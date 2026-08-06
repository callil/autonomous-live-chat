import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.ts";

const secret = "test-assertion-secret";
const env = {
	ALLOWED_REPOSITORY: "callil/autonomous-live-chat",
	PRODUCTION_ORIGIN: "https://autonomous-live-chat.coda-a.workers.dev",
	GIT_PROXY_ASSERTION_SECRET: secret,
	GITHUB_APP_ID: "1",
	GITHUB_APP_INSTALLATION_ID: "1",
	GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
};

function base64Url(value) {
	return Buffer.from(value).toString("base64url");
}

function assertion() {
	const payload = base64Url(JSON.stringify({
		iss: "app-harness-os-native-git",
		jobId: "bridge-test",
		repository: "callil/autonomous-live-chat",
		generation: 1,
		exp: Math.floor(Date.now() / 1000) + 60,
	}));
	return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

async function request(path, body, signed = true) {
	return worker.fetch(new Request(`https://bridge.example${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(signed ? { "x-app-harness-assertion": assertion() } : {}),
		},
		body: JSON.stringify(body),
	}), env);
}

assert.equal((await request("/v1/issues", { eventId: "event-1", title: "A", body: "B", classification: "triage" }, false)).status, 404, "the bridge is default-deny without a signed assertion");
assert.equal((await request("/v1/issues", { eventId: "bad event", title: "A", body: "B", classification: "triage" })).status, 404, "event markers must be bounded and stable");
assert.equal((await request("/v1/issues/12/classification", { eventId: "event-1", classification: "arbitrary-label" })).status, 404, "callers cannot inject arbitrary labels");
assert.equal((await request("/v1/issues/12/close-after-deployment", { eventId: "event-1", body: "done", deploymentUrl: "https://example.com" })).status, 404, "closing is limited to the configured production origin");
assert.equal((await request("/v1/issues", { eventId: "event-1", title: "A", body: "B", classification: "triage" })).status, 503, "a valid shape reaches only the internal GitHub App authentication boundary");

console.log("GitHub App identity bridge contracts passed");
