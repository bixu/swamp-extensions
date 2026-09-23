/**
 * @module
 * Fanboat — map the code and design of any swamp repo as one graph and
 * render it as an interactive D3 page.
 *
 * Single method:
 * - **map** — scan a repo's extension manifests, extension TypeScript, model
 *   definitions, workflows, vaults and datastore config. Write the graph as
 *   a `graph` resource and a self-contained D3 page as an `html` file.
 *
 * Code analysis runs in-process through `@deno/graph` (module imports) and
 * `@deno/doc` (module docs, exported symbols, model types and methods).
 * External imports are never fetched; they become package nodes.
 */
import { z } from "npm:zod@4";
import { createGraph } from "jsr:@deno/graph@0.111.0";
import { doc } from "jsr:@deno/doc@0.207.0";
import {
  fromFileUrl,
  relative,
  resolve as resolvePath,
  toFileUrl,
} from "jsr:@std/path@1.1.6";
import {
  buildGraph,
  type CodeGraph,
  type CodeModule,
  packageId,
  scanRepo,
  stringPropAt,
} from "./fanboat_scan.ts";

const EXTERNAL = "https://external.invalid/";

type LoadResult =
  | { kind: "module"; specifier: string; content: string }
  | { kind: "external"; specifier: string };

/** Load local files from disk; mark everything else external. */
async function load(specifier: string): Promise<LoadResult | undefined> {
  if (!specifier.startsWith("file:")) return { kind: "external", specifier };
  try {
    return {
      kind: "module",
      specifier,
      content: await Deno.readTextFile(new URL(specifier)),
    };
  } catch {
    return undefined;
  }
}

/** Keep `@deno/doc` from resolving `npm:`/`jsr:` against a registry. */
function resolveForDoc(specifier: string, referrer: string): string {
  return /^(npm|jsr|node|https?):/.test(specifier)
    ? EXTERNAL + encodeURIComponent(specifier)
    : new URL(specifier, referrer).href;
}

// deno-lint-ignore no-explicit-any
type Any = any;

/** Analyse the module graph reachable from `entries` (absolute paths). */
export async function analyzeCode(entries: string[]): Promise<CodeModule[]> {
  if (entries.length === 0) return [];
  const roots = [...new Set(entries)].map((p) => toFileUrl(p).href);
  const graph = await createGraph(roots, { load });
  const files = graph.modules.filter((m) => m.specifier.startsWith("file:"));
  const local = files.filter((m) => !m.error);
  const failed: CodeModule[] = files.filter((m) => m.error).map((m) => ({
    path: fromFileUrl(m.specifier),
    doc: "",
    exports: [],
    imports: [],
    packages: [],
    types: [],
    error: String(m.error).split("\n")[0],
  }));
  const docs: Record<string, Any> = local.length
    ? await doc(local.map((m) => m.specifier), { load, resolve: resolveForDoc })
    : {};

  const analysed = await Promise.all(local.map(async (m) => {
    const imports: string[] = [];
    const packages = new Set<string>();
    for (const d of m.dependencies ?? []) {
      const s = d.code?.specifier ?? d.type?.specifier ?? d.specifier;
      if (s.startsWith("file:")) imports.push(fromFileUrl(s));
      else {
        const p = packageId(s);
        if (p) packages.add(p);
      }
    }
    const d = docs[m.specifier] ?? {};
    const source = await Deno.readTextFile(new URL(m.specifier));
    const types: CodeModule["types"] = [];
    const exports: string[] = [];
    for (const sym of d.symbols ?? []) {
      exports.push(sym.name);
      if (sym.name !== "model" && sym.name !== "extension") continue;
      const props = sym.declarations?.[0]?.def?.tsType?.value?.properties ?? [];
      const typeProp = props.find((p: Any) => p.name === "type");
      const type = typeProp
        ? stringPropAt(source, typeProp.location.byteIndex)
        : null;
      if (!type) continue;
      const methods = props.find((p: Any) =>
        p.name === "methods"
      )?.tsType?.value?.properties
        ?.map((p: Any) => p.name) ?? [];
      types.push({ type, methods, extends: sym.name === "extension" });
    }
    return {
      path: fromFileUrl(m.specifier),
      // `@module` followed by prose lands in the tag's name, not in `doc`.
      doc: d.module_doc?.doc ||
        d.module_doc?.tags?.find((t: Any) => t.kind === "module")?.name || "",
      exports,
      imports,
      packages: [...packages].sort(),
      types,
    };
  }));
  return [...analysed, ...failed];
}

