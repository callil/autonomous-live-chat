import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
// The one coding model this runner drives through the OpenAI Responses API.
// Kept in lockstep with AGENT_DEFAULT_MODEL in src/runner-contract.js.
const AGENT_MODEL = "gpt-5.4-nano";

// Budgets. The agent wall clock matches the previous runner generation: 240s,
// inside the job entrypoint's 260s step budget, inside the 300s run deadline.
// A single model request that produces nothing for 120s is stalled, not slow —
// the direct-API analogue of the old JSONL inactivity watchdog.
const AGENT_WALL_CLOCK_MS = 240_000;
const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.AGENT_REQUEST_TIMEOUT_MS_OVERRIDE) || 120_000;
// The bounded loop: at most 12 tool executions, and a few extra model turns so
// the final no-tool answer after the twelfth call is still reachable.
const MAX_TOOL_CALLS = Number(process.env.AGENT_MAX_TOOL_CALLS_OVERRIDE) || 12;
const MAX_MODEL_CALLS = MAX_TOOL_CALLS + 4;
const MODEL_RETRY_BACKOFF_MS = Number(process.env.AGENT_RETRY_BACKOFF_MS_OVERRIDE) || 4_000;
const MAX_FILE_BYTES = 256_000;
const MAX_TOOL_RESULT_BYTES = 24_000;
const MAX_DIR_ENTRIES = 400;
const MAX_TREE_ENTRIES = 500;
const MAX_TREE_DEPTH = 4;
const API_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const ROOT_PREFIX = process.env.AGENT_ROOT_PREFIX_OVERRIDE || "/workspace/";

// Paths that are never listed, read, or written. The security rule is enforced
// in code here, not merely stated in the prompt.
const DENIED_PATHS = [
	/(^|\/)\.git(\/|$)/u,
	/(^|\/)node_modules(\/|$)/u,
	/(^|\/)\.env(\.|$|\/)/u,
	/(^|\/)\.(npmrc|netrc|ssh|aws|gnupg|wrangler)(\/|$)/u,
	/(^|\/)[^/]*(secret|credential|token)[^/]*$/iu,
	/\.(pem|key|p12|pfx|keystore)$/iu,
];

// Writes to a pipe are asynchronous: resolving on the write callback is what
// makes each transcript line real before any exit.
function emit(value) {
	return new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve));
}

async function fail(classification) {
	await emit({ ok: false, model: AGENT_MODEL, responseIds: [], tools: [], toolCalls: 0, writes: [], classification });
	process.exit(1);
}

let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
	if (input.length > 24_000) await fail("agent-input-too-large");
}

let request;
try { request = JSON.parse(input); } catch { request = null; }
if (
	!request
	|| typeof request.prompt !== "string" || !request.prompt.trim()
	|| typeof request.instructions !== "string" || !request.instructions.trim()
	|| typeof request.cwd !== "string" || !request.cwd.startsWith(ROOT_PREFIX)
	|| typeof request.model !== "string" || !MODEL.test(request.model)
) await fail("agent-input-invalid");

const apiKey = process.env.OPENAI_API_KEY;
if (typeof apiKey !== "string" || !apiKey) await fail("agent-credential-missing");

const root = resolve(request.cwd);
const startedAt = Date.now();
const deadline = startedAt + AGENT_WALL_CLOCK_MS;
const responseIds = new Set();
const tools = new Set();
// Writes accumulate here and are applied to the checkout only after the loop
// ends, so a half-finished exploration never dirties the working tree.
const stagedWrites = new Map();

// --- Path safety -----------------------------------------------------------

/** Resolve a model-supplied path strictly inside the checkout, or throw. */
function safePath(value) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("path is invalid");
	const absolute = resolve(root, value);
	const rel = relative(root, absolute);
	if (rel.startsWith("..") || (rel !== "" && resolve(root, rel) !== absolute)) throw new Error("path escapes the checkout");
	const probe = rel.split(sep).join("/");
	for (const pattern of DENIED_PATHS) if (pattern.test(probe)) throw new Error("path is not permitted");
	return { absolute, relative: probe };
}

function clip(text) {
	const value = String(text);
	return value.length > MAX_TOOL_RESULT_BYTES ? `${value.slice(0, MAX_TOOL_RESULT_BYTES)}\n[truncated]` : value;
}

