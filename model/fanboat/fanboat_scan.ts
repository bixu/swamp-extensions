/**
 * @module
 * Repo scanning and graph assembly for `@bixu/fanboat`.
 *
 * `scanRepo` reads the swamp-shaped files every repo has (extension
 * manifests, model definitions, workflows, vaults, `.swamp.yaml`).
 * `buildGraph` is pure: it joins that scan with the code analysis into one
 * node/edge graph for the D3 view.
 */
import { parse as parseYaml } from "jsr:@std/yaml@1.2.0";
import { walk } from "jsr:@std/fs@1.0.24/walk";
import { exists } from "jsr:@std/fs@1.0.24/exists";
import { dirname, join, relative } from "jsr:@std/path@1.1.6";

/** Directories never worth walking. */
const SKIP = [
  /[\\/]\.git([\\/]|$)/,
  /[\\/]node_modules([\\/]|$)/,
  /[\\/]\.swamp([\\/]|$)/,
  /[\\/]\.claude([\\/]|$)/,
];

/** Manifest keys that list TypeScript entry points, by default base dir. */
const TS_KINDS = {
  models: "models",
  reports: "reports",
  datastores: "datastores",
  vaults: "vaults",
  drivers: "drivers",
} as const;

/** A TS entry point listed by an extension manifest. */
export interface ManifestEntry {
  path: string;
  role: keyof typeof TS_KINDS;
}

/** One extension manifest. */
export interface ManifestInfo {
  name: string;
  version: string;
  description: string;
  dir: string;
  entries: ManifestEntry[];
}

/** One model definition (`models/<type>/<name>.yaml`). */
export interface ModelDef {
  id: string;
  name: string;
  type: string;
  path: string;
  vaults: string[];
}

/** One workflow step that points at a model method or another workflow. */
export interface WorkflowStep {
  job: string;
  step: string;
  model?: string;
  method?: string;
  workflow?: string;
}

/** One workflow definition. */
export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  path: string;
  steps: WorkflowStep[];
}

/** One vault definition. */
export interface VaultDef {
  id: string;
  name: string;
  type: string;
  path: string;
}

/** Everything `scanRepo` finds outside the TypeScript. */
export interface RepoScan {
  root: string;
  manifests: ManifestInfo[];
  localSources: string[];
  models: ModelDef[];
  workflows: WorkflowDef[];
  vaults: VaultDef[];
  datastore: string | null;
  /** YAML files that exist but fail to parse. */
  skipped: string[];
}

/** One analysed TS module. Paths are absolute. */
export interface CodeModule {
  path: string;
  doc: string;
  exports: string[];
  imports: string[];
  packages: string[];
  types: { type: string; methods: string[]; extends: boolean }[];
  /** Set when the module failed to load (missing file, parse error). */
  error?: string;
}

/** Node kinds, in lane order left to right. */
export type NodeKind =
  | "workflow"
  | "model"
  | "vault"
  | "type"
  | "module"
  | "package";

/** A graph node. */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  group: string;
  path?: string;
  doc?: string;
  methods?: string[];
  role?: string;
  unresolved?: boolean;
  issues?: Issue[];
}

/** Something on the map that looks broken or worth a second look. */
export interface Issue {
  level: "broken" | "suspicious";
  message: string;
}

/** A graph edge. */
export interface GraphEdge {
  source: string;
  target: string;
  kind:
    | "calls"
    | "runs"
    | "instanceOf"
    | "usesVault"
    | "definedIn"
    | "imports"
    | "dependsOn";
  label?: string;
}

/** The whole map. */
export interface CodeGraph {
  repo: string;
  datastore: string | null;
  generatedAt: string;
  stats: Record<string, number>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// deno-lint-ignore no-explicit-any
type Yaml = any;

/** Parse a YAML file. A file that exists but fails to parse lands in `skipped`. */
async function readYaml(path: string, skipped: string[]): Promise<Yaml> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  try {
    return parseYaml(text);
  } catch {
    skipped.push(path);
    return null;
  }
}

async function yamlFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  for await (
    const e of walk(dir, {
      exts: [".yaml", ".yml"],
      includeDirs: false,
      skip: SKIP,
    })
  ) out.push(e.path);
  return out.sort();
}

/** Vault names referenced as `vault.get(<name>, ...)`, quoted or not. */
export function vaultRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/vault\.get\(\s*["']?([\w.-]+)/g)) {
    out.add(m[1]);
  }
  return [...out].sort();
}

