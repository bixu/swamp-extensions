# @bixu/zfs

ZFS filesystem management and monitoring for [swamp](https://github.com/systeminit/swamp) — import pools, sync health status, take snapshots, prune old snapshots, and schedule scrubs and TRIMs via launchd.

## License

MIT

## Installation

```bash
swamp extension pull @bixu/zfs
```

## Requirements

- OpenZFS installed (`zpool` and `zfs` CLI binaries present)
- macOS (darwin-aarch64, darwin-x86_64) or Linux (linux-x86_64, linux-aarch64)
- macOS: `launchctl` and `osascript` for the `import` forced-import dialog

## Quickstart

```bash
# Create a model instance targeting the 'tank' pool
swamp model create @bixu/zfs tank-zfs --global-arg pool=tank --json

# Sync pool status, datasets, and snapshots
swamp model method run tank-zfs sync --json

# Check pool health
swamp data latest tank-zfs status --json
```

## Global Arguments

| Argument   | Default                | Description                                           |
| ---------- | ---------------------- | ----------------------------------------------------- |
| `pool`     | (none)                 | ZFS pool name (e.g. `tank`). Required for most methods. |
| `zpoolBin` | `/usr/local/bin/zpool` | Path to the `zpool` binary.                           |
| `zfsBin`   | `/usr/local/bin/zfs`   | Path to the `zfs` binary.                             |

## Methods

### `sync`

Fetches current pool status, dataset list, and snapshot inventory. Safe for periodic launchd runs.

```bash
swamp model method run tank-zfs sync --json
```

### `import`

Imports ZFS pools from attached devices. Uses `zpool import -a` when no pool is set. Designed for IOKit launchd triggers on device attach. On macOS, prompts the user via a native dialog before performing forced imports.

```bash
swamp model method run tank-zfs import --json
# Specify a custom device directory
swamp model method run tank-zfs import --input deviceDir=/Volumes --json
```

### `export`

Exports the ZFS pool — unmounts all datasets and prepares drives for safe removal.

```bash
swamp model method run tank-zfs export --json
swamp model method run tank-zfs export --input force=true --json
```

### `snapshot`

Creates a named ZFS snapshot.

```bash
swamp model method run tank-zfs snapshot --input name=pre-upgrade --json
# Snapshot a specific dataset recursively
swamp model method run tank-zfs snapshot \
  --input dataset=tank/data \
  --input name=manual-2026-04-23 \
  --input recursive=true \
  --json
```

### `autoSnapshot`

Creates timestamped snapshots of all datasets in the pool — designed for scheduled launchd retention runs. The snapshot name is `<prefix>-<timestamp>`.

```bash
swamp model method run tank-zfs autoSnapshot --input prefix=daily --json
# Snapshot specific datasets only
swamp model method run tank-zfs autoSnapshot \
  --input prefix=hourly \
  --input 'datasets=["tank/data","tank/home"]' \
  --json
```

### `destroySnapshot`

Destroys a specific ZFS snapshot by its full name.

```bash
swamp model method run tank-zfs destroySnapshot \
  --input snapshot=tank/data@daily-2026-04-01-09-00 \
  --json
```

### `pruneSnapshots`

Destroys snapshots matching a prefix that are older than `keepDays`, always retaining at least `keepCount`. Designed for scheduled retention runs.

```bash
# Dry-run to preview what would be pruned
swamp model method run tank-zfs pruneSnapshots \
  --input dataset=tank/data \
  --input prefix=daily \
  --input keepDays=30 \
  --input keepCount=7 \
  --input dryRun=true \
  --json

# Live prune
swamp model method run tank-zfs pruneSnapshots \
  --input dataset=tank/data \
  --input prefix=daily \
  --input keepDays=30 \
  --input keepCount=7 \
  --json
```

### `scrub`

Starts a ZFS pool scrub to verify data integrity.

```bash
swamp model method run tank-zfs scrub --json
```

### `trim`

Starts a ZFS pool TRIM to reclaim freed space on SSDs.

```bash
swamp model method run tank-zfs trim --json
```

## Resources

| Resource         | Description                                         | Lifetime |
| ---------------- | --------------------------------------------------- | -------- |
| `status`         | Pool health, capacity, fragmentation, device states | infinite |
| `datasets`       | ZFS filesystems and volumes in the pool             | infinite |
| `snapshots`      | ZFS snapshots in the pool                           | infinite |
| `snapshotResult` | Result of a snapshot create, destroy, or prune      | 7 days   |
| `scrubResult`    | Result of a scrub or trim operation                 | 7 days   |
| `importResult`   | Result of a pool import or export operation         | 7 days   |

## CEL Expressions

Reference ZFS data in workflow steps and conditions:

```yaml
# Pool health status
pool_health: ${{ data.latest("tank-zfs", "status").attributes.health }}

# Capacity percentage used
capacity_pct: ${{ data.latest("tank-zfs", "status").attributes.capacityPct }}

# Number of datasets
dataset_count: ${{ data.latest("tank-zfs", "datasets").attributes.count }}

# Number of snapshots
snapshot_count: ${{ data.latest("tank-zfs", "snapshots").attributes.count }}
```

## Example Workflow: Daily Maintenance

```yaml
name: zfs-daily-maintenance
jobs:
  maintain:
    steps:
      - model: tank-zfs
        method: autoSnapshot
        inputs:
          prefix: daily
      - model: tank-zfs
        method: pruneSnapshots
        inputs:
          dataset: tank/data
          prefix: daily
          keepDays: 30
          keepCount: 7
      - model: tank-zfs
        method: scrub
      - model: tank-zfs
        method: sync
```

## Example Workflow: Device Attach (macOS launchd IOKit)

```yaml
name: zfs-device-attach
jobs:
  import-pool:
    steps:
      - model: tank-zfs
        method: import
      - model: tank-zfs
        method: sync
```