// --- Bounded repository tree ----------------------------------------------

async function boundedTree() {
	const lines = [];
	async function walk(rel, depth) {
		if (lines.length >= MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) return;
		let entries;
		try { entries = await readdir(rel === "" ? root : join(root, rel), { withFileTypes: true }); } catch { return; }
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (lines.length >= MAX_TREE_ENTRIES) return;
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			try { safePath(childRel); } catch { continue; }
			lines.push(entry.isDirectory() ? `${childRel}/` : childRel);
			if (entry.isDirectory()) await walk(childRel, depth + 1);
		}
	}
	await walk("", 1);
	return lines.join("\n");
}

// --- Tools -----------------------------------------------------------------

const TOOL_SCHEMA = [
	{
		type: "function",
		function: {
		name: "read_file",
		description: "Read a UTF-8 text file inside the repository checkout. Paths are relative to the repository root. Staged writes from earlier write_file calls are visible.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Repository-relative file path." } },
			required: ["path"],
			additionalProperties: false,
		},
		},
	},
	{
		type: "function",
		function: {
		name: "write_file",
		description: "Stage the complete new contents of one file inside the repository checkout, creating it if needed. Supply the entire file, not a diff. Read the current file first unless you are creating it. Staged writes are applied together when you finish.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Repository-relative file path." },
				content: { type: "string", description: "The complete new file contents." },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		},
	},
	{
		type: "function",
		function: {
		name: "list_dir",
		description: "List the entries of a directory inside the repository checkout. Use \".\" for the repository root. Directories end with \"/\".",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Repository-relative directory path." } },
			required: ["path"],
			additionalProperties: false,
		},
		},
	},
];

async function callTool(name, args) {
	if (name === "read_file") {
		const { absolute, relative: rel } = safePath(args?.path);
		if (stagedWrites.has(rel)) return clip(stagedWrites.get(rel));
		const info = await stat(absolute);
		if (!info.isFile()) throw new Error("path is not a file");
		if (info.size > MAX_FILE_BYTES) throw new Error(`file is too large (${info.size} bytes)`);
		return clip(await readFile(absolute, "utf8"));
	}
	if (name === "write_file") {
		const { relative: rel } = safePath(args?.path);
		if (typeof args?.content !== "string") throw new Error("content must be a string");
		if (args.content.length > MAX_FILE_BYTES) throw new Error("content is too large");
		stagedWrites.set(rel, args.content);
		return `Staged ${rel} (${args.content.length} bytes).`;
	}
	if (name === "list_dir") {
		const { absolute, relative: rel } = safePath(args?.path ?? ".");
		const entries = await readdir(absolute, { withFileTypes: true });
		const visible = entries
			.filter((entry) => { try { safePath(rel === "" ? entry.name : `${rel}/${entry.name}`); return true; } catch { return false; } })
			.slice(0, MAX_DIR_ENTRIES)
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
		return visible.length ? visible.join("\n") : "(empty)";
	}
	throw new Error("unknown tool");
}

// --- Model transport -------------------------------------------------------

function classified(message, classification, retryable = false) {
	return Object.assign(new Error(message), { classification, retryable });
}

