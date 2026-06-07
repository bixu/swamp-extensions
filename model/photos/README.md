# @bixu/photos

Export photos from Apple Photos, process for web, and publish to Glass.

## Prerequisites

- macOS ARM64 (Apple Silicon)
- Glass account (logged in via Safari)
- Safari > Developer > Allow JavaScript from Apple Events (enabled)
- System Settings > Privacy & Security > Accessibility (grant terminal app)

On first run, macOS will prompt for Photos library access (TCC).

## Architecture

This extension bundles [aphex-swift](https://github.com/kitschpatrol/aphex), a
Swift binary by [Eric Mika (@kitschpatrol)](https://github.com/kitschpatrol)
that uses Apple's PhotoKit framework to query and export from the macOS Photos
library. The binary is MIT-licensed and built from source — see the
[aphex repository](https://github.com/kitschpatrol/aphex) for full source and
documentation.

Image processing uses macOS `sips` (built-in). Glass uploads use Safari
AppleScript automation with base64 file injection.

## Methods

### export

Export photos from a named album via the aphex-swift binary.

```bash
swamp model method run photos export --json
```

### process

Resize and convert exported photos for Glass using sharp.

```bash
swamp model method run photos process --input maxWidth=2048 --input quality=90 --json
```

### publish

Upload processed photos to Glass via Playwright browser automation.

```bash
swamp model method run photos publish --json
```

## Glass Authentication

The publish method opens Safari and stages the photo in the Glass upload modal.
You must be logged into Glass in Safari — the extension uses your existing
browser session. Review the staged photo and click Post manually.

## Global Arguments

| Argument        | Default                     | Description                            |
| --------------- | --------------------------- | -------------------------------------- |
| album           | (required)                  | Apple Photos album name                |
| aphexBinaryPath | (bundled binary)            | Override path to aphex-swift if needed |
| exportDir       | $TMPDIR/swamp-photos-{slug} | Export destination                     |

## Credits

- **aphex-swift** by
  [Eric Mika (@kitschpatrol)](https://github.com/kitschpatrol) — MIT license
- **PhotoKit** access via Apple's native framework
- **sips** — macOS built-in image processing
