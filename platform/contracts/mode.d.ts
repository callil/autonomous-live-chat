export type RunMode = "standard" | "fast";

export type ModeBudget = {
	effort: "low" | "medium";
	maxToolCalls: number;
	includeTree: boolean;
	selfReview: "iterate" | "check";
};

export const RUN_MODES: readonly RunMode[];
export const MODE_BUDGETS: Record<RunMode, ModeBudget>;

export function normalizeRunMode(value: unknown): RunMode;
export function modeBudgets(mode: unknown): ModeBudget;
