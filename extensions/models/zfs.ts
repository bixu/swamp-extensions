/**
 * ZFS pool management extension for swamp.
 *
 * Provides methods to import/export pools, sync health status, create and prune
 * snapshots, run scrubs, and issue TRIM commands against OpenZFS pools on macOS
 * and Linux. All methods validate input names to prevent injection before
 * executing any zpool/zfs subprocess.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ZFS name rules: alphanumeric, underscore, hyphen, colon, period (no slash for components)
const SAFE_ZFS_COMPONENT_RE = /^[a-zA-Z0-9_\-:.]+$/;
// Dataset/path names allow slash
const SAFE_ZFS_PATH_RE = /^[a-zA-Z0-9_\-:./]+$/;

function validateComponent(name, label) {
  if (!SAFE_ZFS_COMPONENT_RE.test(name)) {
    throw new Error(
      `Invalid ${label} ${
        JSON.stringify(name)
      }: only alphanumeric, underscore, hyphen, colon, period allowed`,
    );
  }
}

function validatePath(path, label) {
  if (!SAFE_ZFS_PATH_RE.test(path)) {
    throw new Error(
      `Invalid ${label} ${
        JSON.stringify(path)
      }: only alphanumeric, underscore, hyphen, colon, period, slash allowed`,
    );
  }
}

function validateSnapshot(snap, label) {
  const atIdx = snap.indexOf("@");
  if (atIdx < 0) {
    throw new Error(
      `${label} ${
        JSON.stringify(snap)
      } must contain '@' (e.g. tank/data@snapshot-name)`,
    );
  }
  validatePath(snap.slice(0, atIdx), `${label} dataset`);
  validateComponent(snap.slice(atIdx + 1), `${label} snapshot name`);
}

async function run(bin, args) {
  const cmd = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (!result.success) {
    throw new Error(`${bin} ${args[0] ?? ""} failed: ${stderr}`);
  }
  return stdout;
}

let resolvedBins = null;

function requirePool(pool) {
  if (!pool) {
    throw new Error(
      "globalArguments.pool is required for this method — set it when creating the model instance",
    );
  }
  validateComponent(pool, "pool");
  return pool;
}

async function resolveBins(zpoolBin, zfsBin) {
  if (resolvedBins) return resolvedBins;

  for (const [bin, name] of [[zpoolBin, "zpool"], [zfsBin, "zfs"]]) {
    const typeCmd = new Deno.Command("sh", {
      args: ["-c", `type ${bin}`],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await typeCmd.output();
    if (!result.success) {
      throw new Error(
        `${name} not found at '${bin}'. Install OpenZFS or set ${name}Bin in globalArguments.`,
      );
    }
    const output = new TextDecoder().decode(result.stdout).trim();
    const pathMatch = output.match(/\/([\w./\-]+)/);
    if (!pathMatch) {
      throw new Error(`Could not resolve ${name} path from: ${output}`);
    }
  }

  resolvedBins = { zpool: zpoolBin, zfs: zfsBin };
  return resolvedBins;
}

function parseZpoolList(output, pool) {
  for (const line of output.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts[0] === pool) {
      return {
        health: parts[1] || "UNKNOWN",
        sizeBytes: parseInt(parts[2]) || 0,
        allocBytes: parseInt(parts[3]) || 0,
        freeBytes: parseInt(parts[4]) || 0,
        capacityPct: parseInt(parts[5]) || 0,
        fragmentationPct: parseInt(parts[6]) || 0,
      };
    }
  }
  throw new Error(
    `Pool '${pool}' not found in zpool list output — is it imported?`,
  );
}

function parseZpoolStatus(output) {
  const devices = [];
  let scanState = "none";
  let scanDate = "";
  const lines = output.split("\n");
  let inConfig = false;

  for (const line of lines) {
    const scanMatch = line.match(/^\s*scan:\s*(.+)$/);
    if (scanMatch) {
      scanState = scanMatch[1];
      const dateMatch = scanMatch[1].match(/on (.+)$/);
      if (dateMatch) scanDate = dateMatch[1].trim();
    }

    if (line.startsWith("config:")) {
      inConfig = true;
      continue;
    }
    if (inConfig && (line.startsWith("errors:") || line === "")) {
      if (line.startsWith("errors:")) inConfig = false;
      continue;
    }

    if (inConfig) {
      const devMatch = line.match(
        /^\s+(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|REMOVED|UNAVAIL)\s+(\d+)\s+(\d+)\s+(\d+)/,
      );
      if (devMatch) {
        devices.push({
          name: devMatch[1],
          state: devMatch[2],
          read: parseInt(devMatch[3]),
          write: parseInt(devMatch[4]),
          cksum: parseInt(devMatch[5]),
        });
      }
    }
  }

  return { devices, scanState, scanDate };
}

function parseDatasets(output) {
  return output.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return {
      name: parts[0] || "",
      type: parts[1] || "",
      usedBytes: parseInt(parts[2]) || 0,
      availBytes: parseInt(parts[3]) || 0,
      referBytes: parseInt(parts[4]) || 0,
      mountpoint: parts[5] || "",
    };
  });
}

function parseSnapshots(output) {
  return output.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return {
      name: parts[0] || "",
      usedBytes: parseInt(parts[1]) || 0,
      referBytes: parseInt(parts[2]) || 0,
      creationEpoch: parseInt(parts[3]) || 0,
    };
  });
}

const GlobalArgsSchema = z.object({
  pool: z.string().optional().describe(
    "ZFS pool name (e.g. tank). Required for sync, snapshot, scrub, and trim. Leave unset to import all discovered pools on attach.",
  ),
  zpoolBin: z.string().default("/usr/local/bin/zpool").describe(
    "Path to zpool binary",
  ),
  zfsBin: z.string().default("/usr/local/bin/zfs").describe(
    "Path to zfs binary",
  ),
});

const DeviceSchema = z.object({
  name: z.string(),
  state: z.string(),
  read: z.number(),
  write: z.number(),
  cksum: z.number(),
});

const PoolStatusSchema = z.object({
  pool: z.string(),
  health: z.string(),
  sizeBytes: z.number(),
  allocBytes: z.number(),
  freeBytes: z.number(),
  capacityPct: z.number(),
  fragmentationPct: z.number(),
  devices: z.array(DeviceSchema),
  scanState: z.string(),
  scanDate: z.string(),
  checkedAt: z.string(),
});

const DatasetSchema = z.object({
  name: z.string(),
  type: z.string(),
  usedBytes: z.number(),
  availBytes: z.number(),
  referBytes: z.number(),
  mountpoint: z.string(),
});

const DatasetListSchema = z.object({
  pool: z.string(),
  datasets: z.array(DatasetSchema),
  count: z.number(),
  listedAt: z.string(),
});

const SnapshotSchema = z.object({
  name: z.string(),
  usedBytes: z.number(),
  referBytes: z.number(),
  creationEpoch: z.number(),
});

const SnapshotListSchema = z.object({
  pool: z.string(),
  snapshots: z.array(SnapshotSchema),
  count: z.number(),
  listedAt: z.string(),
});

const SnapshotResultSchema = z.object({
  snapshot: z.string(),
  operation: z.string(),
  count: z.number(),
  executedAt: z.string(),
});

const ScrubResultSchema = z.object({
  pool: z.string(),
  operation: z.string(),
  executedAt: z.string(),
});

const PoolImportResultSchema = z.object({
  pools: z.array(z.string()),
  operation: z.string(),
  wasAlreadyImported: z.boolean(),
  executedAt: z.string(),
});

/** ZFS pool management model — import, export, sync, snapshot, prune, scrub, and TRIM. */
export const model = {
  type: "@bixu/zfs",
  version: "2026.04.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "ZFS pool status, health, capacity, and device states",
      schema: PoolStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    datasets: {
      description: "ZFS datasets (filesystems and volumes) in the pool",
      schema: DatasetListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    snapshots: {
      description: "ZFS snapshots in the pool",
      schema: SnapshotListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    snapshotResult: {
      description: "Result of a snapshot create, destroy, or prune operation",
      schema: SnapshotResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
    scrubResult: {
      description: "Result of a scrub or trim operation",
      schema: ScrubResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    importResult: {
      description: "Result of a pool import or export operation",
      schema: PoolImportResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "pool-accessible": {
      description: "Verify the ZFS pool is imported and accessible",
      labels: ["live"],
      appliesTo: [
        "snapshot",
        "autoSnapshot",
        "destroySnapshot",
        "pruneSnapshots",
        "scrub",
        "trim",
      ],
      execute: async (context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        try {
          await resolveBins(zpoolBin, zfsBin);
        } catch (err) {
          return { pass: false, errors: [String(err)] };
        }

        try {
          validateComponent(pool, "pool");
        } catch (err) {
          return { pass: false, errors: [String(err)] };
        }

        try {
          const cmd = new Deno.Command(zpoolBin, {
            args: ["list", "-H", "-o", "name,health", pool],
            stdout: "piped",
            stderr: "piped",
          });
          const result = await cmd.output();
          if (!result.success) {
            const stderr = new TextDecoder().decode(result.stderr).trim();
            return {
              pass: false,
              errors: [
                `Pool '${pool}' is not imported or not accessible: ${stderr}`,
              ],
            };
          }
          const line = new TextDecoder().decode(result.stdout).trim();
          const health = line.split("\t")[1] || "UNKNOWN";
          if (health === "FAULTED") {
            return {
              pass: false,
              errors: [
                `Pool '${pool}' is FAULTED — resolve errors before running operations`,
              ],
            };
          }
          return { pass: true };
        } catch (err) {
          return { pass: false, errors: [String(err)] };
        }
      },
    },
  },
  upgrades: [
    {
      fromVersion: "2026.02.27.5",
      toVersion: "2026.04.23.1",
      description:
        "Expanded from health monitoring to full management model (snapshot, prune, scrub, trim)",
      upgradeAttributes: (old) => old,
    },
  ],
  methods: {
    import: {
      description:
        "Import ZFS pools from attached devices. Uses 'zpool import -a' when no pool is configured — designed for IOKit launchd triggers on device attach. If a pool requires forced import, a native macOS dialog is shown and the user must confirm before proceeding.",
      arguments: z.object({
        deviceDir: z.string().optional().describe(
          "Search for devices in this directory instead of the default (e.g. /dev)",
        ),
      }),
      execute: async (args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const bins = await resolveBins(zpoolBin, zfsBin);

        if (args.deviceDir) validatePath(args.deviceDir, "deviceDir");

        const targetPool = pool ?? null;
        if (targetPool) validateComponent(targetPool, "pool");

        // When a specific pool is named, check if it's already imported
        if (targetPool) {
          const checkCmd = new Deno.Command(bins.zpool, {
            args: ["list", "-H", "-o", "name", targetPool],
            stdout: "piped",
            stderr: "piped",
          });
          if ((await checkCmd.output()).success) {
            context.logger.info(
              "Pool {pool} is already imported — nothing to do",
              { pool: targetPool },
            );
            const handle = await context.writeResource(
              "importResult",
              "current",
              {
                pools: [targetPool],
                operation: "import",
                wasAlreadyImported: true,
                executedAt: new Date().toISOString(),
              },
            );
            return { dataHandles: [handle] };
          }
        }

        // Attempt import without force first
        const baseArgs = ["import"];
        if (args.deviceDir) baseArgs.push("-d", args.deviceDir);
        const importArgs = targetPool
          ? [...baseArgs, targetPool]
          : [...baseArgs, "-a"];

        context.logger.info(
          targetPool
            ? "Importing pool {pool}"
            : "Importing all discovered pools",
          { pool: targetPool ?? "" },
        );

        const firstCmd = new Deno.Command(bins.zpool, {
          args: importArgs,
          stdout: "piped",
          stderr: "piped",
        });
        const firstResult = await firstCmd.output();

        if (!firstResult.success) {
          const stderr = new TextDecoder().decode(firstResult.stderr).trim();
          const needsForce = stderr.includes("use 'zpool import -f'") ||
            stderr.includes("was previously in use") ||
            stderr.includes("use the '-f' flag");

          if (!needsForce) {
            throw new Error(`zpool import failed: ${stderr}`);
          }

          // Pool exists but requires force — ask the user via native macOS dialog.
          // Running as root (LaunchDaemon), so project osascript into the
          // logged-in user's session via launchctl asuser.
          context.logger.info(
            "Pool requires forced import — prompting user for confirmation",
          );

          const uidCmd = new Deno.Command("stat", {
            args: ["-f", "%u", "/dev/console"],
            stdout: "piped",
            stderr: "piped",
          });
          const uidResult = await uidCmd.output();
          const consoleUid = new TextDecoder()
            .decode(uidResult.stdout)
            .trim();

          // Escape single quotes in pool name for AppleScript string safety
          const displayName = (targetPool ?? "detected pool").replace(
            /'/g,
            "\\'",
          );
          const dialogScript =
            `display dialog "ZFS pool '${displayName}' was not cleanly exported and requires a forced import. This is safe if no other system is using the pool.\\n\\nProceed with forced import?" ` +
            `buttons {"Cancel", "Import Anyway"} default button "Cancel" with icon caution`;

          const dialogCmd = new Deno.Command("launchctl", {
            args: [
              "asuser",
              consoleUid,
              "/usr/bin/osascript",
              "-e",
              dialogScript,
            ],
            stdout: "piped",
            stderr: "piped",
          });
          const dialogResult = await dialogCmd.output();

          if (!dialogResult.success) {
            throw new Error(
              `Forced import of pool '${
                targetPool ?? "pool"
              }' cancelled by user`,
            );
          }

          context.logger.info("User confirmed forced import — proceeding");
          const forcedArgs = [...importArgs];
          // Insert -f after "import"
          forcedArgs.splice(1, 0, "-f");
          await run(bins.zpool, forcedArgs);
        }

        // Discover what pools are now imported
        const listCmd = new Deno.Command(bins.zpool, {
          args: ["list", "-H", "-o", "name"],
          stdout: "piped",
          stderr: "piped",
        });
        const listResult = await listCmd.output();
        const importedPools = new TextDecoder()
          .decode(listResult.stdout)
          .trim()
          .split("\n")
          .filter(Boolean);

        context.logger.info("Imported pools: {pools}", {
          pools: importedPools.join(", "),
        });

        const handle = await context.writeResource("importResult", "current", {
          pools: importedPools,
          operation: "import",
          wasAlreadyImported: false,
          executedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    export: {
      description:
        "Export the ZFS pool — unmounts all datasets and prepares drives for safe removal. Requires globalArguments.pool to be set.",
      arguments: z.object({
        force: z.boolean().default(false).describe(
          "Force export even if pool is busy (will terminate active I/O)",
        ),
      }),
      execute: async (args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const bins = await resolveBins(zpoolBin, zfsBin);
        const targetPool = requirePool(pool);

        // No-op if not imported
        const checkCmd = new Deno.Command(bins.zpool, {
          args: ["list", "-H", "-o", "name", targetPool],
          stdout: "piped",
          stderr: "piped",
        });
        const checkResult = await checkCmd.output();

        if (!checkResult.success) {
          context.logger.info(
            "Pool {pool} is not imported — nothing to export",
            { pool: targetPool },
          );
          const handle = await context.writeResource(
            "importResult",
            "current",
            {
              pools: [],
              operation: "export",
              wasAlreadyImported: false,
              executedAt: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }

        const exportArgs = ["export"];
        if (args.force) exportArgs.push("-f");
        exportArgs.push(targetPool);

        context.logger.info("Exporting pool {pool}{force}", {
          pool: targetPool,
          force: args.force ? " (forced)" : "",
        });

        await run(bins.zpool, exportArgs);

        context.logger.info("Pool {pool} exported — safe to remove drives", {
          pool: targetPool,
        });
        const handle = await context.writeResource("importResult", "current", {
          pools: [targetPool],
          operation: "export",
          wasAlreadyImported: true,
          executedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    sync: {
      description:
        "Fetch pool status, dataset list, and snapshot list — safe for periodic launchd runs",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const targetPool = requirePool(pool);
        const bins = await resolveBins(zpoolBin, zfsBin);

        context.logger.info("Syncing ZFS pool {pool}", { pool: targetPool });

        // Pool status
        const listOut = await run(bins.zpool, [
          "list",
          "-H",
          "-p",
          "-o",
          "name,health,size,alloc,free,capacity,fragmentation",
          targetPool,
        ]);
        const poolStats = parseZpoolList(listOut, targetPool);

        const statusOut = await run(bins.zpool, ["status", "-v", targetPool]);
        const { devices, scanState, scanDate } = parseZpoolStatus(statusOut);

        const statusHandle = await context.writeResource("status", "current", {
          pool: targetPool,
          ...poolStats,
          devices,
          scanState,
          scanDate,
          checkedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Pool {pool}: {health} {cap}% used, {deviceCount} devices",
          {
            pool: targetPool,
            health: poolStats.health,
            cap: poolStats.capacityPct,
            deviceCount: devices.length,
          },
        );

        // Datasets
        const dsOut = await run(bins.zfs, [
          "list",
          "-H",
          "-p",
          "-o",
          "name,type,used,avail,refer,mountpoint",
          "-t",
          "filesystem,volume",
          "-r",
          targetPool,
        ]);
        const datasets = dsOut ? parseDatasets(dsOut) : [];
        const datasetsHandle = await context.writeResource(
          "datasets",
          "current",
          {
            pool: targetPool,
            datasets,
            count: datasets.length,
            listedAt: new Date().toISOString(),
          },
        );

        // Snapshots
        const snapOut = await run(bins.zfs, [
          "list",
          "-H",
          "-p",
          "-o",
          "name,used,refer,creation",
          "-t",
          "snapshot",
          "-r",
          targetPool,
        ]);
        const snapshots = snapOut ? parseSnapshots(snapOut) : [];
        const snapshotsHandle = await context.writeResource(
          "snapshots",
          "current",
          {
            pool: targetPool,
            snapshots,
            count: snapshots.length,
            listedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "{dsCount} datasets, {snapCount} snapshots",
          { dsCount: datasets.length, snapCount: snapshots.length },
        );

        return { dataHandles: [statusHandle, datasetsHandle, snapshotsHandle] };
      },
    },

    snapshot: {
      description: "Create a ZFS snapshot",
      arguments: z.object({
        dataset: z.string().describe(
          "Dataset to snapshot (e.g. tank/data). Omit to snapshot the pool root.",
        ).optional(),
        name: z.string().describe(
          "Snapshot name (e.g. manual-2026-04-05). Will be suffixed to dataset@",
        ),
        recursive: z.boolean().default(false).describe(
          "Recursively snapshot all descendant datasets",
        ),
      }),
      execute: async (args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const bins = await resolveBins(zpoolBin, zfsBin);

        const dataset = args.dataset ?? requirePool(pool);
        validatePath(dataset, "dataset");
        validateComponent(args.name, "snapshot name");

        const snapshotFull = `${dataset}@${args.name}`;
        const cmdArgs = ["snapshot"];
        if (args.recursive) cmdArgs.push("-r");
        cmdArgs.push(snapshotFull);

        context.logger.info("Creating snapshot {snap}", { snap: snapshotFull });
        await run(bins.zfs, cmdArgs);

        const handle = await context.writeResource(
          "snapshotResult",
          args.name,
          {
            snapshot: snapshotFull,
            operation: "create",
            count: 1,
            executedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Created {snap}", { snap: snapshotFull });
        return { dataHandles: [handle] };
      },
    },

    autoSnapshot: {
      description:
        "Create timestamped snapshots of all datasets in the pool — designed for scheduled launchd runs",
      arguments: z.object({
        prefix: z.string().describe(
          "Snapshot name prefix (e.g. daily, hourly, weekly). Timestamp appended automatically.",
        ),
        datasets: z.array(z.string()).optional().describe(
          "Specific datasets to snapshot (default: all filesystems in pool)",
        ),
        recursive: z.boolean().default(false).describe(
          "Recursively snapshot each dataset's descendants",
        ),
      }),
      execute: async (args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const targetPool = requirePool(pool);
        const bins = await resolveBins(zpoolBin, zfsBin);

        validateComponent(args.prefix, "prefix");

        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 16);
        const snapName = `${args.prefix}-${ts}`;

        let targets = args.datasets;
        if (!targets || targets.length === 0) {
          const dsOut = await run(bins.zfs, [
            "list",
            "-H",
            "-o",
            "name",
            "-t",
            "filesystem",
            "-r",
            targetPool,
          ]);
          targets = dsOut ? dsOut.split("\n").filter(Boolean) : [targetPool];
        }

        for (const ds of targets) validatePath(ds, "dataset");

        context.logger.info(
          "Auto-snapshotting {count} datasets with name @{snap}",
          { count: targets.length, snap: snapName },
        );

        let created = 0;
        const errors = [];
        for (const ds of targets) {
          const full = `${ds}@${snapName}`;
          const cmdArgs = ["snapshot"];
          if (args.recursive) cmdArgs.push("-r");
          cmdArgs.push(full);
          try {
            await run(bins.zfs, cmdArgs);
            created++;
            context.logger.info("Created {snap}", { snap: full });
          } catch (err) {
            errors.push(`${full}: ${String(err)}`);
            context.logger.info("Failed to snapshot {snap}: {error}", {
              snap: full,
              error: String(err),
            });
          }
        }

        if (errors.length > 0 && created === 0) {
          throw new Error(
            `All snapshots failed:\n${errors.join("\n")}`,
          );
        }

        const handle = await context.writeResource(
          "snapshotResult",
          snapName,
          {
            snapshot: snapName,
            operation: "auto-snapshot",
            count: created,
            executedAt: now.toISOString(),
          },
        );

        context.logger.info(
          "Created {created}/{total} snapshots",
          { created, total: targets.length },
        );

        return { dataHandles: [handle] };
      },
    },

    destroySnapshot: {
      description: "Destroy a specific ZFS snapshot",
      arguments: z.object({
        snapshot: z.string().describe(
          "Full snapshot name including dataset (e.g. tank/data@daily-2026-04-01-09-00)",
        ),
      }),
      execute: async (args, context) => {
        const { zpoolBin, zfsBin } = context.globalArgs;
        const bins = await resolveBins(zpoolBin, zfsBin);

        validateSnapshot(args.snapshot, "snapshot");

        context.logger.info("Destroying snapshot {snap}", {
          snap: args.snapshot,
        });
        await run(bins.zfs, ["destroy", args.snapshot]);

        const snapName = args.snapshot.split("@")[1];
        const handle = await context.writeResource(
          "snapshotResult",
          snapName,
          {
            snapshot: args.snapshot,
            operation: "destroy",
            count: 1,
            executedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Destroyed {snap}", { snap: args.snapshot });
        return { dataHandles: [handle] };
      },
    },

    pruneSnapshots: {
      description:
        "Destroy snapshots matching a prefix that are older than keepDays — designed for scheduled launchd retention runs",
      arguments: z.object({
        dataset: z.string().describe(
          "Dataset to prune (e.g. tank/data). Omit for pool root.",
        ).optional(),
        prefix: z.string().describe(
          "Only prune snapshots whose name starts with this prefix (e.g. daily)",
        ),
        keepDays: z.number().describe(
          "Retain snapshots newer than this many days; destroy older ones",
        ),
        keepCount: z.number().default(1).describe(
          "Always keep at least this many matching snapshots regardless of age",
        ),
        dryRun: z.boolean().default(false).describe(
          "List snapshots that would be destroyed without actually destroying them",
        ),
      }),
      execute: async (args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const bins = await resolveBins(zpoolBin, zfsBin);

        const dataset = args.dataset ?? requirePool(pool);
        validatePath(dataset, "dataset");
        validateComponent(args.prefix, "prefix");

        const snapOut = await run(bins.zfs, [
          "list",
          "-H",
          "-p",
          "-o",
          "name,used,refer,creation",
          "-t",
          "snapshot",
          "-r",
          dataset,
        ]);
        const all = snapOut ? parseSnapshots(snapOut) : [];

        // Filter to snapshots of exactly this dataset matching the prefix
        const matching = all
          .filter((s) => {
            const atIdx = s.name.indexOf("@");
            if (atIdx < 0) return false;
            const ds = s.name.slice(0, atIdx);
            const snapName = s.name.slice(atIdx + 1);
            return ds === dataset && snapName.startsWith(args.prefix);
          })
          .sort((a, b) => b.creationEpoch - a.creationEpoch); // newest first

        const cutoffEpoch = Math.floor(Date.now() / 1000) -
          args.keepDays * 86400;

        // Keep the most recent keepCount regardless of age, prune the rest if old
        const toDestroy = matching
          .slice(args.keepCount)
          .filter((s) => s.creationEpoch < cutoffEpoch);

        context.logger.info(
          "{total} matching snapshots, {destroy} eligible for pruning (keepDays={days}, keepCount={count}, dryRun={dry})",
          {
            total: matching.length,
            destroy: toDestroy.length,
            days: args.keepDays,
            count: args.keepCount,
            dry: args.dryRun,
          },
        );

        let destroyed = 0;
        for (const snap of toDestroy) {
          if (args.dryRun) {
            context.logger.info("Would destroy {snap}", { snap: snap.name });
          } else {
            await run(bins.zfs, ["destroy", snap.name]);
            destroyed++;
            context.logger.info("Destroyed {snap}", { snap: snap.name });
          }
        }

        const opName = args.dryRun ? "prune-dry-run" : "prune";
        const handle = await context.writeResource(
          "snapshotResult",
          `${opName}-${args.prefix}`,
          {
            snapshot: `${dataset}@${args.prefix}*`,
            operation: opName,
            count: args.dryRun ? toDestroy.length : destroyed,
            executedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    scrub: {
      description: "Start a ZFS pool scrub to verify data integrity",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const targetPool = requirePool(pool);
        const bins = await resolveBins(zpoolBin, zfsBin);

        context.logger.info("Starting scrub on pool {pool}", {
          pool: targetPool,
        });
        await run(bins.zpool, ["scrub", targetPool]);

        const handle = await context.writeResource("scrubResult", "current", {
          pool: targetPool,
          operation: "scrub-started",
          executedAt: new Date().toISOString(),
        });

        context.logger.info("Scrub started on {pool}", { pool: targetPool });
        return { dataHandles: [handle] };
      },
    },

    trim: {
      description: "Start a ZFS pool TRIM to reclaim freed space on SSDs",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { pool, zpoolBin, zfsBin } = context.globalArgs;
        const targetPool = requirePool(pool);
        const bins = await resolveBins(zpoolBin, zfsBin);

        context.logger.info("Starting TRIM on pool {pool}", {
          pool: targetPool,
        });
        await run(bins.zpool, ["trim", targetPool]);

        const handle = await context.writeResource("scrubResult", "trim", {
          pool: targetPool,
          operation: "trim-started",
          executedAt: new Date().toISOString(),
        });

        context.logger.info("TRIM started on {pool}", { pool: targetPool });
        return { dataHandles: [handle] };
      },
    },
  },
};
