import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
	AUTHORING_ENVELOPE_POLICY,
	DELIVERY_POLICY,
	PLATFORM_LIMITS,
	fitsDurableRecord,
	storageDeleteBatches,
	utf8Bytes,
} from "@app-harness/contracts";
import {
	claimLedgerWorkItem as claimWorkItem,
	createLedgerWorkItem,
	deferLedgerWorkItem as deferWorkItem,
	recordLedgerCandidate as applyCandidate,
	recordLedgerClassification as applyClassification,
	recordLedgerExternalState as applyExternalState,
	recordLedgerPlan as applyPlan,
	releaseLedgerWorkItem as releaseWorkItem,
	startLedgerImplementation as applyImplementationStart,
	type LedgerClassification,
	type LedgerPhase,
	type LedgerPlan,
	type LedgerWorkItem,
} from "@app-harness/contracts/ledger";
import { assertOperatorCommandAllowed, operatorActionEffectKey, operatorCommandEffectSatisfied } from "@app-harness/contracts/operator";
import { beginOperatorWakeDelivery, operatorWakeDeliveryExhausted, queueOperatorWakeRecord, settleOperatorWakeRecord } from "@app-harness/contracts/wake";

type ChatMessage = {
	id: string;
	author: string;
	text: string;
	createdAt: number;
	sequence?: number;
};

type TargetRectangle = { x: number; y: number; width: number; height: number };

type TargetEnvelope = {
	targetId: string;
	selector: string;
	tag: string;
	role?: string;
	label?: string;
	text?: string;
	page: string;
	room: string;
	rect: TargetRectangle;
};

type DrawingPoint = { x: number; y: number };

type HarnessAnnotation =
	| { id: string; kind: "comment"; target: TargetEnvelope; text: string; createdAt: number; sequence?: number; workItemId?: string }
	| { id: string; kind: "draw"; points: DrawingPoint[]; page: string; createdAt: number; sequence?: number; workItemId?: string };

type PublicPhase = LedgerPhase;
type PublicActivity = { sequence: number; phase: PublicPhase; message: string; source: LedgerEvent["source"]; at: number };
type LedgerEvent = {
	id: string;
	workItemId: string;
	sequence: number;
	phase: LedgerPhase;
	message: string;
	source: "user" | "cloudflare-os" | "github" | "runner" | "ci" | "system";
	at: number;
};

type StoredWorkItem = LedgerWorkItem & {
	kind: "request" | "comment" | "draw";
	annotationId?: string;
	sequence?: number;
	eventSequence: number;
	latestEvent: LedgerEvent;
};

type PublicWorkItem = {
	id: string;
	annotationId?: string;
	clientSubmissionId?: string;
	kind: StoredWorkItem["kind"];
	summary: string;
	target?: TargetEnvelope;
	phase: PublicPhase;
	activity: PublicActivity[];
	activityHasMore?: boolean;
	createdAt: number;
	updatedAt: number;
	sequence?: number;
	githubIssue?: { number: number; url: string };
	githubPullRequestUrl?: string;
	githubCiUrl?: string;
	deploymentUrl?: string;
};

type ClientEvent =
	| { type: "chat:send"; author?: unknown; text?: unknown }
	| { type: "chat:history"; beforeSequence?: unknown }
	| { type: "harness:history"; collection?: unknown; beforeSequence?: unknown }
	| { type: "harness:work-item:history"; workItemId?: unknown; beforeEventSequence?: unknown }
	| { type: "workflow:request"; request?: unknown; target?: unknown; clientSubmissionId?: unknown }
	| { type: "harness:annotation"; annotation?: unknown; clientSubmissionId?: unknown }
	| { type: "harness:annotation:delete"; annotationId?: unknown }
	| { type: "harness:annotations:clear" };

type RecordPage<T> = { records: T[]; hasMore: boolean; beforeSequence?: number };
type WakeRecord = { id: string; workItemId: string; version: number; turn: number; state: "pending" | "in_flight"; attempts: number; availableAt: number; nextVersion?: number };
type StorageTransactionLike = DurableObjectTransaction;
type OperatorCommand =
	| { kind: "claim"; leaseId: string; leaseMs: number }
	| { kind: "release"; leaseId: string }
	| { kind: "defer"; leaseId: string; delayMs: number; message: string }
	| { kind: "classify"; leaseId: string; classification: LedgerClassification; message: string }
	| { kind: "plan"; leaseId: string; plan: LedgerPlan; message: string }
	| { kind: "create-issue"; leaseId: string; title: string; body: string; classification: string }
	| { kind: "implement"; leaseId: string; runId: string }
	| { kind: "record-candidate"; leaseId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }
	| { kind: "promote"; leaseId: string; pullRequestNumber: number; headSha: string; dispatchKey: string }
	| { kind: "record-state"; leaseId: string; phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; message: string; source: LedgerEvent["source"] };
type StoredOperatorAction = {
	id: number;
	workItemId: string;
	expectedVersion: number;
	idempotencyKey: string;
	command: OperatorCommand;
	status: "staged" | "applying" | "applied" | "rejected" | "needs_reconciliation";
	attempts: number;
	leaseExpiresAt?: number;
	executionToken?: string;
	result?: unknown;
	createdAt: number;
	updatedAt: number;
};
type OperatorResponse = { text: string; idempotencyKey: string };

type OperatorGatewayTransport = {
	submitWake(input: { workItemId: string; version: number; turn: number; wakeKey: string; state: string }): Promise<{ accepted: true } | { accepted: false; message: string }>;
};

/** External facts recorded by push (runner today, GitHub webhooks next). */
type ExternalFacts = {
	runnerResult?: { runId: string; state: string; classification?: string; stderrTail?: string; headSha?: string; pullRequest?: { number: number; url: string }; at: number };
};
type ExternalFactInput = { source: "runner"; workItemId: string; runId: string; fact: NonNullable<ExternalFacts["runnerResult"]> };

type RuntimeEnv = Omit<Env, "OPERATOR" | "OPERATOR_PAUSED"> & { OPERATOR: unknown; OPERATOR_PAUSED?: string };

const MESSAGE_PREFIX = "message:";
const ANNOTATION_PREFIX = "annotation:";
const WORK_ITEM_PREFIX = "ledger-work-item:";
const EVENT_PREFIX = "ledger-event:";
const WAKE_PREFIX = "ledger-wake:";
const EXTERNAL_FACT_PREFIX = "ledger-external-fact:";
const ACTION_PREFIX = "ledger-operator-action:";
const ACTION_KEY_PREFIX = "ledger-operator-action-key:";
const ACTION_ACTIVE_PREFIX = "ledger-operator-action-active:";
const ACTION_COUNTER_KEY = "sequence:operator-action";
const MESSAGE_ORDER_PREFIX = "message-order:";
const ANNOTATION_ORDER_PREFIX = "annotation-order:";
const WORK_ITEM_ORDER_PREFIX = "work-item-order:";
const SUBMISSION_INDEX_PREFIX = "submission-index:";
const MESSAGE_SEQUENCE_KEY = "sequence:message";
const ANNOTATION_SEQUENCE_KEY = "sequence:annotation";
const WORK_ITEM_SEQUENCE_KEY = "sequence:work-item";
const WAKE_BATCH_SIZE = 16;
const WAKE_RETRY_BASE_MS = 1_000;
const OPERATOR_LEASE_MAX_MS = 15 * 60_000;
// The operator turn is a bounded model loop, not a chat; the response lease
// only covers one wall-clocked turn plus its note delivery.
const OPERATOR_TURN_RESPONSE_LEASE_MS = 90_000;
const OPERATOR_TURN_DELIVERY_ATTEMPTS = 3;
const ACTION_APPLY_LEASE_MS = 60_000;
const STAGED_ACTION_RECOVERY_MS = 90_000;
const REJECTED_ACTION_PARK_THRESHOLD = 14;
// Just above the runner's own 650s hard deadline: by the time this fires the
// prior run is provably dead. With push-based completion this is a rare
// fallback, not the primary recovery path.
const STALLED_IMPLEMENTATION_MS = 12 * 60_000;
const UNLEASED_REVIVAL_DELAY_MS = 5_000;
const LEASED_REVIVAL_DELAY_MS = 8_000;
const OPERATOR_TURN_HARD_BUDGET = 60;
const READY_PHASES = new Set<LedgerPhase>(["submitted", "retryable"]);
const TERMINAL_PHASES = new Set<LedgerPhase>(["completed", "needs_review", "rejected"]);
const OPERATOR_ID = "cloudflare-os";
const GITHUB_REPOSITORY = "callil/autonomous-live-chat";
const PRODUCTION_DEPLOYMENT_HOST = "autonomous-live-chat.coda-a.workers.dev";

/**
 * Private typed capability exposed to the operator worker over a service
 * binding. These methods validate and persist decisions but never choose the
 * next one.
 */