async function callModel(body) {
	const remaining = deadline - Date.now();
	if (remaining <= 5_000) throw classified("budget", "agent-budget-exhausted");
	let response;
	try {
		// Two independent stops: the per-request timeout and the wall clock. A
		// request can never outlive the run budget.
		response = await fetch(`${API_BASE}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Math.min(MODEL_REQUEST_TIMEOUT_MS, remaining - 1_000)),
		});
	} catch {
		throw classified("transport", "agent-model-unreachable", true);
	}
	if (response.status === 429 || response.status >= 500) throw classified("upstream", "agent-model-unavailable", true);
	if (!response.ok) throw classified("rejected", "agent-model-rejected");
	try { return await response.json(); } catch { throw classified("decode", "agent-model-rejected"); }
}

async function callModelWithRetry(body) {
	let lastError;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try { return await callModel(body); } catch (error) {
			lastError = error;
			if (!error.retryable || attempt === 2) throw error;
			const backoff = Math.min(MODEL_RETRY_BACKOFF_MS * 2 ** attempt, Math.max(0, deadline - Date.now() - 5_000));
			if (backoff <= 0) throw error;
			await new Promise((resolve) => setTimeout(resolve, backoff));
		}
	}
	throw lastError;
}

// --- Loop ------------------------------------------------------------------

const system = [
	request.instructions,
	"",
	"You operate through exactly three tools: read_file, write_file, and list_dir.",
	"You have no shell, no network, no package manager, and no Git. Do not claim to have run tests, builds, or commands; the execution harness commits your staged writes and CI validates them.",
	"Explore with list_dir and read_file before editing. write_file stages a whole replacement file, so read a file before rewriting it.",
	"Never read, print, copy, or reproduce credentials, tokens, or private keys. Paths containing them are blocked and you must not attempt to reach them.",
	`You have a hard budget of ${MAX_TOOL_CALLS} tool calls. Make the smallest coherent change that satisfies the request, then answer in plain text (no tool call) with one or two sentences describing what changed.`,
].join("\n");

const tree = await boundedTree();
const transcript = [
	{ role: "system", content: system },
	{ role: "user", content: `${request.prompt}\n\nRepository tree (bounded to ${MAX_TREE_ENTRIES} entries, depth ${MAX_TREE_DEPTH}):\n${tree}` },
];
let toolCalls = 0;
let modelCalls = 0;
let classification = null;
let finalSummary = "";
let finished = false;

try {
	while (!finished) {
		if (modelCalls >= MAX_MODEL_CALLS) { classification = "agent-model-budget-exhausted"; break; }
		if (Date.now() >= deadline - 5_000) { classification = "agent-budget-exhausted"; break; }
		modelCalls += 1;

		const result = await callModelWithRetry({
			model: request.model,
			messages: transcript,
			tools: TOOL_SCHEMA,
			tool_choice: "auto",
			parallel_tool_calls: false,
		});

		if (typeof result?.id === "string" && responseIds.size < 12) responseIds.add(result.id.slice(0, 120));
		await emit({ type: "model.call.completed", payload: { response_id: typeof result?.id === "string" ? result.id.slice(0, 120) : "unknown" } });

		const message = result?.choices?.[0]?.message;
		if (!message) throw classified("decode", "agent-model-rejected");
		// The assistant message goes back verbatim so tool call ids stay paired
		// with their tool results.
		transcript.push(message);
		const calledTools = Array.isArray(message.tool_calls) ? message.tool_calls : [];

		if (!calledTools.length) {
			finalSummary = String(message.content ?? "").trim().slice(0, 400);
			finished = true;
			break;
		}

		for (const call of calledTools) {
			const name = call?.function?.name;
			if (toolCalls >= MAX_TOOL_CALLS) {
				transcript.push({ role: "tool", tool_call_id: call.id, content: "Error: the tool budget is exhausted. Answer in plain text now." });
				continue;
			}
			toolCalls += 1;
			if (typeof name === "string" && tools.size < 32) tools.add(name);
			let payload;
			let ok = true;
			try {
				const args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
				payload = await callTool(name, args);
			} catch (error) {
				ok = false;
				payload = `Error: ${error instanceof Error ? error.message : "tool failed"}`;
			}
			await emit({ type: "tool.call", payload: { tool: String(name).slice(0, 80), ok, bytes: payload.length } });
			transcript.push({ role: "tool", tool_call_id: call.id, content: clip(payload) });
		}
	}
} catch (error) {
	classification = typeof error?.classification === "string" ? error.classification : "agent-run-failed";
}

// Apply staged writes even when a budget ended the loop early: a real partial
// change beats a silent discard, and CI remains the correctness authority.
const writes = [];
if (!classification || classification.endsWith("-budget-exhausted")) {
	try {
		for (const [rel, content] of stagedWrites) {
			const { absolute } = safePath(rel);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, content, "utf8");
			writes.push(rel);
		}
	} catch {
		classification = "agent-apply-failed";
	}
}
if (!classification && writes.length === 0) classification = "agent-made-no-change";
if (classification?.endsWith("-budget-exhausted") && writes.length > 0) classification = null;

const ok = !classification;
await emit({
	ok,
	model: request.model,
	responseIds: [...responseIds],
	tools: [...tools],
	toolCalls,
	writes,
	summary: finalSummary || undefined,
	classification: ok ? undefined : classification,
});
process.exitCode = ok ? 0 : 1;
