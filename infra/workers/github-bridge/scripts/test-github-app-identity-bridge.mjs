import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import worker from "../src/index.ts";

const nativeSecret = "test-native-assertion-secret";
const identitySecret = "test-identity-assertion-secret";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const env = {
	ALLOWED_REPOSITORY: "callil/autonomous-live-chat",
	PRODUCTION_ORIGIN: "https://autonomous-live-chat.coda-a.workers.dev",
	GIT_PROXY_ASSERTION_SECRET: nativeSecret,
	APP_HARNESS_IDENTITY_SECRET: identitySecret,
	GITHUB_APP_ID: "1",
	GITHUB_APP_INSTALLATION_ID: "1",
	GITHUB_APP_PRIVATE_KEY: privateKey,
};

function base64Url(value) {
	return Buffer.from(value).toString("base64url");
}

function signed(payload, secret) {
	const body = base64Url(JSON.stringify(payload));
	return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function nativeAssertion() {
	return signed({ iss: "app-harness-os-native-git", jobId: "native-test", repository: env.ALLOWED_REPOSITORY, generation: 1, exp: Math.floor(Date.now() / 1000) + 60 }, nativeSecret);
}

function coordinatorAssertion() {
	return signed({ iss: "app-harness-coordinator", workItemId: "work-42", repository: env.ALLOWED_REPOSITORY, exp: Math.floor(Date.now() / 1000) + 60 }, identitySecret);
}

async function request(path, body, assertion = coordinatorAssertion()) {
	return worker.fetch(new Request(`https://bridge.example${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(assertion ? { "x-app-harness-coordinator-assertion": assertion } : {}) },
		body: JSON.stringify(body),
	}), env);
}

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input, init = {}) => {
	const url = typeof input === "string" ? input : input.url;
	const method = init.method ?? (typeof input === "string" ? "GET" : input.method);
	calls.push({ url, method, body: init.body });
	if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
	if (url.includes("/search/issues")) return Response.json(url.includes("event-markdown") || url.includes("event-long") ? { items: [] } : { items: [{ number: 42, html_url: "https://github.com/callil/autonomous-live-chat/issues/42" }] });
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
	assert.equal((await request("/v1/issues", { eventId: "event-1", title: "A", body: "B", classification: "triage" }, null)).status, 404, "identity endpoints are default-deny without a coordinator assertion");
	assert.equal((await request("/v1/issues", { eventId: "event-1", title: "A", body: "B", classification: "triage" }, nativeAssertion())).status, 404, "native Git assertions cannot call identity endpoints");
	const duplicate = await request("/v1/issues", { eventId: "event-1", title: "A", body: "B", classification: "triage" });
	assert.deepEqual(await duplicate.json(), { issueNumber: 42, issueUrl: "https://github.com/callil/autonomous-live-chat/issues/42", existing: true }, "retries return the issue carrying the stable event marker");
	assert.equal(calls.filter((call) => call.url.endsWith("/issues") && call.method === "POST").length, 0, "a duplicate event never creates another issue");
	const markdown = await request("/v1/issues", { eventId: "event-markdown", title: "Targeted request", body: "Target: `message-input`\nSelector: `[data-target-id=\"message-input\"]`", classification: "agent" });
	assert.deepEqual(await markdown.json(), { issueNumber: 43, issueUrl: "https://github.com/callil/autonomous-live-chat/issues/43" }, "Markdown issue bodies are accepted");
	const longBody = `oversized-full-representation ${"x".repeat(100_000)}`;
	const represented = await request("/v1/issues", { eventId: "event-long", title: "Long durable request", body: longBody, classification: "agent" });
	assert.equal(represented.status, 200, "oversized GitHub representations retain a transport-safe view");
	const representedCalls = calls.filter((call) => call.url.endsWith("/issues") && call.method === "POST").slice(-2);
	assert.match(JSON.parse(representedCalls[0].body).body, /oversized-full-representation/u, "the complete durable text is attempted first");
	assert.match(JSON.parse(representedCalls[1].body).body, /full text remains preserved in durable App Harness work item `event-long`/u, "an explicit GitHub validation rejection falls back to a durable reference");
	assert.equal((await request("/v1/issues/42/classification", { eventId: "event-2", classification: "triage", modelClassification: { changeType: "visual", scope: "localized", risk: "low", affectedSurface: "ui", reversible: true, executionEligibility: "eligible", ciProfile: "visual" } })).status, 200);
	const labelPatch = calls.findLast((call) => call.url.endsWith("/issues/42") && call.method === "PATCH");
	assert.deepEqual(JSON.parse(labelPatch.body).labels, ["human-label", "app-harness", "triage", "change-visual", "scope-localized", "risk-low", "surface-ui", "reversible-yes", "execution-eligible", "ci-visual"], "classification labels converge while unrelated labels remain");
	assert.equal((await request("/v1/issues/42/classification", { eventId: "event-2", classification: "triage", modelClassification: { changeType: "arbitrary", scope: "localized", risk: "low", affectedSurface: "ui", reversible: true, executionEligibility: "eligible", ciProfile: "visual" } })).status, 404, "model classification cannot inject arbitrary label values");
} finally {
	globalThis.fetch = originalFetch;
}

console.log("GitHub App identity bridge contracts passed");
