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
	beginVerifying,
	completeRun,
	enqueueRun,
	nextDispatch,
	parkExpiredRun,
	pruneTerminalRuns,
	startRun,
	withinDailyBudget,
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
import { cancelDeadline, mayDispatch, parseRequestEnvelope } from "../contracts/envelope.js";
import { renderFeed, renderFeedItem, renderQueueChips } from "../contracts/feed.js";
import { StubDoctorPort, StubRunnerPort, type DoctorPort, type RunnerPort } from "./ports.js";

type RuntimeEnv = Env & { ADMIN_TOKEN?: string };

type ClientMessage =
	| { type: "chat:send"; author?: unknown; text?: unknown }
	| { type: "request:target" | "request:comment" | "request:draw"; author?: unknown; text?: unknown; annotation?: unknown; clientSubmissionId?: unknown }
	| { type: "request:cancel"; intentId?: unknown }
	| { type: "feed:history"; beforeSeq?: unknown };

type RoomControl = { frozen: boolean };
type BudgetRecord = { day: string; spentUsd: number; exhaustedAnnounced: boolean };

const EVENT_SEQUENCE_KEY = "sequence:event";
const EVENT_PREFIX = "event:";
const INTENT_PREFIX = "intent:";
const QUEUE_KEY = "queue";
const ROOM_CONTROL_KEY = "room-control";
const BUDGET_KEY = "budget";
const DIRTY_KEY = "dirty";

/** Level-triggered cadence: the reconciler re-reads state every minute no matter what. */
const RECONCILE_INTERVAL_MS = 60_000;
/** How soon a poke pulls the reconciler forward. */
const POKE_DELAY_MS = 1_000;
/** Snapshot depth for a fresh connection; older history pages via feed:history. */
const SNAPSHOT_EVENT_COUNT = 100;
const MAX_MESSAGE_BYTES = 128_000;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
/**
 * Honest per-run cost estimate until real metering lands in phase 2 (the
 * blank-slate design priced a change at $0.30-0.75).
 */
const ESTIMATED_RUN_COST_USD = 0.75;
const DEFAULT_DAILY_BUDGET_USD = 25;

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

function budgetDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function safeAuthor(value: unknown): string | null {
	// TODO(phase 2, non-negotiable before cutover): replace client-supplied
	// display names with real identity/auth. The rate limit below keys on this
	// name, which is honest bookkeeping but not a security boundary yet.
	return typeof value === "string" && AUTHOR.test(value) ? value : null;
}

/**
 * The Room Durable Object: single-threaded owner of the append-only event
 * ledger, the strict FIFO singleton build queue, intent records, and the feed
 * projection. Webhooks and client actions only append facts and set a dirty
 * mark; the 60-second level-triggered reconciler re-reads durable state and
 * drives the delta. No model output enters this truth path.
 */
