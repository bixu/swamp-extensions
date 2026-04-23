# @bixu/honeycomb

A [swamp](https://github.com/systeminit/swamp) extension model for managing
Honeycomb observability resources. Supports both the v2 Management API
(environments, API keys) and the v1 Configuration API (datasets, triggers,
boards, columns, derived columns, SLOs, and more).

## Installation

```bash
swamp extension pull @bixu/honeycomb
```

## Usage

Create a model definition that references the extension type and provide
your Honeycomb credentials via vault expressions or plain values:

```yaml
type: "@bixu/honeycomb"
name: honeycomb
globalArguments:
  teamSlug: "my-team"
  apiKeyId: ${{ vault.get('honeycomb', 'api_key_id') }}
  apiKeySecret: ${{ vault.get('honeycomb', 'api_key_secret') }}
  region: us
  configKey: ${{ vault.get('honeycomb', 'config_key') }}
```

Then run methods against the model:

```bash
# List all environments
swamp model method run honeycomb get --input resource=environments --json

# List datasets (v1 API, requires configKey)
swamp model method run honeycomb get --input resource=datasets --json

# Create a new environment
swamp model method run honeycomb create \
  --input resource=environments \
  --input name=staging --json
```

## Supported Resources

**v2 Management API**: environments, api-keys

**v1 Configuration API**: datasets, triggers, boards, columns,
derived-columns, slos, recipients, markers, marker-settings,
dataset-definitions, burn-alerts

## License

MIT
