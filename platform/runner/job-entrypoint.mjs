import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

/**
 * The platform run job (ported from native-git-runner's job entrypoint with
 * ALL stack machinery removed): clone latest main, create the plain
 * room/<intentSeq>/<attempt> branch, run the bounded coding agent over the
 * intent's verbatim evidence, run the local test gate, commit with requester
 * attribution trailers, push, open a plain PR against main, and report
 * {branch, prNumber, headSha} to the platform by push. The PLATFORM owns
 * everything after that: CI verdicts, the exact-SHA squash merge, the
 * observed deploy.
 */

// The first instruction of the process: everything before the clone (module
// load, request read, validation) is charged to bootMs.
const processStartedAt = Date.now();

// Boot heartbeat: written before ANY other work — the first observable line of
// this process. startRun polls for this file; its absence means the job died
// before its first line, which becomes an immediate classified refusal.
const bootRequestPath = process.argv[2];
if (typeof bootRequestPath === "string" && bootRequestPath.startsWith("/tmp/")) {
	try { writeFileSync(`${bootRequestPath}.boot`, new Date().toISOString()); } catch { /* startRun classifies the missing marker */ }
}

const SHA = /^[0-9a-f]{40}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const ROOM_BRANCH = /^room\/\d{1,12}\/[a-f0-9]{4,32}$/u;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

// Every step budget in milliseconds. Any single step can block forever — a
// network fetch, a git push against an unreachable remote, or a stalled model
// call — so no step is ever awaited without one of these.
const CLONE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;
const AGENT_TIMEOUT_MS = 260_000;
// The product's own test file is dependency-free (plain node, relative
// imports only), so it runs in the checkout without npm ci: the cheapest
// honest local gate before anything is pushed. CI remains the merge authority.
const LOCAL_TEST_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 60_000;
const CALLBACK_TIMEOUT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const RUN_DEADLINE_MS = 300_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const MAX_TAIL_CHARS = 16_000;
const MAX_ANNOTATION_PROMPT_CHARS = 48_000;

// Writes to a pipe are asynchronous: resolving on the write callback is what
// makes the artifact real, so every emit MUST be awaited before any exit.
function emit(value) {
	return new Promise((resolve) => {
		process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve());
	});
}

async function readRequest() {
	const path = process.argv[2];
	if (typeof path !== "string" || !path.startsWith("/tmp/")) throw new Error("request-path-invalid");
	const { readFile } = await import("node:fs/promises");
	const input = await readFile(path, "utf8");
	if (input.length > 512_000) throw new Error("request-too-large");
	return JSON.parse(input);
}

function safeCallback(value) {
	if (!value || typeof value !== "object") return null;
	if (typeof value.url !== "string" || !value.url.startsWith("https://")) return null;
	if (typeof value.runId !== "string" || !IDENTIFIER.test(value.runId)) return null;
	if (typeof value.attemptId !== "string" || !IDENTIFIER.test(value.attemptId)) return null;
	return { url: value.url, runId: value.runId, attemptId: value.attemptId };
}

function safeRequest(input) {
	if (!input || typeof input !== "object") return null;
	const { repository, runId, attemptId, intentId, branch, evidence, feedUrl, model, mode, checkoutDirectory } = input;
	if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) return null;
	if (typeof runId !== "string" || !IDENTIFIER.test(runId) || typeof attemptId !== "string" || !IDENTIFIER.test(attemptId)) return null;
	if (typeof intentId !== "string" || !IDENTIFIER.test(intentId)) return null;
	if (typeof branch !== "string" || !ROOM_BRANCH.test(branch)) return null;
	if (typeof model !== "string" || !MODEL.test(model)) return null;
	if (typeof checkoutDirectory !== "string" || !checkoutDirectory.startsWith("/workspace/")) return null;
	if (typeof feedUrl !== "string" || !feedUrl.startsWith("https://")) return null;
	// requestText MUST be non-empty: a builder with an anchor and no
	// instructions invents a plausible change and ships it green. The platform
	// refuses these at dispatch; this is the defense-in-depth backstop.
	if (!evidence || typeof evidence !== "object" || typeof evidence.requestText !== "string" || !evidence.requestText.trim().length || typeof evidence.requestedBy !== "string" || !AUTHOR.test(evidence.requestedBy) || !Array.isArray(evidence.annotations)) return null;
	const callback = safeCallback(input.callback);
	if (!callback) return null;
	// Fast is a USER choice; an unrecognised or absent mode takes the standard
	// (full-quality) budget. The job never guesses cheap.
	return { repository, runId, attemptId, intentId, branch, evidence, feedUrl, model, mode: mode === "fast" ? "fast" : "standard", checkoutDirectory, callback };
}

