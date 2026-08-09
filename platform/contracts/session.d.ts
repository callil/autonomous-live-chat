export type SessionIdentity = { id: string; name: string; iat: number };

export const SESSION_NAME: RegExp;
export const SESSION_TTL_MS: number;

export function mintSessionToken(adminToken: string, name: string, now?: number): Promise<{ token: string; identity: SessionIdentity }>;
export function verifySessionToken(adminToken: string, token: string, now?: number): Promise<SessionIdentity | null>;
export function admitRateLimited(windows: Map<string, number[]>, key: string, now: number, config: { limit: number; windowMs: number }): boolean;
