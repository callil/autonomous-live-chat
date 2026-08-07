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
	clearCreditsExhausted,
	grantImplementSlot,
	IMPLEMENT_SLOTS,
	implementQueuePosition,
	isCreditsExhaustedClassification,
	normalizeAdmissionState,
	recordCreditsExhausted,
	releaseImplementSlot,
	type CreditsHealth,
} from "@app-harness/contracts/admission";
import {
	createLedgerWorkItem,
	recordLedgerCandidate as applyCandidate,
	recordLedgerClassification as applyClassification,
	recordLedgerExternalState as applyExternalState,
	recordLedgerPlan as applyPlan,
	startLedgerImplementation as applyImplementationStart,
	type LedgerClassification,
	type LedgerPhase,
	type LedgerPlan,
	type LedgerWorkItem,
} from "@app-harness/contracts/ledger";
import { assertOperatorCommandAllowed, operatorActionEffectKey, operatorCommandEffectSatisfied } from "@app-harness/contracts/operator";
import {
	appendReservedNode,
	canonicalStackPlan,
	isStaleStackNode,
	markNodeRetargeted,
	normalizeRoomStack,
	pinStackNode,
	popBottomNode,
	stackNodeContext,
	stackTipPinned,
	truncateStack,
	type RoomStackNodeContext,
} from "@app-harness/contracts/room-stack";
import {
	expiredGithubDeliveryMarker,
	GITHUB_DELIVERY_MARKER_PREFIX,
	githubDeliveryMarkerKey,
	matchGithubFactToWorkItem,
	matchGithubMainDeployToWorkItems,
	mergeGithubFact,
	normalizeGithubDeliveryId,
	normalizeGithubWebhookFact,
	type GithubWebhookFact,
} from "@app-harness/contracts/webhook";

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
/** User-facing source label: the stored "cloudflare-os" enum is historical and maps to "operator" at projection time. */
type PublicEventSource = "user" | "operator" | "github" | "runner" | "ci" | "system";
type PublicActivity = { sequence: number; phase: PublicPhase; message: string; source: PublicEventSource; at: number };
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
type OperatorCommand =
	| { kind: "classify"; classification: LedgerClassification; message: string }
	| { kind: "plan"; plan: LedgerPlan; message: string }
	| { kind: "create-issue"; title: string; body: string; classification: string }
	| { kind: "implement"; runId: string; expectedOrder?: string[] }
	| { kind: "record-candidate"; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }
	| { kind: "promote"; pullRequestNumber: number; headSha: string; dispatchKey: string }
	| { kind: "record-state"; phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; message: string; source: LedgerEvent["source"] };
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

type OperatorGatewayTransport = {
	submitWake(input: { workItemId: string }): Promise<{ accepted: true } | { accepted: false; message: string }>;
	/** One minimal model call: the recovery probe for a recorded credit outage. */
	probeModel(): Promise<{ ok: boolean; status?: number }>;
};

/** External facts recorded by push (the runner and GitHub webhooks). */
type ExternalFacts = {
	runnerResult?: { runId: string; state: string; classification?: string; stderrTail?: string; headSha?: string; pullRequest?: { number: number; url: string }; at: number };
	/** Live progress from the running job: last step heartbeat plus a rolling tail of the coding agent's JSONL events. Last write wins, never deduped against the terminal result. */
	runnerProgress?: { runId: string; step: string; at: number; events?: string[] };
	validation?: { runId: number; url: string; conclusion: string | null; createdAt: string; headSha: string; at: number };
	promotion?: { runId: number; url: string; conclusion: string | null; createdAt: string; dispatchKey: string; at: number };
	/** The merge evidence chain's deploy leg: the main deploy run whose head revision is the item's merge commit. */
	mainDeploy?: { runId: number; url: string; conclusion: string | null; createdAt: string; headSha: string; at: number };
	candidate?: { number: number; url: string; headSha: string; branch: string; at: number };
	/** The merge evidence chain's merge leg: the candidate PR closed merged, carrying the merge commit join key. */
	merged?: { number: number; url: string; headSha: string; branch: string; mergeCommitSha: string; at: number };
	/** GitHub's native-stack membership signal for the candidate PR: current base and coordinates — the retarget marker after the node below merges. */
	stack?: { number: number; branch: string; headSha: string; base: string; position: number; size: number; at: number };
};
type ExternalFactInput =
	| { source: "runner"; workItemId: string; runId: string; fact: NonNullable<ExternalFacts["runnerResult"]> }
	| { source: "github"; deliveryId: string; fact: GithubWebhookFact };

type RuntimeEnv = Omit<Env, "OPERATOR" | "OPERATOR_PAUSED" | "GITHUB"> & { OPERATOR: unknown; GITHUB?: unknown; OPERATOR_PAUSED?: string };

/** The one bridge observation the room's sweep reconciliation uses: a bounded candidate PR read that recovers a lost merged delivery. */
type GithubBridgeTransport = {
	observeCandidatePullRequest(input: { number: number }): Promise<{ number: number; state: string; merged: boolean; mergeableState: string; mergeCommitSha?: string | null }>;
};

const MESSAGE_PREFIX = "message:";
const ANNOTATION_PREFIX = "annotation:";
const WORK_ITEM_PREFIX = "ledger-work-item:";
const EVENT_PREFIX = "ledger-event:";
const EXTERNAL_FACT_PREFIX = "ledger-external-fact:";
const ACTION_PREFIX = "ledger-operator-action:";
const ACTION_KEY_PREFIX = "ledger-operator-action-key:";
const ACTION_ACTIVE_PREFIX = "ledger-operator-action-active:";
const ACTION_COUNTER_KEY = "sequence:operator-action";
const POKE_COUNT_PREFIX = "ledger-poke-count:";
// Merge-train admission: one plain counter+set record for the whole room.
const ADMISSION_STATE_KEY = "ledger-implement-admission";
// The room's one shared linear stack: every pending request rides it, merged
// bottom-up. One plain record; every transform over it is a pure contract.
const ROOM_STACK_KEY = "ledger-room-stack";
// Room-level system facts: a model-credit outage is a visible, self-recovering
// state, not a mystery of parked turns and silent retries.
const SYSTEM_HEALTH_KEY = "system-health";
const MESSAGE_ORDER_PREFIX = "message-order:";
const ANNOTATION_ORDER_PREFIX = "annotation-order:";
const WORK_ITEM_ORDER_PREFIX = "work-item-order:";
const SUBMISSION_INDEX_PREFIX = "submission-index:";
const MESSAGE_SEQUENCE_KEY = "sequence:message";
const ANNOTATION_SEQUENCE_KEY = "sequence:annotation";
const WORK_ITEM_SEQUENCE_KEY = "sequence:work-item";
const ACTION_APPLY_LEASE_MS = 60_000;
const REJECTED_ACTION_PARK_THRESHOLD = 14;
// Just above the runner's own 650s hard deadline: by the time this fires the
// prior run is provably dead (the runner's own deadline is 5 minutes). With
// push-based completion this is a rare fallback, not the primary recovery path.
const STALLED_IMPLEMENTATION_MS = 6 * 60_000;
// The final safety net behind event pokes: one slow sweep re-pokes every live
// work item, so a lost fire-and-forget poke costs minutes, never the item.
const SWEEP_INTERVAL_MS = 2 * 60_000;
// Merge watch: after a successful validation the operator stages the
// promotion dispatch — the single merge path (candidates are stack members,
// so they never auto-merge). Past this window with no promotion or merged
// fact, the snapshot records a merge-timeout problem — the ledger queries no
// GitHub state itself; the operator dispatches the promotion now, or observes
// a conflicted candidate through the bridge and restacks it. The sweep's
// re-poke (and the WAITING re-poke) is what delivers the problem to the next
// turn.
const MERGE_WATCH_TIMEOUT_MS = 4 * 60_000;
// Lifetime wake budget per work item: an operator that consumes this many
// pokes without reaching a terminal phase is not converging. Park it.
const OPERATOR_POKE_CAP = 200;
const TERMINAL_PHASES = new Set<LedgerPhase>(["completed", "needs_review", "rejected"]);
const GITHUB_REPOSITORY = "callil/autonomous-live-chat";
const PRODUCTION_DEPLOYMENT_HOST = "autonomous-live-chat.coda-a.workers.dev";

/**
 * Private typed capability exposed to the operator worker over a service
 * binding. These methods validate and persist decisions but never choose the
 * next one.
 */
