import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { handleGithubWebhook, verifyGithubWebhookSignature } from "../src/webhook.ts";

const SECRET = "webhook-shared-secret";
const SHA_A = "a".repeat(40);
const RUN_URL = "https://github.com/callil/autonomous-live-chat/actions/runs/900";
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

function sign(body, secret = SECRET) {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeEnv(ledgerBehavior) {
	const calls = [];
	return {
		calls,
		env: {
			ALLOWED_REPOSITORY: "callil/autonomous-live-chat",
			PRODUCTION_ORIGIN: "https://autonomous-live-chat.coda-a.workers.dev",
			GITHUB_APP_ID: "1",
			GITHUB_APP_INSTALLATION_ID: "1",
			GITHUB_APP_PRIVATE_KEY: "unused",
			GITHUB_WEBHOOK_SECRET: SECRET,
			LEDGER: {
				async ingestExternalFact(input) {
					calls.push(input);
					if (ledgerBehavior === "throw") throw new Error("ledger unavailable");
					return { accepted: ledgerBehavior !== "unmatched" };
				},
			},
		},
	};
}

function deliver(env, { event, payload, delivery = DELIVERY, signature }) {
	const body = JSON.stringify(payload);
	return handleGithubWebhook(new Request("https://app-harness-os-git-proxy.coda-a.workers.dev/github/webhook", {
		method: "POST",
		headers: {
			"X-GitHub-Event": event,
			"X-GitHub-Delivery": delivery,
			"X-Hub-Signature-256": signature ?? sign(body),
		},
		body,
	}), env);
}

const repository = { full_name: "callil/autonomous-live-chat" };
const validationPayload = {
	action: "completed",
	repository,
	workflow_run: {
		id: 900,
		html_url: RUN_URL,
		conclusion: "success",
		created_at: "2026-08-06T20:00:00Z",
		event: "pull_request_target",
		path: ".github/workflows/os-stack-ci.yml",
		head_branch: "app-harness-os/42/g1",
		head_sha: SHA_A,
	},
};

// ---- signature verification: constant-time HMAC, 401 before any parsing ----
const body = JSON.stringify(validationPayload);
assert.equal(await verifyGithubWebhookSignature(SECRET, body, sign(body)), true, "a correctly signed body verifies");
assert.equal(await verifyGithubWebhookSignature(SECRET, body, sign(body, "other-secret")), false, "a signature under another key is refused");
assert.equal(await verifyGithubWebhookSignature(SECRET, body, "sha256=zz"), false, "a malformed signature header is refused");
assert.equal(await verifyGithubWebhookSignature(SECRET, body, null), false, "a missing signature header is refused");
assert.equal(await verifyGithubWebhookSignature(undefined, body, sign(body)), false, "an unprovisioned secret verifies nothing");

{
	const { env, calls } = makeEnv();
	const response = await deliver(env, { event: "workflow_run", payload: validationPayload, signature: sign("tampered") });
	assert.equal(response.status, 401, "a bad signature is 401");
	assert.equal(calls.length, 0, "an unauthenticated delivery never reaches the ledger");
}

// ---- filtering: repository gate and event table, 204 with no ledger call ----
{
	const { env, calls } = makeEnv();
	assert.equal((await deliver(env, { event: "workflow_run", payload: { ...validationPayload, repository: { full_name: "someone/else" } } })).status, 204, "another repository is dropped");
	assert.equal((await deliver(env, { event: "workflow_run", payload: { ...validationPayload, action: "requested" } })).status, 204, "an uncompleted run is dropped");
	assert.equal((await deliver(env, { event: "pull_request", payload: { action: "opened", repository, pull_request: { number: 5, html_url: "https://github.com/callil/autonomous-live-chat/pull/5", head: { ref: "feature/x", sha: SHA_A } } } })).status, 204, "a pull request outside the candidate namespace is dropped");
	assert.equal((await deliver(env, { event: "workflow_run", payload: validationPayload, delivery: "../bad" })).status, 204, "a malformed delivery GUID cannot be deduped and is dropped");
	assert.equal(calls.length, 0, "filtered deliveries never reach the ledger");
}

// ---- ingest: 200 with the exact fact envelope ----
{
	const { env, calls } = makeEnv();
	const response = await deliver(env, { event: "workflow_run", payload: validationPayload });
	assert.equal(response.status, 200, "an ingested fact is 200");
	assert.deepEqual(calls, [{
		source: "github",
		deliveryId: DELIVERY,
		fact: { kind: "validation", runId: 900, url: RUN_URL, conclusion: "success", createdAt: "2026-08-06T20:00:00Z", headSha: SHA_A },
	}], "the ledger receives the delivery GUID and the extracted validation fact");
}
{
	const { env, calls } = makeEnv();
	const promotionPayload = {
		action: "completed",
		repository,
		workflow_run: { id: 901, html_url: RUN_URL, conclusion: "success", created_at: "2026-08-06T21:00:00Z", event: "workflow_dispatch", path: ".github/workflows/os-stack-promote.yml", display_title: "App Harness promotion · dispatch-work-42" },
	};
	assert.equal((await deliver(env, { event: "workflow_run", payload: promotionPayload })).status, 200);
	assert.equal(calls[0].fact.kind, "promotion");
	assert.equal(calls[0].fact.dispatchKey, "dispatch-work-42", "the promotion fact carries the durable dispatch key parsed from the deterministic run-name");
}
{
	const { env, calls } = makeEnv();
	const pullPayload = { action: "opened", repository, pull_request: { number: 55, html_url: "https://github.com/callil/autonomous-live-chat/pull/55", head: { ref: "app-harness-os/42/g1", sha: SHA_A } } };
	assert.equal((await deliver(env, { event: "pull_request", payload: pullPayload })).status, 200);
	assert.deepEqual(calls[0].fact, { kind: "candidate", number: 55, url: "https://github.com/callil/autonomous-live-chat/pull/55", headSha: SHA_A, branch: "app-harness-os/42/g1" }, "an opened candidate pull request is forwarded as a corroborating fact");
}

// ---- ledger outcomes: unmatched is 204, an RPC failure is a visible 500 ----
{
	const { env } = makeEnv("unmatched");
	assert.equal((await deliver(env, { event: "workflow_run", payload: validationPayload })).status, 204, "a verified but unmatched fact is 204");
}
{
	const { env } = makeEnv("throw");
	assert.equal((await deliver(env, { event: "workflow_run", payload: validationPayload })).status, 500, "a ledger RPC failure surfaces as 500 in the App's Recent Deliveries panel");
}

// ---- wiring: the route and the private binding actually exist ----
const entrypoint = await readFile(new URL("../src/entrypoint.ts", import.meta.url), "utf8");
assert.match(entrypoint, /\/github\/webhook/u, "the default fetch routes the webhook path");
assert.match(entrypoint, /handleGithubWebhook/u, "the route delegates to the tested receiver");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
assert.match(wrangler, /"binding": "LEDGER", "service": "autonomous-live-chat", "entrypoint": "LedgerService"/u, "the bridge binds the ledger over a private service binding");

console.log("github webhook receiver verification, filtering, and ledger delivery contracts passed");
