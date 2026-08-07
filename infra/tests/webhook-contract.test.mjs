import assert from "node:assert/strict";
import {
	expiredGithubDeliveryMarker,
	extractGithubWebhookFact,
	GITHUB_DELIVERY_RETENTION_MS,
	githubDeliveryMarkerKey,
	matchGithubFactToWorkItem,
	matchGithubMainDeployToWorkItems,
	mergeGithubFact,
	normalizeGithubDeliveryId,
	normalizeGithubWebhookFact,
} from "../../packages/contracts/webhook.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const RUN_URL = "https://github.com/callil/autonomous-live-chat/actions/runs/900";

function candidateRun(overrides = {}) {
	return {
		id: 900,
		html_url: RUN_URL,
		conclusion: "success",
		created_at: "2026-08-06T20:00:00Z",
		event: "pull_request_target",
		path: ".github/workflows/os-stack-ci.yml",
		head_branch: "app-harness-os/42/g1",
		head_sha: SHA_A,
		display_title: "App Harness candidate · PR",
		...overrides,
	};
}

// ---- event filtering: only the three contracted facts survive ----
const validation = extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun() } });
assert.deepEqual(validation, { kind: "validation", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: SHA_A }, "a completed candidate CI run becomes a validation fact");
assert.ok(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/os-stack-ci.yml@main" }) } }), "a ref-suffixed workflow path still matches");
assert.equal(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "requested", workflow_run: candidateRun() } }), null, "only completed runs carry evidence");
assert.equal(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ event: "pull_request" }) } }), null, "untrusted non-pull_request_target runs are dropped");
assert.equal(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ head_branch: "feature/anything" }) } }), null, "runs outside the candidate branch namespace are dropped");
assert.equal(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ html_url: "https://evil.example/run" }) } }), null, "a non-GitHub run URL never becomes evidence");