export class LedgerService extends WorkerEntrypoint<RuntimeEnv> {
	private room(): DurableObjectStub<ChatRoom> { return this.env.CHAT_ROOM.getByName("main") as unknown as DurableObjectStub<ChatRoom>; }
	snapshotWorkItem(input: { workItemId: string }): Promise<{ state: string; version: number; terminal: boolean } | null> { return this.room().snapshotWorkItem(input); }
	recordClassification(input: { workItemId: string; classification: LedgerClassification; message: string }): Promise<StoredWorkItem> { return this.room().recordClassification(input); }
	recordPlan(input: { workItemId: string; plan: LedgerPlan; message: string }): Promise<StoredWorkItem> { return this.room().recordPlan(input); }
	startImplementation(input: { workItemId: string; runId: string }): Promise<{ disposition: string; item: StoredWorkItem }> { return this.room().startImplementation(input); }
	recordCandidate(input: { workItemId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<StoredWorkItem> { return this.room().recordCandidate(input); }
	recordExternalState(input: { workItemId: string; phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> { return this.room().recordExternalState(input); }
	recordArtifacts(input: { workItemId: string; artifacts: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> { return this.room().recordArtifacts(input); }
	stageOperatorAction(input: { workItemId: string; expectedVersion: number; command: OperatorCommand }): Promise<StoredOperatorAction> { return this.room().stageOperatorAction(input); }
	beginOperatorAction(input: { workItemId: string; actionId: number }): Promise<{ disposition: "execute" | "busy" | "applied" | "rejected" | "stale"; action: StoredOperatorAction; workItem: StoredWorkItem; executionToken?: string }> { return this.room().beginOperatorAction(input); }
	completeOperatorAction(input: { workItemId: string; actionId: number; idempotencyKey: string; executionToken: string; result: unknown }): Promise<StoredOperatorAction> { return this.room().completeOperatorAction(input); }
	rejectOperatorAction(input: { workItemId: string; actionId: number; executionToken: string; error?: string }): Promise<StoredOperatorAction> { return this.room().rejectOperatorAction(input); }
	ingestExternalFact(input: unknown): Promise<{ accepted: boolean }> { return this.room().ingestExternalFact(input); }
}

/**
 * One room Durable Object owns chat, annotations, and the sole work ledger.
 * It records truth and emits events: every relevant state change fires one
 * fire-and-forget poke at the operator worker, whose per-item Durable Object
 * owns its own turn lifecycle. The room's only alarm is a slow safety-net
 * sweep; it contains no GitHub, runner, CI, or promotion decision loop.
 */
export class ChatRoom extends DurableObject<RuntimeEnv> {
	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await this.scheduleSweep();
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
		await this.sweep();
		await this.scheduleSweep();
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

	/**
	 * The authoritative per-item snapshot the operator reads at the start of
	 * each turn: work item, recent actions, and pushed external facts in one
	 * bounded JSON string. The read is loop-owned, never a model tool call.
	 */
	async snapshotWorkItem(input: { workItemId: string }): Promise<{ state: string; version: number; terminal: boolean } | null> {
		const item = await this.loadWorkItem(input.workItemId);
		if (!item) return null;
		const actions = await this.listOperatorActions({ workItemId: item.id });
		const facts = await this.ctx.storage.get<ExternalFacts>(`${EXTERNAL_FACT_PREFIX}${item.id}`);
		// A queued item's snapshot names its honest queue position so the model
		// replies WAITING instead of re-staging into the same teaching error.
		const admission = normalizeAdmissionState(await this.ctx.storage.get(ADMISSION_STATE_KEY));
		// A stale-marked stack node's snapshot carries the restack fact: its
		// parent left the stack, so its single next step is a revised plan.
		// A stacked node's snapshot also carries its merge-train coordinates:
		// the loop supplies expectedOrder to the runner from here, and a green
		// upper node learns to WAIT instead of dispatching a doomed promotion.
		const roomStack = normalizeRoomStack(await this.ctx.storage.get(ROOM_STACK_KEY));
		return { state: operatorSnapshot(item, actions, facts, implementQueuePosition(admission, item.id), isStaleStackNode(roomStack, item.id), stackNodeContext(roomStack, item.id)), version: item.version, terminal: TERMINAL_PHASES.has(item.phase) };
	}

	async recordClassification(input: { workItemId: string; classification: LedgerClassification; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const updated = applyClassification(current, { classification: input.classification, now: Date.now() }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "cloudflare-os");
	}

	async recordPlan(input: { workItemId: string; plan: LedgerPlan; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const updated = applyPlan(current, { plan: input.plan, now: Date.now() }) as StoredWorkItem;
		let staleSurvivors: string[] = [];
		const persisted = await this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "cloudflare-os", async (txn) => {
			// The room stack advances inside the same transaction that records
			// the plan: a replan of a node already on the stack truncates it
			// first (marking every node above stale), then the accepted plan's
			// node is appended as the new reserved tip. The append re-verifies
			// the plan's parent against the live tip, so a plan staged against a
			// stack that has since moved is refused, never recorded.
			const plan = updated.plan!;
			const truncated = truncateStack(normalizeRoomStack(await txn.get(ROOM_STACK_KEY)), updated.id);
			staleSurvivors = truncated.staleWorkItemIds;
			const appended = appendReservedNode(truncated.stack, { workItemId: updated.id, nodeId: plan.nodeId, branch: plan.branch, parentBranch: plan.parentBranch, parentBaseSha: plan.parentBaseSha, stackId: plan.stackId });
			if (!appended.appended) throw new Error(`The room stack moved before this plan could commit (${appended.reason}). Stage a revised plan; the ledger re-derives the parent from the current tip.`);
			await txn.put(ROOM_STACK_KEY, appended.stack);
		});
		// The truncation's survivors replan lowest-first: the tip-pinning rule
		// refuses the higher ones until the lower one's candidate pins the tip,
		// so one sweep-class nudge to the lowest survivor starts the cascade.
		if (staleSurvivors.length) await this.nudgeRestackSurvivor(staleSurvivors[0]);
		return persisted;
	}

	async startImplementation(input: { workItemId: string; runId: string }): Promise<{ disposition: string; item: StoredWorkItem }> {
		const current = await this.requireWorkItem(input.workItemId);
		const result = applyImplementationStart(current, { runId: input.runId, now: Date.now() });
		if (result.disposition !== "started") return { disposition: result.disposition, item: result.item as StoredWorkItem };
		const item = await this.persistTransition(current.version, result.item as StoredWorkItem, "The operator delegated the next missing artifact to an isolated coding-agent run.", "cloudflare-os");
		return { disposition: result.disposition, item };
	}

	async recordCandidate(input: { workItemId: string; runId: string; branch: string; headSha: string; pullRequestNumber: number; pullRequestUrl: string; message: string }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		assertGitHubPullRequestUrl(input.pullRequestUrl, input.pullRequestNumber);
		const updated = applyCandidate(current, { runId: input.runId, branch: input.branch, headSha: input.headSha, pullRequestNumber: input.pullRequestNumber, pullRequestUrl: input.pullRequestUrl, now: Date.now() }) as StoredWorkItem;
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), "runner", async (txn) => {
			// Pin the item's stack node to the candidate head: when the node is
			// the tip, this immutable revision is the parent base the next
			// dependent plan builds on — the pipeline's unblocking event.
			const pinned = pinStackNode(normalizeRoomStack(await txn.get(ROOM_STACK_KEY)), updated.id, input.headSha);
			if (pinned.pinned) await txn.put(ROOM_STACK_KEY, pinned.stack);
		});
	}

	async recordExternalState(input: { workItemId: string; phase: Extract<LedgerPhase, "validating" | "promoting" | "deployed" | "completed" | "retryable" | "needs_review" | "rejected">; artifacts?: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		const artifacts = normalizeArtifacts(input.artifacts ?? {});
		const source = normalizeLedgerEventSource(input.source);
		const updated = applyExternalState(current, { phase: input.phase, artifacts, now: Date.now() }) as StoredWorkItem;
		const persisted = await this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), source);
		if (input.phase === "retryable") {
			// The dead generation's runner evidence must not survive into the
			// next snapshot: a stale result once wedged the model into waiting
			// for a run that no longer exists instead of planning the restack.
			const factKey = `${EXTERNAL_FACT_PREFIX}${persisted.id}`;
			const facts = await this.ctx.storage.get<ExternalFacts>(factKey);
			if (facts && (facts.runnerResult || facts.runnerProgress)) {
				delete facts.runnerResult;
				delete facts.runnerProgress;
				await this.ctx.storage.put(factKey, facts);
			}
		}
		return persisted;
	}

	async recordArtifacts(input: { workItemId: string; artifacts: Record<string, unknown>; message: string; source: LedgerEvent["source"] }): Promise<StoredWorkItem> {
		const current = await this.requireWorkItem(input.workItemId);
		if (TERMINAL_PHASES.has(current.phase)) throw new Error("Terminal work cannot accept another artifact.");
		const updated = { ...current, artifacts: { ...current.artifacts, ...normalizeArtifacts(input.artifacts) }, version: current.version + 1, updatedAt: Date.now() };
		return this.persistTransition(current.version, updated, normalizeOperatorMessage(input.message), normalizeLedgerEventSource(input.source));
	}

	async stageOperatorAction(input: { workItemId: string; expectedVersion: number; command: OperatorCommand }): Promise<StoredOperatorAction> {
		const workItem = await this.requireWorkItem(input.workItemId);
		// The operator decides that and what to plan (summary, CI profile, base
		// revision); the ledger owns the mechanical stack-node identity and
		// derives it from its own durable facts — including the room stack's
		// pinned tip — before validation.
		if (input.command.kind === "plan" && input.command.plan && typeof input.command.plan === "object") {
			const roomStack = normalizeRoomStack(await this.ctx.storage.get(ROOM_STACK_KEY));
			input.command = { ...input.command, plan: canonicalStackPlan(workItem, input.command.plan, roomStack) };
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
			const existing = await this.ctx.storage.get<StoredOperatorAction>(this.actionKey(workItem.id, existingId));
			// A rejected action produced no external effect, so its semantic key is
			// free again: the operator may stage a corrected command in its place.
			if (existing && existing.status !== "rejected") return existing;
		}
		if (workItem.version !== input.expectedVersion) throw new Error("The operator action is based on a stale work-item revision.");
		assertOperatorCommandAllowed(workItem, input.command);
		const action = await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<StoredWorkItem>(this.workItemKey(workItem.id));
			if (!current || current.version !== input.expectedVersion) throw new Error("The operator action became stale before it could be staged.");
			assertOperatorCommandAllowed(current, input.command);
			const duplicateId = await txn.get<number>(`${ACTION_KEY_PREFIX}${key}`);
			if (duplicateId !== undefined) {
				const duplicate = await txn.get<StoredOperatorAction>(this.actionKey(current.id, duplicateId));
				if (duplicate && duplicate.status !== "rejected") return duplicate;
			}
			const activeId = await txn.get<number>(`${ACTION_ACTIVE_PREFIX}${current.id}`);
			if (activeId !== undefined) {
				const active = await txn.get<StoredOperatorAction>(this.actionKey(current.id, activeId));
				if (active && !["applied", "rejected"].includes(active.status)) throw new Error(`Operator action ${active.id} must reconcile before another mutation can be staged.`);
			}
			// Merge-train admission gate: at most IMPLEMENT_SLOTS items may sit
			// between implementation and merge at once, so candidates stop racing
			// each other into hot-file conflicts. The grant commits with the
			// staged action; a full house registers the item in the public queue
			// and the stage is refused with a teaching error after commit.
			// The room stack adds one conjunct: a grant requires a pinned tip
			// (or no tip, or this item's own reserved tip, which this very run
			// will pin), so a dependent run never starts under an unknowable
			// parent revision.
			if (input.command.kind === "implement") {
				if (!stackTipPinned(normalizeRoomStack(await txn.get(ROOM_STACK_KEY)), current.id)) return { stackTipUnpinned: true as const };
				const grant = grantImplementSlot(await txn.get(ADMISSION_STATE_KEY), current.id);
				await txn.put(ADMISSION_STATE_KEY, grant.state);
				if (!grant.granted) return { implementQueuedAhead: grant.ahead };
			}
			const id = ((await txn.get<number>(ACTION_COUNTER_KEY)) ?? 0) + 1;
			if (!Number.isSafeInteger(id)) throw new Error("Operator action counter is exhausted.");
			const now = Date.now();
			const action: StoredOperatorAction = { id, workItemId: current.id, expectedVersion: current.version, idempotencyKey: key, command: input.command, status: "staged", attempts: 0, createdAt: now, updatedAt: now };
			await Promise.all([txn.put(ACTION_COUNTER_KEY, id), txn.put(this.actionKey(current.id, id), action), txn.put(`${ACTION_KEY_PREFIX}${key}`, id), txn.put(`${ACTION_ACTIVE_PREFIX}${current.id}`, id)]);
			return action as StoredOperatorAction | { implementQueuedAhead: number } | { stackTipUnpinned: true };
		});
		if ("stackTipUnpinned" in action) {
			// The tip-pinning refusal is a teaching error too: the item below is
			// still between plan and candidate, and its candidate event re-pokes
			// the whole room's queue.
			throw new Error("The room stack tip is not pinned yet: the item below must record its candidate first. Reply WAITING; the ledger re-pokes when the tip pins.");
		}
		if ("implementQueuedAhead" in action) {
			// The refusal is a teaching error: it names the queue so the model
			// replies WAITING, and the feed carries the honest position line.
			await this.announceImplementQueue();
			throw new Error(`All ${IMPLEMENT_SLOTS} implementation slots are busy: ${action.implementQueuedAhead} item(s) are queued ahead of this one. Reply WAITING; the ledger re-pokes this item when a slot frees.`);
		}
		await this.appendActionEvent(workItem.id, workItem.phase, `The operator staged ${action.command.kind.replaceAll("-", " ")}.`);
		return action;
	}

	async listOperatorActions(input: { workItemId: string }): Promise<StoredOperatorAction[]> {
		if (!isUuid(input.workItemId)) throw new Error("Operator action work-item ID is invalid.");
		// Actions are keyed per work item, so this scan reads only this item's
		// records — never the room's whole action history.
		const actions: StoredOperatorAction[] = [];
		for await (const page of this.storagePages<StoredOperatorAction>(`${ACTION_PREFIX}${input.workItemId}:`)) {
			for (const action of page.values()) actions.push(action);
		}
		return actions.toSorted((left, right) => left.id - right.id);
	}

	async beginOperatorAction(input: { workItemId: string; actionId: number }): Promise<{ disposition: "execute" | "busy" | "applied" | "rejected" | "stale"; action: StoredOperatorAction; workItem: StoredWorkItem; executionToken?: string }> {
		if (!isUuid(input.workItemId)) throw new Error("Operator action work-item ID is invalid.");
		if (!Number.isSafeInteger(input.actionId) || input.actionId < 1) throw new Error("Operator action ID is invalid.");
		const begun = await this.ctx.storage.transaction(async (txn) => {
			const action = await txn.get<StoredOperatorAction>(this.actionKey(input.workItemId, input.actionId));
			if (!action) throw new Error("Unknown operator action.");
			const workItem = await txn.get<StoredWorkItem>(this.workItemKey(action.workItemId));
			if (!workItem) throw new Error("Operator action lost its work item.");
			if (action.status === "applied") return { disposition: "applied" as const, action, workItem };
			if (action.status === "rejected") return { disposition: "rejected" as const, action, workItem };
			if (action.status === "needs_reconciliation" && operatorCommandEffectSatisfied(workItem, action.command)) {
				const reconciled: StoredOperatorAction = { ...action, status: "applied", result: { reconciled: true, workItemVersion: workItem.version }, executionToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() };
				await Promise.all([txn.put(this.actionKey(action.workItemId, action.id), reconciled), txn.delete(`${ACTION_ACTIVE_PREFIX}${action.workItemId}`)]);
				return { disposition: "applied" as const, action: reconciled, workItem };
			}
			const now = Date.now();
			if (action.status === "applying") return { disposition: (action.leaseExpiresAt ?? 0) > now ? "busy" as const : "stale" as const, action, workItem };
			if (workItem.version !== action.expectedVersion) return { disposition: "stale" as const, action, workItem };
			try { assertOperatorCommandAllowed(workItem, action.command); } catch { return { disposition: "stale" as const, action, workItem }; }
			const executionToken = crypto.randomUUID();
			const applying: StoredOperatorAction = { ...action, status: "applying", attempts: action.attempts + 1, executionToken, leaseExpiresAt: now + ACTION_APPLY_LEASE_MS, updatedAt: now };
			await txn.put(this.actionKey(action.workItemId, action.id), applying);
			return { disposition: "execute" as const, action: applying, workItem, executionToken };
		});
		if (begun.disposition === "execute") {
			await this.appendActionEvent(begun.workItem.id, begun.workItem.phase, `The operator is executing ${begun.action.command.kind.replaceAll("-", " ")}.`);
		}
		return begun;
	}

	async completeOperatorAction(input: { workItemId: string; actionId: number; idempotencyKey: string; executionToken: string; result: unknown }): Promise<StoredOperatorAction> {
		if (!isUuid(input.workItemId)) throw new Error("Operator action work-item ID is invalid.");
		const completed = await this.ctx.storage.transaction(async (txn) => {
			const action = await txn.get<StoredOperatorAction>(this.actionKey(input.workItemId, input.actionId));
			if (!action || action.idempotencyKey !== input.idempotencyKey) throw new Error("Operator action completion does not match its durable reservation.");
			if (action.status === "applied") return action;
			if (action.executionToken !== input.executionToken) throw new Error("Operator action completion lost its execution lease.");
			if (action.status !== "applying") throw new Error("Only an applying operator action can complete.");
			if ((action.leaseExpiresAt ?? 0) <= Date.now()) throw new Error("Operator action execution lease expired before completion.");
			const completed: StoredOperatorAction = { ...action, status: "applied", result: input.result, executionToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() };
			if (!fitsDurableRecord(this.actionKey(action.workItemId, action.id), completed)) throw new Error("Operator action result exceeds one durable record.");
			await Promise.all([txn.put(this.actionKey(action.workItemId, action.id), completed), txn.delete(`${ACTION_ACTIVE_PREFIX}${action.workItemId}`)]);
			return completed;
		});
		const workItem = await this.loadWorkItem(completed.workItemId);
		if (workItem) await this.appendActionEvent(workItem.id, workItem.phase, `The operator completed ${completed.command.kind.replaceAll("-", " ")}.`);
		return completed;
	}

	async rejectOperatorAction(input: { workItemId: string; actionId: number; executionToken: string; error?: string }): Promise<StoredOperatorAction> {
		if (!isUuid(input.workItemId)) throw new Error("Operator action work-item ID is invalid.");
		const failure = typeof input.error === "string" && input.error.trim() ? input.error.trim().replace(/\s+/gu, " ").slice(0, 500) : undefined;
		const rejected = await this.ctx.storage.transaction(async (txn) => {
			const action = await txn.get<StoredOperatorAction>(this.actionKey(input.workItemId, input.actionId));
			if (!action) throw new Error("Unknown operator action.");
			if (action.status === "applied") throw new Error("Applied operator actions cannot be rejected.");
			if (action.status !== "applying" || action.executionToken !== input.executionToken || (action.leaseExpiresAt ?? 0) <= Date.now()) throw new Error("Operator action rejection lost its execution lease.");
			const rejected: StoredOperatorAction = { ...action, status: "rejected", ...(failure ? { result: { error: failure } } : {}), executionToken: undefined, leaseExpiresAt: undefined, updatedAt: Date.now() };
			await Promise.all([txn.put(this.actionKey(action.workItemId, action.id), rejected), txn.delete(`${ACTION_ACTIVE_PREFIX}${action.workItemId}`)]);
			return rejected;
		});
		const workItem = await this.loadWorkItem(rejected.workItemId);
		if (workItem) {
			await this.appendActionEvent(workItem.id, workItem.phase, `The operator could not apply ${rejected.command.kind.replaceAll("-", " ")}${failure ? `: ${failure}` : "."}`);
			// An operator that cannot converge would otherwise churn forever.
			// A bounded rejection budget parks truthfully.
			const rejections = (await this.listOperatorActions({ workItemId: workItem.id })).filter((action) => action.status === "rejected").length;
			if (!TERMINAL_PHASES.has(workItem.phase) && rejections >= REJECTED_ACTION_PARK_THRESHOLD) {
				const parked = { ...workItem, phase: "needs_review" as const, version: workItem.version + 1, activeImplementation: null, updatedAt: Date.now() };
				await this.persistTransition(workItem.version, parked, `The operator rejected ${rejections} staged commands for this work item; work is parked for review with its ledger and artifacts intact.`, "system");
			}
		}
		return rejected;
	}

	/**
	 * One entry point for pushed external facts (the runner and GitHub
	 * webhooks). A fact never writes work-item state directly: it is verified
	 * against the item, merged monotonically into the per-item fact record the
	 * operator snapshot embeds, and answered with an immediate poke so the
	 * operator stages the actual transition itself.
	 */
	async ingestExternalFact(input: unknown): Promise<{ accepted: boolean }> {
		// The operator worker's own health note: a model-credit outage found
		// mid-turn. Only the private LEDGER service binding can present source
		// "operator" — the public runner callback pins its source to "runner".
		const note = normalizeOperatorNoteInput(input);
		if (note) {
			if (!isCreditsExhaustedClassification(note.note) || !(await this.loadWorkItem(note.workItemId))) return { accepted: false };
			await this.recordModelCreditsExhausted();
			return { accepted: true };
		}
		// Live progress is recorded under its own fact key with last-write-wins
		// semantics and no poke, so it can never mask or dedupe the terminal
		// runner result for the same run identifier. Step heartbeats also feed
		// the public activity timeline; raw agent events feed only the fact
		// record's rolling tail, keeping the feed readable.
		const progressFact = normalizeRunnerProgressInput(input);
		if (progressFact) {
			const recorded = await this.ctx.storage.transaction(async (txn) => {
				const item = await txn.get<StoredWorkItem>(this.workItemKey(progressFact.workItemId));
				if (!item || item.phase !== "implementing" || item.activeImplementation?.runId !== progressFact.runId) return undefined;
				const key = `${EXTERNAL_FACT_PREFIX}${item.id}`;
				const facts = (await txn.get<ExternalFacts>(key)) ?? {};
				const prior = facts.runnerProgress?.runId === progressFact.runId ? facts.runnerProgress : undefined;
				const events = [...(prior?.events ?? []), ...(progressFact.events ?? [])].slice(-RUNNER_PROGRESS_EVENTS_KEPT);
				facts.runnerProgress = {
					runId: progressFact.runId,
					step: progressFact.step ?? prior?.step ?? "running",
					at: Date.now(),
					...(events.length ? { events } : {}),
				};
				await txn.put(key, facts);
				return { item, stepChanged: progressFact.step !== undefined && progressFact.step !== prior?.step };
			});
			if (!recorded) return { accepted: false };
			if (recorded.stepChanged && progressFact.step) {
				await this.appendActionEvent(recorded.item.id, recorded.item.phase, runnerStepMessage(progressFact.step), "runner");
			}
			return { accepted: true };
		}
		const parsed = normalizeExternalFactInput(input);
		if (!parsed) return { accepted: false };
		if (parsed.source === "github") return this.ingestGithubFact(parsed);
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
		// The credential-verified runner artifact is the trusted signal for the
		// room-level credit outage: recording is idempotent and announced once.
		if (isCreditsExhaustedClassification(parsed.fact.classification)) await this.recordModelCreditsExhausted();
		if (merged.duplicate) return { accepted: true };
		const current = await this.loadWorkItem(parsed.workItemId);
		if (current) {
			const message = parsed.fact.state === "pull-request-opened"
				? "The isolated runner reported a candidate pull request."
				: `The isolated runner finished: ${parsed.fact.state}${parsed.fact.classification ? ` (${parsed.fact.classification})` : ""}.`;
			await this.appendActionEvent(current.id, current.phase, message, "runner");
			this.pokeOperator(current);
		}
		return { accepted: true };
	}

	/**
	 * A pushed GitHub webhook fact. The transport dedupe key is the
	 * X-GitHub-Delivery GUID (stable across redeliveries); matching uses only
	 * immutable identities the ledger already recorded, and the merge is
	 * monotonic, so a late or replayed delivery can never downgrade evidence.
	 */
	private async ingestGithubFact(parsed: Extract<ExternalFactInput, { source: "github" }>): Promise<{ accepted: boolean }> {
		const live: StoredWorkItem[] = [];
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) if (!TERMINAL_PHASES.has(item.phase)) live.push(item);
		}
		const promotions: Array<{ workItemId: string; dispatchKey: string }> = [];
		if (parsed.fact.kind === "promotion") {
			// The promote action's durable dispatchKey is the promotion identity.
			for await (const page of this.storagePages<StoredOperatorAction>(ACTION_PREFIX)) {
				for (const action of page.values()) if (action.command.kind === "promote") promotions.push({ workItemId: action.workItemId, dispatchKey: action.command.dispatchKey });
			}
		}
		const merges: Array<{ workItemId: string; mergeCommitSha: string; mergedAt: number }> = [];
		if (parsed.fact.kind === "main-deploy") {
			// A main deploy run deploys whatever main is; the recorded merged
			// fact's merge commit is the honest join to a work item — exactly,
			// or by containment: main history is linear, so a successful run
			// created after an item's merged fact deployed a descendant of that
			// item's merge commit. One deploy run is therefore evidence for
			// every merged item it contains, not just the last merge it shipped.
			for (const item of live) {
				const facts = await this.ctx.storage.get<ExternalFacts>(`${EXTERNAL_FACT_PREFIX}${item.id}`);
				if (facts?.merged?.mergeCommitSha) merges.push({ workItemId: item.id, mergeCommitSha: facts.merged.mergeCommitSha, mergedAt: facts.merged.at });
			}
		}
		const fact = parsed.fact;
		const workItemIds = fact.kind === "main-deploy"
			? matchGithubMainDeployToWorkItems(fact, live, merges)
			: [matchGithubFactToWorkItem(fact, live, promotions)].filter((id): id is string => id !== null);
		if (!workItemIds.length) return { accepted: false };
		const merged = await this.ctx.storage.transaction(async (txn) => {
			if (await txn.get(githubDeliveryMarkerKey(parsed.deliveryId))) return { freshIds: [] };
			const now = Date.now();
			const freshIds: string[] = [];
			const writes: Array<Promise<void>> = [];
			for (const workItemId of workItemIds) {
				const item = await txn.get<StoredWorkItem>(this.workItemKey(workItemId));
				if (!item || TERMINAL_PHASES.has(item.phase)) continue;
				const key = `${EXTERNAL_FACT_PREFIX}${item.id}`;
				const facts = mergeGithubFact(await txn.get<ExternalFacts>(key), parsed.fact, now);
				if (facts) {
					writes.push(txn.put(key, facts));
					freshIds.push(item.id);
				}
			}
			if (!writes.length && workItemIds.length === 1) {
				const only = await txn.get<StoredWorkItem>(this.workItemKey(workItemIds[0]));
				// Preserve the single-item contract: a delivery whose only match is
				// gone or terminal is refused without consuming its delivery marker.
				if (!only || TERMINAL_PHASES.has(only.phase)) return undefined;
			}
			writes.push(txn.put(githubDeliveryMarkerKey(parsed.deliveryId), { at: now }));
			await Promise.all(writes);
			return { freshIds };
		});
		if (!merged) return { accepted: false };
		await this.pruneGithubDeliveryMarkers(Date.now());
		for (const workItemId of merged.freshIds) {
			const current = await this.loadWorkItem(workItemId);
			if (current) {
				await this.appendActionEvent(current.id, current.phase, githubFactMessage(parsed.fact), "github");
				this.pokeOperator(current);
			}
		}
		// A merged fact (or a successful promotion run) ends the item's
		// implementation-to-merge window: free its admission slot now instead
		// of waiting for the deployed/completed transitions.
		if (parsed.fact.kind === "merged" || (parsed.fact.kind === "promotion" && parsed.fact.conclusion === "success")) {
			for (const workItemId of merged.freshIds) await this.releaseImplementSlotFor(workItemId);
		}
		// The merged bottom node advances the merge train: pop it, advance the
		// recorded base to the merge commit, and poke the new bottom item so it
		// promotes without waiting for its next wake.
		if (parsed.fact.kind === "merged") {
			for (const workItemId of merged.freshIds) await this.popRoomStackBottom(workItemId, parsed.fact.mergeCommitSha);
		}
		// A stack fact whose base no longer names the node's recorded parent is
		// GitHub's retarget after the node below merged: mark the node — tip,
		// head shas, and generations stay untouched, because the gate's
		// ancestor-of-main rule is what keeps the survivor's unchanged
		// provenance verifiable. No replan, no poke storm.
		if (parsed.fact.kind === "stack") {
			for (const workItemId of merged.freshIds) await this.markRoomStackRetargeted(workItemId, parsed.fact.base);
		}
		return { accepted: true };
	}

