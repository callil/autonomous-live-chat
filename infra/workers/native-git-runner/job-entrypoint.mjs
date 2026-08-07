import { spawn } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/iu;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

// Writes to a pipe are asynchronous: process.stdout.write only queues the
// bytes. The previous fire-and-forget version was followed immediately by
// process.exit, which destroyed the buffered artifact before the kernel ever
// saw it — the run then looked wedged because no terminal artifact was ever
// observable. Resolving on the write callback is what makes the artifact real,
// so every emit MUST be awaited before any exit.
function emit(value) {
	return new Promise((resolve) => {
		process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve());
	});
}

async function readRequest() {
	// The request file path arrives as an argument so this process never
	// depends on shell stdin redirection, which would hang forever if the
	// sandbox spawned the command without a shell.
	const path = process.argv[2];
	if (typeof path === "string" && path.startsWith("/tmp/")) {
		const { readFile } = await import("node:fs/promises");
		const input = await readFile(path, "utf8");
		if (input.length > 128_000) throw new Error("request-too-large");
		return JSON.parse(input);
	}
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (input.length > 128_000) throw new Error("request-too-large");
	}
	return JSON.parse(input);
}

function safeBranch(value) {
	return typeof value === "string" && BRANCH.test(value) && !value.includes("..") && !value.startsWith("-") && !value.endsWith("/") ? value : null;
}

// The callback is best-effort transport, never a gate: an invalid shape is
// dropped so a misconfigured worker cannot fail an otherwise good run.
function safeCallback(value) {
	if (!value || typeof value !== "object") return null;
	if (typeof value.url !== "string" || !value.url.startsWith("https://")) return null;
	if (typeof value.workItemId !== "string" || !EVENT_ID.test(value.workItemId)) return null;
	if (typeof value.runId !== "string" || !EVENT_ID.test(value.runId)) return null;
	return { url: value.url, workItemId: value.workItemId, runId: value.runId };
}

function safeRequest(input) {
	const job = input?.job;
	if (!job || typeof job.jobId !== "string" || !EVENT_ID.test(job.jobId) || typeof job.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(job.repository) || !Number.isInteger(job.generation) || job.generation < 1 || typeof input.runId !== "string" || !EVENT_ID.test(input.runId) || typeof input.checkoutDirectory !== "string" || !input.checkoutDirectory.startsWith("/workspace/") || typeof input.instructions !== "string" || typeof input.model !== "string" || !MODEL.test(input.model)) return null;
	if (input.candidate === null) return { ...input, job, candidate: null, callback: safeCallback(input.callback) };
	const candidate = input.candidate;
	const branch = safeBranch(candidate?.stack?.branch);
	const parentBranch = safeBranch(candidate?.stack?.parentBranch);
	if (candidate?.change?.kind !== "repository-task" || typeof candidate.change.request !== "string" || !candidate.change.request.trim() || typeof candidate?.stack?.stackId !== "string" || !EVENT_ID.test(candidate.stack.stackId) || candidate.stack.nodeId !== "root" || !branch || !parentBranch || parentBranch !== "main" || candidate.stack.pullRequestBase !== "main" || !Number.isInteger(candidate.stack.issueNumber) || candidate.stack.issueNumber < 1 || typeof candidate.stack.parentBaseSha !== "string" || !SHA.test(candidate.stack.parentBaseSha) || branch !== `app-harness-os/${candidate.stack.issueNumber}/g${job.generation}`) return null;
	return { ...input, job, candidate: { ...candidate, change: { ...candidate.change, request: candidate.change.request.trim() }, stack: { ...candidate.stack, branch, parentBranch } }, callback: safeCallback(input.callback) };
}

// Every step budget in milliseconds. Any single step can block forever — a
// network fetch, a git push against an unreachable remote, or a stalled model
// call — so no step is ever awaited without one of these.
const CLONE_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;
const AGENT_TIMEOUT_MS = 540_000;
const GH_STACK_TIMEOUT_MS = 120_000;
const GITHUB_FETCH_TIMEOUT_MS = 30_000;
const CALLBACK_TIMEOUT_MS = 15_000;
const RUN_DEADLINE_MS = 650_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const KILL_GRACE_MS = 2_000;

