import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSurvey,
  compareSurvey,
  isOfficial,
  isRelevant,
  methodOverlap,
  methodsByType,
  pickBase,
  surveyBlockers,
  type SwampExtensionInfo,
} from "./wheelshop_survey.ts";

const NOW = new Date("2026-10-13T00:00:00Z");

function info(
  name: string,
  overrides: Partial<SwampExtensionInfo> = {},
): SwampExtensionInfo {
  return {
    name,
    latestVersion: "2026.10.01.1",
    license: null,
    repository: `https://example.com/${name}`,
    updatedAt: "2026-10-01T00:00:00Z",
    pullCount: 10,
    score: null,
    contentMetadata: { models: [] },
    ...overrides,
  };
}

const models = (type: string, methods: string[]) => ({
  contentMetadata: {
    models: [{
      fileName: `${type}.ts`,
      type,
      methods: methods.map((name) => ({ name })),
    }],
  },
});

// Shaped like the real tailscale survey on 2026-10-13.
const SWAMP = info("@swamp/tailscale", {
  ...models("@swamp/tailscale/device", ["get", "delete", "list", "adopt"]),
  license: null,
});
const JOHN = info("@john/tailscale", {
  ...models("tailscale/acl.ts", ["get", "set", "validate"]),
  repository: null,
  updatedAt: "2026-03-02T21:26:17Z",
});
const NET = info(
  "@josephholsten/tailscale/net",
  models("net.ts", ["list", "delete"]),
);
const DRIFT = info("@sntxrr/tailscale-acl-drift");

Deno.test("isOfficial is the @swamp collective", () => {
  assertEquals(isOfficial("@swamp/tailscale"), true);
  assertEquals(isOfficial("@swampy/x"), false);
});

Deno.test("isRelevant needs every query word in the name", () => {
  assertEquals(isRelevant("@swamp/tailscale", "tailscale"), true);
  assertEquals(isRelevant("@swamp/ssh", "tailscale"), false);
  assertEquals(
    isRelevant("@sntxrr/tailscale-acl-drift", "Tailscale ACL"),
    true,
  );
});

Deno.test("an official but off-topic extension cannot be the base", () => {
  const ssh = info("@swamp/ssh", models("@swamp/ssh", ["run"]));
  const { base, candidates } = buildSurvey(
    "tailscale",
    [ssh, SWAMP, NET],
    {},
    NOW,
  );
  assertEquals(base, "@swamp/tailscale");
  assertEquals(candidates.at(-1)?.name, "@swamp/ssh");
});

Deno.test("surveyBlockers reports every health gate", () => {
  assertEquals(surveyBlockers(SWAMP, NOW), []);
  assertEquals(
    surveyBlockers(
      info("@a/b", {
        yankedAt: "x",
        deprecatedAt: "x",
        supersededBy: "@a/c",
        updatedAt: "2023-01-01T00:00:00Z",
        repository: null,
      }),
      NOW,
    ),
    ["yanked", "deprecated", "superseded-by:@a/c", "stale", "no-repository"],
  );
});

Deno.test("methodsByType falls back to the file name", () => {
  assertEquals(methodsByType(JOHN), {
    "tailscale/acl.ts": ["get", "set", "validate"],
  });
});

Deno.test("methodOverlap is the share of method names the base has", () => {
  assertEquals(
    methodOverlap({ a: ["list", "delete"] }, { b: ["list", "delete", "get"] }),
    1,
  );
  assertEquals(
    methodOverlap({ a: ["get", "set", "validate"] }, { b: ["get"] }),
    0.33,
  );
  assertEquals(methodOverlap({}, { b: ["get"] }), null);
});

Deno.test("buildSurvey picks the official base and marks overlap and reuse", () => {
  const { base, candidates } = buildSurvey(
    "tailscale",
    [JOHN, DRIFT, NET, SWAMP],
    { "@sntxrr/tailscale-acl-drift": "MIT", "@swamp/tailscale": "AGPL-3.0" },
    NOW,
  );
  assertEquals(base, "@swamp/tailscale");
  assertEquals(candidates.map((c) => c.name), [
    "@swamp/tailscale",
    // Tied on every ranking field, so input order holds.
    "@sntxrr/tailscale-acl-drift",
    "@josephholsten/tailscale/net",
    "@john/tailscale",
  ]);
  const by = Object.fromEntries(candidates.map((c) => [c.name, c]));
  assertEquals(by["@swamp/tailscale"].reusable, false);
  assertEquals(by["@swamp/tailscale"].overlapWithBase, null);
  assertEquals(by["@josephholsten/tailscale/net"].likelyRedundant, true);
  assertEquals(by["@sntxrr/tailscale-acl-drift"].reusable, true);
  assertEquals(by["@sntxrr/tailscale-acl-drift"].overlapWithBase, null);
  assertEquals(by["@john/tailscale"].blockers, ["no-repository"]);
  assertEquals(by["@john/tailscale"].reusable, false);
});

Deno.test("pickBase skips unhealthy and model-less extensions", () => {
  const { candidates } = buildSurvey("tailscale", [JOHN, DRIFT], {}, NOW);
  assertEquals(pickBase(candidates), null);
});

Deno.test("compareSurvey breaks ties by score, then pulls", () => {
  const { candidates } = buildSurvey(
    "tailscale",
    [
      info("@a/x", { pullCount: 1, score: { percentage: 90 } }),
      info("@a/y", { pullCount: 99 }),
    ],
    {},
    NOW,
  );
  assertEquals(candidates.sort(compareSurvey).map((c) => c.name), [
    "@a/x",
    "@a/y",
  ]);
});
