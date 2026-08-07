import { extractGithubWebhookFact, normalizeGithubDeliveryId, type GithubWebhookFact } from "@app-harness/contracts/webhook";
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

/** One bounded log line per lost delivery, so losses are visible in a tail. */
function logDroppedDelivery(deliveryId: string, event: string | null, payload: Record<string, unknown>, why: string): void {
	const run = payload.workflow_run as { path?: unknown } | undefined;
	console.log("GitHub webhook delivery dropped.", {
		deliveryId,
		event: String(event ?? "").slice(0, 40),
		action: String(payload.action ?? "").slice(0, 40),
		...(typeof run?.path === "string" ? { workflow: run.path.slice(0, 80) } : {}),
		why,
	});
}

/**
 * POST /github/webhook. Response contract: 401 bad signature, 204 filtered or
 * unmatched, 200 ingested, 500 on ledger RPC failure (visible in the GitHub
 * App's Recent Deliveries panel; the ledger's paced revival poll is the
 * recovery path because GitHub does not auto-retry).
 *
 * The resolver recovers a promotion dispatch key by re-reading a run whose
 * webhook payload carried an unrendered display_title. The entrypoint — the
 * sole production caller — injects the App capability's resolver; omitting it
 * (as pure filtering tests may) makes an unrendered promotion title a logged
 * drop.
 */
export async function handleGithubWebhook(
	request: Request,
	env: GitHubBridgeEnv,
	resolvePromotionDispatchKey?: (runId: number) => Promise<string | null>,
): Promise<Response> {
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
	const event = request.headers.get("X-GitHub-Event");
	const extracted = extractGithubWebhookFact({ event, payload });
	if (!extracted) {
		// Only the subscribed event kinds are worth a tail line; everything else
		// is outside the push contract by design.
		if (event === "workflow_run" || event === "pull_request") logDroppedDelivery(deliveryId, event, payload, "no-fact");
		return new Response(null, { status: 204 });
	}
	let fact: GithubWebhookFact;
	if (extracted.kind === "promotion" && extracted.dispatchKey === null) {
		// The payload's display_title did not render the deterministic run-name:
		// recover the durable identity by re-reading the run through the App
		// capability. If it still has no promotion identity, drop visibly — the
		// operator loop's promoting-phase observation is the backstop.
		let dispatchKey: string | null = null;
		try {
			dispatchKey = resolvePromotionDispatchKey ? await resolvePromotionDispatchKey(extracted.runId) : null;
		} catch (error) {
			console.error("GitHub webhook promotion dispatch-key resolution failed.", { deliveryId, runId: extracted.runId, error });
		}
		if (!dispatchKey) {
			logDroppedDelivery(deliveryId, event, payload, "promotion-dispatch-key-unresolvable");
			return new Response(null, { status: 204 });
		}
		fact = { ...extracted, dispatchKey };
	} else {
		fact = extracted as GithubWebhookFact;
	}
	try {
		const outcome = await env.LEDGER.ingestExternalFact({ source: "github", deliveryId, fact });
		if (!outcome.accepted) logDroppedDelivery(deliveryId, event, payload, `unmatched:${fact.kind}`);
		return outcome.accepted ? Response.json({ accepted: true }) : new Response(null, { status: 204 });
	} catch (error) {
		console.error("GitHub webhook ledger ingest failed.", { deliveryId, kind: fact.kind, error });
		return new Response("Ledger ingest failed", { status: 500 });
	}
}