/** Render the D3 page: the template with the graph JSON inlined. */
export function renderHtml(template: string, graph: CodeGraph): string {
  const json = JSON.stringify(graph).replace(/</g, "\\u003c");
  return template.replace("__FANBOAT_DATA__", () => json)
    .replace(
      "__FANBOAT_TITLE__",
      () => `${graph.repo} · fanboat`.replace(/</g, ""),
    );
}

/** Instance names map to datastore paths: keep them flat and safe. */
export function instanceName(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? "repo";
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  ) || "repo";
}

const NodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["workflow", "model", "vault", "type", "module", "package"]),
  label: z.string(),
  group: z.string(),
  path: z.string().optional(),
  doc: z.string().optional(),
  methods: z.array(z.string()).optional(),
  role: z.string().optional(),
  unresolved: z.boolean().optional(),
  issues: z.array(z.object({
    level: z.enum(["broken", "suspicious"]),
    message: z.string(),
  })).optional(),
});

const EdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum([
    "calls",
    "runs",
    "instanceOf",
    "usesVault",
    "definedIn",
    "imports",
    "dependsOn",
  ]),
  label: z.string().optional(),
});

const GraphSchema = z.object({
  repo: z.string(),
  datastore: z.string().nullable(),
  generatedAt: z.string(),
  stats: z.record(z.string(), z.number()),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

const MapArgs = z.object({
  path: z.string().optional().describe(
    "Repo root to map. Defaults to the swamp repo this model runs in.",
  ),
});

/** Fanboat extension model. */
export const model = {
  type: "@bixu/fanboat",
  version: "2026.09.23.1",
  globalArguments: z.object({}),
  resources: {
    graph: {
      description:
        "Nodes and edges for one repo: workflows, models, vaults, types, modules, packages",
      schema: GraphSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  files: {
    html: {
      description: "Self-contained D3 page that draws the graph",
      contentType: "text/html",
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    map: {
      description:
        "Map a swamp repo's extensions, models, workflows, vaults and datastore into one graph, and render it as an interactive D3 page.",
      arguments: MapArgs,
      execute: async (args: z.infer<typeof MapArgs>, context: Any) => {
        const root = resolvePath(context.repoDir, args.path ?? ".");
        context.logger.info("fanboat: scanning {root}", { root });
        const info = await Deno.stat(root).catch(() => null);
        if (!info?.isDirectory) {
          throw new Error(
            `fanboat: cannot map ${root}: not a directory. Pass --input path=<repo root>.`,
          );
        }
        const scan = await scanRepo(root);
        if (scan.skipped.length) {
          context.logger.warn(
            "fanboat: skipped {count} YAML file(s) that do not parse: {files}",
            {
              count: scan.skipped.length,
              files: scan.skipped.map((p) => relative(root, p)).join(", "),
            },
          );
        }
        const entries = [
          ...scan.manifests.flatMap((m) => m.entries.map((e) => e.path)),
          ...scan.localSources,
        ];
        const code = await analyzeCode(entries);
        const graph = buildGraph(scan, code);
        context.logger.info("fanboat: {stats}", {
          stats: JSON.stringify(graph.stats),
        });

        // Build everything before the first write, so a failure leaves no partial output.
        const template = await Deno.readTextFile(
          context.extensionFile("fanboat.html.txt"),
        );
        const page = renderHtml(template, graph);
        const name = instanceName(root);
        const graphHandle = await context.writeResource(
          "graph",
          `${name}-graph`,
          graph,
        );
        const htmlHandle = await context.createFileWriter(
          "html",
          `${name}-page`,
        )
          .writeText(page);
        context.logger.info("fanboat: wrote {graph} and {page}", {
          graph: `${name}-graph`,
          page: `${name}-page`,
        });

        await Deno.stdout.write(new TextEncoder().encode(
          JSON.stringify({ repo: graph.repo, stats: graph.stats }, null, 2) +
            "\n",
        ));
        return { dataHandles: [graphHandle, htmlHandle] };
      },
    },
  },
};
