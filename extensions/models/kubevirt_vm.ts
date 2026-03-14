import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  kubeContext: z.string().describe(
    "Kubernetes context name (e.g. dev-harvester, prod-harvester)",
  ),
  namespace: z.string().default("cicd").describe(
    "Kubernetes namespace where VMs run",
  ),
  user: z.string().default("nobody").describe(
    "Default user to run commands as inside VMs (set to 'root' to disable)",
  ),
});

const ServiceStatusSchema = z.object({
  vmName: z.string(),
  podName: z.string(),
  domain: z.string(),
  serviceName: z.string(),
  active: z.string(),
  enabled: z.string(),
  checkedAt: z.string(),
});

const ExecResultSchema = z.object({
  vmName: z.string(),
  podName: z.string(),
  domain: z.string(),
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  executedAt: z.string(),
});

const SystemdShowSchema = z.object({
  vmName: z.string(),
  podName: z.string(),
  domain: z.string(),
  unit: z.string(),
  properties: z.record(z.string(), z.string()),
  checkedAt: z.string(),
});

const HealthCheckSchema = z.object({
  vmName: z.string(),
  podName: z.string(),
  domain: z.string(),
  failedUnits: z.array(z.string()),
  recentErrors: z.array(z.string()),
  diskUsage: z.array(z.object({
    filesystem: z.string(),
    size: z.string(),
    used: z.string(),
    avail: z.string(),
    usePct: z.string(),
    mount: z.string(),
  })),
  oomEvents: z.array(z.string()),
  checkedAt: z.string(),
});

const VmListSchema = z.object({
  context: z.string(),
  namespace: z.string(),
  vms: z.array(z.object({
    podName: z.string(),
    domain: z.string(),
  })),
  discoveredAt: z.string(),
});

