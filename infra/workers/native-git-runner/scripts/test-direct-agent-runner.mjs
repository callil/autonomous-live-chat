import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_DEFAULT_MODEL,
	buildAgentInstructions,
	normalizeAgentSummary,
} from "../src/runner-contract.js";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const entrypoint = new URL("../agent-entrypoint.mjs", import.meta.url);
const jobEntrypoint = new URL("../job-entrypoint.mjs", import.meta.url);

// --- Instruction contract ---------------------------------------------------

const instructions = buildAgentInstructions({
	repository: "callil/autonomous-live-chat",
	issueNumber: 42,
	branch: "app-harness-os/42/g1",
	stackId: "stack-request-42",
	generation: 1,
});
assert.match(instructions, /exactly three tools: read_file, write_file, and list_dir/u);
assert.match(instructions, /no shell, no network, no package manager, and no Git/u, "the instructions describe the real capability surface, not a hallucinated terminal");
assert.match(instructions, /Do not claim to have run tests, builds, or commands/u);
assert.match(instructions, /default product surface is apps\/demo/u);
assert.match(instructions, /Never read, print, copy, commit, or expose credentials/u);
assert.match(instructions, /official gh stack CLI/u, "the harness, not the model, owns stack submission");
assert.match(instructions, /CI is the merge and production deployment authority/u);
assert.match(instructions, /Multi-node stacks are not enabled yet/u);
assert.doesNotMatch(instructions, /subagents|terminal|package managers|Wrangler/u, "capabilities the direct agent does not have must not be promised");
assert.equal(AGENT_DEFAULT_MODEL, "gpt-5.3-codex");

const bounded = normalizeAgentSummary({
	model: AGENT_DEFAULT_MODEL,
	responseIds: ["resp_1", "resp_1", "bad value", ...Array.from({ length: 20 }, (_, index) => `resp_${index + 2}`)],
	tools: ["read_file", "read_file", "write_file", { raw: "discard" }, ...Array.from({ length: 40 }, (_, index) => `tool.${index}`)],
	transcript: "must not survive",
	arguments: { token: "must not survive" },
});
assert.equal(bounded.responseIds.length, 12);
assert.equal(bounded.tools.length, 32);
assert.deepEqual(Object.keys(bounded).sort(), ["model", "responseIds", "tools"]);
assert.doesNotMatch(JSON.stringify(bounded), /must not survive/u);

// --- Worker source contract -------------------------------------------------