export class LedgerService extends WorkerEntrypoint<RuntimeEnv> {
	private room(): DurableObjectStub<ChatRoom> { return this.env.CHAT_ROOM.getByName("main") as unknown as DurableObjectStub<ChatRoom>; }
	listReady(input?: { limit?: number }): Promise<StoredWorkItem[]> { return this.room().listReady(input); }
	getWorkItem(input: { workItemId: string }): Promise<StoredWorkItem | null> { return this.room().getLedgerWorkItem(input); }
	claim(input: { workItemId: string; leaseId: string; leaseMs: number }): Promise<StoredWorkItem> { return this.room().claim(input); }
	release(input: { workItemId: string; leaseId: string }): Promise<StoredWorkItem> { return this.room().release(input); }
	defer(input: { workItemId: string; leaseId: string; delayMs: number; message: string }): Promise<StoredWorkItem> { return this.room().defer(input); }
	recordClassification(input: { workItemId: string; leaseId: string; classification: LedgerClassification; message: string }): Promise<StoredWorkItem> { return this.room().recordClassification(input); }
	recordPlan(input: { workItemId: string; leaseId: string; plan: LedgerPlan; message: string }): Promise<StoredWorkItem> { return this.room().recordPlan(input); }
	startImplementation(input: { workItemId: string; leaseId: string; runId: string }): Promise<{ disposition: string; item: StoredWorkItem }> { return this.room().startImplementation(input); }
	recordCandidate(input: { workItemId: string; leaseId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<StoredWorkItem> { return this.room().recordCandidate(input); }
	recordExternalState(input: { workItemId: string; leaseId: string; phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> { return this.room().recordExternalState(input); }
	recordArtifacts(input: { workItemId: string; leaseId: string; artifacts: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> { return this.room().recordArtifacts(input); }
	stageOperatorAction(input: { workItemId: string; expectedVersion: number; command: OperatorCommand }): Promise<StoredOperatorAction> { return this.room().stageOperatorAction(input); }
	getOperatorAction(input: { actionId: number }): Promise<StoredOperatorAction | null> { return this.room().getOperatorAction(input); }
	listOperatorActions(input: { workItemId: string }): Promise<StoredOperatorAction[]> { return this.room().listOperatorActions(input); }
	beginOperatorAction(input: { actionId: number }): Promise<{ disposition: "execute" | "busy" | "applied" | "rejected" | "stale"; action: StoredOperatorAction; workItem: StoredWorkItem; executionToken?: string }> { return this.room().beginOperatorAction(input); }
	completeOperatorAction(input: { actionId: number; idempotencyKey: string; executionToken: string; result: unknown }): Promise<StoredOperatorAction> { return this.room().completeOperatorAction(input); }
	rejectOperatorAction(input: { actionId: number; executionToken: string; error?: string }): Promise<StoredOperatorAction> { return this.room().rejectOperatorAction(input); }
	recordOperatorNote(input: { workItemId: string; expectedVersion: number; turn: number; response: OperatorResponse }): Promise<void> { return this.room().recordOperatorNote(input.workItemId, input.expectedVersion, input.turn, input.response); }
	ingestExternalFact(input: unknown): Promise<{ accepted: boolean }> { return this.room().ingestExternalFact(input); }
}

/**
 * One room Durable Object owns chat, annotations, and the sole work ledger.
 * Its only alarm responsibility is idempotent wake delivery to the operator
 * worker; it contains no GitHub, runner, CI, or promotion decision loop.
 */
export class ChatRoom extends DurableObject<RuntimeEnv> {
	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await this.scheduleWakeAlarm();
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		let [messages, annotations, workItems, total] = await Promise.all([
			this.getMessagePage(),
			this.getAnnotationPage(),
			this.getWorkItemPage(),
			this.ctx.storage.get<number>(WORK_ITEM_SEQUENCE_KEY),
		]);
		if (!messages.records.length) {
			for (const message of seededMessages()) await this.saveMessage(message);
			messages = await this.getMessagePage();
		}
		server.send(JSON.stringify({ type: "chat:snapshot", messages: messages.records, hasMore: messages.hasMore, beforeSequence: messages.beforeSequence }));
		server.send(JSON.stringify({ type: "harness:annotations", annotations: annotations.records, hasMore: annotations.hasMore, beforeSequence: annotations.beforeSequence }));
		server.send(JSON.stringify({ type: "harness:work-items", workItems: await this.projectWorkItems(workItems.records), hasMore: workItems.hasMore, beforeSequence: workItems.beforeSequence, total: total ?? workItems.records.length }));
		this.broadcastPresence();
		return new Response(null, { status: 101, webSocket: client });
	}

	async alarm(): Promise<void> {
		await this.recoverExpiredLedgerLeases();
		await this.deliverOperatorWakes();
		await this.scheduleWakeAlarm();
	}

	async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
		if (typeof raw !== "string") return;
		if (utf8Bytes(raw) > PLATFORM_LIMITS.cloudflareDurableObject.keyAndValueBytes) {
			this.notice(socket, "That submission exceeds Cloudflare Durable Object's documented record size. Split it into smaller parts.");
			return;
		}
		let event: ClientEvent;
		try { event = JSON.parse(raw) as ClientEvent; } catch { return; }
		if (event.type === "chat:send") return this.sendChat(socket, event);
		if (event.type === "chat:history") {
			const page = await this.getMessagePage(normalizeSequence(event.beforeSequence));
			socket.send(JSON.stringify({ type: "chat:history", messages: page.records, hasMore: page.hasMore, beforeSequence: page.beforeSequence }));
			return;
		}
		if (event.type === "harness:history") {
			const before = normalizeSequence(event.beforeSequence);
			if (event.collection === "annotations") {
				const page = await this.getAnnotationPage(before);
				socket.send(JSON.stringify({ type: "harness:annotations:history", annotations: page.records, hasMore: page.hasMore, beforeSequence: page.beforeSequence }));
			} else if (event.collection === "work-items") {
				const page = await this.getWorkItemPage(before);
				socket.send(JSON.stringify({ type: "harness:work-items:history", workItems: await this.projectWorkItems(page.records), hasMore: page.hasMore, beforeSequence: page.beforeSequence }));
			}
			return;
		}
		if (event.type === "harness:work-item:history") {
			if (typeof event.workItemId !== "string" || !isUuid(event.workItemId)) return;
			const page = await this.getEventPage(event.workItemId, normalizeSequence(event.beforeEventSequence));
			socket.send(JSON.stringify({ type: "harness:work-item:events", workItemId: event.workItemId, activity: page.records.map(publicActivity), hasMore: page.hasMore, beforeEventSequence: page.beforeSequence }));
			return;
		}
		if (event.type === "workflow:request") return this.submitRequest(socket, event.request, event.target, event.clientSubmissionId);
		if (event.type === "harness:annotation") return this.addAnnotation(socket, event.annotation, event.clientSubmissionId);
		if (event.type === "harness:annotation:delete") return this.deleteAnnotation(socket, event.annotationId);
		if (event.type === "harness:annotations:clear") await this.clearAnnotations();
	}

	webSocketClose(): void { this.broadcastPresence(); }
	webSocketError(): void { this.broadcastPresence(); }

	async listReady(input?: { limit?: number }): Promise<StoredWorkItem[]> {
		const limit = Math.min(Math.max(input?.limit ?? 25, 1), 25);
		const now = Date.now();
		const ready: StoredWorkItem[] = [];
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) {
				if (TERMINAL_PHASES.has(item.phase)) continue;
				if (item.resumeAt !== null && item.resumeAt !== undefined && item.resumeAt > now) continue;
				if (READY_PHASES.has(item.phase) || !item.lease || item.lease.expiresAt <= now) ready.push(item);
				if (ready.length >= limit) return ready.toSorted((a, b) => a.createdAt - b.createdAt);
			}
		}
		return ready.toSorted((a, b) => a.createdAt - b.createdAt);
	}

	async getLedgerWorkItem(input: { workItemId: string }): Promise<StoredWorkItem | null> {
		return (await this.loadWorkItem(input.workItemId)) ?? null;
	}

	async claim(input: { workItemId: string; leaseId: string; leaseMs: number }): Promise<StoredWorkItem> {
		if (input.leaseMs > OPERATOR_LEASE_MAX_MS) throw new Error("Operator lease exceeds the bounded maximum.");
		const current = await this.requireWorkItem(input.workItemId);
		const result = claimWorkItem(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, now: Date.now(), leaseMs: input.leaseMs });
		if (result.disposition === "busy" || result.disposition === "deferred" || result.disposition === "terminal") return result.item as StoredWorkItem;
		return this.persistTransition(current.version, result.item as StoredWorkItem, `The operator ${result.disposition} this work item.`, "cloudflare-os");
	}

	async release(input: { workItemId: string; leaseId: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		return this.persistTransition(current.version, releaseWorkItem(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, now: Date.now() }) as StoredWorkItem, "The operator released this work item for the next turn.", "cloudflare-os");
	}

	async defer(input: { workItemId: string; leaseId: string; delayMs: number; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const updated = deferWorkItem(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, now: Date.now(), delayMs: input.delayMs }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "cloudflare-os", input.delayMs);
	}

	async recordClassification(input: { workItemId: string; leaseId: string; classification: LedgerClassification; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const updated = applyClassification(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, classification: input.classification, now: Date.now() }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "cloudflare-os");
	}

	async recordPlan(input: { workItemId: string; leaseId: string; plan: LedgerPlan; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const updated = applyPlan(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, plan: input.plan, now: Date.now() }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "cloudflare-os");
	}

	async startImplementation(input: { workItemId: string; leaseId: string; runId: string }): Promise<{ disposition: string; item: StoredWorkItem }> {
		const current = await this.requireWorkItem(input.workItemId);
		const result = applyImplementationStart(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, runId: input.runId, now: Date.now() });
		if (result.disposition !== "started") return { disposition: result.disposition, item: result.item as StoredWorkItem };
		const item = await this.persistTransition(current.version, result.item as StoredWorkItem, "The operator delegated the next missing artifact to an isolated NanoCodex run.", "cloudflare-os");
		return { disposition: result.disposition, item };
	}

	async recordCandidate(input: { workItemId: string; leaseId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		assertGitHubPullRequestUrl(input.pullRequestUrl, input.pullRequestNumber);
		const updated = applyCandidate(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, runId: input.runId, branch: input.branch, headSha: input.headSha, pullRequestNumber: input.pullRequestNumber, pullRequestUrl: input.pullRequestUrl, now: Date.now() }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "runner");
	}

	async recordExternalState(input: { workItemId: string; leaseId: string; phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const artifacts = normalizeArtifacts(input.artifacts ?? {});
		const source = normalizeLedgerEventSource(input.source);
		const updated = applyExternalState(current, { operatorId: OPERATOR_ID, leaseId: input.leaseId, phase: input.phase, artifacts, now: Date.now() }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), source);
	}

