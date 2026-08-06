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

type Classification = { changeType: "visual" | "content" | "data" | "behavior" | "infrastructure"; scope: "localized" | "bounded" | "broad"; risk: "low" | "medium" | "high"; affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure"; reversible: boolean; executionEligibility: "eligible" | "needs_review"; ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure" };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

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
		required: ["decision", "patch", "rationale", "classification"],
		properties: {
			decision: { type: "string", enum: ["approved", "needs_review"] },
			patch: { type: ["string", "null"], maxLength: 12000 },
			rationale: { type: "string", maxLength: 240 },
			classification: { type: "object", additionalProperties: false, required: ["changeType", "scope", "risk", "affectedSurface", "reversible", "executionEligibility", "ciProfile"], properties: {
				changeType: { type: "string", enum: ["visual", "content", "data", "behavior", "infrastructure"] },
				scope: { type: "string", enum: ["localized", "bounded", "broad"] },
				risk: { type: "string", enum: ["low", "medium", "high"] },
				affectedSurface: { type: "string", enum: ["ui", "copy", "data", "behavior", "infrastructure"] },
				reversible: { type: "boolean" },
				executionEligibility: { type: "string", enum: ["eligible", "needs_review"] },
				ciProfile: { type: "string", enum: ["visual", "content", "behavior", "data", "infrastructure"] },
			} },
		},
	};
}

function validatedPlan(value: unknown): ({ decision: "approved"; patch: string; rationale: string } | { decision: "needs_review"; rationale: string }) & { classification: Classification } | null {
	if (!value || typeof value !== "object") return null;
	const plan = value as Record<string, unknown>;
	if (typeof plan.rationale !== "string" || !plan.rationale.trim() || plan.rationale.length > 240 || !plan.classification || typeof plan.classification !== "object") return null;
	const classification = plan.classification as Record<string, unknown>;
	if (!["visual", "content", "data", "behavior", "infrastructure"].includes(classification.changeType as string) || !["localized", "bounded", "broad"].includes(classification.scope as string) || !["low", "medium", "high"].includes(classification.risk as string) || !["ui", "copy", "data", "behavior", "infrastructure"].includes(classification.affectedSurface as string) || typeof classification.reversible !== "boolean" || !["eligible", "needs_review"].includes(classification.executionEligibility as string) || !["visual", "content", "behavior", "data", "infrastructure"].includes(classification.ciProfile as string)) return null;
	const safeClassification = classification as unknown as Classification;
	if (plan.decision === "approved" && typeof plan.patch === "string" && plan.patch.startsWith("--- a/") && plan.patch.includes("+++ b/")) {
		if (safeClassification.executionEligibility !== "eligible" || safeClassification.changeType !== "content" || safeClassification.scope !== "localized" || safeClassification.risk !== "low" || !safeClassification.reversible || safeClassification.ciProfile !== "content") return null;
		return { decision: "approved", patch: plan.patch, rationale: plan.rationale.trim(), classification: safeClassification };
	}
	if (plan.decision === "needs_review" && plan.patch === null) return { decision: "needs_review", rationale: plan.rationale.trim(), classification: safeClassification };
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
		"You are allowed to propose one small documentation-only change in README.md or a file below docs/. Return a standard unified diff with paths beginning a/ and b/.",
		"Never touch source code, workflows, package files, credentials, configuration, lockfiles, or any file outside README.md and docs/. Do not emit shell commands or prose outside the JSON fields.",
		"If the request is not an unambiguous, localized documentation update, return needs_review with patch null.",
		"An approved change must classify as content, localized, low risk, affectedSurface ui or copy, reversible true, execution eligible, and content CI profile. Classification can never waive the file policy.",
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
			classification: plan.classification,
			plan: { change: { kind: "documentation-patch", patch: plan.patch } },
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
