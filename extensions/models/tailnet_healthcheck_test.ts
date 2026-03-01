import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCsv,
  buildOutdatedClientsMarkdown,
  compareVersions,
  isBelow,
  parseVersion,
} from "./tailnet_healthcheck_helpers.ts";

// --- parseVersion ---

Deno.test("parseVersion parses semver", () => {
  assertEquals(parseVersion("1.94.0"), [1, 94, 0]);
});

Deno.test("parseVersion parses version with suffix", () => {
  assertEquals(parseVersion("1.36.0-t96f658038-g49bd44543"), [1, 36, 0]);
});

Deno.test("parseVersion returns null for garbage", () => {
  assertEquals(parseVersion("not-a-version"), null);
});

Deno.test("parseVersion returns null for empty string", () => {
  assertEquals(parseVersion(""), null);
});

// --- isBelow ---

Deno.test("isBelow returns true when version is below floor", () => {
  assertEquals(isBelow("1.36.0", "1.94.0"), true);
});

Deno.test("isBelow returns false when version equals floor", () => {
  assertEquals(isBelow("1.94.0", "1.94.0"), false);
});

Deno.test("isBelow returns false when version is above floor", () => {
  assertEquals(isBelow("1.95.0", "1.94.0"), false);
});

Deno.test("isBelow handles major version difference", () => {
  assertEquals(isBelow("0.99.99", "1.0.0"), true);
});

Deno.test("isBelow handles patch version difference", () => {
  assertEquals(isBelow("1.94.0", "1.94.1"), true);
});

Deno.test("isBelow returns false for unparseable version", () => {
  assertEquals(isBelow("garbage", "1.94.0"), false);
});

Deno.test("isBelow handles version with suffix", () => {
  assertEquals(isBelow("1.36.0-t96f658038-g49bd44543", "1.94.0"), true);
});

// --- compareVersions ---

Deno.test("compareVersions returns negative when a < b", () => {
  assertEquals(compareVersions("1.36.0", "1.94.0") < 0, true);
});

Deno.test("compareVersions returns positive when a > b", () => {
  assertEquals(compareVersions("1.94.0", "1.36.0") > 0, true);
});

Deno.test("compareVersions returns 0 when equal", () => {
  assertEquals(compareVersions("1.94.0", "1.94.0"), 0);
});

Deno.test("compareVersions returns 0 for two unparseable versions", () => {
  assertEquals(compareVersions("bad", "worse"), 0);
});

// --- buildCsv ---

Deno.test("buildCsv returns empty string for no devices", () => {
  assertEquals(buildCsv([]), "");
});

Deno.test("buildCsv puts priority columns first", () => {
  const devices = [
    {
      id: "123",
      hostname: "myhost",
      user: "alice@example.com",
      tags: ["tag:server"],
    },
  ];
  const csv = buildCsv(devices);
  const header = csv.split("\n")[0];
  assertEquals(header.startsWith("hostname,user,tags"), true);
});

Deno.test("buildCsv joins array values with semicolons", () => {
  const devices = [
    { hostname: "h1", tags: ["tag:a", "tag:b"] },
  ];
  const csv = buildCsv(devices);
  const row = csv.split("\n")[1];
  assertEquals(row.includes("tag:a; tag:b"), true);
});

Deno.test("buildCsv escapes commas in values", () => {
  const devices = [
    { hostname: "host,name", user: "alice" },
  ];
  const csv = buildCsv(devices);
  const row = csv.split("\n")[1];
  assertEquals(row.includes('"host,name"'), true);
});

Deno.test("buildCsv escapes quotes in values", () => {
  const devices = [
    { hostname: 'host"name', user: "alice" },
  ];
  const csv = buildCsv(devices);
  const row = csv.split("\n")[1];
  assertEquals(row.includes('"host""name"'), true);
});

Deno.test("buildCsv handles missing priority columns", () => {
  const devices = [{ id: "123", os: "linux" }];
  const csv = buildCsv(devices);
  const header = csv.split("\n")[0];
  assertEquals(header.includes("hostname"), false);
  assertEquals(header.includes("id"), true);
});

// --- buildOutdatedClientsMarkdown ---

Deno.test("buildOutdatedClientsMarkdown shows all-clear when no devices", () => {
  const md = buildOutdatedClientsMarkdown([], "1.94.0");
  assertEquals(md.includes("All devices are at or above"), true);
});

Deno.test("buildOutdatedClientsMarkdown includes device table", () => {
  const devices = [
    { hostname: "myhost", version: "1.36.0", owner: "alice@example.com" },
  ];
  const md = buildOutdatedClientsMarkdown(devices, "1.94.0");
  assertEquals(md.includes("myhost"), true);
  assertEquals(md.includes("1.36.0"), true);
  assertEquals(md.includes("alice@example.com"), true);
  assertEquals(md.includes("Hosts Requiring Update"), true);
});

Deno.test("buildOutdatedClientsMarkdown includes device count", () => {
  const devices = [
    { hostname: "h1", version: "1.36.0", owner: "a@b.com" },
    { hostname: "h2", version: "1.50.0", owner: "c@d.com" },
  ];
  const md = buildOutdatedClientsMarkdown(devices, "1.94.0");
  assertEquals(md.includes("**2** devices below minimum safe version"), true);
});

Deno.test("buildOutdatedClientsMarkdown includes security floor", () => {
  const md = buildOutdatedClientsMarkdown([], "1.94.0");
  assertEquals(md.includes("1.94.0"), true);
});