	async recordArtifacts(input: { workItemId: string; leaseId: string; artifacts: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		if (!current.lease || current.lease.operatorId !== OPERATOR_ID || current.lease.id !== input.leaseId || current.lease.expiresAt <= Date.now()) throw new Error("The operator does not own this work-item lease.");
		const updated = { ...current, artifacts: { ...current.artifacts, ...normalizeArtifacts(input.artifacts) }, version: current.version + 1, updatedAt: Date.now() };
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), normalizeLedgerEventSource(input.source));
	}

	async stageOperatorAction(input: { workItemId: string; expectedVersion: number; command: OperatorCommand }): Promise<StoredOperatorAction> {
		const workItem = await this.requireWorkItem(input.workItemId);
		// The operator decides that and what to plan (summary, CI profile, base
		// revision); the ledger owns the mechanical one-node stack identity and
		// derives it from its own durable facts before validation.
		if (input.command.kind === "plan" && input.command.plan && typeof input.command.plan === "object") {
			input.command = { ...input.command, plan: canonicalOneNodePlan(workItem, input.command.plan) };
		}
		// A candidate can only ever belong to the active implementation run; the
		// operator decides to record it, the ledger owns the run identity.
		if (input.command.kind === "record-candidate" && workItem.activeImplementation) {
			input.command = { ...input.command, runId: workItem.activeImplementation.runId, ...(workItem.plan ? { branch: workItem.plan.branch } : {}) };
		}
		// Deployment reconciliation facts are the ledger's own: the applied
		// promote action is the promotion evidence, and the deployment target is
		// this deployment's production origin. The operator still decides when.
		if (input.command.kind === "record-state" && (input.command.phase === "deployed" || input.command.phase === "completed")) {
			const artifacts: Record<string, unknown> = { ...(input.command.artifacts ?? {}) };
			// This deployment has exactly one production origin; any other value
			// is wrong by definition, so the ledger owns this fact outright.
			artifacts.deploymentUrl = `https://${PRODUCTION_DEPLOYMENT_HOST}/`;
			if (!artifacts.promotion && !workItem.artifacts.promotion) {
				const promote = (await this.listOperatorActions({ workItemId: workItem.id })).findLast((action) => action.command.kind === "promote" && action.status === "applied");
				if (promote && promote.command.kind === "promote") artifacts.promotion = { dispatchKey: promote.command.dispatchKey };
			}
			input.command = { ...input.command, artifacts };
		}
		validateOperatorCommand(input.command);
		const key = operatorActionEffectKey(workItem.id, input.command);
		const existingId = await this.ctx.storage.get<number>(`${ACTION_KEY_PREFIX}${key}`);
		if (existingId !== undefined) {
			const existing = await this.ctx.storage.get<StoredOperatorAction>(`${ACTION_PREFIX}${existingId}`);
			// A rejected action produced no external effect, so its semantic key is
			// free again: the operator may stage a corrected command in its place.
			if (existing && existing.status !== "rejected") {
				await this.queueOperatorWake(workItem);
				return existing;
			}
		}
		if (workItem.version !== input.expectedVersion) throw new Error("The operator action is based on a stale work-item revision.");
		this.requireActionLease(workItem, input.command, Date.now());
		assertOperatorCommandAllowed(workItem, input.command, Date.now());
		const action = await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<StoredWorkItem>(this.workItemKey(workItem.id));
			if (!current || current.version !== input.expectedVersion) throw new Error("The operator action became stale before it could be staged.");
			this.requireActionLease(current, input.command, Date.now());
			assertOperatorCommandAllowed(current, input.command, Date.now());
			const duplicateId = await txn.get<number>(`${ACTION_KEY_PREFIX}${key}`);
			if (duplicateId !== undefined) {
				const duplicate = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${duplicateId}`);
				if (duplicate && duplicate.status !== "rejected") return duplicate;
			}
			const activeId = await txn.get<number>(`${ACTION_ACTIVE_PREFIX}${current.id}`);
			if (activeId !== undefined) {
				const active = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${activeId}`);
				if (active && !["applied", "rejected"].includes(active.status)) throw new Error(`Operator action ${active.id} must reconcile before another mutation can be staged.`);
			}
			const id = ((await txn.get<number>(ACTION_COUNTER_KEY)) ?? 0) + 1;
			if (!Number.isSafeInteger(id)) throw new Error("Operator action counter is exhausted.");
			const now = Date.now();
			const action: StoredOperatorAction = { id, workItemId: current.id, expectedVersion: current.version, idempotencyKey: key, command: input.command, status: "staged", attempts: 0, createdAt: now, updatedAt: now };
			await Promise.all([txn.put(ACTION_COUNTER_KEY, id), txn.put(`${ACTION_PREFIX}${id}`, action), txn.put(`${ACTION_KEY_PREFIX}${key}`, id), txn.put(`${ACTION_ACTIVE_PREFIX}${current.id}`, id), this.putWakeInTransaction(txn, current)]);
			return action;
		});
		await this.appendActionEvent(workItem.id, workItem.phase, `The operator staged ${action.command.kind.replaceAll("-", " ")}.`);
		await this.scheduleWakeAlarm();
		return action;
	}

	async getOperatorAction(input: { actionId: number }): Promise<StoredOperatorAction | null> {
		if (!Number.isSafeInteger(input.actionId) || input.actionId < 1) throw new Error("Operator action ID is invalid.");
		return (await this.ctx.storage.get<StoredOperatorAction>(`${ACTION_PREFIX}${input.actionId}`)) ?? null;
	}

	async listOperatorActions(input: { workItemId: string }): Promise<StoredOperatorAction[]> {
		if (!isUuid(input.workItemId)) throw new Error("Operator action work-item ID is invalid.");
		const actions: StoredOperatorAction[] = [];
		for await (const page of this.storagePages<StoredOperatorAction>(ACTION_PREFIX)) {
			for (const action of page.values()) if (action.workItemId === input.workItemId) actions.push(action);
		}
		return actions.toSorted((left, right) => left.id - right.id);
	}

	async beginOperatorAction(input: { actionId: number }): Promise<{ disposition: "execute" | "busy" | "applied" | "rejected" | "stale"; action: StoredOperatorAction; workItem: StoredWorkItem; executionToken?: string }> {
		if (!Number.isSafeInteger(input.actionId) || input.actionId < 1) throw new Error("Operator action ID is invalid.");
		const begun = await this.ctx.storage.transaction(async (txn) => {
			const action = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${input.actionId}`);
			if (!action) throw new Error("Unknown operator action.");
			const workItem = await txn.get<StoredWorkItem>(this.workItemKey(action.workItemId));
			if (!workItem) throw new Error("Operator action lost its work item.");
			if (action.status === "applied") return { disposition: "applied" as const, action, workItem };
			if (action.status === "rejected") return { disposition: "rejected" as const, action, workItem };
			if (action.status === "needs_reconciliation" && operatorCommandEffectSatisfied(workItem, action.command)) {
				const reconciled: StoredOperatorAction = { ...action, status: "applied", result: { reconciled: true, workItemVersion: workItem.version }, executionToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() };
				await Promise.all([txn.put(`${ACTION_PREFIX}${action.id}`, reconciled), txn.delete(this.actionWakeKey(action.id)), txn.delete(`${ACTION_ACTIVE_PREFIX}${action.workItemId}`)]);
				return { disposition: "applied" as const, action: reconciled, workItem };
			}
			const now = Date.now();
			if (action.status === "applying") return { disposition: (action.leaseExpiresAt ?? 0) > now ? "busy" as const : "stale" as const, action, workItem };
			if (workItem.version !== action.expectedVersion) return { disposition: "stale" as const, action, workItem };
			try { this.requireActionLease(workItem, action.command, now); } catch { return { disposition: "stale" as const, action, workItem }; }
			try { assertOperatorCommandAllowed(workItem, action.command, now); } catch { return { disposition: "stale" as const, action, workItem }; }
			const executionToken = crypto.randomUUID();
			const applying: StoredOperatorAction = { ...action, status: "applying", attempts: action.attempts + 1, executionToken, leaseExpiresAt: now + ACTION_APPLY_LEASE_MS, updatedAt: now };
			await Promise.all([
				txn.put(`${ACTION_PREFIX}${action.id}`, applying),
				txn.put(this.actionWakeKey(action.id), { id: `action:${action.id}`, workItemId: workItem.id, version: workItem.version, turn: 1, state: "pending", attempts: 0, availableAt: applying.leaseExpiresAt! }),
			]);
			await this.scheduleAlarmInTransaction(txn, applying.leaseExpiresAt!);
			return { disposition: "execute" as const, action: applying, workItem, executionToken };
		});
		if (begun.disposition === "execute") {
			await this.appendActionEvent(begun.workItem.id, begun.workItem.phase, `The operator is executing ${begun.action.command.kind.replaceAll("-", " ")}.`);
			await this.scheduleWakeAlarm();
		}
		return begun;
	}

	async completeOperatorAction(input: { actionId: number; idempotencyKey: string; executionToken: string; result: unknown }): Promise<StoredOperatorAction> {
		const completed = await this.ctx.storage.transaction(async (txn) => {
			const action = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${input.actionId}`);
			if (!action || action.idempotencyKey !== input.idempotencyKey) throw new Error("Operator action completion does not match its durable reservation.");
			if (action.status === "applied") return action;
			if (action.executionToken !== input.executionToken) throw new Error("Operator action completion lost its execution lease.");
			if (action.status !== "applying") throw new Error("Only an applying operator action can complete.");
			if ((action.leaseExpiresAt ?? 0) <= Date.now()) throw new Error("Operator action execution lease expired before completion.");
			const completed: StoredOperatorAction = { ...action, status: "applied", result: input.result, executionToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() };
			if (!fitsDurableRecord(`${ACTION_PREFIX}${action.id}`, completed)) throw new Error("Operator action result exceeds one durable record.");
			const workItem = await txn.get<StoredWorkItem>(this.workItemKey(action.workItemId));
			await Promise.all([txn.put(`${ACTION_PREFIX}${action.id}`, completed), txn.delete(this.actionWakeKey(action.id)), txn.delete(`${ACTION_ACTIVE_PREFIX}${action.workItemId}`), ...(workItem && !TERMINAL_PHASES.has(workItem.phase) ? [this.putWakeInTransaction(txn, workItem)] : [])]);
			return completed;
		});
		if (completed.command.kind !== "defer") {
			const workItem = await this.loadWorkItem(completed.workItemId);
			if (workItem) {
				await this.appendActionEvent(workItem.id, workItem.phase, `The operator completed ${completed.command.kind.replaceAll("-", " ")}.`);
				await this.scheduleWakeAlarm();
			}
		}
		return completed;
	}

	async rejectOperatorAction(input: { actionId: number; executionToken: string; error?: string }): Promise<StoredOperatorAction> {
		const failure = typeof input.error === "string" && input.error.trim() ? input.error.trim().replace(/\s+/gu, " ").slice(0, 500) : undefined;
		const rejected = await this.ctx.storage.transaction(async (txn) => {
			const action = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${input.actionId}`);
			if (!action) throw new Error("Unknown operator action.");
			if (action.status === "applied") throw new Error("Applied operator actions cannot be rejected.");
			if (action.status !== "applying" || action.executionToken !== input.executionToken || (action.leaseExpiresAt ?? 0) <= Date.now()) throw new Error("Operator action rejection lost its execution lease.");
			const rejected: StoredOperatorAction = { ...action, status: "rejected", ...(failure ? { result: { error: failure } } : {}), executionToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() };
			const workItem = await txn.get<StoredWorkItem>(this.workItemKey(action.workItemId));
			await Promise.all([txn.put(`${ACTION_PREFIX}${action.id}`, rejected), txn.delete(this.actionWakeKey(action.id)), txn.delete(`${ACTION_ACTIVE_PREFIX}${action.workItemId}`), ...(workItem && !TERMINAL_PHASES.has(workItem.phase) ? [this.putWakeInTransaction(txn, workItem)] : [])]);
			return rejected;
		});
		const workItem = await this.loadWorkItem(rejected.workItemId);
		if (workItem) {
			await this.appendActionEvent(workItem.id, workItem.phase, `The operator could not apply ${rejected.command.kind.replaceAll("-", " ")}${failure ? `: ${failure}` : "."}`);
			// Rejections re-queue wakes, so an operator that cannot converge would
			// otherwise churn forever. A bounded rejection budget parks truthfully.
			const rejections = (await this.listOperatorActions({ workItemId: workItem.id })).filter((action) => action.status === "rejected").length;
			if (!TERMINAL_PHASES.has(workItem.phase) && rejections >= REJECTED_ACTION_PARK_THRESHOLD) {
				const parked = { ...workItem, phase: "needs_review" as const, version: workItem.version + 1, lease: null, activeImplementation: null, updatedAt: Date.now() };
				await this.persistTransition(workItem.version, parked, `The operator rejected ${rejections} staged commands for this work item; work is parked for review with its ledger and artifacts intact.`, "system");
			} else {
				await this.scheduleWakeAlarm();
			}
		}
		return rejected;
	}

	async recordOperatorNote(workItemId: string, expectedVersion: number, turn: number, response: OperatorResponse): Promise<void> {
		if (!isUuid(workItemId) || !response || typeof response.text !== "string") return;
		const message = normalizeOperatorMessage(response.text);
		const key = normalizeOperatorNoteKey(response.idempotencyKey) ?? crypto.randomUUID();
		const item = await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<StoredWorkItem>(this.workItemKey(workItemId));
			if (!current) return undefined;
			const wakeKey = `${WAKE_PREFIX}${current.id}`;
			const wake = await txn.get<WakeRecord>(wakeKey);
			const settledWake = settleOperatorWakeRecord(wake, { currentVersion: current.version, expectedVersion, turn, terminal: TERMINAL_PHASES.has(current.phase), now: Date.now() });
			if (settledWake === undefined) return undefined;
			const noteKey = `ledger-operator-note:${current.id}:${key}`;
			if (await txn.get(noteKey)) return undefined;
			const at = Date.now();
			const eventSequence = current.eventSequence + 1;
			const event: LedgerEvent = { id: `${current.id}:${eventSequence}`, workItemId: current.id, sequence: eventSequence, phase: current.phase, message, source: "cloudflare-os", at };
			const updated = { ...current, eventSequence, latestEvent: event, updatedAt: at };
			const writes: Promise<unknown>[] = [
				txn.put(noteKey, { workItemId: current.id, message, at }),
				txn.put(this.workItemKey(updated.id), updated),
				txn.put(this.eventKey(updated.id, eventSequence), event),
			];
			if (settledWake === null) {
				// A completed turn with no durable progress is a natural stop, not a
				// reason to pay for the same prompt again. Any later state change will
				// create a fresh wake.
				writes.push(txn.delete(wakeKey));
			} else {
				writes.push(txn.put(wakeKey, settledWake), this.scheduleAlarmInTransaction(txn, settledWake.availableAt));
			}
			await Promise.all(writes);
			return updated;
		});
		if (item) {
			await this.broadcastWorkItem(item);
			await this.scheduleWakeAlarm();
		}
	}

	/**
	 * One entry point for pushed external facts (the runner today, GitHub
	 * webhooks next). A fact never writes work-item state directly: it is
	 * verified against the item, merged monotonically into the per-item fact
	 * record the wake snapshot embeds, and answered with an immediate wake so
	 * the operator stages the actual transition itself.
	 */
	async ingestExternalFact(input: unknown): Promise<{ accepted: boolean }> {
		const parsed = normalizeExternalFactInput(input);
		if (!parsed) return { accepted: false };
		const merged = await this.ctx.storage.transaction(async (txn) => {
			const item = await txn.get<StoredWorkItem>(this.workItemKey(parsed.workItemId));
			if (!item || TERMINAL_PHASES.has(item.phase)) return undefined;
			// The ledger run identifier is the bearer credential: minted per
			// implementation run, known only to the ledger and the isolated
			// runner process, and it doubles as the dedupe key.
			if (item.phase !== "implementing" || item.activeImplementation?.runId !== parsed.runId) return undefined;
			const key = `${EXTERNAL_FACT_PREFIX}${item.id}`;
			const facts = (await txn.get<ExternalFacts>(key)) ?? {};
			if (facts.runnerResult?.runId === parsed.runId) return { duplicate: true };
			facts.runnerResult = parsed.fact;
			await txn.put(key, facts);
			return { duplicate: false };
		});
		if (!merged) return { accepted: false };
		if (merged.duplicate) return { accepted: true };
		const current = await this.loadWorkItem(parsed.workItemId);
		if (current) {
			const message = parsed.fact.state === "pull-request-opened"
				? "The isolated runner reported a candidate pull request."
				: `The isolated runner finished: ${parsed.fact.state}${parsed.fact.classification ? ` (${parsed.fact.classification})` : ""}.`;
			if (current.resumeAt !== null && current.resumeAt !== undefined) {
				// The completion supersedes any defer that was waiting for it.
				await this.persistTransition(current.version, { ...current, resumeAt: null, version: current.version + 1 }, message, "runner");
			} else {
				await this.appendActionEvent(current.id, current.phase, message, "runner");
				await this.queueOperatorWake(current);
			}
		}
		return { accepted: true };
	}

	private requireActionLease(workItem: StoredWorkItem, command: OperatorCommand, now: number): void {
		if (command.kind === "claim") return;
		if (!workItem.lease || workItem.lease.operatorId !== OPERATOR_ID || workItem.lease.id !== command.leaseId || workItem.lease.expiresAt <= now) {
			throw new Error("An operator action requires the current durable work-item lease.");
		}
	}

	private async appendActionEvent(workItemId: string, phase: LedgerPhase, message: string, source: LedgerEvent["source"] = "cloudflare-os"): Promise<void> {
		const item = await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<StoredWorkItem>(this.workItemKey(workItemId));
			if (!current) return undefined;
			const eventSequence = current.eventSequence + 1;
			const event: LedgerEvent = { id: `${current.id}:${eventSequence}`, workItemId: current.id, sequence: eventSequence, phase, message: normalizeOperatorMessage(message), source, at: Date.now() };
			const updated = { ...current, eventSequence, latestEvent: event, updatedAt: event.at };
			await Promise.all([txn.put(this.workItemKey(updated.id), updated), txn.put(this.eventKey(updated.id, eventSequence), event)]);
			return updated;
		});
		if (item) await this.broadcastWorkItem(item);
	}

	private async sendChat(socket: WebSocket, event: Extract<ClientEvent, { type: "chat:send" }>): Promise<void> {
		const text = typeof event.text === "string" ? event.text.trim() : "";
		if (!text) return;
		const message: ChatMessage = { id: crypto.randomUUID(), author: normalizeAuthor(event.author), text, createdAt: Date.now(), sequence: Number.MAX_SAFE_INTEGER };
		if (!fitsDurableRecord(this.messageKey(message.id), message)) return this.notice(socket, "That message exceeds Cloudflare Durable Object's documented record size. Split it into smaller messages.");
		message.sequence = await this.nextSequence(MESSAGE_SEQUENCE_KEY);
		await this.saveMessage(message);
		this.broadcast({ type: "chat:message", message });
	}

	private async submitRequest(socket: WebSocket, rawRequest: unknown, rawTarget: unknown, rawSubmissionId: unknown, existingId?: string): Promise<void> {
		const request = normalizeRequest(rawRequest);
		if (!request) return this.notice(socket, "Describe the change before submitting.");
		const target = normalizeTarget(rawTarget) ?? undefined;
		const submissionId = normalizeSubmissionId(rawSubmissionId);
		let existing = existingId ? await this.loadWorkItem(existingId) : undefined;
		if (!existing && submissionId) {
			const id = await this.ctx.storage.get<string>(`${SUBMISSION_INDEX_PREFIX}${submissionId}`);
			if (id) existing = await this.loadWorkItem(id);
		}
		if (existing) {
			await this.broadcastWorkItem(existing);
			await this.queueOperatorWake(existing);
			return;
		}
		const item = this.newWorkItem({ kind: "request", request, target, submissionId, now: Date.now() });
		if (!fitsDurableRecord(this.workItemKey(item.id), item)) return this.notice(socket, "That request exceeds one durable record. Split it into smaller implementation steps.");
		const admitted = await this.saveNewWorkItem(item);
		await this.broadcastWorkItem(admitted.item);
		await this.scheduleWakeAlarm();
	}

	private async addAnnotation(socket: WebSocket, raw: unknown, rawSubmissionId: unknown): Promise<void> {
		const annotation = normalizeAnnotation(raw);
		if (!annotation) return this.notice(socket, "That comment or drawing could not be saved.");
		const submissionId = normalizeSubmissionId(rawSubmissionId);
		if (annotation.kind === "comment") {
			const item = this.newWorkItem({ kind: "comment", request: annotation.text, target: annotation.target, submissionId, annotationId: annotation.id, now: Date.now() });
			annotation.workItemId = item.id;
			const admitted = await this.saveNewWorkItem(item, annotation);
			if (admitted.created && admitted.annotation) this.broadcast({ type: "harness:annotation:added", annotation: admitted.annotation });
			await this.broadcastWorkItem(admitted.item);
			await this.scheduleWakeAlarm();
			return;
		}
		annotation.sequence = await this.nextSequence(ANNOTATION_SEQUENCE_KEY);
		await this.ctx.storage.transaction(async (txn) => {
			await Promise.all([
				txn.put(this.annotationKey(annotation.id), annotation),
				txn.put(this.orderKey(ANNOTATION_ORDER_PREFIX, annotation.sequence!, annotation.id), annotation.id),
			]);
		});
		this.broadcast({ type: "harness:annotation:added", annotation });
		this.notice(socket, "Drawing saved as public context. Add a text comment when you want the operator to implement it.");
	}

	private async deleteAnnotation(socket: WebSocket, rawId: unknown): Promise<void> {
		if (typeof rawId !== "string" || !isUuid(rawId)) return this.notice(socket, "That annotation could not be removed.");
		const annotation = await this.ctx.storage.get<HarnessAnnotation>(this.annotationKey(rawId));
		if (!annotation) return;
		await this.ctx.storage.delete([this.annotationKey(rawId), ...(annotation.sequence ? [this.orderKey(ANNOTATION_ORDER_PREFIX, annotation.sequence, annotation.id)] : [])]);
		this.broadcast({ type: "harness:annotation:deleted", annotationId: rawId });
	}

	private async clearAnnotations(): Promise<void> {
		for await (const page of this.storagePages<HarnessAnnotation>(ANNOTATION_PREFIX)) {
			const keys = [...page].flatMap(([key, annotation]) => [key, ...(annotation.sequence ? [this.orderKey(ANNOTATION_ORDER_PREFIX, annotation.sequence, annotation.id)] : [])]);
			for (const batch of storageDeleteBatches(keys)) await this.ctx.storage.delete(batch);
		}
		for await (const page of this.storagePages<string>(ANNOTATION_ORDER_PREFIX)) for (const batch of storageDeleteBatches([...page.keys()])) await this.ctx.storage.delete(batch);
		this.broadcast({ type: "harness:annotations:cleared" });
	}

	private newWorkItem(input: { kind: StoredWorkItem["kind"]; request: string; target?: TargetEnvelope; submissionId?: string; annotationId?: string; now: number }): StoredWorkItem {
		const id = crypto.randomUUID();
		const base = createLedgerWorkItem({ id, room: "main", request: input.request, target: input.target, submissionId: input.submissionId, now: input.now });
		const event: LedgerEvent = { id: `${id}:1`, workItemId: id, sequence: 1, phase: "submitted", message: "Request received and durably queued for the operator.", source: "user", at: input.now };
		return { ...base, kind: input.kind, annotationId: input.annotationId, eventSequence: 1, latestEvent: event };
	}

	private async saveNewWorkItem(item: StoredWorkItem, annotation?: HarnessAnnotation): Promise<{ item: StoredWorkItem; created: boolean; annotation?: HarnessAnnotation }> {
		return this.ctx.storage.transaction(async (txn) => {
			if (item.submissionId) {
				const existingId = await txn.get<string>(`${SUBMISSION_INDEX_PREFIX}${item.submissionId}`);
				if (existingId) {
					const existing = await txn.get<StoredWorkItem>(this.workItemKey(existingId));
					if (existing) return { item: existing, created: false };
				}
			}
			const sequence = ((await txn.get<number>(WORK_ITEM_SEQUENCE_KEY)) ?? 0) + 1;
			if (!Number.isSafeInteger(sequence)) throw new Error("Work-item sequence is exhausted.");
			item.sequence = sequence;
			await txn.put(WORK_ITEM_SEQUENCE_KEY, sequence);
			let persistedAnnotation: HarnessAnnotation | undefined;
			if (annotation) {
				const annotationSequence = ((await txn.get<number>(ANNOTATION_SEQUENCE_KEY)) ?? 0) + 1;
				if (!Number.isSafeInteger(annotationSequence)) throw new Error("Annotation sequence is exhausted.");
				persistedAnnotation = { ...annotation, sequence: annotationSequence } as HarnessAnnotation;
				await txn.put(ANNOTATION_SEQUENCE_KEY, annotationSequence);
			}
			await Promise.all([
				txn.put(this.workItemKey(item.id), item),
				txn.put(this.orderKey(WORK_ITEM_ORDER_PREFIX, item.sequence, item.id), item.id),
				txn.put(this.eventKey(item.id, item.latestEvent.sequence), item.latestEvent),
				this.putWakeInTransaction(txn, item),
				...(persistedAnnotation ? [txn.put(this.annotationKey(persistedAnnotation.id), persistedAnnotation), txn.put(this.orderKey(ANNOTATION_ORDER_PREFIX, persistedAnnotation.sequence!, persistedAnnotation.id), persistedAnnotation.id)] : []),
				...(item.submissionId ? [txn.put(`${SUBMISSION_INDEX_PREFIX}${item.submissionId}`, item.id)] : []),
			]);
			return { item, created: true, annotation: persistedAnnotation };
		});
	}

	private async persistTransition(expectedVersion: number, nextItem: StoredWorkItem, message: string, source: LedgerEvent["source"], wakeDelayMs = 0): Promise<StoredWorkItem> {
		const at = Date.now();
		const persisted = await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<StoredWorkItem>(this.workItemKey(nextItem.id));
			if (!current || current.version !== expectedVersion) throw new Error("Work item changed before this operator transition could commit.");
			const eventSequence = current.eventSequence + 1;
			const event: LedgerEvent = { id: `${current.id}:${eventSequence}`, workItemId: current.id, sequence: eventSequence, phase: nextItem.phase, message, source, at };
			const item = { ...nextItem, eventSequence, latestEvent: event, updatedAt: at };
			await Promise.all([txn.put(this.workItemKey(item.id), item), txn.put(this.eventKey(item.id, eventSequence), event), this.putWakeInTransaction(txn, item, wakeDelayMs)]);
			return item;
		});
		await this.broadcastWorkItem(persisted);
		await this.scheduleWakeAlarm();
		return persisted;
	}

	private async queueOperatorWake(item: StoredWorkItem, delayMs = 0): Promise<void> {
		if (TERMINAL_PHASES.has(item.phase)) return;
		await this.ctx.storage.transaction((txn) => this.putWakeInTransaction(txn, item, delayMs));
		await this.scheduleWakeAlarm();
	}

	private async putWakeInTransaction(txn: StorageTransactionLike, item: StoredWorkItem, delayMs = 0): Promise<void> {
		if (TERMINAL_PHASES.has(item.phase)) return;
		const key = `${WAKE_PREFIX}${item.id}`;
		const now = Date.now();
		const existing = await txn.get<WakeRecord>(key);
		const deliveredTurn = (await txn.get<number>(this.wakeTurnKey(item.id))) ?? 0;
		const wake = queueOperatorWakeRecord(existing, { id: item.id, workItemId: item.id, version: item.version, now, delayMs, turnFloor: deliveredTurn + 1 });
		await txn.put(key, wake);
		await this.scheduleAlarmInTransaction(txn, wake.availableAt);
	}

	private wakeTurnKey(id: string): string { return `ledger-wake-turn:${id}`; }

	private async scheduleAlarmInTransaction(txn: StorageTransactionLike, availableAt: number): Promise<void> {
		if (this.env.OPERATOR_PAUSED === "true") return;
		const target = Math.max(Date.now() + 25, availableAt);
		const existing = await txn.getAlarm();
		if (existing === null || target < existing) await txn.setAlarm(target);
	}

	private async deliverOperatorWakes(): Promise<void> {
		// Durable emergency brake: preserve the ledger and pending wakes while
		// preventing a misbehaving external operator from consuming more turns.
		if (this.env.OPERATOR_PAUSED === "true") return;
		const now = Date.now();
		const due: Array<[string, WakeRecord]> = [];
		for await (const page of this.storagePages<WakeRecord>(WAKE_PREFIX)) {
			for (const entry of page.entries()) if (entry[1].availableAt <= now) due.push(entry);
		}
		const wakes = due.toSorted((left, right) => left[1].availableAt - right[1].availableAt).slice(0, WAKE_BATCH_SIZE);
		for (const [key, wake] of wakes) {
			const reservation = await this.ctx.storage.transaction(async (txn) => {
				let currentWake = await txn.get<WakeRecord>(key);
				const currentItem = await txn.get<StoredWorkItem>(this.workItemKey(wake.workItemId));
				if (!currentWake || currentWake.version !== wake.version || currentWake.availableAt > now) return undefined;
				if (!currentItem) {
					await txn.delete(key);
					return undefined;
				}
				if (operatorWakeDeliveryExhausted(currentWake, OPERATOR_TURN_DELIVERY_ATTEMPTS)) {
					await txn.delete(key);
					return { kind: "exhausted", item: currentItem } as const;
				}
				// The monotonic per-item turn counter doubles as a lifetime budget:
				// an operator that keeps completing turns without converging parks.
				if (((await txn.get<number>(this.wakeTurnKey(wake.workItemId))) ?? 0) >= OPERATOR_TURN_HARD_BUDGET) {
					await txn.delete(key);
					return { kind: "exhausted", item: currentItem } as const;
				}
				const marked = beginOperatorWakeDelivery(currentWake, { currentVersion: currentItem.version, terminal: TERMINAL_PHASES.has(currentItem.phase), now, responseLeaseMs: OPERATOR_TURN_RESPONSE_LEASE_MS });
				if (!marked) {
					await txn.delete(key);
					return undefined;
				}
				await txn.put(key, marked);
				await txn.put(this.wakeTurnKey(wake.workItemId), Math.max((await txn.get<number>(this.wakeTurnKey(wake.workItemId))) ?? 0, marked.turn));
				await this.scheduleAlarmInTransaction(txn, marked.availableAt);
				return { kind: "deliver", wake: marked } as const;
			});
			if (!reservation) continue;
			if (reservation.kind === "exhausted") {
				const exhausted = reservation.item;
				if (!TERMINAL_PHASES.has(exhausted.phase)) {
					const parked = { ...exhausted, phase: "needs_review" as const, version: exhausted.version + 1, lease: null, activeImplementation: null, updatedAt: Date.now() };
					await this.persistTransition(exhausted.version, parked, "The operator did not return a completed turn after three durable delivery attempts. Work is parked for review without losing its ledger or artifacts.", "system");
				}
				continue;
			}
			const inFlight = reservation.wake;
			// Embed the authoritative ledger state in the wake itself. The bounded
			// operator model then stages its one command directly instead of
			// spending its small turn budget re-reading state it already owns.
			const stateItem = await this.loadWorkItem(inFlight.workItemId);
			const stateActions = stateItem ? await this.listOperatorActions({ workItemId: stateItem.id }) : [];
			const stateFacts = stateItem ? await this.ctx.storage.get<ExternalFacts>(`${EXTERNAL_FACT_PREFIX}${stateItem.id}`) : undefined;
			// Each delivered or recovery turn keeps its independently idempotent key.
			const wakeKey = `ledger-event:${inFlight.id}:v${inFlight.version}:t${inFlight.turn}`;
			try {
				const result = await (this.env.OPERATOR as OperatorGatewayTransport).submitWake({
					workItemId: inFlight.workItemId,
					version: inFlight.version,
					turn: inFlight.turn,
					wakeKey,
					state: operatorWakeState(stateItem, stateActions, stateFacts),
				});
				if (!result.accepted) throw new Error(`The operator worker declined the durable wake: ${result.message}`);
			} catch (error) {
				console.error("Failed to deliver the durable ledger wake to the operator worker.", { workItemId: inFlight.workItemId, version: inFlight.version, turn: inFlight.turn, error });
				// A delivery failure must be public: silent retries looked exactly
				// like a healthy idle system for hours.
				const failedItem = await this.loadWorkItem(inFlight.workItemId);
				if (failedItem) await this.appendActionEvent(failedItem.id, failedItem.phase, `Operator wake delivery failed (turn ${inFlight.turn}): ${String(error instanceof Error ? error.message : error).slice(0, 200)}. Retrying.`).catch(() => undefined);
				await this.ctx.storage.transaction(async (txn) => {
					const current = await txn.get<WakeRecord>(key);
					if (current?.version === inFlight.version && (current.turn ?? 1) === inFlight.turn) await txn.put(key, { ...inFlight, state: "pending", availableAt: now + Math.min(WAKE_RETRY_BASE_MS * 2 ** Math.min(inFlight.attempts, 8), 5 * 60_000) });
				});
			}
		}
	}

	private async scheduleWakeAlarm(): Promise<void> {
		if (this.env.OPERATOR_PAUSED === "true") {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		let availableAt: number | undefined;
		for await (const page of this.storagePages<WakeRecord>(WAKE_PREFIX)) {
			for (const wake of page.values()) availableAt = availableAt === undefined ? wake.availableAt : Math.min(availableAt, wake.availableAt);
		}
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			// Every live item needs a future alarm even with no pending wake:
			// recovery is what re-queues wakes, and nothing else re-arms a
			// dormant room. Paced revival covers parked turns in both lease states.
			for (const item of page.values()) {
				if (TERMINAL_PHASES.has(item.phase)) continue;
				const at = Date.now() + (item.lease ? LEASED_REVIVAL_DELAY_MS : UNLEASED_REVIVAL_DELAY_MS);
				availableAt = availableAt === undefined ? at : Math.min(availableAt, at);
			}
		}
		for await (const page of this.storagePages<StoredOperatorAction>(ACTION_PREFIX)) {
			for (const action of page.values()) {
				if (action.status === "applying" && action.leaseExpiresAt && action.leaseExpiresAt > Date.now()) availableAt = availableAt === undefined ? action.leaseExpiresAt : Math.min(availableAt, action.leaseExpiresAt);
				if (action.status === "staged") availableAt = availableAt === undefined ? action.updatedAt + STAGED_ACTION_RECOVERY_MS : Math.min(availableAt, action.updatedAt + STAGED_ACTION_RECOVERY_MS);
			}
		}
		if (availableAt !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 25, availableAt));
	}

	private async recoverExpiredLedgerLeases(): Promise<void> {
		const now = Date.now();
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) {
				if (TERMINAL_PHASES.has(item.phase)) continue;
				if (item.lease && item.lease.expiresAt <= now) { await this.queueOperatorWake(item); continue; }
				// A live item whose wake was consumed by a no-progress turn has no
				// other revival path; pace its re-prompt instead of waiting out the
				// full lease. The lifetime turn budget keeps this bounded.
				if (!(await this.ctx.storage.get<WakeRecord>(`${WAKE_PREFIX}${item.id}`))) await this.queueOperatorWake(item, item.lease ? LEASED_REVIVAL_DELAY_MS : UNLEASED_REVIVAL_DELAY_MS);
			}
		}
		for await (const page of this.storagePages<StoredOperatorAction>(ACTION_PREFIX)) {
			for (const action of page.values()) {
				// A staged approval whose execution never arrived (for example after
				// the capability worker was replaced) would otherwise strand its work
				// item with no wake. One recovery wake per staging lets the operator
				// re-stage the same command, which resubmits the approval.
				if (action.status === "staged" && action.updatedAt + STAGED_ACTION_RECOVERY_MS <= now) {
					const item = await this.loadWorkItem(action.workItemId);
					if (item && !TERMINAL_PHASES.has(item.phase)) {
						await this.ctx.storage.transaction(async (txn) => {
							const current = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${action.id}`);
							if (!current || current.status !== "staged" || current.updatedAt !== action.updatedAt) return;
							await txn.put(`${ACTION_PREFIX}${action.id}`, { ...current, updatedAt: Date.now() });
							await this.putWakeInTransaction(txn, item);
						});
						await this.scheduleWakeAlarm();
					}
					continue;
				}
				if (action.status !== "applying" || !action.leaseExpiresAt || action.leaseExpiresAt > now) continue;
				const expired = await this.ctx.storage.transaction(async (txn) => {
					const current = await txn.get<StoredOperatorAction>(`${ACTION_PREFIX}${action.id}`);
					if (!current || current.status !== "applying" || (current.leaseExpiresAt ?? 0) > now) return undefined;
					const next: StoredOperatorAction = { ...current, status: "needs_reconciliation", executionToken: undefined, leaseExpiresAt: undefined, updatedAt: now };
					const workItem = await txn.get<StoredWorkItem>(this.workItemKey(current.workItemId));
					await Promise.all([txn.put(`${ACTION_PREFIX}${current.id}`, next), txn.delete(this.actionWakeKey(current.id)), ...(workItem && !TERMINAL_PHASES.has(workItem.phase) ? [this.putWakeInTransaction(txn, workItem)] : [])]);
					return next;
				});
				if (!expired) continue;
				const item = await this.loadWorkItem(expired.workItemId);
				if (item && !TERMINAL_PHASES.has(item.phase)) {
					await this.appendActionEvent(item.id, item.phase, `The operator must reconcile an interrupted ${expired.command.kind.replaceAll("-", " ")} before retrying.`);
					await this.queueOperatorWake(item);
				}
			}
		}
	}

	private async requireWorkItem(id: string): Promise<StoredWorkItem> {
		const item = await this.loadWorkItem(id);
		if (!item) throw new Error("Unknown App Harness work item.");
		return item;
	}

	private async loadWorkItem(id: string): Promise<StoredWorkItem | undefined> {
		if (!isUuid(id)) return undefined;
		return this.ctx.storage.get<StoredWorkItem>(this.workItemKey(id));
	}

	private async *storagePages<T>(prefix: string): AsyncGenerator<Map<string, T>> {
		let startAfter: string | undefined;
		for (;;) {
			const page = await this.ctx.storage.list<T>({ prefix, limit: DELIVERY_POLICY.historyRecordsPerPage, ...(startAfter ? { startAfter } : {}) });
			if (!page.size) return;
			startAfter = [...page.keys()].at(-1);
			yield page;
			if (page.size < DELIVERY_POLICY.historyRecordsPerPage) return;
		}
	}

	private orderKey(prefix: string, sequence: number, id: string): string { return `${prefix}${String(sequence).padStart(16, "0")}:${id}`; }
	private orderBoundary(prefix: string, sequence: number): string { return `${prefix}${String(sequence).padStart(16, "0")}`; }
	private sequenceFromOrderKey(prefix: string, key: string): number | undefined {
		const value = Number(key.slice(prefix.length).split(":", 1)[0]);
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}
	private messageKey(id: string): string { return `${MESSAGE_PREFIX}${id}`; }
	private annotationKey(id: string): string { return `${ANNOTATION_PREFIX}${id}`; }
	private workItemKey(id: string): string { return `${WORK_ITEM_PREFIX}${id}`; }
	private eventKey(id: string, sequence: number): string { return `${EVENT_PREFIX}${id}:${String(sequence).padStart(12, "0")}`; }
	private actionWakeKey(actionId: number): string { return `${WAKE_PREFIX}action:${actionId}`; }

	private async projectWorkItem(item: StoredWorkItem): Promise<PublicWorkItem> {
		const page = await this.getEventPage(item.id);
		return publicWorkItem(item, page.records.length ? page.records : [item.latestEvent], page.hasMore);
	}

	private async getEventPage(workItemId: string, beforeSequence?: number): Promise<RecordPage<LedgerEvent>> {
		const pageSize = DELIVERY_POLICY.historyRecordsPerPage;
		const records = await this.ctx.storage.list<LedgerEvent>({ prefix: `${EVENT_PREFIX}${workItemId}:`, reverse: true, limit: pageSize + 1, ...(beforeSequence ? { end: this.eventKey(workItemId, beforeSequence) } : {}) });
		const events = [...records.values()];
		const hasMore = events.length > pageSize;
		if (hasMore) events.pop();
		events.sort((left, right) => left.sequence - right.sequence);
		return { records: events, hasMore, beforeSequence: events[0]?.sequence };
	}

	private projectWorkItems(items: StoredWorkItem[]): Promise<PublicWorkItem[]> { return Promise.all(items.map((item) => this.projectWorkItem(item))); }

	private async nextSequence(key: string): Promise<number> {
		return this.ctx.storage.transaction(async (txn) => {
			const next = ((await txn.get<number>(key)) ?? 0) + 1;
			await txn.put(key, next);
			return next;
		});
	}

	private async orderedPage<T extends { sequence?: number }>(orderPrefix: string, recordKey: (id: string) => string, beforeSequence?: number): Promise<RecordPage<T>> {
		const pageSize = DELIVERY_POLICY.historyRecordsPerPage;
		const order = await this.ctx.storage.list<string>({ prefix: orderPrefix, reverse: true, limit: pageSize + 1, ...(beforeSequence ? { end: this.orderBoundary(orderPrefix, beforeSequence) } : {}) });
		const records: T[] = [];
		let bytes = 0;
		let cursor: number | undefined;
		let hasMore = false;
		for (const [orderKey, id] of order) {
			if (records.length >= pageSize) { hasMore = true; break; }
			const record = await this.ctx.storage.get<T>(recordKey(id));
			if (!record) { await this.ctx.storage.delete(orderKey); continue; }
			const size = utf8Bytes(JSON.stringify(record));
			if (records.length && bytes + size > DELIVERY_POLICY.historyPageBytes) { hasMore = true; break; }
			records.push(record);
			bytes += size;
			cursor = this.sequenceFromOrderKey(orderPrefix, orderKey) ?? record.sequence;
		}
		if (order.size === pageSize + 1) hasMore = true;
		records.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
		return { records, hasMore, beforeSequence: cursor };
	}

	private getMessagePage(before?: number): Promise<RecordPage<ChatMessage>> { return this.orderedPage(MESSAGE_ORDER_PREFIX, (id) => this.messageKey(id), before); }
	private getAnnotationPage(before?: number): Promise<RecordPage<HarnessAnnotation>> { return this.orderedPage(ANNOTATION_ORDER_PREFIX, (id) => this.annotationKey(id), before); }
	private getWorkItemPage(before?: number): Promise<RecordPage<StoredWorkItem>> { return this.orderedPage(WORK_ITEM_ORDER_PREFIX, (id) => this.workItemKey(id), before); }

	private async saveMessage(message: ChatMessage): Promise<void> {
		if (!message.sequence) message.sequence = await this.nextSequence(MESSAGE_SEQUENCE_KEY);
		await this.ctx.storage.transaction(async (txn) => Promise.all([txn.put(this.messageKey(message.id), message), txn.put(this.orderKey(MESSAGE_ORDER_PREFIX, message.sequence!, message.id), message.id)]));
	}

	private notice(socket: WebSocket, message: string): void { socket.send(JSON.stringify({ type: "workflow:notice", message })); }
	private broadcast(payload: unknown): void {
		const body = JSON.stringify(payload);
		for (const socket of this.ctx.getWebSockets()) try { socket.send(body); } catch { /* reconnect snapshot is authoritative */ }
	}
	private async broadcastWorkItem(item: StoredWorkItem): Promise<void> { this.broadcast({ type: "harness:work-item", workItem: await this.projectWorkItem(item) }); }
	private broadcastPresence(): void { this.broadcast({ type: "chat:presence", count: this.ctx.getWebSockets().length }); }
}

