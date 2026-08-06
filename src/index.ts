import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
	applyCoordinatorCallback,
	blockCoordinatorStack,
	claimCoordinatorEffect,
	completeCoordinatorEffect,
	createCoordinatorEffect,
	createCoordinatorJob,
	normalizeAgentProvenance,
	reconcileCompletedStack,
	retryCoordinatorEffect,
} from "./coordinator-state.js";
import { createGithubIdentityClient } from "./github-identity-client.js";
import {
	classifyOsRunnerResponse,
	createOsNativeGitJob,
	createOsWorkspaceSubmission,
	osExecutionDisposition,
	osWorkspaceTurnDisposition,
	validateOsExecutionRequest,
} from "./os-provider-bridge.js";
import { applyStackEvent, createStackLedger } from "./stack-ledger.js";

type ChatMessage = {
	id: string;
	author: string;
	text: string;
	createdAt: number;
};

type WorkflowPhase =
	| "received"
	| "interpreting"
	| "preparing_candidate"
	| "validating"
	| "deploying"
	| "completed"
	| "requires_review"
	| "rejected"
	| "failed";

type WorkflowActivity = {
	phase: WorkflowPhase;
	message: string;
	at: number;
};

type WorkflowRecord = {
	id: string;
	workItemId?: string;
	request: string;
	target?: TargetEnvelope;
	phase: WorkflowPhase;
	activity: WorkflowActivity[];
	createdAt: number;
	updatedAt: number;
	result?: string;
};

type TargetRectangle = {
	x: number;
	y: number;
	width: number;
	height: number;
};

/**
 * Context from the optional click-to-target authoring surface. This is
 * deliberately presentation metadata only: no form values, message bodies,
 * query strings, or credentials are accepted into the durable ledger.
 */
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

type DrawingPoint = {
	x: number;
	y: number;
};

type HarnessAnnotation =
	| {
			id: string;
			workItemId?: string;
			kind: "comment";
			target: TargetEnvelope;
			text: string;
			createdAt: number;
		}
	| {
			id: string;
			workItemId?: string;
			kind: "draw";
			points: DrawingPoint[];
			page: string;
			room: string;
			createdAt: number;
		};

type WorkItemPhase = "received" | "triaged" | "queued" | "building" | "completed" | "rejected" | "needs_review";

type WorkItemActivity = {
	phase: WorkItemPhase;
	message: string;
	at: number;
};

type HarnessWorkItem = {
	id: string;
	annotationId?: string;
	clientSubmissionId?: string;
	kind: "request" | "comment" | "draw";
	summary: string;
	target?: TargetEnvelope;
	phase: WorkItemPhase;
	activity: WorkItemActivity[];
	createdAt: number;
	updatedAt: number;
	workflowId?: string;
	githubIssue?: { number: number; url: string };
	githubPullRequestUrl?: string;
	osNativeGit?: {
		jobId: string;
		state: string;
		runnerUrl: string;
		stackId: string;
		generation: number;
		attempts?: number;
		startedAt?: number;
		baseSha?: string;
		headSha?: string;
		agent?: { model: string; responseIds: string[]; tools: string[] };
		workspace?: { chatPath: string; state: string; lastResponse?: string };
	};
};

type ClientEvent =
	| { type: "chat:send"; author?: unknown; text?: unknown }
	| { type: "workflow:request"; request?: unknown; target?: unknown; clientSubmissionId?: unknown }
	| { type: "harness:annotation"; annotation?: unknown; clientSubmissionId?: unknown }
	| { type: "harness:annotation:delete"; annotationId?: unknown }
	| { type: "harness:annotations:clear" };

type WorkflowCallback = {
	requestId?: unknown;
	phase?: unknown;
	message?: unknown;
	result?: unknown;
	deploymentUrl?: unknown;
	currentMainSha?: unknown;
	headSha?: unknown;
	mergeSha?: unknown;
	runId?: unknown;
};

type CoordinatorJob = Omit<ReturnType<typeof createCoordinatorJob>, "stage" | "currentEffectId" | "lease"> & {
	stage: string;
	terminalPhase?: WorkflowPhase;
	currentEffectId: string | null;
	lease: { effectId: string; token: string; expiresAt: number } | null;
};

type CoordinatorEffect = Omit<ReturnType<typeof createCoordinatorEffect>, "payload"> & { payload: Record<string, unknown> };
type StackLedger = ReturnType<typeof createStackLedger>;
type CoordinatorClaim = { job: CoordinatorJob; effect: CoordinatorEffect; leaseToken: string };

type RuntimeEnv = Omit<Env, "OS_NATIVE_GIT_RUNNER" | "OS_WORKSPACE"> & {
	GITHUB_AUTOMATION_TOKEN: string;
	AUTONOMY_CALLBACK_SECRET: string;
	OS_NATIVE_GIT_RUNNER?: Fetcher;
	OS_NATIVE_GIT_RUNNER_SECRET?: string;
	OS_WORKSPACE?: unknown;
	GITHUB_IDENTITY_BRIDGE?: Fetcher;
	APP_HARNESS_IDENTITY_SECRET?: string;
};

type OsWorkspaceGateway = {
	submitExternalMessage(input: {
		callerEmail: string;
		gadgetKey: string;
		chatKey: string;
		messageKey: string;
		gadgetTitle: string;
		prompt: string;
		chatGatewayRpcTarget: unknown;
	}): Promise<{ accepted: true; chatPath: string } | { accepted: false; message: string }>;
};

type OsWorkspaceResponse = { text: string; idempotencyKey: string };
type OsExecutionBridgeProps = { source: string };
type OsExecutionRequest = { workItemId: string; issueNumber: number };

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_REQUEST_LENGTH = 500;
const MAX_STORED_MESSAGES = 200;
const MAX_STORED_ANNOTATIONS = 100;
// Kept only as the public "latest workflow" compatibility snapshot. Admission,
// callbacks, leases, and retries are keyed by workflow/work item below.
const WORKFLOW_KEY = "workflow";
const WORKFLOW_PREFIX = "workflow:";
const JOB_PREFIX = "coordinator-job:";
const OUTBOX_PREFIX = "coordinator-outbox:";
const LEDGER_PREFIX = "stack-ledger:";
const WORK_ITEM_PREFIX = "harness-work-item:";
const ANNOTATIONS_KEY = "harness-annotations";
const WORK_ITEMS_KEY = "harness-work-items";
const MAX_STORED_WORK_ITEMS = 100;
const COORDINATOR_LEASE_MS = 180_000;
const OS_RUNNER_LEASE_MS = 780_000;
const COORDINATOR_MAX_ATTEMPTS = 3;
const COORDINATOR_BATCH_SIZE = 8;
const SHA = /^[0-9a-f]{40}$/iu;
const LIVE_APP_URL = "https://autonomous-live-chat.coda-a.workers.dev/?room=main";
const OS_WORKSPACE_CALLER_EMAIL = "callil.capuozzo@gmail.com";
const TERMINAL_PHASES: ReadonlySet<WorkflowPhase> = new Set([
	"completed",
	"requires_review",
	"rejected",
	"failed",
]);
const PHASES: ReadonlySet<WorkflowPhase> = new Set([
	"received",
	"interpreting",
	"preparing_candidate",
	"validating",
	"deploying",
	"completed",
	"requires_review",
	"rejected",
	"failed",
]);


/**
 * Persistent callback capability handed to Cloudflare OS. The OS workspace
 * stores this stub and invokes it after the agent turn finishes; the props bind
 * that response to one durable App Harness work item without parsing model
 * prose for identifiers.
 */
export class OsWorkspaceResponseTarget extends WorkerEntrypoint<RuntimeEnv> {
	async onGadgetResponse(response: OsWorkspaceResponse): Promise<void> {
		const prefix = "app-harness:";
		if (!response.idempotencyKey.startsWith(prefix)) throw new Error("Cloudflare OS response target source is invalid.");
		const workItemId = response.idempotencyKey.slice(prefix.length);
		if (!isUuid(workItemId)) throw new Error("Cloudflare OS response target work item is invalid.");
		await this.env.CHAT_ROOM.getByName("main").receiveOsWorkspaceResponse(workItemId, response);
	}
}

/**
 * Capability-only bridge exposed to the Cloudflare OS Gatekeeper. It has no
 * HTTP route and accepts no repository, prompt, source, or credential from the
 * agent. The durable work item remains the authority for all of those values.
 */
export class OsExecutionBridge extends WorkerEntrypoint<RuntimeEnv, OsExecutionBridgeProps> {
	async enqueueRepositoryTask(input: OsExecutionRequest): Promise<{ accepted: boolean; state: string }> {
		if (this.ctx.props.source !== "cloudflare-os") throw new Error("Unrecognized Cloudflare OS capability source.");
		if (!input || !isUuid(input.workItemId) || !Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
			throw new Error("Cloudflare OS execution request is invalid.");
		}
		return this.env.CHAT_ROOM.getByName("main").enqueueOsRepositoryTask(input);
	}
}

/**
 * A room is the durable coordination boundary for both chat and autonomous
 * change requests. The object keeps a public, ordered record and broadcasts
 * each state transition to every connected client.
 */
