import { spawn } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/iu;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

function emit(value) {
	process.stdout.write(JSON.stringify(value));
}

async function readRequest() {
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

function safeRequest(input) {
	const job = input?.job;
	if (!job || typeof job.jobId !== "string" || !EVENT_ID.test(job.jobId) || typeof job.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(job.repository) || !Number.isInteger(job.generation) || job.generation < 1 || typeof input.runId !== "string" || !EVENT_ID.test(input.runId) || typeof input.checkoutDirectory !== "string" || !input.checkoutDirectory.startsWith("/workspace/") || typeof input.instructions !== "string" || typeof input.model !== "string" || !MODEL.test(input.model)) return null;
	if (input.candidate === null) return { ...input, job, candidate: null };
	const candidate = input.candidate;
	const branch = safeBranch(candidate?.stack?.branch);
	const parentBranch = safeBranch(candidate?.stack?.parentBranch);
	if (candidate?.change?.kind !== "repository-task" || typeof candidate.change.request !== "string" || !candidate.change.request.trim() || typeof candidate?.stack?.stackId !== "string" || !EVENT_ID.test(candidate.stack.stackId) || candidate.stack.nodeId !== "root" || !branch || !parentBranch || parentBranch !== "main" || candidate.stack.pullRequestBase !== "main" || !Number.isInteger(candidate.stack.issueNumber) || candidate.stack.issueNumber < 1 || typeof candidate.stack.parentBaseSha !== "string" || !SHA.test(candidate.stack.parentBaseSha) || branch !== `app-harness-os/${candidate.stack.issueNumber}/g${job.generation}`) return null;
	return { ...input, job, candidate: { ...candidate, change: { ...candidate.change, request: candidate.change.request.trim() }, stack: { ...candidate.stack, branch, parentBranch } } };
}

function run(command, args, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { if (stdout.length < 16_000) stdout += chunk; });
		child.stderr.on("data", (chunk) => { if (stderr.length < 16_000) stderr += chunk; });
		child.once("error", (error) => resolve({ success: false, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` }));
		child.once("close", (code) => resolve({ success: code === 0, exitCode: code ?? 1, stdout, stderr }));
		if (options.input) child.stdin.end(options.input); else child.stdin.end();
	});
}

function classifyGitTransportFailure(stderr) {
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
		const response = await fetch(`https://api.github.com/repos/${job.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${candidate.stack.branch}`)}&base=${encodeURIComponent(candidate.stack.pullRequestBase)}`, { headers });
		if (!response.ok) return { classification: "candidate-pull-request-missing" };
		const matches = await response.json();
		const pullRequest = Array.isArray(matches) ? matches.find((item) => item?.head?.sha === headSha && item?.base?.ref === candidate.stack.pullRequestBase) : null;
		if (!pullRequest || typeof pullRequest.html_url !== "string" || !Number.isInteger(pullRequest.number)) return { classification: "candidate-pull-request-missing" };
		const update = await fetch(`https://api.github.com/repos/${job.repository}/pulls/${pullRequest.number}`, { method: "PATCH", headers, body: JSON.stringify({ body: provenanceBody(typeof pullRequest.body === "string" ? pullRequest.body : "", request, headSha) }) });
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
	const initialized = await run("gh", ["stack", "init", "--base", "main", branch], { cwd: request.checkoutDirectory });
	if (!initialized.success) return { classification: "stack-initialization-failed" };
	const submitted = await run("gh", ["stack", "submit", "--auto", "--open"], { cwd: request.checkoutDirectory });
	if (!submitted.success) return { classification: "stack-submission-failed" };
	const [head, pushed, view] = await Promise.all([
		run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"]),
		run("git", ["-C", request.checkoutDirectory, "ls-remote", "--heads", "origin", `refs/heads/${branch}`]),
		run("gh", ["stack", "view", "--json"], { cwd: request.checkoutDirectory }),
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

async function main() {
	const request = safeRequest(await readRequest());
	if (!request) throw new Error("input-invalid");
	const cloneBranch = request.candidate?.stack.parentBranch ?? "main";
	const clone = await run("git", ["clone", "--branch", cloneBranch, `https://github.com/${request.job.repository}.git`, request.checkoutDirectory]);
	if (!clone.success) return artifact(request, "checkout-failed", { exitCode: clone.exitCode, classification: classifyGitTransportFailure(clone.stderr) });
	const base = await run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"]);
	const baseSha = base.stdout.trim();
	if (!base.success || !SHA.test(baseSha)) return artifact(request, "checkout-failed", { classification: "checkout-head-unavailable" });
	if (!request.candidate) return artifact(request, "checked-out", { baseSha, headSha: baseSha });
	if (request.candidate.stack.parentBaseSha && request.candidate.stack.parentBaseSha !== baseSha) return artifact(request, "needs-restack", { baseSha, classification: "parent-base-sha-mismatch", stack: { id: request.candidate.stack.stackId, nodeId: request.candidate.stack.nodeId, branch: request.candidate.stack.branch, parentBranch: request.candidate.stack.parentBranch } });

	const remote = await run("git", ["-C", request.checkoutDirectory, "ls-remote", "--heads", "origin", `refs/heads/${request.candidate.stack.branch}`]);
	if (!remote.success) return artifact(request, "candidate-failed", { classification: classifyGitTransportFailure(remote.stderr) });
	const remoteSha = remote.stdout.trim().split(/\s+/u)[0];
	const checkout = SHA.test(remoteSha)
		? await run("git", ["-C", request.checkoutDirectory, "fetch", "origin", `refs/heads/${request.candidate.stack.branch}:refs/remotes/origin/${request.candidate.stack.branch}`]).then(async (fetchResult) => fetchResult.success ? run("git", ["-C", request.checkoutDirectory, "checkout", "-B", request.candidate.stack.branch, `refs/remotes/origin/${request.candidate.stack.branch}`]) : fetchResult)
		: await run("git", ["-C", request.checkoutDirectory, "checkout", "-b", request.candidate.stack.branch]);
	if (!checkout.success) return artifact(request, "candidate-failed", { classification: "candidate-branch-failed" });

	const agentInput = JSON.stringify({ prompt: `Implement the linked repository task exactly as requested: ${request.candidate.change.request}`, instructions: request.instructions, cwd: request.checkoutDirectory, model: request.model });
	const agentExecution = await run("node", ["/opt/app-harness/agent-entrypoint.mjs"], { cwd: request.checkoutDirectory, input: agentInput });
	let agent = null;
	try { agent = JSON.parse(agentExecution.stdout.trim()); } catch { agent = null; }
	if (!agentExecution.success || !agent?.ok) return artifact(request, "candidate-failed", { classification: typeof agent?.classification === "string" ? agent.classification : "nanocodex-output-invalid", agent: agent && typeof agent === "object" ? agent : undefined });

	const status = await run("git", ["-C", request.checkoutDirectory, "status", "--porcelain"]);
	const head = await run("git", ["-C", request.checkoutDirectory, "rev-parse", "HEAD"]);
	const headSha = head.stdout.trim();
	if (!status.success || status.stdout.trim()) return artifact(request, "candidate-failed", { classification: "candidate-working-tree-dirty", agent });
	if (!head.success || !SHA.test(headSha) || headSha === baseSha) return artifact(request, "candidate-failed", { classification: "candidate-head-unavailable", agent });
	const submitted = await submitOneNodeStack(request, headSha);
	if ("classification" in submitted) return artifact(request, "candidate-failed", { classification: submitted.classification, agent });
	const pullRequest = await findAndAnnotatePullRequest(request, headSha);
	if ("classification" in pullRequest) return artifact(request, "candidate-failed", { classification: pullRequest.classification, agent });
	return artifact(request, "pull-request-opened", { baseSha, headSha, pullRequest, stack: { id: request.candidate.stack.stackId, nodeId: request.candidate.stack.nodeId, branch: request.candidate.stack.branch, parentBranch: request.candidate.stack.parentBranch, topology: submitted.topology }, agent });
}

try {
	emit(await main());
} catch {
	emit({ jobId: "unknown", state: "candidate-failed", classification: "runner-entrypoint-failed" });
	process.exitCode = 1;
}