export class RoomDO extends DurableObject<RuntimeEnv> {
	private runnerPort: RunnerPort = new StubRunnerPort();
	private doctorPort: DoctorPort = new StubDoctorPort();

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await this.scheduleReconcile(Date.now() + RECONCILE_INTERVAL_MS);
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
	 */
	async ingestRunnerResult(input: { runId?: unknown; attemptId?: unknown; state?: unknown; headSha?: unknown; reason?: unknown }): Promise<{ accepted: boolean; reason?: string }> {
		const { runId, attemptId, state } = input;
		if (typeof runId !== "string" || typeof attemptId !== "string" || typeof state !== "string") return { accepted: false, reason: "malformed" };
		if (state !== "verifying" && state !== "merged" && state !== "failed") return { accepted: false, reason: "unknown-state" };
		const now = Date.now();
		try {
			await this.ctx.storage.transaction(async () => {
				let queue = await this.loadQueue();
				const run = assertLiveAttempt(queue, { runId, attemptId });
				if (state === "verifying") {
					queue = beginVerifying(queue, { runId, attemptId, at: now });
					await this.appendEvent("run-verifying", { runId, intentId: run.intentId }, now);
				} else {
					const headSha = typeof input.headSha === "string" ? input.headSha : undefined;
					const reason = typeof input.reason === "string" ? input.reason.slice(0, 500) : "unspecified";
					queue = completeRun(queue, { runId, attemptId, state, at: now, detail: state === "failed" ? reason : headSha });
					await this.appendEvent(state === "merged" ? "run-merged" : "run-failed", { runId, intentId: run.intentId, ...(headSha ? { headSha } : {}), ...(state === "failed" ? { reason } : {}) }, now);
					await this.recordIntentOutcomeFact(run.intentId, state === "merged" ? "live" : "parked", now, state === "failed" ? reason : undefined);
				}
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(queue));
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
	 * the request pipeline. TODO(phase 2): the deploy rails consume this fact
	 * and perform the actual rollback; phase 1 records and announces it.
	 */
	async requestRevert(sha: string): Promise<{ recorded: boolean }> {
		if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Revert requires a full lowercase Git SHA.");
		const now = Date.now();
		await this.ctx.storage.transaction(async () => {
			await this.appendEvent("revert-requested", { sha, by: "owner" }, now);
		});
		await this.broadcastFeed();
		return { recorded: true };
	}

	/**
	 * The level-triggered reconciler. It never trusts why it woke: it re-reads
	 * durable state and drives every overdue delta — cancel windows elapsed,
	 * TTL-expired runs parked, the queue head dispatched — then reschedules.
	 */
	private async reconcile(): Promise<void> {
		const now = Date.now();
		await this.ctx.storage.delete(DIRTY_KEY);
		const control = await this.loadControl();

		// 1. TTL enforcement: park-and-explain, then the queue advances.
		await this.ctx.storage.transaction(async () => {
			const queue = await this.loadQueue();
			const { queue: swept, parked } = parkExpiredRun(queue, now);
			if (!parked) return;
			const verdict = await this.doctorPort.consult({ kind: "run-ttl-exceeded", runId: parked.runId, intentId: parked.intentId, detail: "The run exceeded its 10-minute budget." });
			await this.ctx.storage.put(QUEUE_KEY, swept);
			await this.appendEvent("run-parked", { runId: parked.runId, intentId: parked.intentId, note: verdict.publicNote }, now);
			await this.recordIntentOutcomeFact(parked.intentId, "parked", now, verdict.publicNote);
		});

		// 2. Enqueue accepted requests whose cancel window has elapsed.
		const intents = await this.loadIntents();
		for (const intent of intents) {
			if (intent.state !== "open" || !mayDispatch(intent.openedAt, now)) continue;
			await this.ctx.storage.transaction(async () => {
				const current = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${intent.id}`);
				if (!current || current.state !== "open") return;
				const runId = `run-${crypto.randomUUID()}`;
				const queue = enqueueRun(await this.loadQueue(), { runId, intentId: current.id, enqueuedAt: now });
				await this.ctx.storage.put(QUEUE_KEY, queue);
				await this.ctx.storage.put(`${INTENT_PREFIX}${current.id}`, dispatchIntent(current, { runId, at: now }));
				await this.appendEvent("run-queued", { runId, intentId: current.id }, now);
				await this.appendEvent("intent-dispatched", { intentId: current.id, runId }, now);
			});
		}

		// 3. Dispatch the FIFO head — one run at a time, never while frozen,
		// never past the daily spend budget.
		if (!control.frozen) await this.dispatchHead(now);

		await this.broadcastFeed();
	}

	private async dispatchHead(now: number): Promise<void> {
		const queue = await this.loadQueue();
		const head = nextDispatch(queue);
		if (!head) return;

		const budget = await this.loadBudget(now);
		if (!withinDailyBudget({ spentUsd: budget.spentUsd, budgetUsd: this.dailyBudgetUsd(), estimatedRunUsd: ESTIMATED_RUN_COST_USD })) {
			if (!budget.exhaustedAnnounced) {
				await this.ctx.storage.transaction(async () => {
					await this.appendEvent("budget-exhausted", { day: budget.day }, now);
					await this.ctx.storage.put(BUDGET_KEY, { ...budget, exhaustedAnnounced: true } satisfies BudgetRecord);
				});
			}
			return;
		}

		const attemptId = `attempt-${crypto.randomUUID()}`;
		const intent = await this.ctx.storage.get<Intent>(`${INTENT_PREFIX}${head.intentId}`);
		const evidence = intent ? await this.collectEvidence(intent) : { requestText: "", requestedBy: "unknown", annotations: [] };
		// TODO(phase 2): the real RunnerPort dispatches a sandbox run branched
		// from latest main. The stub refuses, and the refusal parks honestly.
		const result = await this.runnerPort.startRun({ runId: head.runId, attemptId, intentId: head.intentId, evidence });
		await this.ctx.storage.transaction(async () => {
			let current = await this.loadQueue();
			if (result.accepted) {
				current = startRun(current, { runId: head.runId, attemptId, startedAt: now });
				await this.ctx.storage.put(QUEUE_KEY, current);
				await this.ctx.storage.put(BUDGET_KEY, { ...budget, spentUsd: budget.spentUsd + ESTIMATED_RUN_COST_USD } satisfies BudgetRecord);
				await this.appendEvent("run-started", { runId: head.runId, intentId: head.intentId, attemptId }, now);
			} else {
				current = startRun(current, { runId: head.runId, attemptId, startedAt: now });
				current = completeRun(current, { runId: head.runId, attemptId, state: "failed", at: now, detail: result.reason });
				await this.ctx.storage.put(QUEUE_KEY, pruneTerminalRuns(current));
				await this.appendEvent("run-failed", { runId: head.runId, intentId: head.intentId, reason: result.reason }, now);
				await this.recordIntentOutcomeFact(head.intentId, "parked", now, `The builder is not available yet (${result.reason}).`);
			}
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
			const intent = createIntent({ id: intentId, openedBy: author, at: now, refs: { utteranceSeqs: [], annotationSeqs: [annotationEvent.seq] } });
			await this.ctx.storage.put(`${INTENT_PREFIX}${intentId}`, intent);
			await this.appendEvent("intent-opened", { intentId, by: author }, now);
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
			// TODO(phase 2): webhook signature verification. Safe meanwhile: a
			// poke only sets the dirty mark — the reconciler re-reads durable
			// state and decides everything itself.
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
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