	/** Delivery markers only absorb GitHub's bounded redelivery window. */
	private async pruneGithubDeliveryMarkers(now: number): Promise<void> {
		const expired: string[] = [];
		for await (const page of this.storagePages<{ at?: number }>(GITHUB_DELIVERY_MARKER_PREFIX)) {
			for (const [key, marker] of page) if (expiredGithubDeliveryMarker(marker, now)) expired.push(key);
		}
		for (const batch of storageDeleteBatches(expired)) await this.ctx.storage.delete(batch);
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
			this.pokeOperator(existing);
			return;
		}
		const item = this.newWorkItem({ kind: "request", request, target, submissionId, now: Date.now() });
		if (!fitsDurableRecord(this.workItemKey(item.id), item)) return this.notice(socket, "That request exceeds one durable record. Split it into smaller implementation steps.");
		const admitted = await this.saveNewWorkItem(item);
		await this.broadcastWorkItem(admitted.item);
		this.pokeOperator(admitted.item);
		await this.scheduleSweep();
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
			this.pokeOperator(admitted.item);
			await this.scheduleSweep();
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
				...(persistedAnnotation ? [txn.put(this.annotationKey(persistedAnnotation.id), persistedAnnotation), txn.put(this.orderKey(ANNOTATION_ORDER_PREFIX, persistedAnnotation.sequence!, persistedAnnotation.id), persistedAnnotation.id)] : []),
				...(item.submissionId ? [txn.put(`${SUBMISSION_INDEX_PREFIX}${item.submissionId}`, item.id)] : []),
			]);
			return { item, created: true, annotation: persistedAnnotation };
		});
	}

	private async persistTransition(expectedVersion: number, nextItem: StoredWorkItem, message: string, source: LedgerEvent["source"], mutate?: (txn: DurableObjectTransaction) => Promise<void>): Promise<StoredWorkItem> {
		const at = Date.now();
		const persisted = await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<StoredWorkItem>(this.workItemKey(nextItem.id));
			if (!current || current.version !== expectedVersion) throw new Error("Work item changed before this operator transition could commit.");
			const eventSequence = current.eventSequence + 1;
			const event: LedgerEvent = { id: `${current.id}:${eventSequence}`, workItemId: current.id, sequence: eventSequence, phase: nextItem.phase, message, source, at };
			const item = { ...nextItem, eventSequence, latestEvent: event, updatedAt: at };
			await Promise.all([txn.put(this.workItemKey(item.id), item), txn.put(this.eventKey(item.id, eventSequence), event)]);
			// A caller-supplied room-record mutation (the stack append or pin)
			// commits atomically with the transition it belongs to.
			if (mutate) await mutate(txn);
			return item;
		});
		await this.broadcastWorkItem(persisted);
		this.pokeOperator(persisted);
		// The implementation-to-merge slot follows the item's fate: a retryable
		// or terminal transition frees it for the next queued item. The room
		// stack follows the same transitions: the dead item's node truncates
		// out, marking any dependents stale for their replan.
		if (persisted.phase === "retryable" || TERMINAL_PHASES.has(persisted.phase)) {
			await this.releaseImplementSlotFor(persisted.id);
			await this.truncateRoomStackFor(persisted.id);
		}
		return persisted;
	}

	/**
	 * One fire-and-forget event to the operator worker. The ledger records
	 * truth and emits; the per-item OperatorTurn Durable Object owns its own
	 * lifecycle and reads a fresh snapshot when it starts a turn. A lost poke
	 * is recovered by the next event or the periodic sweep, and a bounded
	 * lifetime poke budget parks a non-converging item for review.
	 */
	/** Maintenance: terminally park every live item at or below a sequence. */
	async parkStaleWorkItems(beforeSequence: number): Promise<number> {
		let parked = 0;
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) {
				if (TERMINAL_PHASES.has(item.phase) || (item.sequence ?? 0) > beforeSequence) continue;
				try {
					const current = await this.loadWorkItem(item.id);
					if (!current || TERMINAL_PHASES.has(current.phase)) continue;
					const next = { ...current, phase: "needs_review" as const, version: current.version + 1, activeImplementation: null, updatedAt: Date.now() };
					await this.persistTransition(current.version, next, "Parked by maintenance: superseded by newer platform fixes; ledger and artifacts intact.", "system");
					parked += 1;
				} catch { /* raced with its own transition; the next sweep settles it */ }
			}
		}
		return parked;
	}

	/** Maintenance: delete parked/rejected items and every trace of them. */
	async purgeReviewWorkItems(): Promise<number> {
		let purged = 0;
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) {
				if (item.phase !== "needs_review" && item.phase !== "rejected") continue;
				const keys = [
					this.workItemKey(item.id),
					`${EXTERNAL_FACT_PREFIX}${item.id}`,
					`${POKE_COUNT_PREFIX}${item.id}`,
					`${ACTION_ACTIVE_PREFIX}${item.id}`,
					...(item.sequence ? [this.orderKey(WORK_ITEM_ORDER_PREFIX, item.sequence, item.id)] : []),
				];
				for (let sequence = 1; sequence <= item.eventSequence; sequence += 1) keys.push(this.eventKey(item.id, sequence));
				// The purge takes the item's action history with it: action records
				// and effect-key records are per-item prefixes, so a purged item
				// leaves nothing behind for future snapshot scans to pay for.
				for (const prefix of [`${ACTION_PREFIX}${item.id}:`, `${ACTION_KEY_PREFIX}${item.id}:`]) {
					for await (const page of this.storagePages<unknown>(prefix)) keys.push(...page.keys());
				}
				for (const batch of storageDeleteBatches(keys)) await this.ctx.storage.delete(batch);
				// A purged item must not keep holding an admission slot, a queue
				// place, or a room-stack node its record can no longer release.
				await this.releaseImplementSlotFor(item.id);
				await this.truncateRoomStackFor(item.id);
				purged += 1;
			}
		}
		const remaining = await this.getWorkItemPage();
		this.broadcast({ type: "harness:work-items", workItems: await this.projectWorkItems(remaining.records), hasMore: remaining.hasMore, beforeSequence: remaining.beforeSequence, total: remaining.records.length });
		return purged;
	}

	private pokeOperator(item: StoredWorkItem, origin: "event" | "sweep" = "event"): void {
		if (TERMINAL_PHASES.has(item.phase) || this.env.OPERATOR_PAUSED === "true") return;
		this.ctx.waitUntil((async () => {
			// The lifetime cap bounds event-driven pokes only: those track real
			// ledger activity, so exhausting them means non-convergence. Sweep
			// re-pokes are periodic and proportional to wall-clock time queued,
			// not to progress — counting them would park healthy-but-queued work
			// on a schedule instead of on behavior.
			if (origin === "event") {
				const key = `${POKE_COUNT_PREFIX}${item.id}`;
				const pokes = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
				if (pokes > OPERATOR_POKE_CAP) {
					const current = await this.loadWorkItem(item.id);
					if (current && !TERMINAL_PHASES.has(current.phase)) {
						const parked = { ...current, phase: "needs_review" as const, version: current.version + 1, activeImplementation: null, updatedAt: Date.now() };
						await this.persistTransition(current.version, parked, `The operator consumed its lifetime budget of ${OPERATOR_POKE_CAP} wakes without reaching a terminal state. Work is parked for review with its ledger and artifacts intact.`, "system");
					}
					return;
				}
				await this.ctx.storage.put(key, pokes);
			}
			const result = await (this.env.OPERATOR as OperatorGatewayTransport).submitWake({ workItemId: item.id });
			if (!result.accepted) console.warn("The operator worker declined a wake.", { workItemId: item.id, message: result.message });
		})().catch((error) => {
			// A lost poke is not a lost item: the next ledger event or the sweep
			// re-pokes, and the operator's own alarm resumes a crashed turn.
			console.error("Failed to poke the operator worker.", { workItemId: item.id, error });
		}));
	}

	/**
	 * Free whatever the item holds in the admission record — its slot, or its
	 * queue place when it ended while waiting — then publish the new queue
	 * positions and nudge the queue head so a freed slot never waits for the
	 * two-minute sweep. The nudge is sweep-class (free of the lifetime poke
	 * cap): it measures a queue advance, not new item activity.
	 */
	private async releaseImplementSlotFor(workItemId: string): Promise<void> {
		const release = await this.ctx.storage.transaction(async (txn) => {
			const outcome = releaseImplementSlot(await txn.get(ADMISSION_STATE_KEY), workItemId);
			if (outcome.released) await txn.put(ADMISSION_STATE_KEY, outcome.state);
			return outcome;
		});
		if (!release.released) return;
		await this.announceImplementQueue();
		const head = release.state.queue[0];
		if (head) {
			const item = await this.loadWorkItem(head);
			if (item && !TERMINAL_PHASES.has(item.phase)) this.pokeOperator(item, "sweep");
		}
	}

	/**
	 * Public honesty about the admission queue: one activity line per queued
	 * item whenever its position changes, throttled by announcing changes only.
	 */
	private async announceImplementQueue(): Promise<void> {
		const announcements = await this.ctx.storage.transaction(async (txn) => {
			const state = normalizeAdmissionState(await txn.get(ADMISSION_STATE_KEY));
			const changes: Array<{ id: string; position: number }> = [];
			for (const [index, id] of state.queue.entries()) {
				const position = index + 1;
				if (state.announced[id] === position) continue;
				state.announced[id] = position;
				changes.push({ id, position });
			}
			if (changes.length) await txn.put(ADMISSION_STATE_KEY, state);
			return changes;
		});
		for (const { id, position } of announcements) {
			const item = await this.loadWorkItem(id);
			if (item && !TERMINAL_PHASES.has(item.phase)) await this.appendActionEvent(id, item.phase, queuePositionMessage(position), "system");
		}
	}

	/**
	 * Truncate the item's node out of the room stack at exactly the transitions
	 * where its admission slot releases. Every node above it is marked stale —
	 * its recorded parent is gone — and the lowest survivor gets one
	 * sweep-class nudge so the sequential replan cascade starts now instead of
	 * on the next sweep.
	 */
	private async truncateRoomStackFor(workItemId: string): Promise<void> {
		const outcome = await this.ctx.storage.transaction(async (txn) => {
			const truncated = truncateStack(normalizeRoomStack(await txn.get(ROOM_STACK_KEY)), workItemId);
			if (truncated.removed) await txn.put(ROOM_STACK_KEY, truncated.stack);
			return truncated;
		});
		if (outcome.removed && outcome.staleWorkItemIds.length) await this.nudgeRestackSurvivor(outcome.staleWorkItemIds[0]);
	}

	/** Sweep-class poke to a restacked survivor: it measures a stack event, not new item activity, so it never burns the lifetime poke cap. */
	private async nudgeRestackSurvivor(workItemId: string): Promise<void> {
		const item = await this.loadWorkItem(workItemId);
		if (item && !TERMINAL_PHASES.has(item.phase)) this.pokeOperator(item, "sweep");
	}

	/**
	 * The cascade's forward step: the bottom node's pull request merged, so it
	 * pops off the room stack and the recorded base advances to the merge
	 * commit. Survivors keep their tip, head shas, and generations — GitHub
	 * retargets them without rebasing — and the new bottom item gets one
	 * sweep-class poke so it promotes promptly instead of on its next wake.
	 */
	private async popRoomStackBottom(workItemId: string, mergeCommitSha: string): Promise<void> {
		const outcome = await this.ctx.storage.transaction(async (txn) => {
			const popped = popBottomNode(normalizeRoomStack(await txn.get(ROOM_STACK_KEY)), workItemId, mergeCommitSha);
			if (popped.popped) await txn.put(ROOM_STACK_KEY, popped.stack);
			return popped;
		});
		if (!outcome.popped) return;
		const bottom = outcome.stack.order[0];
		if (bottom) await this.nudgeRestackSurvivor(bottom.workItemId);
	}

	/**
	 * GitHub's retarget marker: after the node below merged, the survivor's
	 * pull request was retargeted off its recorded parent (to the stack base)
	 * without a rebase. Only the marker changes — a stack fact whose base
	 * still names the recorded parent is a join or move, not a retarget.
	 */
	private async markRoomStackRetargeted(workItemId: string, base: string): Promise<void> {
		await this.ctx.storage.transaction(async (txn) => {
			const stack = normalizeRoomStack(await txn.get(ROOM_STACK_KEY));
			const node = stack.order.find((entry) => entry.workItemId === workItemId);
			if (!node || node.parentBranch === base) return;
			const marked = markNodeRetargeted(stack, workItemId);
			if (marked.marked) await txn.put(ROOM_STACK_KEY, marked.stack);
		});
	}

	/**
	 * Missed-delivery backstop for the merge train: the pop above rides the
	 * merged webhook, and a lost delivery would otherwise leave the bottom
	 * node holding the stack forever. Each sweep spends at most one bounded
	 * bridge observation on the bottom node — only when its merged fact is
	 * overdue — and reconciles the pop from the observed merge commit.
	 */
	private async reconcileStackBottom(now: number): Promise<void> {
		const stack = normalizeRoomStack(await this.ctx.storage.get(ROOM_STACK_KEY));
		const bottom = stack.order[0];
		if (!bottom) return;
		const item = await this.loadWorkItem(bottom.workItemId);
		if (!item) return;
		const facts = await this.ctx.storage.get<ExternalFacts>(`${EXTERNAL_FACT_PREFIX}${item.id}`);
		if (facts?.merged?.mergeCommitSha) {
			// The merged fact is recorded but the pop was lost: reconcile it.
			await this.popRoomStackBottom(item.id, facts.merged.mergeCommitSha);
			return;
		}
		const overdue = (facts?.promotion?.conclusion === "success" && now - facts.promotion.at > MERGE_WATCH_TIMEOUT_MS)
			|| item.phase === "deployed" || item.phase === "completed";
		const candidate = item.artifacts.candidate as { pullRequestNumber?: unknown } | undefined;
		if (!overdue || !Number.isSafeInteger(candidate?.pullRequestNumber) || !this.env.GITHUB) return;
		try {
			const observed = await (this.env.GITHUB as GithubBridgeTransport).observeCandidatePullRequest({ number: candidate!.pullRequestNumber as number });
			if (observed.merged && typeof observed.mergeCommitSha === "string" && /^[0-9a-f]{40}$/u.test(observed.mergeCommitSha)) {
				await this.popRoomStackBottom(item.id, observed.mergeCommitSha);
			}
		} catch (error) {
			// An unobservable PR is not a lost stack: the next sweep retries.
			console.error("Stack-bottom merge reconciliation failed.", { workItemId: item.id, error });
		}
	}

	/**
	 * The nuke-and-rebuild lever for a corrupted room stack: park every
	 * stacked non-terminal item and clear the record so the queue can be
	 * re-admitted in order as fresh generations. The trusted server-side
	 * unstack (`gh stack unstack`) is a documented operator-side manual step,
	 * never executed by this worker.
	 */
	async rebuildStack(): Promise<{ parked: number; clearedStackId: string | null }> {
		const stack = normalizeRoomStack(await this.ctx.storage.get(ROOM_STACK_KEY));
		const stacked = [...stack.order.map((node) => node.workItemId), ...stack.stale.map((node) => node.workItemId)];
		let parked = 0;
		for (const workItemId of stacked) {
			try {
				const current = await this.loadWorkItem(workItemId);
				if (!current || TERMINAL_PHASES.has(current.phase)) continue;
				const next = { ...current, phase: "needs_review" as const, version: current.version + 1, activeImplementation: null, updatedAt: Date.now() };
				await this.persistTransition(current.version, next, "Parked by the stack rebuild lever: the room stack record is being cleared; resubmit this request to re-admit it as a fresh generation.", "system");
				parked += 1;
			} catch { /* raced with its own transition; clearing the record below is what matters */ }
		}
		await this.ctx.storage.delete(ROOM_STACK_KEY);
		return { parked, clearedStackId: stack.stackId };
	}

	/** Record the room-level credit outage exactly once and announce it publicly. */
	private async recordModelCreditsExhausted(): Promise<void> {
		const outcome = await this.ctx.storage.transaction(async (txn) => {
			const recorded = recordCreditsExhausted(await txn.get(SYSTEM_HEALTH_KEY), Date.now());
			if (recorded.changed) await txn.put(SYSTEM_HEALTH_KEY, recorded.health);
			return recorded;
		});
		if (outcome.changed) await this.systemChat("Model credits are exhausted; work is paused until the balance is restored.");
	}

	/** One durable, broadcast chat line from the platform itself. */
	private async systemChat(text: string): Promise<void> {
		const message: ChatMessage = { id: crypto.randomUUID(), author: "System", text, createdAt: Date.now() };
		await this.saveMessage(message);
		this.broadcast({ type: "chat:message", message });
	}

	/**
	 * The slow safety net behind event pokes. It recovers interrupted action
	 * executions and re-pokes every live work item, so no failure mode can
	 * silently strand work. Sweep re-pokes never consume the lifetime poke
	 * cap: the cap bounds event-driven activity, not time spent queued.
	 */
	private async sweep(): Promise<void> {
		if (this.env.OPERATOR_PAUSED === "true") return;
		// A recorded model-credit outage pauses the room: the sweep sends no
		// pokes while it stands. Each sweep spends exactly one minimal probe
		// through the operator worker; the first success clears the fact,
		// announces recovery publicly, and this same sweep resumes pokes.
		const health = await this.ctx.storage.get<CreditsHealth>(SYSTEM_HEALTH_KEY);
		if (health?.creditsExhausted) {
			const probe = await (this.env.OPERATOR as OperatorGatewayTransport).probeModel().catch(() => ({ ok: false as const }));
			if (!probe.ok) return;
			if (clearCreditsExhausted(health).changed) {
				await this.ctx.storage.delete(SYSTEM_HEALTH_KEY);
				await this.systemChat("Model credits are restored; paused work is resuming.");
			}
		}
		const now = Date.now();
		// Merge-train reconciliation: recover a lost merged delivery for the
		// stack's bottom node before the per-item re-pokes below.
		await this.reconcileStackBottom(now);
		for await (const page of this.storagePages<StoredOperatorAction>(ACTION_PREFIX)) {
			for (const action of page.values()) {
				if (action.status !== "applying" || !action.leaseExpiresAt || action.leaseExpiresAt > now) continue;
				const expired = await this.ctx.storage.transaction(async (txn) => {
					const current = await txn.get<StoredOperatorAction>(this.actionKey(action.workItemId, action.id));
					if (!current || current.status !== "applying" || (current.leaseExpiresAt ?? 0) > now) return undefined;
					const next: StoredOperatorAction = { ...current, status: "needs_reconciliation", executionToken: undefined, leaseExpiresAt: undefined, updatedAt: now };
					await txn.put(this.actionKey(current.workItemId, current.id), next);
					return next;
				});
				if (!expired) continue;
				const item = await this.loadWorkItem(expired.workItemId);
				if (item && !TERMINAL_PHASES.has(item.phase)) {
					await this.appendActionEvent(item.id, item.phase, `The operator must reconcile an interrupted ${expired.command.kind.replaceAll("-", " ")} before retrying.`);
				}
			}
		}
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) {
				if (TERMINAL_PHASES.has(item.phase)) continue;
				// Mechanical run-deadline enforcement: a silent run past its
				// budget is declared dead BY THE LEDGER, not by model judgment.
				// A platform-killed container reports nothing, and a model told
				// to wait for the callback would otherwise wait forever.
				if (item.phase === "implementing" && item.activeImplementation && now - item.activeImplementation.startedAt > STALLED_IMPLEMENTATION_MS) {
					try {
						await this.recordExternalState({
							workItemId: item.id,
							phase: "retryable",
							message: "The implementation run went silent past its execution deadline. The ledger cleared it; stage a fresh implementation.",
							source: "system",
						});
					} catch (error) {
						console.error("Failed to clear a silent implementation run.", { workItemId: item.id, error });
					}
					continue;
				}
				this.pokeOperator(item, "sweep");
			}
		}
	}

	private async scheduleSweep(): Promise<void> {
		// Durable emergency brake: preserve every ledger record while sending
		// no wakes and no model prompts. Redeploying with the flag disabled
		// reconstructs the schedule from the ledger on initialization.
		if (this.env.OPERATOR_PAUSED === "true") {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		let live = false;
		for await (const page of this.storagePages<StoredWorkItem>(WORK_ITEM_PREFIX)) {
			for (const item of page.values()) {
				if (!TERMINAL_PHASES.has(item.phase)) { live = true; break; }
			}
			if (live) break;
		}
		if (!live) return;
		const target = Date.now() + SWEEP_INTERVAL_MS;
		const existing = await this.ctx.storage.getAlarm();
		if (existing === null || existing > target) await this.ctx.storage.setAlarm(target);
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
	/** Actions are keyed per work item so every per-item read is a bounded prefix scan and the purge can delete an item's whole action history. */
	private actionKey(workItemId: string, id: number): string { return `${ACTION_PREFIX}${workItemId}:${String(id).padStart(12, "0")}`; }
	private eventKey(id: string, sequence: number): string { return `${EVENT_PREFIX}${id}:${String(sequence).padStart(12, "0")}`; }

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

function publicEventSource(source: LedgerEvent["source"]): PublicEventSource {
	// The stored enum keeps its historical value for old records; the public
	// surface always says "operator".
	return source === "cloudflare-os" ? "operator" : source;
}

function publicActivity(event: LedgerEvent): PublicActivity {
	return { sequence: event.sequence, phase: publicPhase(event.phase), message: event.message, source: publicEventSource(event.source), at: event.at };
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

const OPERATOR_STATE_ACTION_LIMIT = 10;
const OPERATOR_STATE_RESULT_CHARS = 400;
const OPERATOR_STATE_MAX_CHARS = 6_000;
/** Rolling tail of coding-agent JSONL events kept on the progress fact. */
const RUNNER_PROGRESS_EVENTS_KEPT = 30;
/** How much of that tail the bounded operator snapshot embeds. */
const OPERATOR_STATE_PROGRESS_EVENTS = 5;
const OPERATOR_STATE_PROGRESS_EVENT_CHARS = 200;

/**
 * Compact authoritative snapshot the operator reads at the start of each
 * turn. It carries facts, never a decision: the model still chooses the
 * single next command, and the durable ledger still enforces phase,
 * ordering, and idempotency invariants against whatever the model stages.
 */
function operatorSnapshot(item: StoredWorkItem | undefined, actions: StoredOperatorAction[], facts?: ExternalFacts, queuePosition?: number | null, parentRestacked?: boolean, stackNode?: RoomStackNodeContext | null): string {
	if (!item) return "null";
	// Pushed external facts ride the snapshot; only facts for the currently
	// active implementation run are shown so a stale run cannot masquerade.
	const runnerResult = facts?.runnerResult && item.activeImplementation && facts.runnerResult.runId === item.activeImplementation.runId ? facts.runnerResult : undefined;
	const liveProgress = facts?.runnerProgress && item.activeImplementation && facts.runnerProgress.runId === item.activeImplementation.runId ? facts.runnerProgress : undefined;
	// The model sees what the coding agent last did: the current step plus a
	// bounded tail of its streamed JSONL events.
	const runnerProgress = liveProgress
		? {
			runId: liveProgress.runId,
			step: liveProgress.step,
			at: liveProgress.at,
			...(liveProgress.events?.length ? { events: liveProgress.events.slice(-OPERATOR_STATE_PROGRESS_EVENTS).map((event) => event.slice(0, OPERATOR_STATE_PROGRESS_EVENT_CHARS)) } : {}),
		}
		: undefined;
	// Pushed GitHub facts ride the same way, each gated by the immutable
	// identity the ledger already owns so a stale generation cannot masquerade:
	// validation by the recorded candidate head revision, promotion by a staged
	// promote action's durable dispatchKey, candidate corroboration by the
	// active plan branch while the item is still implementing.
	const candidateArtifact = item.artifacts.candidate as { headSha?: unknown } | undefined;
	const validation = facts?.validation && candidateArtifact?.headSha === facts.validation.headSha ? facts.validation : undefined;
	const promotionFact = facts?.promotion;
	const promotion = promotionFact && actions.some((action) => action.command.kind === "promote" && action.command.dispatchKey === promotionFact.dispatchKey) ? promotionFact : undefined;
	// While the item is promoting, the applied promote action's durable dispatch
	// key rides the snapshot as a loop-facing identity: the operator loop (never
	// the model) uses it to observe the promotion run when the webhook fact was
	// lost, so the item can still record deployed from real evidence.
	const appliedPromote = item.phase === "promoting" ? actions.findLast((action) => action.command.kind === "promote" && action.status === "applied") : undefined;
	const promotionDispatch = appliedPromote && appliedPromote.command.kind === "promote"
		? { dispatchKey: appliedPromote.command.dispatchKey, dispatchedAt: appliedPromote.updatedAt }
		: undefined;
	const candidate = facts?.candidate && item.phase === "implementing" && item.plan && facts.candidate.branch === item.plan.branch ? facts.candidate : undefined;
	// Merge evidence facts: the merged fact is gated by the recorded
	// candidate's immutable head revision (or the plan branch), and the main
	// deploy run rides alongside a merged fact whose merge commit it contains:
	// exactly (the run's head IS the merge commit), or by descent — main
	// history is linear, so a successful run created after the merged fact was
	// recorded deployed a descendant of the merge commit. Back-to-back merges
	// whose own queued deploy run GitHub canceled still complete on this
	// evidence chain instead of needing a second promotion run.
	const merged = facts?.merged && (candidateArtifact?.headSha === facts.merged.headSha || (item.plan && facts.merged.branch === item.plan.branch)) ? facts.merged : undefined;
	const mainDeploy = merged && facts?.mainDeploy && (facts.mainDeploy.headSha === merged.mergeCommitSha || (facts.mainDeploy.conclusion === "success" && Date.parse(facts.mainDeploy.createdAt) > merged.at)) ? facts.mainDeploy : undefined;
	// The merge-train hold: a green upper node is blocked by design — only the
	// bottom item promotes, so a held item's single honest move is WAITING.
	// The hold also suppresses the merge-watch problem below, which would
	// otherwise instruct a promotion dispatch the trusted gate must refuse.
	const mergeTrainHold = stackNode && stackNode.position > 1 && validation?.conclusion === "success"
		? `Validation is green, but ${stackNode.position - 1} item(s) are below this one in the merge train and only the bottom item promotes. Reply WAITING with your position; the ledger pokes this item when the item below merges.`
		: undefined;
	// Merge-watch problem fact: a promotion dispatch that was never staged (or
	// whose fact was lost) is invisible by push, and GitHub sends no event
	// when a PR becomes conflicted. Validation succeeded, the watch window
	// passed, and neither a merged fact nor a promotion fact arrived: name the
	// problem so the operator dispatches the promotion now — the single merge
	// path — and restacks a conflicted candidate via the bridge observation.
	let mergeTimeoutProblem: string | undefined;
	if (validation && validation.conclusion === "success" && !merged && !facts?.promotion && !mergeTrainHold && Date.now() - validation.at > MERGE_WATCH_TIMEOUT_MS) {
		mergeTimeoutProblem = "Validation succeeded but no promotion fact and no merged fact arrived within the merge watch window. Dispatch the merge now with stagePromotion — the operator-staged promotion dispatch is the single merge path; candidates never auto-merge. If the candidate may be conflicted, observe the candidate pull request state with observeCandidatePullRequest: if mergeableState is dirty the candidate is conflicted — restack now with stagePlan (next generation, fresh getMainSha baseSha).";
	}
	// Surface a stalled implementation run as a fact: the disposable runner
	// derives its own process identity, so a re-staged implement command with
	// a fresh runId starts a clean isolated run instead of resuming a corpse.
	let implementationProblem: string | undefined;
	if (item.phase === "implementing" && item.activeImplementation && Date.now() - item.activeImplementation.startedAt > STALLED_IMPLEMENTATION_MS) {
		implementationProblem = "The active implementation run exceeded its execution budget and cannot resume. Stage stageImplementation again to restart the isolated run.";
	}
	// A retryable item has no live run by construction: its failed generation
	// and stale runner evidence were cleared with the transition. Make the
	// restack the obvious single next step so the model never waits on a run
	// that no longer exists.
	const nextStep = item.phase === "retryable"
		? `The failed implementation run was cleared. Stage a revised plan (revision ${item.plan ? item.plan.revision + 1 : 1}, next generation, fresh getMainSha baseSha) to restack.`
		: undefined;
	// Surface a recorded plan the runner would refuse as a fact, so the
	// bounded model stages a revised plan instead of retrying implement. The
	// rules are scoped per node: a root node stacks on main, a dependent node
	// stacks on a pinned sibling branch.
	let planProblem: string | undefined;
	if (item.plan && !item.activeImplementation) {
		const canonical = `app-harness-os/${item.plan.issueNumber}/g${item.plan.generation}`;
		if (item.plan.nodeId === "root") {
			if (item.plan.parentBranch !== "main" || item.plan.pullRequestBase !== "main" || item.plan.parentBaseSha === null || item.plan.branch !== canonical) {
				planProblem = `The recorded plan is invalid for a root stack node: parentBranch and pullRequestBase must be main, parentBaseSha = baseSha, branch exactly ${canonical}. Stage a revised plan with revision ${item.plan.revision + 1} before implementation.`;
			}
		} else if (!/^app-harness-os\/\d+\/g\d+$/u.test(item.plan.parentBranch) || item.plan.pullRequestBase !== item.plan.parentBranch || item.plan.parentBaseSha === null || item.plan.branch !== canonical) {
			planProblem = `The recorded plan is invalid for a dependent stack node: parentBranch must be a sibling app-harness-os stack branch, pullRequestBase = parentBranch, parentBaseSha = the parent's pinned head, branch exactly ${canonical}. Stage a revised plan with revision ${item.plan.revision + 1} before implementation.`;
		}
	}
	// The cascade-restack fact: this node's recorded parent left the room
	// stack, so its plan builds on a branch that will never merge. The single
	// next step is a revised plan; the ledger re-derives the parent from the
	// current tip when it is staged.
	const restackProblem = parentRestacked
		? `Your parent was restacked and this node left the room stack. Stage a revised plan (revision ${item.plan ? item.plan.revision + 1 : 1}, next generation, fresh getMainSha baseSha); the ledger re-derives the parent from the current stack tip.`
		: undefined;
	const snapshot = {
		workItemId: item.id,
		phase: item.phase,
		version: item.version,
		request: String(item.request ?? "").slice(0, 600),
		classification: item.classification,
		plan: item.plan,
		...(nextStep ? { nextStep } : {}),
		...(promotionDispatch ? { promotionDispatch } : {}),
		...(queuePosition
			? { implementQueue: { position: queuePosition, note: `All ${IMPLEMENT_SLOTS} implementation slots are busy; this item is number ${queuePosition} in the queue. Reply WAITING — the ledger re-pokes when a slot frees.` } }
			: {}),
		// The item's merge-train coordinates: the loop (never the model) reads
		// expectedOrder from here and supplies it to the runner, which asserts
		// the server-side stack shows exactly these branches beneath the node.
		...(stackNode
			? { stack: { position: stackNode.position, size: stackNode.size, expectedOrder: stackNode.expectedOrder, ...(stackNode.retargeted ? { retargeted: true } : {}) } }
			: {}),
		...(mergeTrainHold ? { mergeTrainHold } : {}),
		...(planProblem ? { planProblem } : {}),
		...(restackProblem ? { restackProblem } : {}),
		...(implementationProblem ? { implementationProblem } : {}),
		...(mergeTimeoutProblem ? { mergeTimeoutProblem } : {}),
		...(runnerResult || runnerProgress || validation || promotion || candidate || merged || mainDeploy
			? {
				facts: {
					...(runnerResult ? { runnerResult } : {}),
					...(runnerProgress ? { runnerProgress } : {}),
					...(candidate ? { candidate } : {}),
					...(validation ? { validation } : {}),
					...(promotion ? { promotion } : {}),
					...(merged ? { merged } : {}),
					...(mainDeploy ? { mainDeploy } : {}),
				},
			}
			: {}),
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
	return trimmed.length <= OPERATOR_STATE_MAX_CHARS ? trimmed : JSON.stringify({ workItemId: item.id, phase: item.phase, version: item.version, request: snapshot.request });
}

function normalizeOperatorMessage(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("A public operator status message is required.");
	return value.trim().replace(/\s+/gu, " ");
}

/**
 * Verify a pushed external fact before it can touch the room. The merge is
 * monotonic by construction: one fact per run identifier, first write wins,
 * so a later delivery can never downgrade recorded evidence.
 */
/**
 * Live progress from the running job: `artifact.progress === true` plus a
 * step name, a bounded batch of coding-agent JSONL events, or both.
 */
function normalizeRunnerProgressInput(value: unknown): { workItemId: string; runId: string; step?: string; events?: string[] } | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.source !== "runner") return null;
	if (typeof raw.workItemId !== "string" || !isUuid(raw.workItemId)) return null;
	if (typeof raw.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(raw.runId)) return null;
	const artifact = raw.artifact;
	if (!artifact || typeof artifact !== "object") return null;
	const rawArtifact = artifact as Record<string, unknown>;
	if (rawArtifact.progress !== true) return null;
	const step = typeof rawArtifact.step === "string" && /^[a-z][a-z-]{0,40}$/u.test(rawArtifact.step) ? rawArtifact.step : undefined;
	const events = Array.isArray(rawArtifact.events)
		? rawArtifact.events.filter((event): event is string => typeof event === "string" && event.length > 0).map((event) => event.slice(0, 500)).slice(0, RUNNER_PROGRESS_EVENTS_KEPT)
		: undefined;
	if (!step && !events?.length) return null;
	return { workItemId: raw.workItemId, runId: raw.runId, ...(step ? { step } : {}), ...(events?.length ? { events } : {}) };
}

/** The public feed's honest admission-queue line, spoken only when a position changes. */
function queuePositionMessage(position: number): string {
	return position === 1
		? "Waiting for an implementation slot: next in line."
		: `Waiting for an implementation slot: ${position - 1} item(s) ahead in the queue.`;
}

/** A health note pushed by the operator worker over its private service binding. */
function normalizeOperatorNoteInput(value: unknown): { workItemId: string; note: string } | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.source !== "operator") return null;
	if (typeof raw.workItemId !== "string" || !isUuid(raw.workItemId)) return null;
	if (typeof raw.note !== "string" || !/^[a-z][a-z-]{0,60}$/u.test(raw.note)) return null;
	return { workItemId: raw.workItemId, note: raw.note };
}

