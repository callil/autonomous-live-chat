import type { Intent } from "./intent.js";
import type { LedgerEvent } from "./ledger.js";
import type { QueuedRun } from "./queue.js";

export type FeedItem = { seq: number; at: number; kind: string; text: string; refs?: { prNumber?: number; sha?: string } };
export type PipelinePhase = "accepted" | "queued" | "building" | "verifying" | "deploying" | "reviewing";
export type ChipAnchor = { kind?: string; dataLoc?: string; selector?: string | null; selectorPath?: string | null };
export type QueueChip = { intentId: string; phase: PipelinePhase; label: string; runId?: string; position?: number; etaMs?: number; anchor?: ChipAnchor; text?: string; by?: string; mode?: "fast" };
export type AnchoredIntent = Intent & { anchor?: ChipAnchor; requestText?: string; requestedBy?: string; requestMode?: "fast" };
export type FeedPayload = { items: FeedItem[]; queue: QueueChip[]; frozen: boolean };

export function formatEta(etaMs: number): string;
export function renderFeedItem(event: LedgerEvent): FeedItem | null;
export function renderQueueChips(queue: QueuedRun[], now: number, intents?: AnchoredIntent[]): QueueChip[];
export function renderFeed(input: { events: LedgerEvent[]; queue: QueuedRun[]; intents?: AnchoredIntent[]; now: number; frozen?: boolean }): FeedPayload;
