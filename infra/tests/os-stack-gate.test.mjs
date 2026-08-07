import assert from "node:assert/strict";
import {
	parentBaseMergedIntoMain,
	selectValidationRun,
	validateCandidateFiles,
	validatePullRequest,
	validateStackMembership,
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
		"- CI profile: `content`",
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
assert.equal(valid.ciProfile, "content", "the ledger-declared CI profile rides the provenance markers into the gate outputs");

// The CI profile marker is optional (older candidates), but never guessable:
// absent means the full baseline, and an out-of-vocabulary profile fails closed.
const withoutProfile = validatePullRequest(
	{ ...pullRequest, body: pullRequest.body.split("\n").filter((line) => !line.startsWith("- CI profile:")).join("\n") },
	commit,
	files,
	options,
	comparison,
);
assert.equal(withoutProfile.ciProfile, "", "an absent CI profile marker yields the empty profile: the workflow runs the full mandatory baseline");
assert.throws(
	() => validatePullRequest({ ...pullRequest, body: pullRequest.body.replace("- CI profile: `content`", "- CI profile: `fastpath`") }, commit, files, options, comparison),
	/CI profile provenance is invalid/u,
	"an invented CI profile cannot buy the scoped fast path",
);

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

// ---- server-side stack membership: the stack object cross-checks the body markers ----

const stackPr = { ...pullRequest, stack: { id: 900, number: 3, position: 1, size: 1, base: { ref: "main", sha: baseSha } } };
const stackDetail = { number: 3, base: { ref: "main" }, open: true, pull_requests: [{ number: 20, state: "open", head: { ref: "app-harness-os/19/g1", sha: headSha } }] };
assert.deepEqual(validateStackMembership(stackPr, stackDetail, { requireBottom: true }), { stackNumber: 3, position: 1, size: 1 }, "a one-node stack's only member is its bottom open member");
assert.deepEqual(validateStackMembership(stackPr, stackDetail, {}), { stackNumber: 3, position: 1, size: 1 }, "CI verification asserts membership without the promotion-only bottom rule");
assert.throws(() => validateStackMembership(pullRequest, stackDetail, {}), /not a member of a native pull request stack/u, "a candidate without a server-side stack object fails closed");
assert.throws(() => validateStackMembership({ ...stackPr, stack: { ...stackPr.stack, base: { ref: "release" } } }, stackDetail, {}), /based on main/u, "a stack based anywhere but main fails closed");
assert.throws(() => validateStackMembership(stackPr, { ...stackDetail, base: { ref: "release" } }, {}), /based on main/u, "the fetched stack's base is asserted independently of the membership object");
assert.throws(() => validateStackMembership(stackPr, { ...stackDetail, number: 4 }, {}), /different stack/u, "the fetched stack must be the membership's stack");
assert.throws(() => validateStackMembership(stackPr, { ...stackDetail, pull_requests: [{ number: 99, state: "open" }] }, {}), /exactly once/u, "the candidate must appear exactly once among the stack's members");
assert.throws(() => validateStackMembership({ ...stackPr, stack: { ...stackPr.stack, position: 0 } }, stackDetail, {}), /position provenance/u);
assert.throws(() => validateStackMembership({ ...stackPr, stack: { ...stackPr.stack, size: 2 } }, stackDetail, {}), /missing or inconsistent/u, "a member count that disagrees with the recorded size fails closed");

// Members are ordered bottom to top: promotion demands the bottom OPEN member.
const upperPr = { ...pullRequest, number: 21, stack: { id: 900, number: 3, position: 2, size: 2, base: { ref: "main", sha: baseSha } } };
const twoOpen = { number: 3, base: { ref: "main" }, pull_requests: [{ number: 20, state: "open" }, { number: 21, state: "open" }] };
assert.throws(() => validateStackMembership(upperPr, twoOpen, { requireBottom: true }), /bottom open stack member/u, "an upper node cannot be promoted while a lower member is still open");
validateStackMembership(upperPr, twoOpen, {});
const bottomMerged = { number: 3, base: { ref: "main" }, pull_requests: [{ number: 20, state: "closed" }, { number: 21, state: "open" }] };
validateStackMembership(upperPr, bottomMerged, { requireBottom: true });
assert.throws(() => validateStackMembership({ ...upperPr, stack: { ...upperPr.stack, position: 1 } }, twoOpen, {}), /member order/u, "a position that disagrees with the stack's member order fails closed");

// ---- ancestor-of-main rule: a retargeted survivor's parent marker ----

assert.equal(parentBaseMergedIntoMain({ status: "behind", ahead_by: 0, behind_by: 4 }), true, "a recorded parent base behind main is an ancestor: the parent merged");
assert.equal(parentBaseMergedIntoMain({ status: "identical", ahead_by: 0, behind_by: 0 }), true);
assert.equal(parentBaseMergedIntoMain({ status: "diverged", ahead_by: 2, behind_by: 4 }), false);
assert.equal(parentBaseMergedIntoMain({ status: "ahead", ahead_by: 1, behind_by: 0 }), false);
assert.equal(parentBaseMergedIntoMain(undefined), false, "the ancestor rule fails closed without the comparison");

const survivorBody = pullRequest.body.replace("- Parent base: `main`", "- Parent base: `app-harness-os/18/g1`");
assert.throws(
	() => validatePullRequest({ ...pullRequest, body: survivorBody }, commit, files, options, comparison),
	/parent provenance is invalid/u,
	"a parent marker that no longer names the base branch fails closed without ancestor evidence",
);
const survivor = validatePullRequest({ ...pullRequest, body: survivorBody }, commit, files, { ...options, parentMarkerComparison: { status: "behind", ahead_by: 0, behind_by: 3 } }, comparison);
assert.equal(survivor.headSha, headSha, "a retargeted survivor verifies when its recorded parent base is an ancestor of current main");
assert.throws(
	() => validatePullRequest({ ...pullRequest, body: survivorBody }, commit, files, { ...options, parentMarkerComparison: { status: "diverged", ahead_by: 1, behind_by: 3 } }, comparison),
	/parent provenance is invalid/u,
	"a diverged recorded parent base is not a merged parent",
);

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
