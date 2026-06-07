import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  parseDatasets,
  parseSnapshots,
  parseZpoolList,
  parseZpoolStatus,
  requirePool,
  SAFE_ZFS_COMPONENT_RE,
  SAFE_ZFS_PATH_RE,
  validateComponent,
  validatePath,
  validateSnapshot,
} from "./zfs.ts";

// --- SAFE_ZFS_COMPONENT_RE ---

Deno.test("SAFE_ZFS_COMPONENT_RE: accepts valid pool names", () => {
  for (const name of ["tank", "my-pool", "pool_1", "rpool:mirror", "v2.0"]) {
    assertEquals(
      SAFE_ZFS_COMPONENT_RE.test(name),
      true,
      `should accept ${name}`,
    );
  }
});

Deno.test("SAFE_ZFS_COMPONENT_RE: rejects names with slashes or spaces", () => {
  for (const name of ["tank/data", "my pool", "pool;rm", "a@b", ""]) {
    assertEquals(
      SAFE_ZFS_COMPONENT_RE.test(name),
      false,
      `should reject ${name}`,
    );
  }
});

// --- SAFE_ZFS_PATH_RE ---

Deno.test("SAFE_ZFS_PATH_RE: accepts valid dataset paths", () => {
  for (
    const p of ["tank/data", "rpool/ROOT/ubuntu", "tank", "a/b/c.d-e_f:g"]
  ) {
    assertEquals(SAFE_ZFS_PATH_RE.test(p), true, `should accept ${p}`);
  }
});

Deno.test("SAFE_ZFS_PATH_RE: rejects paths with spaces or metacharacters", () => {
  for (const p of ["tank/my data", "pool;cmd", "a b", ""]) {
    assertEquals(SAFE_ZFS_PATH_RE.test(p), false, `should reject ${p}`);
  }
});

// --- validateComponent ---

Deno.test("validateComponent: passes for valid component names", () => {
  validateComponent("tank", "pool");
  validateComponent("my-pool_2.0:mirror", "pool");
});

Deno.test("validateComponent: throws for names with slashes", () => {
  assertThrows(
    () => validateComponent("tank/data", "pool"),
    Error,
    "only alphanumeric",
  );
});

Deno.test("validateComponent: throws for names with spaces", () => {
  assertThrows(
    () => validateComponent("my pool", "pool"),
    Error,
    "only alphanumeric",
  );
});

Deno.test("validateComponent: throws for shell metacharacters", () => {
  assertThrows(
    () => validateComponent("pool;rm -rf /", "pool"),
    Error,
    "only alphanumeric",
  );
});

// --- validatePath ---

Deno.test("validatePath: passes for valid paths including slashes", () => {
  validatePath("tank/data/child", "dataset");
  validatePath("rpool/ROOT/ubuntu", "dataset");
});

Deno.test("validatePath: throws for paths with spaces", () => {
  assertThrows(
    () => validatePath("tank/my data", "dataset"),
    Error,
    "only alphanumeric",
  );
});

Deno.test("validatePath: throws for shell injection attempts", () => {
  assertThrows(
    () => validatePath("tank;rm -rf /", "dataset"),
    Error,
    "only alphanumeric",
  );
});

// --- validateSnapshot ---

Deno.test("validateSnapshot: passes for valid snapshot names", () => {
  validateSnapshot("tank/data@daily-2026-04-01", "snapshot");
  validateSnapshot("rpool@manual-backup", "snapshot");
});

Deno.test("validateSnapshot: throws when @ is missing", () => {
  assertThrows(
    () => validateSnapshot("tank/data-no-at", "snapshot"),
    Error,
    "must contain '@'",
  );
});

Deno.test("validateSnapshot: throws when dataset part is invalid", () => {
  assertThrows(
    () => validateSnapshot("tank data@snap", "snapshot"),
    Error,
    "only alphanumeric",
  );
});

Deno.test("validateSnapshot: throws when snapshot name part is invalid", () => {
  assertThrows(
    () => validateSnapshot("tank/data@snap/invalid", "snapshot"),
    Error,
    "only alphanumeric",
  );
});

// --- requirePool ---

Deno.test("requirePool: returns pool name when valid", () => {
  assertEquals(requirePool("tank"), "tank");
  assertEquals(requirePool("my-pool"), "my-pool");
});

Deno.test("requirePool: throws when pool is undefined", () => {
  assertThrows(
    () => requirePool(undefined),
    Error,
    "globalArguments.pool is required",
  );
});

Deno.test("requirePool: throws when pool is empty string", () => {
  assertThrows(
    () => requirePool(""),
    Error,
    "globalArguments.pool is required",
  );
});

