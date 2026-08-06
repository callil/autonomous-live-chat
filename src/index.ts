import { DurableObject } from "cloudflare:workers";
import { classifyOsRunnerResponse, createOsNativeGitJob, createOsPlanningManifest } from "./os-provider-bridge.js";

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
		model?: { id: string; model: string };
		classification?: OsModelClassification;
		plan?: { kind: "accent-color"; color: "blue" | "green" | "purple" | "orange" };
		attempts?: number;
		startedAt?: number;
		baseSha?: string;
		headSha?: string;
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
};

type RuntimeEnv = Omit<Env, "OS_NATIVE_GIT_PROVIDER" | "OS_NATIVE_GIT_RUNNER" | "OS_AGENT_ORCHESTRATOR"> & {
	GITHUB_AUTOMATION_TOKEN: string;
	AUTONOMY_CALLBACK_SECRET: string;
	OS_NATIVE_GIT_RUNNER?: Fetcher;
	OS_NATIVE_GIT_RUNNER_SECRET?: string;
	OS_AGENT_ORCHESTRATOR?: Fetcher;
	OS_AGENT_ORCHESTRATOR_SECRET?: string;
	OS_NATIVE_GIT_PROVIDER?: string;
};

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_REQUEST_LENGTH = 500;
const MAX_STORED_MESSAGES = 200;
const MAX_STORED_ANNOTATIONS = 100;
const WORKFLOW_KEY = "workflow";
const ANNOTATIONS_KEY = "harness-annotations";
const WORK_ITEMS_KEY = "harness-work-items";
const MAX_STORED_WORK_ITEMS = 100;
const OS_RUNNER_LEASE_MS = 180_000;
const LIVE_APP_URL = "https://autonomous-live-chat.coda-a.workers.dev/?room=main";
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

type OsAgentPlanResponse = {
	state?: unknown;
	model?: unknown;
	plan?: unknown;
	rationale?: unknown;
	classification?: unknown;
};

type OsModelClassification = {
	changeType: "visual" | "content" | "data" | "behavior" | "infrastructure";
	scope: "localized" | "bounded" | "broad";
	risk: "low" | "medium" | "high";
	affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure";
	reversible: boolean;
	executionEligibility: "eligible" | "needs_review";
	ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure";
};

function acceptedOsAgentPlan(value: unknown): { model: { id: string; model: string }; plan: { kind: "accent-color"; color: "blue" | "green" | "purple" | "orange" }; rationale: string; classification: OsModelClassification } | null {
	if (!value || typeof value !== "object") return null;
	const response = value as OsAgentPlanResponse;
	if (response.state !== "planned" || !response.model || typeof response.model !== "object" || !response.plan || typeof response.plan !== "object" || typeof response.rationale !== "string") return null;
	const model = response.model as Record<string, unknown>;
	const plan = response.plan as Record<string, unknown>;
	const change = plan.change;
	const classification = response.classification as Record<string, unknown> | null;
	if (!change || typeof change !== "object") return null;
	const candidate = change as Record<string, unknown>;
	if (!classification || typeof model.id !== "string" || typeof model.model !== "string" || candidate.kind !== "accent-color" || !["blue", "green", "purple", "orange"].includes(candidate.color as string) || !["visual", "content", "data", "behavior", "infrastructure"].includes(classification.changeType as string) || !["localized", "bounded", "broad"].includes(classification.scope as string) || !["low", "medium", "high"].includes(classification.risk as string) || !["ui", "copy", "data", "behavior", "infrastructure"].includes(classification.affectedSurface as string) || typeof classification.reversible !== "boolean" || classification.executionEligibility !== "eligible" || !["visual", "content", "behavior", "data", "infrastructure"].includes(classification.ciProfile as string)) return null;
	return {
		model: { id: model.id, model: model.model },
		plan: { kind: "accent-color", color: candidate.color as "blue" | "green" | "purple" | "orange" },
		rationale: response.rationale.slice(0, 240),
		classification: classification as unknown as OsModelClassification,
	};
}

