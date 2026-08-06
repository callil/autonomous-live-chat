import assert from "node:assert/strict";
import {
	createEvidence,
	validateCandidateFiles,
	validatePullRequest,
	validateWorkflowRun,
	verifyEvidence,
} from "./os-stack-gate.mjs";

const repo = "callil/autonomous-live-chat";
const headSha = "8".repeat(40);
const baseSha = "7".repeat(40);
const mergeSha = "9".repeat(40);
const patch = [
	"@@ -6 +6 @@",
	"-:root { --accent: #10a37f; color: #0d0d0d; }",
	"+:root { --accent: #8b5cf6; color: #0d0d0d; }",
].join("\n");
const files = [{ filename: "public/index.html", status: "modified", additions: 1, deletions: 1, changes: 2, patch }];
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
		"- Parent base: `main`",
		`- Candidate head: \`${headSha}\``,
	].join("\n"),
};
const commit = { sha: headSha, parents: [{ sha: baseSha }] };
const options = {
	repo,
	expectedParent: "main",
	expectedHead: headSha,
	expectedIssue: 19,
	expectedGeneration: 1,
	expectedStack: "stack-request-19",
	allowMerged: false,
};

const valid = validatePullRequest(pullRequest, commit, files, options);
assert.equal(valid.headSha, headSha);
assert.equal(valid.issue, 19);
assert.equal(valid.generation, 1);
assert.equal(valid.alreadyMerged, false);

const merged = validatePullRequest(
	{ ...pullRequest, state: "closed", merged_at: "2026-08-06T15:00:00Z", merge_commit_sha: mergeSha },
	commit,
	files,
	{ ...options, allowMerged: true },
);
assert.equal(merged.alreadyMerged, true);
assert.equal(merged.mergeSha, mergeSha);

for (const mutation of [
	{ head: { ...pullRequest.head, repo: { full_name: "fork/repository" } } },
	{ user: { login: "untrusted-user" } },
	{ head: { ...pullRequest.head, ref: "app-harness-os/20/g1" } },
	{ base: { ...pullRequest.base, ref: "release" } },
]) {
	assert.throws(() => validatePullRequest({ ...pullRequest, ...mutation }, commit, files, options));
}
assert.throws(() => validatePullRequest(pullRequest, { ...commit, parents: [{ sha: "6".repeat(40) }] }, files, options));

validateCandidateFiles(files);
assert.throws(() => validateCandidateFiles([...files, { ...files[0], filename: "package.json" }]));
assert.throws(() => validateCandidateFiles([{ ...files[0], patch: patch.replace("color: #0d0d0d; }", "color: red; }") }]));
assert.throws(() => validateCandidateFiles([{ ...files[0], patch: patch.replace("#8b5cf6", "#12345") }]));

const evidenceInput = { repo, pullRequest: 20, headSha, baseSha, runId: 123456, state: "success", secret: "test-attestation-secret" };
const description = createEvidence(evidenceInput);
const status = { context: "app-harness-os/validate-node/pr-20", state: "success", description };
assert.deepEqual(verifyEvidence(status, { repo, pullRequest: 20, headSha, baseSha, secret: evidenceInput.secret }), { runId: 123456, state: "success" });
assert.throws(() => verifyEvidence({ ...status, state: "failure" }, { repo, pullRequest: 20, headSha, baseSha, secret: evidenceInput.secret }));
assert.throws(() => verifyEvidence(status, { repo, pullRequest: 21, headSha, baseSha, secret: evidenceInput.secret }));

const workflowRun = {
	id: 123456,
	path: ".github/workflows/os-stack-ci.yml",
	repository: { full_name: repo },
	status: "completed",
	conclusion: "success",
	event: "pull_request",
	head_sha: headSha,
	pull_requests: [{ number: 20 }],
};
assert.deepEqual(validateWorkflowRun(workflowRun, { repo, pullRequest: 20, headSha, runId: 123456 }), { pending: false });
assert.throws(() => validateWorkflowRun({ ...workflowRun, head_sha: "6".repeat(40) }, { repo, pullRequest: 20, headSha, runId: 123456 }));
assert.deepEqual(validateWorkflowRun({ ...workflowRun, event: "workflow_dispatch", head_sha: baseSha, pull_requests: [] }, { repo, pullRequest: 20, headSha, runId: 123456 }), { pending: false });

console.log("OS stack trusted gate contracts passed");
