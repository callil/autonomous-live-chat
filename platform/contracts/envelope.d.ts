import type { AnnotationPayload } from "./ledger.js";
import type { RunMode } from "./mode.js";

export type RequestEnvelope = {
	kind: "target" | "comment" | "draw";
	text: string;
	annotation: AnnotationPayload;
	/** The requester's explicit per-request speed choice; defaults to "standard". */
	mode: RunMode;
	clientSubmissionId?: string;
};

export const REQUEST_ENVELOPE_TYPES: readonly string[];
export const CANCEL_WINDOW_MS: number;

export function parseRequestEnvelope(message: unknown): RequestEnvelope | null;
export function cancelDeadline(acceptedAt: number, windowMs?: number): number;
export function mayDispatch(acceptedAt: number, now: number, windowMs?: number): boolean;