export class ChatRoom extends DurableObject<RuntimeEnv> {
	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/workflow-callback") {
			const callback = (await request.json()) as WorkflowCallback;
			await this.applyWorkflowCallback(callback);
			return Response.json({ ok: true });
		}

		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		await this.migrateLegacyRecords();
		await this.backfillExternalHandoffs();
		await this.reconcileClosedGitHubIssues();
		await this.scheduleCoordinatorAlarm();
		const [storedMessages, workflow, annotations, workItems] = await Promise.all([
			this.ctx.storage.get<ChatMessage[]>("messages"),
			this.latestWorkflow(),
			this.ctx.storage.get<HarnessAnnotation[]>(ANNOTATIONS_KEY),
			this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY),
		]);
		const messages = storedMessages ?? seededMessages();
		if (!storedMessages) await this.ctx.storage.put("messages", messages);
		server.send(JSON.stringify({ type: "chat:snapshot", messages: messages ?? [] }));
		server.send(JSON.stringify({ type: "workflow:snapshot", workflow: workflow ?? null }));
		server.send(JSON.stringify({ type: "harness:annotations", annotations: annotations ?? [] }));
		server.send(JSON.stringify({ type: "harness:work-items", workItems: workItems ?? [] }));
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
	}

	/** One alarm drains all per-work-item outbox records using expiring leases. */
	async alarm(): Promise<void> {
		try {
			await this.drainCoordinatorOutbox(COORDINATOR_BATCH_SIZE);
		} catch (error) {
			console.error("Coordinator alarm failed", error);
		} finally {
			await this.scheduleCoordinatorAlarm();
		}
	}

	/** Record the final agent response delivered by the persistent OS workspace. */
	async receiveOsWorkspaceResponse(workItemId: string, response: OsWorkspaceResponse): Promise<void> {
		if (!isUuid(workItemId) || !response || typeof response.text !== "string") return;
		const text = response.text.trim().replace(/\s+/gu, " ").slice(0, 500);
		if (!text) return;
		const workItem = await this.getWorkItem(workItemId);
		if (!workItem?.workflowId) return;
		const workflow = await this.getWorkflow(workItem.workflowId);
		const job = await this.ctx.storage.get<CoordinatorJob>(this.jobKey(workItem.workflowId));
		if (!workflow || !job || TERMINAL_PHASES.has(workflow.phase)) return;
		if (workItem.osNativeGit?.workspace?.lastResponse === text) return;
		const delegated = osWorkspaceTurnDisposition(job.stage) === "delegated";
		if (workItem.osNativeGit?.workspace) {
			workItem.osNativeGit.workspace.state = delegated ? "delegated" : "responded-without-execution";
			workItem.osNativeGit.workspace.lastResponse = text;
		}
		const now = Date.now();
		if (!delegated) {
			workflow.phase = "requires_review";
			workItem.osNativeGit!.state = "needs-review";
		}
		workflow.updatedAt = now;
		const status = delegated
			? `Cloudflare OS workspace: ${text}`
			: `Cloudflare OS completed without starting repository execution: ${text}`;
		workflow.activity.push({ phase: workflow.phase, message: status.slice(0, 280), at: now });
		this.transitionWorkItem(workItem, delegated ? workItem.phase : "needs_review", status);
		await this.ctx.storage.transaction(async (txn) => {
			await Promise.all([
				txn.put(this.jobKey(job.id), delegated ? job : { ...job, stage: "terminal", currentEffectId: null, lease: null, updatedAt: now }),
				txn.put(this.workflowKey(workflow.id), workflow),
				txn.put(this.workItemKey(workItem.id), workItem),
			]);
		});
		await Promise.all([this.saveWorkflow(workflow), this.saveWorkItem(workItem)]);
		this.broadcastWorkflow(workflow);
		await this.appendGitHubIssueStatus(workItem, status);
	}

	/**
	 * Called only through OsExecutionBridge after the OS Gatekeeper action has
	 * passed its audit/approval policy. It resumes the deterministic stack
	 * machine using the original durable request, never agent-supplied prose.
	 */
	async enqueueOsRepositoryTask(input: OsExecutionRequest): Promise<{ accepted: boolean; state: string }> {
		if (!input || !isUuid(input.workItemId) || !Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
			throw new Error("Cloudflare OS execution request is invalid.");
		}
		const workItem = await this.getWorkItem(input.workItemId);
		if (!workItem?.workflowId || !workItem.githubIssue) throw new Error("Cloudflare OS execution request lost its durable work item.");
		validateOsExecutionRequest(input, { workItemId: workItem.id, issue: workItem.githubIssue });
		const workflow = await this.getWorkflow(workItem.workflowId);
		const job = await this.ctx.storage.get<CoordinatorJob>(this.jobKey(workItem.workflowId));
		if (!workflow || !job) throw new Error("Cloudflare OS execution request lost its durable workflow.");

		const now = Date.now();
		const effectId = this.effectId(job.id, "observe-main");
		const existingEffect = await this.ctx.storage.get<CoordinatorEffect>(this.outboxKey(effectId));
		const disposition = osExecutionDisposition({ terminal: job.stage === "terminal", existingEffect: Boolean(existingEffect), jobStage: job.stage });
		if (disposition === "terminal") return { accepted: false, state: "terminal" };
		if (disposition === "duplicate") return { accepted: true, state: workItem.osNativeGit?.state ?? job.stage };
		const effect = createCoordinatorEffect({ id: effectId, jobId: job.id, workItemId: workItem.id, kind: "observe-main", now });
		workItem.osNativeGit ??= {
			jobId: `os-${workItem.id}-g1`,
			state: "workspace-delegated",
			runnerUrl: "https://app-harness-os-native-git.coda-a.workers.dev",
			stackId: `stack-${workItem.id}`,
			generation: 1,
		};
		workItem.osNativeGit.state = "workspace-delegated";
		if (workItem.osNativeGit.workspace) workItem.osNativeGit.workspace.state = "delegated";
		workflow.phase = "preparing_candidate";
		workflow.updatedAt = now;
		workflow.activity.push({ phase: "preparing_candidate", message: "Cloudflare OS delegated the approved task to the deterministic stack runner.", at: now });
		this.transitionWorkItem(workItem, "queued", "Cloudflare OS approved the repository task; main observation and native Git execution are queued.");

		await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get<CoordinatorJob>(this.jobKey(job.id));
			if (!current || current.stage === "terminal") throw new Error("Cloudflare OS execution request became stale.");
			const existing = await txn.get<CoordinatorEffect>(this.outboxKey(effectId));
			if (!existing) await txn.put(this.outboxKey(effectId), effect);
			const submissionEffect = current.currentEffectId
				? await txn.get<CoordinatorEffect>(this.outboxKey(current.currentEffectId))
				: undefined;
			if (submissionEffect?.kind === "submit-os-workspace" && submissionEffect.state !== "delivered" && submissionEffect.state !== "failed") {
				await txn.put(this.outboxKey(submissionEffect.id), {
					...submissionEffect,
					state: "delivered",
					leaseToken: null,
					leaseExpiresAt: null,
					updatedAt: now,
				});
			}
			await Promise.all([
				txn.put(this.jobKey(job.id), { ...current, stage: "queued", currentEffectId: effectId, lease: null, updatedAt: now }),
				txn.put(this.workflowKey(workflow.id), workflow),
				txn.put(this.workItemKey(workItem.id), workItem),
			]);
		});
		await Promise.all([this.saveWorkflow(workflow), this.saveWorkItem(workItem)]);
		this.broadcastWorkflow(workflow);
		await this.appendGitHubIssueStatus(workItem, "Cloudflare OS approved the repository task; main observation and native Git execution are queued.");
		await this.ctx.storage.setAlarm(now + 25);
		return { accepted: true, state: "queued" };
	}

	async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
		if (typeof raw !== "string") return;

		let event: ClientEvent;
		try {
			event = JSON.parse(raw) as ClientEvent;
		} catch {
			return;
		}

		if (event.type === "chat:send") {
			await this.sendChat(event);
			return;
		}

		if (event.type === "workflow:request") {
			await this.startWorkflow(socket, event.request, event.target, event.clientSubmissionId);
			return;
		}

		if (event.type === "harness:annotation") {
			await this.addHarnessAnnotation(socket, event.annotation, event.clientSubmissionId);
			return;
		}

		if (event.type === "harness:annotation:delete") {
			await this.deleteHarnessAnnotation(socket, event.annotationId);
			return;
		}

		if (event.type === "harness:annotations:clear") {
			await this.clearHarnessAnnotations();
		}
	}

	webSocketClose(socket: WebSocket, code: number, reason: string): void {
		socket.close(code, reason);
		this.broadcastPresence();
	}

	webSocketError(socket: WebSocket): void {
		socket.close(1011, "WebSocket error");
		this.broadcastPresence();
	}

	private async sendChat(event: Extract<ClientEvent, { type: "chat:send" }>): Promise<void> {
		const text = typeof event.text === "string" ? event.text.trim() : "";
		if (!text || text.length > MAX_MESSAGE_LENGTH) return;

		const message: ChatMessage = {
			id: crypto.randomUUID(),
			author: normalizeAuthor(event.author),
			text,
			createdAt: Date.now(),
		};

		const messages = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
		messages.push(message);
		await this.ctx.storage.put("messages", messages.slice(-MAX_STORED_MESSAGES));
		this.broadcast({ type: "chat:message", message });
	}

	private async addHarnessAnnotation(socket: WebSocket, input: unknown, clientSubmissionId: unknown): Promise<void> {
		const annotation = normalizeAnnotation(input);
		if (!annotation) {
			socket.send(JSON.stringify({ type: "workflow:notice", message: "That comment or drawing could not be saved." }));
			return;
		}

		const now = Date.now();
		const canSubmitComment = annotation.kind === "comment";
		const workItem = this.createWorkItem({
			annotationId: annotation.id,
			clientSubmissionId: normalizeSubmissionId(clientSubmissionId),
			kind: annotation.kind,
			summary: annotation.kind === "comment" ? annotation.text : "Freehand drawing feedback",
			target: annotation.kind === "comment" ? annotation.target : undefined,
			phase: canSubmitComment ? "received" : "needs_review",
			message: annotation.kind === "comment"
				? "Comment received and durably queued for the persistent Cloudflare OS workspace."
				: "Drawing recorded as public context; add a text comment to submit an implementation request.",
			now,
		});
		annotation.workItemId = workItem.id;
		const annotations = (await this.ctx.storage.get<HarnessAnnotation[]>(ANNOTATIONS_KEY)) ?? [];
		annotations.push(annotation);
		const stored = annotations.slice(-MAX_STORED_ANNOTATIONS);
		const workItems = await this.getWorkItems();
		workItems.unshift(workItem);
		await Promise.all([
			this.ctx.storage.put(ANNOTATIONS_KEY, stored),
			this.ctx.storage.put(WORK_ITEMS_KEY, workItems.slice(0, MAX_STORED_WORK_ITEMS)),
		]);
		this.broadcast({ type: "harness:annotations", annotations: stored });
		this.broadcastWorkItems(workItems);

		if (canSubmitComment && annotation.kind === "comment") {
			await this.startWorkflow(socket, annotation.text, annotation.target, workItem.clientSubmissionId, workItem.id);
		} else {
			await this.ensureGitHubIssue(workItem.id, false, "triage");
		}
	}

	private async deleteHarnessAnnotation(socket: WebSocket, annotationId: unknown): Promise<void> {
		if (typeof annotationId !== "string" || !isUuid(annotationId)) {
			socket.send(JSON.stringify({ type: "workflow:notice", message: "That annotation could not be removed." }));
			return;
		}

		const annotations = (await this.ctx.storage.get<HarnessAnnotation[]>(ANNOTATIONS_KEY)) ?? [];
		const stored = annotations.filter((annotation) => annotation.id !== annotationId);
		if (stored.length === annotations.length) return;
		await this.ctx.storage.put(ANNOTATIONS_KEY, stored);
		this.broadcast({ type: "harness:annotation:deleted", annotationId });
		this.broadcast({ type: "harness:annotations", annotations: stored });
	}

	private async clearHarnessAnnotations(): Promise<void> {
		const annotations = (await this.ctx.storage.get<HarnessAnnotation[]>(ANNOTATIONS_KEY)) ?? [];
		if (!annotations.length) return;
		await this.ctx.storage.put(ANNOTATIONS_KEY, []);
		this.broadcast({ type: "harness:annotations:cleared" });
		this.broadcast({ type: "harness:annotations", annotations: [] });
	}

	private async startWorkflow(
		socket: WebSocket,
		input: unknown,
		targetInput: unknown,
		clientSubmissionId?: unknown,
		existingWorkItemId?: string,
	): Promise<void> {
		const request = normalizeRequest(input);
		if (!request) {
			socket.send(JSON.stringify({ type: "workflow:notice", message: "Describe a change in 500 characters or fewer." }));
			return;
		}

		const target = normalizeTarget(targetInput);
		const now = Date.now();
		let workItems = await this.getWorkItems();
		let workItem = existingWorkItemId ? workItems.find((item) => item.id === existingWorkItemId) : undefined;
		const submissionId = normalizeSubmissionId(clientSubmissionId);
		if (!workItem && submissionId) workItem = workItems.find((item) => item.clientSubmissionId === submissionId);
		if (workItem?.workflowId) {
			const existing = await this.getWorkflow(workItem.workflowId);
			if (existing) this.broadcastWorkflow(existing);
			return;
		}
		if (!workItem) {
			workItem = this.createWorkItem({
				clientSubmissionId: submissionId,
				kind: "request",
				summary: request,
				target: target ?? undefined,
				phase: "received",
				message: "Change request received and durably queued.",
				now,
			});
			workItems.unshift(workItem);
			// Issue creation resolves the item from durable storage so an external
			// handoff can never race a newly submitted targeted request.
			await this.saveWorkItems(workItems);
		}

		const targetDescription = describeTarget(target);
		const workflow: WorkflowRecord = {
			id: crypto.randomUUID(),
			workItemId: workItem.id,
			request,
			target: target ?? undefined,
			phase: "interpreting",
			createdAt: now,
			updatedAt: now,
			activity: [
				{ phase: "received", message: `Request received${targetDescription ? ` for ${targetDescription}` : ""} and durably queued.`, at: now },
				{ phase: "interpreting", message: "Creating the public issue before submitting to the persistent Cloudflare OS workspace.", at: now },
			],
		};

		workItem.workflowId = workflow.id;
		this.transitionWorkItem(workItem, "queued", workItem.githubIssue
			? "Cloudflare OS workspace submission is durably queued."
			: "GitHub App issue creation is durably queued before the OS workspace handoff.");
		const firstKind = workItem.githubIssue ? "submit-os-workspace" : "create-issue";
		const firstEffectId = this.effectId(workflow.id, firstKind);
		const job = createCoordinatorJob({ workflowId: workflow.id, workItemId: workItem.id, pipeline: "os-native-git", firstEffectId, now });
		const effect = createCoordinatorEffect({
			id: firstEffectId,
			jobId: job.id,
			workItemId: workItem.id,
			kind: firstKind,
			payload: { handoff: "os-workspace" },
			now,
		});
		await Promise.all([
			this.saveWorkflow(workflow),
			this.saveWorkItem(workItem),
			this.ctx.storage.put(this.jobKey(job.id), job),
			this.ctx.storage.put(this.outboxKey(effect.id), effect),
		]);
		this.broadcastWorkflow(workflow);
		await this.ctx.storage.setAlarm(now + 25);
		await this.drainCoordinatorOutbox(1);
	}

	private workflowKey(id: string): string { return `${WORKFLOW_PREFIX}${id}`; }
	private jobKey(id: string): string { return `${JOB_PREFIX}${id}`; }
	private outboxKey(id: string): string { return `${OUTBOX_PREFIX}${id}`; }
	private ledgerKey(workItemId: string): string { return `${LEDGER_PREFIX}${workItemId}`; }
	private workItemKey(id: string): string { return `${WORK_ITEM_PREFIX}${id}`; }
	private effectId(workflowId: string, kind: string, suffix = "main"): string { return `${workflowId}-${kind}-${suffix}`; }

	private async drainCoordinatorOutbox(limit: number): Promise<void> {
		const effects = [...(await this.ctx.storage.list<CoordinatorEffect>({ prefix: OUTBOX_PREFIX })).values()]
			.filter((effect) => effect.state === "pending" || effect.state === "leased")
			.sort((left, right) => (left.state === "leased" ? left.leaseExpiresAt ?? left.availableAt : left.availableAt) - (right.state === "leased" ? right.leaseExpiresAt ?? right.availableAt : right.availableAt));
		let processed = 0;
		for (const effect of effects) {
			if (processed >= limit) break;
			const dueAt = effect.state === "leased" ? effect.leaseExpiresAt ?? effect.availableAt : effect.availableAt;
			if (dueAt > Date.now()) break;
			if (await this.processCoordinatorEffect(effect.id)) processed += 1;
		}
	}

	private async scheduleCoordinatorAlarm(): Promise<void> {
		const effects = [...(await this.ctx.storage.list<CoordinatorEffect>({ prefix: OUTBOX_PREFIX })).values()]
			.filter((effect) => effect.state === "pending" || effect.state === "leased");
		if (!effects.length) return;
		const next = Math.min(...effects.map((effect) => effect.state === "leased" ? effect.leaseExpiresAt ?? effect.availableAt : effect.availableAt));
		const current = await this.ctx.storage.getAlarm();
		if (current === null || next < current || current <= Date.now()) await this.ctx.storage.setAlarm(Math.max(Date.now() + 25, next));
	}

	private async claimEffect(effectId: string): Promise<{ job: CoordinatorJob; effect: CoordinatorEffect; leaseToken: string } | null> {
		return this.ctx.storage.transaction(async (txn) => {
			const effect = await txn.get<CoordinatorEffect>(this.outboxKey(effectId));
			if (!effect) return null;
			const job = await txn.get<CoordinatorJob>(this.jobKey(effect.jobId));
			if (!job) return null;
			const leaseToken = crypto.randomUUID();
			const leaseMs = effect.kind === "run-os" ? OS_RUNNER_LEASE_MS : COORDINATOR_LEASE_MS;
			const claimed = claimCoordinatorEffect(job, effect, { now: Date.now(), leaseToken, leaseMs });
			if (claimed.disposition === "terminal") {
				await txn.put(this.outboxKey(effect.id), { ...effect, state: "failed", updatedAt: Date.now() });
				return null;
			}
			if (claimed.disposition !== "claimed") return null;
			await Promise.all([
				txn.put(this.jobKey(job.id), claimed.job),
				txn.put(this.outboxKey(effect.id), claimed.effect),
			]);
			return { job: claimed.job as CoordinatorJob, effect: claimed.effect as CoordinatorEffect, leaseToken };
		});
	}

	private async processCoordinatorEffect(effectId: string): Promise<boolean> {
		const claim = await this.claimEffect(effectId);
		if (!claim) return false;
		try {
			switch (claim.effect.kind) {
				case "create-issue": await this.processCreateIssue(claim); break;
				case "submit-os-workspace": await this.processOsWorkspaceSubmission(claim); break;
				case "observe-main": await this.processMainObservation(claim); break;
				case "run-os": await this.processOsRunner(claim); break;
				case "dispatch-promotion": await this.processPromotionDispatch(claim); break;
				case "github-status": await this.processGithubStatus(claim); break;
				case "github-close": await this.processGithubClose(claim); break;
				default: throw new Error(`Unsupported coordinator effect ${claim.effect.kind}.`);
			}
		} catch (error) {
			await this.retryClaim(claim, error);
		}
		return true;
	}

	private async processCreateIssue(claim: { job: CoordinatorJob; effect: CoordinatorEffect; leaseToken: string }): Promise<void> {
		const workflow = await this.getWorkflow(claim.job.id);
		const workItem = await this.getWorkItem(claim.job.workItemId);
		if (!workflow || !workItem) throw new Error("Coordinator issue handoff lost its durable work record.");
		const handoff = "os-workspace";
		if (!workItem.githubIssue) {
			const issue = await this.createGithubIssueHandoff(workItem, false, handoff);
			workItem.githubIssue = { number: issue.issueNumber, url: issue.issueUrl };
		}
		this.transitionWorkItem(workItem, "triaged", `GitHub issue #${workItem.githubIssue.number} created by App Harness. Persistent Cloudflare OS workspace submission is durably queued.`);
		const nextKind = "submit-os-workspace";
		await this.completeClaim(claim, { workflow, workItem, nextKind, nextStage: "queued" });
	}

	private async processOsWorkspaceSubmission(claim: CoordinatorClaim): Promise<void> {
		const workflow = await this.getWorkflow(claim.job.id);
		const workItem = await this.getWorkItem(claim.job.workItemId);
		if (!workflow || !workItem?.githubIssue) throw new Error("Cloudflare OS workspace submission lost its linked issue.");
		if (!this.env.OS_WORKSPACE) throw new Error("Persistent Cloudflare OS workspace binding is unavailable.");
		workItem.osNativeGit ??= {
			jobId: `os-${workItem.id}-g1`,
			state: "workspace-submitting",
			runnerUrl: "https://app-harness-os-native-git.coda-a.workers.dev",
			stackId: `stack-${workItem.id}`,
			generation: 1,
		};
		// Forward the static loopback Service Binding itself. The OS response carries
		// the gateway-owned idempotency key, so this callback never needs a dynamic
		// binding invocation (which would produce a non-serializable RpcPromise).
		const responseTarget = this.ctx.exports.OsWorkspaceResponseTarget;
		const submission = createOsWorkspaceSubmission({
			workItemId: workItem.id,
			issue: workItem.githubIssue,
			request: workflow.request,
			target: workflow.target,
			responseTarget,
		});
		const result = await (this.env.OS_WORKSPACE as OsWorkspaceGateway).submitExternalMessage({
			callerEmail: OS_WORKSPACE_CALLER_EMAIL,
			...submission,
		});
		if (!result.accepted) throw new Error(`Cloudflare OS rejected the workspace message (${result.message.slice(0, 120)}).`);
		workItem.osNativeGit.state = "workspace-accepted";
		workItem.osNativeGit.workspace = { chatPath: result.chatPath, state: "accepted" };
		this.transitionWorkItem(workItem, "triaged", "Persistent Cloudflare OS workspace accepted the request and is deciding how to act.");
		workflow.updatedAt = Date.now();
		workflow.activity.push({ phase: workflow.phase, message: "Persistent Cloudflare OS workspace accepted the idempotent request.", at: workflow.updatedAt });
		if (await this.completeClaim(claim, { workflow, workItem, nextKind: null, nextStage: "awaiting-os" })) {
			await this.appendGitHubIssueStatus(workItem, `Cloudflare OS workspace accepted the request: ${result.chatPath}`);
		}
	}

	private async processMainObservation(claim: { job: CoordinatorJob; effect: CoordinatorEffect; leaseToken: string }): Promise<void> {
		const workflow = await this.getWorkflow(claim.job.id);
		const workItem = await this.getWorkItem(claim.job.workItemId);
		if (!workflow || !workItem?.githubIssue || !workItem.osNativeGit?.workspace) throw new Error("Main observation lost its durable OS workspace authority.");
		const response = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/git/ref/heads/main`, {
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`, "User-Agent": "app-harness-os", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (!response.ok) throw new Error(`GitHub main observation failed (${response.status}).`);
		const body = await response.json() as { object?: { sha?: unknown } };
		if (typeof body.object?.sha !== "string" || !SHA.test(body.object.sha)) throw new Error("GitHub main observation returned no full SHA.");
		const ledger = createStackLedger({
			id: workItem.osNativeGit.stackId,
			repository: this.env.GITHUB_REPOSITORY,
			lane: "room-main",
			issue: workItem.githubIssue,
			baseSha: body.object.sha,
			nodes: [{ id: "root", intent: workflow.request, branchPrefix: `app-harness-os/${workItem.githubIssue.number}` }],
		});
		workItem.osNativeGit.baseSha = body.object.sha.toLowerCase();
		await this.completeClaim(claim, { workflow, workItem, ledger, nextKind: "run-os", nextStage: "queued" });
	}

	private async processOsRunner(claim: { job: CoordinatorJob; effect: CoordinatorEffect; leaseToken: string }): Promise<void> {
		const workflow = await this.getWorkflow(claim.job.id);
		const workItem = await this.getWorkItem(claim.job.workItemId);
		let ledger = await this.ctx.storage.get<StackLedger>(this.ledgerKey(claim.job.workItemId));
		if (!workflow || !workItem?.githubIssue || !workItem.osNativeGit?.workspace || !ledger || !this.env.OS_NATIVE_GIT_RUNNER || !this.env.OS_NATIVE_GIT_RUNNER_SECRET) throw new Error("Native Git runner lost its durable capability state.");
		if (ledger.runner.stage === "running" && ledger.runner.attemptToken) {
			ledger = applyStackEvent(ledger, { type: "runner-attempt-retryable", eventId: `runner-expired-${claim.effect.attempts - 1}`, generation: ledger.generation, attemptToken: ledger.runner.attemptToken }).ledger;
		}
		const started = applyStackEvent(ledger, { type: "runner-attempt-started", eventId: `runner-start-${claim.effect.attempts}`, generation: ledger.generation, nodeId: "root", attemptToken: claim.leaseToken });
		if (started.disposition !== "applied") throw new Error(`Runner lease could not start (${started.reason}).`);
		ledger = started.ledger;
		workItem.osNativeGit.state = "running";
		workItem.osNativeGit.startedAt = Date.now();
		workItem.osNativeGit.attempts = claim.effect.attempts;
		this.transitionWorkItem(workItem, "building", `Cloudflare OS isolated native Git runner started durable attempt ${claim.effect.attempts}.`);
		await Promise.all([this.ctx.storage.put(this.ledgerKey(workItem.id), ledger), this.saveWorkItem(workItem)]);
		const runnerJob = createOsNativeGitJob({
			workItemId: workItem.id,
			issue: workItem.githubIssue,
			request: workflow.request,
			generation: ledger.generation,
			parentBaseSha: ledger.generationBaseSha,
		});
		const response = await this.env.OS_NATIVE_GIT_RUNNER.fetch(new Request("https://runner.internal/v1/native-git/jobs", {
			method: "POST",
			headers: { Authorization: `Bearer ${this.env.OS_NATIVE_GIT_RUNNER_SECRET}`, "Content-Type": "application/json" },
			body: JSON.stringify(runnerJob),
		}));
		let body: unknown = null;
		try { body = await response.json(); } catch { /* classified below */ }
		const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
		const agent = normalizeAgentProvenance(value.agent);
		if (agent) workItem.osNativeGit.agent = agent;
		const outcome = classifyOsRunnerResponse(body);
		if (value.state !== "pull-request-opened" || typeof value.baseSha !== "string" || typeof value.headSha !== "string" || !value.pullRequest || typeof value.pullRequest !== "object") {
			const failed = applyStackEvent(ledger, { type: "runner-attempt-failed", eventId: `runner-failed-${claim.effect.attempts}`, generation: ledger.generation, attemptToken: claim.leaseToken });
			if (failed.disposition === "applied") ledger = failed.ledger;
			await this.terminateClaim(claim, workflow, workItem, "requires_review", outcome.detail, ledger);
			return;
		}
		const pullRequest = value.pullRequest as Record<string, unknown>;
		if (!Number.isInteger(pullRequest.number) || typeof pullRequest.url !== "string") throw new Error("Runner pull request provenance is invalid.");
		const recorded = applyStackEvent(ledger, {
			type: "runner-candidate-recorded",
			eventId: `runner-candidate-${claim.effect.attempts}`,
			generation: ledger.generation,
			nodeId: "root",
			attemptToken: claim.leaseToken,
			parentBranch: "main",
			parentBaseSha: value.baseSha,
			headSha: value.headSha,
			pullRequestNumber: pullRequest.number as number,
			pullRequestUrl: pullRequest.url,
		});
		if (recorded.disposition !== "applied") throw new Error(`Runner candidate reconciliation failed (${recorded.reason}).`);
		ledger = recorded.ledger;
		workItem.osNativeGit.state = "pull-request-opened";
		workItem.osNativeGit.baseSha = value.baseSha;
		workItem.osNativeGit.headSha = value.headSha;
		if (typeof pullRequest.url === "string") workItem.githubPullRequestUrl = pullRequest.url;
		this.transitionWorkItem(workItem, "building", outcome.detail);
		workflow.phase = "validating";
		workflow.updatedAt = Date.now();
		workflow.activity.push({ phase: "validating", message: outcome.detail, at: workflow.updatedAt });
		if (await this.completeClaim(claim, { workflow, workItem, ledger, nextKind: "dispatch-promotion", nextStage: "queued" })) {
			await this.appendGitHubIssueStatus(workItem, outcome.detail);
		}
	}

	private async processPromotionDispatch(claim: { job: CoordinatorJob; effect: CoordinatorEffect; leaseToken: string }): Promise<void> {
		const workflow = await this.getWorkflow(claim.job.id);
		const workItem = await this.getWorkItem(claim.job.workItemId);
		const runner = workItem?.osNativeGit;
		const match = workItem?.githubPullRequestUrl?.match(/\/pull\/(\d+)$/u);
		if (!workflow || !workItem?.githubIssue || !runner || !match || !runner.baseSha || !runner.headSha) throw new Error("Promotion dispatch lost immutable candidate provenance.");
		const response = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/actions/workflows/os-stack-promote.yml/dispatches`, {
			method: "POST",
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`, "Content-Type": "application/json", "User-Agent": "app-harness-os", "X-GitHub-Api-Version": "2022-11-28" },
			body: JSON.stringify({ ref: "main", inputs: { pull_request: match[1], stack_id: runner.stackId, generation: String(runner.generation), issue_number: String(workItem.githubIssue.number), parent_branch: "main", head_sha: runner.headSha, room: "main", workflow_id: workflow.id, ci_profile: "behavior" } }),
		});
		if (!response.ok) throw new Error(`Stack promotion dispatch failed (${response.status}).`);
		if (await this.completeClaim(claim, { workflow, workItem, nextKind: null, nextStage: "awaiting-callback" })) {
			await this.appendGitHubIssueStatus(workItem, `Stack scheduled: ${runner.stackId} generation ${runner.generation}, root parent main, base ${runner.baseSha}. Candidate: ${workItem.githubPullRequestUrl}`);
		}
	}

	private async processGithubStatus(claim: CoordinatorClaim): Promise<void> {
		const workItem = await this.getWorkItem(claim.job.workItemId);
		const issueNumber = claim.effect.payload.issueNumber;
		const body = claim.effect.payload.body;
		if (!workItem || !Number.isInteger(issueNumber) || typeof body !== "string") throw new Error("GitHub status effect is invalid.");
		await createGithubIdentityClient(this.env, { workItemId: workItem.id }).updateStatus({ issueNumber: issueNumber as number, body });
		await this.completeAuxClaim(claim);
	}

	private async processGithubClose(claim: CoordinatorClaim): Promise<void> {
		const workItem = await this.getWorkItem(claim.job.workItemId);
		const issueNumber = claim.effect.payload.issueNumber;
		const body = claim.effect.payload.body;
		const deploymentUrl = claim.effect.payload.deploymentUrl;
		if (!workItem || !Number.isInteger(issueNumber) || typeof body !== "string" || typeof deploymentUrl !== "string" || !/^https:\/\//u.test(deploymentUrl)) throw new Error("GitHub completion effect is invalid.");
		await createGithubIdentityClient(this.env, { workItemId: workItem.id }).closeAfterDeployment({ issueNumber: issueNumber as number, body, deploymentUrl });
		await this.completeAuxClaim(claim);
	}

	private async completeAuxClaim(claim: CoordinatorClaim): Promise<void> {
		await this.ctx.storage.transaction(async (txn) => {
			const job = await txn.get<CoordinatorJob>(this.jobKey(claim.job.id));
			const effect = await txn.get<CoordinatorEffect>(this.outboxKey(claim.effect.id));
			if (!job || !effect) return;
			const completed = completeCoordinatorEffect(job, effect, { leaseToken: claim.leaseToken, now: Date.now(), nextEffectId: null, nextStage: job.stage });
			if (completed.disposition !== "completed") return;
			await Promise.all([txn.put(this.jobKey(job.id), completed.job), txn.put(this.outboxKey(effect.id), completed.effect)]);
		});
	}

	private async completeClaim(
		claim: CoordinatorClaim,
		input: { workflow: WorkflowRecord; workItem: HarnessWorkItem; ledger?: StackLedger; nextKind: string | null; nextStage: string },
	): Promise<boolean> {
		const now = Date.now();
		const nextEffectId = input.nextKind ? this.effectId(claim.job.id, input.nextKind) : null;
		const didComplete = await this.ctx.storage.transaction(async (txn) => {
			const job = await txn.get<CoordinatorJob>(this.jobKey(claim.job.id));
			const effect = await txn.get<CoordinatorEffect>(this.outboxKey(claim.effect.id));
			if (!job || !effect) return false;
			const completed = completeCoordinatorEffect(job, effect, { leaseToken: claim.leaseToken, now, nextEffectId, nextStage: input.nextStage });
			if (completed.disposition !== "completed") return false;
			await Promise.all([
				txn.put(this.jobKey(job.id), completed.job),
				txn.put(this.outboxKey(effect.id), completed.effect),
				txn.put(this.workflowKey(input.workflow.id), input.workflow),
				txn.put(this.workItemKey(input.workItem.id), input.workItem),
				...(input.ledger ? [txn.put(this.ledgerKey(input.workItem.id), input.ledger)] : []),
			]);
			if (input.nextKind && nextEffectId) {
				await txn.put(this.outboxKey(nextEffectId), createCoordinatorEffect({ id: nextEffectId, jobId: job.id, workItemId: input.workItem.id, kind: input.nextKind, now }));
			}
			return true;
		});
		if (!didComplete) return false;
		await Promise.all([this.saveWorkflow(input.workflow), this.saveWorkItem(input.workItem)]);
		this.broadcastWorkflow(input.workflow);
		await this.scheduleCoordinatorAlarm();
		return true;
	}

	private async terminateClaim(claim: CoordinatorClaim, workflow: WorkflowRecord, workItem: HarnessWorkItem, phase: Extract<WorkflowPhase, "requires_review" | "rejected" | "failed">, message: string, ledger?: StackLedger): Promise<void> {
		const now = Date.now();
		workflow.phase = phase;
		workflow.updatedAt = now;
		workflow.result = message.slice(0, 500);
		workflow.activity.push({ phase, message: message.slice(0, 280), at: now });
		this.transitionWorkItem(workItem, workItemPhaseFor(phase), message);
		const blocked = ledger ? blockCoordinatorStack(ledger) : undefined;
		const didComplete = await this.ctx.storage.transaction(async (txn) => {
			const job = await txn.get<CoordinatorJob>(this.jobKey(claim.job.id));
			const effect = await txn.get<CoordinatorEffect>(this.outboxKey(claim.effect.id));
			if (!job || !effect) return false;
			const completed = completeCoordinatorEffect(job, effect, { leaseToken: claim.leaseToken, now, nextEffectId: null, nextStage: "awaiting-callback" });
			if (completed.disposition !== "completed") return false;
			const terminal = applyCoordinatorCallback(completed.job, { callbackKey: `terminal-${phase}`, phase, now });
			await Promise.all([
				txn.put(this.jobKey(job.id), terminal.job),
				txn.put(this.outboxKey(effect.id), completed.effect),
				txn.put(this.workflowKey(workflow.id), workflow),
				txn.put(this.workItemKey(workItem.id), workItem),
				...(blocked ? [txn.put(this.ledgerKey(workItem.id), blocked)] : []),
			]);
			return true;
		});
		if (!didComplete) return;
		await Promise.all([this.saveWorkflow(workflow), this.saveWorkItem(workItem)]);
		this.broadcastWorkflow(workflow);
		await this.appendGitHubIssueStatus(workItem, message);
	}

	private async retryClaim(claim: CoordinatorClaim, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message.slice(0, 180) : "unknown coordinator error";
		const terminal = claim.effect.attempts >= COORDINATOR_MAX_ATTEMPTS;
		const terminalWork = terminal && claim.effect.blocking;
		const now = Date.now();
		let changedWorkItem: HarnessWorkItem | undefined;
		let changedWorkflow: WorkflowRecord | undefined;
		await this.ctx.storage.transaction(async (txn) => {
			const job = await txn.get<CoordinatorJob>(this.jobKey(claim.job.id));
			const effect = await txn.get<CoordinatorEffect>(this.outboxKey(claim.effect.id));
			if (!job || !effect) return;
			const retried = retryCoordinatorEffect(job, effect, { leaseToken: claim.leaseToken, now, availableAt: now + effect.attempts * 5_000, terminal });
			if (retried.disposition === "stale") return;
			const workflow = await txn.get<WorkflowRecord>(this.workflowKey(job.id));
			const workItem = await txn.get<HarnessWorkItem>(this.workItemKey(job.workItemId));
			let ledger = await txn.get<StackLedger>(this.ledgerKey(job.workItemId));
			if (ledger && effect.kind === "run-os" && ledger.runner.stage === "running" && ledger.runner.attemptToken === claim.leaseToken) {
				const event = applyStackEvent(ledger, { type: terminalWork ? "runner-attempt-failed" : "runner-attempt-retryable", eventId: `runner-${terminalWork ? "failed" : "retry"}-${effect.attempts}`, generation: ledger.generation, attemptToken: claim.leaseToken });
				if (event.disposition === "applied") ledger = event.ledger;
			} else if (ledger && terminalWork) ledger = blockCoordinatorStack(ledger);
			if (workflow && workItem) {
				const detail = terminal
					? terminalWork ? `Coordinator effect ${effect.kind} failed after ${effect.attempts} attempts (${message}).` : `GitHub App status effect ${effect.kind} could not be delivered after ${effect.attempts} attempts (${message}); workflow authority is unchanged.`
					: `Coordinator effect ${effect.kind} attempt ${effect.attempts} did not complete (${message}); retry queued.`;
				if (terminalWork) {
					workflow.phase = "failed";
					workflow.result = detail;
				}
				workflow.updatedAt = now;
				workflow.activity.push({ phase: workflow.phase, message: detail.slice(0, 280), at: now });
				this.transitionWorkItem(workItem, terminalWork ? "needs_review" : workItem.phase, detail);
				changedWorkflow = workflow;
				changedWorkItem = workItem;
				await Promise.all([txn.put(this.workflowKey(workflow.id), workflow), txn.put(this.workItemKey(workItem.id), workItem)]);
			}
			await Promise.all([
				txn.put(this.jobKey(job.id), retried.job),
				txn.put(this.outboxKey(effect.id), retried.effect),
				...(ledger ? [txn.put(this.ledgerKey(job.workItemId), ledger)] : []),
			]);
		});
		if (changedWorkflow && changedWorkItem) {
			await Promise.all([this.saveWorkflow(changedWorkflow), this.saveWorkItem(changedWorkItem)]);
			this.broadcastWorkflow(changedWorkflow);
			if (terminalWork && claim.effect.kind !== "github-status" && claim.effect.kind !== "github-close") await this.appendGitHubIssueStatus(changedWorkItem, changedWorkflow.result ?? message);
		}
		await this.scheduleCoordinatorAlarm();
	}

	private async enqueueAuxEffect(workItem: HarnessWorkItem, kind: "github-status" | "github-close", payload: Record<string, unknown>): Promise<void> {
		if (!workItem.workflowId) return;
		const job = await this.ctx.storage.get<CoordinatorJob>(this.jobKey(workItem.workflowId));
		if (!job) return;
		const now = Date.now();
		const effect = createCoordinatorEffect({
			id: this.effectId(job.id, kind, crypto.randomUUID()),
			jobId: job.id,
			workItemId: workItem.id,
			kind,
			payload,
			now,
			blocking: false,
		});
		await this.ctx.storage.put(this.outboxKey(effect.id), effect);
		await this.ctx.storage.setAlarm(now + 25);
	}

	private async applyWorkflowCallback(callback: WorkflowCallback): Promise<void> {
		if (typeof callback.requestId !== "string" || !isUuid(callback.requestId) || typeof callback.phase !== "string" || !PHASES.has(callback.phase as WorkflowPhase) || typeof callback.message !== "string") return;
		const workflow = await this.getWorkflow(callback.requestId);
		if (!workflow?.workItemId) return;
		const workItem = await this.getWorkItem(workflow.workItemId);
		if (!workItem) return;
		let job = await this.ctx.storage.get<CoordinatorJob>(this.jobKey(workflow.id));
		if (!job) {
				const legacy = createCoordinatorJob({ workflowId: workflow.id, workItemId: workItem.id, pipeline: "os-native-git", firstEffectId: this.effectId(workflow.id, "legacy"), now: workflow.createdAt });
			job = { ...legacy, stage: "awaiting-callback", currentEffectId: null, lease: null };
		}
		if (!job) return;

		let phase = callback.phase as WorkflowPhase;
		let message = callback.message.slice(0, 280);
		let ledger = await this.ctx.storage.get<StackLedger>(this.ledgerKey(workItem.id));
		let deploymentUrl = typeof callback.deploymentUrl === "string" && /^https:\/\/[^\s]+$/u.test(callback.deploymentUrl) ? callback.deploymentUrl : undefined;
		const runId = typeof callback.runId === "number" && Number.isSafeInteger(callback.runId) ? String(callback.runId) : typeof callback.runId === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(callback.runId) ? callback.runId : undefined;
		if (phase === "completed" && job.pipeline === "os-native-git") {
			const currentMainSha = typeof callback.currentMainSha === "string" && SHA.test(callback.currentMainSha) ? callback.currentMainSha.toLowerCase() : undefined;
			const headSha = typeof callback.headSha === "string" && SHA.test(callback.headSha) ? callback.headSha.toLowerCase() : undefined;
			const mergeSha = typeof callback.mergeSha === "string" && SHA.test(callback.mergeSha) ? callback.mergeSha.toLowerCase() : undefined;
			if (!ledger || !currentMainSha || !headSha || !mergeSha || !deploymentUrl || !runId) {
				phase = "requires_review";
				message = "Completion callback lacked the immutable merge or deployment provenance required to claim success.";
			} else {
				try {
					ledger = reconcileCompletedStack(ledger, { currentMainSha, headSha, mergeSha, deploymentUrl, runId });
				} catch {
					phase = "requires_review";
					message = "Completion callback did not reconcile with the durable stack ledger; human review is required.";
				}
			}
		}
		if (phase === "completed" && !deploymentUrl) {
			phase = "requires_review";
			message = "Completion callback did not include an HTTPS deployment URL, so deployment success was not claimed.";
		}
		const callbackKey = `callback-${phase}-${runId ?? "legacy"}`;
		const callbackBaseJob = job;
		const applied = applyCoordinatorCallback(job, { callbackKey, phase, now: Date.now() });
		if (applied.disposition !== "applied") return;
		job = applied.job as CoordinatorJob;
		const now = Date.now();
		workflow.phase = phase;
		workflow.updatedAt = now;
		workflow.activity.push({ phase, message, at: now });
		if (typeof callback.result === "string") workflow.result = callback.result.slice(0, 500);
		this.transitionWorkItem(workItem, workItemPhaseFor(phase), message);
		if (typeof callback.result === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/iu.test(callback.result)) workItem.githubPullRequestUrl = callback.result;
		if (TERMINAL_PHASES.has(phase) && phase !== "completed" && ledger) ledger = blockCoordinatorStack(ledger);
		const committed = await this.ctx.storage.transaction(async (txn) => {
			const currentJob = (await txn.get<CoordinatorJob>(this.jobKey(job.id))) ?? callbackBaseJob;
			const current = applyCoordinatorCallback(currentJob, { callbackKey, phase, now });
			if (current.disposition !== "applied") return false;
			await Promise.all([
				txn.put(this.jobKey(job.id), current.job),
				txn.put(this.workflowKey(workflow.id), workflow),
				txn.put(this.workItemKey(workItem.id), workItem),
				...(ledger ? [txn.put(this.ledgerKey(workItem.id), ledger)] : []),
			]);
			return true;
		});
		if (!committed) return;
		await Promise.all([this.saveWorkflow(workflow), this.saveWorkItem(workItem)]);
		this.broadcastWorkflow(workflow);
		if (phase === "completed" && deploymentUrl && workItem.githubIssue) {
			await this.enqueueAuxEffect(workItem, "github-close", { issueNumber: workItem.githubIssue.number, body: formatGithubStatus(workItem, message, deploymentUrl), deploymentUrl });
		} else {
			await this.appendGitHubIssueStatus(workItem, message, typeof callback.result === "string" ? callback.result : undefined);
		}
	}

	private createWorkItem(input: {
		annotationId?: string;
		clientSubmissionId?: string;
		kind: HarnessWorkItem["kind"];
		summary: string;
		target?: TargetEnvelope;
		phase: WorkItemPhase;
		message: string;
		now: number;
	}): HarnessWorkItem {
		return {
			id: crypto.randomUUID(),
			annotationId: input.annotationId,
			clientSubmissionId: input.clientSubmissionId,
			kind: input.kind,
			summary: input.summary,
			target: input.target,
			phase: input.phase,
			activity: [{ phase: input.phase, message: input.message, at: input.now }],
			createdAt: input.now,
			updatedAt: input.now,
		};
	}

	private transitionWorkItem(workItem: HarnessWorkItem, phase: WorkItemPhase, message: string): void {
		const now = Date.now();
		workItem.phase = phase;
		workItem.updatedAt = now;
		workItem.activity.push({ phase, message: message.slice(0, 280), at: now });
	}

	private async getWorkItems(): Promise<HarnessWorkItem[]> {
		const projection = (await this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY)) ?? [];
		const individual = [...(await this.ctx.storage.list<HarnessWorkItem>({ prefix: WORK_ITEM_PREFIX })).values()];
		const merged = new Map(projection.map((item) => [item.id, item]));
		for (const item of individual) merged.set(item.id, item);
		return [...merged.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_STORED_WORK_ITEMS);
	}

	private async saveWorkItems(workItems: HarnessWorkItem[]): Promise<void> {
		const current = (await this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY)) ?? [];
		const merged = new Map(current.map((item) => [item.id, item]));
		for (const item of workItems) merged.set(item.id, item);
		const stored = [...merged.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_STORED_WORK_ITEMS);
		await Promise.all([
			this.ctx.storage.put(WORK_ITEMS_KEY, stored),
			...workItems.map((item) => this.ctx.storage.put(this.workItemKey(item.id), item)),
		]);
		this.broadcastWorkItems(stored);
	}

	private async saveWorkItem(workItem: HarnessWorkItem): Promise<void> {
		await this.saveWorkItems([workItem]);
	}

	private async getWorkItem(id: string): Promise<HarnessWorkItem | undefined> {
		const item = await this.ctx.storage.get<HarnessWorkItem>(this.workItemKey(id));
		if (item) return item;
		const legacy = ((await this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY)) ?? []).find((candidate) => candidate.id === id);
		if (legacy) await this.ctx.storage.put(this.workItemKey(id), legacy);
		return legacy;
	}

	private async getWorkflow(id: string): Promise<WorkflowRecord | undefined> {
		const workflow = await this.ctx.storage.get<WorkflowRecord>(this.workflowKey(id));
		if (workflow) return workflow;
		const legacy = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		if (legacy?.id === id) {
			await this.ctx.storage.put(this.workflowKey(id), legacy);
			return legacy;
		}
		return undefined;
	}

	private async saveWorkflow(workflow: WorkflowRecord): Promise<void> {
		const latest = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		await this.ctx.storage.put(this.workflowKey(workflow.id), workflow);
		if (!latest || workflow.updatedAt >= latest.updatedAt) await this.ctx.storage.put(WORKFLOW_KEY, workflow);
	}

	private async latestWorkflow(): Promise<WorkflowRecord | undefined> {
		const legacy = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		const workflows = [...(await this.ctx.storage.list<WorkflowRecord>({ prefix: WORKFLOW_PREFIX })).values()];
		return [...workflows, ...(legacy ? [legacy] : [])].sort((left, right) => right.updatedAt - left.updatedAt)[0];
	}

	private async migrateLegacyRecords(): Promise<void> {
		const [items, workflow] = await Promise.all([
			this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY),
			this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY),
		]);
		await Promise.all([
			...(items ?? []).map(async (item) => {
				if (!(await this.ctx.storage.get(this.workItemKey(item.id)))) await this.ctx.storage.put(this.workItemKey(item.id), item);
			}),
			...(workflow && !(await this.ctx.storage.get(this.workflowKey(workflow.id))) ? [this.ctx.storage.put(this.workflowKey(workflow.id), workflow)] : []),
		]);
	}

	private async workItemForWorkflow(workflow: WorkflowRecord): Promise<HarnessWorkItem | undefined> {
		if (!workflow.workItemId) return undefined;
		return this.getWorkItem(workflow.workItemId);
	}

	private async backfillExternalHandoffs(): Promise<void> {
		const workItems = await this.getWorkItems();
		for (const workItem of workItems) {
			if (workItem.githubIssue) continue;
			await this.ensureGitHubIssue(
				workItem.id,
				true,
				workItem.kind !== "draw" ? "os-workspace" : "triage",
			);
		}
	}

	/** Reconcile only public terminal labels; GitHub history is never rewritten. */
	private async reconcileClosedGitHubIssues(): Promise<void> {
		const workItems = await this.getWorkItems();
		let changed = false;
		for (const workItem of workItems) {
			if (!workItem.githubIssue || ["completed", "rejected", "needs_review"].includes(workItem.phase)) continue;
			try {
				const response = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/issues/${workItem.githubIssue.number}`, {
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`,
						"User-Agent": "app-harness-autonomy",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});
				if (!response.ok) continue;
				const issue = (await response.json()) as { state?: unknown; labels?: Array<{ name?: unknown }> };
				if (issue.state !== "closed") continue;
				const labels = new Set((issue.labels ?? []).map((label) => label.name).filter((label): label is string => typeof label === "string"));
				if (labels.has("status:completed")) {
					this.transitionWorkItem(workItem, "completed", `GitHub issue #${workItem.githubIssue.number} is closed with completed status.`);
					changed = true;
				} else if (labels.has("status:superseded")) {
					this.transitionWorkItem(workItem, "rejected", `GitHub issue #${workItem.githubIssue.number} is closed as superseded.`);
					changed = true;
				} else if (labels.has("status:needs-review")) {
					this.transitionWorkItem(workItem, "needs_review", `GitHub issue #${workItem.githubIssue.number} is closed pending human review.`);
					changed = true;
				}
			} catch {
				// A transient GitHub read does not change the durable room record.
			}
		}
		if (changed) await this.saveWorkItems(workItems);
	}

	private async ensureGitHubIssue(workItemId: string, backfill: boolean, handoff: "os-workspace" | "triage" = "triage"): Promise<boolean> {
		const workItems = await this.getWorkItems();
		const workItem = workItems.find((item) => item.id === workItemId);
		if (!workItem) return false;
		if (workItem.githubIssue) return true;

		try {
			const issue = await this.createGithubIssueHandoff(workItem, backfill, handoff);
			workItem.githubIssue = { number: issue.issueNumber, url: issue.issueUrl };
			this.transitionWorkItem(
				workItem,
				handoff === "os-workspace" ? "triaged" : "needs_review",
				handoff === "os-workspace"
					? `GitHub issue #${issue.issueNumber} created by App Harness. Persistent Cloudflare OS workspace handoff is next.`
					: `GitHub issue #${issue.issueNumber} created by App Harness — awaiting a text implementation request.`,
			);
			await this.saveWorkItems(workItems);
			return true;
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown handoff error";
			this.transitionWorkItem(workItem, "needs_review", `External GitHub handoff failed (${detail}). The intake is retained in App Harness.`);
			await this.saveWorkItems(workItems);
			return false;
		}
	}

	private async createGithubIssueHandoff(workItem: HarnessWorkItem, backfill: boolean, handoff: "os-workspace" | "triage") {
		const target = workItem.target;
		const targetDetails = target
			? [
				"### Safe target envelope",
				`- Target: \`${target.targetId}\``,
				`- Selector: \`${target.selector}\``,
				`- Element: \`${target.tag}${target.role ? ` (${target.role})` : ""}\``,
				`- Label: ${target.label ?? target.text ?? "—"}`,
				`- Room/page: \`${target.room}${target.page}\``,
			].join("\n")
			: "### Safe target envelope\nNo element target was supplied (freehand drawing feedback).";
		const classification = handoff === "os-workspace"
			? "Queued for the persistent Cloudflare OS repository workspace. The workspace may delegate implementation through its typed App Harness capability; the durable issue and request remain authoritative."
			: "Recorded as public context. A text implementation request is needed before autonomous execution starts.";
		const body = [
			"## App Harness intake",
			`- Work item: \`${workItem.id}\``,
			`- Kind: \`${workItem.kind}\``,
			`- Live room: [open App Harness](${LIVE_APP_URL})`,
			`- Policy classification: ${classification}`,
			backfill ? "- Note: This issue backfills a request submitted before external handoff was enabled." : "",
			"",
			"### Request or feedback",
			workItem.summary,
			"",
			targetDetails,
		].filter(Boolean).join("\n");
		return createGithubIdentityClient(this.env, { workItemId: workItem.id }).createIssue({
			title: `App Harness: ${workItem.summary.slice(0, 90)}`,
			body,
			classification: handoff === "triage" ? "triage" : "agent",
		});
	}

	private async appendGitHubIssueStatus(workItem: HarnessWorkItem, message: string, result?: string): Promise<void> {
		if (!workItem.githubIssue) return;
		await this.enqueueAuxEffect(workItem, "github-status", {
			issueNumber: workItem.githubIssue.number,
			body: formatGithubStatus(workItem, message, result),
		});
	}

	private broadcast(payload: unknown): void {
		const body = JSON.stringify(payload);
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(body);
			} catch {
				// A peer can close between getWebSockets() and send(). The next room
				// snapshot remains authoritative when that client reconnects.
			}
		}
	}

	private broadcastWorkflow(workflow: WorkflowRecord): void {
		this.broadcast({ type: "workflow:update", workflow });
	}

	private broadcastWorkItems(workItems: HarnessWorkItem[]): void {
		this.broadcast({ type: "harness:work-items", workItems: workItems.slice(0, MAX_STORED_WORK_ITEMS) });
	}

	private broadcastPresence(): void {
		this.broadcast({ type: "chat:presence", count: this.ctx.getWebSockets().length });
	}
}

