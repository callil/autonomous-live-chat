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
	underOpenIntentLimit,
	withdrawIntent,
	type Intent,
} from "../contracts/intent.js";
import { cancelDeadline, parseRequestEnvelope } from "../contracts/envelope.js";
import { renderFeed, renderFeedItem, renderQueueChips } from "../contracts/feed.js";
import { classifyCheckRuns, includesMigrationMarker } from "../contracts/checks.js";
import { decide, type ReconcileAction } from "../contracts/reconcile.js";
import { GitHubApp, observeDeployedVersion, syntheticLivenessCheck, verifyWebhookSignature } from "./github.js";
import { BindingRunnerPort, StubDoctorPort, StubRunnerPort, type DoctorPort, type RunnerBinding, type RunnerPort } from "./ports.js";

type RuntimeEnv = Env & {
	ADMIN_TOKEN?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_WEBHOOK_SECRET?: string;
};

type ClientMessage =
	| { type: "chat:send"; author?: unknown; text?: unknown }
	| { type: "request:target" | "request:comment" | "request:draw"; author?: unknown; text?: unknown; annotation?: unknown; clientSubmissionId?: unknown }
	| { type: "request:cancel"; intentId?: unknown }
	| { type: "feed:history"; beforeSeq?: unknown };

type RoomControl = { frozen: boolean };
type BudgetRecord = { day: string; spentUsd: number; exhaustedAnnounced: boolean };
/** A pending revert-to-SHA: owner-requested or watchdog-triggered, executed outside the request pipeline. */
type RevertRecord = { sha: string; requestedAt: number; dispatchedAt: number | null; reason: string };
/** The post-deploy liveness window: synthetic fetches until `until`, with the previous good SHA on hand. */
type WatchdogRecord = { sha: string; until: number; migration: boolean };
/** The last two revisions the platform OBSERVED serving; `previous` is the auto-revert target. */
type GoodShaRecord = { current: string; previous: string | null };

const EVENT_SEQUENCE_KEY = "sequence:event";
const EVENT_PREFIX = "event:";
const INTENT_PREFIX = "intent:";
const QUEUE_KEY = "queue";
const ROOM_CONTROL_KEY = "room-control";
const BUDGET_KEY = "budget";
const DIRTY_KEY = "dirty";
const REVERT_KEY = "pending-revert";
const WATCHDOG_KEY = "deploy-watchdog";
const GOOD_SHA_KEY = "observed-good-sha";

/** Level-triggered cadence: the reconciler re-reads state every minute no matter what. */
const RECONCILE_INTERVAL_MS = 60_000;
/** How soon a poke pulls the reconciler forward. */
const POKE_DELAY_MS = 1_000;
/** Snapshot depth for a fresh connection; older history pages via feed:history. */
const SNAPSHOT_EVENT_COUNT = 100;
const MAX_MESSAGE_BYTES = 128_000;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const SHA = /^[0-9a-f]{40}$/u;
/**
 * Honest per-run cost estimate until real metering lands (the blank-slate
 * design priced a change at $0.30-0.75).
 */
const ESTIMATED_RUN_COST_USD = 0.75;
const DEFAULT_DAILY_BUDGET_USD = 25;
/** Post-deploy liveness window (task #16: health pings for 5 minutes). */
const WATCHDOG_WINDOW_MS = 5 * 60_000;
/** The product deploy leg, reused for reverts via its sha input. */
const DEPLOY_WORKFLOW_FILE = "deploy-demo-on-main.yml";

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

function budgetDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function safeAuthor(value: unknown): string | null {
	// TODO(phase 3, non-negotiable before cutover): replace client-supplied
	// display names with real identity/auth. The rate limit below keys on this
	// name, which is honest bookkeeping but not a security boundary yet.
	return typeof value === "string" && AUTHOR.test(value) ? value : null;
}

/**
 * The Room Durable Object: single-threaded owner of the append-only event
 * ledger, the strict FIFO singleton build queue, intent records, and the feed
 * projection. Webhooks and client actions only append facts and set a dirty
 * mark; the 60-second level-triggered reconciler re-reads durable state and
 * drives the delta through the pure decide() policy. No model output enters
 * this truth path.
 */
