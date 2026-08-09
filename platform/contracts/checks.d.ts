export type CheckRunInput = { name?: unknown; status?: unknown; conclusion?: unknown };
export type CheckVerdict = { verdict: "green" } | { verdict: "pending" } | { verdict: "red"; failed: string[] };

export function classifyCheckRuns(checkRuns: unknown[]): CheckVerdict;
export function includesMigrationMarker(changedPaths: unknown[]): boolean;