function publicPhase(phase: LedgerPhase): PublicPhase {
	return phase;
}

function publicActivity(event: LedgerEvent): PublicActivity {
	return { sequence: event.sequence, phase: publicPhase(event.phase), message: event.message, source: event.source, at: event.at };
}

function publicWorkItem(item: StoredWorkItem, events: LedgerEvent[], activityHasMore: boolean): PublicWorkItem {
	const issue = item.artifacts.issue as { number?: unknown; url?: unknown } | undefined;
	const candidate = item.artifacts.candidate as { pullRequestUrl?: unknown } | undefined;
	const validation = item.artifacts.validation as { url?: unknown } | undefined;
	const promotion = item.artifacts.promotion as { url?: unknown } | undefined;
	return {
		id: item.id,
		annotationId: item.annotationId,
		clientSubmissionId: item.submissionId,
		kind: item.kind,
		summary: String(item.request),
		target: item.target as TargetEnvelope | undefined,
		phase: publicPhase(item.phase),
		activity: events.map(publicActivity),
		activityHasMore: activityHasMore || undefined,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		sequence: item.sequence,
		githubIssue: typeof issue?.number === "number" && typeof issue.url === "string" ? { number: issue.number, url: issue.url } : undefined,
		githubPullRequestUrl: typeof candidate?.pullRequestUrl === "string" ? candidate.pullRequestUrl : typeof item.artifacts.pullRequestUrl === "string" ? item.artifacts.pullRequestUrl : undefined,
		githubCiUrl: typeof validation?.url === "string" ? validation.url : typeof promotion?.url === "string" ? promotion.url : typeof item.artifacts.githubCiUrl === "string" ? item.artifacts.githubCiUrl : undefined,
		deploymentUrl: typeof item.artifacts.deploymentUrl === "string" ? item.artifacts.deploymentUrl : undefined,
	};
}