/** Return only the planner's bounded public state; never surface prompts, headers, or provider output. */
function osPlannerFailureDetail(status: number, value: unknown): string {
	const body = value && typeof value === "object" ? value as Record<string, unknown> : null;
	const state = typeof body?.state === "string" && /^[a-z-]{1,48}$/u.test(body.state) ? body.state : "unknown";
	const classification = typeof body?.classification === "string" && /^[a-z-]{1,64}$/u.test(body.classification) ? body.classification : null;
	if (status === 401 || status === 404) return "Cloudflare OS planner authentication to its private service failed. No model or native Git action was attempted.";
	if (state === "needs-review") return "Cloudflare OS model reviewed this request and did not approve the bounded candidate plan. No native Git action was attempted.";
	return `Cloudflare OS planner did not produce an approved bounded plan (${classification ?? state}). No native Git action was attempted.`;
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

		await this.backfillExternalHandoffs();
		await this.reconcileClosedGitHubIssues();
		await this.schedulePendingOsRunner();
		const [storedMessages, workflow, annotations, workItems] = await Promise.all([
			this.ctx.storage.get<ChatMessage[]>("messages"),
			this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY),
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

	/** Alarms make the external runner handoff durable instead of tying it to a WebSocket event. */
	async alarm(): Promise<void> {
		await this.resumeOsNativeGitRunner();
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
		const osProviderEnabled = this.env.OS_NATIVE_GIT_PROVIDER === "enabled";
		const approvedComment = annotation.kind === "comment" && isPolicyApprovedFallbackRequest(annotation.text);
		const canPlanComment = annotation.kind === "comment" && (osProviderEnabled || approvedComment);
		const workItem = this.createWorkItem({
			annotationId: annotation.id,
			clientSubmissionId: normalizeSubmissionId(clientSubmissionId),
			kind: annotation.kind,
			summary: annotation.kind === "comment" ? annotation.text : "Freehand drawing feedback",
			target: annotation.kind === "comment" ? annotation.target : undefined,
			phase: canPlanComment ? "received" : "needs_review",
			message: osProviderEnabled && annotation.kind === "comment"
				? "Comment received. Cloudflare OS bounded planning will decide whether it can become a candidate."
				: approvedComment
					? "Comment received. It matches the guarded fallback policy and is being queued."
				: annotation.kind === "comment"
					? "Comment recorded and awaiting agent triage. Arbitrary comments do not build themselves yet."
					: "Drawing recorded and awaiting agent triage.",
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

		const issueCreated = await this.ensureGitHubIssue(workItem.id, approvedComment, false, canPlanComment && osProviderEnabled ? "os-planning" : approvedComment ? "fallback" : "triage");
		if (canPlanComment && annotation.kind === "comment") {
			if (issueCreated) await this.startWorkflow(socket, annotation.text, annotation.target, workItem.clientSubmissionId, workItem.id);
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
		if (!workItem) {
			workItem = this.createWorkItem({
				clientSubmissionId: normalizeSubmissionId(clientSubmissionId),
				kind: "request",
				summary: request,
				target: target ?? undefined,
				phase: "received",
				message: "Change request received and checking the guarded policy.",
				now,
			});
			workItems.unshift(workItem);
			// Issue creation resolves the item from durable storage so an external
			// handoff can never race a newly submitted targeted request.
			await this.saveWorkItems(workItems);
		}

		const policyApproved = isPolicyApprovedFallbackRequest(request);
		const osProviderEnabled = this.env.OS_NATIVE_GIT_PROVIDER === "enabled";
		const workItemId = workItem.id;
		const issueCreated = await this.ensureGitHubIssue(workItemId, policyApproved, false, osProviderEnabled ? "os-planning" : policyApproved ? "fallback" : "triage");
		if (!issueCreated) return;
		workItems = await this.getWorkItems();
		workItem = workItems.find((item) => item.id === workItemId) ?? workItem;
		if (!osProviderEnabled && !policyApproved) {
			this.transitionWorkItem(
				workItem,
				"needs_review",
				`GitHub issue #${workItem.githubIssue?.number ?? "?"} created — awaiting coding-agent triage. NanoCodex is not configured.`,
			);
			await this.saveWorkItems(workItems);
			return;
		}

		const active = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		if (active && !TERMINAL_PHASES.has(active.phase)) {
			this.transitionWorkItem(workItem, "needs_review", "An autonomous candidate run is already active. This request is recorded for human triage.");
			await this.saveWorkItems(workItems);
			socket.send(JSON.stringify({ type: "workflow:notice", message: "This room already has a change request in progress." }));
			return;
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
				{ phase: "interpreting", message: osProviderEnabled ? "Sending the bounded request to Cloudflare OS planning." : "Checking the request against the autonomous change policy.", at: now },
			],
		};

		workItem.workflowId = workflow.id;
		this.transitionWorkItem(workItem, "queued", osProviderEnabled ? "GitHub issue created. Cloudflare OS planning is starting." : "GitHub issue created. Candidate execution is being selected by policy.");
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		this.broadcastWorkflow(workflow);

		try {
			if (this.env.OS_NATIVE_GIT_PROVIDER === "enabled") {
				await this.dispatchOsNativeGitJob(workflow);
				return;
			}
			this.transitionWorkItem(workItem, "queued", "Guarded fallback workflow dispatched; no model-driven agent is involved.");
			await this.saveWorkItems(workItems);
			await this.dispatchAutonomousRun(workflow);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown dispatch error";
			console.error("Autonomy dispatch failed", detail);
			await this.failWorkflow(workflow, `Could not dispatch the guarded candidate run (${detail}). No source or production change was made.`);
		}
	}

	/**
	 * The OS provider has two deliberately separate boundaries. The planning
	 * agent sees a bounded manifest (including the request); the native-Git
	 * runner receives only its schema-validated plan, never user prose or a
	 * model response. Both sides are capability-scoped service bindings.
	 */
	private async dispatchOsNativeGitJob(workflow: WorkflowRecord): Promise<void> {
		const workItems = await this.getWorkItems();
		const workItem = workflow.workItemId ? workItems.find((item) => item.id === workflow.workItemId) : undefined;
		if (!workItem?.githubIssue) {
			await this.failWorkflow(workflow, "Cloudflare OS job is blocked because the linked GitHub issue is missing.");
			return;
		}
		const manifest = createOsPlanningManifest({
			workItemId: workItem.id,
			issueUrl: workItem.githubIssue.url,
			request: workflow.request,
			target: workflow.target,
			room: "main",
		});
		workItem.osNativeGit = {
			jobId: `os-${workItem.id}-g${manifest.stack.generation}`,
			state: "planning",
			runnerUrl: manifest.runnerUrl,
			stackId: manifest.stack.id,
			generation: manifest.stack.generation,
		};
		if (!this.env.OS_AGENT_ORCHESTRATOR || !this.env.OS_AGENT_ORCHESTRATOR_SECRET || !this.env.OS_NATIVE_GIT_RUNNER || !this.env.OS_NATIVE_GIT_RUNNER_SECRET) {
			workItem.osNativeGit.state = "blocked";
			this.transitionWorkItem(workItem, "needs_review", "Cloudflare OS provider is enabled but its private planning or runner binding is not configured. No model or native Git action was attempted.");
			await this.saveWorkItems(workItems);
			return;
		}

		const planningResponse = await this.env.OS_AGENT_ORCHESTRATOR.fetch(new Request("https://os-agent.internal/v1/plans", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.env.OS_AGENT_ORCHESTRATOR_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(manifest),
		}));
		let planningBody: unknown = null;
		try { planningBody = await planningResponse.json(); } catch { /* handled as blocked below */ }
		const agentPlan = acceptedOsAgentPlan(planningBody);
		if (!agentPlan) {
			workItem.osNativeGit.state = typeof planningBody === "object" && planningBody && "state" in planningBody && typeof (planningBody as { state?: unknown }).state === "string" ? (planningBody as { state: string }).state : "unknown";
			const detail = osPlannerFailureDetail(planningResponse.status, planningBody);
			this.transitionWorkItem(workItem, "needs_review", detail);
			workflow.phase = "requires_review";
			workflow.updatedAt = Date.now();
			workflow.activity.push({ phase: workflow.phase, message: detail, at: workflow.updatedAt });
			await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
			await this.appendGitHubIssueStatus(workItem, detail);
			this.broadcastWorkflow(workflow);
			return;
		}
		workItem.osNativeGit.state = "planned";
		workItem.osNativeGit.model = agentPlan.model;
		workItem.osNativeGit.plan = agentPlan.plan;
		workItem.osNativeGit.classification = agentPlan.classification;
		await this.applyOsClassificationLabels(workItem, agentPlan.classification);
		this.transitionWorkItem(workItem, "queued", `Cloudflare OS model ${agentPlan.model.model} produced a bounded candidate plan; native Git is queued durably.`);
		workflow.phase = "preparing_candidate";
		workflow.updatedAt = Date.now();
		workflow.activity.push({ phase: "preparing_candidate", message: `Cloudflare OS model plan recorded (${agentPlan.rationale}).`, at: Date.now() });
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		await this.appendGitHubIssueStatus(workItem, `Cloudflare OS model plan recorded (${agentPlan.model.model}, ${agentPlan.model.id}); native Git is queued durably.`);
		await this.ctx.storage.setAlarm(Date.now() + 50);
		this.broadcastWorkflow(workflow);
	}

	private async schedulePendingOsRunner(): Promise<void> {
		const workflow = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		if (!workflow || TERMINAL_PHASES.has(workflow.phase)) return;
		const workItem = await this.workItemForWorkflow(workflow);
		if (!workItem?.osNativeGit?.plan) return;
		const runner = workItem.osNativeGit;
		if (runner.state === "planned" || (runner.state === "running" && (!runner.startedAt || Date.now() - runner.startedAt > OS_RUNNER_LEASE_MS))) await this.ctx.storage.setAlarm(Date.now() + 50);
	}

	private async resumeOsNativeGitRunner(): Promise<void> {
		const workflow = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		if (!workflow || TERMINAL_PHASES.has(workflow.phase)) return;
		const workItems = await this.getWorkItems();
		const workItem = workflow.workItemId ? workItems.find((item) => item.id === workflow.workItemId) : undefined;
		if (!workItem?.githubIssue || !workItem.osNativeGit?.plan) return;
		if (workItem.osNativeGit.state === "running" && workItem.osNativeGit.startedAt && Date.now() - workItem.osNativeGit.startedAt <= OS_RUNNER_LEASE_MS) {
			await this.ctx.storage.setAlarm(workItem.osNativeGit.startedAt + OS_RUNNER_LEASE_MS + 50);
			return;
		}
		if (!["planned", "running"].includes(workItem.osNativeGit.state)) return;
		if (!this.env.OS_NATIVE_GIT_RUNNER || !this.env.OS_NATIVE_GIT_RUNNER_SECRET) {
			workItem.osNativeGit.state = "blocked";
			this.transitionWorkItem(workItem, "needs_review", "Cloudflare OS runner binding is unavailable. The model plan is retained; no native Git action was attempted.");
			workflow.phase = "requires_review";
			await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
			return;
		}
		const manifest = createOsPlanningManifest({ workItemId: workItem.id, issueUrl: workItem.githubIssue.url, request: workflow.request, target: workflow.target, room: "main", generation: workItem.osNativeGit.generation });
		const job = createOsNativeGitJob({ manifest, plan: workItem.osNativeGit.plan });
		workItem.osNativeGit.state = "running";
		workItem.osNativeGit.startedAt = Date.now();
		workItem.osNativeGit.attempts = (workItem.osNativeGit.attempts ?? 0) + 1;
		this.transitionWorkItem(workItem, "building", "Cloudflare OS isolated native Git runner started the durable candidate job.");
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		// Schedule the watchdog before awaiting a cross-Worker call. If the
		// invocation is interrupted after this durable write, the lease expires
		// into a resumable planned job instead of becoming a zombie "running" job.
		await this.ctx.storage.setAlarm(workItem.osNativeGit.startedAt + OS_RUNNER_LEASE_MS + 50);

		let response: Response;
		try {
			response = await this.env.OS_NATIVE_GIT_RUNNER.fetch(new Request("https://runner.internal/v1/native-git/jobs", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.env.OS_NATIVE_GIT_RUNNER_SECRET}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(job),
			}));
		} catch {
			const attempts = workItem.osNativeGit.attempts ?? 1;
			if (attempts >= 3) {
				workItem.osNativeGit.state = "blocked";
				this.transitionWorkItem(workItem, "needs_review", "Cloudflare OS runner did not return after three durable attempts. The model plan is retained; no pull request or deployment is claimed.");
				workflow.phase = "requires_review";
			} else {
				workItem.osNativeGit.state = "planned";
				workItem.osNativeGit.startedAt = undefined;
				this.transitionWorkItem(workItem, "queued", `Cloudflare OS runner attempt ${attempts} did not return. The durable job will retry.`);
				workflow.phase = "preparing_candidate";
				await this.ctx.storage.setAlarm(Date.now() + attempts * 5_000);
			}
			workflow.updatedAt = Date.now();
			await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
			this.broadcastWorkflow(workflow);
			return;
		}
		let body: unknown = null;
		try { body = await response.json(); } catch { /* handled as unrecognized below */ }
		const outcome = classifyOsRunnerResponse(body);
		workItem.osNativeGit.state = typeof body === "object" && body && "state" in body && typeof body.state === "string" ? body.state : "unknown";
		if (typeof body === "object" && body && "baseSha" in body && typeof (body as { baseSha?: unknown }).baseSha === "string") workItem.osNativeGit.baseSha = (body as { baseSha: string }).baseSha;
		if (typeof body === "object" && body && "headSha" in body && typeof (body as { headSha?: unknown }).headSha === "string") workItem.osNativeGit.headSha = (body as { headSha: string }).headSha;
		if (typeof body === "object" && body && "pullRequest" in body) {
			const pullRequest = (body as { pullRequest?: unknown }).pullRequest;
			if (pullRequest && typeof pullRequest === "object" && typeof (pullRequest as { url?: unknown }).url === "string") workItem.githubPullRequestUrl = (pullRequest as { url: string }).url;
		}
		this.transitionWorkItem(workItem, outcome.phase, outcome.detail);
		workflow.phase = outcome.terminal ? "requires_review" : workItem.githubPullRequestUrl ? "validating" : "preparing_candidate";
		workflow.updatedAt = Date.now();
		workflow.activity.push({ phase: workflow.phase, message: outcome.detail, at: workflow.updatedAt });
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		await this.appendGitHubIssueStatus(workItem, outcome.detail);
		if (workItem.githubPullRequestUrl && workItem.osNativeGit.baseSha && workItem.osNativeGit.headSha) await this.dispatchOsStackPromotion(workflow, workItem);
		this.broadcastWorkflow(workflow);
	}

	private async dispatchOsStackPromotion(workflow: WorkflowRecord, workItem: HarnessWorkItem): Promise<void> {
		const runner = workItem.osNativeGit;
		const match = workItem.githubPullRequestUrl?.match(/\/pull\/(\d+)$/u);
		if (!runner || !match || !workItem.githubIssue || !runner.baseSha || !runner.headSha) return;
		const response = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/actions/workflows/os-stack-promote.yml/dispatches`, {
			method: "POST",
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`, "Content-Type": "application/json", "User-Agent": "app-harness-os", "X-GitHub-Api-Version": "2022-11-28" },
			body: JSON.stringify({ ref: "main", inputs: { pull_request: match[1], stack_id: runner.stackId, generation: String(runner.generation), issue_number: String(workItem.githubIssue.number), parent_branch: "main", head_sha: runner.headSha, room: "main", workflow_id: workflow.id, ci_profile: runner.classification?.ciProfile ?? "unsupported" } }),
		});
		if (!response.ok) {
			this.transitionWorkItem(workItem, "needs_review", "Native candidate pull request exists, but the stack promotion gate could not be dispatched. No merge or deployment was attempted.");
			workflow.phase = "requires_review";
			await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(await this.getWorkItems())]);
			await this.appendGitHubIssueStatus(workItem, "Stack promotion dispatch failed after the native candidate PR opened; no merge or deployment was attempted.");
			return;
		}
		await this.appendGitHubIssueStatus(workItem, `Stack scheduled: ${runner.stackId} generation ${runner.generation}, root parent main, base ${runner.baseSha}. Candidate: ${workItem.githubPullRequestUrl}`);
	}

	private async applyOsClassificationLabels(workItem: HarnessWorkItem, classification: OsModelClassification): Promise<void> {
		if (!workItem.githubIssue) return;
		const labels = [
			`change-${classification.changeType}`,
			`scope-${classification.scope}`,
			`risk-${classification.risk}`,
			`surface-${classification.affectedSurface}`,
			classification.reversible ? "reversible-yes" : "reversible-no",
			`execution-${classification.executionEligibility}`,
			`ci-${classification.ciProfile}`,
		];
		try {
			await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/issues/${workItem.githubIssue.number}/labels`, {
				method: "POST",
				headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`, "Content-Type": "application/json", "User-Agent": "app-harness-os", "X-GitHub-Api-Version": "2022-11-28" },
				body: JSON.stringify({ labels }),
			});
		} catch { /* labels improve discoverability but never alter execution authority */ }
	}

	private async dispatchAutonomousRun(workflow: WorkflowRecord): Promise<void> {
		const response = await fetch(
			`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/actions/workflows/autonomous-change.yml/dispatches`,
			{
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`,
					"Content-Type": "application/json",
					"User-Agent": "app-harness-autonomy",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				body: JSON.stringify({
					ref: "main",
					inputs: {
						request_id: workflow.id,
						request: workflow.request,
						room: "main",
						issue_number: String((await this.workItemForWorkflow(workflow))?.githubIssue?.number ?? ""),
					},
				}),
			},
		);

		if (!response.ok) throw new Error(`GitHub dispatch failed (${response.status})`);
	}

	private async applyWorkflowCallback(callback: WorkflowCallback): Promise<void> {
		if (
			typeof callback.requestId !== "string" ||
			typeof callback.phase !== "string" ||
			!PHASES.has(callback.phase as WorkflowPhase) ||
			typeof callback.message !== "string"
		) {
			return;
		}

		const workflow = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		// A verified promotion may finish after a temporary promotion callback
		// recorded needs-review. A trusted completion callback can reconcile that
		// specific recoverable state; every other terminal state stays immutable.
		const recoverableCompletion = workflow?.phase === "requires_review" && callback.phase === "completed";
		if (!workflow || workflow.id !== callback.requestId || (TERMINAL_PHASES.has(workflow.phase) && !recoverableCompletion)) return;

		const phase = callback.phase as WorkflowPhase;
		const now = Date.now();
		workflow.phase = phase;
		workflow.updatedAt = now;
		workflow.activity.push({ phase, message: callback.message.slice(0, 280), at: now });
		if (typeof callback.result === "string") workflow.result = callback.result.slice(0, 500);
		const workItems = await this.getWorkItems();
		const workItem = workflow.workItemId ? workItems.find((item) => item.id === workflow.workItemId) : undefined;
		if (workItem) {
			this.transitionWorkItem(workItem, workItemPhaseFor(workflow.phase), callback.message.slice(0, 280));
			if (typeof callback.result === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i.test(callback.result)) {
				workItem.githubPullRequestUrl = callback.result;
			}
		}
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		if (workItem) await this.appendGitHubIssueStatus(workItem, callback.message.slice(0, 280), typeof callback.result === "string" ? callback.result : undefined);
		this.broadcastWorkflow(workflow);
	}

	private async failWorkflow(workflow: WorkflowRecord, message: string): Promise<void> {
		workflow.phase = "failed";
		workflow.updatedAt = Date.now();
		workflow.result = message;
		workflow.activity.push({ phase: "failed", message, at: workflow.updatedAt });
		const workItems = await this.getWorkItems();
		const workItem = workflow.workItemId ? workItems.find((item) => item.id === workflow.workItemId) : undefined;
		if (workItem) this.transitionWorkItem(workItem, "needs_review", message);
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		if (workItem) await this.appendGitHubIssueStatus(workItem, message);
		this.broadcastWorkflow(workflow);
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
		return (await this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY)) ?? [];
	}

	private async saveWorkItems(workItems: HarnessWorkItem[]): Promise<void> {
		const stored = workItems.slice(0, MAX_STORED_WORK_ITEMS);
		await this.ctx.storage.put(WORK_ITEMS_KEY, stored);
		this.broadcastWorkItems(stored);
	}

	private async workItemForWorkflow(workflow: WorkflowRecord): Promise<HarnessWorkItem | undefined> {
		if (!workflow.workItemId) return undefined;
		return (await this.getWorkItems()).find((item) => item.id === workflow.workItemId);
	}

	private async backfillExternalHandoffs(): Promise<void> {
		const workItems = await this.getWorkItems();
		for (const workItem of workItems) {
			if (workItem.githubIssue) continue;
			await this.ensureGitHubIssue(
				workItem.id,
				workItem.kind !== "draw" && isPolicyApprovedFallbackRequest(workItem.summary),
				true,
				this.env.OS_NATIVE_GIT_PROVIDER === "enabled" && workItem.kind !== "draw" ? "os-planning" : workItem.kind !== "draw" && isPolicyApprovedFallbackRequest(workItem.summary) ? "fallback" : "triage",
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

	private async ensureGitHubIssue(workItemId: string, policyApproved: boolean, backfill: boolean, handoff: "os-planning" | "fallback" | "triage" = policyApproved ? "fallback" : "triage"): Promise<boolean> {
		const workItems = await this.getWorkItems();
		const workItem = workItems.find((item) => item.id === workItemId);
		if (!workItem) return false;
		if (workItem.githubIssue) return true;

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
		const classification = handoff === "os-planning"
			? "Queued for Cloudflare OS bounded planning. A model may approve only the explicitly allowlisted candidate shape; no native Git action exists until an approved plan is recorded."
			: handoff === "fallback"
				? "Eligible for the deterministic guarded fallback. This is not a model-driven coding-agent run."
				: "Recorded as intake awaiting coding-agent triage. No candidate or model run has started.";
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
		try {
			const response = await fetch(`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/issues`, {
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`,
					"Content-Type": "application/json",
					"User-Agent": "app-harness-autonomy",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				body: JSON.stringify({
					title: `App Harness: ${workItem.summary.slice(0, 90)}`,
					body,
					labels: ["app-harness", handoff === "os-planning" ? "cloudflare-os-planning" : handoff === "fallback" ? "guarded-fallback" : "awaiting-coding-agent-triage"],
				}),
			});
			if (!response.ok) throw new Error(`GitHub issue creation failed (${response.status})`);
			const issue = (await response.json()) as { number?: unknown; html_url?: unknown };
			if (typeof issue.number !== "number" || typeof issue.html_url !== "string") throw new Error("GitHub returned an invalid issue response");
			workItem.githubIssue = { number: issue.number, url: issue.html_url };
			this.transitionWorkItem(
				workItem,
				handoff === "os-planning" || policyApproved ? "triaged" : "needs_review",
				handoff === "os-planning"
					? `GitHub issue #${issue.number} created. Cloudflare OS bounded planning is next.`
					: policyApproved
						? `GitHub issue #${issue.number} created. The deterministic fallback may now start.`
						: `GitHub issue #${issue.number} created — awaiting coding-agent triage.`,
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

	private async appendGitHubIssueStatus(workItem: HarnessWorkItem, message: string, result?: string): Promise<void> {
		if (!workItem.githubIssue) return;
		const details = result ? `\n\nResult: ${result}` : "";
		try {
			await fetch(
				`https://api.github.com/repos/${this.env.GITHUB_REPOSITORY}/issues/${workItem.githubIssue.number}/comments`,
				{
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${this.env.GITHUB_AUTOMATION_TOKEN}`,
						"Content-Type": "application/json",
						"User-Agent": "app-harness-autonomy",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					body: JSON.stringify({ body: `App Harness status: ${message}${details}` }),
				},
			);
		} catch (error) {
			console.error("GitHub issue status update failed", error);
		}
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

function isPolicyApprovedFallbackRequest(request: string): boolean {
	if (/^(?:set|change) (?:the )?accent(?: color)? to (blue|green|purple|orange)[.!]?$/i.test(request)) return true;
	const emptyMatch = request.match(/^set (?:the )?empty(?: |-)?state(?: message)? to ["“]?(.+?)["”]?[.!]?$/i);
	return Boolean(emptyMatch && /^[A-Za-z0-9 ,.!?'’:-]{1,80}$/.test(emptyMatch[1].trim()));
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
			const { body, valid } = await validCallback(request, runtimeEnv.GITHUB_AUTOMATION_TOKEN);
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
