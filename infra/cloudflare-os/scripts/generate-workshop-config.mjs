import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`Cloudflare OS Workshop configuration failed: ${message}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safePath(value, label) {
  if (typeof value !== "string" || !value) fail(`${label} is required.`);
  return path.resolve(value);
}

/** Enough JSONC support for Wrangler configs without adding a runtime dependency. */
function parseJsonc(input) {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/gu, "$1"));
}

const checkout = safePath(argument("--checkout"), "--checkout");
const output = safePath(argument("--output"), "--output");
const manifest = JSON.parse(await readFile(path.join(root, "integration.manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || !manifest.workshop?.gatekeeper?.binding || !Array.isArray(manifest.removeGatekeeperBindings)) {
  fail("integration manifest is invalid.");
}

const source = path.join(checkout, "packages/workshop-backend/wrangler.jsonc");
const config = parseJsonc(await readFile(source, "utf8"));
const remove = new Set(manifest.removeGatekeeperBindings);
const retained = Array.isArray(config.services)
  ? config.services.filter((service) => typeof service?.binding === "string" && !service.binding.startsWith("GATEKEEPER_") && !remove.has(service.binding))
  : [];
config.services = [...retained, manifest.workshop.gatekeeper];

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote Workshop config with only ${manifest.workshop.gatekeeper.binding} as a Gatekeeper`);