/**
 * Derive the mechanical one-node stack identity from durable ledger facts.
 * The model's decisions (summary, ciProfile, baseSha it read from GitHub)
 * pass through; everything else is the platform's own naming contract.
 */
function canonicalOneNodePlan(item: StoredWorkItem, plan: LedgerPlan): LedgerPlan {
	const issue = item.artifacts?.issue as { number?: number } | undefined;
	const issueNumber = Number.isSafeInteger(issue?.number) && issue!.number! >= 1 ? issue!.number! : plan.issueNumber;
	// A replan over an existing candidate is a restack: the next generation
	// gets a fresh branch so the stale candidate can never be revalidated.
	const priorCandidate = item.artifacts?.candidate as { generation?: number } | undefined;
	const floor = Number.isSafeInteger(priorCandidate?.generation) ? priorCandidate!.generation! + 1 : 1;
	const generation = Math.max(floor, Number.isSafeInteger(plan.generation) && plan.generation >= 1 ? plan.generation : 1);
	const baseSha = typeof plan.baseSha === "string" ? plan.baseSha : "";
	return {
		...plan,
		revision: item.plan ? item.plan.revision + 1 : 1,
		generation,
		issueNumber,
		nodeId: "root",
		parentBranch: "main",
		pullRequestBase: "main",
		parentBaseSha: baseSha,
		branch: `app-harness-os/${issueNumber}/g${generation}`,
		stackId: typeof plan.stackId === "string" && plan.stackId.trim() ? plan.stackId : `stack-${item.id.slice(0, 8)}`,
	};
}