/**
 * Per-mode agent budgets, mirroring platform/contracts/mode.js. Standard is
 * the system's best and the default. Fast is the requester's EXPLICIT
 * per-request speed trade: lower reasoning effort, a tighter tool ceiling,
 * no repository tree in the prompt (the annotation's data-loc anchor already
 * names the file), and a self-review that checks but does not iterate.
 * Nothing here relaxes the local gate, CI, or the write firewall.
 */
const MODE_BUDGETS = {
	standard: { effort: "medium", maxToolCalls: 12, includeTree: true, selfReview: "iterate" },
	fast: { effort: "low", maxToolCalls: 8, includeTree: false, selfReview: "check" },
};

/** Per-phase wall clock, reported on the terminal callback as a run-timing fact. */
const timings = {};
async function timed(phase, work) {
	const started = Date.now();
	try { return await work(); } finally { timings[phase] = Date.now() - started; }
}

// Every step transition is appended here and rides along on the terminal
// callback, so a failed run reports exactly how far it got.
const progress = [];
function appendProgress(step) {
	progress.push({ step, at: Date.now() });
}

// Every live child is tracked so the run deadline can SIGKILL all of them. A
// surviving grandchild holds the sandbox process entry open and is exactly
// what keeps a run non-terminal after this process has given up.
const liveChildren = new Set();

function killAllChildren() {
	for (const child of liveChildren) {
		try { child.kill("SIGKILL"); } catch { /* already gone */ }
	}
	liveChildren.clear();
}

