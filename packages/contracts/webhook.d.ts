export const GITHUB_CANDIDATE_WORKFLOW_PATH: string;
export const GITHUB_PROMOTION_WORKFLOW_PATH: string;
export const GITHUB_MAIN_DEPLOY_WORKFLOW_PATH: string;
export const GITHUB_CANDIDATE_BRANCH_PREFIX: string;
export const GITHUB_PROMOTION_RUN_PREFIX: string;
export const GITHUB_DELIVERY_MARKER_PREFIX: string;
export const GITHUB_DELIVERY_RETENTION_MS: number;

export type GithubWebhookFact =
	| { kind: "validation"; runId: number; url: string; conclusion: string | null; createdAt: string; headSha: string }
	| { kind: "promotion"; runId: number; url: string; conclusion: string | null; createdAt: string; dispatchKey: string }
	| { kind: "main-deploy"; runId: number; url: string; conclusion: string | null; createdAt: string; headSha: string }
	| { kind: "candidate"; number: number; url: string; headSha: string; branch: string }
	| { kind: "merged"; number: number; url: string; headSha: string; branch: string; mergeCommitSha: string };

export type GithubFactRecord = {
	validation?: { runId: number; url: string; conclusion: string | null; createdAt: string; headSha: string; at: number };
	promotion?: { runId: number; url: string; conclusion: string | null; createdAt: string; dispatchKey: string; at: number };
	mainDeploy?: { runId: number; url: string; conclusion: string | null; createdAt: string; headSha: string; at: number };
	candidate?: { number: number; url: string; headSha: string; branch: string; at: number };
	merged?: { number: number; url: string; headSha: string; branch: string; mergeCommitSha: string; at: number };
};

export type GithubFactWorkItemView = {
	id: string;
	createdAt?: number;
	plan?: unknown;
	artifacts?: unknown;
};

export function normalizeGithubDeliveryId(value: unknown): string | null;
export function githubDeliveryMarkerKey(deliveryId: string): string;
export function expiredGithubDeliveryMarker(marker: unknown, now: number): boolean;
export function extractGithubWebhookFact(input: { event: string | null | undefined; payload: unknown }): GithubWebhookFact | null;
export function normalizeGithubWebhookFact(value: unknown): GithubWebhookFact | null;
export function matchGithubFactToWorkItem(
	fact: GithubWebhookFact,
	items: readonly GithubFactWorkItemView[],
	promotions?: readonly { workItemId: string; dispatchKey: string }[],
	merges?: readonly { workItemId: string; mergeCommitSha: string }[],
): string | null;
export function mergeGithubFact<T extends GithubFactRecord>(existing: T | undefined, fact: GithubWebhookFact, now: number): T | null;