function githubPhaseLabel(phase: WorkItemPhase): string {
	if (phase === "needs_review") return "Needs review";
	return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function formatGithubStatus(workItem: HarnessWorkItem, message: string, result?: string): string {
	const progress = workItem.activity.slice(-6).map((event) => {
		const marker = event.phase === "completed" ? "✅" : event.phase === "rejected" || event.phase === "needs_review" ? "⚠️" : event === workItem.activity.at(-1) ? "▶️" : "✓";
		return `- ${marker} **${githubPhaseLabel(event.phase)}** — ${event.message}`;
	});
	const links = [
		workItem.githubIssue ? `[Issue #${workItem.githubIssue.number}](${workItem.githubIssue.url})` : null,
		workItem.githubPullRequestUrl ? `[Pull request](${workItem.githubPullRequestUrl})` : null,
		result && /^https:\/\//u.test(result) ? `[Latest evidence](${result})` : null,
	].filter((value): value is string => Boolean(value));
	const agent = workItem.osNativeGit?.agent;
	const agentSummary = agent
		? `model \`${agent.model}\` · responses: ${agent.responseIds.map((id) => `\`${id}\``).join(", ") || "none"} · tools: ${agent.tools.map((tool) => `\`${tool}\``).join(", ") || "none"}`
		: "Not reported";
	return [
		"## App Harness · live status",
		`**${githubPhaseLabel(workItem.phase)}** — ${message}`,
		"",
		"| Work | Value |",
		"| --- | --- |",
		`| Work item | \`${workItem.id}\` |`,
		`| Execution | ${workItem.osNativeGit ? `Cloudflare OS · generation ${workItem.osNativeGit.generation}` : "Triage"} |`,
		`| Agent audit | ${agentSummary} |`,
		`| Artifacts | ${links.join(" · ") || "Pending"} |`,
		"",
		"### Progress",
		...progress,
		"",
		`<sub>Updated ${new Date(workItem.updatedAt).toISOString()}. This comment is updated in place by the App Harness GitHub App.</sub>`,
	].join("\n").slice(0, 5_900);
}

