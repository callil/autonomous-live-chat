import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

await import("./verify.mjs");

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const index = args.indexOf("--checkout");
if (index === -1 || !args[index + 1] || args.length !== 2) throw new Error("Usage: node infra/cloudflare-os/scripts/apply-overlay.mjs --checkout <detached-upstream-checkout>");

const checkout = path.resolve(args[index + 1]);
const [upstream, manifest] = await Promise.all([
  JSON.parse(await readFile(path.join(root, "upstream.lock.json"), "utf8")),
  JSON.parse(await readFile(path.join(root, "patches.json"), "utf8")),
]);
const { stdout: head } = await run("git", ["-C", checkout, "rev-parse", "HEAD"]);
if (head.trim().toLowerCase() !== upstream.commit) throw new Error("Checkout HEAD does not match infra/cloudflare-os/upstream.lock.json.");

for (const patch of manifest.patches.filter((candidate) => candidate.kind === "directory-overlay")) {
  const source = path.join(root, patch.source);
  const destination = path.join(checkout, patch.destination);
  try {
    await stat(destination);
    throw new Error(`Refusing to overwrite existing overlay destination: ${patch.destination}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  console.log(`applied ${patch.id} -> ${patch.destination}`);
}

for (const patch of manifest.patches.filter((candidate) => candidate.kind === "text-replacement")) {
  const destination = path.join(checkout, patch.destination);
  const source = await readFile(destination, "utf8");
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== patch.expectedSha256) throw new Error(`Refusing ${patch.id}: pinned upstream text does not match the reviewed source hash.`);
  const parts = source.split(patch.search);
  if (parts.length - 1 !== patch.expectedMatches) throw new Error(`Refusing ${patch.id}: expected ${patch.expectedMatches} reviewed text match(es).`);
  await writeFile(destination, parts.join(patch.replace));
  console.log(`applied ${patch.id} -> ${patch.destination}`);
}