assert.match(source, /kind: "repository-task"/u);
assert.match(source, /node \/opt\/app-harness\/job-entrypoint\.mjs/u);
assert.match(source, /session\.writeFile\(ids\.requestPath, JSON\.stringify/u);
assert.match(source, /session\.startProcess/u);
assert.match(source, /const processId = `p-\$\{\(ledgerRunId \?\? crypto\.randomUUID\(\)\)/u, "every attempt gets its own process identity so retries can never attach to a prior attempt's record");
assert.match(source, /autoCleanup: false/u);
assert.match(source, /timeout: AGENT_EXECUTION_TIMEOUT_MS/u);
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
assert.match(config, /"deleted_classes": \["RunnerJob"\]/u);
assert.doesNotMatch(config, /"name": "RUNNER_JOB"/u);
assert.doesNotMatch(source, /runJob\(/u, "the Worker cannot synchronously own a full implementation run");
assert.match(source, /async function deterministicId/u);
assert.match(source, /hex\.slice\(0, 32\)/u, "sandbox identifiers stay DNS-safe lowercase hex");
assert.match(source, /const TERMINAL_PROCESS_STATUSES/u);
assert.match(source, /parseTerminalArtifact/u);
assert.match(source, /sandbox\.getSession\(ids\.sessionId\)/u);
assert.match(source, /RUNNER_IMAGE_REVISION = "da052-async014"/u, "the image revision changes with the agent replacement so no run resumes a stale NanoCodex sandbox");
assert.ok(`ah-da052-async014-${"x".repeat(32)}`.length <= 63, "derived Cloudflare Sandbox identities stay within the platform limit");

// The budget layering that silently killed four consecutive production runs:
// the SDK-side process timeout must sit strictly ABOVE the in-container run
// deadline plus the watchdog's emit grace, or the platform SIGKILL beats the
// watchdog and no artifact, callback, or classification is ever observable.
assert.match(source, /AGENT_EXECUTION_TIMEOUT_MS = 330_000/u);
assert.match(source, /RUNNER_DEADLINE_GRACE_MS = 120_000/u, "the Worker backstop sits past every in-container watchdog");
const jobEntrypointSource = await readFile(jobEntrypoint, "utf8");
const workerTimeout = Number(source.match(/AGENT_EXECUTION_TIMEOUT_MS = (\d+_?\d*)/u)[1].replaceAll("_", ""));
const runDeadline = Number(jobEntrypointSource.match(/RUN_DEADLINE_MS = (\d+_?\d*)/u)[1].replaceAll("_", ""));
assert.ok(workerTimeout >= runDeadline + 30_000, "the SDK process timeout must exceed the in-container run deadline by at least the emit-and-callback grace");

// Boot verification: a job process that dies before its first line is an
// immediate classified startRun failure, never a silent hang.
assert.match(source, /BOOT_VERIFICATION_TIMEOUT_MS = 15_000/u);
assert.match(source, /function bootMarkerPath/u);
assert.match(source, /\$\{ids\.requestPath\}\.boot/u);
assert.match(source, /classification: "job-boot-failed"/u);
assert.match(source, /processStatus/u, "the boot failure carries whatever process state the SDK exposes");
assert.match(source, /function startedMarkerPath/u, "startRun persists a start marker so run age is derivable");
assert.match(source, /\$\{ids\.requestPath\}\.started/u);
assert.match(source, /session\.writeFile\(startedMarkerPath\(ids\)/u);
assert.match(source, /async function runAgeMs/u);
assert.match(source, /AGENT_EXECUTION_TIMEOUT_MS \+ RUNNER_DEADLINE_GRACE_MS/u, "inspectRun enforces the deadline from the persisted start marker");
assert.match(source, /process\.kill\("SIGKILL"\)/u, "a wedged run is actively killed rather than reported as running forever");
assert.match(source, /classification: "runner-deadline-enforced"/u);
assert.match(source, /classification: "agent-output-invalid"/u);
assert.match(source, /MAX_ARTIFACT_STDOUT_CHARS = 200_000/u, "a chatty run must not have its terminal artifact discarded by a low cap");
assert.match(source, /function parseArtifactLine/u);
assert.match(source, /for \(let index = lines\.length - 1; index >= 0; index -= 1\)/u, "the parser scans backwards for the last parseable artifact");
assert.match(source, /destroySandboxSafely\(sandbox, ids\.sessionId\)/u, "a wedged sandbox is destroyed so max_instances capacity is reclaimed");
assert.doesNotMatch(source, /nanocodex/iu, "the NanoCodex binary dependency is gone");

// --- Image contract ---------------------------------------------------------

assert.doesNotMatch(dockerfile, /nanocodex/iu, "the image no longer downloads an agent binary; the agent is a direct API loop on the base Node runtime");
assert.match(dockerfile, /GH_VERSION=2\.97\.0/u);
assert.match(dockerfile, /GH_STACK_VERSION=0\.1\.0/u);
assert.match(dockerfile, /sha256sum --check/gu);
assert.match(dockerfile, /COPY agent-entrypoint\.mjs/u);
assert.match(dockerfile, /job-entrypoint\.mjs/u);

// --- Job entrypoint contract ------------------------------------------------

const entrypointSource = await readFile(entrypoint, "utf8");
// The boot heartbeat is the process's first observable act.
assert.match(jobEntrypointSource, /writeFileSync\(`\$\{bootRequestPath\}\.boot`/u);
assert.ok(jobEntrypointSource.indexOf(".boot") < jobEntrypointSource.indexOf("const SHA"), "the boot marker is written before any other work");
assert.match(jobEntrypointSource, /git", \["clone"/u);
assert.match(jobEntrypointSource, /node", \["\/opt\/app-harness\/agent-entrypoint\.mjs"\]/u);
assert.match(jobEntrypointSource, /findAndAnnotatePullRequest/u);
assert.match(jobEntrypointSource, /gh", \["stack", "init", "--base", "main", branch\]/u);
assert.match(jobEntrypointSource, /gh", \["stack", "submit", "--auto", "--open"\]/u);
assert.match(jobEntrypointSource, /gh", \["stack", "view", "--json"\]/u);
assert.match(jobEntrypointSource, /oneNodeStackView/u);
assert.match(jobEntrypointSource, /candidate-working-tree-dirty/u);
assert.match(jobEntrypointSource, /stack-head-not-pushed/u);
assert.doesNotMatch(jobEntrypointSource, /console\.log/u, "the background process emits only bounded JSONL");

// The direct agent stages file contents only, so the job entrypoint owns the
// Git identity, staging, and commit that NanoCodex used to perform itself.
assert.match(jobEntrypointSource, /"config", "user\.email"/u);
assert.match(jobEntrypointSource, /"config", "user\.name"/u);
assert.match(jobEntrypointSource, /"add", "-A"/u);
assert.match(jobEntrypointSource, /"commit", "-m"/u);
assert.match(jobEntrypointSource, /candidate-identity-failed/u);
assert.match(jobEntrypointSource, /candidate-stage-failed/u);
assert.match(jobEntrypointSource, /candidate-commit-failed/u);

// Budgets stay as on main; every blocking step carries its own budget.
assert.match(jobEntrypointSource, /CLONE_TIMEOUT_MS = 120_000/u);
assert.match(jobEntrypointSource, /GIT_TIMEOUT_MS = 60_000/u);
assert.match(jobEntrypointSource, /AGENT_TIMEOUT_MS = 260_000/u);
assert.match(jobEntrypointSource, /GH_STACK_TIMEOUT_MS = 120_000/u);
assert.match(jobEntrypointSource, /GITHUB_FETCH_TIMEOUT_MS = 30_000/u);
assert.match(jobEntrypointSource, /RUN_DEADLINE_MS = 300_000/u);
assert.match(jobEntrypointSource, /options\.timeoutMs/u, "run() honours a per-step budget");
assert.match(jobEntrypointSource, /child\.kill\("SIGTERM"\)/u);
assert.match(jobEntrypointSource, /child\.kill\("SIGKILL"\)/u, "a child that ignores SIGTERM is escalated");
assert.match(jobEntrypointSource, /exitCode: 124, stdout, stderr: "step-timeout"/u);
assert.match(jobEntrypointSource, /AbortSignal\.timeout\(GITHUB_FETCH_TIMEOUT_MS\)/gu, "every GitHub fetch is bounded");
assert.match(jobEntrypointSource, /timeoutMs: CLONE_TIMEOUT_MS/u);
assert.match(jobEntrypointSource, /timeoutMs: AGENT_TIMEOUT_MS/u);
assert.match(jobEntrypointSource, /timeoutMs: GH_STACK_TIMEOUT_MS/u);
// The watchdog must hold the event loop open: an unref'd timer is exactly how
// earlier runs wedged in "running" without ever emitting the deadline artifact.
assert.match(jobEntrypointSource, /const watchdog = setInterval\(/u);
assert.doesNotMatch(jobEntrypointSource, /\.unref\(\)|unref\?\.\(\)/u, "the run deadline must not be unref'd");
assert.match(jobEntrypointSource, /clearInterval\(watchdog\)/gu, "the watchdog is cleared before the final artifact is emitted");
assert.match(jobEntrypointSource, /classification: "agent-deadline-exceeded"/u, "a deadline-exceeded run is classified as such");
// The proven root cause of the wedged runs: stdout.write to a pipe is async, so
// a fire-and-forget emit followed by process.exit destroyed the artifact.
assert.match(jobEntrypointSource, /function emit\(value\) \{\n\treturn new Promise/u, "emit resolves on the write callback");
assert.match(jobEntrypointSource, /await Promise\.race\(\[\n\t\temit\(deadline\)\.then\(\(\) => postCallback\(deadline\)\)/u, "the watchdog awaits its artifact and pushes the terminal fact, capped, before exiting");
assert.match(jobEntrypointSource, /await emit\(result\)/u);
assert.doesNotMatch(jobEntrypointSource, /\n\temit\(/u, "no emit is fire-and-forget");
assert.match(jobEntrypointSource, /const liveChildren = new Set\(\)/u);
assert.match(jobEntrypointSource, /function killAllChildren/u);

// Observability: step transitions accumulate in a progress array; the terminal
// callback carries the array plus bounded agent transcript and stderr tails;
// live heartbeats ride the same callback URL as progress facts.
assert.match(jobEntrypointSource, /const progress = \[\]/u);
assert.match(jobEntrypointSource, /function appendProgress/u);
assert.match(jobEntrypointSource, /function postHeartbeat/u);
for (const step of ["cloned", "agent-started", "agent-done", "pushed"]) assert.match(jobEntrypointSource, new RegExp(`postHeartbeat\\("${step}"\\)`, "u"));
assert.match(jobEntrypointSource, /progress: true/u, "heartbeats are marked so the ledger records them separately from the terminal fact");
assert.match(jobEntrypointSource, /transcriptTail/u);
assert.match(jobEntrypointSource, /agentStderrTail/u);
assert.match(jobEntrypointSource, /MAX_TAIL_CHARS = 16_000/u);
assert.match(jobEntrypointSource, /function parseAgentSummary/u, "the agent summary is the last parseable JSONL line, tolerant of transcript lines before it");

// --- Agent entrypoint contract ----------------------------------------------

assert.doesNotMatch(entrypointSource, /child_process|spawn\(/u, "the agent is a direct API loop, not a binary supervisor");
assert.match(entrypointSource, /AGENT_MODEL = "gpt-5\.3-codex"/u);
assert.match(entrypointSource, /\/responses`/u, "the agent drives the Responses API per the current platform docs");
assert.match(entrypointSource, /include: \["reasoning\.encrypted_content"\]/u, "reasoning items are requested and replayed between tool calls per the docs");
assert.match(entrypointSource, /AbortSignal\.timeout/u, "every model request is bounded");
assert.match(entrypointSource, /AGENT_WALL_CLOCK_MS = 240_000/u, "the agent wall clock stays at 240s");
assert.match(entrypointSource, /AGENT_REQUEST_TIMEOUT_MS_OVERRIDE\) \|\| 120_000/u, "a model request that produces nothing for 120s is stalled");
assert.match(entrypointSource, /AGENT_MAX_TOOL_CALLS_OVERRIDE\) \|\| 12/u, "the loop is bounded at 12 tool calls");
assert.match(entrypointSource, /const DENIED_PATHS/u);
assert.match(entrypointSource, /parallel_tool_calls: false/u);
assert.match(entrypointSource, /await emit/u);
assert.match(entrypointSource, /process\.exitCode =/u);
assert.doesNotMatch(entrypointSource, /\.unref\(/u);

// --- Live agent runs against a scripted Responses API ------------------------

function startMockModel(responders) {
	const requests = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body);
			requests.push(parsed);
			const responder = responders.length === 1 ? responders[0] : responders[requests.length - 1];
			if (!responder) {
				response.writeHead(500).end("{}");
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(responder(parsed, requests.length)));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
	});
}