function normalizeAuthor(value: unknown): string {
	if (typeof value !== "string") return "Guest";
	const author = value.trim().replace(/\s+/g, " ").slice(0, 32);
	return author || "Guest";
}

function seededMessages(): ChatMessage[] {
	const now = Date.now();
	return [
		{
			id: "seed-welcome",
			author: "Mara",
			text: "I left the first pass in place. What should we refine next?",
			createdAt: now - 1000 * 60 * 18,
		},
		{
			id: "seed-authoring",
			author: "Jon",
			text: "Keep the conversation focused. The authoring layer should appear only when someone calls for it.",
			createdAt: now - 1000 * 60 * 12,
		},
		{
			id: "seed-harness",
			author: "Mara",
			text: "Agreed — the room needs to feel useful before anyone decides to annotate it.",
			createdAt: now - 1000 * 60 * 6,
		},
	];
}

function workItemPhaseFor(phase: WorkflowPhase): WorkItemPhase {
	if (phase === "completed") return "completed";
	if (phase === "rejected") return "rejected";
	if (phase === "requires_review" || phase === "failed") return "needs_review";
	if (phase === "preparing_candidate" || phase === "validating" || phase === "deploying") return "building";
	if (phase === "received") return "received";
	return "triaged";
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeRequest(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const request = value.trim().replace(/\s+/g, " ");
	return request && request.length <= MAX_REQUEST_LENGTH ? request : null;
}

function normalizeSubmissionId(value: unknown): string | undefined {
	return typeof value === "string" && isUuid(value) ? value : undefined;
}

function normalizeTarget(value: unknown): TargetEnvelope | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const targetId = normalizeTargetString(candidate.targetId, 64);
	const tag = normalizeTargetString(candidate.tag, 32)?.toLowerCase();
	const page = normalizePage(candidate.page);
	const rect = normalizeRectangle(candidate.rect);
	if (!targetId || !/^[a-z0-9_-]+$/i.test(targetId) || !tag || !/^[a-z][a-z0-9-]*$/.test(tag) || !page || !rect) return null;

	// The server derives the selector and room rather than trusting either from
	// the browser. This keeps the envelope stable and prevents arbitrary selector
	// or room names from entering the durable request ledger.
	return {
		targetId,
		selector: `[data-target-id="${targetId}"]`,
		tag,
		role: normalizeTargetString(candidate.role, 48),
		label: normalizeTargetString(candidate.label, 120),
		text: normalizeTargetString(candidate.text, 120),
		page,
		room: "main",
		rect,
	};
}

