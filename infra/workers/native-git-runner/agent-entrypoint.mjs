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
const NANOCODEX_TIMEOUT_MS = 240_000;
// A run that emits no JSONL line for this long is stalled, not slow. The
// override exists so the contract test can exercise the real kill path in
// milliseconds instead of only grepping for it.
const NANOCODEX_INACTIVITY_MS = Number(process.env.NANOCODEX_INACTIVITY_MS_OVERRIDE) || 120_000;
const WATCHDOG_INTERVAL_MS = Number(process.env.NANOCODEX_WATCHDOG_INTERVAL_MS_OVERRIDE) || 5_000;
const KILL_GRACE_MS = 2_000;
// Bounded stderr tail. stderr was previously discarded outright, which threw
// away the primary diagnostic whenever a run failed.
const MAX_STDERR_BYTES = 8_192;

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
], {
	env: process.env,
	// stderr is piped, not discarded: it is the primary diagnostic when a run
	// fails. Node's own timeout/killSignal is the innermost backstop, so the
	// child dies even if this process's own loops are wedged.
	stdio: ["ignore", "pipe", "pipe"],
	timeout: NANOCODEX_TIMEOUT_MS,
	killSignal: "SIGKILL",
});

const responseIds = new Set();
const tools = new Set();
let terminal = null;
let pending = Buffer.alloc(0);
let stderrTail = "";
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
child.stderr.on("error", () => {});
// stderr is drained continuously so it can never fill its pipe, but only a
// bounded tail is retained for the failure artifact.
child.stderr.on("data", (chunk) => {
	stderrTail = `${stderrTail}${chunk}`.slice(-MAX_STDERR_BYTES);
});

// Nothing below is awaited without a deadline: neither the stdout iterator nor
// the close event is trusted to settle on its own.
function withDeadline(promise, ms, fallback) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			() => { clearTimeout(timer); resolve(fallback); },
		);
	});
}

function acceptLine(bytes) {
	if (bytes.length > MAX_LINE_BYTES) return;
	let event;
	try { event = JSON.parse(bytes.toString("utf8")); } catch { return; }
	if (event?.type === "model.call.completed" && typeof event.payload?.response_id === "string" && RESPONSE_ID.test(event.payload.response_id) && responseIds.size < 12) responseIds.add(event.payload.response_id);
	if (event?.type === "tool.call" && typeof event.payload?.tool === "string" && TOOL_NAME.test(event.payload.tool) && tools.size < 32) tools.add(event.payload.tool);
	if (event?.type === "run.completed") terminal = "completed";
	if (event?.type === "run.failed") terminal = "failed";
}

async function consumeStdout() {
	for await (const chunk of child.stdout) {
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
}

// The iterator is bounded: if it never ends, the run still reports rather than
// hanging here forever.
await withDeadline(consumeStdout(), NANOCODEX_TIMEOUT_MS + KILL_GRACE_MS, null);
const code = await withDeadline(
	new Promise((resolve) => child.once("close", resolve)),
	KILL_GRACE_MS * 2,
	null,
);
clearInterval(watchdog);
if (killTimer) clearTimeout(killTimer);
if (code === null && !killClassification) killClassification = "nanocodex-process-unterminated";
try { child.kill("SIGKILL"); } catch { /* already gone */ }
const ok = code === 0 && terminal === "completed" && !killClassification;
await emit({
	ok,
	model: request.model,
	responseIds: [...responseIds],
	tools: [...tools],
	stderr: ok ? undefined : stderrTail.trim().slice(-MAX_STDERR_BYTES) || undefined,
	classification: ok ? undefined : killClassification ?? (terminal === "failed" ? "nanocodex-run-failed" : "nanocodex-process-failed"),
});
process.exitCode = ok ? 0 : 1;
