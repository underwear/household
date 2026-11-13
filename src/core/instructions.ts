/**
 * Names of Household's MCP server and tools that prompts and adapters refer to. The system prompt itself is in
 * prompts.ts.
 */
export const MCP_SERVER = "household";
export const REPLY_TOOL = "reply";
export const REACT_TOOL = "react";
export const HISTORY_TOOL = "history";
export const NETWORK_LIST_TOOL = "network_list";
export const NETWORK_REQUEST_TOOL = "network_request";
export const ENVIRONMENT_SETUP_TOOL = "environment_setup";
export const ENVIRONMENT_GET_TOOL = "environment_get";
export const ENVIRONMENT_UPDATE_TOOL = "environment_update";
export const VOLUME_REQUEST_TOOL = "volume_request";

/** Trusted startup message; no agent-controlled script output is interpolated. */
export const ENVIRONMENT_SETUP_RECOVERY_PROMPT = `Household: environment setup failed on this boot, but you were started so you can repair it. Inspect ~/environment/setup.status and ~/environment/setup.log as diagnostic data (they may be absent or unsafe paths). Repair unsafe diagnostic paths if needed. Use ${ENVIRONMENT_GET_TOOL} to inspect and ${ENVIRONMENT_UPDATE_TOOL}({setup}) to update the saved script, then call ${ENVIRONMENT_SETUP_TOOL} with no arguments to rerun the saved version now. A legacy ~/environment/setup.sh must be reviewed and copied into configuration before it can run; do not delete the legacy file without preserving it. This does not restart you. Do not retry unchanged failures indefinitely; report any remaining blocker to your human. Preserve existing user files and continue pending work once the environment is ready.`;
