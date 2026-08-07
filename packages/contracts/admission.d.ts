export declare const IMPLEMENT_SLOTS: number;

export type ImplementAdmissionState = {
	holders: string[];
	queue: string[];
	announced: Record<string, number>;
};

export declare function normalizeAdmissionState(value: unknown): ImplementAdmissionState;
export declare function grantImplementSlot(
	state: unknown,
	workItemId: string,
	slots?: number,
):
	| { granted: true; state: ImplementAdmissionState }
	| { granted: false; state: ImplementAdmissionState; position: number; ahead: number };
export declare function releaseImplementSlot(state: unknown, workItemId: string): { released: boolean; state: ImplementAdmissionState };
export declare function implementQueuePosition(state: unknown, workItemId: string): number | null;

export type CreditsHealth = { creditsExhausted: true; at: number };

export declare function isCreditsExhaustedClassification(value: unknown): boolean;
export declare function recordCreditsExhausted(health: unknown, at: number): { health: CreditsHealth; changed: boolean };
export declare function clearCreditsExhausted(health: unknown): { health: null; changed: boolean };
