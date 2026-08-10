import { DurableObject } from "cloudflare:workers";
import {
	assertAppendable,
	createLedgerEvent,
	eventStorageKey,
	type LedgerEvent,
	type LedgerEventKind,
} from "../contracts/ledger.js";
import {
	assertLiveAttempt,
	beginDeploying,
	beginVerifying,
	completeRun,
	enqueueRun,
	parkExpiredRun,
	pruneTerminalRuns,
	startRun,
	type QueuedRun,
} from "../contracts/queue.js";
import {
	createIntent,
	dispatchIntent,
	recordIntentOutcome,
	retryIntent,
	underOpenIntentLimit,
	withdrawIntent,
	type Intent,
} from "../contracts/intent.js";
import { cancelDeadline, parseRequestEnvelope } from "../contracts/envelope.js";
import { classifyRunTier, type RunTier } from "../contracts/tier.js";
import { renderFeed, renderFeedItem, renderQueueChips } from "../contracts/feed.js";
import { classifyCheckRuns, includesMigrationMarker } from "../contracts/checks.js";
import { decide, type ReconcileAction } from "../contracts/reconcile.js";
import { admitRateLimited, mintSessionToken, verifySessionToken, SESSION_TTL_MS, type SessionIdentity } from "../contracts/session.js";
import { INSTALLED_TENANT } from "../contracts/tenant.js";
import { GitHubApp, observeDeployedVersion, syntheticLivenessCheck, verifyWebhookSignature } from "./github.js";
import { OpenAiDoctorPort } from "./doctor.js";
import { FALLBACK_HTML } from "./fallback.js";
import OVERLAY_CLIENT from "./overlay/overlay.client.js";
import { BindingRunnerPort, RETRYABLE_DOCTOR_KINDS, StubDoctorPort, StubRunnerPort, type DoctorCase, type DoctorCaseKind, type DoctorPort, type RunnerBinding, type RunnerPort } from "./ports.js";

type RuntimeEnv = Env & {
	ADMIN_TOKEN?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_WEBHOOK_SECRET?: string;
	OPENAI_API_KEY?: string;
};

type ClientMessage =
	| { type: "chat:send"; text?: unknown }
	| { type: "request:target" | "request:comment" | "request:draw"; text?: unknown; annotation?: unknown; clientSubmissionId?: unknown }
	| { type: "request:cancel"; intentId?: unknown }
	| { type: "harness:feedback"; text?: unknown; annotation?: unknown; clientSubmissionId?: unknown }
	| { type: "feed:history"; beforeSeq?: unknown };

type RoomControl = { frozen: boolean };
type BudgetRecord = { day: string; spentUsd: number; exhaustedAnnounced: boolean };
/** A pending revert-to-SHA: owner-requested or watchdog-triggered, executed outside the request pipeline. */
type RevertRecord = { sha: string; requestedAt: number; dispatchedAt: number | null; reason: string };
/** The post-deploy liveness window: synthetic fetches until `until`, with the previous good SHA on hand. */
type WatchdogRecord = { sha: string; until: number; migration: boolean };
/** The last two revisions the platform OBSERVED serving; `previous` is the auto-revert target. */
type GoodShaRecord = { current: string; previous: string | null };
/** A durable park case awaiting the Doctor: appended by park sites, consumed by the reconciler. */
type DoctorQueueEntry = { id: string; kind: DoctorCaseKind; runId?: string; intentId?: string; detail: string; at: number };

const EVENT_SEQUENCE_KEY = "sequence:event";
const EVENT_PREFIX = "event:";
const INTENT_PREFIX = "intent:";
const QUEUE_KEY = "queue";
const ROOM_CONTROL_KEY = "room-control";
const BUDGET_KEY = "budget";
const REVERT_KEY = "pending-revert";
const WATCHDOG_KEY = "deploy-watchdog";
const GOOD_SHA_KEY = "observed-good-sha";
const DOCTOR_QUEUE_KEY = "doctor-queue";

/** Level-triggered cadence: the reconciler re-reads state every minute no matter what. */
const RECONCILE_INTERVAL_MS = 60_000;
/**
 * The idle cadence is a safety net, not a pipeline clock. While a run is
 * actually waiting on an external system — CI to go green, the deploy to serve
 * the merged SHA — the reconciler re-reads on this much tighter cadence, so a
 * missed or delayed webhook costs seconds instead of most of a minute. Webhook
 * pokes remain the fast path; this is what makes the polling floor honest.
 */
const ACTIVE_RECONCILE_INTERVAL_MS = 5_000;
/** How soon a poke pulls the reconciler forward. */
const POKE_DELAY_MS = 1_000;
/** Snapshot depth for a fresh connection; older history pages via feed:history. */
const SNAPSHOT_EVENT_COUNT = 100;
/** Feed items carried on every feed:update broadcast so connected clients see new facts live. */
const BROADCAST_FEED_ITEMS = 30;
const MAX_MESSAGE_BYTES = 128_000;
const SHA = /^[0-9a-f]{40}$/u;
/** Per-identity chat flood ceiling (identity is the stable session id, not the display name). */
const CHAT_RATE = { limit: 20, windowMs: 60_000 };
/** Per-identity request-envelope ceiling; the 5-open-intent cap is the durable backstop. */
const REQUEST_RATE = { limit: 6, windowMs: 60_000 };
/**
 * Honest per-run cost estimate until real metering lands (the blank-slate
 * design priced a change at $0.30-0.75).
 */
const ESTIMATED_RUN_COST_USD = 0.75;
const DEFAULT_DAILY_BUDGET_USD = 25;
/** Post-deploy liveness window (task #16: health pings for 5 minutes). */
const WATCHDOG_WINDOW_MS = 5 * 60_000;
/** The product deploy leg, reused for reverts via its sha input. */
const DEPLOY_WORKFLOW_FILE = "deploy-product.yml";

const SESSION_COOKIE = "ahp_session";
const IDENTITY_ID_HEADER = "x-ahp-session-id";
const IDENTITY_NAME_HEADER = "x-ahp-session-name";

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

/**
 * Best-effort constant-time string comparison for the owner's admin bearer,
 * matching the doctrine the webhook and session verifiers already follow
 * (their comparisons ride crypto.subtle.verify). Length still leaks; bytes
 * do not.
 */
function fixedTimeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) return false;
	let diff = 0;
	for (let index = 0; index < left.byteLength; index += 1) diff |= left[index] ^ right[index];
	return diff === 0;
}

function budgetDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** The per-phase durations a run-timing fact may carry. */
const TIMING_PHASES = ["bootMs", "cloneMs", "agentMs", "testMs", "pushMs", "prMs", "totalMs"] as const;
/** A day of milliseconds: any "duration" beyond this is a broken clock, not a slow run. */
const MAX_TIMING_MS = 86_400_000;

/**
 * Accept only sane, bounded per-phase durations from the builder's report.
 * Timings are measurement, not truth the pipeline acts on, so anything
 * malformed is dropped rather than allowed to poison the ledger.
 */
function sanitizeTimings(value: unknown): Record<string, number> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	const timing: Record<string, number> = {};
	for (const phase of TIMING_PHASES) {
		const raw = source[phase];
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_TIMING_MS) continue;
		timing[phase] = Math.round(raw);
	}
	return Object.keys(timing).length ? timing : null;
}

/**
 * The Room Durable Object: single-threaded owner of the append-only event
 * ledger, the strict FIFO singleton build queue, intent records, and the feed
 * projection. Webhooks and client actions only append facts and pull the
 * alarm forward; the 60-second level-triggered reconciler re-reads durable state and
 * drives the delta through the pure decide() policy. No model output enters
 * this truth path — the Doctor's verdict is constrained to a typed
 * disposition plus a public note that renders as exactly that.
 */