/** Collapse an import specifier to a package id, or null for local files. */
export function packageId(specifier: string): string | null {
  const reg = specifier.match(/^(npm|jsr):\/?(@[^/@]+\/[^/@]+|[^/@]+)/);
  if (reg) return `${reg[1]}:${reg[2]}`;
  if (specifier.startsWith("node:")) return specifier.split("/")[0];
  if (/^https?:/.test(specifier)) {
    const u = new URL(specifier);
    const seg = u.pathname.split("/").filter(Boolean)[0] ?? "";
    return `${u.host}/${seg.replace(/@.*$/, "")}`.replace(/\/$/, "");
  }
  return null;
}

/** Read the string literal at a byte offset, e.g. `type: "@a/b"`. */
export function stringPropAt(source: string, byteIndex: number): string | null {
  const bytes = new TextEncoder().encode(source);
  const tail = new TextDecoder().decode(
    bytes.slice(byteIndex, byteIndex + 400),
  );
  return tail.match(/^\w+\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
}

async function resolveEntry(
  root: string,
  manifestDir: string,
  kindDir: string,
  file: string,
  baseIsManifest: boolean,
): Promise<string | null> {
  const tries = baseIsManifest
    ? [join(manifestDir, file)]
    : [join(root, "extensions", kindDir, file), join(manifestDir, file)];
  for (const t of tries) if (await exists(t, { isFile: true })) return t;
  return null;
}

/** Walk the repo's swamp files. Never throws on one bad file. */
export async function scanRepo(root: string): Promise<RepoScan> {
  const skipped: string[] = [];
  const manifests: ManifestInfo[] = [];
  for await (
    const e of walk(root, {
      match: [/[\\/]manifest\.ya?ml$/],
      includeDirs: false,
      skip: SKIP,
    })
  ) {
    const m = await readYaml(e.path, skipped);
    if (!m?.manifestVersion || typeof m.name !== "string") continue;
    const dir = dirname(e.path);
    const entries: ManifestEntry[] = [];
    for (const [role, kindDir] of Object.entries(TS_KINDS)) {
      for (const f of Array.isArray(m[role]) ? m[role] : []) {
        if (typeof f !== "string" || !/\.tsx?$/.test(f)) continue;
        const p = await resolveEntry(
          root,
          dir,
          kindDir,
          f,
          m.paths?.base === "manifest",
        );
        if (p) entries.push({ path: p, role: role as ManifestEntry["role"] });
      }
    }
    manifests.push({
      name: m.name,
      version: String(m.version ?? ""),
      description: String(m.description ?? ""),
      dir,
      entries,
    });
  }

  // Unpublished local types: swamp loads extensions/<kind>/**/*.ts directly.
  const localSources: string[] = [];
  const extDir = join(root, "extensions");
  if (await exists(extDir)) {
    for await (
      const e of walk(extDir, { exts: [".ts"], includeDirs: false, skip: SKIP })
    ) if (!/_test\.ts$|\.d\.ts$/.test(e.path)) localSources.push(e.path);
  }

  const models: ModelDef[] = [];
  for (const p of await yamlFiles(join(root, "models"))) {
    const text = await Deno.readTextFile(p);
    let y: Yaml;
    try {
      y = parseYaml(text);
    } catch {
      skipped.push(p);
      continue;
    }
    if (typeof y?.type !== "string" || typeof y?.name !== "string") continue;
    models.push({
      id: String(y.id ?? ""),
      name: y.name,
      type: y.type,
      path: p,
      vaults: vaultRefs(text),
    });
  }

  const workflows: WorkflowDef[] = [];
  for (const p of await yamlFiles(join(root, "workflows"))) {
    const y = await readYaml(p, skipped);
    if (typeof y?.name !== "string" || !Array.isArray(y.jobs)) continue;
    const steps: WorkflowStep[] = [];
    for (const job of y.jobs) {
      for (const s of Array.isArray(job?.steps) ? job.steps : []) {
        const t = s?.task ?? {};
        steps.push({
          job: String(job.name ?? ""),
          step: String(s.name ?? ""),
          model: t.modelIdOrName,
          method: t.methodName,
          workflow: t.workflowIdOrName,
        });
      }
    }
    workflows.push({
      id: String(y.id ?? ""),
      name: y.name,
      description: String(y.description ?? ""),
      path: p,
      steps,
    });
  }

  const vaults: VaultDef[] = [];
  for (const p of await yamlFiles(join(root, "vaults"))) {
    const y = await readYaml(p, skipped);
    if (typeof y?.name !== "string") continue;
    vaults.push({
      id: String(y.id ?? ""),
      name: y.name,
      type: String(y.type ?? ""),
      path: p,
    });
  }

  const cfg = await readYaml(join(root, ".swamp.yaml"), skipped);
  const ds = cfg?.datastore;
  const datastore = ds?.type
    ? `${ds.type}${ds.namespace ? ` (${ds.namespace})` : ""}`
    : null;

  return {
    root,
    manifests,
    localSources,
    models,
    workflows,
    vaults,
    datastore,
    skipped,
  };
}

const firstParagraph = (s: string) =>
  s.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();

/** Join the scan and the code analysis into one graph. Pure. */
export function buildGraph(
  scan: RepoScan,
  code: CodeModule[],
  now = new Date(),
): CodeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const rel = (p: string) => relative(scan.root, p);
  const add = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };
  const link = (e: GraphEdge) =>
    edges.set(`${e.source}|${e.target}|${e.kind}|${e.label ?? ""}`, e);

  // Longest manifest dir that contains the file names its extension.
  const byDepth = [...scan.manifests].sort((a, b) =>
    b.dir.length - a.dir.length
  );
  const roles = new Map(
    scan.manifests.flatMap((m) => m.entries.map((e) => [e.path, e.role])),
  );
  const owners = new Map(
    scan.manifests.flatMap((m) => m.entries.map((e) => [e.path, m.name])),
  );
  const groupOf = (p: string) => {
    if (owners.has(p)) return owners.get(p)!;
    const m = byDepth.find((m) => p.startsWith(m.dir + "/"));
    if (m) return m.name;
    const r = rel(p).split("/");
    return r[0] === "extensions" && r.length > 2 ? `local/${r[1]}` : "local";
  };

  const typeNode = (type: string) =>
    add({
      id: `type:${type}`,
      kind: "type",
      label: type,
      group: type.split("/").slice(0, 2).join("/"),
      unresolved: true,
    });

  for (const m of code) {
    const id = `mod:${rel(m.path)}`;
    add({
      id,
      kind: "module",
      label: rel(m.path).split("/").pop()!,
      group: groupOf(m.path),
      path: rel(m.path),
      doc: firstParagraph(m.doc),
      role: roles.get(m.path),
    });
    for (const t of m.types) {
      const n = typeNode(t.type);
      n.unresolved = false;
      n.methods = [...new Set([...(n.methods ?? []), ...t.methods])].sort();
      if (!n.doc) n.doc = firstParagraph(m.doc);
      link({
        source: n.id,
        target: id,
        kind: "definedIn",
        label: t.extends ? "extends" : undefined,
      });
    }
  }
  for (const m of code) {
    const id = `mod:${rel(m.path)}`;
    for (const i of m.imports) {
      if (nodes.has(`mod:${rel(i)}`)) {
        link({ source: id, target: `mod:${rel(i)}`, kind: "imports" });
      }
    }
    for (const p of m.packages) {
      add({
        id: `pkg:${p}`,
        kind: "package",
        label: p,
        group: p.split(":")[0].split("/")[0],
      });
      link({ source: id, target: `pkg:${p}`, kind: "dependsOn" });
    }
  }

  for (const v of scan.vaults) {
    add({
      id: `vault:${v.name}`,
      kind: "vault",
      label: v.name,
      group: v.type || "vaults",
      path: rel(v.path),
      doc: v.type,
    });
  }

  const modelByRef = new Map<string, string>();
  for (const d of scan.models) {
    const id = `model:${d.name}`;
    add({ id, kind: "model", label: d.name, group: d.type, path: rel(d.path) });
    modelByRef.set(d.name, id);
    if (d.id) modelByRef.set(d.id, id);
    link({ source: id, target: typeNode(d.type).id, kind: "instanceOf" });
    for (const v of d.vaults) {
      add({
        id: `vault:${v}`,
        kind: "vault",
        label: v,
        group: "not defined here",
        unresolved: true,
      });
      link({ source: id, target: `vault:${v}`, kind: "usesVault" });
    }
  }

  const wfByRef = new Map<string, string>();
  for (const w of scan.workflows) {
    wfByRef.set(w.name, `wf:${w.name}`);
    if (w.id) wfByRef.set(w.id, `wf:${w.name}`);
  }
  for (const w of scan.workflows) {
    const id = `wf:${w.name}`;
    add({
      id,
      kind: "workflow",
      label: w.name,
      group: "workflows",
      path: rel(w.path),
      doc: firstParagraph(w.description),
    });
    for (const s of w.steps) {
      if (s.model && !s.model.includes("${{")) {
        const target = modelByRef.get(s.model) ??
          add({
            id: `model:${s.model}`,
            kind: "model",
            label: s.model,
            group: "not defined here",
            unresolved: true,
          }).id;
        link({ source: id, target, kind: "calls", label: s.method });
      }
      if (s.workflow && !s.workflow.includes("${{")) {
        const target = wfByRef.get(s.workflow) ??
          add({
            id: `wf:${s.workflow}`,
            kind: "workflow",
            label: s.workflow,
            group: "not defined here",
            unresolved: true,
          }).id;
        link({ source: id, target, kind: "runs" });
      }
    }
  }

  flagIssues(scan, code, nodes, edges, rel);

  const all = [...nodes.values()];
  const count = (k: NodeKind) => all.filter((n) => n.kind === k).length;
  const issues = all.flatMap((n) => n.issues ?? []);
  return {
    repo: scan.root.split("/").filter(Boolean).pop() ?? scan.root,
    datastore: scan.datastore,
    generatedAt: now.toISOString(),
    stats: {
      extensions: scan.manifests.length,
      workflows: count("workflow"),
      models: count("model"),
      vaults: count("vault"),
      types: count("type"),
      modules: count("module"),
      packages: count("package"),
      edges: edges.size,
      broken: issues.filter((i) => i.level === "broken").length,
      suspicious: issues.filter((i) => i.level === "suspicious").length,
    },
    nodes: all,
    edges: [...edges.values()],
  };
}