const promotion = extractGithubWebhookFact({
	event: "workflow_run",
	payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/os-stack-promote.yml", event: "workflow_dispatch", display_title: "App Harness promotion · dispatch-work-42" }) },
});
assert.deepEqual(promotion, { kind: "promotion", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", dispatchKey: "dispatch-work-42" }, "the deterministic run-name yields the durable dispatch key");
assert.equal(
	extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/os-stack-promote.yml", event: "workflow_dispatch", display_title: "Unrelated dispatch" }) } }),
	null,
	"a promotion run without the deterministic title has no durable identity",
);

const candidate = extractGithubWebhookFact({
	event: "pull_request",
	payload: { action: "opened", pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", head: { ref: "app-harness-os/42/g1", sha: SHA_A } } },
});
assert.deepEqual(candidate, { kind: "candidate", number: 55, url: "https://github.com/callil/autonomous-live-chat/pull/55", headSha: SHA_A, branch: "app-harness-os/42/g1" }, "an opened candidate pull request becomes a corroborating fact");
assert.equal(extractGithubWebhookFact({ event: "pull_request", payload: { action: "closed", pull_request: { number: 55, html_url: "https://github.com/x/y/pull/55", head: { ref: "app-harness-os/42/g1", sha: SHA_A } } } }), null, "a closed-unmerged candidate carries no fact");
assert.equal(extractGithubWebhookFact({ event: "pull_request", payload: { action: "opened", pull_request: { number: 55, html_url: "https://github.com/x/y/pull/55", head: { ref: "feature/other", sha: SHA_A } } } }), null);
assert.equal(extractGithubWebhookFact({ event: "check_suite", payload: { action: "completed" } }), null, "unsubscribed events never produce facts");
// GitHub sends no delivery when a PR becomes conflicted, and synchronize/edited
// actions carry no merge evidence either: post-submission conflict recovery is
// the ledger's merge watch (merge-timeout problem fact plus the operator's
// observeCandidatePullRequest observation), never a webhook fact.
for (const action of ["synchronize", "edited"]) {
	assert.equal(
		extractGithubWebhookFact({ event: "pull_request", payload: { action, pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", head: { ref: "app-harness-os/42/g1", sha: SHA_A } } } }),
		null,
		`a ${action} pull_request delivery is not a conflict signal and produces no fact`,
	);
}

// ---- auto-merge fast lane: merged and main-deploy facts ----
const MERGE_SHA = "c".repeat(40);
const merged = extractGithubWebhookFact({
	event: "pull_request",
	payload: { action: "closed", pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", merged: true, merge_commit_sha: MERGE_SHA, head: { ref: "app-harness-os/42/g1", sha: SHA_A } } },
});
assert.deepEqual(merged, { kind: "merged", number: 55, url: "https://github.com/callil/autonomous-live-chat/pull/55", headSha: SHA_A, branch: "app-harness-os/42/g1", mergeCommitSha: MERGE_SHA }, "a candidate PR closed merged becomes a merged fact carrying the merge commit join key");
assert.equal(extractGithubWebhookFact({ event: "pull_request", payload: { action: "closed", pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", merged: false, merge_commit_sha: MERGE_SHA, head: { ref: "app-harness-os/42/g1", sha: SHA_A } } } }), null, "closed without merged=true is never merge evidence");
assert.equal(extractGithubWebhookFact({ event: "pull_request", payload: { action: "closed", pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", merged: true, merge_commit_sha: "short", head: { ref: "app-harness-os/42/g1", sha: SHA_A } } } }), null, "a merged fact requires a full merge commit SHA");
assert.equal(extractGithubWebhookFact({ event: "pull_request", payload: { action: "closed", pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", merged: true, merge_commit_sha: MERGE_SHA, head: { ref: "feature/other", sha: SHA_A } } } }), null, "merges outside the candidate branch namespace are dropped");

const mainDeploy = extractGithubWebhookFact({
	event: "workflow_run",
	payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/deploy-demo-on-main.yml", event: "push", head_branch: "main", head_sha: MERGE_SHA }) },
});
assert.deepEqual(mainDeploy, { kind: "main-deploy", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: MERGE_SHA }, "a completed main deploy run becomes promotion-equivalent evidence");
assert.ok(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/deploy-demo-on-main.yml", event: "workflow_dispatch", head_branch: "main", head_sha: MERGE_SHA }) } }), "a manually dispatched main deploy still carries evidence");
assert.equal(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/deploy-demo-on-main.yml", event: "push", head_branch: "feature/x", head_sha: MERGE_SHA }) } }), null, "a deploy run off main is never deployment evidence");
assert.equal(extractGithubWebhookFact({ event: "workflow_run", payload: { action: "completed", workflow_run: candidateRun({ path: ".github/workflows/deploy-demo-on-main.yml", event: "pull_request_target", head_branch: "main", head_sha: MERGE_SHA }) } }), null, "only push and workflow_dispatch deploy runs are trusted");

// ---- boundary re-validation round-trips every extracted fact ----
for (const fact of [validation, promotion, candidate, merged, mainDeploy]) {
	assert.deepEqual(normalizeGithubWebhookFact(JSON.parse(JSON.stringify(fact))), fact, `${fact.kind} fact survives the service boundary`);
}
assert.equal(normalizeGithubWebhookFact({ kind: "validation", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: "short" }), null);
assert.equal(normalizeGithubWebhookFact({ kind: "promotion", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", dispatchKey: "bad key" }), null);
assert.equal(normalizeGithubWebhookFact({ kind: "main-deploy", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: "short" }), null);
assert.equal(normalizeGithubWebhookFact({ ...merged, mergeCommitSha: "short" }), null, "a merged fact without a full merge commit dies at the boundary");
assert.equal(normalizeGithubWebhookFact({ kind: "elsewhere" }), null);

// ---- matching: immutable identities, oldest live item wins ----
const items = [
	{ id: "item-new", createdAt: 200, plan: { branch: "app-harness-os/43/g1" }, artifacts: {} },
	{ id: "item-old", createdAt: 100, plan: { branch: "app-harness-os/42/g1" }, artifacts: { candidate: { headSha: SHA_A } } },
];
assert.equal(matchGithubFactToWorkItem(validation, items), "item-old", "validation matches by the immutable candidate head revision");
assert.equal(matchGithubFactToWorkItem({ ...validation, headSha: SHA_B }, items), null, "a restacked head revision no longer matches anything");
assert.equal(matchGithubFactToWorkItem(promotion, items, [{ workItemId: "item-old", dispatchKey: "dispatch-work-42" }]), "item-old", "promotion matches by the promote action's durable dispatch key");
assert.equal(matchGithubFactToWorkItem(promotion, items, [{ workItemId: "item-gone", dispatchKey: "dispatch-work-42" }]), null, "a promotion for a non-live work item is dropped");
assert.equal(matchGithubFactToWorkItem(candidate, items), "item-old", "candidate corroboration matches by the plan branch");
assert.equal(matchGithubFactToWorkItem(merged, items), "item-old", "a merged fact matches by the recorded candidate head revision");
assert.equal(matchGithubFactToWorkItem({ ...merged, headSha: SHA_B }, items), "item-old", "a merged fact still matches by the plan branch when the head revision is unrecorded");
assert.equal(matchGithubFactToWorkItem({ ...merged, headSha: SHA_B, branch: "app-harness-os/99/g1" }, items), null, "a merge outside every live identity is dropped");
// A main deploy is evidence for every live item it provably contains: the
// exact merge-commit join, plus containment by ordering — main history is
// linear, so a successful run created after an item's merged fact deployed a
// descendant of that item's merge commit.
const DEPLOY_RUN_AT = Date.parse(mainDeploy.createdAt);
assert.deepEqual(matchGithubMainDeployToWorkItems(mainDeploy, items, [{ workItemId: "item-old", mergeCommitSha: MERGE_SHA, mergedAt: DEPLOY_RUN_AT + 60_000 }]), ["item-old"], "a main deploy matches by head revision against the recorded merge commit regardless of ordering");
assert.deepEqual(matchGithubMainDeployToWorkItems(mainDeploy, items, [{ workItemId: "item-old", mergeCommitSha: SHA_B, mergedAt: DEPLOY_RUN_AT - 60_000 }]), ["item-old"], "a successful deploy run created after an item merged deploys a descendant of its merge commit");
assert.deepEqual(
	matchGithubMainDeployToWorkItems(mainDeploy, items, [
		{ workItemId: "item-new", mergeCommitSha: MERGE_SHA, mergedAt: DEPLOY_RUN_AT + 60_000 },
		{ workItemId: "item-old", mergeCommitSha: SHA_B, mergedAt: DEPLOY_RUN_AT - 60_000 },
	]),
	["item-new", "item-old"],
	"one deploy run completes every merged item it contains, not only the last merge it shipped",
);
assert.deepEqual(matchGithubMainDeployToWorkItems(mainDeploy, items, [{ workItemId: "item-old", mergeCommitSha: SHA_B, mergedAt: DEPLOY_RUN_AT + 60_000 }]), [], "a deploy run created before the merge proves nothing about it");
assert.deepEqual(matchGithubMainDeployToWorkItems({ ...mainDeploy, conclusion: "failure" }, items, [{ workItemId: "item-old", mergeCommitSha: SHA_B, mergedAt: DEPLOY_RUN_AT - 60_000 }]), [], "only a successful run is containment evidence for other items' merges");
assert.deepEqual(matchGithubMainDeployToWorkItems({ ...mainDeploy, conclusion: "failure" }, items, [{ workItemId: "item-old", mergeCommitSha: MERGE_SHA, mergedAt: DEPLOY_RUN_AT - 60_000 }]), ["item-old"], "the exact join still carries a failed run: an item's own deploy failing is real evidence");
assert.deepEqual(matchGithubMainDeployToWorkItems(mainDeploy, items, [{ workItemId: "item-gone", mergeCommitSha: MERGE_SHA, mergedAt: DEPLOY_RUN_AT - 60_000 }]), [], "a main deploy for a non-live work item is dropped");

// ---- merge: monotonic, never downgrades recorded evidence ----
const first = mergeGithubFact({ runnerResult: { runId: "run-1" } }, validation, 1_000);
assert.deepEqual(first, {
	runnerResult: { runId: "run-1" },
	validation: { runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: SHA_A, at: 1_000 },
}, "the merge preserves unrelated pushed facts");
assert.equal(mergeGithubFact(first, validation, 2_000), null, "a redelivered identical fact adds nothing");
assert.equal(mergeGithubFact(first, { ...validation, conclusion: null }, 2_000), null, "a null conclusion never downgrades recorded evidence");
assert.equal(mergeGithubFact(first, { ...validation, runId: 800, createdAt: "2026-08-06T19:00:00Z", conclusion: "failure" }, 2_000), null, "an older run never replaces newer evidence");
const rerun = mergeGithubFact(first, { ...validation, runId: 901, createdAt: "2026-08-06T21:00:00Z", conclusion: "failure" }, 2_000);
assert.equal(rerun.validation.runId, 901, "a newer run replaces the recorded one");
assert.equal(rerun.validation.conclusion, "failure");

const promoted = mergeGithubFact(rerun, promotion, 3_000);
assert.equal(promoted.promotion.dispatchKey, "dispatch-work-42");
assert.equal(promoted.validation.runId, 901, "promotion facts never disturb validation facts");
const corroborated = mergeGithubFact(promoted, candidate, 4_000);
assert.equal(corroborated.candidate.headSha, SHA_A);
assert.equal(mergeGithubFact(corroborated, candidate, 5_000), null, "candidate corroboration is idempotent per head revision");
assert.equal(mergeGithubFact(corroborated, { ...candidate, headSha: SHA_B, number: 56 }, 5_000).candidate.number, 56, "a restacked candidate replaces the corroboration");

// ---- fast lane merge: merged join key, then the deploy run rides in ----
const withMerge = mergeGithubFact(corroborated, merged, 6_000);
assert.deepEqual(withMerge.merged, { number: 55, url: "https://github.com/callil/autonomous-live-chat/pull/55", headSha: SHA_A, branch: "app-harness-os/42/g1", mergeCommitSha: MERGE_SHA, at: 6_000 });
assert.equal(withMerge.validation.runId, 901, "the merged fact never disturbs recorded workflow evidence");
assert.equal(mergeGithubFact(withMerge, merged, 7_000), null, "a redelivered merged fact adds nothing: a candidate merges exactly once");
const withDeploy = mergeGithubFact(withMerge, mainDeploy, 8_000);
assert.deepEqual(withDeploy.mainDeploy, { runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: MERGE_SHA, at: 8_000 }, "the main deploy run records under its own key");
assert.equal(mergeGithubFact(withDeploy, mainDeploy, 9_000), null, "a redelivered identical deploy run adds nothing");
assert.equal(mergeGithubFact(withDeploy, { ...mainDeploy, conclusion: null }, 9_000), null, "a null conclusion never downgrades recorded deploy evidence");
assert.equal(mergeGithubFact(withDeploy, { ...mainDeploy, runId: 902, createdAt: "2026-08-06T22:00:00Z", conclusion: "failure" }, 9_000).mainDeploy.runId, 902, "a newer deploy run replaces the recorded one");

// ---- transport dedupe: delivery GUID markers with bounded retention ----
assert.equal(normalizeGithubDeliveryId("72d3162e-cc78-11e3-81ab-4c9367dc0958"), "72d3162e-cc78-11e3-81ab-4c9367dc0958");
assert.equal(normalizeGithubDeliveryId("../escape"), null);
assert.equal(normalizeGithubDeliveryId(42), null);
assert.equal(githubDeliveryMarkerKey("guid-1"), "github-delivery:guid-1");
assert.equal(expiredGithubDeliveryMarker({ at: 0 }, GITHUB_DELIVERY_RETENTION_MS - 1), false, "markers survive the seven-day redelivery window");
assert.equal(expiredGithubDeliveryMarker({ at: 0 }, GITHUB_DELIVERY_RETENTION_MS), true, "markers past seven days are prunable");
assert.equal(expiredGithubDeliveryMarker(undefined, 0), true, "a malformed marker is prunable, never trusted");

console.log("github webhook fact extraction, matching, monotonic merge, and dedupe contracts passed");
