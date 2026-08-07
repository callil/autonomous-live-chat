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
const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const entrypoint = new URL("../agent-entrypoint.mjs", import.meta.url);
const jobEntrypoint = new URL("../job-entrypoint.mjs", import.meta.url);

const instructions = buildNanocodexInstructions({
	repository: "callil/autonomous-live-chat",
	issueNumber: 42,
	branch: "app-harness-os/42/g1",
	stackId: "stack-request-42",
	generation: 1,
});
for (const capability of ["normal terminal", "filesystem", "GitHub CLI", "gh stack", "package managers", "migration tools", "Wrangler", "CI is the merge"]) assert.match(instructions, new RegExp(capability, "i"));
assert.match(instructions, /Do not restrict yourself to a file or command allowlist/u);
assert.match(instructions, /default product surface is apps\/demo/u);
assert.match(instructions, /Never read, print, copy, commit, or expose credentials/u);
assert.match(instructions, /read-only subagents proactively and in parallel/u);
assert.match(instructions, /parent agent alone owns edits, Git, branches, and the stack/u);
assert.match(instructions, /execution harness will submit this branch through the installed official gh stack CLI/u);
assert.match(instructions, /Multi-node stacks are not enabled yet/u);
assert.equal(NANOCODEX_DEFAULT_MODEL, "gpt-5.6-sol");

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
assert.match(source, /node \/opt\/app-harness\/job-entrypoint\.mjs/u);
assert.match(source, /session\.writeFile\(ids\.requestPath, JSON\.stringify/u);
assert.match(source, /session\.startProcess/u);
assert.match(source, /processId: ids\.runId/u);
assert.match(source, /autoCleanup: false/u);
assert.match(source, /timeout: NANOCODEX_EXECUTION_TIMEOUT_MS/u);
assert.match(source, /state: "runner-unavailable"/u);
assert.match(source, /class NativeGitRunner extends WorkerEntrypoint/u);
assert.match(source, /async startRun\(input: NativeGitJob\)/u);
assert.match(source, /async inspectRun\(input: \{ jobId: string; generation: number; runId: string \}\)/u);
assert.match(source, /async cancelRun\(/u);
assert.match(source, /async probe\(\)/u);
assert.doesNotMatch(source, /class RunnerJob extends DurableObject/u, "the disposable runner must not own a second durable job machine");
assert.doesNotMatch(source, /APP_HARNESS_RUNNER_SECRET|GITHUB_APP_PRIVATE_KEY|GITHUB_APP_INSTALLATION_ID|GITHUB_APP_ID/u, "the runner receives neither a static bearer nor the GitHub App private key");
assert.match(source, /GITHUB_APP\.createRunnerToken/u, "the sole GitHub App broker mints the short-lived repository capability");
assert.match(config, /"binding": "GITHUB_APP"/u);
assert.match(config, /"entrypoint": "GitHubAppCapability"/u);
assert.doesNotMatch(config, /"MODEL_ID"/u, "the pinned NanoCodex binary model must not be presented as configurable");
assert.match(config, /"deleted_classes": \["RunnerJob"\]/u);
assert.doesNotMatch(config, /"name": "RUNNER_JOB"/u);
assert.doesNotMatch(source, /runJob\(/u, "the Worker cannot synchronously own a full implementation run");
assert.match(source, /async function deterministicId/u);
assert.match(source, /hex\.slice\(0, 32\)/u, "sandbox identifiers stay DNS-safe lowercase hex");
assert.match(source, /const TERMINAL_PROCESS_STATUSES/u);
assert.match(source, /parseTerminalArtifact/u);
assert.match(source, /sandbox\.getSession\(ids\.sessionId\)/u);
assert.ok(`ah-nc031-async010-${"x".repeat(32)}`.length <= 63, "derived Cloudflare Sandbox identities stay within the platform limit");
assert.match(source, /NANOCODEX_EXECUTION_TIMEOUT_MS = 720_000/u, "agent execution stays below Cloudflare's 15-minute alarm limit");
for (const obsolete of ["DOC_AGENT_TOOLS", "safeDocumentationPatch", "runDocumentationAgent", "add -- README.md docs"]) assert.doesNotMatch(source, new RegExp(obsolete.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
assert.match(dockerfile, new RegExp(`NANOCODEX_VERSION=${NANOCODEX_VERSION}`, "u"));
assert.match(dockerfile, /GH_VERSION=2\.97\.0/u);
assert.match(dockerfile, /GH_STACK_VERSION=0\.1\.0/u);
assert.match(dockerfile, /sha256sum --check/gu);
assert.match(dockerfile, /COPY agent-entrypoint\.mjs/u);
assert.match(dockerfile, /job-entrypoint\.mjs/u);
const entrypointSource = await readFile(entrypoint, "utf8");
const jobEntrypointSource = await readFile(jobEntrypoint, "utf8");
assert.doesNotMatch(entrypointSource, /"--model"/u);
assert.match(entrypointSource, /request\.model !== NANOCODEX_MODEL/u);
assert.match(entrypointSource, /await emit/u);
assert.match(entrypointSource, /process\.exitCode =/u);
assert.match(jobEntrypointSource, /git", \["clone"/u);
assert.match(jobEntrypointSource, /node", \["\/opt\/app-harness\/agent-entrypoint\.mjs"\]/u);
assert.match(jobEntrypointSource, /findAndAnnotatePullRequest/u);
assert.match(jobEntrypointSource, /gh", \["stack", "init", "--base", "main", branch\]/u);
assert.match(jobEntrypointSource, /gh", \["stack", "submit", "--auto", "--open"\]/u);
assert.match(jobEntrypointSource, /gh", \["stack", "view", "--json"\]/u);
assert.match(jobEntrypointSource, /oneNodeStackView/u);
assert.match(jobEntrypointSource, /candidate-working-tree-dirty/u);
assert.match(jobEntrypointSource, /stack-head-not-pushed/u);
assert.doesNotMatch(jobEntrypointSource, /console\.log/u, "the background process emits only its bounded terminal artifact");

const directory = await mkdtemp(join(tmpdir(), "nanocodex-contract-"));
const mock = join(directory, "nanocodex");
await writeFile(mock, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "run" || !args.includes("--cwd") || !args.includes("--thinking") || args[args.indexOf("--thinking") + 1] !== "low" || !args.includes("--instructions") || !args.includes("--rollouts") || !args.includes("--store-responses") || !args.includes("--web-search") || args[args.indexOf("--web-search") + 1] !== "false" || !args.includes("--image-generation") || !args.includes("--subagents") || args[args.indexOf("--subagents") + 1] !== "true" || args.includes("--model") || args.at(-2) !== "--" || args.at(-1) !== "Implement task") process.exit(3);
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