const OPERATOR_STATE_ACTION_LIMIT = 10;
const OPERATOR_STATE_RESULT_CHARS = 400;
const OPERATOR_STATE_MAX_CHARS = 6_000;

/**
 * Compact authoritative snapshot embedded in each operator wake. It carries
 * facts, never a decision: the model still chooses the single next command,
 * and the durable ledger still enforces phase, lease, ordering, and
 * idempotency invariants against whatever the model stages.
 */
function operatorWakeState(item: StoredWorkItem | undefined, actions: StoredOperatorAction[], facts?: ExternalFacts): string {
	if (!item) return "null";
	// Pushed external facts ride the snapshot; only facts for the currently
	// active implementation run are shown so a stale run cannot masquerade.
	const runnerResult = facts?.runnerResult && item.activeImplementation && facts.runnerResult.runId === item.activeImplementation.runId ? facts.runnerResult : undefined;
	// Surface a stalled implementation run as a fact: the disposable runner
	// derives its own process identity, so a re-staged implement command with
	// a fresh runId starts a clean isolated run instead of resuming a corpse.
	let implementationProblem: string | undefined;
	if (item.phase === "implementing" && item.activeImplementation && Date.now() - item.activeImplementation.startedAt > STALLED_IMPLEMENTATION_MS) {
		implementationProblem = "The active implementation run exceeded its execution budget and cannot resume. Stage stageImplementation again to restart the isolated run.";
	}
	// Surface a recorded plan the runner would refuse as a fact, so the
	// bounded model stages a revised plan instead of retrying implement.
	let planProblem: string | undefined;
	if (item.plan && !item.activeImplementation) {
		const canonical = `app-harness-os/${item.plan.issueNumber}/g${item.plan.generation}`;
		if (item.plan.nodeId !== "root" || item.plan.parentBranch !== "main" || item.plan.pullRequestBase !== "main" || item.plan.parentBaseSha === null || item.plan.branch !== canonical) {
			planProblem = `The recorded plan is invalid for the one-node runner: nodeId must be root, parentBranch and pullRequestBase main, parentBaseSha = baseSha, branch exactly ${canonical}. Stage a revised plan with revision ${item.plan.revision + 1} before implementation.`;
		}
	}
	const snapshot = {
		workItemId: item.id,
		phase: item.phase,
		version: item.version,
		leaseId: item.lease && item.lease.expiresAt > Date.now() ? item.lease.id : null,
		request: String(item.request ?? "").slice(0, 600),
		classification: item.classification,
		plan: item.plan,
		...(planProblem ? { planProblem } : {}),
		...(implementationProblem ? { implementationProblem } : {}),
		...(runnerResult ? { facts: { runnerResult } } : {}),
		activeImplementation: item.activeImplementation,
		artifacts: item.artifacts,
		actions: actions.slice(-OPERATOR_STATE_ACTION_LIMIT).map((action) => ({
			id: action.id,
			kind: action.command.kind,
			status: action.status,
			...(action.result === undefined ? {} : { result: JSON.stringify(action.result).slice(0, OPERATOR_STATE_RESULT_CHARS) }),
		})),
	};
	const text = JSON.stringify(snapshot);
	if (text.length <= OPERATOR_STATE_MAX_CHARS) return text;
	const trimmed = JSON.stringify({ ...snapshot, actions: snapshot.actions.map(({ id, kind, status }) => ({ id, kind, status })) });
	return trimmed.length <= OPERATOR_STATE_MAX_CHARS ? trimmed : JSON.stringify({ workItemId: item.id, phase: item.phase, version: item.version, leaseId: snapshot.leaseId, request: snapshot.request });
}

