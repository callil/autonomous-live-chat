import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,120}$/u;
// The one coding model this runner drives through the OpenAI Responses API.
// Kept in lockstep with DEFAULT_AGENT_MODEL in src/index.ts (the dispatch's
// model field, from the runner Worker's AGENT_MODEL var, wins at runtime).
const AGENT_MODEL = "gpt-5.6-sol";

// Budgets. The agent wall clock matches the previous runner generation: 240s,
// inside the job entrypoint's 260s step budget, inside the 300s run deadline.
// A single model request that produces nothing for 120s is stalled, not slow —
// the direct-API analogue of the old JSONL inactivity watchdog.
const AGENT_WALL_CLOCK_MS = 240_000;
const MODEL_REQUEST_TIMEOUT_MS = Number(process.env.AGENT_REQUEST_TIMEOUT_MS_OVERRIDE) || 120_000;
// The bounded loop: at most this many tool executions, and a few extra model
// turns so the final no-tool answer after the last call is still reachable.
// The dispatch's per-tier budget narrows this; it can never widen it.
const MAX_TOOL_CALLS_CEILING = Number(process.env.AGENT_MAX_TOOL_CALLS_OVERRIDE) || 12;
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

// The platform firewall's frozen surfaces, enforced at WRITE time in code so
// a doomed diff dies here instead of at CI: agent branches (room/*) may only
// change product code. Reads stay allowed — context is not authority.
const WRITE_DENIED_PATHS = [
	/^platform\//u,
	/^infra\//u,
	/^apps\//u,
	/^\.github\//u,
	/(^|\/)package\.json$/u,
	/(^|\/)package-lock\.json$/u,
	/(^|\/)npm-shrinkwrap\.json$/u,
	/(^|\/)yarn\.lock$/u,
	/(^|\/)pnpm-lock\.yaml$/u,
	/(^|\/)bun\.lockb$/u,
	/(^|\/)wrangler\.(jsonc?|toml)$/u,
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
// Decode as a UTF-8 stream: without setEncoding each chunk is a Buffer that
// is coerced independently, so a multibyte character split across a chunk
// boundary silently becomes U+FFFD inside the agent's evidence.
process.stdin.setEncoding("utf8");
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

// Per-tier budgets from the dispatch. Each one may only TIGHTEN the ceiling:
// a malformed or oversized request can never buy itself a bigger budget.
const EFFORT = request.effort === "low" ? "low" : "medium";
const MAX_TOOL_CALLS = Number.isSafeInteger(request.maxToolCalls)
	? Math.max(1, Math.min(request.maxToolCalls, MAX_TOOL_CALLS_CEILING))
	: MAX_TOOL_CALLS_CEILING;
const MAX_MODEL_CALLS = MAX_TOOL_CALLS + 6;
// The final self-review: "iterate" may spend remaining tool budget fixing
// gaps it finds; "check" (the fast mode) is a text-only verification. Both
// draw on the SAME tool/wall-clock ceilings — the self-review can never buy
// budget the main loop did not already have.
const SELF_REVIEW = request.selfReview === "check" ? "check" : "iterate";
// Smalls skip the repository tree: the annotation's data-loc anchor already
// names the file, so the tree is prompt weight that buys nothing.
const INCLUDE_TREE = request.includeTree !== false;

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
		name: "read_file",
		strict: true,
		description: "Read a UTF-8 text file inside the repository checkout. Paths are relative to the repository root. Staged writes from earlier write_file calls are visible.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Repository-relative file path." } },
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		type: "function",
		name: "write_file",
		strict: true,
		description: "Stage the complete new contents of one file inside the repository checkout, creating it if needed. Supply the entire file, not a diff. Read the current file first unless you are creating it. Reproduce every part you are not changing exactly as it is — never strip comments or reformat untouched code. Staged writes are applied together when you finish.",
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
	{
		type: "function",
		name: "list_dir",
		strict: true,
		description: "List the entries of a directory inside the repository checkout. Use \".\" for the repository root. Directories end with \"/\".",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Repository-relative directory path." } },
			required: ["path"],
			additionalProperties: false,
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
		for (const pattern of WRITE_DENIED_PATHS) if (pattern.test(rel)) throw new Error("that path is a frozen platform surface; only product code may change");
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
		response = await fetch(`${API_BASE}/responses`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Math.min(MODEL_REQUEST_TIMEOUT_MS, remaining - 1_000)),
		});
	} catch {
		throw classified("transport", "agent-model-unreachable", true);
	}
	if (response.status === 429 || response.status >= 500) {
		// A 429 for an exhausted balance is not transient overload: OpenAI marks
		// it with error.type/code "insufficient_quota", and no retry can succeed
		// until the balance is restored. Classify it distinctly, non-retryable,
		// so the ledger can record the outage and pause the room.
		if (response.status === 429 && (await response.text().catch(() => "")).includes("insufficient_quota")) {
			throw classified("credits", "agent-credits-exhausted");
		}
		throw classified("upstream", "agent-model-unavailable", true);
	}
	if (!response.ok) {
		// The provider's own words are the diagnosis (dead model vs gated org
		// vs bad shape); put a bounded slice on the transcript stream.
		const detail = (await response.text().catch(() => "")).slice(0, 400);
		await emit({ type: "model.call.rejected", payload: { status: response.status, detail } });
		throw classified(`rejected: ${response.status} ${detail.slice(0, 160)}`, "agent-model-rejected");
	}
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
	INCLUDE_TREE
		? "Explore with list_dir and read_file before editing. write_file stages a whole replacement file, so read a file before rewriting it."
		: "Go straight to the file the annotation's data-loc ref names: read it, then write it. write_file stages a whole replacement file, so read a file before rewriting it. Do not survey the repository — list_dir is available if the anchor turns out to be wrong, not as a first step.",
	"Never read, print, copy, or reproduce credentials, tokens, or private keys. Paths containing them are blocked and you must not attempt to reach them.",
	`You have a hard budget of ${MAX_TOOL_CALLS} tool calls. Make the smallest coherent change that FULLY satisfies the request — its evident intent, in the app's existing design language, with no collateral churn — then answer in plain text (no tool call) with one or two sentences describing what changed.`,
].join("\n");