function normalizeTargetString(value: unknown, maximum: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/\s+/g, " ");
	return normalized && normalized.length <= maximum ? normalized : undefined;
}

function normalizePage(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const page = value.trim();
	return /^\/[a-zA-Z0-9/_-]{0,159}$/.test(page) ? page : null;
}

function normalizeRectangle(value: unknown): TargetRectangle | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
	if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 100_000)) return null;
	if ((candidate.width as number) < 0 || (candidate.height as number) < 0) return null;
	return {
		x: Math.round((candidate.x as number) * 100) / 100,
		y: Math.round((candidate.y as number) * 100) / 100,
		width: Math.round((candidate.width as number) * 100) / 100,
		height: Math.round((candidate.height as number) * 100) / 100,
	};
}

function describeTarget(target: TargetEnvelope | null): string | null {
	if (!target) return null;
	return target.label || target.text || target.targetId.replace(/[-_]+/g, " ");
}

function normalizeAnnotation(value: unknown): HarnessAnnotation | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const createdAt = Date.now();

	if (candidate.kind === "comment") {
		const target = normalizeTarget(candidate.target);
		const text = normalizeAnnotationText(candidate.text);
		if (!target || !text) return null;
		return { id: crypto.randomUUID(), kind: "comment", target, text, createdAt };
	}

	if (candidate.kind === "draw") {
		const points = normalizeDrawingPoints(candidate.points);
		const page = normalizePage(candidate.page);
		if (!points || !page) return null;
		return { id: crypto.randomUUID(), kind: "draw", points, page, room: "main", createdAt };
	}

	return null;
}