function normalizeOperatorMessage(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("A public operator status message is required.");
	return value.trim().replace(/\s+/gu, " ");
}

function normalizeOperatorNoteKey(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value) ? value : undefined;
}

/**
 * Verify a pushed external fact before it can touch the room. The merge is
 * monotonic by construction: one fact per run identifier, first write wins,
 * so a later delivery can never downgrade recorded evidence.
 */
function normalizeExternalFactInput(value: unknown): ExternalFactInput | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.source !== "runner") return null;
	if (typeof raw.workItemId !== "string" || !isUuid(raw.workItemId)) return null;
	if (typeof raw.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(raw.runId)) return null;
	const artifact = raw.artifact;
	if (!artifact || typeof artifact !== "object") return null;
	const rawArtifact = artifact as Record<string, unknown>;
	if (typeof rawArtifact.state !== "string" || !/^[a-z][a-z-]{0,40}$/u.test(rawArtifact.state)) return null;
	const fact: NonNullable<ExternalFacts["runnerResult"]> = { runId: raw.runId, state: rawArtifact.state, at: Date.now() };
	if (typeof rawArtifact.classification === "string") fact.classification = rawArtifact.classification.slice(0, 80);
	if (typeof rawArtifact.stderrTail === "string") fact.stderrTail = rawArtifact.stderrTail.slice(0, 400);
	if (typeof rawArtifact.headSha === "string" && /^[0-9a-f]{40}$/iu.test(rawArtifact.headSha)) fact.headSha = rawArtifact.headSha.toLowerCase();
	if (rawArtifact.pullRequest && typeof rawArtifact.pullRequest === "object") {
		const pullRequest = rawArtifact.pullRequest as { number?: unknown; url?: unknown };
		if (Number.isSafeInteger(pullRequest.number) && (pullRequest.number as number) >= 1) {
			try {
				fact.pullRequest = { number: pullRequest.number as number, url: assertGitHubPullRequestUrl(pullRequest.url, pullRequest.number) };
			} catch { /* an unverifiable pull request reference is omitted, not trusted */ }
		}
	}
	return { source: "runner", workItemId: raw.workItemId, runId: raw.runId, fact };
}


function normalizeLedgerEventSource(value: unknown): LedgerEvent["source"] {
	if (["user", "cloudflare-os", "github", "runner", "ci", "system"].includes(value as string)) return value as LedgerEvent["source"];
	throw new Error("Operator event source is invalid.");
}

function githubUrl(path: string): URL {
	const url = new URL(path);
	if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("GitHub artifact URL is invalid.");
	return url;
}