/** The public activity feed gets a short human line per step transition; raw agent events stay on /status. */
function runnerStepMessage(step: string): string {
	const messages: Record<string, string> = {
		cloned: "The runner cloned the repository.",
		"agent-started": "The coding agent started editing the repository.",
		"agent-done": "The coding agent finished editing.",
		pushed: "The runner pushed the candidate branch.",
	};
	return messages[step] ?? `The runner reached step: ${step.replaceAll("-", " ")}.`;
}

function normalizeExternalFactInput(value: unknown): ExternalFactInput | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.source === "github") {
		// The bridge already verified the webhook signature and repository
		// gate; the ledger still re-validates the fact shape at its boundary.
		const deliveryId = normalizeGithubDeliveryId(raw.deliveryId);
		const fact = normalizeGithubWebhookFact(raw.fact);
		return deliveryId && fact ? { source: "github", deliveryId, fact } : null;
	}
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

function githubFactMessage(fact: GithubWebhookFact): string {
	if (fact.kind === "validation") return `GitHub reported the candidate validation run finished: ${fact.conclusion ?? "unknown"}.`;
	if (fact.kind === "promotion") return `GitHub reported the promotion run finished: ${fact.conclusion ?? "unknown"}.`;
	if (fact.kind === "main-deploy") return `GitHub reported the main deploy run finished: ${fact.conclusion ?? "unknown"}.`;
	if (fact.kind === "merged") return `GitHub reported candidate pull request #${fact.number} merged to main.`;
	return `GitHub reported candidate pull request #${fact.number} opened.`;
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
	const allowed = new Set(["issue", "candidate", "validation", "promotion", "merged", "mainDeploy", "deploymentUrl", "githubCiUrl"]);
	for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown artifact '${key}'.`);
	const normalized: Record<string, unknown> = {};
	if (raw.issue !== undefined) normalized.issue = assertGitHubIssue(raw.issue);
	if (raw.candidate !== undefined) {
		if (!raw.candidate || typeof raw.candidate !== "object") throw new Error("Candidate artifact is invalid.");
		const candidate = raw.candidate as { pullRequestNumber?: unknown; pullRequestUrl?: unknown; headSha?: unknown; branch?: unknown; implementationKey?: unknown; runId?: unknown; pullRequestBase?: unknown; stackId?: unknown; generation?: unknown; nodeId?: unknown };
		normalized.candidate = { ...candidate, pullRequestUrl: assertGitHubPullRequestUrl(candidate.pullRequestUrl, candidate.pullRequestNumber) };
	}
	for (const key of ["validation", "promotion", "mainDeploy"] as const) {
		if (raw[key] === undefined) continue;
		if (!raw[key] || typeof raw[key] !== "object") throw new Error(`${key} artifact is invalid.`);
		const artifact = raw[key] as { url?: unknown };
		normalized[key] = { ...artifact, url: assertGitHubActionsUrl(artifact.url) };
	}
	if (raw.merged !== undefined) {
		if (!raw.merged || typeof raw.merged !== "object") throw new Error("Merged artifact is invalid.");
		const merged = raw.merged as { number?: unknown; url?: unknown; headSha?: unknown; mergeCommitSha?: unknown; branch?: unknown };
		if (typeof merged.headSha !== "string" || !/^[0-9a-f]{40}$/u.test(merged.headSha)) throw new Error("Merged artifact requires the candidate's immutable head SHA.");
		if (typeof merged.mergeCommitSha !== "string" || !/^[0-9a-f]{40}$/u.test(merged.mergeCommitSha)) throw new Error("Merged artifact requires the merge commit SHA.");
		normalized.merged = { ...merged, url: assertGitHubPullRequestUrl(merged.url, merged.number) };
	}
	if (raw.githubCiUrl !== undefined) normalized.githubCiUrl = assertGitHubActionsUrl(raw.githubCiUrl);
	if (raw.deploymentUrl !== undefined) normalized.deploymentUrl = assertDeploymentUrl(raw.deploymentUrl);
	return normalized;
}

function validateOperatorCommand(command: OperatorCommand): void {
	if (!command || typeof command !== "object") throw new Error("Operator command is required.");
	if (command.kind === "implement") {
		// The loop-supplied merge-train order beneath this node: a bounded list
		// of canonical sibling branches, never model-typed free text.
		if (command.expectedOrder !== undefined && (!Array.isArray(command.expectedOrder) || command.expectedOrder.length > 16 || command.expectedOrder.some((branch) => typeof branch !== "string" || !/^app-harness-os\/\d+\/g\d+$/u.test(branch)))) {
			throw new Error("Implement command expectedOrder must be a bounded list of canonical stack branches.");
		}
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
		if (pathname.startsWith("/api/admin/")) {
			// The maintenance levers park or delete work: they require the
			// ADMIN_TOKEN worker secret as a bearer credential and fail closed
			// when the secret is not provisioned.
			const token = (env as { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
			if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
		}
		if (pathname === "/api/admin/purge-terminal") {
			// Prototype maintenance lever: delete parked and rejected items
			// outright (completed ones stay - they are the record of shipped
			// work; the durable evidence lives on GitHub either way).
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const purged = await env.CHAT_ROOM.getByName("main").purgeReviewWorkItems();
			return Response.json({ purged });
		}
		if (pathname === "/api/admin/rebuild-stack") {
			// The merge-train recovery lever: park every stacked non-terminal
			// item and clear the room-stack record. The trusted server-side
			// unstack is documented in the response as an operator-side manual
			// step; this worker never runs it.
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			const outcome = await env.CHAT_ROOM.getByName("main").rebuildStack();
			return Response.json({
				...outcome,
				operatorStep: "Manual trusted step (not executed by this worker): run `gh stack unstack` against the abandoned server-side stack, then resubmit the parked requests in order as fresh generations.",
			});
		}
		if (pathname === "/api/admin/park-stale") {
			// Prototype maintenance lever: park every non-terminal work item at or
			// below the given sequence so abandoned work stops consuming runs.
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
			let body: { beforeSequence?: unknown };
			try { body = JSON.parse(await request.text()) as typeof body; } catch { return new Response("Invalid JSON", { status: 400 }); }
			if (!Number.isSafeInteger(body.beforeSequence)) return new Response("beforeSequence required", { status: 400 });
			const parked = await env.CHAT_ROOM.getByName("main").parkStaleWorkItems(body.beforeSequence as number);
			return Response.json({ parked });
		}
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