function run(command, args, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
		liveChildren.add(child);
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timeout;
		let kill;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (kill) clearTimeout(kill);
			resolve(result);
		};
		child.once("close", () => liveChildren.delete(child));
		if (options.timeoutMs) {
			timeout = setTimeout(() => {
				child.kill("SIGTERM");
				kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
				finish({ success: false, exitCode: 124, stdout, stderr: "step-timeout" });
			}, options.timeoutMs);
		}
		// Bounded TAILS, not heads: for a chatty child the last lines carry the
		// summary and the failure, so the tail is the only part worth keeping.
		child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_TAIL_CHARS); });
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_TAIL_CHARS); });
		child.stdout.on("error", () => {});
		child.stderr.on("error", () => {});
		child.stdin.on("error", () => {});
		child.once("error", (error) => finish({ success: false, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` }));
		child.once("close", (code) => finish({ success: code === 0, exitCode: code ?? 1, stdout, stderr }));
		if (options.input) child.stdin.end(options.input); else child.stdin.end();
	});
}

function classifyGitTransportFailure(stderr) {
	if (stderr === "step-timeout") return "git-step-timeout";
	if (/could not resolve host|name or service not known|failed to connect|connection timed out/iu.test(stderr)) return "github-unreachable";
	if (/http (?:401|403|404)\b|authentication failed|could not read username/iu.test(stderr)) return "github-authorization-rejected";
	if (/http 5\d\d\b|service unavailable/iu.test(stderr)) return "github-upstream-unavailable";
	return "git-transport-failed";
}

// The last parseable JSONL line with a boolean "ok" is the agent summary.
function parseAgentSummary(stdout) {
	const lines = typeof stdout === "string" ? stdout.trim().split("\n") : [];
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return parsed;
		} catch { /* keep scanning */ }
	}
	return null;
}

// Report to the platform by push: the runId is the bearer credential, the
// attemptId is the zombie guard. Failure here is non-fatal — the artifact was
// already emitted, and the run TTL is the platform-side backstop.
let terminalCallback = null;

async function postCallback(result) {
	if (!terminalCallback) return;
	try {
		await fetch(terminalCallback.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ runId: terminalCallback.runId, attemptId: terminalCallback.attemptId, ...result, progress: undefined, steps: progress }),
			signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
		});
	} catch { /* best effort by design */ }
}

// Small live-state heartbeats at each major step, recorded by the platform as
// durable run-heartbeat ledger facts. Fire-and-forget by design: a slow
// platform must never spend the run budget.
function postHeartbeat(step) {
	appendProgress(step);
	if (!terminalCallback) return;
	fetch(terminalCallback.url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ runId: terminalCallback.runId, attemptId: terminalCallback.attemptId, progress: true, step }),
		signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
	}).catch(() => { /* best effort by design */ });
}

function failure(reason, extra = {}) {
	return { state: "failed", reason, ...extra };
}

function stderrTail(result) {
	const tail = typeof result?.stderr === "string" ? result.stderr.trim().slice(-400) : "";
	return tail ? { stderrTail: tail } : {};
}

/**
 * The agent's prompt: the restated request plus every annotation payload
 * VERBATIM. The anchors (data-loc refs, captured DOM, computed styles,
 * drawing points) are CONTEXT identifying what the requester pointed at —
 * never scope authority (task #14/#15).
 */
function buildAgentPrompt(evidence) {
	const annotations = JSON.stringify(evidence.annotations, null, 1);
	return [
		`${evidence.requestedBy} requested this change in the live room. These are their exact words, and they are the specification for this task:`,
		"",
		"----- BEGIN REQUEST -----",
		evidence.requestText,
		"----- END REQUEST -----",
		"",
		"Do exactly what the request says. If it names a specific wording, element, or property, change that one — do not substitute your own idea of an improvement, and do not delete something you were asked to modify. If the request is ambiguous, choose the reading that changes the least.",
		"",
		"The following annotation payloads were captured verbatim from the live app when the requester marked it. They are CONTEXT that identifies exactly what was pointed at — the structural refs (a data-loc source ref when the app stamps its source, otherwise a DOM selector), the captured DOM subtree, computed styles, and any drawing points. They tell you WHERE; the request above tells you WHAT. They are NOT a restriction on which files you may change.",
		"",
		annotations.length > MAX_ANNOTATION_PROMPT_CHARS ? `${annotations.slice(0, MAX_ANNOTATION_PROMPT_CHARS)}\n[annotation payloads truncated]` : annotations,
	].join("\n");
}

function buildAgentInstructions(request) {
	return [
		"You are the coding agent for a live collaborative room, working on a fresh isolated checkout of the repository.",
		"You operate through exactly three tools: read_file, write_file, and list_dir. You have no shell, no network, no package manager, and no Git.",
		"Inspect the relevant parts of the checked-out repository and every applicable AGENTS.md before changing anything.",
		"The product surface is product/ — the live room UI Worker (product/src, its ui/ sources, and product/test). Annotation data-loc refs like product/src/ui/room.html:41 point at exact source lines there. You may ONLY change product code: writes to platform/, infra/, .github/, apps/ (the legacy demo), dependency manifests, lockfiles, or wrangler configs are blocked here and would fail the platform firewall anyway.",
		"Match the app's existing visual language: before styling anything, study the annotation's captured DOM and computed styles and the surrounding source, then reuse the stylesheet's existing CSS custom properties, classes, and spacing patterns. Do not bolt on inline style attributes or bare unstyled native controls when the app has a design system to extend.",
		"Complete the request's evident intent, not just its literal minimum: a UI change should come back polished enough that a designer would accept it — sensible states, spacing, and consistency with neighbouring elements — while never expanding beyond what was actually asked.",
		"write_file replaces the whole file, so reproduce every part you are not changing exactly as it is. Never strip comments, collapse multi-line code or CSS, or reformat sections you were not asked to touch: collateral churn gets the change rejected in review.",
		"Make the smallest coherent repository change that actually satisfies the request, including tests when appropriate.",
		"Preserve user data and unrelated work. Never read, print, copy, commit, or expose credentials. Refuse illegal, harmful, offensive, intentionally availability-destroying, or externally unsupported work.",
		"Do not claim to have run tests, builds, or commands: you cannot. The execution harness commits your staged writes, runs the local test gate, pushes, and opens the pull request; CI is the merge authority.",
		`The repository is ${request.repository}. The harness owns the branch (${request.branch}) and all Git mechanics; never emulate branches, commits, or pull requests in file content.`,
		"When the change is complete, answer in plain text with one or two sentences describing what changed.",
	].join(" ");
}

/** A slug good enough for a noreply co-author address; display names are already bounded. */
function coAuthorSlug(name) {
	return name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "") || "room-requester";
}

/** Titles are one plain line: no newlines, no control characters, no Markdown or option injection. */
const TITLE_MAX_CHARS = 70;

/**
 * A short, human-readable summary of what was requested, derived from the
 * requester's own words. The intent id belongs in the PR body, not the
 * title: a wall of `Live-room change intent-<uuid>` tells a reviewer
 * nothing about what actually changed.
 *
 * Sanitization is deliberate rather than cosmetic. This text is user-authored
 * and flows into `git commit -m` and `gh pr create --title`, so control
 * characters collapse to spaces (a title is one line), Markdown and comment
 * lead-ins are stripped (they would render as headings or vanish), and a
 * leading dash is removed so the value can never be read as a CLI option.
 */
function summarizeRequest(text) {
	// Control characters (CR, LF, TAB and friends) collapse to spaces FIRST, so
	// a multi-line request cannot smuggle a second line into a one-line title.
	const firstLine = String(text ?? "")
		.replaceAll(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
		.replaceAll(/\s+/gu, " ")
		.trim()
		// Strip Markdown/comment lead-ins and any leading dash (option injection).
		// Whole HTML comments go first, contents included: stripping only the
		// `<!--` opener would promote the comment body into the title.
		.replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, " ")
		.replaceAll(/\s+/gu, " ")
		.trim()
		// Strip Markdown lead-ins and any leading dash (CLI option injection).
		.replace(/^[#>*_`~+-]+\s*/u, "")
		.trim();
	if (!firstLine.length) return null;
	if (firstLine.length <= TITLE_MAX_CHARS) return firstLine;
	// Truncate on a word boundary when there is a reasonable one.
	const clipped = firstLine.slice(0, TITLE_MAX_CHARS - 1);
	const lastSpace = clipped.lastIndexOf(" ");
	return `${(lastSpace > TITLE_MAX_CHARS * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * The one title used for BOTH the commit subject and the PR title, so the
 * squashed history and the pull request never disagree. The platform refuses
 * to dispatch a run with no request text, so the fallback here is a backstop
 * that should be unreachable in practice.
 */
function changeTitle(request) {
	const title = summarizeRequest(request.evidence.requestText) ?? `Live-room change ${request.intentId}`;
	// Honesty rule: a fast pass names itself in the title (and therefore the
	// squashed commit subject), so nobody mistakes it for the system's best.
	return request.mode === "fast" ? `${title} (fast pass)` : title;
}

function commitMessage(request) {
	return [
		changeTitle(request),
		"",
		`Requested live in the room by ${request.evidence.requestedBy}.`,
		`Intent: ${request.intentId}`,
		"",
		`Co-authored-by: ${request.evidence.requestedBy} <${coAuthorSlug(request.evidence.requestedBy)}@users.noreply.github.com>`,
		`Requested-by: ${request.evidence.requestedBy} (${request.feedUrl})`,
	].join("\n");
}

/**
 * The PR body carries everything the title no longer does: the verbatim
 * request, the requester attribution, the intent id, and the feed link. The
 * request is quoted as a blockquote so it is unambiguously the requester's
 * words rather than the agent's, and it is bounded.
 */
function pullRequestBody(request, agentSummary) {
	const quoted = String(request.evidence.requestText ?? "")
		.slice(0, 1_000)
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return [
		`Requested live in the room by **${request.evidence.requestedBy}**:`,
		"",
		quoted.trim() ? quoted : "> (carried entirely by the annotation payload)",
		"",
		agentSummary ? `Agent summary: ${String(agentSummary).slice(0, 400)}` : "Agent summary unavailable.",
		"",
		...(request.mode === "fast"
			? ["**Fast pass.** Built at the requester's explicit fast setting: lower reasoning effort and a tighter budget, traded for speed. A follow-up request at standard mode gets the system's best.", ""]
			: []),
		`Intent: \`${request.intentId}\``,
		`Feed: ${request.feedUrl}`,
		"",
		"The platform merges this PR at its exact verified head SHA once CI is green; do not merge by hand.",
	].join("\n");
}

