type Env = {
	ALLOWED_REPOSITORY: string;
	APP_HARNESS_ORCHESTRATOR_SECRET: string;
	MODEL_ID: string;
	OPENAI_API_KEY: string;
};

type PlanInput = {
	workItemId?: unknown;
	issueUrl?: unknown;
	repository?: unknown;
	request?: unknown;
	target?: unknown;
	stack?: unknown;
};

type SafeManifest = {
	workItemId: string;
	issueUrl: string;
	repository: string;
	request: string;
	target?: { targetId: string; label?: string; page: string };
	stack: { id: string; generation: number; lane: string };
};

type AccentColor = "blue" | "green" | "purple" | "orange";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const COLORS = new Set<AccentColor>(["blue", "green", "purple", "orange"]);

function authorized(request: Request, env: Env): boolean {
	return request.headers.get("authorization") === `Bearer ${env.APP_HARNESS_ORCHESTRATOR_SECRET}`;
}

function normalizeManifest(input: PlanInput, env: Env): SafeManifest | null {
	if (
		typeof input.workItemId !== "string" || !SAFE_ID.test(input.workItemId) ||
		typeof input.repository !== "string" || input.repository !== env.ALLOWED_REPOSITORY ||
		typeof input.issueUrl !== "string" || !new RegExp(`^https://github\\.com/${env.ALLOWED_REPOSITORY}/issues/\\d+$`, "i").test(input.issueUrl) ||
		typeof input.request !== "string"
	) return null;
	const request = input.request.trim().replace(/\s+/gu, " ");
	if (!request || request.length > 500 || !input.stack || typeof input.stack !== "object") return null;
	const stack = input.stack as Record<string, unknown>;
	if (typeof stack.id !== "string" || !SAFE_ID.test(stack.id) || !Number.isInteger(stack.generation) || (stack.generation as number) < 1 || typeof stack.lane !== "string" || !SAFE_ID.test(stack.lane)) return null;
	let target: SafeManifest["target"];
	if (input.target && typeof input.target === "object") {
		const value = input.target as Record<string, unknown>;
		if (typeof value.targetId !== "string" || !SAFE_ID.test(value.targetId) || typeof value.page !== "string" || !/^\/[A-Za-z0-9/_-]{0,159}$/.test(value.page)) return null;
		target = {
			targetId: value.targetId,
			page: value.page,
			...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim().replace(/\s+/gu, " ").slice(0, 120) } : {}),
		};
	}
	return {
		workItemId: input.workItemId,
		issueUrl: input.issueUrl,
		repository: input.repository,
		request,
		...(target ? { target } : {}),
		stack: { id: stack.id, generation: stack.generation as number, lane: stack.lane },
	};
}

function planSchema() {
	return {
		type: "object",
		additionalProperties: false,
		required: ["decision", "color", "rationale"],
		properties: {
			decision: { type: "string", enum: ["approved", "needs_review"] },
			color: { type: ["string", "null"], enum: ["blue", "green", "purple", "orange", null] },
			rationale: { type: "string", maxLength: 240 },
		},
	};
}

function validatedPlan(value: unknown): { decision: "approved"; color: AccentColor; rationale: string } | { decision: "needs_review"; rationale: string } | null {
	if (!value || typeof value !== "object") return null;
	const plan = value as Record<string, unknown>;
	if (typeof plan.rationale !== "string" || !plan.rationale.trim() || plan.rationale.length > 240) return null;
	if (plan.decision === "approved" && typeof plan.color === "string" && COLORS.has(plan.color as AccentColor)) {
		return { decision: "approved", color: plan.color as AccentColor, rationale: plan.rationale.trim() };
	}
	if (plan.decision === "needs_review" && plan.color === null) return { decision: "needs_review", rationale: plan.rationale.trim() };
	return null;
}

function responseText(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const response = value as Record<string, unknown>;
	if (typeof response.output_text === "string") return response.output_text;
	if (!Array.isArray(response.output)) return null;
	for (const item of response.output) {
		if (!item || typeof item !== "object") continue;
		const content = (item as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const record = part as Record<string, unknown>;
			if (record.type === "output_text" && typeof record.text === "string") return record.text;
		}
	}
	return null;
}

async function askModel(manifest: SafeManifest, env: Env): Promise<Response> {
	const instructions = [
		"You are the App Harness Cloudflare OS planning agent.",
		"Return a plan only for an unambiguous request to set this app's accent color to blue, green, purple, or orange.",
		"You may not propose source edits, shell commands, repository URLs, credentials, dependencies, configuration changes, authentication changes, or any operation outside that single allowlisted change.",
		"If the bounded manifest does not request exactly that change, return needs_review with color null.",
		"Do not include user data beyond a brief rationale.",
	].join(" ");
	try {
		const response = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: env.MODEL_ID,
				store: false,
				reasoning: { effort: "low" },
				input: [
					{ role: "system", content: [{ type: "input_text", text: instructions }] },
					{ role: "user", content: [{ type: "input_text", text: JSON.stringify(manifest) }] },
				],
				text: { format: { type: "json_schema", name: "app_harness_candidate_plan", strict: true, schema: planSchema() } },
			}),
		});
		if (!response.ok) return Response.json({ state: "agent-unavailable", classification: "model-request-failed" }, { status: 502 });
		const result = await response.json() as { id?: unknown; output_text?: unknown; output?: unknown };
		let plan = null;
		try {
			const text = responseText(result);
			plan = text ? validatedPlan(JSON.parse(text)) : null;
		} catch { /* invalid structured content remains fail-closed */ }
		if (typeof result.id !== "string" || !plan) return Response.json({ state: "agent-unavailable", classification: "model-plan-invalid" }, { status: 502 });
		if (plan.decision === "needs_review") {
			return Response.json({ state: "needs-review", model: { id: result.id, model: env.MODEL_ID }, rationale: plan.rationale });
		}
		return Response.json({
			state: "planned",
			model: { id: result.id, model: env.MODEL_ID },
			rationale: plan.rationale,
			plan: { change: { kind: "accent-color", color: plan.color } },
		});
	} catch {
		return Response.json({ state: "agent-unavailable", classification: "model-response-unavailable" }, { status: 502 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST" || !authorized(request, env) || new URL(request.url).pathname !== "/v1/plans") return new Response("Not found", { status: 404 });
		let body: PlanInput;
		try { body = await request.json() as PlanInput; } catch { return Response.json({ error: "Invalid plan input." }, { status: 400 }); }
		const manifest = normalizeManifest(body, env);
		if (!manifest) return Response.json({ error: "Plan input is outside the OS agent scope." }, { status: 403 });
		return askModel(manifest, env);
	},
};