// The tree is only walked when it will actually ride the prompt: for a fast
// pass it is neither computed nor sent.
const tree = INCLUDE_TREE ? await boundedTree() : null;
const transcript = [
	{
		role: "user",
		content: tree === null
			? `${request.prompt}\n\nThis is a fast pass the requester explicitly asked for: a tightly-scoped change on a lean budget. The annotation's data-loc ref above names the exact source file and line: read that file first and edit it directly. Do not survey the repository.`
			: `${request.prompt}\n\nRepository tree (bounded to ${MAX_TREE_ENTRIES} entries, depth ${MAX_TREE_DEPTH}):\n${tree}`,
	},
];
let toolCalls = 0;
let modelCalls = 0;
let classification = null;
let finalSummary = "";
let selfCheck = "skipped";

/**
 * One bounded drive of the model loop: model turns executing tool calls until
 * the model answers in plain text (returned), or a budget ends the phase
 * (returns null and sets the classification). `allowTools: false` makes it a
 * single text-only turn — used by the fast mode's self-CHECK.
 */
async function drive(options = {}) {
	while (true) {
		if (modelCalls >= MAX_MODEL_CALLS) { classification = "agent-model-budget-exhausted"; return null; }
		if (Date.now() >= deadline - 5_000) { classification = "agent-budget-exhausted"; return null; }
		modelCalls += 1;

		const result = await callModelWithRetry({
			model: request.model,
			instructions: system,
			input: transcript,
			tools: TOOL_SCHEMA,
			tool_choice: options.allowTools === false ? "none" : "auto",
			parallel_tool_calls: false,
			store: false,
			// Per the API docs: with store:false, reasoning items ride the
			// transcript as encrypted content and MUST be replayed between tool
			// calls, or the model loses its chain of thought.
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: EFFORT },
			max_output_tokens: 25_000,
		});

		if (typeof result?.id === "string" && responseIds.size < 12) responseIds.add(result.id.slice(0, 120));
		await emit({ type: "model.call.completed", payload: { response_id: typeof result?.id === "string" ? result.id.slice(0, 120) : "unknown" } });

		const output = Array.isArray(result?.output) ? result.output : [];
		if (!output.length) throw classified("decode", "agent-model-rejected");
		// Replay every output item verbatim - reasoning items included - so call
		// ids stay paired with their outputs and the chain of thought survives.
		for (const item of output) transcript.push(item);
		const calledTools = output.filter((item) => item?.type === "function_call");

		if (!calledTools.length) {
			return output
				.filter((item) => item?.type === "message" && Array.isArray(item.content))
				.flatMap((item) => item.content.filter((part) => part?.type === "output_text").map((part) => String(part.text ?? "")))
				.join(" ")
				.trim()
				.slice(0, 400);
		}

		for (const call of calledTools) {
			if (toolCalls >= MAX_TOOL_CALLS) {
				transcript.push({ type: "function_call_output", call_id: call.call_id, output: "Error: the tool budget is exhausted. Answer in plain text now." });
				continue;
			}
			toolCalls += 1;
			if (typeof call.name === "string" && tools.size < 32) tools.add(call.name);
			let payload;
			let ok = true;
			try {
				const args = call.arguments ? JSON.parse(call.arguments) : {};
				payload = await callTool(call.name, args);
			} catch (error) {
				ok = false;
				payload = `Error: ${error instanceof Error ? error.message : "tool failed"}`;
			}
			await emit({ type: "tool.call", payload: { tool: String(call.name).slice(0, 80), ok, bytes: payload.length } });
			transcript.push({ type: "function_call_output", call_id: call.call_id, output: clip(payload) });
		}
	}
}

