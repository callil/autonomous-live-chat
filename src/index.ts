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
	request: string;
	phase: WorkflowPhase;
	activity: WorkflowActivity[];
	createdAt: number;
	updatedAt: number;
	result?: string;
};

type ClientEvent =
	| { type: "chat:send"; author?: unknown; text?: unknown }
	| { type: "workflow:request"; request?: unknown };

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
const WORKFLOW_KEY = "workflow";
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

		const [messages, workflow] = await Promise.all([
			this.ctx.storage.get<ChatMessage[]>("messages"),
			this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY),
		]);
		server.send(JSON.stringify({ type: "chat:snapshot", messages: messages ?? [] }));
		server.send(JSON.stringify({ type: "workflow:snapshot", workflow: workflow ?? null }));
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
			await this.startWorkflow(socket, event.request);
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

	private async startWorkflow(socket: WebSocket, input: unknown): Promise<void> {
		const request = normalizeRequest(input);
		if (!request) {
			socket.send(JSON.stringify({ type: "workflow:notice", message: "Describe a change in 500 characters or fewer." }));
			return;
		}

		const active = await this.ctx.storage.get<WorkflowRecord>(WORKFLOW_KEY);
		if (active && !TERMINAL_PHASES.has(active.phase)) {
			socket.send(JSON.stringify({ type: "workflow:notice", message: "This room already has a change request in progress." }));
			return;
		}

		const now = Date.now();
		const workflow: WorkflowRecord = {
			id: crypto.randomUUID(),
			request,
			phase: "interpreting",
			createdAt: now,
			updatedAt: now,
			activity: [
				{ phase: "received", message: "Request received and durably queued.", at: now },
				{ phase: "interpreting", message: "Checking the request against the autonomous change policy.", at: now },
			],
		};

		await this.ctx.storage.put(WORKFLOW_KEY, workflow);
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
					"User-Agent": "livework-autonomy",
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
		await this.ctx.storage.put(WORKFLOW_KEY, workflow);
		this.broadcastWorkflow(workflow);
	}

	private async failWorkflow(workflow: WorkflowRecord, message: string): Promise<void> {
		workflow.phase = "failed";
		workflow.updatedAt = Date.now();
		workflow.result = message;
		workflow.activity.push({ phase: "failed", message, at: workflow.updatedAt });
		await this.ctx.storage.put(WORKFLOW_KEY, workflow);
		this.broadcastWorkflow(workflow);
	}

	private broadcast(payload: unknown): void {
		const body = JSON.stringify(payload);
		for (const socket of this.ctx.getWebSockets()) socket.send(body);
	}

	private broadcastWorkflow(workflow: WorkflowRecord): void {
		this.broadcast({ type: "workflow:update", workflow });
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

function normalizeRequest(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const request = value.trim().replace(/\s+/g, " ");
	return request && request.length <= MAX_REQUEST_LENGTH ? request : null;
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
