# @bixu/tailnet-healthcheck

A [swamp](https://github.com/systeminit/swamp) extension that monitors your
Tailscale tailnet for devices running outdated client versions with known
security vulnerabilities. It dynamically fetches the minimum safe client
version from the Tailscale security bulletins RSS feed and reports any devices
below that threshold. Reports can optionally be sent to Slack as threaded
messages with a CSV attachment listing all affected devices.

## Installation

Install from the swamp extension registry:

```bash
swamp extension pull @bixu/tailnet-healthcheck
```

## Configuration

Create a model definition that references the extension type and provide your
Tailscale credentials via vault expressions:

```yaml
type: "@bixu/tailnet-healthcheck"
name: tailnet-healthcheck
globalArgs:
  tailnet: "example.com"
  apiKey: ${{ vault.get('tailscale', 'API_KEY') }}
  slackChannel: "#security-alerts"
  slackToken: ${{ vault.get('slack', 'BOT_TOKEN') }}
```

## Usage

### Outdated Client Report

The `outdated-client` report type identifies devices running Tailscale client
versions below the minimum safe version derived from published security
bulletins. Each bulletin that requires a client update contributes to the
security floor version.

Run the report:

```bash
swamp model method run tailnet-healthcheck run \
  --input reportType=outdated-client \
  --json
```

The report produces a structured `outdatedClients` resource containing:

- **generatedAt** -- ISO 8601 timestamp of the report
- **securityFloor** -- the minimum safe client version
- **securityFloorSource** -- whether the floor came from the RSS feed or the
  built-in default
- **devices** -- array of hostname, version, and owner for each affected device
- **markdown** -- a pre-formatted Markdown summary table

### Slack Integration

When `slackChannel` and `slackToken` are configured, the report is
automatically posted as a threaded Slack message with a CSV file attachment
listing all affected devices and their full API metadata.

## License

MIT -- see [LICENSE.txt](LICENSE.txt).
