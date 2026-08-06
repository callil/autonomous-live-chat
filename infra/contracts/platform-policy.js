/**
 * Platform contracts and delivery policy live here so limits are named,
 * documented, and tested instead of being scattered through product code.
 *
 * Cloudflare sources:
 * - https://developers.cloudflare.com/durable-objects/platform/limits/
 * - https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
export const PLATFORM_LIMITS = {
	cloudflareDurableObject: {
		keyAndValueBytes: 2_000_000,
		deleteKeysPerCall: 128,
		getKeysPerCall: 128,
		webSocketReceiveBytes: 32 * 1024 * 1024,
	},
};

/**
 * These values bound one delivery operation, never retained product history.
 * Changing them affects latency and memory pressure, not what is preserved.
 */
export const DELIVERY_POLICY = {
	historyRecordsPerPage: 64,
	historyPageBytes: 2 * PLATFORM_LIMITS.cloudflareDurableObject.keyAndValueBytes,
};

/**
 * The authoring overlay deliberately records a small, non-sensitive locator
 * envelope instead of arbitrary DOM state. These are schema bounds, not caps
 * on the user's actual request or retained history.
 */
export const AUTHORING_ENVELOPE_POLICY = {
	roomNameCharacters: 64,
	targetIdCharacters: 64,
	tagCharacters: 32,
	roleCharacters: 48,
	safeTextCharacters: 120,
	pagePathCharacters: 160,
	coordinateMagnitude: 100_000,
};

const encoder = new TextEncoder();

export function utf8Bytes(value) {
	return encoder.encode(value).byteLength;
}

export function durableRecordBytes(key, value) {
	return utf8Bytes(key) + utf8Bytes(JSON.stringify(value));
}

export function fitsDurableRecord(key, value) {
	return durableRecordBytes(key, value) <= PLATFORM_LIMITS.cloudflareDurableObject.keyAndValueBytes;
}

export function storageDeleteBatches(keys) {
	const size = PLATFORM_LIMITS.cloudflareDurableObject.deleteKeysPerCall;
	const batches = [];
	for (let index = 0; index < keys.length; index += size) batches.push(keys.slice(index, index + size));
	return batches;
}