// Every live child is tracked so the run deadline can SIGKILL all of them. A
// surviving grandchild holds the sandbox process entry open and is exactly what
// keeps a run non-terminal after this process has given up.
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
				// Escalate: a well-behaved child exits on SIGTERM, a wedged one
				// only dies on SIGKILL. Resolving here means the caller is never
				// blocked on a child that refuses to leave.
				child.kill("SIGTERM");
				kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
				finish({ success: false, exitCode: 124, stdout, stderr: "step-timeout" });
			}, options.timeoutMs);
		}
		child.stdout.on("data", (chunk) => { if (stdout.length < 16_000) stdout += chunk; });
		child.stderr.on("data", (chunk) => { if (stderr.length < 16_000) stderr += chunk; });
		child.stdout.on("error", () => {});
		child.stderr.on("error", () => {});
		child.stdin.on("error", () => {});
		child.once("error", (error) => finish({ success: false, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` }));
		child.once("close", (code) => finish({ success: code === 0, exitCode: code ?? 1, stdout, stderr }));
		if (options.input) child.stdin.end(options.input); else child.stdin.end();
	});
}

function classifyGitTransportFailure(stderr) {
	// A step the watchdog killed is reported as such rather than being folded
	// into a generic transport failure, so the ledger stays truthful.
	if (stderr === "step-timeout") return "git-step-timeout";
	if (/could not resolve host|name or service not known|failed to connect|connection timed out/iu.test(stderr)) return "github-unreachable";
	if (/http (?:401|403|404)\b|authentication failed|could not read username/iu.test(stderr)) return "github-authorization-rejected";
	if (/http 5\d\d\b|service unavailable/iu.test(stderr)) return "github-upstream-unavailable";
	return "git-transport-failed";
}

function provenanceBody(existing, request, headSha) {
	const start = "<!-- app-harness-provenance:start -->";
	const end = "<!-- app-harness-provenance:end -->";
	const prior = existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`, "u"), "").trim();
	const { candidate, job } = request;
	return [
		prior || `Refs #${candidate.stack.issueNumber}`,
		"",
		start,
		"## App Harness candidate provenance",
		`- Stack: \`${candidate.stack.stackId}\` generation ${job.generation}`,
		`- Node: \`${candidate.stack.nodeId}\``,
		`- Parent base: \`${candidate.stack.parentBranch}\`${candidate.stack.parentBaseSha ? ` at \`${candidate.stack.parentBaseSha}\`` : ""}`,
		`- Candidate head: \`${headSha}\``,
		"- Operator: NanoCodex",
		"- CI is the merge and production deployment authority.",
		end,
	].join("\n");
}

async function findAndAnnotatePullRequest(request, headSha) {
	const { candidate, job } = request;
	const owner = job.repository.split("/")[0];
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${process.env.GH_TOKEN}`,
		"Content-Type": "application/json",
		"User-Agent": "app-harness-nanocodex",
		"X-GitHub-Api-Version": "2026-03-10",
	};
	try {
		// Every GitHub call is bounded: a hung socket here would otherwise wedge
		// the run after the candidate branch is already pushed.
		const response = await fetch(`https://api.github.com/repos/${job.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${candidate.stack.branch}`)}&base=${encodeURIComponent(candidate.stack.pullRequestBase)}`, { headers, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
		if (!response.ok) return { classification: "candidate-pull-request-missing" };
		const matches = await response.json();
		const pullRequest = Array.isArray(matches) ? matches.find((item) => item?.head?.sha === headSha && item?.base?.ref === candidate.stack.pullRequestBase) : null;
		if (!pullRequest || typeof pullRequest.html_url !== "string" || !Number.isInteger(pullRequest.number)) return { classification: "candidate-pull-request-missing" };
		const update = await fetch(`https://api.github.com/repos/${job.repository}/pulls/${pullRequest.number}`, { method: "PATCH", headers, body: JSON.stringify({ body: provenanceBody(typeof pullRequest.body === "string" ? pullRequest.body : "", request, headSha) }), signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
		return update.ok ? { url: pullRequest.html_url, number: pullRequest.number } : { classification: "pull-request-provenance-failed" };
	} catch {
		return { classification: "pull-request-provenance-failed" };
	}
}

function oneNodeStackView(stdout, branch) {
	try {
		const view = JSON.parse(stdout);
		if (!view || view.trunk !== "main" || view.currentBranch !== branch || !Array.isArray(view.branches) || view.branches.length !== 1) return null;
		const [node] = view.branches;
		if (!node || node.name !== branch || typeof node.base !== "string" || !SHA.test(node.base) || node.needsRebase !== false) return null;
		return { trunk: "main", branch: node.name, baseSha: node.base.toLowerCase() };
	} catch {
		return null;
	}
}

async function submitOneNodeStack(request, expectedHead) {
	const { branch } = request.candidate.stack;
	const initialized = await run("gh", ["stack", "init", "--base", "main", branch], { cwd: request.checkoutDirectory, timeoutMs: GH_STACK_TIMEOUT_MS });
	if (!initialized.success) return { classification: "stack-initialization-failed" };
	const submitted = await run("gh", ["stack", "submit", "--auto", "--open"], { cwd: request.checkoutDirectory, timeoutMs: GH_STACK_TIMEOUT_MS });
	if (!submitted.success) return { classification: "stack-submission-failed" };
	const [head, pushed, view] = await Promise.all([
		run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS }),
		run("git", ["-C", request.checkoutDirectory, "ls-remote", "--heads", "origin", `refs/heads/${branch}`], { timeoutMs: GIT_TIMEOUT_MS }),
		run("gh", ["stack", "view", "--json"], { cwd: request.checkoutDirectory, timeoutMs: GH_STACK_TIMEOUT_MS }),
	]);
	if (!head.success || head.stdout.trim() !== expectedHead) return { classification: "stack-head-changed" };
	if (!pushed.success || pushed.stdout.trim().split(/\s+/u)[0] !== expectedHead) return { classification: "stack-head-not-pushed" };
	if (!view.success) return { classification: "stack-view-failed" };
	const topology = oneNodeStackView(view.stdout, branch);
	return topology ? { topology } : { classification: "stack-topology-invalid" };
}

