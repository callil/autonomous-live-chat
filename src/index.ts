import { DurableObject } from "cloudflare:workers";

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

type RuntimeEnv = Env & {
	GITHUB_AUTOMATION_TOKEN: string;
	AUTONOMY_CALLBACK_SECRET: string;
};

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_REQUEST_LENGTH = 500;
const MAX_STORED_MESSAGES = 200;
const MAX_STORED_ANNOTATIONS = 100;
const WORKFLOW_KEY = "workflow";
const ANNOTATIONS_KEY = "harness-annotations";
const WORK_ITEMS_KEY = "harness-work-items";
const MAX_STORED_WORK_ITEMS = 100;
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

		const [messages, workflow, annotations, workItems] = await Promise.all([
			this.ctx.storage.get<ChatMessage[]>("messages"),
			this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY),
			this.ctx.storage.get<HarnessAnnotation[]>(ANNOTATIONS_KEY),
			this.ctx.storage.get<HarnessWorkItem[]>(WORK_ITEMS_KEY),
		]);
		server.send(JSON.stringify({ type: "chat:snapshot", messages: messages ?? [] }));
		server.send(JSON.stringify({ type: "workflow:snapshot", workflow: workflow ?? null }));
		server.send(JSON.stringify({ type: "harness:annotations", annotations: annotations ?? [] }));
		server.send(JSON.stringify({ type: "harness:work-items", workItems: workItems ?? [] }));
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
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
		const approvedComment = annotation.kind === "comment" && isPolicyApprovedFallbackRequest(annotation.text);
		const workItem = this.createWorkItem({
			annotationId: annotation.id,
			clientSubmissionId: normalizeSubmissionId(clientSubmissionId),
			kind: annotation.kind,
			summary: annotation.kind === "comment" ? annotation.text : "Freehand drawing feedback",
			target: annotation.kind === "comment" ? annotation.target : undefined,
			phase: approvedComment ? "received" : "needs_review",
			message: approvedComment
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

		if (approvedComment && annotation.kind === "comment") {
			await this.startWorkflow(socket, annotation.text, annotation.target, workItem.clientSubmissionId, workItem.id);
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
		}

		const active = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		if (active && !TERMINAL_PHASES.has(active.phase)) {
			this.transitionWorkItem(workItem, "needs_review", "A guarded run is already active. This request is recorded for human triage.");
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
				{ phase: "interpreting", message: "Checking the request against the autonomous change policy.", at: now },
			],
		};

		workItem.workflowId = workflow.id;
		this.transitionWorkItem(workItem, "queued", "Queued for the guarded candidate workflow.");
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
		this.broadcastWorkflow(workflow);

		try {
			await this.dispatchAutonomousRun(workflow);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown dispatch error";
			console.error("Autonomy dispatch failed", detail);
			await this.failWorkflow(workflow, `Could not dispatch the guarded candidate run (${detail}). No source or production change was made.`);
		}
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
					inputs: { request_id: workflow.id, request: workflow.request, room: "main" },
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
		if (!workflow || workflow.id !== callback.requestId || TERMINAL_PHASES.has(workflow.phase)) return;

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
		}
		await Promise.all([this.ctx.storage.put(WORKFLOW_KEY, workflow), this.saveWorkItems(workItems)]);
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
