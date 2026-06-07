# @bixu/photos

Export photos from Apple Photos, process for web, and publish to Glass.

## Prerequisites

- macOS ARM64 (Apple Silicon)
- `aphex-swift` binary built and installed (see below)
- Playwright browsers installed: `npx playwright install chromium`
- Glass account with saved browser session

## Building aphex-swift

```bash
git clone https://github.com/kitschpatrol/aphex.git
cd aphex/native/aphex-swift
swift build --configuration release -Xswiftc -DDEBUG
cp .build/release/aphex-swift /usr/local/bin/
```

On first run, macOS will prompt for Photos library access.

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

The publish method uses Playwright with a persistent browser context stored at
`~/.swamp-glass-auth/`. Log in once with `headless=false`:

```bash
swamp model method run photos publish --input headless=false --json
```

After initial login, subsequent runs can use headless mode (the default).

## Global Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| album | (required) | Apple Photos album name |
| aphexBinaryPath | /usr/local/bin/aphex-swift | Path to built binary |
| exportDir | $TMPDIR/swamp-photos-{album} | Export destination |
