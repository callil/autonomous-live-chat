import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GitHubCapability } from "../src/index.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const env = {
	ALLOWED_REPOSITORY: "callil/autonomous-live-chat",
	PRODUCTION_ORIGIN: "https://autonomous-live-chat.coda-a.workers.dev",
	GITHUB_APP_ID: "1",
	GITHUB_APP_INSTALLATION_ID: "1",
	GITHUB_APP_PRIVATE_KEY: privateKey,
};
const capability = new GitHubCapability(env);
const originalFetch = globalThis.fetch;
const calls = [];

globalThis.fetch = async (input, init = {}) => {
	const url = typeof input === "string" ? input : input.url;
	const method = init.method ?? (typeof input === "string" ? "GET" : input.method);
	calls.push({ url, method, body: init.body });
	if (url.includes("/access_tokens")) return Response.json({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" });
	if (url.includes("/issues?state=all")) {
		if (url.includes("never")) return Response.json([]);
		return Response.json([{ number: 42, html_url: "https://github.com/callil/autonomous-live-chat/issues/42", body: "<!-- app-harness-event:event-1 -->" }]);
	}
	if (url.includes("/search/issues")) return Response.json(url.includes("event-markdown") || url.includes("event-long") ? { items: [] } : { items: [{ number: 42, html_url: "https://github.com/callil/autonomous-live-chat/issues/42" }] });
	if (url === `${env.PRODUCTION_ORIGIN}/`) return new Response("live");
	if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "a".repeat(40) } });
	if (url.includes("/pulls?")) {
		const query = new URL(url).searchParams;
		return Response.json(query.get("head") === "callil:app-harness-os/42/g1" ? [{ number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", state: "open", head: { ref: "app-harness-os/42/g1", sha: "b".repeat(40) }, base: { ref: "main" } }] : []);
	}
	if (url.endsWith("/actions/workflows/os-stack-promote.yml/dispatches") && method === "POST") {
		const body = JSON.parse(init.body);
		assert.equal(body.inputs.dispatch_key, "dispatch-work-42", "the immutable durable dispatch key is forwarded to Actions");
		assert.deepEqual(Object.keys(body.inputs).sort(), ["ci_profile", "dispatch_key", "generation", "head_sha", "issue_number", "parent_branch", "pull_request", "stack_id"], "Actions receives only the explicit promotion contract");
		return new Response(null, { status: 204 });
	}
	if (url.includes("/actions/workflows/os-stack-promote.yml/runs?")) return Response.json({ workflow_runs: [{ id: 124, status: "completed", conclusion: "success", html_url: "https://github.com/callil/autonomous-live-chat/actions/runs/124", display_title: "App Harness promotion · dispatch-work-42", created_at: "2026-08-06T20:00:00Z" }] });
	if (url.includes("/actions/workflows/os-stack-ci.yml/runs?")) return Response.json({ workflow_runs: [{ id: 122, status: "completed", conclusion: "success", html_url: "https://github.com/callil/autonomous-live-chat/actions/runs/122", display_title: "App Harness candidate · PR", head_sha: "b".repeat(40), created_at: "2026-08-06T19:58:00Z", event: "pull_request_target", path: ".github/workflows/os-stack-ci.yml@main" }] });
	if (url.endsWith("/actions/runs/123")) return Response.json({ status: "completed", conclusion: "success", html_url: "https://github.com/callil/autonomous-live-chat/actions/runs/123" });
	if (url.endsWith("/issues/42/comments?per_page=100")) return Response.json([{ id: 900, body: "Previous status\n\n<!-- app-harness-event:event-close -->" }]);
	if (url.endsWith("/issues/comments/900") && method === "PATCH") return Response.json({ id: 900 });
	if (url.endsWith("/issues") && method === "POST") {
		const body = JSON.parse(init.body);
		if (body.body.includes("oversized-full-representation")) return new Response("unprocessable", { status: 422 });
		return Response.json({ number: 43, html_url: "https://github.com/callil/autonomous-live-chat/issues/43" });
	}
	if (url.endsWith("/issues/42") && method === "GET") return Response.json({ labels: [{ name: "human-label" }, { name: "triage" }, { name: "change-content" }, { name: "risk-high" }] });
	if (url.endsWith("/issues/42") && method === "PATCH") return Response.json({ number: 42 });
	throw new Error(`Unexpected fetch ${method} ${url}`);
};

try {
	const duplicate = await capability.createIssue({ eventId: "event-1", title: "A", body: "B", classification: "triage" });
	assert.deepEqual(duplicate, { issueNumber: 42, issueUrl: "https://github.com/callil/autonomous-live-chat/issues/42", existing: true }, "retries return the issue carrying the stable event marker");
	assert.equal(calls.filter((call) => call.url.endsWith("/issues") && call.method === "POST").length, 0, "a duplicate event never creates another issue");
	assert.equal(calls.filter((call) => call.url.includes("/search/issues")).length, 0, "a just-created issue is reconciled from the read-after-write repository listing without waiting for search indexing");
	const markdown = await capability.createIssue({ eventId: "event-markdown", title: "Targeted request", body: "Target: `message-input`\nSelector: `[data-target-id=\"message-input\"]`", classification: "agent" });
	assert.deepEqual(markdown, { issueNumber: 43, issueUrl: "https://github.com/callil/autonomous-live-chat/issues/43" }, "Markdown issue bodies are accepted");
	const longBody = `oversized-full-representation ${"x".repeat(100_000)}`;
	await capability.createIssue({ eventId: "event-long", title: "Long durable request", body: longBody, classification: "agent" });
	const representedCalls = calls.filter((call) => call.url.endsWith("/issues") && call.method === "POST").slice(-2);
	assert.match(JSON.parse(representedCalls[0].body).body, /oversized-full-representation/u, "the complete durable text is attempted first");
	assert.match(JSON.parse(representedCalls[1].body).body, /full text remains preserved in durable App Harness work item `event-long`/u, "an explicit GitHub validation rejection falls back to a durable reference");
	await capability.updateClassification({ issueNumber: 42, classification: "triage", modelClassification: { changeType: "visual", scope: "localized", risk: "low", affectedSurface: "ui", reversible: true, executionEligibility: "eligible", ciProfile: "visual" } });
	const labelPatch = calls.findLast((call) => call.url.endsWith("/issues/42") && call.method === "PATCH");
	assert.deepEqual(JSON.parse(labelPatch.body).labels, ["human-label", "app-harness", "triage", "change-visual", "scope-localized", "risk-low", "surface-ui", "reversible-yes", "execution-eligible", "ci-visual"], "classification labels converge while unrelated labels remain");
	await assert.rejects(() => capability.updateClassification({ issueNumber: 42, classification: "triage", modelClassification: { changeType: "arbitrary", scope: "localized", risk: "low", affectedSurface: "ui", reversible: true, executionEligibility: "eligible", ciProfile: "visual" } }), /Invalid classification/u, "model classification cannot inject arbitrary label values");
	const closed = await capability.closeAfterDeployment({ issueNumber: 42, eventId: "event-close", body: "Completed and deployed.", deploymentUrl: env.PRODUCTION_ORIGIN });
	assert.deepEqual(closed, { issueNumber: 42, state: "closed", deploymentUrl: `${env.PRODUCTION_ORIGIN}/` }, "the GitHub App projects verified completion and closes the issue");
	const completionPatches = calls.filter((call) => call.url.endsWith("/issues/42") && call.method === "PATCH").slice(-2).map((call) => JSON.parse(call.body));
	assert.deepEqual(completionPatches, [{ labels: ["human-label", "app-harness", "deployed"] }, { state: "closed" }], "completion converges labels before closing the issue");
	assert.match(JSON.parse(calls.find((call) => call.url.endsWith("/issues/comments/900") && call.method === "PATCH").body).body, /Verified reachable deployment/u);
	assert.deepEqual(await capability.getMainSha(), { sha: "a".repeat(40) }, "the operator can observe immutable main state through the private capability");
	assert.deepEqual(await capability.getCandidate({ branch: "app-harness-os/42/g1", pullRequestBase: "main" }), { number: 55, url: "https://github.com/callil/autonomous-live-chat/pull/55", headSha: "b".repeat(40), base: "main", state: "open" }, "the operator can reconcile an exact candidate branch without storing PR state elsewhere");
	assert.equal(await capability.getCandidate({ branch: "app-harness-os/missing/g1", pullRequestBase: "main" }), null, "a missing candidate remains an observation rather than a synthetic state transition");
	assert.deepEqual(await capability.observeCandidateValidation({ pullRequest: 55, headSha: "b".repeat(40) }), { runId: 122, status: "completed", conclusion: "success", url: "https://github.com/callil/autonomous-live-chat/actions/runs/122", createdAt: "2026-08-06T19:58:00Z" }, "the operator can observe immutable candidate validation by its deterministic title");
	assert.deepEqual(await capability.dispatchPromotion({ pullRequest: 42, stackId: "stack-42", generation: 1, issueNumber: 42, parentBranch: "main", headSha: "b".repeat(40), dispatchKey: "dispatch-work-42", ciProfile: "behavior" }), { dispatchKey: "dispatch-work-42", dispatched: true }, "the operator can request deterministic promotion through the private capability");
	assert.deepEqual(await capability.observeWorkflowRun({ runId: 123 }), { runId: 123, status: "completed", conclusion: "success", url: "https://github.com/callil/autonomous-live-chat/actions/runs/123" }, "the operator can observe trusted GitHub workflow state");
	assert.deepEqual(await capability.findPromotionRun({ dispatchKey: "dispatch-work-42", createdAfter: "2026-08-06T19:59:00Z" }), { runId: 124, status: "completed", conclusion: "success", url: "https://github.com/callil/autonomous-live-chat/actions/runs/124", createdAt: "2026-08-06T20:00:00Z" }, "the operator can find a promotion by its deterministic display title");
	assert.equal(await capability.findPromotionRun({ dispatchKey: "dispatch-missing" }), null, "an undispatched promotion remains absent rather than becoming local workflow state");
	await assert.rejects(() => capability.dispatchPromotion({ pullRequest: 42, stackId: "stack-42", generation: 1, issueNumber: 42, parentBranch: "main", headSha: "b".repeat(40), dispatchKey: "not valid", ciProfile: "behavior" }), /Invalid promotion dispatch/u, "a request cannot make ambiguous workflow evidence");
	assert.deepEqual(await capability.createRunnerToken({ repository: env.ALLOWED_REPOSITORY, jobId: "job-1", generation: 1 }), { token: "installation-token", expiresAt: "2099-01-01T00:00:00Z" }, "the runner receives only a short-lived repository token");
	await assert.rejects(() => capability.createRunnerToken({ repository: "other/repo", jobId: "job-1", generation: 1 }), /outside the installed repository scope/u, "the capability refuses another repository");
} finally {
	globalThis.fetch = originalFetch;
}

console.log("GitHub App private RPC capability contracts passed");
