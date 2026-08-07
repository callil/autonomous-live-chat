import { extractGithubWebhookFact, normalizeGithubDeliveryId } from "@app-harness/contracts/webhook";
import type { GitHubBridgeEnv } from "./index";

/**
 * GitHub webhook receiver. The bridge terminates the GitHub-facing trust
 * boundary (it already solely owns the App identity), verifies the delivery,
 * filters it down to one fact, and forwards it to the ledger over the private
 * LEDGER service binding. It never writes work-item state itself: the ledger
 * records the fact and wakes the operator, which stages the actual transition.
 */

const encoder = new TextEncoder();
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/u;
// workflow_run and pull_request payloads are tens of kilobytes; anything
// larger is outside the contract and not worth hashing.
const MAX_WEBHOOK_BODY_CHARS = 1_000_000;

/** Constant-time HMAC-SHA-256 verification of the raw delivery body. */
export async function verifyGithubWebhookSignature(secret: string | undefined, body: string, header: string | null): Promise<boolean> {
	if (!secret || typeof header !== "string") return false;
	const match = SIGNATURE_HEADER.exec(header);
	if (!match) return false;
	const digest = match[1];
	const signature = new Uint8Array(32);
	for (let index = 0; index < 32; index += 1) signature[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	// crypto.subtle.verify performs the constant-time comparison itself.
	return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

/**
 * POST /github/webhook. Response contract: 401 bad signature, 204 filtered or
 * unmatched, 200 ingested, 500 on ledger RPC failure (visible in the GitHub
 * App's Recent Deliveries panel; the ledger's paced revival poll is the
 * recovery path because GitHub does not auto-retry).
 */
export async function handleGithubWebhook(request: Request, env: GitHubBridgeEnv): Promise<Response> {
	const body = await request.text();
	if (body.length > MAX_WEBHOOK_BODY_CHARS) return new Response(null, { status: 204 });
	if (!(await verifyGithubWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
		return new Response("Invalid signature", { status: 401 });
	}
	const deliveryId = normalizeGithubDeliveryId(request.headers.get("X-GitHub-Delivery"));
	if (!deliveryId) return new Response(null, { status: 204 });
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return new Response(null, { status: 204 });
	}
	const repository = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
	if (repository !== env.ALLOWED_REPOSITORY) return new Response(null, { status: 204 });
	const fact = extractGithubWebhookFact({ event: request.headers.get("X-GitHub-Event"), payload });
	if (!fact) return new Response(null, { status: 204 });
	try {
		const outcome = await env.LEDGER.ingestExternalFact({ source: "github", deliveryId, fact });
		return outcome.accepted ? Response.json({ accepted: true }) : new Response(null, { status: 204 });
	} catch (error) {
		console.error("GitHub webhook ledger ingest failed.", { deliveryId, kind: fact.kind, error });
		return new Response("Ledger ingest failed", { status: 500 });
	}
}
