import type { Intent } from "./intent.js";
import type { LedgerEvent } from "./ledger.js";
import type { QueuedRun } from "./queue.js";

export type FeedItem = { seq: number; at: number; kind: string; text: string; refs?: { prNumber?: number; sha?: string } };
export type PipelinePhase = "accepted" | "queued" | "building" | "verifying" | "deploying" | "reviewing";
export type QueueChip = { intentId: string; phase: PipelinePhase; label: string; runId?: string; position?: number; etaMs?: number };
export type FeedPayload = { items: FeedItem[]; queue: QueueChip[]; frozen: boolean };

export function formatEta(etaMs: number): string;
export function renderFeedItem(event: LedgerEvent): FeedItem | null;
export function renderQueueChips(queue: QueuedRun[], now: number, intents?: Intent[]): QueueChip[];
export function renderFeed(input: { events: LedgerEvent[]; queue: QueuedRun[]; intents?: Intent[]; now: number; frozen?: boolean }): FeedPayload;