let answer = null;
try {
	answer = await drive();
	if (answer !== null) finalSummary = answer;
} catch (error) {
	classification = typeof error?.classification === "string" ? error.classification : "agent-run-failed";
}

// THE SELF-CHECK GATE. The first-pass failure signatures on the record are
// (1) literal-minimum results that ignore the request's evident intent,
// (2) one-off inline styles that ignore the app's design language, and
// (3) collateral churn from whole-file rewrites (stripped comments,
// collapsed formatting). Before anything is committed, the agent re-reads
// the request and audits its own staged diff against exactly those three.
// Standard mode may spend REMAINING budget fixing what it finds (one
// bounded iteration); fast mode verifies in text only. A budget ending
// the self-check never discards the staged work — the epilogue below
// applies staged writes on budget exhaustion by design. Isolated failure
// domain: an error INSIDE the self-check never discards finished work.
if (answer !== null && !classification && stagedWrites.size > 0) {
	try {
		const stagedBefore = new Map(stagedWrites);
		const iterate = SELF_REVIEW === "iterate" && toolCalls < MAX_TOOL_CALLS && Date.now() < deadline - 20_000;
		transcript.push({
			role: "user",
			content: [
				"Self-check before your work is committed. Re-read the verbatim request at the top and audit every staged file against it:",
				"1. Is the request satisfied in full — the literal ask AND its evident intent (a designer would accept the result)?",
				"2. Do styling changes reuse the app's existing CSS custom properties, classes, and patterns rather than one-off inline styles?",
				"3. Does every staged file preserve all code, comments, and formatting you were not asked to change?",
				iterate
					? "If anything falls short, fix it now with write_file, then answer in plain text. If everything holds, answer exactly: SELF-CHECK PASS — followed by your one-or-two-sentence summary of what changed."
					: "Answer in plain text only (no tool calls). If everything holds, answer exactly: SELF-CHECK PASS — followed by your one-or-two-sentence summary of what changed. If something falls short, answer: SELF-CHECK GAP — and name it in one sentence.",
			].join("\n"),
		});
		const review = await drive({ allowTools: iterate });
		if (review === null) {
			selfCheck = "budget-exhausted";
			// A budget spent on self-review must not fail work that was already
			// complete; the epilogue treats it exactly like any budget end.
		} else {
			finalSummary = review || finalSummary;
			const revised = stagedWrites.size !== stagedBefore.size || [...stagedWrites].some(([rel, content]) => stagedBefore.get(rel) !== content);
			if (review.includes("SELF-CHECK PASS")) selfCheck = revised ? "revised" : "pass";
			else selfCheck = revised ? "revised" : "flagged";
		}
	} catch {
		selfCheck = "error";
	}
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
