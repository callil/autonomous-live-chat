import { spawn } from "node:child_process";

const RESPONSE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const NANOCODEX_MODEL = "gpt-5.6-sol";
const MAX_LINE_BYTES = 1_048_576;

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
	"--thinking", "high",
	"--instructions", request.instructions,
	"--rollouts", "false",
	"--store-responses", "false",
	"--web-search", "true",
	"--image-generation", "false",
	"--",
	request.prompt,
], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });

const responseIds = new Set();
const tools = new Set();
let terminal = null;
let pending = Buffer.alloc(0);

function acceptLine(bytes) {
	if (bytes.length > MAX_LINE_BYTES) return;
	let event;
	try { event = JSON.parse(bytes.toString("utf8")); } catch { return; }
	if (event?.type === "model.call.completed" && typeof event.payload?.response_id === "string" && RESPONSE_ID.test(event.payload.response_id) && responseIds.size < 12) responseIds.add(event.payload.response_id);
	if (event?.type === "tool.call" && typeof event.payload?.tool === "string" && TOOL_NAME.test(event.payload.tool) && tools.size < 32) tools.add(event.payload.tool);
	if (event?.type === "run.completed") terminal = "completed";
	if (event?.type === "run.failed") terminal = "failed";
}

for await (const chunk of child.stdout) {
	pending = Buffer.concat([pending, chunk]);
	let newline;
	while ((newline = pending.indexOf(10)) >= 0) {
		acceptLine(pending.subarray(0, newline));
		pending = pending.subarray(newline + 1);
	}
	if (pending.length > MAX_LINE_BYTES) pending = Buffer.alloc(0);
}
if (pending.length) acceptLine(pending);

const code = await new Promise((resolve) => child.once("close", resolve));
await emit({
	ok: code === 0 && terminal === "completed",
	model: request.model,
	responseIds: [...responseIds],
	tools: [...tools],
	classification: code === 0 && terminal === "completed" ? undefined : terminal === "failed" ? "nanocodex-run-failed" : "nanocodex-process-failed",
});
process.exitCode = code === 0 && terminal === "completed" ? 0 : 1;
