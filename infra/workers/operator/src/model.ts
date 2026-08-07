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

/**
 * Every model call carries its own deadline: a hung provider request must not
 * outlive the turn. The loop also checks, before each call, that a call this
 * long still fits inside the turn's outer envelope.
 */
export const MODEL_CALL_TIMEOUT_MS = 45_000;

export class ModelError extends Error {
	constructor(readonly status: number, detail: string, readonly code?: string) {
		super(`Model call failed (${status}): ${detail}`);
	}

	/**
	 * OpenAI reports an exhausted balance as 429 with error.type/code
	 * "insufficient_quota". Unlike ordinary 429 overload, no retry can succeed
	 * until the balance is restored, so the loop must park distinctly instead
	 * of burning its retry budget.
	 */
	get creditsExhausted(): boolean {
		return this.code === "insufficient_quota";
	}
}

/** Distinguish exhausted credits from transient overload in a 429 body. */
export function modelErrorCode(status: number, detail: string): string | undefined {
	return status === 429 && /insufficient_quota/u.test(detail) ? "insufficient_quota" : undefined;
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
	// The DO's alarm can re-drive the loop but cannot cancel an in-flight
	// fetch, so the request carries its own deadline.
	const response = await fetch(`${env.MODEL_BASE_URL}/chat/completions`, {
		method: "POST",
		signal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS),
		headers: {
			"content-type": "application/json",
			// With gateway-stored provider keys the direct credential is optional.
			...(env.MODEL_API_KEY ? { authorization: `Bearer ${env.MODEL_API_KEY}` } : {}),
		},
		body: JSON.stringify({
			model: env.MODEL_ID,
			messages,
			// The 1-token recovery probe sends no tools at all; a regular turn
			// always carries the full vocabulary.
			...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
			max_completion_tokens: Math.max(1, Math.min(Number(env.MAX_TOKENS_PER_TURN), maxTokens ?? Number(env.MAX_TOKENS_PER_TURN))),
		}),
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new ModelError(response.status, detail.slice(0, 300), modelErrorCode(response.status, detail));
	}
	const body = await response.json() as { choices?: Array<{ message?: ModelMessage }>; usage?: { total_tokens?: number } };
	const message = body.choices?.[0]?.message;
	if (!message) throw new ModelError(502, "Model response carried no message.");
	return { message, usage: body.usage };
}

/**
 * One minimal chat call: enough tokens to prove the account can buy tokens
 * again after a recorded credit outage, and nothing more. The ledger sweep
 * calls this through OperatorGateway while the outage fact stands.
 */
export async function probeModel(env: ModelEnv): Promise<{ ok: boolean; status?: number }> {
	try {
		await callModel(env, [{ role: "user", content: "Reply with ok." }], [], 16);
		return { ok: true };
	} catch (error) {
		return { ok: false, ...(error instanceof ModelError ? { status: error.status } : {}) };
	}
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
