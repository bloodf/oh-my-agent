/**
 * Purpose: An agent's lifecycle state, in a module with no imports so code
 * outside the plugin (the website's demo mock) can type against it without
 * installing OMP.
 */
export type AgentState = "running" | "parked" | "stopped";
