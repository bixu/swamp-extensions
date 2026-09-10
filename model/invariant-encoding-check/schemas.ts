/**
 * Shared zod schemas for shapes the invariant-encoding-check enforces. Ship
 * these alongside the check so a consumer who wants a reusable "digest" or
 * "platform" schema does not reinvent the shape the CI gate is looking for —
 * schema and gate cannot drift apart.
 *
 * These are `additionalFiles` in the extension manifest, not a runtime import
 * target for other swamp models. Copy or vendor this file into your own
 * extension's `_lib/` (or wherever local shared code lives) if you want to
 * reuse them; there is no swamp-native path for one extension to `import`
 * TypeScript from another.
 */
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

const SHA256_DIGEST_RE_ANCHORED = /^sha256:[0-9a-f]{64}$/;

/**
 * An OCI sha256 content digest: `sha256:<64 lowercase hex>`. Anchored. A
 * caller who confuses it with the mutable tag or the content fingerprint
 * hits a schema error at write time rather than pushing to the wrong
 * reference.
 */
export const Sha256DigestSchema = z.string().regex(
  SHA256_DIGEST_RE_ANCHORED,
  "expected sha256:<64 hex chars>",
);

/**
 * An OCI platform string: `arch`, `os/arch`, or `os/arch/variant`, all
 * lowercase alphanumerics. Matches the usual `linux/amd64`, `linux/arm64`,
 * the variant forms buildx emits (`linux/arm64/v8`), and the bare-arch
 * form.
 */
export const PlatformSchema = z.string().regex(
  /^[a-z0-9]+(?:\/[a-z0-9]+){0,2}$/,
  "expected [<os>/]<arch>[/<variant>]",
);

/**
 * An SSH key fingerprint as `ssh-keygen -lf` emits: `SHA256:<base64>` on
 * modern keys, `MD5:<hex-with-colons>` on old ones.
 */
export const SshFingerprintSchema = z.string().regex(
  /^(?:SHA256:[A-Za-z0-9+/=]+|MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2})$/,
  "expected SHA256:<base64> or MD5:<hex-with-colons>",
);