async function kubectl(context, namespace, args) {
  const cmd = new Deno.Command("kubectl", {
    args: ["--context", context, "-n", namespace, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`kubectl failed: ${stderr}`);
  }
  return stdout.trim();
}

async function discoverVms(context, namespace) {
  const podList = await kubectl(context, namespace, [
    "get",
    "pods",
    "-o",
    "name",
  ]);
  const pods = podList.split("\n").filter((p) =>
    p.startsWith("pod/virt-launcher-")
  ).map((p) => p.replace("pod/", ""));

  const vms = [];
  for (const pod of pods) {
    const domain = await kubectl(context, namespace, [
      "exec",
      pod,
      "-c",
      "compute",
      "--",
      "virsh",
      "-c",
      "qemu:///session",
      "list",
      "--name",
    ]);
    const domainName = domain.split("\n").filter(Boolean)[0];
    if (domainName) {
      vms.push({ podName: pod, domain: domainName });
    }
  }
  return vms;
}

function wrapForUser(command, user) {
  if (!user || user === "root") return command;
  // Use runuser to drop privileges; escape single quotes in the command
  const escaped = command.replace(/'/g, "'\\''");
  return `runuser -u ${user} -- /bin/bash -c '${escaped}'`;
}

async function guestExec(
  context,
  namespace,
  pod,
  domain,
  command,
  timeoutSecs = 15,
  user = "root",
) {
  const wrappedCommand = wrapForUser(command, user);
  const execPayload = JSON.stringify({
    execute: "guest-exec",
    arguments: {
      path: "/bin/bash",
      arg: ["-c", wrappedCommand],
      "capture-output": true,
    },
  });

  const pidJson = await kubectl(context, namespace, [
    "exec",
    pod,
    "-c",
    "compute",
    "--",
    "virsh",
    "-c",
    "qemu:///session",
    "qemu-agent-command",
    domain,
    execPayload,
  ]);

  const pidResult = JSON.parse(pidJson);
  const pid = pidResult.return.pid;

  // Wait for command to complete
  await new Promise((r) => setTimeout(r, Math.min(timeoutSecs, 5) * 1000));

  const statusPayload = JSON.stringify({
    execute: "guest-exec-status",
    arguments: { pid },
  });

  // Poll until exited or timeout
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    const statusJson = await kubectl(context, namespace, [
      "exec",
      pod,
      "-c",
      "compute",
      "--",
      "virsh",
      "-c",
      "qemu:///session",
      "qemu-agent-command",
      domain,
      statusPayload,
    ]);
    const status = JSON.parse(statusJson);
    if (status.return.exited) {
      const stdout = status.return["out-data"]
        ? new TextDecoder().decode(
          Uint8Array.from(
            atob(status.return["out-data"]),
            (c) => c.charCodeAt(0),
          ),
        )
        : "";
      const stderr = status.return["err-data"]
        ? new TextDecoder().decode(
          Uint8Array.from(
            atob(status.return["err-data"]),
            (c) => c.charCodeAt(0),
          ),
        )
        : "";
      return { stdout, stderr, exitCode: status.return.exitcode ?? 0 };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Command timed out after ${timeoutSecs}s on ${domain}`);
}

export const model = {
  type: "@bixu/kubevirt-vm",
  version: "2026.03.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    vms: {
      description: "Discovered VMs in the cluster",
      schema: VmListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    serviceStatus: {
      description: "Systemd service status on a VM",
      schema: ServiceStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    exec: {
      description: "Command execution result from a VM",
      schema: ExecResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    systemdUnit: {
      description: "Systemd unit properties from a VM",
      schema: SystemdShowSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    healthCheck: {
      description: "Health check results from a VM",
      schema: HealthCheckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    discover: {
      description: "Discover all KubeVirt VMs and their virsh domain names",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const vms = await discoverVms(g.kubeContext, g.namespace);
        context.logger.info("Discovered {count} VMs in {ctx}/{ns}", {
          count: vms.length,
          ctx: g.kubeContext,
          ns: g.namespace,
        });

        const handle = await context.writeResource("vms", "latest", {
          context: g.kubeContext,
          namespace: g.namespace,
          vms,
          discoveredAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    exec: {
      description: "Execute a command on a VM via QEMU guest agent",
      arguments: z.object({
        vm: z.string().describe(
          "VM name filter (matches against pod name or domain)",
        ),
        command: z.string().describe("Shell command to execute inside the VM"),
        timeout: z.number().default(30).describe("Timeout in seconds"),
        user: z.string().optional().describe(
          "User to run as (overrides global default; use 'root' for privileged commands)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const runAs = args.user ?? g.user;
        const vms = await discoverVms(g.kubeContext, g.namespace);
        const vm = vms.find((v) =>
          v.podName.includes(args.vm) || v.domain.includes(args.vm)
        );
        if (!vm) {
          throw new Error(
            `No VM matching '${args.vm}' found. Available: ${
              vms.map((v) => v.domain).join(", ")
            }`,
          );
        }

        context.logger.info("Executing as {user} on {domain}: {cmd}", {
          user: runAs,
          domain: vm.domain,
          cmd: args.command,
        });

        const result = await guestExec(
          g.kubeContext,
          g.namespace,
          vm.podName,
          vm.domain,
          args.command,
          args.timeout,
          runAs,
        );

        const handle = await context.writeResource("exec", vm.domain, {
          vmName: vm.domain.replace(/^cicd_/, ""),
          podName: vm.podName,
          domain: vm.domain,
          command: args.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          executedAt: new Date().toISOString(),
        });

        context.logger.info("Exit code {code} on {domain}", {
          code: result.exitCode,
          domain: vm.domain,
        });

        return { dataHandles: [handle] };
      },
    },

    checkService: {
      description:
        "Check the status of a systemd service across all VMs (or a filtered subset)",
      arguments: z.object({
        service: z.string().describe(
          "Systemd service name (e.g. otelcol-contrib)",
        ),
        filter: z.string().optional().describe(
          "Only check VMs matching this string",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        let vms = await discoverVms(g.kubeContext, g.namespace);
        if (args.filter) {
          vms = vms.filter((v) =>
            v.podName.includes(args.filter) || v.domain.includes(args.filter)
          );
        }

        context.logger.info("Checking {service} on {count} VMs", {
          service: args.service,
          count: vms.length,
        });

        const handles = [];
        for (const vm of vms) {
          try {
            const result = await guestExec(
              g.kubeContext,
              g.namespace,
              vm.podName,
              vm.domain,
              `systemctl is-active ${args.service} 2>/dev/null || echo not-found; systemctl is-enabled ${args.service} 2>/dev/null || echo not-installed`,
              10,
              "root",
            );

            const lines = result.stdout.trim().split("\n");
            const active = lines[0] || "unknown";
            const enabled = lines[1] || "unknown";

            const handle = await context.writeResource(
              "serviceStatus",
              vm.domain,
              {
                vmName: vm.domain.replace(/^cicd_/, ""),
                podName: vm.podName,
                domain: vm.domain,
                serviceName: args.service,
                active,
                enabled,
                checkedAt: new Date().toISOString(),
              },
            );
            handles.push(handle);

            context.logger.info(
              "{domain}: {service} active={active} enabled={enabled}",
              {
                domain: vm.domain,
                service: args.service,
                active,
                enabled,
              },
            );
          } catch (err) {
            context.logger.info("Failed to check {domain}: {error}", {
              domain: vm.domain,
              error: String(err),
            });
          }
        }
        return { dataHandles: handles };
      },
    },

    execAll: {
      description: "Execute a command on all VMs (or a filtered subset)",
      arguments: z.object({
        command: z.string().describe("Shell command to execute inside each VM"),
        filter: z.string().optional().describe(
          "Only run on VMs matching this string",
        ),
        timeout: z.number().default(30).describe("Timeout in seconds per VM"),
        user: z.string().optional().describe(
          "User to run as (overrides global default; use 'root' for privileged commands)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const runAs = args.user ?? g.user;
        let vms = await discoverVms(g.kubeContext, g.namespace);
        if (args.filter) {
          vms = vms.filter((v) =>
            v.podName.includes(args.filter) || v.domain.includes(args.filter)
          );
        }

        context.logger.info("Running as {user} on {count} VMs: {cmd}", {
          user: runAs,
          count: vms.length,
          cmd: args.command,
        });

        const handles = [];
        for (const vm of vms) {
          try {
            const result = await guestExec(
              g.kubeContext,
              g.namespace,
              vm.podName,
              vm.domain,
              args.command,
              args.timeout,
              runAs,
            );

            const handle = await context.writeResource("exec", vm.domain, {
              vmName: vm.domain.replace(/^cicd_/, ""),
              podName: vm.podName,
              domain: vm.domain,
              command: args.command,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              executedAt: new Date().toISOString(),
            });
            handles.push(handle);

            context.logger.info("{domain}: exit={code}", {
              domain: vm.domain,
              code: result.exitCode,
            });
          } catch (err) {
            context.logger.info("Failed on {domain}: {error}", {
              domain: vm.domain,
              error: String(err),
            });
          }
        }
        return { dataHandles: handles };
      },
    },

    systemdShow: {
      description:
        "Show systemd unit properties across all VMs (or a filtered subset)",
      arguments: z.object({
        unit: z.string().describe(
          "Systemd unit name (e.g. otelcol-contrib, docker, sshd)",
        ),
        properties: z.string().optional().describe(
          "Comma-separated list of properties to show (default: all). e.g. LimitNOFILE,MemoryMax,User,Restart",
        ),
        filter: z.string().optional().describe(
          "Only check VMs matching this string",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        let vms = await discoverVms(g.kubeContext, g.namespace);
        if (args.filter) {
          vms = vms.filter((v) =>
            v.podName.includes(args.filter) || v.domain.includes(args.filter)
          );
        }

        const propFlag = args.properties
          ? `--property=${args.properties}`
          : "--all";

        context.logger.info("Showing {unit} properties on {count} VMs", {
          unit: args.unit,
          count: vms.length,
        });

        const handles = [];
        for (const vm of vms) {
          try {
            const result = await guestExec(
              g.kubeContext,
              g.namespace,
              vm.podName,
              vm.domain,
              `systemctl show ${args.unit} ${propFlag} 2>&1`,
              15,
              "root",
            );

            const properties = {};
            for (const line of result.stdout.split("\n")) {
              const eq = line.indexOf("=");
              if (eq > 0) {
                properties[line.slice(0, eq)] = line.slice(eq + 1);
              }
            }

            const handle = await context.writeResource(
              "systemdUnit",
              `${vm.domain}--${args.unit}`,
              {
                vmName: vm.domain.replace(/^cicd_/, ""),
                podName: vm.podName,
                domain: vm.domain,
                unit: args.unit,
                properties,
                checkedAt: new Date().toISOString(),
              },
            );
            handles.push(handle);

            const user = properties["User"] || "(not set)";
            const restart = properties["Restart"] || "(not set)";
            const active = properties["ActiveState"] || "(unknown)";
            context.logger.info(
              "{domain}: {unit} state={active} user={user} restart={restart}",
              {
                domain: vm.domain,
                unit: args.unit,
                active,
                user,
                restart,
              },
            );
          } catch (err) {
            context.logger.info("Failed on {domain}: {error}", {
              domain: vm.domain,
              error: String(err),
            });
          }
        }
        return { dataHandles: handles };
      },
    },
    healthCheck: {
      description:
        "Run health checks across all VMs (or a filtered subset) — failed units, recent errors, disk pressure, OOM events",
      arguments: z.object({
        filter: z.string().optional().describe(
          "Only check VMs matching this string",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        let vms = await discoverVms(g.kubeContext, g.namespace);
        if (args.filter) {
          vms = vms.filter((v) =>
            v.podName.includes(args.filter) || v.domain.includes(args.filter)
          );
        }

        context.logger.info("Health-checking {count} VMs", {
          count: vms.length,
        });

        const handles = [];
        for (const vm of vms) {
          try {
            const result = await guestExec(
              g.kubeContext,
              g.namespace,
              vm.podName,
              vm.domain,
              [
                "echo '=== FAILED ==='",
                "systemctl --failed --no-legend 2>/dev/null || true",
                "echo '=== ERRORS ==='",
                "journalctl -p err --since '1 hour ago' --no-pager -q 2>/dev/null | tail -20 || true",
                "echo '=== DISK ==='",
                "df -h / /var /tmp 2>/dev/null | tail -n +2 || true",
                "echo '=== OOM ==='",
                "dmesg 2>/dev/null | grep -i 'out of memory' | tail -5 || true",
              ].join(" && "),
              30,
              "root",
            );

            const sections = result.stdout.split(
              /=== (FAILED|ERRORS|DISK|OOM) ===/,
            );
            // sections: ["", "FAILED", content, "ERRORS", content, "DISK", content, "OOM", content]
            const failedRaw = (sections[2] || "").trim();
            const errorsRaw = (sections[4] || "").trim();
            const diskRaw = (sections[6] || "").trim();
            const oomRaw = (sections[8] || "").trim();

            const failedUnits = failedRaw
              ? failedRaw.split("\n").filter(Boolean)
              : [];
            const recentErrors = errorsRaw
              ? errorsRaw.split("\n").filter(Boolean)
              : [];
            const oomEvents = oomRaw ? oomRaw.split("\n").filter(Boolean) : [];

            const diskUsage = diskRaw
              ? diskRaw.split("\n").filter(Boolean).map((line) => {
                const parts = line.split(/\s+/);
                return {
                  filesystem: parts[0] || "",
                  size: parts[1] || "",
                  used: parts[2] || "",
                  avail: parts[3] || "",
                  usePct: parts[4] || "",
                  mount: parts[5] || "",
                };
              })
              : [];

            const handle = await context.writeResource(
              "healthCheck",
              vm.domain,
              {
                vmName: vm.domain.replace(/^cicd_/, ""),
                podName: vm.podName,
                domain: vm.domain,
                failedUnits,
                recentErrors,
                diskUsage,
                oomEvents,
                checkedAt: new Date().toISOString(),
              },
            );
            handles.push(handle);

            const issues = failedUnits.length + recentErrors.length +
              oomEvents.length;
            const diskWarnings = diskUsage.filter((d) =>
              parseInt(d.usePct) >= 90
            );
            if (issues > 0 || diskWarnings.length > 0) {
              context.logger.info(
                "{domain}: {failed} failed units, {errors} errors, {oom} OOM events, {diskWarn} disks >=90%",
                {
                  domain: vm.domain,
                  failed: failedUnits.length,
                  errors: recentErrors.length,
                  oom: oomEvents.length,
                  diskWarn: diskWarnings.length,
                },
              );
            } else {
              context.logger.info("{domain}: healthy", {
                domain: vm.domain,
              });
            }
          } catch (err) {
            context.logger.info("Failed to check {domain}: {error}", {
              domain: vm.domain,
              error: String(err),
            });
          }
        }
        return { dataHandles: handles };
      },
    },
  },
};
