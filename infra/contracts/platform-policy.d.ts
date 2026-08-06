export const PLATFORM_LIMITS: {
	readonly cloudflareDurableObject: {
		readonly keyAndValueBytes: 2_000_000;
		readonly deleteKeysPerCall: 128;
		readonly getKeysPerCall: 128;
		readonly webSocketReceiveBytes: number;
	};
};

export const DELIVERY_POLICY: {
	readonly historyRecordsPerPage: 64;
	readonly historyPageBytes: number;
};

export const AUTHORING_ENVELOPE_POLICY: {
	readonly roomNameCharacters: 64;
	readonly targetIdCharacters: 64;
	readonly tagCharacters: 32;
	readonly roleCharacters: 48;
	readonly safeTextCharacters: 120;
	readonly pagePathCharacters: 160;
	readonly coordinateMagnitude: 100_000;
};

export function utf8Bytes(value: string): number;
export function durableRecordBytes(key: string, value: unknown): number;
export function fitsDurableRecord(key: string, value: unknown): boolean;
export function storageDeleteBatches(keys: string[]): string[][];
