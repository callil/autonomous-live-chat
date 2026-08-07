import assert from "node:assert/strict";
import {
	selectValidationRun,
	validateCandidateFiles,
	validatePullRequest,
	validateWorkflowRun,
} from "../scripts/os-stack-gate.mjs";

const repo = "callil/autonomous-live-chat";
const headSha = "8".repeat(40);
const baseSha = "7".repeat(40);
const mergeSha = "9".repeat(40);
const files = [
	{ filename: "src/feature.ts", status: "modified", additions: 12, deletions: 3, changes: 15 },
	{ filename: "migrations/0002_feature.sql", status: "added", additions: 8, deletions: 0, changes: 8 },
];
const pullRequest = {
	number: 20,
	state: "open",
	merged_at: null,
	merge_commit_sha: null,
	user: { login: "app-harness-native-git-callil[bot]" },
	head: { ref: "app-harness-os/19/g1", sha: headSha, repo: { full_name: repo } },
	base: { ref: "main", sha: baseSha, repo: { full_name: repo } },
	body: [
		"- Stack: `stack-request-19` generation 1",
		"- Node: `root`",
		"- Parent base: `main`",
		`- Candidate head: \`${headSha}\``,
	].join("\n"),
};
const commit = { sha: headSha, parents: [{ sha: "6".repeat(40) }] };
const comparison = { status: "ahead", ahead_by: 3, base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha } };
const options = {
	repo,
	expectedParent: "main",
	expectedHead: headSha,
	expectedIssue: 19,
	expectedGeneration: 1,
	expectedStack: "stack-request-19",
	allowMerged: false,
};

const valid = validatePullRequest(pullRequest, commit, files, options, comparison);
assert.equal(valid.headSha, headSha);
assert.equal(valid.issue, 19);
assert.equal(valid.generation, 1);
assert.equal(valid.alreadyMerged, false);

const merged = validatePullRequest(
	{ ...pullRequest, state: "closed", merged_at: "2026-08-06T15:00:00Z", merge_commit_sha: mergeSha },
	commit,
	files,
	{ ...options, allowMerged: true },
	comparison,
);
assert.equal(merged.alreadyMerged, true);
assert.equal(merged.mergeSha, mergeSha);

for (const mutation of [
	{ head: { ...pullRequest.head, repo: { full_name: "fork/repository" } } },
	{ user: { login: "untrusted-user" } },
	{ head: { ...pullRequest.head, ref: "app-harness-os/20/g1" } },
	{ base: { ...pullRequest.base, ref: "release" } },
]) {
	assert.throws(() => validatePullRequest({ ...pullRequest, ...mutation }, commit, files, options, comparison));
}
assert.throws(() => validatePullRequest(pullRequest, commit, files, options, { ...comparison, merge_base_commit: { sha: "5".repeat(40) } }));

validateCandidateFiles(files);
validateCandidateFiles(Array.from({ length: 101 }, (_, index) => ({ ...files[0], filename: `src/file-${index}.ts` })));
assert.throws(() => validateCandidateFiles([{ ...files[0], filename: "../outside" }]));
assert.throws(() => validateCandidateFiles([{ ...files[0], filename: ".git/config" }]));
assert.throws(() => validateCandidateFiles([{ ...files[0], changes: -1 }]));

const workflowRun = {
	id: 123456,
	path: ".github/workflows/os-stack-ci.yml",
	repository: { full_name: repo },
	status: "completed",
	conclusion: "success",
	event: "pull_request_target",
	head_sha: headSha,
	head_branch: "app-harness-os/19/g1",
	created_at: "2026-08-06T20:00:00Z",
};
const validationExpected = { repo, pullRequest: 20, headSha, headRef: pullRequest.head.ref };
assert.deepEqual(validateWorkflowRun(workflowRun, validationExpected), { pending: false, runId: 123456 });
assert.throws(() => validateWorkflowRun({ ...workflowRun, head_sha: "6".repeat(40) }, validationExpected));
assert.throws(() => validateWorkflowRun({ ...workflowRun, event: "pull_request" }, validationExpected));
assert.throws(() => validateWorkflowRun({ ...workflowRun, head_branch: "app-harness-os/20/g1" }, validationExpected));
assert.deepEqual(selectValidationRun([workflowRun, { ...workflowRun, id: 123457, status: "in_progress", conclusion: null, created_at: "2026-08-06T20:01:00Z" }], validationExpected), { pending: true });
assert.deepEqual(selectValidationRun([workflowRun], validationExpected), { pending: false, runId: 123456 });
assert.deepEqual(selectValidationRun([], validationExpected), { pending: true });

assert.throws(() => validatePullRequest(
	{
		...pullRequest,
		head: { ...pullRequest.head, ref: "app-harness-os/19/g2" },
		base: { ...pullRequest.base, ref: "app-harness-os/19/g1" },
		body: [
			"- Stack: `stack-request-19` generation 2",
			"- Node: `root`",
			"- Parent base: `app-harness-os/19/g1`",
			`- Candidate head: \`${headSha}\``,
		].join("\n"),
	},
	commit,
	files,
	{ ...options, expectedGeneration: 2, expectedParent: undefined },
	comparison,
), /one-node stack root/u, "dependent nodes fail closed until multi-node restacking is implemented");

console.log("OS stack trusted gate contracts passed");
