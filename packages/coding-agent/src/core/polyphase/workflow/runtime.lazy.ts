/** Loads the workflow script runtime on the first script run (see runtime.ts). */
export const loadWorkflowRuntime = () => import("./runtime.ts");
