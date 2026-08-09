export type RunTier = "small" | "normal";

export type TierBudget = {
	effort: "low" | "medium";
	maxToolCalls: number;
	includeTree: boolean;
};

export const RUN_TIERS: readonly RunTier[];
export const SMALL_MAX_TEXT_CHARS: number;
export const SMALL_MAX_ANNOTATIONS: number;
export const TIER_BUDGETS: Record<RunTier, TierBudget>;

export function classifyRunTier(input: { kind: unknown; text: unknown; annotationCount: unknown }): RunTier;
export function tierBudgets(tier: unknown): TierBudget;
