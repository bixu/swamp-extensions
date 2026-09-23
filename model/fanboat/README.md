# @bixu/fanboat

Skim over the surface of your swamp and enjoy the view.

Fanboat maps a swamp repo as one graph and draws it as an interactive D3 page.
It reads the files every swamp repo has, so it works on any repo with no
configuration.

## What it maps

| Lane      | Source                                                       |
| --------- | ------------------------------------------------------------ |
| Workflows | `workflows/**/*.yaml` (steps that call models or workflows)  |
| Models    | `models/**/*.yaml` (instance name and type)                  |
| Types     | `export const model` / `extension` in extension TypeScript   |
| Vaults    | `vaults/**/*.yaml`, plus `vault.get(...)` refs in model YAML |
| Modules   | Extension manifests and `extensions/**/*.ts`, with imports   |
| Packages  | `npm:`, `jsr:`, `node:` and URL imports                      |

The datastore from `.swamp.yaml` shows in the page header.

Code analysis runs in-process through
[`@deno/graph`](https://jsr.io/@deno/graph) and
[`@deno/doc`](https://jsr.io/@deno/doc). Fanboat never fetches or runs the code
it maps. External imports become package nodes.

## Usage

```bash
swamp extension pull @bixu/fanboat
swamp model create @bixu/fanboat fanboat
swamp model method run fanboat map
```

Map a different repo with `--input path=/path/to/repo`.

The method writes two outputs:

- `graph`: a resource with the nodes, edges and counts. Query it with CEL from
  other models or reports.
- `html`: a file that holds the self-contained D3 page. Open it in a browser.

```bash
swamp data get fanboat <repo-name>-graph --json  # graph
swamp data get fanboat <repo-name>-page --json   # D3 page
```

## Example: Generate a Map in CI

This GitHub Actions job maps the repo on every push to `main` and publishes
the page to GitHub Pages. It assumes the runner already has the swamp CLI on
`PATH`. The job maps the checkout from a scratch swamp repo, so it never
writes to the datastore of the repo it maps.

```yaml
name: Repo map
on:
  push:
    branches: [main]
jobs:
  map:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
    steps:
      - uses: actions/checkout@v4
      - name: Map the repo
        working-directory: ${{ runner.temp }}
        run: |
          set -euo pipefail
          mkdir fanboat site && cd fanboat
          swamp repo init --json > /dev/null
          swamp extension pull @bixu/fanboat --json > /dev/null
          swamp model create @bixu/fanboat fanboat --json > /dev/null
          swamp model method run fanboat map \
            --input path="$GITHUB_WORKSPACE" --json > /dev/null
          repo=$(basename "$GITHUB_WORKSPACE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')
          swamp data get fanboat "$repo-page" --json | jq -r .content > ../site/index.html
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${{ runner.temp }}/site
      - uses: actions/deploy-pages@v4
```

To fail a pull request when the map finds something broken, add this line
after the `map` step:

```bash
test "$(swamp data get fanboat "$repo-graph" --json | jq .content.stats.broken)" -eq 0
```

## Reading the page

Lanes run left to right. A workflow calls a model's method. The model is an
instance of a type. A module defines the type, imports other modules, and
depends on packages.

The Models lane shows one node per type, for example `deploy-web +3`. Select
it to list every instance. The `graph` resource still holds each instance.

Select any node to trace its lineage in both directions. A dashed node is one
the repo mentions but does not define, for example a type from a pulled
extension.

## Problems

Fanboat flags nodes that look wrong. The page marks them in red or amber, and
the toolbar lists them all. The `graph` resource keeps them in each node's
`issues` field, with totals in `stats.broken` and `stats.suspicious`.

| Level      | Rule                                                               |
| ---------- | ------------------------------------------------------------------ |
| broken     | A workflow calls a method that the model's type does not define    |
| broken     | A local import points at a file that is missing or does not parse  |
| broken     | Two model or workflow files share one name                         |
| suspicious | A workflow calls a model or workflow that has no file in the repo  |
| suspicious | A model reads a vault that has no file in the repo                 |
| suspicious | The repo defines a type, but no model in the repo uses it          |

Fanboat checks methods only for types the repo defines in full. It skips a
type that the repo only extends, because the other methods live elsewhere.

## Limits

- Structure only: imports, exports, and workflow → model → type links. No
  function-level call graph.
- Fanboat skips pulled extensions under `.swamp/`. Their types show as dashed
  nodes.
- Fanboat skips workflow steps that name their model with a `${{ }}` expression.
- Fanboat reads workflows from `workflows/` on disk. It does not see workflows
  that live only in a remote datastore.

## License

MIT