Deno.test("requirePool: throws when pool name is invalid", () => {
  assertThrows(
    () => requirePool("tank;rm"),
    Error,
    "only alphanumeric",
  );
});

// --- parseZpoolList ---

Deno.test("parseZpoolList: parses valid tab-separated output", () => {
  const output = "tank\tONLINE\t10737418240\t5368709120\t5368709120\t50\t12";
  const result = parseZpoolList(output, "tank");
  assertEquals(result, {
    health: "ONLINE",
    sizeBytes: 10737418240,
    allocBytes: 5368709120,
    freeBytes: 5368709120,
    capacityPct: 50,
    fragmentationPct: 12,
  });
});

Deno.test("parseZpoolList: finds correct pool among multiple lines", () => {
  const output = [
    "rpool\tONLINE\t500107862016\t250000000000\t250107862016\t49\t5",
    "tank\tDEGRADED\t2000398934016\t1500000000000\t500398934016\t75\t22",
  ].join("\n");
  const result = parseZpoolList(output, "tank");
  assertEquals(result.health, "DEGRADED");
  assertEquals(result.capacityPct, 75);
  assertEquals(result.fragmentationPct, 22);
});

Deno.test("parseZpoolList: throws when pool not found", () => {
  const output =
    "rpool\tONLINE\t500107862016\t250000000000\t250107862016\t49\t5";
  assertThrows(
    () => parseZpoolList(output, "tank"),
    Error,
    "not found in zpool list output",
  );
});

Deno.test("parseZpoolList: throws on empty output", () => {
  assertThrows(
    () => parseZpoolList("", "tank"),
    Error,
    "not found in zpool list output",
  );
});

Deno.test("parseZpoolList: handles non-numeric fields gracefully (defaults to 0)", () => {
  const output = "tank\tONLINE\t-\t-\t-\t-\t-";
  const result = parseZpoolList(output, "tank");
  assertEquals(result.health, "ONLINE");
  assertEquals(result.sizeBytes, 0);
  assertEquals(result.allocBytes, 0);
  assertEquals(result.freeBytes, 0);
  assertEquals(result.capacityPct, 0);
  assertEquals(result.fragmentationPct, 0);
});

// --- parseZpoolStatus ---

Deno.test("parseZpoolStatus: parses devices from config section", () => {
  const output = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:12:34 with 0 errors on Sun Apr  6 02:00:34 2026

config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        ONLINE       0     0     0
\t  mirror-0  ONLINE       0     0     0
\t    sda     ONLINE       0     0     0
\t    sdb     ONLINE       0     0     0

errors: No known data errors`;

  const result = parseZpoolStatus(output);
  assertEquals(result.devices.length, 4);
  assertEquals(result.devices[0], {
    name: "tank",
    state: "ONLINE",
    read: 0,
    write: 0,
    cksum: 0,
  });
  assertEquals(result.devices[1].name, "mirror-0");
  assertEquals(result.devices[2].name, "sda");
  assertEquals(result.devices[3].name, "sdb");
});

Deno.test("parseZpoolStatus: extracts scan state and date", () => {
  const output = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:12:34 with 0 errors on Sun Apr  6 02:00:34 2026

config:

\tNAME   STATE     READ WRITE CKSUM
\ttank   ONLINE       0     0     0

errors: No known data errors`;

  const result = parseZpoolStatus(output);
  assertStringIncludes(result.scanState, "scrub repaired");
  assertStringIncludes(result.scanDate, "Sun Apr  6 02:00:34 2026");
});

Deno.test("parseZpoolStatus: handles 'scan: none requested' gracefully", () => {
  const output = `  pool: tank
 state: ONLINE
  scan: none requested

config:

\tNAME   STATE     READ WRITE CKSUM
\ttank   ONLINE       0     0     0

errors: No known data errors`;

  const result = parseZpoolStatus(output);
  assertEquals(result.scanState, "none requested");
  assertEquals(result.scanDate, "");
});

Deno.test("parseZpoolStatus: detects degraded/faulted devices", () => {
  const output = `  pool: tank
 state: DEGRADED
  scan: scrub in progress on Mon Apr  7 03:00:00 2026

config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        DEGRADED     0     0     0
\t  mirror-0  DEGRADED     0     0     0
\t    sda     ONLINE       0     0     0
\t    sdb     FAULTED      3     1     7

errors: No known data errors`;

  const result = parseZpoolStatus(output);
  const faulted = result.devices.find((d) => d.state === "FAULTED");
  assertEquals(faulted?.name, "sdb");
  assertEquals(faulted?.read, 3);
  assertEquals(faulted?.write, 1);
  assertEquals(faulted?.cksum, 7);
});