function artifact(request, state, extra = {}) {
	return { jobId: request.job.jobId, state, ...extra };
}

function stderrTail(result) {
	const tail = typeof result?.stderr === "string" ? result.stderr.trim().slice(-400) : "";
	return tail ? { stderrTail: tail } : {};
}

// Report the terminal artifact to the ledger by push, so the operator wakes on
// completion instead of polling. Failure here is non-fatal: the artifact was
// already emitted, and the ledger's stalled-implementation fact is the backstop.
let terminalCallback = null;

async function postCallback(result) {
	if (!terminalCallback) return;
	try {
		await fetch(terminalCallback.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workItemId: terminalCallback.workItemId, runId: terminalCallback.runId, artifact: result }),
			signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
		});
	} catch { /* best effort by design */ }
}

async function main() {
	const request = safeRequest(await readRequest());
	if (!request) throw new Error("input-invalid");
	terminalCallback = request.callback;
	const cloneBranch = request.candidate?.stack.parentBranch ?? "main";
	const clone = await run("git", ["clone", "--branch", cloneBranch, `https://github.com/${request.job.repository}.git`, request.checkoutDirectory], { timeoutMs: CLONE_TIMEOUT_MS });
	if (!clone.success) return artifact(request, "checkout-failed", { exitCode: clone.exitCode, classification: classifyGitTransportFailure(clone.stderr), ...stderrTail(clone) });
	const base = await run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
	const baseSha = base.stdout.trim();
	if (!base.success || !SHA.test(baseSha)) return artifact(request, "checkout-failed", { classification: "checkout-head-unavailable" });
	if (!request.candidate) return artifact(request, "checked-out", { baseSha, headSha: baseSha });
	if (request.candidate.stack.parentBaseSha && request.candidate.stack.parentBaseSha !== baseSha) return artifact(request, "needs-restack", { baseSha, classification: "parent-base-sha-mismatch", stack: { id: request.candidate.stack.stackId, nodeId: request.candidate.stack.nodeId, branch: request.candidate.stack.branch, parentBranch: request.candidate.stack.parentBranch } });

	const remote = await run("git", ["-C", request.checkoutDirectory, "ls-remote", "--heads", "origin", `refs/heads/${request.candidate.stack.branch}`], { timeoutMs: GIT_TIMEOUT_MS });
	if (!remote.success) return artifact(request, "candidate-failed", { classification: classifyGitTransportFailure(remote.stderr), ...stderrTail(remote) });
	const remoteSha = remote.stdout.trim().split(/\s+/u)[0];
	const checkout = SHA.test(remoteSha)
		? await run("git", ["-C", request.checkoutDirectory, "fetch", "origin", `refs/heads/${request.candidate.stack.branch}:refs/remotes/origin/${request.candidate.stack.branch}`], { timeoutMs: GIT_TIMEOUT_MS }).then(async (fetchResult) => fetchResult.success ? run("git", ["-C", request.checkoutDirectory, "checkout", "-B", request.candidate.stack.branch, `refs/remotes/origin/${request.candidate.stack.branch}`], { timeoutMs: GIT_TIMEOUT_MS }) : fetchResult)
		: await run("git", ["-C", request.checkoutDirectory, "checkout", "-b", request.candidate.stack.branch], { timeoutMs: GIT_TIMEOUT_MS });
	if (!checkout.success) return artifact(request, "candidate-failed", { classification: "candidate-branch-failed" });

	const agentInput = JSON.stringify({ prompt: `Implement the linked repository task exactly as requested: ${request.candidate.change.request}`, instructions: request.instructions, cwd: request.checkoutDirectory, model: request.model });
	const agentExecution = await run("node", ["/opt/app-harness/agent-entrypoint.mjs"], { cwd: request.checkoutDirectory, input: agentInput, timeoutMs: AGENT_TIMEOUT_MS });
	let agent = null;
	try { agent = JSON.parse(agentExecution.stdout.trim()); } catch { agent = null; }
	if (!agentExecution.success || !agent?.ok) return artifact(request, "candidate-failed", { classification: typeof agent?.classification === "string" ? agent.classification : agentExecution.exitCode === 124 ? "nanocodex-step-timeout" : "nanocodex-output-invalid", agent: agent && typeof agent === "object" ? agent : undefined, ...stderrTail(agentExecution) });

	const status = await run("git", ["-C", request.checkoutDirectory, "status", "--porcelain"], { timeoutMs: GIT_TIMEOUT_MS });
	const head = await run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"], { timeoutMs: GIT_TIMEOUT_MS });
	const headSha = head.stdout.trim();
	if (!status.success || status.stdout.trim()) return artifact(request, "candidate-failed", { classification: "candidate-working-tree-dirty", agent });
	if (!head.success || !SHA.test(headSha) || headSha === baseSha) return artifact(request, "candidate-failed", { classification: "candidate-head-unavailable", agent });
	const submitted = await submitOneNodeStack(request, headSha);
	if ("classification" in submitted) return artifact(request, "candidate-failed", { classification: submitted.classification, agent });
	const pullRequest = await findAndAnnotatePullRequest(request, headSha);
	if ("classification" in pullRequest) return artifact(request, "candidate-failed", { classification: pullRequest.classification, agent });
	return artifact(request, "pull-request-opened", { baseSha, headSha, pullRequest, stack: { id: request.candidate.stack.stackId, nodeId: request.candidate.stack.nodeId, branch: request.candidate.stack.branch, parentBranch: request.candidate.stack.parentBranch, topology: submitted.topology }, agent });
}

