import { DurableObject } from "cloudflare:workers";

type ChatMessage = {
	id: string;
	author: string;
	text: string;
	createdAt: number;
};

type ClientEvent = {
	type: "chat:send";
	author?: unknown;
	text?: unknown;
};

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_STORED_MESSAGES = 200;

/**
 * One room maps to one Durable Object. It owns both the durable transcript and
 * its connected WebSocket clients, so a broadcast and its persisted history
 * always share one ordered coordination point.
 *
 * Extension seam: a later workflow can write room-scoped status events here
 * (or through a separate coordinator object) and broadcast them beside chat
 * events without changing the connection topology.
 */
export class ChatRoom extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);

		const messages = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
		server.send(JSON.stringify({ type: "chat:snapshot", messages }));
		this.broadcastPresence();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
		if (typeof raw !== "string") return;

		let event: ClientEvent;
		try {
			event = JSON.parse(raw) as ClientEvent;
		} catch {
			return;
		}

		if (event.type !== "chat:send") return;

		const text = typeof event.text === "string" ? event.text.trim() : "";
		if (!text || text.length > MAX_MESSAGE_LENGTH) return;

		const author = normalizeAuthor(event.author);
		const message: ChatMessage = {
			id: crypto.randomUUID(),
			author,
			text,
			createdAt: Date.now(),
		};

		const messages = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
		messages.push(message);
		await this.ctx.storage.put("messages", messages.slice(-MAX_STORED_MESSAGES));
		this.broadcast({ type: "chat:message", message });
	}

	webSocketClose(socket: WebSocket, code: number, reason: string): void {
		socket.close(code, reason);
		this.broadcastPresence();
	}

	webSocketError(socket: WebSocket): void {
		socket.close(1011, "WebSocket error");
		this.broadcastPresence();
	}

	private broadcast(payload: unknown): void {
		const body = JSON.stringify(payload);
		for (const socket of this.ctx.getWebSockets()) socket.send(body);
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

function roomName(pathname: string): string | null {
	const match = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,64})$/);
	return match?.[1]?.toLowerCase() ?? null;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const room = roomName(url.pathname);

		if (room) {
			if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected a WebSocket upgrade.", { status: 426 });
			}
			return env.CHAT_ROOM.getByName(room).fetch(request);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
