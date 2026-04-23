# @bixu/github

GitHub automation models for [swamp](https://github.com/systeminit/swamp) — manage repos, issues, pull requests, and members using the Octokit REST SDK. Also includes `@bixu/github-security` for repository security auditing.

## License

MIT

## Installation

```bash
swamp extension pull @bixu/github
swamp extension pull @bixu/github-security
```

## Quickstart

```bash
# Create a model instance
swamp model create @bixu/github/repo my-github \
  --global-arg token=ghp_... \
  --global-arg org=my-org \
  --json

# List repos
swamp model method run my-github list --json
```

## Global Arguments

| Argument | Required | Description                              |
| -------- | -------- | ---------------------------------------- |
| `token`  | Yes      | GitHub personal access token (sensitive) |
| `org`    | No       | Default GitHub organization              |
| `owner`  | No       | Default repository owner                |

## Models

### `@bixu/github/repo`
Manage GitHub repositories — list, get, create, archive.

### `@bixu/github/issue`
Search and manage GitHub issues across repos and orgs.

### `@bixu/github/pull`
Search and inspect GitHub pull requests.

### `@bixu/github/member`
List and manage organization members.

### `@bixu/github-security`
Audit repository security posture — secret scanning, Dependabot, code scanning, and third-party security tool coverage.

```bash
swamp model create @bixu/github-security my-security-audit \
  --global-arg token=ghp_... \
  --json
swamp model method run my-security-audit auditOrg --input org=my-org --json
```
