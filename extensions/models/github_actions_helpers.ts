// deno-lint-ignore-file no-import-prefix
import { Octokit } from "npm:@octokit/rest@22.0.1";
import { parse as parseYaml } from "npm:yaml@2.7.1";

export async function resolveGitHubToken(
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;

  // Try GITHUB_TOKEN / GH_TOKEN env vars
  const envToken = Deno.env.get("GITHUB_TOKEN") ??
    Deno.env.get("GH_TOKEN");
  if (envToken) return envToken;

  // Read from gh CLI config (~/.config/gh/hosts.yml) — works when token is stored in file
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const configPath = `${home}/.config/gh/hosts.yml`;
  try {
    const content = await Deno.readTextFile(configPath);
    // deno-lint-ignore no-explicit-any
    const hosts = parseYaml(content) as any;
    const ghToken = hosts?.["github.com"]?.oauth_token;
    if (ghToken) return ghToken;
  } catch {
    // Config file doesn't exist or is unreadable
  }

  // Fall back to `gh auth token` — works with keychain/keyring storage
  try {
    const cmd = new Deno.Command("gh", {
      args: ["auth", "token"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const token = new TextDecoder().decode(stdout).trim();
      if (token) return token;
    }
  } catch {
    // gh CLI not available
  }

  throw new Error(
    "No GitHub token found. Set GITHUB_TOKEN, GH_TOKEN, or authenticate with `gh auth login`.",
  );
}

export function createClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

// deno-lint-ignore no-explicit-any
export function normalizeRun(r: any): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name ?? null,
    path: r.path ?? null,
    status: r.status,
    conclusion: r.conclusion ?? null,
    headBranch: r.head_branch ?? null,
    event: r.event,
    runNumber: r.run_number,
    runAttempt: r.run_attempt ?? 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
  };
}

export function buildRunTable(
  // deno-lint-ignore no-explicit-any
  runs: any[],
): string[] {
  const lines: string[] = [];
  const hdr = [
    "Conclusion".padEnd(10),
    "Workflow".padEnd(50),
    "URL",
  ].join(" ");
  lines.push(hdr);
  lines.push("-".repeat(hdr.length));

  for (const r of runs) {
    const conclusion = r.conclusion === "success"
      ? "pass"
      : r.conclusion === "failure"
      ? "FAIL"
      : r.conclusion === null
      ? String(r.status ?? "")
      : String(r.conclusion ?? "");
    // Use workflow file path if available, fall back to name
    const workflow = r.path
      ? String(r.path).replace(".github/workflows/", "").replace(/\.[^.]+$/, "")
      : String(r.name ?? "");
    lines.push([
      conclusion.padEnd(10).slice(0, 10),
      workflow.padEnd(50).slice(0, 50),
      String(r.htmlUrl ?? ""),
    ].join(" "));
  }

  return lines;
}