const MISSING: Partial<Record<NodeKind, string>> = {
  model: "A workflow calls this model, but no file in models/ defines it.",
  workflow:
    "A workflow runs this workflow, but no file in workflows/ defines it.",
  vault: "A model reads this vault, but no file in vaults/ defines it.",
};

/** Attach broken/suspicious findings to nodes. Mutates `nodes`. */
function flagIssues(
  scan: RepoScan,
  code: CodeModule[],
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
  rel: (p: string) => string,
): void {
  const flag = (id: string, level: Issue["level"], message: string) => {
    const n = nodes.get(id);
    if (!n) return;
    n.issues ??= [];
    if (!n.issues.some((i) => i.message === message)) {
      n.issues.push({ level, message });
    }
  };

  for (const m of code) {
    if (m.error) {
      flag(`mod:${rel(m.path)}`, "broken", `Fails to load: ${m.error}`);
    }
  }

  for (
    const [prefix, defs] of [["model", scan.models], [
      "wf",
      scan.workflows,
    ]] as const
  ) {
    const byName = Map.groupBy(
      defs as { name: string; path: string }[],
      (d) => d.name,
    );
    for (const [name, same] of byName) {
      if (same.length < 2) continue;
      flag(
        `${prefix}:${name}`,
        "broken",
        `${same.length} files define this name: ${
          same.map((d) => rel(d.path)).join(", ")
        }.`,
      );
    }
  }

  for (const n of nodes.values()) {
    if (n.unresolved && MISSING[n.kind]) {
      flag(n.id, "suspicious", MISSING[n.kind]!);
    }
  }

  // Only types this repo defines in full; an `extension` adds to a type
  // whose other methods live elsewhere.
  const full = new Set(
    code.flatMap((m) =>
      m.types.filter((t) => !t.extends).map((t) => `type:${t.type}`)
    ),
  );
  const used = new Set(
    [...edges.values()].filter((e) => e.kind === "instanceOf").map((e) =>
      e.target
    ),
  );
  for (const t of full) {
    if (!used.has(t)) {
      flag(t, "suspicious", "Defined here, but no model in this repo uses it.");
    }
  }

  const models = new Map(scan.models.flatMap((d) => [[d.name, d], [d.id, d]]));
  for (const w of scan.workflows) {
    for (const s of w.steps) {
      const d = s.model ? models.get(s.model) : undefined;
      const methods = d && full.has(`type:${d.type}`)
        ? nodes.get(`type:${d.type}`)?.methods
        : undefined;
      if (!s.method || !methods?.length || methods.includes(s.method)) continue;
      flag(
        `model:${d!.name}`,
        "broken",
        `Workflow ${w.name} calls ${s.method}, but ${
          d!.type
        } has no such method.`,
      );
    }
  }
}