// A wedged child process must never exceed the run budget silently: emit a
// truthful terminal artifact and exit before the platform's process timeout.
//
// This is a ref'd setInterval rather than an unref'd setTimeout on purpose. An
// unref'd timer does not hold the event loop open, and a single long timer can
// be starved outright, which is how earlier runs wedged in "running" forever
// without ever emitting the deadline artifact. A ref'd interval keeps the loop
// alive and re-checks a wall-clock deadline, so it still fires even if one tick
// is delayed.
const startedAt = Date.now();
const watchdog = setInterval(async () => {
	if (Date.now() - startedAt < RUN_DEADLINE_MS) return;
	clearInterval(watchdog);
	// Kill every tracked child first: a surviving grandchild would hold the
	// sandbox process entry open and leave the run looking non-terminal even
	// after this process exits.
	killAllChildren();
	// The artifact must reach the kernel before exiting, so this await is
	// load-bearing rather than cosmetic. It is still raced against a hard cap:
	// if stdout itself is blocked the write can never resolve, and exiting
	// without the artifact still beats hanging here forever.
	await Promise.race([
		emit({ jobId: "unknown", state: "candidate-failed", classification: "nanocodex-deadline-exceeded" }),
		new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS)),
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
} catch {
	clearInterval(watchdog);
	killAllChildren();
	const failure = { jobId: "unknown", state: "candidate-failed", classification: "runner-entrypoint-failed" };
	await emit(failure);
	await postCallback(failure);
	process.exitCode = 1;
}