export class RoomDO extends DurableObject<RuntimeEnv> {
	private readonly runnerPort: RunnerPort;
	private readonly doctorPort: DoctorPort = new StubDoctorPort();

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		const binding = env.RUNNER as unknown as RunnerBinding | undefined;
		this.runnerPort = binding ? new BindingRunnerPort(binding as RunnerBinding) : new StubRunnerPort();
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
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		const snapshot = await this.snapshot();
		server.send(JSON.stringify(snapshot));
		return new Response(null, { status: 101, webSocket: client });
	}

	async alarm(): Promise<void> {
		await this.reconcile();
		await this.scheduleReconcile(Date.now() + RECONCILE_INTERVAL_MS);
	}

	async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
		if (typeof raw !== "string" || utf8Bytes(raw) > MAX_MESSAGE_BYTES) {
			this.notice(socket, "That message is too large. Split it into smaller parts.");
			return;
		}
		let message: ClientMessage;
		try { message = JSON.parse(raw) as ClientMessage; } catch { return; }
		try {
			if (message.type === "chat:send") return await this.handleChat(socket, message);
			if (message.type === "request:target" || message.type === "request:comment" || message.type === "request:draw") return await this.handleRequest(socket, message);
			if (message.type === "request:cancel") return await this.handleCancel(socket, message);
			if (message.type === "feed:history") return await this.handleHistory(socket, message);
		} catch (error) {
			this.notice(socket, error instanceof Error ? error.message : "That message could not be processed.");
		}
	}

	webSocketClose(): void {}
	webSocketError(): void {}

	/** Webhooks and external systems poke here: set the dirty mark, pull the reconciler forward, decide nothing. */
	async poke(): Promise<{ accepted: true }> {
		await this.ctx.storage.put(DIRTY_KEY, true);
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
	 *   merging is the platform's job, after CI.
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
				} else {
					const reason = typeof input.reason === "string" ? input.reason.slice(0, 500) : "unspecified";
					queue = completeRun(queue, { runId, attemptId, state: "failed", at: now, detail: reason });
					await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
					await this.appendEvent("run-failed", { runId, intentId: run.intentId, reason }, now);
					await this.recordIntentOutcomeFact(run.intentId, "parked", now, reason);
				}
			});
		} catch (error) {
			// Zombie or stale pushes are inert by design; say so and move on.
			return { accepted: false, reason: error instanceof Error ? error.message : "rejected" };
		}
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
	 * cancel windows elapsed, TTL-expired runs parked, verifying runs checked
	 * against CI, deploys observed, liveness enforced, the queue head
	 * dispatched — then executes them in order and reschedules.
	 */
	private async reconcile(): Promise<void> {
		const now = Date.now();
		await this.ctx.storage.delete(DIRTY_KEY);
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
		}
	}

	/** TTL enforcement: park-and-explain, then the queue advances. */
	private async executeParkRun(now: number): Promise<void> {
		await this.ctx.storage.transaction(async () => {
			const queue = await this.loadQueue();
			const { queue: swept, parked } = parkExpiredRun(queue, now);
			if (!parked) return;
			const kind = parked.state === "running" ? "run-ttl-exceeded" : parked.state === "verifying" ? "verify-ttl-exceeded" : "deploy-ttl-exceeded";
			const detail = parked.state === "deploying"
				? `The change squash-merged at ${String(parked.mergeSha).slice(0, 7)} but the deploy was never observed serving it.`
				: `The run exceeded its ${parked.state} budget.`;
			const verdict = await this.doctorPort.consult({ kind, runId: parked.runId, intentId: parked.intentId, detail });
			await this.ctx.storage.put(QUEUE_KEY, swept);
			await this.appendEvent("run-parked", { runId: parked.runId, intentId: parked.intentId, note: verdict.publicNote }, now);
			await this.recordIntentOutcomeFact(parked.intentId, "parked", now, verdict.publicNote);
		});
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
		// The branch is the platform's to name: plain room/<intentSeq>/<attempt>
		// from latest main. No stacks, no parents, no expected order.
		const intentSeq = intent && Number.isSafeInteger(intent.openSeq) ? intent.openSeq : 0;
		const branch = `room/${intentSeq}/${attemptId.slice(8, 16)}`;
		await this.ctx.storage.transaction(async () => {
			const current = startRun(await this.loadQueue(), { runId: head.runId, attemptId, startedAt: now });
			await this.ctx.storage.put(QUEUE_KEY, current);
			await this.ctx.storage.put(BUDGET_KEY, { ...budget, spentUsd: budget.spentUsd + ESTIMATED_RUN_COST_USD } satisfies BudgetRecord);
			await this.appendEvent("run-started", { runId: head.runId, intentId: head.intentId, attemptId, branch }, now);
		});
		const result = await this.startRunViaPort({ runId: head.runId, attemptId, intentId: head.intentId, branch, evidence });
		if (result.accepted) return;
		await this.ctx.storage.transaction(async () => {
			let current = await this.loadQueue();
			current = completeRun(current, { runId: head.runId, attemptId, state: "failed", at: now, detail: result.reason });
			await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(current));
			await this.appendEvent("run-failed", { runId: head.runId, intentId: head.intentId, reason: result.reason }, now);
			await this.recordIntentOutcomeFact(head.intentId, "parked", now, `The builder could not start (${result.reason}).`);
		});
	}

	/** Mint the per-dispatch Git credential and hand the runner its complete job. */
	private async startRunViaPort(input: { runId: string; attemptId: string; intentId: string; branch: string; evidence: { requestText: string; requestedBy: string; annotations: unknown[] } }): Promise<{ accepted: true } | { accepted: false; reason: string }> {
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
	 * and hand the run to the deploy leg. Red CI parks-and-explains.
	 */
	private async observeCi(action: Extract<ReconcileAction, { kind: "observe-ci" }>, now: number): Promise<void> {
		const app = this.githubApp();
		if (!app) return;
		const verdict = classifyCheckRuns(await app.listCheckRuns(action.headSha));
		if (verdict.verdict === "pending") return;
		const attemptId = action.attemptId ?? "";
		if (verdict.verdict === "red") {
			const doctor = await this.doctorPort.consult({ kind: "ci-red", runId: action.runId, detail: `CI failed: ${verdict.failed.join(", ").slice(0, 300)}` });
			await this.ctx.storage.transaction(async () => {
				let queue = await this.loadQueue();
				const run = assertLiveAttempt(queue, { runId: action.runId, attemptId });
				queue = completeRun(queue, { runId: action.runId, attemptId, state: "failed", at: now, detail: doctor.publicNote });
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
				await this.appendEvent("run-failed", { runId: action.runId, intentId: run.intentId, reason: doctor.publicNote }, now);
				await this.recordIntentOutcomeFact(run.intentId, "parked", now, doctor.publicNote);
			});
			return;
		}
		// Green: derive the deterministic migration marker from the real diff,
		// then merge exactly the verified head SHA — nothing else can ride in.
		const migration = includesMigrationMarker(await app.listChangedFiles(action.prNumber));
		const merge = await app.squashMerge(action.prNumber, action.headSha);
		if (!merge.merged) {
			const doctor = await this.doctorPort.consult({ kind: "merge-refused", runId: action.runId, detail: `GitHub refused the exact-SHA squash merge (${merge.reason}).` });
			await this.ctx.storage.transaction(async () => {
				let queue = await this.loadQueue();
				const run = assertLiveAttempt(queue, { runId: action.runId, attemptId });
				queue = completeRun(queue, { runId: action.runId, attemptId, state: "failed", at: now, detail: doctor.publicNote });
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
				await this.appendEvent("run-failed", { runId: action.runId, intentId: run.intentId, reason: doctor.publicNote }, now);
				await this.recordIntentOutcomeFact(run.intentId, "parked", now, doctor.publicNote);
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
		// Dispatch the deploy leg. Best effort: the push-to-main trigger on the
		// same workflow is the backstop, and observe-deploy polls /version either way.
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
	 * (state may have moved); that parks to the Doctor seam instead.
	 */
	private async executeLivenessCheck(action: Extract<ReconcileAction, { kind: "liveness-check" }>, now: number): Promise<void> {
		const result = await syntheticLivenessCheck(this.env.PRODUCT_URL);
		if (result.ok) return;
		const good = (await this.ctx.storage.get<GoodShaRecord>(GOOD_SHA_KEY)) ?? { current: "", previous: null };
		if (action.migration || !good.previous) {
			const detail = action.migration
				? `The deploy of ${action.sha.slice(0, 7)} included a migration; auto-revert refuses to cross it. (${result.reason})`
				: `No previous observed-good revision exists to revert to. (${result.reason})`;
			const doctor = await this.doctorPort.consult({ kind: "liveness-failed-migration", detail });
			await this.ctx.storage.transaction(async () => {
				await this.appendEvent("liveness-failed", { reason: `${result.reason} — ${doctor.publicNote}` }, now);
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

	/** Every anchored payload rides to the builder verbatim, per-requester attributed. */
	private async collectEvidence(intent: Intent): Promise<{ requestText: string; requestedBy: string; annotations: unknown[] }> {
		const annotations: unknown[] = [];
		let requestText = "";
		for (const seq of [...intent.refs.annotationSeqs, ...intent.refs.utteranceSeqs]) {
			const event = await this.ctx.storage.get<LedgerEvent>(eventStorageKey(seq));
			if (!event) continue;
			if (event.kind === "annotation") annotations.push(event.payload);
			if (event.kind === "request-accepted" && typeof event.payload.text === "string") requestText = event.payload.text;
		}
		return { requestText, requestedBy: intent.openedBy, annotations };
	}

	private async handleChat(socket: WebSocket, message: Extract<ClientMessage, { type: "chat:send" }>): Promise<void> {
		const author = safeAuthor(message.author);
		const text = typeof message.text === "string" ? message.text.trim() : "";
		if (!author || !text.length) {
			this.notice(socket, "Chat needs an author and non-empty text.");
			return;
		}
		let event: LedgerEvent | undefined;
		await this.ctx.storage.transaction(async () => {
			event = await this.appendEvent("utterance", { author, text }, Date.now());
		});
		this.broadcast({ type: "chat:message", author, text, seq: event?.seq, at: event?.at });
	}

	private async handleRequest(socket: WebSocket, message: Extract<ClientMessage, { type: "request:target" | "request:comment" | "request:draw" }>): Promise<void> {
		const author = safeAuthor(message.author);
		if (!author) {
			this.notice(socket, "Requests need an author.");
			return;
		}
		const envelope = parseRequestEnvelope(message);
		if (!envelope) return;
		const control = await this.loadControl();
		if (control.frozen) {
			this.notice(socket, "The room is frozen by its owner: new requests are paused, chat stays open.");
			return;
		}
		const intents = await this.loadIntents();
		if (!underOpenIntentLimit(intents, author)) {
			this.notice(socket, "You already have 5 open requests. Wait for one to finish (or cancel one) before opening another.");
			return;
		}
		const now = Date.now();
		const intentId = `intent-${crypto.randomUUID()}`;
		let deadline = 0;
		await this.ctx.storage.transaction(async () => {
			const annotationEvent = await this.appendEvent("annotation", { by: author, annotation: envelope.annotation }, now);
			// The intent-opened seq is the room-unique ordinal that later names
			// the run branch: room/<openSeq>/<attempt>.
			const openedEvent = await this.appendEvent("intent-opened", { intentId, by: author }, now);
			const intent = createIntent({ id: intentId, openedBy: author, at: now, refs: { utteranceSeqs: [], annotationSeqs: [annotationEvent.seq] }, openSeq: openedEvent.seq });
			await this.ctx.storage.put(`${INTENT_PREFIX}${intentId}`, intent);
			deadline = cancelDeadline(now);
			await this.appendEvent("request-accepted", { intentId, by: author, text: envelope.text, at: now, cancelDeadline: deadline }, now);
		});
		// The immediate public ack, with its cancel window, straight back to the
		// requester and out to the room.
		socket.send(JSON.stringify({ type: "request:ack", intentId, cancelDeadline: deadline, clientSubmissionId: envelope.clientSubmissionId }));
		await this.broadcastFeed();
		// Pull the reconciler to just past the cancel window so dispatch is prompt.
		await this.scheduleReconcile(deadline + POKE_DELAY_MS);
	}

	private async handleCancel(socket: WebSocket, message: Extract<ClientMessage, { type: "request:cancel" }>): Promise<void> {
		const intentId = typeof message.intentId === "string" ? message.intentId : null;
		if (!intentId) return;
		const now = Date.now();
		let cancelled = false;
		await this.ctx.storage.transaction(async () => {
			const intent = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${intentId}`);
			if (!intent || intent.state !== "open") return;
			await this.ctx.storage.put(`${INTENT_PREFIX}${intentId}`, withdrawIntent(intent, { at: now }));
			await this.appendEvent("request-cancelled", { intentId, by: intent.openedBy }, now);
			await this.appendEvent("intent-withdrawn", { intentId }, now);
			cancelled = true;
		});
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
		const feed = renderFeed({ events, queue: await this.loadQueue(), now, frozen: control.frozen });
		const chat = events.filter((event) => event.kind === "utterance").map((event) => ({ author: event.payload.author, text: event.payload.text, seq: event.seq, at: event.at }));
		return { type: "room:snapshot", chat, feed, hasMore: start > 1, beforeSeq: start };
	}

	private async broadcastFeed(): Promise<void> {
		const now = Date.now();
		const control = await this.loadControl();
		const queue = await this.loadQueue();
		this.broadcast({ type: "feed:update", queue: renderQueueChips(queue, now), frozen: control.frozen });
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

	private async loadIntents(): Promise<Intent[]> {
		const page = await this.ctx.storage.list<Intent>({ prefix: INTENT_PREFIX });
		return [...page.values()];
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

	/** Only ever pulls the alarm EARLIER; the steady 60s cadence is the floor. */
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

export default {
	async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		const room = (): DurableObjectStub<RoomDO> => env.ROOM_DO.getByName("main") as DurableObjectStub<RoomDO>;

		if (pathname.startsWith("/api/admin/")) {
			// Owner levers require the ADMIN_TOKEN worker secret as a bearer
			// credential and fail closed when the secret is not provisioned.
			const token = env.ADMIN_TOKEN;
			if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
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
			// only verified deliveries set the dirty mark, and even a verified
			// poke decides NOTHING — the reconciler re-reads durable state.
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
			return env.ROOM_DO.getByName(name).fetch(request);
		}
		return new Response("Not found", { status: 404 });
	},
};