Deno.test("parseZpoolStatus: returns empty devices when no config section", () => {
  const output = `  pool: tank
 state: ONLINE
  scan: none requested`;

  const result = parseZpoolStatus(output);
  assertEquals(result.devices, []);
});

// --- parseDatasets ---

Deno.test("parseDatasets: parses single dataset line", () => {
  const output =
    "tank/data\tfilesystem\t1073741824\t9663676416\t536870912\t/tank/data";
  const result = parseDatasets(output);
  assertEquals(result.length, 1);
  assertEquals(result[0], {
    name: "tank/data",
    type: "filesystem",
    usedBytes: 1073741824,
    availBytes: 9663676416,
    referBytes: 536870912,
    mountpoint: "/tank/data",
  });
});

Deno.test("parseDatasets: parses multiple dataset lines", () => {
  const output = [
    "tank\tfilesystem\t5368709120\t5368709120\t131072\t/tank",
    "tank/data\tfilesystem\t1073741824\t5368709120\t536870912\t/tank/data",
    "tank/zvol0\tvolume\t2147483648\t5368709120\t2147483648\t-",
  ].join("\n");
  const result = parseDatasets(output);
  assertEquals(result.length, 3);
  assertEquals(result[0].name, "tank");
  assertEquals(result[1].name, "tank/data");
  assertEquals(result[2].type, "volume");
  assertEquals(result[2].mountpoint, "-");
});

Deno.test("parseDatasets: returns empty array for empty output", () => {
  assertEquals(parseDatasets(""), []);
});

Deno.test("parseDatasets: handles lines with non-numeric size fields", () => {
  const output = "tank/broken\tfilesystem\tnone\tnone\tnone\t/tank/broken";
  const result = parseDatasets(output);
  assertEquals(result[0].usedBytes, 0);
  assertEquals(result[0].availBytes, 0);
  assertEquals(result[0].referBytes, 0);
});

// --- parseSnapshots ---

Deno.test("parseSnapshots: parses single snapshot line", () => {
  const output = "tank/data@daily-2026-04-01\t131072\t536870912\t1743465600";
  const result = parseSnapshots(output);
  assertEquals(result.length, 1);
  assertEquals(result[0], {
    name: "tank/data@daily-2026-04-01",
    usedBytes: 131072,
    referBytes: 536870912,
    creationEpoch: 1743465600,
  });
});

Deno.test("parseSnapshots: parses multiple snapshot lines", () => {
  const output = [
    "tank/data@daily-2026-04-01\t131072\t536870912\t1743465600",
    "tank/data@daily-2026-04-02\t262144\t536870912\t1743552000",
    "tank/data@weekly-2026-w14\t524288\t1073741824\t1743552000",
  ].join("\n");
  const result = parseSnapshots(output);
  assertEquals(result.length, 3);
  assertEquals(result[0].name, "tank/data@daily-2026-04-01");
  assertEquals(result[1].usedBytes, 262144);
  assertEquals(result[2].name, "tank/data@weekly-2026-w14");
});

Deno.test("parseSnapshots: returns empty array for empty output", () => {
  assertEquals(parseSnapshots(""), []);
});

Deno.test("parseSnapshots: handles non-numeric fields as 0", () => {
  const output = "tank@snap\t-\t-\t-";
  const result = parseSnapshots(output);
  assertEquals(result[0].usedBytes, 0);
  assertEquals(result[0].referBytes, 0);
  assertEquals(result[0].creationEpoch, 0);
});

// --- Schema validation via model export ---

Deno.test("model export: has expected type and version", () => {
  // Import lazily to avoid triggering any side effects
  import("./zfs.ts").then((mod) => {
    assertEquals(mod.model.type, "@bixu/zfs");
    assertStringIncludes(mod.model.version, "2026.");
  });
});

Deno.test("model export: defines all 10 methods", () => {
  import("./zfs.ts").then((mod) => {
    const methods = Object.keys(mod.model.methods);
    assertEquals(methods.length, 9);
    for (
      const name of [
        "import",
        "export",
        "sync",
        "snapshot",
        "autoSnapshot",
        "destroySnapshot",
        "pruneSnapshots",
        "scrub",
        "trim",
      ]
    ) {
      assertEquals(
        methods.includes(name),
        true,
        `missing method: ${name}`,
      );
    }
  });
});

Deno.test("model export: defines expected resources", () => {
  import("./zfs.ts").then((mod) => {
    const resources = Object.keys(mod.model.resources);
    for (
      const name of [
        "status",
        "datasets",
        "snapshots",
        "snapshotResult",
        "scrubResult",
        "importResult",
      ]
    ) {
      assertEquals(
        resources.includes(name),
        true,
        `missing resource: ${name}`,
      );
    }
  });
});
