import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = /^[0-9a-f]{40}$/u;

function fail(message) {
  throw new Error(`Cloudflare OS overlay verification failed: ${message}`);
}

async function json(relative) {
  try {
    return JSON.parse(await readFile(path.join(root, relative), "utf8"));
  } catch (error) {
    fail(`cannot parse ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    fail(`${label} must be a non-empty relative path without traversal.`);
  }
  return value;
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await files(child));
    else if (entry.isFile()) paths.push(child);
    else fail(`overlay contains unsupported entry: ${child}`);
  }
  return paths;
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const upstream = await json("upstream.lock.json");
const manifest = await json("patches.json");
const deployment = await json("deployment.manifest.json");
const integration = await json("integration.manifest.json");

if (upstream.schemaVersion !== 1 || typeof upstream.repository !== "string" || !sha.test(upstream.commit)) fail("upstream lock is incomplete.");
if (manifest.schemaVersion !== 1 || manifest.upstreamLock !== "./upstream.lock.json" || !Array.isArray(manifest.patches) || manifest.patches.length === 0) fail("patch manifest is incomplete.");
if (deployment.schemaVersion !== 1 || deployment.stateAuthority !== "app-harness-ledger") fail("deployment manifest must name the App Harness ledger as state authority.");
if (!Array.isArray(deployment.forbiddenBindings) || !["durable_objects", "d1_databases", "kv_namespaces", "r2_buckets"].every((binding) => deployment.forbiddenBindings.includes(binding))) fail("deployment manifest must prohibit local action stores.");
if (integration.schemaVersion !== 1 || integration.workshop?.gatekeeper?.binding !== "GATEKEEPER_APP_HARNESS" || integration.workshop.gatekeeper.entrypoint !== "GatekeeperVendor" || integration.workshop.ambientVendorId !== "app_harness") {
  fail("integration manifest must declare the single App Harness ambient Gatekeeper.");
}
if (!Array.isArray(integration.removeGatekeeperBindings) || !["GATEKEEPER_CUSTOM", "GATEKEEPER_GITHUB"].every((binding) => integration.removeGatekeeperBindings.includes(binding))) {
  fail("integration manifest must remove obsolete Gatekeeper bindings.");
}
const gatekeeperWrangler = JSON.parse(await readFile(path.join(root, "overlay/packages/gatekeeper-app-harness-operator/wrangler.jsonc"), "utf8"));
for (const binding of ["LEDGER", "RUNNER", "GITHUB"]) {
  if (!gatekeeperWrangler.services?.some((service) => service.binding === binding)) fail(`Gatekeeper overlay must bind ${binding} as a private service.`);
}
if (deployment.forbiddenBindings.some((binding) => gatekeeperWrangler[binding] !== undefined)) fail("Gatekeeper overlay declares a forbidden local persistence binding.");
if (gatekeeperWrangler.name !== integration.workshop.gatekeeper.service) fail("Workshop integration must target the operator Gatekeeper Worker.");
const gatekeeperSource = await readFile(path.join(root, "overlay/packages/gatekeeper-app-harness-operator/src/operator-gatekeeper.ts"), "utf8");
if (/nextAction|phase-to-next-command/i.test(gatekeeperSource)) fail("Gatekeeper overlay may not select a next command from ledger phase.");
if (/ctx\.storage|new\s+RepositoryTaskActionStore/i.test(gatekeeperSource)) fail("Gatekeeper overlay may not keep a local action store.");
const gatekeeperSources = await Promise.all((await files(path.join(root, "overlay/packages/gatekeeper-app-harness-operator/src"))).map((file) => readFile(file, "utf8")));
const legacyPromotionField = ["workflow", "Id"].join("");
if (gatekeeperSources.some((source) => source.includes(legacyPromotionField))) fail("Gatekeeper overlay must use the durable dispatchKey contract without a legacy compatibility path.");

for (const patch of manifest.patches) {
  if (patch.baseCommit !== upstream.commit) fail(`${patch.id} does not target the pinned upstream commit.`);
  safeRelative(patch.destination, `${patch.id} destination`);
  if (patch.review?.status !== "ready-for-maintainer-review" || !Array.isArray(patch.review.securityInvariants)) {
    fail(`${patch.id} is missing review metadata.`);
  }
  if (patch.kind === "text-replacement") {
    if (!/^[0-9a-f]{64}$/u.test(patch.expectedSha256) || typeof patch.search !== "string" || !patch.search || typeof patch.replace !== "string" || !Number.isSafeInteger(patch.expectedMatches) || patch.expectedMatches < 1) {
      fail(`${patch.id} has an invalid reviewed text replacement.`);
    }
    continue;
  }
  if (patch.kind !== "directory-overlay") fail(`${patch.id} has an unsupported patch kind.`);
  const source = safeRelative(patch.source, `${patch.id} source`);
  if (!Array.isArray(patch.review.requiredChecks)) fail(`${patch.id} is missing required checks.`);
  const directory = path.join(root, source);
  if (!(await stat(directory)).isDirectory()) fail(`${patch.id} source directory is missing.`);
  const sourceFiles = await files(directory);
  if (sourceFiles.length === 0) fail(`${patch.id} has no overlay source files.`);
  const listed = new Set((patch.files ?? []).map((file) => file.path));
  if (listed.size !== sourceFiles.length) fail(`${patch.id} file metadata does not cover the overlay exactly.`);
  for (const sourceFile of sourceFiles) {
    const relative = path.relative(directory, sourceFile).split(path.sep).join("/");
    const file = (patch.files ?? []).find((candidate) => candidate.path === relative);
    if (!file || typeof file.sha256 !== "string" || file.sha256 !== digest(await readFile(sourceFile))) fail(`${patch.id} hash mismatch for ${relative}.`);
  }
}

console.log(`cloudflare-os overlay: ${manifest.patches.length} reviewed overlay(s) verified against ${upstream.commit}`);