export class RoomDO extends DurableObject<RuntimeEnv> {
	private readonly runnerPort: RunnerPort;
	private readonly doctorPort: DoctorPort;
	/** In-memory flood windows keyed on the stable session id; durable caps back them up. */
	private readonly chatWindows = new Map<string, number[]>();
	private readonly requestWindows = new Map<string, number[]>();

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		const binding = env.RUNNER as unknown as RunnerBinding | undefined;
		this.runnerPort = binding ? new BindingRunnerPort(binding as RunnerBinding) : new StubRunnerPort();
		// The real Doctor rides the OPENAI_API_KEY secret (the same credential
		// the platform runner's agent uses); without it the deterministic stub
		// parks every deviation for a human (fail-open).
		this.doctorPort = env.OPENAI_API_KEY ? new OpenAiDoctorPort(env.OPENAI_API_KEY) : new StubDoctorPort();
		this.ctx.blockConcurrencyWhile(async () => {
			await this.scheduleReconcile(Date.now() + RECONCILE_INTERVAL_MS);
		});
	}

	/** The GitHub App capability, or null while its secrets are not provisioned. */
	private githubApp(): GitHubApp | null {
		const { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY } = this.env;
		if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID || !GITHUB_APP_PRIVATE_KEY) return null;
		return new GitHubApp({
			repository: this.env.REPOSITORY,
			appId: GITHUB_APP_ID,
			installationId: GITHUB_APP_INSTALLATION_ID,
			privateKey: GITHUB_APP_PRIVATE_KEY,
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
		// Identity was verified by the Worker in front of this DO (signed
		// session cookie); the DO trusts only these internal headers.
		const id = request.headers.get(IDENTITY_ID_HEADER);
		const name = request.headers.get(IDENTITY_NAME_HEADER);
		if (!id || !name) return new Response("A signed session is required.", { status: 401 });
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		// Hibernation-safe identity: the attachment survives eviction.
		server.serializeAttachment({ id, name } satisfies { id: string; name: string });
		const snapshot = await this.snapshot();
		server.send(JSON.stringify({ ...snapshot, you: { id, name } }));
		return new Response(null, { status: 101, webSocket: client });
	}

	async alarm(): Promise<void> {
		await this.reconcile();
		await this.scheduleReconcile(Date.now() + (await this.nextReconcileDelayMs()));
	}

	/**
	 * How long until the reconciler MUST look again. A run parked on an
	 * external system (CI verdict, deploy observation) is polled tightly; an
	 * idle room falls back to the minute cadence. This only ever schedules the
	 * alarm — every decision still comes from re-read durable state, so the
	 * cadence can never change what the reconciler concludes, only how soon.
	 */
	private async nextReconcileDelayMs(): Promise<number> {
		// A queued run is also "active": it is waiting on nothing but this
		// reconciler, so leaving it to the idle minute cadence inserts a ~60s
		// stall between enqueue and dispatch (and between consecutive runs).
		const active = (await this.loadQueue()).find((run) => run.state === "queued" || run.state === "verifying" || run.state === "deploying");
		if (active) return ACTIVE_RECONCILE_INTERVAL_MS;
		// A pending revert is also waiting on an observation.
		const revert = await this.ctx.storage.get<RevertRecord>(REVERT_KEY);
		if (revert) return ACTIVE_RECONCILE_INTERVAL_MS;
		return RECONCILE_INTERVAL_MS;
	}

	private socketIdentity(socket: WebSocket): { id: string; name: string } | null {
		try {
			const attachment = socket.deserializeAttachment() as { id?: unknown; name?: unknown } | null;
			if (attachment && typeof attachment.id === "string" && typeof attachment.name === "string") return { id: attachment.id, name: attachment.name };
		} catch { /* fall through to null */ }
		return null;
	}

	async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
		if (typeof raw !== "string" || utf8Bytes(raw) > MAX_MESSAGE_BYTES) {
			this.notice(socket, "That message is too large. Split it into smaller parts.");
			return;
		}
		const identity = this.socketIdentity(socket);
		if (!identity) {
			this.notice(socket, "This connection carries no session; reconnect to continue.");
			return;
		}
		let message: ClientMessage;
		try { message = JSON.parse(raw) as ClientMessage; } catch { return; }
		try {
			if (message.type === "chat:send") return await this.handleChat(socket, message, identity);
			if (message.type === "request:target" || message.type === "request:comment" || message.type === "request:draw") return await this.handleRequest(socket, message, identity);
			if (message.type === "request:cancel") return await this.handleCancel(socket, message, identity);
			if (message.type === "harness:feedback") return await this.handleHarnessFeedback(socket, message, identity);
			if (message.type === "feed:history") return await this.handleHistory(socket, message);
		} catch (error) {
			this.notice(socket, error instanceof Error ? error.message : "That message could not be processed.");
		}
	}

	webSocketClose(): void {}
	webSocketError(): void {}

	/** Webhooks and external systems poke here: pull the reconciler forward, decide nothing. */
	async poke(): Promise<{ accepted: true }> {
		await this.scheduleReconcile(Date.now() + POKE_DELAY_MS);
		return { accepted: true };
	}

	/**
	 * The runner's push-based completion callback. The runId inside the
	 * payload is the bearer credential (minted per dispatch, shared only with
	 * that run's builder) and the attemptId is the zombie guard: pushes from
	 * superseded attempts are recorded nowhere and change nothing.
	 *
	 * Two payload shapes are accepted from a live attempt:
	 * - progress heartbeats { progress: true, step } -> a run-heartbeat fact;
	 * - the terminal report { state: "verifying", branch, prNumber, headSha }
	 *   or { state: "failed", reason }. The runner never reports "merged":
	 *   merging is the platform's job, after CI. A failed report parks the run
	 *   immediately and queues the case for the Doctor — the consult itself
	 *   happens in the reconciler, never in this client-driven handler.
	 */
	async ingestRunnerResult(input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }> {
		const { runId, attemptId } = input;
		if (typeof runId !== "string" || typeof attemptId !== "string") return { accepted: false, reason: "malformed" };
		const now = Date.now();

		if (input.progress === true) {
			const step = typeof input.step === "string" ? input.step.slice(0, 80) : "unspecified";
			try {
				await this.ctx.storage.transaction(async () => {
					const queue = await this.loadQueue();
					const run = assertLiveAttempt(queue, { runId, attemptId });
					await this.appendEvent("run-heartbeat", { runId, intentId: run.intentId, step }, now);
				});
			} catch (error) {
				return { accepted: false, reason: error instanceof Error ? error.message : "rejected" };
			}
			return { accepted: true };
		}

		const state = input.state;
		if (state !== "verifying" && state !== "failed") return { accepted: false, reason: "unknown-state" };
		try {
			await this.ctx.storage.transaction(async () => {
				let queue = await this.loadQueue();
				const run = assertLiveAttempt(queue, { runId, attemptId });
				if (state === "verifying") {
					const verification = { branch: input.branch, prNumber: input.prNumber, headSha: input.headSha };
					queue = beginVerifying(queue, { runId, attemptId, at: now, verification });
					await this.ctx.storage.put(QUEUE_KEY, queue);
					await this.appendEvent("run-verifying", { runId, intentId: run.intentId, ...verification }, now);
					// Measurement rides alongside the terminal report, never gating
					// it: a malformed timings block costs the fact, not the run.
					const timing = sanitizeTimings(input.timings);
					if (timing) await this.appendEvent("run-timing", { runId, intentId: run.intentId, tier: input.tier === "small" ? "small" : "normal", ...timing }, now);
				} else {
					// Once the attempt has reported "verifying" the run belongs to
					// the platform: a late "failed" push (the in-container watchdog
					// racing the job's own terminal report) must not yank a run whose
					// PR the reconciler may be merging concurrently.
					if (run.state !== "running") throw new Error("attempt-already-terminal");
					const reason = typeof input.reason === "string" ? input.reason.slice(0, 500) : "unspecified";
					queue = completeRun(queue, { runId, attemptId, state: "failed", at: now, detail: reason });
					await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
					await this.appendEvent("run-failed", { runId, intentId: run.intentId, reason }, now);
					await this.queueDoctorCase({ kind: "run-failed", runId, intentId: run.intentId, detail: `The build reported failure: ${reason}` }, now);
				}
			});
		} catch (error) {
			// Zombie or stale pushes are inert by design; say so and move on.
			return { accepted: false, reason: error instanceof Error ? error.message : "rejected" };
		}
		// The terminal report was the job's last act: release its container so
		// the bounded pool is not held hostage to the SDK's idle sleep.
		this.ctx.waitUntil(this.runnerPort.finishRun(runId));
		await this.poke();
		await this.broadcastFeed();
		return { accepted: true };
	}

	/** Owner lever: freeze pauses request intake and dispatch; chat stays open. */
	async freeze(frozen: boolean): Promise<{ frozen: boolean }> {
		const now = Date.now();
		await this.ctx.storage.transaction(async () => {
			const control = await this.loadControl();
			if (control.frozen === frozen) return;
			await this.ctx.storage.put(ROOM_CONTROL_KEY, { frozen } satisfies RoomControl);
			await this.appendEvent(frozen ? "room-frozen" : "room-unfrozen", { by: "owner" }, now);
		});
		await this.broadcastFeed();
		return { frozen };
	}

	/**
	 * Owner lever: record a revert-to-SHA request as a durable fact, bypassing
	 * the request pipeline. The reconciler executes it: it dispatches the
	 * deploy workflow at that SHA and posts rollback-observed only once the
	 * product's /version endpoint actually serves it.
	 */
	async requestRevert(sha: string): Promise<{ recorded: boolean }> {
		if (!SHA.test(sha)) throw new Error("Revert requires a full lowercase Git SHA.");
		const now = Date.now();
		await this.ctx.storage.transaction(async () => {
			await this.appendEvent("revert-requested", { sha, by: "owner" }, now);
			await this.ctx.storage.put(REVERT_KEY, { sha, requestedAt: now, dispatchedAt: null, reason: "owner-requested" } satisfies RevertRecord);
		});
		await this.poke();
		await this.broadcastFeed();
		return { recorded: true };
	}

	/**
	 * The level-triggered reconciler. It never trusts why it woke: it re-reads
	 * durable state, asks the pure decide() policy for the overdue deltas —
	 * pending Doctor cases, cancel windows elapsed, TTL-expired runs parked,
	 * verifying runs checked against CI, deploys observed, liveness enforced,
	 * the queue head dispatched — then executes them in order and reschedules.
	 */
	private async reconcile(): Promise<void> {
		const now = Date.now();
		const control = await this.loadControl();
		const budget = await this.loadBudget(now);
		const revert = (await this.ctx.storage.get<RevertRecord>(REVERT_KEY)) ?? null;
		const watchdog = (await this.ctx.storage.get<WatchdogRecord>(WATCHDOG_KEY)) ?? null;
		const intents = await this.loadIntents();
		const actions = decide({
			now,
			frozen: control.frozen,
			queue: await this.loadQueue(),
			openIntents: intents.filter((intent) => intent.state === "open").map((intent) => ({ id: intent.id, openedAt: intent.openedAt })),
			budget: { spentUsd: budget.spentUsd, budgetUsd: this.dailyBudgetUsd(), estimatedRunUsd: ESTIMATED_RUN_COST_USD },
			revert: revert ? { sha: revert.sha, dispatchedAt: revert.dispatchedAt } : null,
			watchdog,
			doctorQueue: await this.loadDoctorQueue(),
		});
		for (const action of actions) {
			try {
				await this.execute(action, now);
			} catch (error) {
				// One failed effect must never starve the rest of the plan; the
				// level-triggered cadence retries it next cycle from durable state.
				console.error("Reconcile action failed", { kind: action.kind, error: error instanceof Error ? error.message : String(error) });
			}
		}
		await this.broadcastFeed();
	}

	private async execute(action: ReconcileAction, now: number): Promise<void> {
		switch (action.kind) {
			case "park-run": return this.executeParkRun(now);
			case "enqueue-intent": return this.executeEnqueueIntent(action.intentId, now);
			case "dispatch": return this.dispatchHead(now);
			case "announce-budget-exhausted": return this.announceBudgetExhausted(now);
			case "observe-ci": return this.observeCi(action, now);
			case "observe-deploy": return this.observeDeploy(action, now);
			case "liveness-check": return this.executeLivenessCheck(action, now);
			case "dispatch-revert": return this.executeDispatchRevert(action.sha, now);
			case "observe-revert": return this.executeObserveRevert(action.sha, now);
			case "consult-doctor": return this.executeConsultDoctor(now);
		}
	}

	/** Append a park case for the Doctor. MUST run inside a storage transaction. */
	private async queueDoctorCase(entry: Omit<DoctorQueueEntry, "id" | "at">, now: number): Promise<void> {
		const pending = await this.loadDoctorQueue();
		pending.push({ ...entry, id: `case-${crypto.randomUUID()}`, at: now, detail: entry.detail.slice(0, 600) });
		await this.ctx.storage.put(DOCTOR_QUEUE_KEY, pending);
	}

	/**
	 * Resolve ONE pending Doctor case: build the full case file from durable
	 * facts, consult the DoctorPort (bounded; fails open to stay-parked), and
	 * apply the verdict durably — either the intent parks with the Doctor's
	 * public note, or it is granted its one retry as a fresh queued run.
	 */
	private async executeConsultDoctor(now: number): Promise<void> {
		const pending = await this.loadDoctorQueue();
		const entry = pending[0];
		if (!entry) return;
		const intent = entry.intentId ? await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${entry.intentId}`) : null;
		const retryAvailable = RETRYABLE_DOCTOR_KINDS.has(entry.kind) && intent?.state === "dispatched" && intent.retried !== true;
		const caseFile: DoctorCase = {
			kind: entry.kind,
			runId: entry.runId,
			intentId: entry.intentId,
			detail: entry.detail,
			retryAvailable,
			...(intent ? await this.describeIntent(intent) : {}),
			recentEvents: await this.recentEventLines(),
		};
		let verdict = await this.doctorPort.consult(caseFile);
		// The mechanical clamp holds here too: no retry without the lever.
		if (verdict.disposition === "retry-once" && !retryAvailable) verdict = { disposition: "stay-parked", publicNote: verdict.publicNote };
		await this.ctx.storage.transaction(async () => {
			const current = await this.loadDoctorQueue();
			if (!current.length || current[0].id !== entry.id) return;
			await this.ctx.storage.put(DOCTOR_QUEUE_KEY, current.slice(1));
			if (!entry.intentId || !intent) {
				await this.appendEvent("doctor-note", { note: verdict.publicNote, kind: entry.kind }, now);
				return;
			}
			if (verdict.disposition === "retry-once") {
				const runId = `run-${crypto.randomUUID()}`;
				const queue = enqueueRun(await this.loadQueue(), { runId, intentId: intent.id, enqueuedAt: now });
				await this.ctx.storage.put(QUEUE_KEY, queue);
				await this.ctx.storage.put(`${INTENT_PREFIX}${intent.id}`, retryIntent(intent, { runId, at: now }));
				await this.appendEvent("run-queued", { runId, intentId: intent.id }, now);
				await this.appendEvent("intent-retried", { intentId: intent.id, runId, note: verdict.publicNote }, now);
				return;
			}
			await this.recordIntentOutcomeFact(intent.id, "parked", now, verdict.publicNote);
		});
		await this.poke();
	}

	/** The case-file view of an intent: verbatim request text plus its requester. */
	private async describeIntent(intent: Intent): Promise<{ requestText: string; requestedBy: string }> {
		const evidence = await this.collectEvidence(intent);
		return { requestText: evidence.requestText.slice(0, 2_000), requestedBy: evidence.requestedBy };
	}

	/** Bounded recent ledger facts for the Doctor's case file, oldest first. */
	private async recentEventLines(count = 20): Promise<string[]> {
		const lastSeq = (await this.ctx.storage.get<number>(EVENT_SEQUENCE_KEY)) ?? 0;
		const events = await this.loadEvents(Math.max(1, lastSeq - count + 1), lastSeq);
		return events.map((event) => `${event.seq} ${event.kind}: ${JSON.stringify(event.payload).slice(0, 240)}`);
	}

	/** TTL enforcement: park-and-explain, then the queue advances; the Doctor gets the case. */
	private async executeParkRun(now: number): Promise<void> {
		let parkedRunId: string | null = null;
		await this.ctx.storage.transaction(async () => {
			const queue = await this.loadQueue();
			const { queue: swept, parked } = parkExpiredRun(queue, now);
			if (!parked) return;
			parkedRunId = parked.runId;
			const kind: DoctorCaseKind = parked.state === "running" ? "run-ttl-exceeded" : parked.state === "verifying" ? "verify-ttl-exceeded" : "deploy-ttl-exceeded";
			const detail = parked.state === "deploying"
				? `The change squash-merged at ${String(parked.mergeSha).slice(0, 7)} but the deploy was never observed serving it.`
				: `The run exceeded its ${parked.state} budget.`;
			await this.ctx.storage.put(QUEUE_KEY, swept);
			await this.appendEvent("run-parked", { runId: parked.runId, intentId: parked.intentId, note: detail }, now);
			await this.queueDoctorCase({ kind, runId: parked.runId, intentId: parked.intentId, detail }, now);
		});
		// A run parked from "running" may still hold a live (hung) container;
		// release it. For later phases the container is already gone and this
		// is an idempotent no-op.
		if (parkedRunId) this.ctx.waitUntil(this.runnerPort.finishRun(parkedRunId));
	}

	/** An accepted request's cancel window elapsed: admit it to the FIFO queue. */
	private async executeEnqueueIntent(intentId: string, now: number): Promise<void> {
		await this.ctx.storage.transaction(async () => {
			const current = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${intentId}`);
			if (!current || current.state !== "open") return;
			const runId = `run-${crypto.randomUUID()}`;
			const queue = enqueueRun(await this.loadQueue(), { runId, intentId: current.id, enqueuedAt: now });
			await this.ctx.storage.put(QUEUE_KEY, queue);
			await this.ctx.storage.put(`${INTENT_PREFIX}${current.id}`, dispatchIntent(current, { runId, at: now }));
			await this.appendEvent("run-queued", { runId, intentId: current.id }, now);
			await this.appendEvent("intent-dispatched", { intentId: current.id, runId }, now);
		});
		// The freshly queued run is not in this cycle's snapshot, so decide()
		// could not emit its dispatch. Pull the reconciler straight back rather
		// than letting the queued head sit until the next cadence tick.
		await this.poke();
	}

	private async announceBudgetExhausted(now: number): Promise<void> {
		const budget = await this.loadBudget(now);
		if (budget.exhaustedAnnounced) return;
		await this.ctx.storage.transaction(async () => {
			await this.appendEvent("budget-exhausted", { day: budget.day }, now);
			await this.ctx.storage.put(BUDGET_KEY, { ...budget, exhaustedAnnounced: true } satisfies BudgetRecord);
		});
	}

	/**
	 * Dispatch the FIFO head into a real sandboxed run, one at a time. The
	 * start is RECORDED before the sandbox RPC: if the platform dies between
	 * the record and the dispatch, the TTL parks one honest run — the reverse
	 * order would let a crash re-dispatch the same intent into a second
	 * sandbox with a second branch and a duplicate PR.
	 */
	private async dispatchHead(now: number): Promise<void> {
		const queue = await this.loadQueue();
		const head = queue.find((run) => run.state === "queued");
		if (!head) return;
		const budget = await this.loadBudget(now);
		const attemptId = `attempt-${crypto.randomUUID()}`;
		const intent = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${head.intentId}`);
		const evidence = intent ? await this.collectEvidence(intent) : { requestText: "", requestedBy: "unknown", annotations: [] };

		// THE BLIND-BUILD INVARIANT. A builder with an anchor but no
		// instructions does not fail — it invents a plausible change and ships
		// it green, which is exactly how requests came back as work nobody
		// asked for. Refuse structurally, park with an honest public reason,
		// and let the queue advance rather than spend a run on a guess.
		if (!evidence.requestText.trim().length) {
			const detail = "This request reached the builder with no instructions attached, so no build was started and nothing was changed. Re-send it with a sentence describing the change you want.";
			await this.ctx.storage.transaction(async () => {
				// Start-then-fail so the queue contract's attempt guard holds; the
				// run never leaves the platform, and no sandbox is ever spent.
				let current = startRun(await this.loadQueue(), { runId: head.runId, attemptId, startedAt: now });
				current = completeRun(current, { runId: head.runId, attemptId, state: "failed", at: now, detail: "request-text-missing" });
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(current));
				await this.appendEvent("run-started", { runId: head.runId, intentId: head.intentId, attemptId, branch: "" }, now);
				await this.appendEvent("run-failed", { runId: head.runId, intentId: head.intentId, reason: "request-text-missing" }, now);
				await this.recordIntentOutcomeFact(head.intentId, "parked", now, detail);
			});
			return;
		}
		// The branch is the platform's to name: plain room/<intentSeq>/<attempt>
		// from latest main. No stacks, no parents, no expected order.
		const intentSeq = intent && Number.isSafeInteger(intent.openSeq) ? intent.openSeq : 0;
		const branch = `room/${intentSeq}/${attemptId.slice(8, 16)}`;
		// Sizing is deterministic and recorded, so error rates by tier stay
		// measurable. It tunes only the agent's own budgets — never the gates.
		const tier = this.runTier(evidence);
		await this.ctx.storage.transaction(async () => {
			const current = startRun(await this.loadQueue(), { runId: head.runId, attemptId, startedAt: now });
			await this.ctx.storage.put(QUEUE_KEY, current);
			await this.ctx.storage.put(BUDGET_KEY, { ...budget, spentUsd: budget.spentUsd + ESTIMATED_RUN_COST_USD } satisfies BudgetRecord);
			await this.appendEvent("run-started", { runId: head.runId, intentId: head.intentId, attemptId, branch, tier }, now);
		});
		const result = await this.startRunViaPort({ runId: head.runId, attemptId, intentId: head.intentId, branch, evidence, tier });
		if (result.accepted) return;
		await this.ctx.storage.transaction(async () => {
			let current = await this.loadQueue();
			current = completeRun(current, { runId: head.runId, attemptId, state: "failed", at: now, detail: result.reason });
			await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(current));
			await this.appendEvent("run-failed", { runId: head.runId, intentId: head.intentId, reason: result.reason }, now);
			await this.queueDoctorCase({ kind: "dispatch-refused", runId: head.runId, intentId: head.intentId, detail: `The builder could not start (${result.reason}).` }, now);
		});
	}

	/** Mint the per-dispatch Git credential and hand the runner its complete job. */
	private async startRunViaPort(input: { runId: string; attemptId: string; intentId: string; branch: string; evidence: { requestText: string; requestedBy: string; annotations: unknown[] }; tier: RunTier }): Promise<{ accepted: true } | { accepted: false; reason: string }> {
		const app = this.githubApp();
		if (!app) return { accepted: false, reason: "github-app-not-configured" };
		let gitToken: string;
		try {
			gitToken = await app.installationToken();
		} catch (error) {
			return { accepted: false, reason: `github-token-unavailable: ${(error instanceof Error ? error.message : "unknown").slice(0, 120)}` };
		}
		return this.runnerPort.startRun({ ...input, feedUrl: this.env.PRODUCT_URL, gitToken });
	}

	/**
	 * A verifying run: read the exact head SHA's check runs, classify them
	 * mechanically, and on green squash-merge with --match-head-commit
	 * semantics, record the migration marker from the ACTUAL changed files,
	 * and hand the run to the deploy leg. Red CI parks-and-queues-the-Doctor.
	 */
	private async observeCi(action: Extract<ReconcileAction, { kind: "observe-ci" }>, now: number): Promise<void> {
		const app = this.githubApp();
		if (!app) return;
		const verdict = classifyCheckRuns(await app.listCheckRuns(action.headSha));
		if (verdict.verdict === "pending") return;
		const attemptId = action.attemptId ?? "";
		if (verdict.verdict === "red") {
			const detail = `CI failed: ${verdict.failed.join(", ").slice(0, 300)}`;
			await this.ctx.storage.transaction(async () => {
				let queue = await this.loadQueue();
				const run = assertLiveAttempt(queue, { runId: action.runId, attemptId });
				queue = completeRun(queue, { runId: action.runId, attemptId, state: "failed", at: now, detail });
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
				await this.appendEvent("run-failed", { runId: action.runId, intentId: run.intentId, reason: detail }, now);
				await this.queueDoctorCase({ kind: "ci-red", runId: action.runId, intentId: run.intentId, detail }, now);
			});
			return;
		}
		// Green: derive the deterministic migration marker from the real diff,
		// then merge exactly the verified head SHA — nothing else can ride in.
		const changedFiles = await app.listChangedFiles(action.prNumber);
		const migration = includesMigrationMarker(changedFiles);
		// deploy-product.yml also triggers on pushes to main under product/**.
		// When the merge touches that path the push trigger already covers it,
		// and dispatching as well produced a second identical run that queued
		// behind the first on the deploy concurrency group — pure tail on the
		// observed-deploy path. Dispatch only when the push trigger will NOT
		// fire, so a deploy always has exactly one cause.
		const pushTriggerCovers = changedFiles.some((file) => file.startsWith("product/"));
		let merge = await app.squashMerge(action.prNumber, action.headSha);
		if (!merge.merged) {
			// Crash-window recovery: if a previous cycle's merge succeeded but the
			// DO died before the beginDeploying transaction committed, this cycle
			// re-merges an already-merged PR and GitHub answers 405. That is not a
			// refusal of the change — read the PR and, when it is already merged
			// from exactly the verified head, proceed with its real merge commit.
			const already = await app.pullRequestMergeState(action.prNumber).catch(() => null);
			if (already?.merged && already.mergeSha && already.headSha === action.headSha) {
				merge = { merged: true, mergeSha: already.mergeSha };
			}
		}
		if (!merge.merged) {
			const detail = `GitHub refused the exact-SHA squash merge (${merge.reason}).`;
			await this.ctx.storage.transaction(async () => {
				let queue = await this.loadQueue();
				const run = assertLiveAttempt(queue, { runId: action.runId, attemptId });
				queue = completeRun(queue, { runId: action.runId, attemptId, state: "failed", at: now, detail });
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
				await this.appendEvent("run-failed", { runId: action.runId, intentId: run.intentId, reason: detail }, now);
				await this.queueDoctorCase({ kind: "merge-refused", runId: action.runId, intentId: run.intentId, detail }, now);
			});
			return;
		}
		await this.ctx.storage.transaction(async () => {
			let queue = await this.loadQueue();
			const run = assertLiveAttempt(queue, { runId: action.runId, attemptId });
			queue = beginDeploying(queue, { runId: action.runId, attemptId, at: now, mergeSha: merge.mergeSha, migration });
			await this.ctx.storage.put(QUEUE_KEY, queue);
			await this.appendEvent("pr-merged", { runId: action.runId, intentId: run.intentId, prNumber: action.prNumber, mergeSha: merge.mergeSha }, now);
			await this.appendEvent("deploy-requested", { sha: merge.mergeSha, runId: action.runId }, now);
		});
		// Dispatch the deploy leg only when the push trigger will not already do
		// it. Either way observe-deploy is the sole authority on "Live": it polls
		// /version until the merged SHA is actually served, so a missed trigger
		// costs the run its deploy TTL and parks honestly rather than hanging.
		if (pushTriggerCovers) return;
		try {
			await app.dispatchWorkflow(DEPLOY_WORKFLOW_FILE, { sha: merge.mergeSha });
		} catch (error) {
			console.error("Deploy workflow dispatch failed; push trigger remains the backstop.", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * A deploying run completes ONLY when the platform observes the product's
	 * /version endpoint serving the merge SHA. That observation is the Live
	 * fact, the good-SHA record, and the start of the liveness window.
	 */
	private async observeDeploy(action: Extract<ReconcileAction, { kind: "observe-deploy" }>, now: number): Promise<void> {
		const observed = await observeDeployedVersion(this.env.PRODUCT_URL);
		if (observed !== action.mergeSha) return;
		const attemptId = action.attemptId ?? "";
		await this.ctx.storage.transaction(async () => {
			let queue = await this.loadQueue();
			const run = assertLiveAttempt(queue, { runId: action.runId, attemptId });
			const migration = run.migration === true;
			queue = completeRun(queue, { runId: action.runId, attemptId, state: "merged", at: now, detail: action.mergeSha });
			await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
			await this.appendEvent("deploy-observed", { sha: action.mergeSha, runId: action.runId }, now);
			await this.appendEvent("run-merged", { runId: action.runId, intentId: run.intentId, mergeSha: action.mergeSha }, now);
			await this.recordIntentOutcomeFact(run.intentId, "live", now);
			const good = (await this.ctx.storage.get<GoodShaRecord>(GOOD_SHA_KEY)) ?? { current: "", previous: null };
			await this.ctx.storage.put(GOOD_SHA_KEY, { current: action.mergeSha, previous: good.current || null } satisfies GoodShaRecord);
			await this.ctx.storage.put(WATCHDOG_KEY, { sha: action.mergeSha, until: now + WATCHDOG_WINDOW_MS, migration } satisfies WatchdogRecord);
		});
	}

	/**
	 * The liveness watchdog: a synthetic fetch of the live product. Failure is
	 * a public fact, then a deterministic auto-revert to the previous good
	 * SHA — unless the deploy included a migration, which auto-revert refuses
	 * (state may have moved); that queues the Doctor for a public note.
	 */
	private async executeLivenessCheck(action: Extract<ReconcileAction, { kind: "liveness-check" }>, now: number): Promise<void> {
		const result = await syntheticLivenessCheck(this.env.PRODUCT_URL);
		if (result.ok) return;
		const good = (await this.ctx.storage.get<GoodShaRecord>(GOOD_SHA_KEY)) ?? { current: "", previous: null };
		if (action.migration || !good.previous) {
			const detail = action.migration
				? `The deploy of ${action.sha.slice(0, 7)} included a migration; auto-revert refuses to cross it. (${result.reason})`
				: `No previous observed-good revision exists to revert to. (${result.reason})`;
			await this.ctx.storage.transaction(async () => {
				await this.appendEvent("liveness-failed", { reason: `${result.reason} — ${detail}` }, now);
				await this.queueDoctorCase({ kind: "liveness-failed-migration", detail }, now);
				await this.ctx.storage.delete(WATCHDOG_KEY);
			});
			return;
		}
		const previous = good.previous;
		await this.ctx.storage.transaction(async () => {
			await this.appendEvent("liveness-failed", { reason: result.reason }, now);
			await this.appendEvent("rollback-requested", { sha: previous, reason: `liveness-${result.reason}` }, now);
			await this.ctx.storage.put(REVERT_KEY, { sha: previous, requestedAt: now, dispatchedAt: null, reason: `liveness-${result.reason}` } satisfies RevertRecord);
			await this.ctx.storage.delete(WATCHDOG_KEY);
		});
	}

	/** Execute a pending revert: redeploy the recorded good SHA via the deploy workflow. */
	private async executeDispatchRevert(sha: string, now: number): Promise<void> {
		const app = this.githubApp();
		if (!app) return;
		await app.dispatchWorkflow(DEPLOY_WORKFLOW_FILE, { sha });
		await this.ctx.storage.transaction(async () => {
			const pending = await this.ctx.storage.get<RevertRecord>(REVERT_KEY);
			if (!pending || pending.sha !== sha || pending.dispatchedAt !== null) return;
			await this.appendEvent("deploy-requested", { sha, reason: pending.reason }, now);
			await this.ctx.storage.put(REVERT_KEY, { ...pending, dispatchedAt: now } satisfies RevertRecord);
		});
	}

	/** A revert completes only when /version is observed serving the target SHA again. */
	private async executeObserveRevert(sha: string, now: number): Promise<void> {
		const observed = await observeDeployedVersion(this.env.PRODUCT_URL);
		if (observed !== sha) return;
		await this.ctx.storage.transaction(async () => {
			const pending = await this.ctx.storage.get<RevertRecord>(REVERT_KEY);
			if (!pending || pending.sha !== sha) return;
			await this.appendEvent("rollback-observed", { sha }, now);
			await this.ctx.storage.delete(REVERT_KEY);
			const good = (await this.ctx.storage.get<GoodShaRecord>(GOOD_SHA_KEY)) ?? { current: "", previous: null };
			await this.ctx.storage.put(GOOD_SHA_KEY, { current: sha, previous: good.current && good.current !== sha ? good.current : good.previous } satisfies GoodShaRecord);
		});
	}

	/**
	 * Every anchored payload rides to the builder verbatim, per-requester
	 * attributed.
	 *
	 * `requestText` is the requester's OWN WORDS and is what the builder is
	 * actually asked to do; the annotations are context identifying what was
	 * pointed at. Three envelope kinds carry those words differently:
	 * target/draw type them into the composer (the request-accepted fact), and
	 * comment carries them inside the annotation payload. All three are
	 * recovered here, so no kind can dispatch a build blind.
	 */
	private async collectEvidence(intent: Intent): Promise<{ requestText: string; requestedBy: string; annotations: unknown[] }> {
		const annotations: unknown[] = [];
		let requestText = "";
		let annotationText = "";
		for (const seq of [...intent.refs.annotationSeqs, ...intent.refs.utteranceSeqs]) {
			const event = await this.ctx.storage.get<LedgerEvent>(eventStorageKey(seq));
			if (!event) continue;
			if (event.kind === "annotation") {
				annotations.push(event.payload);
				const annotation = event.payload.annotation as { text?: unknown } | undefined;
				if (typeof annotation?.text === "string" && annotation.text.trim().length) annotationText = annotation.text.trim();
			}
			if (event.kind === "request-accepted" && typeof event.payload.text === "string" && event.payload.text.trim().length) {
				requestText = event.payload.text.trim();
			}
			// A plain utterance attached to an intent is requester speech too.
			if (event.kind === "utterance" && typeof event.payload.text === "string" && !requestText.trim().length) {
				requestText = event.payload.text.trim();
			}
		}
		return { requestText: requestText || annotationText, requestedBy: intent.openedBy, annotations };
	}

	/**
	 * Size this run from durable evidence alone: the envelope kind carried by
	 * the anchoring annotation, the verbatim request text, and how many anchors
	 * the intent collected. Deterministic — the same facts always pick the same
	 * tier — and biased to "normal" whenever smallness is not positively proven.
	 */
	private runTier(evidence: { requestText: string; annotations: unknown[] }): RunTier {
		const first = evidence.annotations[0] as { annotation?: { kind?: unknown } } | undefined;
		return classifyRunTier({
			kind: first?.annotation?.kind,
			text: evidence.requestText,
			annotationCount: evidence.annotations.length,
		});
	}

	private async handleChat(socket: WebSocket, message: Extract<ClientMessage, { type: "chat:send" }>, identity: { id: string; name: string }): Promise<void> {
		const text = typeof message.text === "string" ? message.text.trim() : "";
		if (!text.length) {
			this.notice(socket, "Chat needs non-empty text.");
			return;
		}
		const now = Date.now();
		if (!admitRateLimited(this.chatWindows, identity.id, now, CHAT_RATE)) {
			this.notice(socket, "You are sending messages too quickly; wait a moment.");
			return;
		}
		let event: LedgerEvent | undefined;
		await this.ctx.storage.transaction(async () => {
			event = await this.appendEvent("utterance", { author: identity.name, authorId: identity.id, text }, now);
		});
		this.broadcast({ type: "chat:message", author: identity.name, text, seq: event?.seq, at: event?.at });
	}

	private async handleRequest(socket: WebSocket, message: Extract<ClientMessage, { type: "request:target" | "request:comment" | "request:draw" }>, identity: { id: string; name: string }): Promise<void> {
		const envelope = parseRequestEnvelope(message);
		if (!envelope) return;
		const control = await this.loadControl();
		if (control.frozen) {
			this.notice(socket, "The room is frozen by its owner: new requests are paused, chat stays open.");
			return;
		}
		const now = Date.now();
		if (!admitRateLimited(this.requestWindows, identity.id, now, REQUEST_RATE)) {
			this.notice(socket, "You are opening requests too quickly; wait a moment.");
			return;
		}
		const intents = await this.loadIntents();
		if (!underOpenIntentLimit(intents, identity.id)) {
			this.notice(socket, "You already have 5 open requests. Wait for one to finish (or cancel one) before opening another.");
			return;
		}
		const intentId = `intent-${crypto.randomUUID()}`;
		let deadline = 0;
		await this.ctx.storage.transaction(async () => {
			const annotationEvent = await this.appendEvent("annotation", { by: identity.name, byId: identity.id, annotation: envelope.annotation }, now);
			// The intent-opened seq is the room-unique ordinal that later names
			// the run branch: room/<openSeq>/<attempt>.
			const openedEvent = await this.appendEvent("intent-opened", { intentId, by: identity.name }, now);
			deadline = cancelDeadline(now);
			// The request-accepted fact carries the requester's TYPED WORDS, and
			// it is appended BEFORE the intent so its seq can be recorded in the
			// intent's refs. That pointer is the only path by which the typed
			// text reaches the builder (collectEvidence walks refs and nothing
			// else): recording the intent first and this fact afterwards — the
			// original order — left requestText permanently empty and dispatched
			// every build with an anchor and no instructions.
			const acceptedEvent = await this.appendEvent("request-accepted", { intentId, by: identity.name, text: envelope.text, at: now, cancelDeadline: deadline }, now);
			const intent = createIntent({
				id: intentId,
				openedBy: identity.name,
				openedById: identity.id,
				at: now,
				refs: { utteranceSeqs: [acceptedEvent.seq], annotationSeqs: [annotationEvent.seq] },
				openSeq: openedEvent.seq,
			});
			await this.ctx.storage.put(`${INTENT_PREFIX}${intentId}`, intent);
		});
		// The immediate public ack, with its cancel window, straight back to the
		// requester and out to the room.
		socket.send(JSON.stringify({ type: "request:ack", intentId, cancelDeadline: deadline, clientSubmissionId: envelope.clientSubmissionId }));
		await this.broadcastFeed();
		// Pull the reconciler to just past the cancel window so dispatch is prompt.
		await this.scheduleReconcile(deadline + POKE_DELAY_MS);
	}

	/**
	 * Feedback about the HARNESS ITSELF. The platform is firewalled from the
	 * room's coding agents by design, so this NEVER opens an intent and NEVER
	 * dispatches a build: the fact is terminal at creation — recorded verbatim
	 * with its anchored overlay element, acked honestly, and read by the
	 * harness team from the ledger.
	 */
	private async handleHarnessFeedback(socket: WebSocket, message: Extract<ClientMessage, { type: "harness:feedback" }>, identity: { id: string; name: string }): Promise<void> {
		const text = typeof message.text === "string" ? message.text.trim().slice(0, 2000) : "";
		if (!text.length) {
			this.notice(socket, "Write a brief note about the harness UI.");
			return;
		}
		const now = Date.now();
		if (!admitRateLimited(this.requestWindows, identity.id, now, REQUEST_RATE)) {
			this.notice(socket, "You are sending feedback too quickly; wait a moment.");
			return;
		}
		const raw = message.annotation && typeof message.annotation === "object" && !Array.isArray(message.annotation) ? message.annotation as Record<string, unknown> : {};
		// Bounded verbatim anchor: the overlay's own chrome, never the app's DOM.
		const annotation = {
			kind: "harness-feedback",
			label: typeof raw.label === "string" && raw.label.length ? raw.label.slice(0, 200) : "harness chrome",
			selectorPath: typeof raw.selectorPath === "string" ? raw.selectorPath.slice(0, 400) : null,
			control: typeof raw.control === "string" ? raw.control.slice(0, 120) : null,
		};
		await this.ctx.storage.transaction(async () => {
			await this.appendEvent("harness-feedback", { by: identity.name, byId: identity.id, text, annotation }, now);
		});
		try {
			socket.send(JSON.stringify({ type: "harness:ack", clientSubmissionId: typeof message.clientSubmissionId === "string" && message.clientSubmissionId.length <= 128 ? message.clientSubmissionId : undefined }));
		} catch { /* the broadcast below still carries the fact */ }
		await this.broadcastFeed();
	}

	private async handleCancel(socket: WebSocket, message: Extract<ClientMessage, { type: "request:cancel" }>, identity: { id: string; name: string }): Promise<void> {
		const intentId = typeof message.intentId === "string" ? message.intentId : null;
		if (!intentId) return;
		const now = Date.now();
		let cancelled = false;
		let refused: string | null = null;
		await this.ctx.storage.transaction(async () => {
			const intent = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${intentId}`);
			if (!intent || intent.state !== "open") return;
			// Only the requester (by stable id) may cancel their own request.
			if ((intent.openedById ?? intent.openedBy) !== identity.id) {
				refused = "Only the requester can cancel a request.";
				return;
			}
			await this.ctx.storage.put(`${INTENT_PREFIX}${intentId}`, withdrawIntent(intent, { at: now }));
			await this.appendEvent("request-cancelled", { intentId, by: intent.openedBy }, now);
			await this.appendEvent("intent-withdrawn", { intentId }, now);
			cancelled = true;
		});
		if (refused) {
			this.notice(socket, refused);
			return;
		}
		if (!cancelled) {
			this.notice(socket, "That request has already been dispatched (or finished); it can no longer be cancelled.");
			return;
		}
		await this.broadcastFeed();
	}

	private async handleHistory(socket: WebSocket, message: Extract<ClientMessage, { type: "feed:history" }>): Promise<void> {
		const before = Number.isSafeInteger(message.beforeSeq) && (message.beforeSeq as number) > 1 ? (message.beforeSeq as number) : null;
		const lastSeq = (await this.ctx.storage.get<number>(EVENT_SEQUENCE_KEY)) ?? 0;
		const end = before === null ? lastSeq : Math.min(before - 1, lastSeq);
		const start = Math.max(1, end - SNAPSHOT_EVENT_COUNT + 1);
		const events = await this.loadEvents(start, end);
		socket.send(JSON.stringify({
			type: "feed:history",
			items: events.map(renderFeedItem).filter((item) => item !== null),
			hasMore: start > 1,
			beforeSeq: start,
		}));
	}

	private async snapshot(): Promise<Record<string, unknown>> {
		const now = Date.now();
		const lastSeq = (await this.ctx.storage.get<number>(EVENT_SEQUENCE_KEY)) ?? 0;
		const start = Math.max(1, lastSeq - SNAPSHOT_EVENT_COUNT + 1);
		const events = await this.loadEvents(start, lastSeq);
		const control = await this.loadControl();
		const feed = renderFeed({ events, queue: await this.loadQueue(), intents: await this.loadIntentsForFeed(), now, frozen: control.frozen });
		const chat = events.filter((event) => event.kind === "utterance").map((event) => ({ author: event.payload.author, text: event.payload.text, seq: event.seq, at: event.at }));
		return { type: "room:snapshot", chat, feed, hasMore: start > 1, beforeSeq: start };
	}

	private async broadcastFeed(): Promise<void> {
		const now = Date.now();
		const control = await this.loadControl();
		const queue = await this.loadQueue();
		// Recent items ride every update so connected clients see new facts
		// without reconnecting; they merge by seq.
		const lastSeq = (await this.ctx.storage.get<number>(EVENT_SEQUENCE_KEY)) ?? 0;
		const events = await this.loadEvents(Math.max(1, lastSeq - BROADCAST_FEED_ITEMS + 1), lastSeq);
		this.broadcast({
			type: "feed:update",
			// Chips project INTENTS, not just queued runs: an accepted request
			// stays visibly active through building/verifying/deploying until
			// its terminal fact (live/parked/withdrawn) lands.
			queue: renderQueueChips(queue, now, await this.loadIntentsForFeed()),
			frozen: control.frozen,
			items: events.map(renderFeedItem).filter((item) => item !== null),
		});
	}

	private broadcast(message: Record<string, unknown>): void {
		const raw = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			try { socket.send(raw); } catch { /* A hibernating or closing socket is not this broadcast's problem. */ }
		}
	}

	private notice(socket: WebSocket, text: string): void {
		try { socket.send(JSON.stringify({ type: "room:notice", text })); } catch { /* ditto */ }
	}

	/** Append one fact. MUST run inside a storage transaction. */
	private async appendEvent(kind: LedgerEventKind, payload: Record<string, unknown>, at: number): Promise<LedgerEvent> {
		const lastSeq = (await this.ctx.storage.get<number>(EVENT_SEQUENCE_KEY)) ?? 0;
		const event = assertAppendable(lastSeq, createLedgerEvent({ seq: lastSeq + 1, kind, at, payload }));
		await this.ctx.storage.put(eventStorageKey(event.seq), event);
		await this.ctx.storage.put(EVENT_SEQUENCE_KEY, event.seq);
		return event;
	}

	private async recordIntentOutcomeFact(intentId: string, state: "live" | "parked", now: number, detail?: string): Promise<void> {
		const intent = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${intentId}`);
		if (!intent || intent.state !== "dispatched") return;
		await this.ctx.storage.put(`${INTENT_PREFIX}${intentId}`, recordIntentOutcome(intent, { state, at: now, detail }));
		await this.appendEvent(state === "live" ? "intent-live" : "intent-parked", { intentId, ...(detail === undefined ? {} : { reason: detail }) }, now);
	}

	private async loadEvents(start: number, end: number): Promise<LedgerEvent[]> {
		if (end < start) return [];
		const page = await this.ctx.storage.list<LedgerEvent>({ start: eventStorageKey(start), end: `${EVENT_PREFIX}${String(end + 1).padStart(12, "0")}` });
		return [...page.values()];
	}

	private async loadQueue(): Promise<QueuedRun[]> {
		return (await this.ctx.storage.get<QueuedRun[]>(QUEUE_KEY)) ?? [];
	}

	private async loadDoctorQueue(): Promise<DoctorQueueEntry[]> {
		return (await this.ctx.storage.get<DoctorQueueEntry[]>(DOCTOR_QUEUE_KEY)) ?? [];
	}

	private async loadIntents(): Promise<Intent[]> {
		const page = await this.ctx.storage.list<Intent>({ prefix: INTENT_PREFIX });
		return [...page.values()];
	}

	/**
	 * Intents decorated for the pipeline projection: each ACTIVE intent
	 * carries its anchor (what the requester pointed at), the verbatim request
	 * text, and the requester's name, read back from the durable facts its
	 * refs point at. Chips built from these let every client show WHAT is
	 * building and pin pending work to the exact element it targets. Bounded
	 * work: only non-terminal intents (a handful at most) are decorated.
	 */
	private async loadIntentsForFeed(): Promise<(Intent & { anchor?: Record<string, unknown>; requestText?: string; requestedBy?: string; requestMode?: "fast" })[]> {
		const intents = await this.loadIntents();
		const out: (Intent & { anchor?: Record<string, unknown>; requestText?: string; requestedBy?: string; requestMode?: "fast" })[] = [];
		for (const intent of intents) {
			if (intent.state !== "open" && intent.state !== "dispatched") { out.push(intent); continue; }
			let decorated: Intent & { anchor?: Record<string, unknown>; requestText?: string; requestedBy?: string; requestMode?: "fast" } = intent;
			const annotationSeq = intent.refs?.annotationSeqs?.[0];
			if (Number.isSafeInteger(annotationSeq)) {
				const event = await this.ctx.storage.get<LedgerEvent>(eventStorageKey(annotationSeq as number));
				const annotation = event?.payload?.annotation as Record<string, unknown> | undefined;
				if (annotation && typeof annotation === "object") {
					decorated = {
						...decorated,
						anchor: { kind: annotation.kind, dataLoc: annotation.dataLoc, selector: annotation.selector ?? null, selectorPath: annotation.selectorPath ?? null },
						// The build mode (fast/standard) rides the verbatim
						// annotation; chips surface it as the lightning.
						...(annotation.mode === "fast" ? { requestMode: "fast" as const } : {}),
					};
				}
			}
			const acceptedSeq = intent.refs?.utteranceSeqs?.[0];
			if (Number.isSafeInteger(acceptedSeq)) {
				const event = await this.ctx.storage.get<LedgerEvent>(eventStorageKey(acceptedSeq as number));
				if (event?.kind === "request-accepted" && typeof event.payload?.text === "string") {
					decorated = { ...decorated, requestText: event.payload.text as string, requestedBy: typeof event.payload.by === "string" ? event.payload.by as string : undefined };
				}
			}
			out.push(decorated);
		}
		return out;
	}

	private async loadControl(): Promise<RoomControl> {
		return (await this.ctx.storage.get<RoomControl>(ROOM_CONTROL_KEY)) ?? { frozen: false };
	}

	private async loadBudget(now: number): Promise<BudgetRecord> {
		const day = budgetDay(now);
		const record = await this.ctx.storage.get<BudgetRecord>(BUDGET_KEY);
		if (record && record.day === day) return record;
		return { day, spentUsd: 0, exhaustedAnnounced: false };
	}

	private dailyBudgetUsd(): number {
		const parsed = Number.parseFloat(this.env.ROOM_DAILY_BUDGET_USD ?? "");
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
	}

	/** Only ever pulls the alarm EARLIER; the cadence chosen by the caller is the floor. */
	private async scheduleReconcile(at: number): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing !== null && existing <= at) return;
		await this.ctx.storage.setAlarm(at);
	}
}

function roomName(pathname: string): string | null {
	const match = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)$/u);
	return match ? match[1] : null;
}

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

/** The presented session token: cookie first, ?session= as the non-browser fallback (it is a bearer either way). */
function presentedSessionToken(request: Request): string | null {
	return readCookie(request, SESSION_COOKIE) ?? new URL(request.url).searchParams.get("session");
}

function sessionCookie(token: string): string {
	return `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export default {
	async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		const room = (): DurableObjectStub<RoomDO> => env.ROOM_DO.getByName("main") as DurableObjectStub<RoomDO>;

		if (pathname.startsWith("/api/admin/")) {
			// Owner levers require the ADMIN_TOKEN worker secret as a bearer
			// credential and fail closed when the secret is not provisioned.
			const token = env.ADMIN_TOKEN;
			if (!token || !fixedTimeEqual(request.headers.get("Authorization") ?? "", `Bearer ${token}`)) return new Response("Unauthorized", { status: 401 });
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			if (pathname === "/api/admin/freeze") return Response.json(await room().freeze(true));
			if (pathname === "/api/admin/unfreeze") return Response.json(await room().freeze(false));
			if (pathname === "/api/admin/revert") {
				let body: { sha?: unknown };
				try { body = JSON.parse(await request.text()) as typeof body; } catch { return new Response("Invalid JSON", { status: 400 }); }
				if (typeof body.sha !== "string") return new Response("sha required", { status: 400 });
				try { return Response.json(await room().requestRevert(body.sha)); } catch (error) { return new Response(error instanceof Error ? error.message : "Invalid revert", { status: 400 }); }
			}
			return new Response("Not found", { status: 404 });
		}

		if (pathname === "/api/session") {
			// Identity (phase 3, v1 non-negotiable): the platform mints signed
			// session cookies — a display-name claim plus a stable id, HMAC'd
			// with a key derived from ADMIN_TOKEN. Fails closed when the secret
			// is not provisioned.
			if (!env.ADMIN_TOKEN) return new Response("Identity is not provisioned yet.", { status: 503 });
			if (request.method === "GET") {
				const token = presentedSessionToken(request);
				const identity = token ? await verifySessionToken(env.ADMIN_TOKEN, token) : null;
				if (!identity) return new Response("No valid session.", { status: 401 });
				return Response.json({ id: identity.id, name: identity.name });
			}
			if (request.method === "POST") {
				let body: { name?: unknown };
				try { body = JSON.parse(await request.text()) as typeof body; } catch { return new Response("Invalid JSON", { status: 400 }); }
				let minted: { token: string; identity: SessionIdentity };
				try {
					minted = await mintSessionToken(env.ADMIN_TOKEN, typeof body.name === "string" ? body.name.trim() : "");
				} catch (error) {
					return new Response(error instanceof Error ? error.message : "Invalid name", { status: 400 });
				}
				return Response.json(
					{ id: minted.identity.id, name: minted.identity.name, token: minted.token },
					{ headers: { "Set-Cookie": sessionCookie(minted.token) } },
				);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		if (pathname === "/overlay.js") {
			// THE OVERLAY (task #13): the platform-owned authoring tools and
			// status surface, served to whatever app has App Harness installed.
			// It is frozen here — the CI path firewall bars agent branches from
			// platform/** — so an agent change to the app can never break or
			// falsify the queue, the activity feed, or its provenance links.
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			return new Response(OVERLAY_CLIENT, {
				headers: {
					"content-type": "text/javascript; charset=utf-8",
					"cache-control": "public, max-age=60",
					"x-content-type-options": "nosniff",
				},
			});
		}

		if (pathname === "/overlay/tenant") {
			// The installed tenant's public descriptor: exactly what the overlay
			// needs to attach itself, and nothing about the app's internals.
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			return Response.json(
				{ id: INSTALLED_TENANT.id, anchorMode: INSTALLED_TENANT.anchorMode, repoUrl: `https://github.com/${INSTALLED_TENANT.repository}` },
				{ headers: { "cache-control": "no-store" } },
			);
		}

		if (pathname === "/fallback") {
			// The frozen minimal UI (task #13): reachable even when the
			// self-modifiable product bundle is broken.
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			return new Response(FALLBACK_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		}

		if (pathname === "/api/runner/complete") {
			// The builder reports by push; the per-dispatch runId inside the
			// payload is the bearer credential and the attemptId is the zombie
			// guard (native-git-runner pattern).
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const body = await request.text();
			if (utf8Bytes(body) > 256_000) return new Response("Payload too large", { status: 413 });
			let payload: Record<string, unknown>;
			try { payload = JSON.parse(body) as Record<string, unknown>; } catch { return new Response("Invalid JSON", { status: 400 }); }
			const outcome = await room().ingestRunnerResult(payload);
			return Response.json(outcome, { status: outcome.accepted ? 200 : 403 });
		}

		if (pathname === "/api/hooks/poke") {
			// GitHub webhook ingress. HMAC signature verification fails closed:
			// only verified deliveries pull the reconciler forward, and even a
			// verified poke decides NOTHING — the reconciler re-reads durable state.
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const body = await request.text();
			if (utf8Bytes(body) > 1_000_000) return new Response(null, { status: 204 });
			const verified = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256"));
			if (!verified) return new Response("Invalid signature", { status: 401 });
			return Response.json(await room().poke());
		}

		const name = roomName(pathname);
		if (name) {
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (name !== "main") return new Response("Unknown room", { status: 404 });
			// The room WebSocket requires a valid signed session; the Worker
			// verifies it here and forwards ONLY the verified identity to the DO.
			if (!env.ADMIN_TOKEN) return new Response("Identity is not provisioned yet.", { status: 503 });
			const token = presentedSessionToken(request);
			const identity = token ? await verifySessionToken(env.ADMIN_TOKEN, token) : null;
			if (!identity) return new Response("A signed session is required.", { status: 401 });
			const headers = new Headers(request.headers);
			headers.set(IDENTITY_ID_HEADER, identity.id);
			headers.set(IDENTITY_NAME_HEADER, identity.name);
			return env.ROOM_DO.getByName(name).fetch(new Request(request.url, { method: request.method, headers }));
		}
		return new Response("Not found", { status: 404 });
	},
};
