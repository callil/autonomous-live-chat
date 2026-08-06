import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/iu;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const STACK_BRANCH = /^app-harness-os\/(\d+)\/g(\d+)$/u;
const APP_LOGIN = "app-harness-native-git-callil[bot]";
const STATUS_PREFIX = "app-harness-os/validate-node/pr-";
const WORKFLOW_PATH = ".github/workflows/os-stack-ci.yml";

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function integer(value, name) {
	if (!/^\d+$/u.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer.`);
	return Number(value);
}

function exactSha(value, name) {
	if (!SHA.test(value)) throw new Error(`${name} must be a full commit SHA.`);
	return value.toLowerCase();
}

function repository(value) {
	if (!REPOSITORY.test(value)) throw new Error("GH_REPO must be an owner/repository pair.");
	return value;
}

function lineValue(body, pattern, label) {
	const match = body.match(pattern);
	if (!match?.[1]) throw new Error(`Pull request is missing ${label} provenance.`);
	return match[1];
}

export function validatePullRequest(pr, commit, files, options, comparison) {
	if (!pr || typeof pr !== "object") throw new Error("Pull request response is invalid.");
	const head = pr.head;
	const base = pr.base;
	if (!head?.repo || !base?.repo) throw new Error("Pull request repository provenance is missing.");
	if (head.repo.full_name !== options.repo || base.repo.full_name !== options.repo) throw new Error("Candidate must originate in the trusted repository.");
	if (pr.user?.login !== (options.appLogin ?? APP_LOGIN)) throw new Error("Candidate pull request was not opened by the native Git app.");
	if (base.ref !== options.expectedParent || options.expectedParent !== "main") throw new Error("Only root candidates based on main can be promoted.");
	const branch = typeof head.ref === "string" ? head.ref.match(STACK_BRANCH) : null;
	if (!branch) throw new Error("Candidate branch is outside the OS stack namespace.");
	const issue = Number(branch[1]);
	const generation = Number(branch[2]);
	if (generation !== 1) throw new Error("Multi-node changes require verified GitHub-native stack membership, order, and target-base metadata; this workflow supports only the one-node normal-PR path.");
	if (options.expectedIssue && issue !== options.expectedIssue) throw new Error("Candidate branch does not match the expected issue.");
	if (options.expectedGeneration && generation !== options.expectedGeneration) throw new Error("Candidate branch does not match the expected generation.");
	const headSha = exactSha(head.sha, "pull request head");
	const baseSha = exactSha(base.sha, "pull request base");
	if (options.expectedHead && headSha !== options.expectedHead) throw new Error("Candidate head changed after orchestration.");

	const open = pr.state === "open";
	const merged = options.allowMerged && pr.state === "closed" && Boolean(pr.merged_at) && SHA.test(pr.merge_commit_sha ?? "");
	if (!open && !merged) throw new Error("Candidate pull request is not open or an allowed completed merge.");
	if (!commit || commit.sha?.toLowerCase() !== headSha || !commit.parents?.length) throw new Error("Candidate head commit provenance is invalid.");
	if (!comparison || comparison.base_commit?.sha?.toLowerCase() !== baseSha || comparison.merge_base_commit?.sha?.toLowerCase() !== baseSha || comparison.status !== "ahead" || !Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 1) {
		throw new Error("Candidate must be an immutable non-empty history based on its recorded parent.");
	}
	validateCandidateFiles(files);

	const body = typeof pr.body === "string" ? pr.body : "";
	const stackMatch = body.match(/- Stack: `([^`]+)` generation (\d+)/u);
	if (!stackMatch || Number(stackMatch[2]) !== generation) throw new Error("Pull request stack generation provenance is invalid.");
	if (options.expectedStack && stackMatch[1] !== options.expectedStack) throw new Error("Pull request stack id does not match orchestration.");
	if (lineValue(body, /- Parent base: `([^`]+)`/u, "parent") !== base.ref) throw new Error("Pull request parent provenance is invalid.");
	if (lineValue(body, /- Candidate head: `([0-9a-f]{40})`/iu, "head").toLowerCase() !== headSha) throw new Error("Pull request head provenance is invalid.");
	return {
		pullRequest: Number(pr.number),
		headSha,
		candidateBaseSha: baseSha,
		headRef: head.ref,
		issue,
		generation,
		stackId: stackMatch[1],
		alreadyMerged: Boolean(merged),
		mergeSha: merged ? pr.merge_commit_sha.toLowerCase() : "",
	};
}

export function validateCandidateFiles(files) {
	if (!Array.isArray(files) || files.length < 1 || files.length > 100) throw new Error("Candidate file provenance is empty or incomplete.");
	const seen = new Set();
	for (const file of files) {
		if (!file || typeof file.filename !== "string" || !file.filename || file.filename.startsWith("/") || file.filename.includes("\0") || file.filename.split("/").includes("..") || file.filename === ".git" || file.filename.startsWith(".git/")) throw new Error("Candidate contains an unsafe repository path.");
		if (seen.has(file.filename)) throw new Error("Candidate file provenance contains duplicate paths.");
		seen.add(file.filename);
		if (!new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]).has(file.status)) throw new Error("Candidate file status is invalid.");
		for (const field of ["additions", "deletions", "changes"]) if (!Number.isInteger(file[field]) || file[field] < 0) throw new Error("Candidate change counts are invalid.");
	}
}

function evidenceMessage({ repo, pullRequest, headSha, baseSha, runId, state }) {
	return [repo, String(pullRequest), headSha, baseSha, String(runId), state].join("\n");
}

export function createEvidence({ repo, pullRequest, headSha, baseSha, runId, state, secret }) {
	const signature = createHmac("sha256", secret).update(evidenceMessage({ repo, pullRequest, headSha, baseSha, runId, state })).digest("hex");
	return `b=${baseSha};r=${runId};s=${signature}`;
}

export function verifyEvidence(status, expected) {
	if (!status || status.context !== `${STATUS_PREFIX}${expected.pullRequest}`) throw new Error("Validation status context is not bound to the pull request.");
	const match = typeof status.description === "string" ? status.description.match(/^b=([0-9a-f]{40});r=(\d+);s=([0-9a-f]{64})$/iu) : null;
	if (!match) throw new Error("Validation status attestation is malformed.");
	const baseSha = match[1].toLowerCase();
	const runId = Number(match[2]);
	if (baseSha !== expected.baseSha || !Number.isSafeInteger(runId)) throw new Error("Validation status is bound to different provenance.");
	const wanted = createEvidence({ ...expected, runId, state: status.state, secret: expected.secret }).slice(-64);
	const actual = match[3].toLowerCase();
	if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(wanted, "hex"))) throw new Error("Validation status attestation is invalid.");
	return { runId, state: status.state };
}

export function validateWorkflowRun(run, expected) {
	if (!run || run.id !== expected.runId || run.path !== WORKFLOW_PATH || run.repository?.full_name !== expected.repo) throw new Error("Validation status points to an unrelated workflow run.");
	if (run.status !== "completed") return { pending: true };
	if (run.conclusion !== "success") throw new Error("Bound validation workflow did not succeed.");
	if (run.event === "pull_request") {
		if (run.head_sha?.toLowerCase() !== expected.headSha || !run.pull_requests?.some((pr) => pr.number === expected.pullRequest)) {
			throw new Error("Pull request validation run is bound to different candidate provenance.");
		}
	} else if (run.event !== "workflow_dispatch") {
		throw new Error("Validation status points to an unsupported workflow event.");
	}
	return { pending: false };
}

async function api(path, options = {}) {
	const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/${path}`, {
		...options,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${required("GH_TOKEN")}`,
			"Content-Type": "application/json",
			"User-Agent": "app-harness-os-stack-gate",
			"X-GitHub-Api-Version": "2022-11-28",
			...options.headers,
		},
	});
	if (!response.ok) throw new Error(`GitHub API ${path} failed (${response.status}).`);
	return response.json();
}

async function output(values) {
	const destination = process.env.GITHUB_OUTPUT;
	for (const [key, value] of Object.entries(values)) {
		const line = `${key}=${value}\n`;
		if (destination) await appendFile(destination, line);
		else process.stdout.write(line);
	}
}

async function verifyPullRequestCommand() {
	const repo = repository(required("GH_REPO"));
	const pullRequest = integer(required("PR"), "PR");
	const expectedHead = process.env.EXPECTED_HEAD ? exactSha(process.env.EXPECTED_HEAD, "EXPECTED_HEAD") : undefined;
	const [pr, files, extraFiles] = await Promise.all([
		api(`repos/${repo}/pulls/${pullRequest}`),
		api(`repos/${repo}/pulls/${pullRequest}/files?per_page=100&page=1`),
		api(`repos/${repo}/pulls/${pullRequest}/files?per_page=100&page=2`),
	]);
	if (extraFiles.length) throw new Error("Candidate exceeds the bounded file-provenance audit.");
	const [commit, comparison] = await Promise.all([
		api(`repos/${repo}/git/commits/${pr.head.sha}`),
		api(`repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`),
	]);
	const result = validatePullRequest(pr, commit, files, {
		repo,
		expectedParent: process.env.EXPECTED_PARENT ?? "main",
		expectedHead,
		expectedIssue: process.env.EXPECTED_ISSUE ? integer(process.env.EXPECTED_ISSUE, "EXPECTED_ISSUE") : undefined,
		expectedGeneration: process.env.EXPECTED_GENERATION ? integer(process.env.EXPECTED_GENERATION, "EXPECTED_GENERATION") : undefined,
		expectedStack: process.env.EXPECTED_STACK,
		allowMerged: process.env.ALLOW_MERGED === "true",
		appLogin: process.env.APP_HARNESS_OS_APP_LOGIN,
	}, comparison);
	await output({
		pull_request: result.pullRequest,
		head_sha: result.headSha,
		candidate_base_sha: result.candidateBaseSha,
		head_ref: result.headRef,
		issue: result.issue,
		generation: result.generation,
		stack_id: result.stackId,
		already_merged: result.alreadyMerged,
		merge_sha: result.mergeSha,
	});
}

async function publishStatusCommand() {
	const repo = repository(required("GH_REPO"));
	const pullRequest = integer(required("PR"), "PR");
	const headSha = exactSha(required("EXPECTED_HEAD"), "EXPECTED_HEAD");
	const baseSha = exactSha(required("EXPECTED_BASE"), "EXPECTED_BASE");
	const runId = integer(required("GITHUB_RUN_ID"), "GITHUB_RUN_ID");
	const state = required("VALIDATION_STATE");
	if (!new Set(["pending", "success", "failure", "error"]).has(state)) throw new Error("VALIDATION_STATE is invalid.");
	const description = createEvidence({ repo, pullRequest, headSha, baseSha, runId, state, secret: required("ATTESTATION_SECRET") });
	await api(`repos/${repo}/statuses/${headSha}`, {
		method: "POST",
		body: JSON.stringify({
			state,
			context: `${STATUS_PREFIX}${pullRequest}`,
			description,
			target_url: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${runId}`,
		}),
	});
}

