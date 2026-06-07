# @bixu/photos

Watch a directory for new photos, process for web, and publish to Glass.

Designed to run as a scheduled workflow via `swamp serve` — drop images into a
directory and they get resized and staged in Glass automatically.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Glass account (logged in via Safari)
- Safari > Developer > Allow JavaScript from Apple Events (enabled)
- System Settings > Privacy & Security > Accessibility (grant terminal app)

## Methods

### scan

Find new image files in the source directory that haven't been processed yet.

```bash
swamp model method run photos scan --json
```

### process

Resize and convert new files using macOS `sips`.

```bash
swamp model method run photos process --input maxWidth=2048 --input quality=90 --json
```

### publish

Stage processed photos in the Glass upload modal via Safari AppleScript.
Review and click Post manually.

```bash
swamp model method run photos publish --json
```

## Scheduled Workflow

Create a workflow that runs the full pipeline on a cron:

```yaml
name: glass-publish
trigger:
  schedule: "*/5 * * * *"
jobs:
  - name: pipeline
    steps:
      - name: scan
        task:
          type: model_method
          modelIdOrName: photos
          methodName: scan
      - name: process
        task:
          type: model_method
          modelIdOrName: photos
          methodName: process
      - name: publish
        task:
          type: model_method
          modelIdOrName: photos
          methodName: publish
```

Then run `swamp serve` to keep it active.

## Global Arguments

| Argument  | Default                  | Description                     |
| --------- | ------------------------ | ------------------------------- |
| sourceDir | (required)               | Directory to watch for photos   |
| exportDir | sourceDir/processed      | Output directory for processed files |

## How It Works

The `scan` method tracks which files have already been processed via a
persistent swamp resource (`scan-state`). On each run, it diffs the current
directory listing against the tracked set and only passes new files forward.
This makes the pipeline idempotent — re-running produces no duplicates.
