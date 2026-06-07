# @bixu swamp extensions

Monorepo of publishable [swamp](https://github.com/swamp-club/swamp) extensions.

## Extensions

| Extension | Description |
|-----------|-------------|
| [@bixu/wheelshop](model/wheelshop/) | Trust-gate auditor for npm/jsr packages in swamp extensions |
| [@bixu/github](model/github/) | GitHub repos, issues, PRs, and members via Octokit |
| [@bixu/github-security](model/github-security/) | GitHub security advisories and vulnerability scanning |
| [@bixu/honeycomb](model/honeycomb/) | Honeycomb observability queries and dataset management |
| [@bixu/slack](model/slack/) | Slack messaging and channel management |
| [@bixu/tailnet-healthcheck](model/tailnet-healthcheck/) | Tailnet health reporting for outdated Tailscale clients |
| [@bixu/homekit](model/homekit/) | HomeKit accessory control via HAP |
| [@bixu/zfs](model/zfs/) | ZFS pool, dataset, and snapshot management |
| [@bixu/k8s-exec](model/k8s-exec/) | Kubernetes pod command execution |

## Layout

```
model/<name>/       Self-contained extension (manifest, source, tests, deno.json)
extensions/models/  Pulled extension lockfile only (upstream_extensions.json)
.claude/skills/     Skills for Claude Code
```

## Development

```bash
cd model/<name>
deno fmt --check && deno lint && deno task test
swamp extension push manifest.yaml --json
```

## Testing published extensions

```bash
swamp extension pull @bixu/<name>
```

## License

MIT
