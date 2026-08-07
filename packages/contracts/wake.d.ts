export type OperatorWakeRecord = { id: string; workItemId: string; version: number; turn: number; state: "pending" | "in_flight"; attempts: number; availableAt: number; nextVersion?: number };
export function queueOperatorWakeRecord(existing: OperatorWakeRecord | undefined, input: { id: string; workItemId: string; version: number; now: number; delayMs: number }): OperatorWakeRecord;
export function settleOperatorWakeRecord(wake: OperatorWakeRecord | undefined, input: { currentVersion: number; expectedVersion: number; turn: number; terminal: boolean; now: number }): OperatorWakeRecord | null | undefined;
export function beginOperatorWakeDelivery(wake: OperatorWakeRecord, input: { currentVersion: number; terminal: boolean; now: number; responseLeaseMs: number }): OperatorWakeRecord | null;
export function operatorWakeDeliveryExhausted(wake: OperatorWakeRecord, maximumAttempts: number): boolean;
