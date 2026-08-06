/**
 * Shared platform contracts. Limits live here so the app and reusable overlay
 * cannot silently drift or accumulate unrelated local constants.
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
 * Delivery bounds protect one invocation and never discard retained history.
 * Both values derive directly from documented platform boundaries: a page can
 * inspect at most one multi-key operation and carries at most one maximum
 * durable record before the client asks for the next cursor.
 */
export const DELIVERY_POLICY = {
	historyRecordsPerPage: PLATFORM_LIMITS.cloudflareDurableObject.getKeysPerCall,
	historyPageBytes: PLATFORM_LIMITS.cloudflareDurableObject.keyAndValueBytes,
};

/**
 * The authoring overlay deliberately records a small, non-sensitive locator
 * envelope instead of arbitrary DOM state. These are privacy/schema bounds,
 * not caps on request prose or retained history.
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