function assertGitHubPullRequestUrl(value: unknown, number: unknown): string {
	if (!Number.isSafeInteger(number) || (number as number) < 1) throw new Error("GitHub pull request number is invalid.");
	const url = githubUrl(String(value));
	if (url.pathname !== `/${GITHUB_REPOSITORY}/pull/${number}` || url.search || url.hash) throw new Error("GitHub pull request URL is outside the configured repository.");
	return url.toString();
}

function assertGitHubIssue(value: unknown): { number: number; url: string } {
	if (!value || typeof value !== "object") throw new Error("GitHub issue artifact is invalid.");
	const candidate = value as { number?: unknown; url?: unknown };
	if (!Number.isSafeInteger(candidate.number) || (candidate.number as number) < 1) throw new Error("GitHub issue number is invalid.");
	const url = githubUrl(String(candidate.url));
	if (url.pathname !== `/${GITHUB_REPOSITORY}/issues/${candidate.number}` || url.search || url.hash) throw new Error("GitHub issue URL is outside the configured repository.");
	return { number: candidate.number as number, url: url.toString() };
}

function assertGitHubActionsUrl(value: unknown): string {
	const url = githubUrl(String(value));
	if (!new RegExp(`^/${GITHUB_REPOSITORY}/actions/runs/[1-9][0-9]*$`, "u").test(url.pathname) || url.search || url.hash) throw new Error("GitHub Actions URL is outside the configured repository.");
	return url.toString();
}

function assertDeploymentUrl(value: unknown): string {
	const url = new URL(String(value));
	if (url.protocol !== "https:" || url.hostname !== PRODUCTION_DEPLOYMENT_HOST || url.username || url.password || url.hash) throw new Error("Deployment URL is not the configured production application.");
	return url.toString();
}

function normalizeArtifacts(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Artifacts must be an object.");
	const raw = value as Record<string, unknown>;
	const allowed = new Set(["issue", "candidate", "validation", "promotion", "deploymentUrl", "githubCiUrl"]);
	for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown artifact '${key}'.`);
	const normalized: Record<string, unknown> = {};
	if (raw.issue !== undefined) normalized.issue = assertGitHubIssue(raw.issue);
	if (raw.candidate !== undefined) {
		if (!raw.candidate || typeof raw.candidate !== "object") throw new Error("Candidate artifact is invalid.");
		const candidate = raw.candidate as { pullRequestNumber?: unknown; pullRequestUrl?: unknown; headSha?: unknown; branch?: unknown; implementationKey?: unknown; runId?: unknown; pullRequestBase?: unknown; stackId?: unknown; generation?: unknown; nodeId?: unknown };
		normalized.candidate = { ...candidate, pullRequestUrl: assertGitHubPullRequestUrl(candidate.pullRequestUrl, candidate.pullRequestNumber) };
	}
	for (const key of ["validation", "promotion"] as const) {
		if (raw[key] === undefined) continue;
		if (!raw[key] || typeof raw[key] !== "object") throw new Error(`${key} artifact is invalid.`);
		const artifact = raw[key] as { url?: unknown };
		normalized[key] = { ...artifact, url: assertGitHubActionsUrl(artifact.url) };
	}
	if (raw.githubCiUrl !== undefined) normalized.githubCiUrl = assertGitHubActionsUrl(raw.githubCiUrl);
	if (raw.deploymentUrl !== undefined) normalized.deploymentUrl = assertDeploymentUrl(raw.deploymentUrl);
	return normalized;
}

function validateOperatorCommand(command: OperatorCommand): void {
	if (!command || typeof command !== "object") throw new Error("Operator command is required.");
	if ("leaseId" in command && (typeof command.leaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(command.leaseId))) throw new Error("Operator command lease is invalid.");
	if (command.kind === "claim") {
		if (!Number.isSafeInteger(command.leaseMs) || command.leaseMs < 1 || command.leaseMs > OPERATOR_LEASE_MAX_MS) throw new Error("Operator command lease duration is invalid.");
		return;
	}
	if (command.kind === "release" || command.kind === "implement") return;
	if (command.kind === "defer") {
		if (!Number.isSafeInteger(command.delayMs) || command.delayMs < 1 || command.delayMs > 5 * 60_000 || !command.message.trim()) throw new Error("Defer command is invalid.");
		return;
	}
	if (command.kind === "classify") {
		if (!command.classification || !["eligible", "needs_review", "rejected"].includes(command.classification.decision) || !command.message.trim()) throw new Error("Classification command is invalid.");
		return;
	}
	if (command.kind === "plan") {
		if (!command.plan || !command.message.trim()) throw new Error("Plan command is invalid.");
		return;
	}
	if (command.kind === "create-issue") {
		if (!command.title.trim() || !command.body.trim() || !command.classification.trim()) throw new Error("GitHub issue command is invalid.");
		return;
	}
	if (command.kind === "record-candidate") {
		if (!command.runId.trim() || !command.branch.trim() || !/^[0-9a-f]{40}$/iu.test(command.headSha) || !Number.isSafeInteger(command.pullRequestNumber) || command.pullRequestNumber < 1 || !command.pullRequestUrl.startsWith("https://github.com/") || !command.message.trim()) throw new Error("Candidate command is invalid.");
		return;
	}
	if (command.kind === "promote") {
		if (!Number.isSafeInteger(command.pullRequestNumber) || command.pullRequestNumber < 1 || !/^[0-9a-f]{40}$/iu.test(command.headSha) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u.test(command.dispatchKey)) throw new Error("Promotion command is invalid.");
		return;
	}
	if (command.kind === "record-state") {
		if (!command.message.trim()) throw new Error("State command needs a public status message.");
		return;
	}
	throw new Error("Unknown operator command.");
}

function normalizeAuthor(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ") : "Guest";
}

function seededMessages(): ChatMessage[] {
	return [
		{ id: "seed-welcome", author: "Maya", text: "The live room is ready. Use the small launcher to target any part of the app.", createdAt: 1 },
		{ id: "seed-followup", author: "Noah", text: "Requests are public and the activity view links to the real issue, PR, checks, and deployment.", createdAt: 2 },
	];
}

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function normalizeRequest(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function normalizeSubmissionId(value: unknown): string | undefined { return typeof value === "string" && isUuid(value) ? value.toLowerCase() : undefined; }
function normalizeSequence(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined; }

function normalizeTarget(value: unknown): TargetEnvelope | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const targetId = boundedString(raw.targetId, AUTHORING_ENVELOPE_POLICY.targetIdCharacters);
	const selector = targetId && raw.selector === `[data-app-harness-id="${targetId}"]` ? raw.selector : targetId && raw.selector === `[data-target-id="${targetId}"]` ? `[data-app-harness-id="${targetId}"]` : null;
	const tag = boundedString(raw.tag, AUTHORING_ENVELOPE_POLICY.tagCharacters)?.toLowerCase();
	const page = normalizePage(raw.page);
	const room = boundedString(raw.room, AUTHORING_ENVELOPE_POLICY.roomNameCharacters)?.toLowerCase();
	const rect = normalizeRectangle(raw.rect);
	if (!targetId || !selector || !tag || !page || room !== "main" || !rect) return null;
	return { targetId, selector, tag, role: boundedString(raw.role, AUTHORING_ENVELOPE_POLICY.roleCharacters)?.toLowerCase(), label: boundedString(raw.label, AUTHORING_ENVELOPE_POLICY.safeTextCharacters), text: boundedString(raw.text, AUTHORING_ENVELOPE_POLICY.safeTextCharacters), page, room, rect };
}

function boundedString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/gu, " ");
	return text && [...text].length <= max ? text : undefined;
}

function normalizePage(value: unknown): string | null {
	if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#") || [...value].length > AUTHORING_ENVELOPE_POLICY.pagePathCharacters) return null;
	try { return new URL(value, "https://app-harness.invalid").pathname === value ? value : null; } catch { return null; }
}

function normalizeRectangle(value: unknown): TargetRectangle | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const values = [raw.x, raw.y, raw.width, raw.height];
	if (!values.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= AUTHORING_ENVELOPE_POLICY.coordinateMagnitude)) return null;
	if ((raw.width as number) < 0 || (raw.height as number) < 0) return null;
	return { x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number };
}

function normalizeAnnotation(value: unknown): HarnessAnnotation | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const now = Date.now();
	if (raw.kind === "comment") {
		const target = normalizeTarget(raw.target);
		const text = normalizeRequest(raw.text);
		return target && text ? { id: crypto.randomUUID(), kind: "comment", target, text, createdAt: now } : null;
	}
	if (raw.kind === "draw") {
		const page = normalizePage(raw.page);
		if (!page || !Array.isArray(raw.points)) return null;
		const points = raw.points.flatMap((point) => {
			if (!point || typeof point !== "object") return [];
			const rawPoint = point as Record<string, unknown>;
			return typeof rawPoint.x === "number" && typeof rawPoint.y === "number" && Number.isFinite(rawPoint.x) && Number.isFinite(rawPoint.y) && Math.abs(rawPoint.x) <= AUTHORING_ENVELOPE_POLICY.coordinateMagnitude && Math.abs(rawPoint.y) <= AUTHORING_ENVELOPE_POLICY.coordinateMagnitude ? [{ x: rawPoint.x, y: rawPoint.y }] : [];
		});
		return points.length >= 2 ? { id: crypto.randomUUID(), kind: "draw", points, page, createdAt: now } : null;
	}
	return null;
}

function roomName(pathname: string): string | null {
	const match = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)$/u);
	const name = match?.[1];
	return name && name.length <= AUTHORING_ENVELOPE_POLICY.roomNameCharacters ? name.toLowerCase() : null;
}

export default {
	async fetch(request, env): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/api/runner/complete") {
			// The isolated runner reports its terminal artifact by push. The
			// per-run ledger identifier inside the payload is the bearer
			// credential; the room verifies it against the active implementation.
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const body = await request.text();
			if (utf8Bytes(body) > 256_000) return new Response("Payload too large", { status: 413 });
			let payload: { workItemId?: unknown; runId?: unknown; artifact?: unknown };
			try { payload = JSON.parse(body) as typeof payload; } catch { return new Response("Invalid JSON", { status: 400 }); }
			const outcome = await env.CHAT_ROOM.getByName("main").ingestExternalFact({ source: "runner", workItemId: payload.workItemId, runId: payload.runId, artifact: payload.artifact });
			return Response.json(outcome, { status: outcome.accepted ? 200 : 403 });
		}
		const room = roomName(pathname);
		if (room) {
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (room !== "main") return new Response("Unknown room", { status: 404 });
			return env.CHAT_ROOM.getByName(room).fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
