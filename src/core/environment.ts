export type EnvironmentPhase = "setup" | "onStart";

/** The config owns the setup script; the runtime only materializes a copy inside the pet. */
export interface PetEnvironment {
  setup?: string;
  onStart?: string;
}

/** Bound config, MCP and runtime payloads by encoded bytes, including non-ASCII scripts. */
export const ENVIRONMENT_SETUP_MAX_BYTES = 64 * 1024;

export function environmentSetupProblem(script: string): string | undefined {
  if (new TextEncoder().encode(script).byteLength > ENVIRONMENT_SETUP_MAX_BYTES) return `environment setup is ${ENVIRONMENT_SETUP_MAX_BYTES} UTF-8 bytes at most`;
  if (script.includes("\0")) return "environment setup cannot contain NUL characters";
  return undefined;
}
