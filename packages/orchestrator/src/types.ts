/**
 * Core types for multi-agent orchestration.
 */

export type AgentType = "research" | "implement" | "test" | "review";

export type SubTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface SubTask {
	id: string;
	title: string;
	description: string;
	agentType: AgentType;
	dependsOn: string[];
	status: SubTaskStatus;
	result?: SubTaskResult;
}

export interface SubTaskResult {
	output: string;
	artifacts?: string[];
	duration: number;
	error?: string;
}

export interface TaskPlan {
	taskId: string;
	description: string;
	subTasks: SubTask[];
	createdAt: number;
}

export interface ExecutionResult {
	taskId: string;
	plan: TaskPlan;
	completedSubTasks: SubTask[];
	failedSubTasks: SubTask[];
	synthesizedResult: string;
	totalDuration: number;
}

export interface OrchestratorState {
	plan: TaskPlan;
	currentSubTaskId: string | null;
	completedSubTaskIds: string[];
	failedSubTaskIds: string[];
	startedAt: number;
}

export interface ProgressCallback {
	(event: ProgressEvent): void;
}

export type ProgressEvent =
	| { type: "subtask_start"; subTask: SubTask }
	| { type: "subtask_complete"; subTask: SubTask; result: SubTaskResult }
	| { type: "subtask_failed"; subTask: SubTask; error: string }
	| { type: "synthesis_start" }
	| { type: "complete"; result: ExecutionResult };