async function main() {
	appendProgress("booted");
	const request = safeRequest(await readRequest());
	if (!request) throw new Error("input-invalid");
	terminalCallback = request.callback;
	appendProgress("request-validated");
	// Everything up to here is process boot: module load, request read, validate.
	timings.bootMs = Date.now() - processStartedAt;

	// Always from LATEST main: the singleton pipeline previews every change
	// against the actual composed state.
	// A shallow single-branch clone: this pipeline only ever builds from the tip
	// of main, so the full history is bytes on the critical path for nothing.
	const clone = await timed("cloneMs", () => run("git", ["clone", "--depth", "1", "--single-branch", "--branch", "main", `https://github.com/${request.repository}.git`, request.checkoutDirectory], { timeoutMs: CLONE_TIMEOUT_MS }));
	if (!clone.success) return failure(classifyGitTransportFailure(clone.stderr), stderrTail(clone));
	const base = await run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
	const baseSha = base.stdout.trim();
	if (!base.success || !SHA.test(baseSha)) return failure("checkout-head-unavailable");
	postHeartbeat("cloned");

	const branched = await run("git", ["-C", request.checkoutDirectory, "checkout", "-b", request.branch], { timeoutMs: GIT_TIMEOUT_MS });
	if (!branched.success) return failure("branch-create-failed", stderrTail(branched));

	postHeartbeat("agent-started");
	const budgets = MODE_BUDGETS[request.mode] ?? MODE_BUDGETS.standard;
	const agentInput = JSON.stringify({
		prompt: buildAgentPrompt(request.evidence),
		instructions: buildAgentInstructions(request),
		cwd: request.checkoutDirectory,
		model: request.model,
		effort: budgets.effort,
		maxToolCalls: budgets.maxToolCalls,
		includeTree: budgets.includeTree,
		selfReview: budgets.selfReview,
	});
	const agentExecution = await timed("agentMs", () => run("node", ["/opt/app-harness/agent-entrypoint.mjs"], { cwd: request.checkoutDirectory, input: agentInput, timeoutMs: AGENT_TIMEOUT_MS }));
	const agent = parseAgentSummary(agentExecution.stdout);
	postHeartbeat("agent-done");
	if (!agentExecution.success || !agent?.ok) {
		return failure(typeof agent?.classification === "string" ? agent.classification : agentExecution.exitCode === 124 ? "agent-step-timeout" : "agent-output-invalid", stderrTail(agentExecution));
	}

	// The agent stages file contents only; this entrypoint owns Git. The
	// commit needs an explicit identity — no global Git config exists in the
	// container image.
	const identityEmail = await run("git", ["-C", request.checkoutDirectory, "config", "user.email", "app-harness-platform[bot]@users.noreply.github.com"], { timeoutMs: GIT_TIMEOUT_MS });
	const identityName = await run("git", ["-C", request.checkoutDirectory, "config", "user.name", "App Harness Platform"], { timeoutMs: GIT_TIMEOUT_MS });
	if (!identityEmail.success || !identityName.success) return failure("commit-identity-failed");
	const staged = await run("git", ["-C", request.checkoutDirectory, "add", "-A"], { timeoutMs: GIT_TIMEOUT_MS });
	if (!staged.success) return failure("stage-failed");
	const committed = await run("git", ["-C", request.checkoutDirectory, "commit", "-m", commitMessage(request)], { timeoutMs: GIT_TIMEOUT_MS });
	if (!committed.success) return failure("commit-failed", stderrTail(committed));
	postHeartbeat("committed");

	const status = await run("git", ["-C", request.checkoutDirectory, "status", "--porcelain"], { timeoutMs: GIT_TIMEOUT_MS });
	const head = await run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
	const headSha = head.stdout.trim().toLowerCase();
	if (!status.success || status.stdout.trim()) return failure("working-tree-dirty");
	if (!head.success || !SHA.test(headSha) || headSha === baseSha.toLowerCase()) return failure("no-change-produced");

	// Local fast-fail gate BEFORE anything is pushed: the product's own test
	// file is the cheapest honest signal a candidate is broken.
	postHeartbeat("local-tests");
	const localTests = await timed("testMs", () => run("node", ["product/test/ui-contract.test.mjs"], { cwd: request.checkoutDirectory, timeoutMs: LOCAL_TEST_TIMEOUT_MS }));
	if (!localTests.success) return failure(localTests.stderr === "step-timeout" ? "local-tests-timeout" : "local-tests-failed", stderrTail(localTests));
	postHeartbeat("local-tests-passed");

	const pushed = await timed("pushMs", () => run("git", ["-C", request.checkoutDirectory, "push", "origin", `${request.branch}:${request.branch}`], { timeoutMs: GIT_TIMEOUT_MS }));
	if (!pushed.success) return failure(classifyGitTransportFailure(pushed.stderr), stderrTail(pushed));
	postHeartbeat("pushed");

	// Plain PR against main — no stacks, and no merge automation armed here:
	// the PLATFORM merges at the exact verified head SHA once CI is green.
	// The SAME title as the commit subject: the squashed history and the pull
	// request must never describe the change differently.
	const created = await timed("prMs", () => run("gh", ["pr", "create", "--base", "main", "--head", request.branch, "--title", changeTitle(request), "--body", pullRequestBody(request, agent.summary)], { cwd: request.checkoutDirectory, timeoutMs: GH_TIMEOUT_MS }));
	if (!created.success) return failure("pull-request-create-failed", stderrTail(created));
	const urlMatch = created.stdout.match(/\/pull\/(\d{1,9})\s*$/u) ?? created.stdout.match(/\/pull\/(\d{1,9})/u);
	let prNumber = urlMatch ? Number.parseInt(urlMatch[1], 10) : null;
	if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
		// Fallback: ask gh for the PR bound to this branch.
		const viewed = await run("gh", ["pr", "view", request.branch, "--json", "number", "--jq", ".number"], { cwd: request.checkoutDirectory, timeoutMs: GH_TIMEOUT_MS });
		prNumber = viewed.success ? Number.parseInt(viewed.stdout.trim(), 10) : null;
		if (!Number.isSafeInteger(prNumber) || prNumber < 1) return failure("pull-request-number-unresolved");
	}
	postHeartbeat("pr-opened");

	return { state: "verifying", branch: request.branch, prNumber, headSha, mode: request.mode, effort: (MODE_BUDGETS[request.mode] ?? MODE_BUDGETS.standard).effort, timings: { ...timings, totalMs: Date.now() - processStartedAt } };
}

