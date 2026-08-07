import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/iu;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const STACK_BRANCH = /^app-harness-os\/(\d+)\/g(\d+)$/u;
const APP_LOGIN = "app-harness-native-git-callil[bot]";
const WORKFLOW_PATH = ".github/workflows/os-stack-ci.yml";
const CI_PROFILES = new Set(["visual", "content", "behavior", "data", "infrastructure"]);

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
	const branch = typeof head.ref === "string" ? head.ref.match(STACK_BRANCH) : null;
	if (!branch) throw new Error("Candidate branch is outside the OS stack namespace.");
	const issue = Number(branch[1]);
	const generation = Number(branch[2]);
	if (base.ref !== "main" || (options.expectedParent && options.expectedParent !== "main")) throw new Error("Only the durable one-node stack root based on main can be promoted.");
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
	if (lineValue(body, /- Node: `([^`]+)`/u, "node") !== "root") throw new Error("One-node stack provenance must identify the root node.");
	if (lineValue(body, /- Parent base: `([^`]+)`/u, "parent") !== base.ref) throw new Error("Pull request parent provenance is invalid.");
	if (lineValue(body, /- Candidate head: `([0-9a-f]{40})`/iu, "head").toLowerCase() !== headSha) throw new Error("Pull request head provenance is invalid.");
	// The ledger-declared CI profile rides the same provenance markers: content
	// and visual candidates earn the scoped validation fast path. The marker is
	// optional for compatibility; when absent, an empty profile means the full
	// mandatory baseline — never a guessed fast path.
	const profileMatch = body.match(/- CI profile: `([a-z]+)`/u);
	if (profileMatch && !CI_PROFILES.has(profileMatch[1])) throw new Error("Pull request CI profile provenance is invalid.");
	return {
		pullRequest: Number(pr.number),
		headSha,
		candidateBaseSha: baseSha,
		headRef: head.ref,
		issue,
		generation,
		stackId: stackMatch[1],
		ciProfile: profileMatch ? profileMatch[1] : "",
		alreadyMerged: Boolean(merged),
		mergeSha: merged ? pr.merge_commit_sha.toLowerCase() : "",
	};
}

export function validateCandidateFiles(files) {
	if (!Array.isArray(files) || files.length < 1) throw new Error("Candidate file provenance is empty or incomplete.");
	const seen = new Set();
	for (const file of files) {
		if (!file || typeof file.filename !== "string" || !file.filename || file.filename.startsWith("/") || file.filename.includes("\0") || file.filename.split("/").includes("..") || file.filename === ".git" || file.filename.startsWith(".git/")) throw new Error("Candidate contains an unsafe repository path.");
		if (seen.has(file.filename)) throw new Error("Candidate file provenance contains duplicate paths.");
		seen.add(file.filename);
		if (!new Set(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]).has(file.status)) throw new Error("Candidate file status is invalid.");
		for (const field of ["additions", "deletions", "changes"]) if (!Number.isInteger(file[field]) || file[field] < 0) throw new Error("Candidate change counts are invalid.");
	}
}

// GitHub documents a 100-item page maximum and a 3,000-file response ceiling
// for the pull-request files endpoint. This is provider-derived pagination,
// not an App Harness repository-scope restriction.
const GITHUB_PULL_FILES_PAGE_SIZE = 100;
const GITHUB_PULL_FILES_MAX_PAGES = 30;

async function pullRequestFiles(repo, pullRequest) {
	const files = [];
	for (let page = 1; page <= GITHUB_PULL_FILES_MAX_PAGES; page += 1) {
		const batch = await api(`repos/${repo}/pulls/${pullRequest}/files?per_page=${GITHUB_PULL_FILES_PAGE_SIZE}&page=${page}`);
		if (!Array.isArray(batch)) throw new Error("GitHub returned invalid candidate file provenance.");
		files.push(...batch);
		if (batch.length < GITHUB_PULL_FILES_PAGE_SIZE) return files;
	}
	throw new Error("GitHub's pull-request file response reached its documented 3,000-file ceiling; complete provenance is unavailable.");
}

export function validateWorkflowRun(run, expected) {
	if (!run || run.path !== WORKFLOW_PATH || run.repository?.full_name !== expected.repo) throw new Error("Validation run is not from the trusted candidate workflow.");
	if (run.event !== "pull_request_target" || run.head_sha?.toLowerCase() !== expected.headSha || run.head_branch !== expected.headRef) {
		throw new Error("Validation run is bound to different candidate provenance.");
	}
	if (run.status !== "completed") return { pending: true };
	if (run.conclusion !== "success") throw new Error("Bound validation workflow did not succeed.");
	return { pending: false, runId: run.id };
}

export function selectValidationRun(runs, expected) {
	if (!Array.isArray(runs)) throw new Error("GitHub Actions validation response is invalid.");
	const bound = runs.filter((run) => run?.path === WORKFLOW_PATH && run.repository?.full_name === expected.repo && run.event === "pull_request_target" && run.head_sha?.toLowerCase() === expected.headSha && run.head_branch === expected.headRef);
	if (!bound.length) return { pending: true };
	const newest = bound.sort((left, right) => {
		const time = Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "");
		return time || (right.run_attempt ?? 0) - (left.run_attempt ?? 0) || (right.id ?? 0) - (left.id ?? 0);
	})[0];
	return validateWorkflowRun(newest, expected);
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
	const pr = await api(`repos/${repo}/pulls/${pullRequest}`);
	const [files, commit, comparison] = await Promise.all([
		pullRequestFiles(repo, pullRequest),
		api(`repos/${repo}/git/commits/${pr.head.sha}`),
		api(`repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`),
	]);
	const result = validatePullRequest(pr, commit, files, {
		repo,
		expectedParent: process.env.EXPECTED_PARENT,
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
		ci_profile: result.ciProfile,
		node_id: "root",
		already_merged: result.alreadyMerged,
		merge_sha: result.mergeSha,
	});
}

async function waitValidationCommand() {
	const repo = repository(required("GH_REPO"));
	const pullRequest = integer(required("PR"), "PR");
	const headSha = exactSha(required("EXPECTED_HEAD"), "EXPECTED_HEAD");
	const headRef = required("EXPECTED_HEAD_REF");
	const expected = { repo, pullRequest, headSha, headRef };
	for (let attempt = 1; attempt <= 36; attempt += 1) {
		const response = await api(`repos/${repo}/actions/workflows/os-stack-ci.yml/runs?event=pull_request_target&head_sha=${headSha}&per_page=100`);
		const result = selectValidationRun(response.workflow_runs, expected);
		if (!result.pending) {
			await output({ validation_run_id: result.runId });
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	throw new Error("Immutable validation did not complete within three minutes.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = process.argv[2];
	if (command === "verify-pr") await verifyPullRequestCommand();
	else if (command === "wait-validation") await waitValidationCommand();
	else throw new Error("Usage: os-stack-gate.mjs <verify-pr|wait-validation>");
}