function normalizeAnnotationText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim().replace(/\s+/g, " ");
	return text && text.length <= MAX_REQUEST_LENGTH ? text : null;
}

function normalizeDrawingPoints(value: unknown): DrawingPoint[] | null {
	if (!Array.isArray(value) || value.length < 2 || value.length > 240) return null;
	const points: DrawingPoint[] = [];
	for (const rawPoint of value) {
		if (!rawPoint || typeof rawPoint !== "object") return null;
		const point = rawPoint as Record<string, unknown>;
		if (
			typeof point.x !== "number" ||
			typeof point.y !== "number" ||
			!Number.isFinite(point.x) ||
			!Number.isFinite(point.y) ||
			Math.abs(point.x) > 100_000 ||
			Math.abs(point.y) > 100_000
		) return null;
		points.push({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 });
	}
	return points;
}

function roomName(pathname: string): string | null {
	const match = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,64})$/);
	return match?.[1]?.toLowerCase() ?? null;
}

async function validCallback(request: Request, secret: string): Promise<{ body: string; valid: boolean }> {
	const body = await request.text();
	return { body, valid: request.headers.get("Authorization") === `Bearer ${secret}` };
}

export default {
	async fetch(request, env): Promise<Response> {
		const runtimeEnv = env as RuntimeEnv;
		const url = new URL(request.url);
		const room = roomName(url.pathname);

		if (request.method === "POST" && url.pathname === "/api/autonomy/callback") {
			const { body, valid } = await validCallback(request, runtimeEnv.AUTONOMY_CALLBACK_SECRET);
			if (!valid) return new Response("Unauthorized", { status: 401 });
			const callback = JSON.parse(body) as WorkflowCallback & { room?: unknown };
			const callbackRoom = typeof callback.room === "string" ? roomName(`/api/rooms/${callback.room}`) : null;
			if (!callbackRoom) return new Response("Invalid room", { status: 400 });
			return runtimeEnv.CHAT_ROOM.getByName(callbackRoom).fetch(
				new Request("https://room.internal/workflow-callback", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(callback),
				}),
			);
		}

		if (room) {
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected a WebSocket upgrade.", { status: 426 });
			}
			return runtimeEnv.CHAT_ROOM.getByName(room).fetch(request);
		}

		return runtimeEnv.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
