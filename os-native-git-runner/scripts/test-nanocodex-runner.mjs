import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	buildNanocodexInstructions,
	NANOCODEX_DEFAULT_MODEL,
	NANOCODEX_VERSION,
	normalizeAgentSummary,
} from "../src/runner-contract.js";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const planner = await readFile(new URL("../../os-agent-orchestrator/src/index.ts", import.meta.url), "utf8");
const entrypoint = new URL("../agent-entrypoint.mjs", import.meta.url);

const instructions = buildNanocodexInstructions({
	repository: "callil/autonomous-live-chat",
	issueNumber: 42,
	branch: "app-harness-os/42/g1",
	stackId: "stack-request-42",
	generation: 1,
});
for (const capability of ["normal terminal", "filesystem", "GitHub CLI", "gh stack", "package managers", "migration tools", "Wrangler", "CI is the merge"]) assert.match(instructions, new RegExp(capability, "i"));
assert.match(instructions, /Do not restrict yourself to a file or command allowlist/u);
assert.match(instructions, /Never read, print, copy, commit, or expose credentials/u);

const bounded = normalizeAgentSummary({
	model: NANOCODEX_DEFAULT_MODEL,
	responseIds: ["resp_1", "resp_1", "bad value", ...Array.from({ length: 20 }, (_, index) => `resp_${index + 2}`)],
	tools: ["terminal.exec", "terminal.exec", "filesystem.read", { raw: "discard" }, ...Array.from({ length: 40 }, (_, index) => `tool.${index}`)],
	transcript: "must not survive",
	arguments: { token: "must not survive" },
});
assert.equal(bounded.responseIds.length, 12);
assert.equal(bounded.tools.length, 32);
assert.deepEqual(Object.keys(bounded).sort(), ["model", "responseIds", "tools"]);
assert.doesNotMatch(JSON.stringify(bounded), /must not survive/u);

assert.match(source, /kind: "repository-task"/u);
assert.match(source, /node \/opt\/app-harness\/agent-entrypoint\.mjs/u);
assert.match(source, /writeFile\(requestPath, JSON\.stringify/u);
assert.match(source, /agent-entrypoint\.mjs < \$\{requestPath\}/u);
assert.match(source, /GH_TOKEN: installation\.token/u);
assert.match(source, /candidate-working-tree-dirty/u);
assert.match(source, /candidate-head-not-pushed/u);
assert.match(source, /findAndAnnotatePullRequest/u);
assert.match(source, /async function sandboxIdentity/u);
assert.match(source, /base64Url\(digest\)\.slice\(0, 32\)/u);
assert.ok(`ah-nc030-gs010-${"x".repeat(32)}`.length <= 63, "derived Cloudflare Sandbox identities stay within the platform limit");
assert.match(source, /NANOCODEX_EXECUTION_TIMEOUT_MS = 720_000/u, "agent execution stays below Cloudflare's 15-minute alarm limit");
for (const obsolete of ["DOC_AGENT_TOOLS", "safeDocumentationPatch", "runDocumentationAgent", "add -- README.md docs"]) assert.doesNotMatch(source, new RegExp(obsolete.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
assert.match(planner, /plan: \{ change: \{ kind: "repository-task" \} \}/u);
assert.doesNotMatch(planner, /documentation-only|outside README\.md and docs/u);

assert.match(dockerfile, new RegExp(`NANOCODEX_VERSION=${NANOCODEX_VERSION}`, "u"));
assert.match(dockerfile, /GH_VERSION=2\.97\.0/u);
assert.match(dockerfile, /GH_STACK_VERSION=0\.1\.0/u);
assert.match(dockerfile, /sha256sum --check/gu);
assert.match(dockerfile, /COPY agent-entrypoint\.mjs/u);
const entrypointSource = await readFile(entrypoint, "utf8");
assert.doesNotMatch(entrypointSource, /"--model"/u);
assert.match(entrypointSource, /request\.model !== NANOCODEX_MODEL/u);

const directory = await mkdtemp(join(tmpdir(), "nanocodex-contract-"));
const mock = join(directory, "nanocodex");
await writeFile(mock, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "run" || !args.includes("--cwd") || !args.includes("--thinking") || !args.includes("--instructions") || !args.includes("--rollouts") || !args.includes("--store-responses") || !args.includes("--web-search") || !args.includes("--image-generation") || args.includes("--model") || args.at(-2) !== "--" || args.at(-1) !== "Implement task") process.exit(3);
process.stdout.write(JSON.stringify({type:"model.call.completed",payload:{response_id:"resp_safe",content:"SECRET_TRANSCRIPT"}})+"\\n");
process.stdout.write(JSON.stringify({type:"tool.call",payload:{tool:"terminal.exec",arguments:{token:"SECRET_TOKEN"}}})+"\\n");
process.stdout.write(JSON.stringify({type:"run.completed",payload:{answer:"SECRET_ANSWER"}})+"\\n");
`);
await chmod(mock, 0o755);

const child = spawn(process.execPath, [entrypoint.pathname], {
	env: { ...process.env, NANOCODEX_BINARY: mock },
	stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stdin.end(JSON.stringify({ prompt: "Implement task", instructions, cwd: "/workspace/repository", model: NANOCODEX_DEFAULT_MODEL }));
const code = await new Promise((resolve) => child.once("close", resolve));
assert.equal(code, 0);
const summary = JSON.parse(stdout);
assert.deepEqual(summary, { ok: true, model: NANOCODEX_DEFAULT_MODEL, responseIds: ["resp_safe"], tools: ["terminal.exec"] });
assert.doesNotMatch(stdout, /SECRET_/u);

console.log("NanoCodex Sandbox runner contracts passed");
