import { RETRYABLE_DOCTOR_KINDS, StubDoctorPort, type DoctorCase, type DoctorPort, type DoctorVerdict } from "./ports.js";

/**
 * The real Doctor (phase 3): gpt-5.6-sol over the OpenAI Responses API — the
 * same model and credential the platform runner's agent rides — invoked ONLY
 * on park events with the full case file. The output is doubly constrained —
 * a strict JSON schema on the API side, and a mechanical disposition clamp on
 * ours (retry-once is honored only when the case is mechanically retryable).
 * EVERY failure — missing credential, timeout, refusal, malformed output —
 * fails open to the deterministic stub, which parks for a human. The Doctor
 * can never wedge the pipeline.
 *
 * Raw fetch on purpose: the frozen platform Worker carries zero runtime
 * dependencies (same convention as the GitHub App capability in github.ts).
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DOCTOR_MODEL = "gpt-5.6-sol";
/** Reasoning tokens and the verdict text share this cap (Responses API semantics). */
const DOCTOR_MAX_OUTPUT_TOKENS = 8_000;
const DOCTOR_TIMEOUT_MS = 45_000;
const MAX_NOTE_CHARS = 400;

const VERDICT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["disposition", "publicNote"],
	properties: {
		disposition: { type: "string", enum: ["stay-parked", "retry-once"] },
		publicNote: {
			type: "string",
			description: "One or two plain-language sentences, shown verbatim in the public room feed: what happened and what happens next. Honest, specific, no blame, no jargon.",
		},
	},
} as const;

const SYSTEM_PROMPT = [
	"You are the Doctor for an autonomous live-coding platform: a chat room whose users point at UI elements and request changes, which an isolated coding agent builds, CI verifies, and the platform merges and deploys.",
	"You are consulted ONLY when a build request has deviated (a park event). You receive the mechanical classification, the verbatim user request, and the recent ledger facts.",
	"You must return exactly one disposition:",
	"- \"retry-once\": grant the request ONE fresh build attempt from latest main. Choose this only when retryAvailable is true AND the failure looks transient or plausibly resolved by a clean re-run (flaky CI, a timeout, a merge race, a sandbox hiccup, or an agent stumble a fresh attempt may avoid).",
	"- \"stay-parked\": leave the request parked for a human. Choose this when the failure looks deterministic (the request is infeasible, the same test would fail again, credentials or infrastructure are missing) or when retryAvailable is false.",
	"Also write publicNote: one or two sentences shown verbatim in the public room feed. Be honest and specific about what happened and what happens next. Never blame the requester. Never promise anything beyond the chosen disposition.",
].join("\n");

export class OpenAiDoctorPort implements DoctorPort {
	private readonly apiKey: string;
	private readonly fallback: DoctorPort;

	constructor(apiKey: string, fallback: DoctorPort = new StubDoctorPort()) {
		this.apiKey = apiKey;
		this.fallback = fallback;
	}

	async consult(caseFile: DoctorCase): Promise<DoctorVerdict> {
		const retryAvailable = caseFile.retryAvailable === true && RETRYABLE_DOCTOR_KINDS.has(caseFile.kind);
		try {
			const response = await fetch(OPENAI_RESPONSES_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: DOCTOR_MODEL,
					instructions: SYSTEM_PROMPT,
					input: JSON.stringify({ ...caseFile, retryAvailable }, null, 1),
					store: false,
					reasoning: { effort: "medium" },
					max_output_tokens: DOCTOR_MAX_OUTPUT_TOKENS,
					text: { format: { type: "json_schema", name: "doctor_verdict", strict: true, schema: VERDICT_SCHEMA } },
				}),
				signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`openai-${response.status}`);
			const body = await response.json() as { status?: unknown; output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }> };
			// A refusal, truncation, or failed response means no trustworthy verdict: fail open.
			if (body.status !== "completed") throw new Error(`doctor-status-${String(body.status)}`);
			const text = (body.output ?? [])
				.filter((item) => item.type === "message")
				.flatMap((item) => item.content ?? [])
				.find((part) => part.type === "output_text")?.text;
			if (typeof text !== "string") throw new Error("doctor-no-text");
			const verdict = JSON.parse(text) as { disposition?: unknown; publicNote?: unknown };
			if (verdict.disposition !== "stay-parked" && verdict.disposition !== "retry-once") throw new Error("doctor-disposition-invalid");
			if (typeof verdict.publicNote !== "string" || !verdict.publicNote.trim().length) throw new Error("doctor-note-invalid");
			return {
				// The mechanical clamp: the model cannot retry what the platform
				// deems unretryable, no matter how it words the verdict.
				disposition: verdict.disposition === "retry-once" && retryAvailable ? "retry-once" : "stay-parked",
				publicNote: verdict.publicNote.trim().slice(0, MAX_NOTE_CHARS),
			};
		} catch (error) {
			console.error("Doctor consult failed open to the deterministic stub", { kind: caseFile.kind, error: error instanceof Error ? error.message : String(error) });
			return this.fallback.consult(caseFile);
		}
	}
}
