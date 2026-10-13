# @bixu/tailscale-community

Community add-ons for the official
[`@swamp/tailscale`](https://github.com/swamp-club/swamp-extensions) extension.
The useful parts of other community Tailscale extensions are collected here and
retargeted onto the official, maintained model types. Every borrowed file
credits its source, and the full record is in
[`prior-art.yaml`](prior-art.yaml), checked by
[`@bixu/wheelshop`](https://github.com/bixu/swamp-extensions/tree/main/model/wheelshop)'s
`attribute` method.

## Installation

```bash
swamp extension pull @bixu/tailscale-community
```

This pulls `@swamp/tailscale` as a dependency.

## What it adds

### `@swamp/tailscale/policy-file`: `drift` and `propose`

From [`@sntxrr/tailscale-acl-drift`](https://github.com/sntxrr/swamp-tailscale),
originally written for `@john/tailscale-acl`:

- **`drift`** compares the policy live on your tailnet against the
  `policy.hujson` in your GitOps repo.
- **`propose`** writes a proposed `policy.hujson` byte-for-byte (comments
  survive), diffs it against the live policy, and returns a pull-request title,
  body and commit message.

Neither method writes to the tailnet. Your GitOps pipeline stays the only
writer, so swamp and CI can't race each other (last push wins).

The comparison is semantic. Comments, whitespace and object key order are not
drift. ACL rule order and added, removed or changed sections are, because rule
order matters in Tailscale.

Both methods read the snapshot that the base model's `get` writes, so run `get`
first:

```bash
swamp model method run my-policy get
swamp model method run my-policy drift \
  --input policyPath=/absolute/path/to/policy.hujson
swamp model method run my-policy propose \
  --input sourcePath=/tmp/proposed.hujson \
  --input targetPath=/absolute/path/to/policy.hujson
```

`my-policy` is a model of type `@swamp/tailscale/policy-file`.

Changes from the original:

- Targets `@swamp/tailscale/policy-file`, which is maintained and licensed. The
  original targeted `@john/tailscale-acl`, which ships no license.
- Parses the HuJSON text the official `get` stores, rather than expecting a
  pre-parsed policy object.
- Fixes trailing-comma removal so it no longer edits text inside strings (e.g. a
  policy value `"a, ]"`).
- Adds tests.

## Considered, not included

- `@josephholsten/tailscale/net` (`sync`/`delete` for devices) is already
  covered by `@swamp/tailscale/device` `list`/`delete`.
- `@john/tailscale` ships no license, so none of its code can be reused.

## License

MIT, with the notices for included code in `LICENSE.txt`.
