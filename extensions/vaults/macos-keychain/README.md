# @bixu/macos-keychain

A [swamp](https://github.com/systeminit/swamp) vault extension that stores and
retrieves secrets using the macOS Keychain via the built-in `security` CLI.
Secrets are stored as generic password items scoped by a configurable service
name. Key enumeration is supported through an internal index entry maintained
alongside user secrets in the same keychain service.

## Prerequisites

- macOS (Darwin) — the `security` CLI ships with every macOS installation.
- swamp 20260525 or later.

## Installation

```bash
swamp extension pull @bixu/macos-keychain
```

## Configuration

Add the vault to your `.swamp.yaml`:

```yaml
vaults:
  keychain:
    type: "@bixu/macos-keychain"
    config:
      service: "swamp"   # optional — defaults to "swamp"
```

The `service` field controls the Keychain service name under which all secrets
are stored. Use a distinct service name per project to keep secrets isolated.

## Usage

Store, retrieve, and list secrets with the `swamp vault` CLI:

```bash
# Store a secret
swamp vault put keychain my-api-key "sk-live-abc123"

# Retrieve a secret
swamp vault get keychain my-api-key

# List all stored keys
swamp vault list-keys keychain
```

## Vault Expressions in Models

Reference vault secrets in model definitions using the `vault://` expression
syntax. Swamp resolves the expression at method execution time — the secret
value is never written to the datastore.

```yaml
globalArguments:
  apiToken:
    type: string
    default: "vault://keychain/my-api-key"
```

## Key Enumeration

Unlike the macOS Keychain's native API (which does not expose a simple
list-by-service operation via the `security` CLI), this provider maintains an
internal index entry under the key `__swamp_keychain_index__` in the same
keychain service. The index is updated atomically on every `put`. Do not use
`__swamp_keychain_index__` as a key name — it is reserved.

## Platform Support

This extension runs only on macOS:

- `darwin-aarch64` (Apple Silicon)
- `darwin-x86_64` (Intel)

## Prior Art

Adapted from
[@webframp/macos-keychain](https://github.com/webframp/swamp-extensions)
(Apache-2.0) with the following changes:

- `list()` returns a `string[]` instead of rejecting, fulfilling the
  `VaultProvider` interface contract and enabling `swamp vault list-keys`.
- Error messages include the key name and service name for easier debugging.
- `Deno.Command` is called without an unnecessary intermediate `spawn()`.
- Unit tests cover success and failure paths using `withMockedCommand`.

## License

MIT — see [LICENSE.md](LICENSE.md) for details.
