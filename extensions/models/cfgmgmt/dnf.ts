import { z } from "npm:zod@4";
import { getConnection, exec, wrapSudo } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  packages: z.array(z.string()).default([]).describe("Package names to manage"),
  ensure: z.enum(["present", "absent"]).default("present").describe("Whether packages should be present or absent"),
  nodeHost: z.string().describe("Hostname or IP of the remote node"),
  nodeUser: z.string().default("root").describe("SSH username"),
  nodePort: z.number().default(22).describe("SSH port"),
  nodeIdentityFile: z.string().optional().describe("Path to SSH private key"),
  become: z.boolean().default(false).describe("Enable sudo privilege escalation"),
  becomeUser: z.string().default("root").describe("User to become via sudo"),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe("Password for sudo -S"),
});

function sudoOpts(g) {
  return { become: g.become, becomeUser: g.becomeUser, becomePassword: g.becomePassword };
}

const StateSchema = z.object({
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]).describe("Compliance status"),
  packages: z.array(z.object({
    name: z.string().describe("Package name"),
    installed: z.boolean().describe("Whether the package is installed"),
    version: z.string().nullable().describe("Installed version"),
  })).nullable().describe("Per-package status"),
  changes: z.array(z.string()).describe("List of changes (e.g. install nginx)"),
  stdout: z.string().describe("Command output"),
  stderr: z.string().describe("Command error output"),
  error: z.string().nullable().describe("Error message if status is failed"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

const InstalledSchema = z.object({
  packages: z.array(z.object({
    name: z.string().describe("Package name"),
    version: z.string().describe("Installed version"),
  })).describe("All installed packages"),
  count: z.number().describe("Total number of installed packages"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

async function connect(g) {
  return getConnection({
    host: g.nodeHost,
    port: g.nodePort,
    username: g.nodeUser,
    privateKeyPath: g.nodeIdentityFile,
  });
}

async function queryPackages(client, packages, g) {
  const so = sudoOpts(g);
  const results = [];
  for (const pkg of packages) {
    const r = await exec(client, wrapSudo(`rpm -q ${JSON.stringify(pkg)} 2>/dev/null`, so));
    if (r.exitCode === 0) {
      const version = r.stdout.trim().replace(new RegExp(`^${pkg}-`), "");
      results.push({ name: pkg, installed: true, version });
    } else {
      results.push({ name: pkg, installed: false, version: null });
    }
  }
  return results;
}

function detectChanges(packages, ensure) {
  const changes = [];
  for (const pkg of packages) {
    if (ensure === "present" && !pkg.installed) {
      changes.push(`install ${pkg.name}`);
    } else if (ensure === "absent" && pkg.installed) {
      changes.push(`remove ${pkg.name}`);
    }
  }
  return changes;
}

export const model = {
  type: "@adam/cfgmgmt/dnf",
  version: "2026.03.02.1",
  globalArguments: GlobalArgsSchema,
  inputsSchema: z.object({
    packages: z.array(z.string()).optional().describe("Package names to manage"),
    ensure: z.enum(["present", "absent"]).optional().describe("Whether packages should be present or absent"),
    nodeHost: z.string().optional().describe("Hostname or IP of the remote node"),
    nodeUser: z.string().optional().describe("SSH username"),
    nodePort: z.number().optional().describe("SSH port"),
    nodeIdentityFile: z.string().optional().describe("Path to SSH private key"),
    become: z.boolean().optional().describe("Enable sudo privilege escalation"),
    becomeUser: z.string().optional().describe("User to become via sudo"),
    becomePassword: z.string().optional().describe("Password for sudo -S"),
  }),
  resources: {
    state: {
      description: "Package operation state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    installed: {
      description: "All installed packages",
      schema: InstalledSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description: "Check if packages match desired state without modifying",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const packages = await queryPackages(client, g.packages, g);
          const changes = detectChanges(packages, g.ensure);
          const handle = await context.writeResource("state", g.nodeHost, {
            status: changes.length === 0 ? "compliant" : "non_compliant",
            packages,
            changes,
            stdout: "",
            stderr: "",
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
    apply: {
      description: "Install or remove packages based on ensure state",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const packages = await queryPackages(client, g.packages, g);
          const changes = detectChanges(packages, g.ensure);

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              status: "compliant",
              packages,
              changes: [],
              stdout: "",
              stderr: "",
              error: null,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const toInstall = packages.filter((p) => g.ensure === "present" && !p.installed).map((p) => p.name);
          const toRemove = packages.filter((p) => g.ensure === "absent" && p.installed).map((p) => p.name);

          let stdout = "";
          let stderr = "";

          if (toInstall.length > 0) {
            const so = sudoOpts(g);
            const r = await exec(client, wrapSudo(`dnf install -y ${toInstall.join(" ")}`, so));
            stdout += r.stdout;
            stderr += r.stderr;
            if (r.exitCode !== 0) {
              const handle = await context.writeResource("state", g.nodeHost, {
                status: "failed",
                packages: await queryPackages(client, g.packages, g),
                changes,
                stdout,
                stderr,
                error: `dnf install failed with exit code ${r.exitCode}`,
                timestamp: new Date().toISOString(),
              });
              return { dataHandles: [handle] };
            }
          }

          if (toRemove.length > 0) {
            const so = sudoOpts(g);
            const r = await exec(client, wrapSudo(`dnf remove -y ${toRemove.join(" ")}`, so));
            stdout += r.stdout;
            stderr += r.stderr;
            if (r.exitCode !== 0) {
              const handle = await context.writeResource("state", g.nodeHost, {
                status: "failed",
                packages: await queryPackages(client, g.packages, g),
                changes,
                stdout,
                stderr,
                error: `dnf remove failed with exit code ${r.exitCode}`,
                timestamp: new Date().toISOString(),
              });
              return { dataHandles: [handle] };
            }
          }

          const updated = await queryPackages(client, g.packages, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "applied",
            packages: updated,
            changes,
            stdout,
            stderr,
            error: null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
    refresh: {
      description: "Refresh the dnf package metadata",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const r = await exec(client, wrapSudo("dnf makecache", sudoOpts(g)));
          const handle = await context.writeResource("state", g.nodeHost, {
            status: r.exitCode === 0 ? "applied" : "failed",
            packages: null,
            changes: r.exitCode === 0 ? ["metadata refreshed"] : [],
            stdout: r.stdout,
            stderr: r.stderr,
            error: r.exitCode !== 0 ? `dnf makecache failed with exit code ${r.exitCode}` : null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
    upgrade: {
      description: "Upgrade all installed packages",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const r = await exec(client, wrapSudo("dnf upgrade -y", sudoOpts(g)));
          const handle = await context.writeResource("state", g.nodeHost, {
            status: r.exitCode === 0 ? "applied" : "failed",
            packages: null,
            changes: r.exitCode === 0 ? ["system upgraded"] : [],
            stdout: r.stdout,
            stderr: r.stderr,
            error: r.exitCode !== 0 ? `dnf upgrade failed with exit code ${r.exitCode}` : null,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
    list: {
      description: "List all installed packages",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        try {
          const client = await connect(g);
          const r = await exec(client, wrapSudo("rpm -qa --qf '%{NAME} %{VERSION}-%{RELEASE}\\n'", sudoOpts(g)));
          if (r.exitCode !== 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              status: "failed",
              packages: null,
              changes: [],
              stdout: r.stdout,
              stderr: r.stderr,
              error: `rpm -qa failed with exit code ${r.exitCode}`,
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }

          const packages = r.stdout.trim().split("\n")
            .filter((line) => line.length > 0)
            .map((line) => {
              const parts = line.split(/\s+/);
              return { name: parts[0], version: parts[1] || "unknown" };
            });

          const handle = await context.writeResource("installed", g.nodeHost, {
            packages,
            count: packages.length,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        } catch (err) {
          const handle = await context.writeResource("state", g.nodeHost, {
            status: "failed",
            packages: null,
            changes: [],
            stdout: "",
            stderr: "",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }
      },
    },
  },
};
