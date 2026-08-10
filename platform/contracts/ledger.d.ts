export type LedgerEventKind =
	| "utterance"
	| "annotation"
	| "request-accepted"
	| "request-cancelled"
	| "intent-opened"
	| "intent-amended"
	| "intent-dispatched"
	| "intent-live"
	| "intent-parked"
	| "intent-withdrawn"
	| "intent-retried"
	| "run-queued"
	| "run-started"
	| "run-heartbeat"
	| "run-timing"
	| "run-verifying"
	| "pr-merged"
	| "run-merged"
	| "run-failed"
	| "run-parked"
	| "deploy-requested"
	| "deploy-observed"
	| "rollback-requested"
	| "rollback-observed"
	| "liveness-failed"
	| "room-frozen"
	| "room-unfrozen"
	| "revert-requested"
	| "budget-exhausted"
	| "doctor-note"
	| "harness-feedback";

export type AnnotationPayload = {
	kind: "target" | "comment" | "draw";
	dataLoc: string;
	domSnapshot: string;
	text?: string;
	selector?: string;
	computedStyles?: Record<string, string>;
	drawingPoints?: Array<{ x: number; y: number }>;
	screenshotCrop?: string;
	[key: string]: unknown;
};

export type LedgerEvent = {
	readonly seq: number;
	readonly kind: LedgerEventKind;
	readonly at: number;
	readonly payload: Record<string, unknown>;
};

export const LEDGER_EVENT_KINDS: readonly LedgerEventKind[];
export function isLedgerEventKind(value: unknown): value is LedgerEventKind;
export function validateAnnotationPayload(payload: unknown): AnnotationPayload;
export function createLedgerEvent(input: { seq: number; kind: LedgerEventKind; at: number; payload: Record<string, unknown> }): LedgerEvent;
export function assertAppendable(lastSeq: number, event: LedgerEvent): LedgerEvent;
export function eventStorageKey(seq: number): string;
