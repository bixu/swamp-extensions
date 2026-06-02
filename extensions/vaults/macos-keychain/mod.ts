/**
 * macOS Keychain vault provider for swamp.
 *
 * Stores and retrieves secrets as generic password items in the macOS
 * Keychain using the built-in `security` CLI. Secrets are scoped by a
 * configurable service name (defaults to "swamp"). Key enumeration is
 * supported via an internal index entry maintained alongside user secrets in
 * the same keychain service.
 *
 * Adapted from @webframp/macos-keychain (Apache-2.0) with the following
 * improvements: `list()` fulfills the VaultProvider contract by returning an
 * array instead of rejecting; error messages include the key name and service
 * name for easier debugging; `Deno.Command` is invoked without an unnecessary
 * intermediate `spawn()` call.
 *
 * @module
 */

import { z } from "npm:zod@4";

const INDEX_KEY = "__swamp_keychain_index__";

const ConfigSchema = z.object({
  service: z.string().min(1).default("swamp").describe(
    'Keychain service name under which all secrets are stored (defaults to "swamp")',
  ),
});

/** VaultProvider returned by {@linkcode vault.createProvider}. */
export interface KeychainVaultProvider {
  /** Retrieve a secret by key; throws if the key does not exist. */
  get(key: string): Promise<string>;
  /** Store or overwrite a secret value; idempotent across repeated calls. */
  put(key: string, value: string): Promise<void>;
  /**
   * List all stored key names.
   *
   * Returns an empty array when no secrets have been stored yet. The internal
   * index entry used for enumeration is excluded from results.
   */
  list(): Promise<string[]>;
  /** Returns the vault instance name. */
  getName(): string;
}

type CommandResult = { code: number; stdout: string; stderr: string };
type CommandRunner = (args: string[]) => Promise<CommandResult>;

function defaultRunner(args: string[]): Promise<CommandResult> {
  return new Deno.Command("security", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output().then(({ code, stdout, stderr }) => ({
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  }));
}

/** macOS Keychain vault provider definition. */
export const vault = {
  type: "@bixu/macos-keychain",
  name: "macOS Keychain",
  description:
    "Stores and retrieves swamp secrets from the macOS Keychain using the security CLI",
  configSchema: ConfigSchema,

  createProvider: (
    name: string,
    config: Record<string, unknown>,
    /** @internal override for unit tests — omit in production */
    _runner?: CommandRunner,
  ): KeychainVaultProvider => {
    const { service } = ConfigSchema.parse(config);
    const run: CommandRunner = _runner ?? defaultRunner;

    const runSecurity = async (args: string[]): Promise<string> => {
      const { code, stdout, stderr } = await run(args);
      if (code !== 0) {
        throw new Error(stderr || `security exited with code ${code}`);
      }
      return stdout;
    };

    /**
     * Attempt to retrieve a keychain password without throwing on "not found".
     * Returns `null` when the item is absent; throws for all other failures.
     */
    const tryFindPassword = async (key: string): Promise<string | null> => {
      const { code, stdout, stderr } = await run([
        "find-generic-password",
        "-s",
        service,
        "-a",
        key,
        "-w",
      ]);
      if (code === 0) return stdout;
      // Exit code 44 and the standard "could not be found" message both
      // indicate a missing item — treat either as a clean miss.
      if (
        code === 44 || stderr.includes("could not be found in the keychain")
      ) {
        return null;
      }
      throw new Error(
        `Failed to read key "${key}" from service "${service}": ${
          stderr || `security exited with code ${code}`
        }`,
      );
    };

    const readIndex = async (): Promise<string[]> => {
      const raw = await tryFindPassword(INDEX_KEY);
      if (raw === null) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    };

    const writeIndex = async (keys: string[]): Promise<void> => {
      await runSecurity([
        "add-generic-password",
        "-s",
        service,
        "-a",
        INDEX_KEY,
        "-w",
        JSON.stringify(keys),
        "-U",
      ]);
    };

    return {
      get: async (key: string): Promise<string> => {
        const value = await tryFindPassword(key);
        if (value === null) {
          throw new Error(
            `Secret "${key}" not found in keychain service "${service}"`,
          );
        }
        return value;
      },

      put: async (key: string, value: string): Promise<void> => {
        await runSecurity([
          "add-generic-password",
          "-s",
          service,
          "-a",
          key,
          "-w",
          value,
          "-U",
        ]);
        const index = await readIndex();
        if (!index.includes(key)) {
          await writeIndex([...index, key]);
        }
      },

      list: async (): Promise<string[]> => {
        const index = await readIndex();
        return index.filter((k) => k !== INDEX_KEY);
      },

      getName: (): string => name,
    };
  },
};