async function waitStatusCommand() {
	const repo = repository(required("GH_REPO"));
	const pullRequest = integer(required("PR"), "PR");
	const headSha = exactSha(required("EXPECTED_HEAD"), "EXPECTED_HEAD");
	const baseSha = exactSha(required("EXPECTED_BASE"), "EXPECTED_BASE");
	const expected = { repo, pullRequest, headSha, baseSha, secret: required("ATTESTATION_SECRET") };
	for (let attempt = 1; attempt <= 36; attempt += 1) {
		const combined = await api(`repos/${repo}/commits/${headSha}/status`);
		const status = combined.statuses?.find((candidate) => candidate.context === `${STATUS_PREFIX}${pullRequest}`);
		if (status) {
			const evidence = verifyEvidence(status, expected);
			if (evidence.state === "failure" || evidence.state === "error") throw new Error(`Immutable validation concluded ${evidence.state}.`);
			if (evidence.state === "success") {
				const run = await api(`repos/${repo}/actions/runs/${evidence.runId}`);
				const result = validateWorkflowRun(run, { ...expected, runId: evidence.runId });
				if (!result.pending) {
					await output({ validation_run_id: evidence.runId });
					return;
				}
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	throw new Error("Immutable validation did not complete within three minutes.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = process.argv[2];
	if (command === "verify-pr") await verifyPullRequestCommand();
	else if (command === "publish-status") await publishStatusCommand();
	else if (command === "wait-status") await waitStatusCommand();
	else throw new Error("Usage: os-stack-gate.mjs <verify-pr|publish-status|wait-status>");
}
