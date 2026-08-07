import { spawn } from "node:child_process";

const RESPONSE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
// NanoCodex v0.3.0 is compiled against this one Responses model.
const NANOCODEX_MODEL = "gpt-5.6-sol";
const MAX_LINE_BYTES = 1_048_576;
// Overall budget for the NanoCodex process, kept below the job entrypoint's
// own agent budget so this process reports its own failure rather than being
// killed from outside.
const NANOCODEX_TIMEOUT_MS = 520_000;
// A run that emits no JSONL line for this long is stalled, not slow. The
// override exists so the contract test can exercise the real kill path in
// milliseconds instead of only grepping for it.
const NANOCODEX_INACTIVITY_MS = Number(process.env.NANOCODEX_INACTIVITY_MS_OVERRIDE) || 120_000;
const WATCHDOG_INTERVAL_MS = Number(process.env.NANOCODEX_WATCHDOG_INTERVAL_MS_OVERRIDE) || 5_000;
const KILL_GRACE_MS = 2_000;
// Accumulated stdout is capped so a chatty agent cannot fill the pipe buffer
// and deadlock its own writes while this process is still reading.
const MAX_ACCUMULATED_STDOUT_BYTES = 2_097_152;

function emit(value) {
	return new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));
}

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
	if (input.length > 24_000) {
		await emit({ ok: false, classification: "nanocodex-input-too-large" });
		process.exit(2);
	}
}

let request;
try { request = JSON.parse(input); } catch { request = null; }
if (!request || typeof request.prompt !== "string" || !request.prompt.trim() || typeof request.instructions !== "string" || !request.instructions.trim() || typeof request.cwd !== "string" || !request.cwd.startsWith("/workspace/") || typeof request.model !== "string" || !MODEL.test(request.model) || request.model !== NANOCODEX_MODEL) {
	await emit({ ok: false, classification: "nanocodex-input-invalid" });
	process.exit(2);
}

const binary = process.env.NANOCODEX_BINARY || "/usr/local/bin/nanocodex";
const child = spawn(binary, [
	"run",
	"--cwd", request.cwd,
	"--thinking", "low",
	"--instructions", request.instructions,
	"--rollouts", "false",
	"--store-responses", "false",
	"--web-search", "false",
	"--image-generation", "false",
	"--subagents", "true",
	"--",
	request.prompt,
], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });

const responseIds = new Set();
const tools = new Set();
let terminal = null;
let pending = Buffer.alloc(0);
let accumulated = 0;
let droppedBytes = 0;
let lastLineAt = Date.now();
let killClassification = null;
let killTimer;

function killChild(classification) {
	if (killClassification) return;
	killClassification = classification;
	child.kill("SIGTERM");
	killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
}

const startedAt = Date.now();
// A ref'd interval, not an unref'd timer: it must keep the event loop alive and
// re-check wall-clock time so neither budget can be silently skipped.
const watchdog = setInterval(() => {
	if (Date.now() - startedAt >= NANOCODEX_TIMEOUT_MS) killChild("nanocodex-timeout");
	else if (Date.now() - lastLineAt >= NANOCODEX_INACTIVITY_MS) killChild("nanocodex-stalled");
}, WATCHDOG_INTERVAL_MS);

// Never let a failed write to a closed stdout throw and abort the run.
process.stdout.on("error", () => {});
child.stdin?.on("error", () => {});

function acceptLine(bytes) {
	if (bytes.length > MAX_LINE_BYTES) return;
	let event;
	try { event = JSON.parse(bytes.toString("utf8")); } catch { return; }
	if (event?.type === "model.call.completed" && typeof event.payload?.response_id === "string" && RESPONSE_ID.test(event.payload.response_id) && responseIds.size < 12) responseIds.add(event.payload.response_id);
	if (event?.type === "tool.call" && typeof event.payload?.tool === "string" && TOOL_NAME.test(event.payload.tool) && tools.size < 32) tools.add(event.payload.tool);
	if (event?.type === "run.completed") terminal = "completed";
	if (event?.type === "run.failed") terminal = "failed";
}

// The stream is always drained, even past the cap: dropping bytes on the floor
// still consumes them, which is what keeps the child's writes from blocking.
for await (const chunk of child.stdout) {
	accumulated += chunk.length;
	if (accumulated > MAX_ACCUMULATED_STDOUT_BYTES) {
		droppedBytes += chunk.length;
		pending = Buffer.alloc(0);
		lastLineAt = Date.now();
		continue;
	}
	pending = Buffer.concat([pending, chunk]);
	let newline;
	while ((newline = pending.indexOf(10)) >= 0) {
		acceptLine(pending.subarray(0, newline));
		lastLineAt = Date.now();
		pending = pending.subarray(newline + 1);
	}
	if (pending.length > MAX_LINE_BYTES) pending = Buffer.alloc(0);
}
if (pending.length) acceptLine(pending);

const code = await new Promise((resolve) => child.once("close", resolve));
clearInterval(watchdog);
if (killTimer) clearTimeout(killTimer);
const ok = code === 0 && terminal === "completed" && !killClassification;
await emit({
	ok,
	model: request.model,
	responseIds: [...responseIds],
	tools: [...tools],
	droppedBytes: droppedBytes || undefined,
	classification: ok ? undefined : killClassification ?? (terminal === "failed" ? "nanocodex-run-failed" : "nanocodex-process-failed"),
});
process.exitCode = ok ? 0 : 1;
