import type { LedgerEvent } from "./ledger.js";
import type { QueuedRun, QueueChipStatus } from "./queue.js";

export type FeedItem = { seq: number; at: number; kind: string; text: string };
export type QueueChip = QueueChipStatus & { label: string };
export type FeedPayload = { items: FeedItem[]; queue: QueueChip[]; frozen: boolean };

export function formatEta(etaMs: number): string;
export function renderFeedItem(event: LedgerEvent): FeedItem | null;
export function renderQueueChips(queue: QueuedRun[], now: number): QueueChip[];
export function renderFeed(input: { events: LedgerEvent[]; queue: QueuedRun[]; now: number; frozen?: boolean }): FeedPayload;
