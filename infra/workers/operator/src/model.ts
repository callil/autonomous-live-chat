import type { ToolDefinition } from "./operator-tools.js";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ModelMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
};
export type ModelReply = { message: ModelMessage; usage?: { total_tokens?: number } };
export type ModelEnv = {
	AI?: { run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
	MODEL_PROVIDER?: string;
	MODEL_ID: string;
	MODEL_BASE_URL: string;
	MODEL_API_KEY?: string;
	MAX_TOKENS_PER_TURN: string;
};

export class ModelError extends Error {
	constructor(readonly status: number, detail: string) {
		super(`Model call failed (${status}): ${detail}`);
	}
}

type WorkersAiResult = {
	response?: string;
	tool_calls?: Array<{ name?: string; arguments?: unknown }>;
	usage?: { total_tokens?: number };
};

function normalizeWorkersAi(raw: unknown): ModelReply {
	const result = (raw ?? {}) as WorkersAiResult;
	const calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
	const tool_calls: ToolCall[] = calls
		.filter((call) => typeof call?.name === "string")
		.map((call, index) => ({ id: `wa-${index}`, type: "function", function: { name: call.name as string, arguments: JSON.stringify(call.arguments ?? {}) } }));
	return {
		message: { role: "assistant", content: typeof result.response === "string" ? result.response : null, ...(tool_calls.length ? { tool_calls } : {}) },
		usage: result.usage,
	};
}

export async function callModel(env: ModelEnv, messages: ModelMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ModelReply> {
	if (env.MODEL_PROVIDER === "workers-ai") {
		if (!env.AI) throw new ModelError(500, "Workers AI binding is not configured.");
		// The default gateway auto-provisions, adding observability and failover.
		const raw = await env.AI.run(env.MODEL_ID, { messages, tools: tools.map((entry) => entry.function), max_tokens: Number(env.MAX_TOKENS_PER_TURN) }, { gateway: { id: "default" } });
		return normalizeWorkersAi(raw);
	}
	// A hung provider request must not outlive the turn: the DO's alarm can
	// re-drive the loop but cannot cancel an in-flight fetch, so the request
	// carries its own deadline.
	const response = await fetch(`${env.MODEL_BASE_URL}/chat/completions`, {
		method: "POST",
		signal: AbortSignal.timeout(45_000),
		headers: {
			"content-type": "application/json",
			// With gateway-stored provider keys the direct credential is optional.
			...(env.MODEL_API_KEY ? { authorization: `Bearer ${env.MODEL_API_KEY}` } : {}),
		},
		body: JSON.stringify({
			model: env.MODEL_ID,
			messages,
			tools,
			tool_choice: "auto",
			parallel_tool_calls: false,
			max_completion_tokens: Math.max(1, Math.min(Number(env.MAX_TOKENS_PER_TURN), maxTokens ?? Number(env.MAX_TOKENS_PER_TURN))),
		}),
	});
	if (!response.ok) throw new ModelError(response.status, (await response.text()).slice(0, 300));
	const body = await response.json() as { choices?: Array<{ message?: ModelMessage }>; usage?: { total_tokens?: number } };
	const message = body.choices?.[0]?.message;
	if (!message) throw new ModelError(502, "Model response carried no message.");
	return { message, usage: body.usage };
}

export async function withRetry<T>(action: () => Promise<T>, options: { attempts: number; baseMs: number; retryOn: (error: unknown) => boolean }): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < options.attempts; attempt += 1) {
		try {
			return await action();
		} catch (error) {
			lastError = error;
			if (attempt === options.attempts - 1 || !options.retryOn(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, options.baseMs * 2 ** attempt));
		}
	}
	throw lastError;
}
