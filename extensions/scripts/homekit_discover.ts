// Standalone discovery script — run via `deno run --allow-all`
// Outputs JSON array of discovered HomeKit accessories to stdout.
// Usage: deno run --allow-all homekit_discover.ts [timeout_seconds]

import { IPDiscovery } from "npm:hap-controller@0.10.2";

const timeout = parseInt(Deno.args[0] || "10", 10);
const discovery = new IPDiscovery();
const found: Record<string, unknown>[] = [];

// deno-lint-ignore no-explicit-any
discovery.on("serviceUp", (service: any) => {
  found.push(service);
});

discovery.start();
await new Promise((r) => setTimeout(r, timeout * 1000));
discovery.stop();

console.log(JSON.stringify(found));
Deno.exit(0);
