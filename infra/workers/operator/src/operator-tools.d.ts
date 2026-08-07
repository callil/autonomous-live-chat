import type { OperatorCommand } from "./contracts";

export type ToolDefinition = {
	type: "function";
	function: {
		name: string;
		description: string;
		strict: true;
		parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
	};
};

export type StageContext = {
	minted: string;
	activeRunId: string;
	planBranch: string;
	issueNumber: number;
	candidatePr: number;
	candidateHeadSha: string;
};

export const SYSTEM_PROMPT: string;
export const TOOLS: ToolDefinition[];
export const OBSERVATION_TOOLS: Set<string>;
export const STAGE_TOOLS: Set<string>;
export function commandFor(name: string, args: Record<string, unknown>, ctx: StageContext): OperatorCommand;
