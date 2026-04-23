# @bixu/tailnet-healthcheck

Tailnet health reporting for [swamp](https://github.com/systeminit/swamp) — queries the Tailscale API to find devices running outdated client versions and optionally posts a report to Slack.

## License

MIT

## Installation

```bash
swamp extension pull @bixu/tailnet-healthcheck
```

## Requirements

- Tailscale API key or OAuth client credentials
- Optional: Slack bot token with `files:write` and `chat:write` scopes

## Quickstart

```bash
# Create a model instance
swamp model create @bixu/tailnet-healthcheck my-tailnet \
  --global-arg tailnet=my-org \
  --global-arg apiKey=tskey-api-... \
  --json

# Run an outdated-client health report
swamp model method run my-tailnet run \
  --input reportType=outdated-client \
  --json
```

## Global Arguments

| Argument            | Required | Description                                                         |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `tailnet`           | Yes      | Tailnet name (org name or `-` for default)                          |
| `apiKey`            | No*      | Tailscale API key (sensitive)                                       |
| `oauthClientId`     | No*      | OAuth client ID                                                     |
| `oauthClientSecret` | No*      | OAuth client secret (sensitive)                                     |
| `slackChannel`      | No       | If set, auto-send the report to this Slack channel                  |
| `slackToken`        | No       | Slack bot token (sensitive, required if `slackChannel` is set)      |

*Either `apiKey` or `oauthClientId` + `oauthClientSecret` is required.

## Methods

### `run`

Runs a health report by type and optionally sends it to Slack.

```bash
# Just generate the report
swamp model method run my-tailnet run \
  --input reportType=outdated-client \
  --json

# Generate and send to Slack
swamp model create @bixu/tailnet-healthcheck my-tailnet \
  --global-arg tailnet=my-org \
  --global-arg apiKey=tskey-api-... \
  --global-arg slackChannel="#infra-alerts" \
  --global-arg slackToken=xoxb-... \
  --json
swamp model method run my-tailnet run --input reportType=outdated-client --json
```

The security floor (minimum safe client version) is determined dynamically from the [Tailscale security bulletins RSS feed](https://tailscale.com/security-bulletins/index.xml), falling back to a hardcoded constant if the feed is unavailable.

## Resources

| Resource          | Description                                              | Lifetime |
| ----------------- | -------------------------------------------------------- | -------- |
| `outdatedClients` | Devices below the minimum safe Tailscale client version  | infinite |

## CEL Expressions

```yaml
# Count of outdated devices
outdated_count: ${{ data.latest("my-tailnet", "outdatedClients").attributes.devices | size }}

# Security floor version used
floor: ${{ data.latest("my-tailnet", "outdatedClients").attributes.securityFloor }}
```