// A wedged child process must never exceed the run budget silently: emit a
// truthful terminal artifact, push it to the platform, and exit before the
// platform's process timeout. Ref'd interval on purpose: an unref'd timer can
// be starved outright, which is how earlier runners wedged forever.
const startedAt = Date.now();
const watchdog = setInterval(async () => {
	if (Date.now() - startedAt < RUN_DEADLINE_MS) return;
	clearInterval(watchdog);
	killAllChildren();
	const deadline = { state: "failed", reason: "run-deadline-exceeded" };
	await Promise.race([
		emit(deadline).then(() => postCallback(deadline)),
		new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + CALLBACK_TIMEOUT_MS)),
	]);
	process.exit(1);
}, WATCHDOG_INTERVAL_MS);

try {
	const result = await main();
	// Clear before emitting so the watchdog can never race a completed run and
	// append a second, contradictory artifact.
	clearInterval(watchdog);
	killAllChildren();
	await emit(result);
	await postCallback(result);
	process.exitCode = result.state === "failed" ? 1 : 0;
} catch (error) {
	clearInterval(watchdog);
	killAllChildren();
	const wreck = { state: "failed", reason: error instanceof Error && /^[a-z0-9-]{1,80}$/u.test(error.message) ? error.message : "runner-entrypoint-failed" };
	await emit(wreck);
	await postCallback(wreck);
	process.exitCode = 1;
}