function functionCall(id, name, args) {
	return { id, output: [{ type: "reasoning", encrypted_content: `enc-${id}` }, { type: "function_call", call_id: `call-${id}`, name, arguments: JSON.stringify(args) }] };
}

function finalText(id, text) {
	return { id, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

async function runAgent({ port, checkout, env = {} }) {
	const child = spawn(process.execPath, [entrypoint.pathname], {
		env: {
			...process.env,
			OPENAI_API_KEY: "test-key-must-not-leak",
			OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
			AGENT_ROOT_PREFIX_OVERRIDE: checkout,
			AGENT_RETRY_BACKOFF_MS_OVERRIDE: "10",
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.end(JSON.stringify({ prompt: "Implement task", instructions, cwd: checkout, model: AGENT_DEFAULT_MODEL }));
	const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
	const code = await new Promise((resolve) => child.once("close", resolve));
	clearTimeout(guard);
	const lines = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { code, stdout, stderr, lines, summary: lines.at(-1) };
}

// Happy path: explore, read, stage a write, survive a traversal attempt and a
// denied secret path, then finish. The staged write lands on disk, the summary
// is the last JSONL line, and neither file contents nor credentials leak.
{
	const checkout = await mkdtemp(join(tmpdir(), "agent-happy-"));
	await writeFile(join(checkout, "notes.txt"), "hello\n");
	const { server, requests, port } = await startMockModel([
		(body) => {
			assert.equal(body.model, AGENT_DEFAULT_MODEL);
			assert.equal(body.parallel_tool_calls, false);
			assert.equal(body.store, false);
			assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
			assert.equal(body.tools.length, 3);
			assert.ok(body.tools.every((tool) => tool.strict === true), "every tool schema is strict per the docs contract");
			assert.deepEqual(body.tools.map((tool) => tool.name).sort(), ["list_dir", "read_file", "write_file"]);
			assert.match(body.instructions, /exactly three tools/u);
			assert.match(body.input[0].content, /Repository tree/u);
			return functionCall("resp_1", "list_dir", { path: "." });
		},
		() => functionCall("resp_2", "read_file", { path: "notes.txt" }),
		() => functionCall("resp_3", "write_file", { path: "notes.txt", content: "hello world\n" }),
		() => functionCall("resp_4", "read_file", { path: "../../etc/passwd" }),
		() => functionCall("resp_5", "read_file", { path: ".env" }),
		() => finalText("resp_6", "Updated notes.txt."),
	]);
	const result = await runAgent({ port, checkout });
	server.close();
	assert.equal(result.code, 0);
	assert.equal(result.summary.ok, true);
	assert.equal(result.summary.model, AGENT_DEFAULT_MODEL);
	assert.deepEqual(result.summary.responseIds, ["resp_1", "resp_2", "resp_3", "resp_4", "resp_5", "resp_6"]);
	assert.deepEqual([...result.summary.tools].sort(), ["list_dir", "read_file", "write_file"]);
	assert.equal(result.summary.toolCalls, 5);
	assert.deepEqual(result.summary.writes, ["notes.txt"]);
	assert.equal(result.summary.summary, "Updated notes.txt.");
	assert.equal(await readFile(join(checkout, "notes.txt"), "utf8"), "hello world\n", "staged writes are applied to the checkout");
	// The traversal and denied-path attempts surfaced as tool errors to the
	// model, and the run still terminated cleanly.
	const toolOutputs = requests.flatMap((body) => (body.input ?? []).filter((item) => item?.type === "function_call_output").map((item) => item.output));
	// Reasoning items must be replayed on later requests, or the model loses
	// its chain of thought under store:false.
	assert.ok(requests.some((body) => (body.input ?? []).some((item) => item?.type === "reasoning")), "reasoning items ride the transcript between tool calls");
	assert.ok(toolOutputs.some((output) => /Error: path escapes the checkout/u.test(output)));
	assert.ok(toolOutputs.some((output) => /Error: path is not permitted/u.test(output)));
	assert.doesNotMatch(result.stdout, /hello world/u, "file contents never ride the transcript");
	assert.doesNotMatch(result.stdout, /test-key-must-not-leak/u, "the credential never rides the transcript");
	assert.ok(result.lines.some((line) => line.type === "tool.call"), "tool calls are visible as JSONL transcript events");
	assert.ok(result.lines.some((line) => line.type === "model.call.completed"));
	await rm(checkout, { recursive: true, force: true });
}

// A run that changes nothing is a classified failure, not a silent success.
{
	const checkout = await mkdtemp(join(tmpdir(), "agent-nochange-"));
	const { server, port } = await startMockModel([
		() => finalText("resp_1", "Nothing to do."),
	]);
	const result = await runAgent({ port, checkout });
	server.close();
	assert.equal(result.code, 1);
	assert.equal(result.summary.ok, false);
	assert.equal(result.summary.classification, "agent-made-no-change");
	await rm(checkout, { recursive: true, force: true });
}

// A model that never stops calling tools exhausts the bounded loop and is
// reported truthfully instead of running forever.
{
	const checkout = await mkdtemp(join(tmpdir(), "agent-budget-"));
	await writeFile(join(checkout, "notes.txt"), "hello\n");
	let calls = 0;
	const { server, port } = await startMockModel([
		() => { calls += 1; return functionCall(`resp_loop_${calls}`, "read_file", { path: "notes.txt" }); },
	]);
	const result = await runAgent({ port, checkout, env: { AGENT_MAX_TOOL_CALLS_OVERRIDE: "1" } });
	server.close();
	assert.equal(result.code, 1);
	assert.equal(result.summary.ok, false);
	assert.equal(result.summary.classification, "agent-model-budget-exhausted");
	assert.equal(result.summary.toolCalls, 1, "the tool budget is enforced");
	await rm(checkout, { recursive: true, force: true });
}

// An unreachable model endpoint is a fast classified failure, not a hang.
{
	const checkout = await mkdtemp(join(tmpdir(), "agent-unreachable-"));
	const result = await runAgent({ port: 9, checkout });
	assert.equal(result.code, 1);
	assert.equal(result.summary.ok, false);
	assert.equal(result.summary.classification, "agent-model-unreachable");
	await rm(checkout, { recursive: true, force: true });
}

// --- Job entrypoint boot heartbeat, live ------------------------------------

// The job writes `<requestPath>.boot` before any other work, even when the
// request itself is missing or invalid — that is what lets startRun separate
// "the process never ran a line" from every later failure.
{
	const requestPath = `/tmp/ah-boot-test-${process.pid}-request.json`;
	const bootPath = `${requestPath}.boot`;
	await rm(bootPath, { force: true });
	const child = spawn(process.execPath, [jobEntrypoint.pathname, requestPath], { stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
	const code = await new Promise((resolve) => child.once("close", resolve));
	clearTimeout(guard);
	assert.equal(code, 1);
	await access(bootPath);
	const artifactLine = JSON.parse(stdout.trim().split("\n").at(-1));
	assert.equal(artifactLine.state, "candidate-failed");
	assert.equal(artifactLine.classification, "runner-entrypoint-failed");
	await rm(bootPath, { force: true });
}

console.log("Direct-agent Sandbox runner contracts passed");
