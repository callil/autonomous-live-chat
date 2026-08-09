export type IntentState = "open" | "dispatched" | "live" | "parked" | "withdrawn";

export type IntentRefs = { utteranceSeqs: number[]; annotationSeqs: number[] };

export type Intent = {
	schemaVersion: 1;
	id: string;
	openedBy: string;
	state: IntentState;
	version: number;
	refs: IntentRefs;
	runId?: string;
	detail?: unknown;
	openedAt: number;
	updatedAt: number;
};

export const INTENT_STATES: readonly IntentState[];
export const TERMINAL_INTENT_STATES: ReadonlySet<IntentState>;
export const OPEN_INTENT_LIMIT: number;

export function createIntent(input: { id: string; openedBy: string; at: number; refs: IntentRefs }): Intent;
export function amendmentDisposition(intent: Intent): "amend" | "follow-up";
export function amendIntent(intent: Intent, input: { refs: IntentRefs; at: number }): Intent;
export function dispatchIntent(intent: Intent, input: { runId: string; at: number }): Intent;
export function recordIntentOutcome(intent: Intent, input: { state: "live" | "parked"; at: number; detail?: unknown }): Intent;
export function withdrawIntent(intent: Intent, input: { at: number }): Intent;
export function countOpenIntents(intents: Intent[], userId: string): number;
export function underOpenIntentLimit(intents: Intent[], userId: string, limit?: number): boolean;
