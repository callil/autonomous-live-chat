import { RETRYABLE_DOCTOR_KINDS, StubDoctorPort, type DoctorCase, type DoctorPort, type DoctorVerdict } from "./ports.js";

/**
 * The real Doctor (phase 3): claude-opus-5 over the Anthropic Messages API,
 * invoked ONLY on park events with the full case file. The output is doubly
 * constrained — a strict JSON schema on the API side, and a mechanical
 * disposition clamp on ours (retry-once is honored only when the case is
 * mechanically retryable). EVERY failure — missing credential, timeout,
 * refusal, malformed output — fails open to the deterministic stub, which
 * parks for a human. The Doctor can never wedge the pipeline.
 *
 * Raw fetch on purpose: the frozen platform Worker carries zero runtime
 * dependencies (same convention as the GitHub App capability in github.ts).
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DOCTOR_MODEL = "claude-opus-5";
/** Thinking is on by default on claude-opus-5 and max_tokens caps thinking + text together. */
const DOCTOR_MAX_TOKENS = 8_000;
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

export class AnthropicDoctorPort implements DoctorPort {
	private readonly apiKey: string;
	private readonly fallback: DoctorPort;

	constructor(apiKey: string, fallback: DoctorPort = new StubDoctorPort()) {
		this.apiKey = apiKey;
		this.fallback = fallback;
	}

	async consult(caseFile: DoctorCase): Promise<DoctorVerdict> {
		const retryAvailable = caseFile.retryAvailable === true && RETRYABLE_DOCTOR_KINDS.has(caseFile.kind);
		try {
			const response = await fetch(ANTHROPIC_URL, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": this.apiKey,
					"anthropic-version": ANTHROPIC_VERSION,
				},
				body: JSON.stringify({
					model: DOCTOR_MODEL,
					max_tokens: DOCTOR_MAX_TOKENS,
					system: SYSTEM_PROMPT,
					output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
					messages: [{ role: "user", content: JSON.stringify({ ...caseFile, retryAvailable }, null, 1) }],
				}),
				signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`anthropic-${response.status}`);
			const body = await response.json() as { stop_reason?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
			// A refusal or truncation means no trustworthy verdict: fail open.
			if (body.stop_reason !== "end_turn") throw new Error(`doctor-stop-${String(body.stop_reason)}`);
			const text = (body.content ?? []).find((block) => block.type === "text")?.text;
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
