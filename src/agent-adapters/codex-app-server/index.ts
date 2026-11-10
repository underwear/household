import type { AgentAdapter, Exec, KeyUse } from "../../core/agent";
import { acceptsCodexModel, acceptsCodexReasoningEffort, codexFallbackModel } from "./models";
import { createPlaceholderJwt, parseSubscriptionMarker } from "./auth";
import { answerFor, askOf } from "./dialogs";
import { translatePacket } from "./translate";
import { CODEX_MODES } from "./modes";

const CHATGPT = { host: "chatgpt.com", port: 443 };
const OPENAI_API = { host: "api.openai.com", port: 443 };
export const PLACEHOLDER_API_KEY = "sk-household-codex-placeholder-not-a-real-key";
const CONTROL = ["bun", "/etc/household/control.ts"];
async function control(exec: Exec, action: string, body?: unknown): Promise<Record<string, any> | undefined> {
  const result = await exec([...CONTROL, action], body === undefined ? undefined : JSON.stringify(body));
  if (!result.ok) return undefined;
  try { return JSON.parse(result.output); } catch { return undefined; }
}

export const codexAppServer: AgentAdapter = {
  name: "codex-app-server",
  imageContext: import.meta.dir,
  instructionsFile: ".codex/AGENTS.md",
  instructionOverrides: [".codex/AGENTS.override.md"],
  skillsDirectory: ".agents/skills",
  workspaceSkillsDirectory: ".agents/skills",
  home: "/home/agent",
  models: ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
  acceptsModel: acceptsCodexModel,
  modelOptions: codexFallbackModel,
  acceptsReasoningEffort: acceptsCodexReasoningEffort,
  async listModels(exec, key) {
    const catalog = await control(exec, "models");
    const account = parseSubscriptionMarker(key.value);
    const expected = account ? "chatgpt" : "apiKey";
    if (key.provider !== "openai" || !catalog || catalog.authType !== expected || (account && catalog.accountId !== account) || !Array.isArray(catalog.models)) {
      throw new Error("Codex model discovery is unavailable for this account");
    }
    return catalog.models;
  },
  defaultModel: "gpt-6.1-terra",
  modes: CODEX_MODES,
  providers: ["openai"],
  useKey(provider, value): KeyUse | { problem: string } {
    if (provider !== "openai") return { problem: "codex-app-server requires an OpenAI key or ChatGPT subscription reference" };
    if (value.startsWith("sk-") && value.length > 10) return { kind: "API key", env: { HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY }, wire: [{ target: OPENAI_API, header: "authorization", prefix: "Bearer " }] };
    const account = parseSubscriptionMarker(value);
    if (!account) return { problem: "use an OpenAI API key (sk-…) or host-managed ChatGPT subscription reference (codex-chatgpt:<account-id>)" };
    return { kind: "subscription", env: { HOUSEHOLD_CODEX_ACCOUNT: account, HOUSEHOLD_CODEX_TOKEN: createPlaceholderJwt(account) }, wire: [{ target: CHATGPT, header: "authorization", prefix: "Bearer " }] };
  },
  credentialHeaders: [{ target: CHATGPT, headers: ["authorization", "x-api-key"] }, { target: OPENAI_API, headers: ["authorization", "x-api-key"] }],
  env: ({ caCertPath, eventsUrl, mcpUrl, instructions, model, mode, reasoningEffort, home, workspace }) => ({
    ...(home === undefined ? {} : { HOME: home }),
    ...(workspace === undefined ? {} : { HOUSEHOLD_WORKSPACE: workspace }), CODEX_CA_CERTIFICATE: caCertPath, NODE_EXTRA_CA_CERTS: caCertPath,
    HOUSEHOLD_EVENTS_URL: eventsUrl, HOUSEHOLD_MCP_URL: mcpUrl, HOUSEHOLD_INSTRUCTIONS: instructions, HOUSEHOLD_MODEL: model, ...(reasoningEffort === undefined ? {} : { HOUSEHOLD_REASONING_EFFORT: reasoningEffort }), HOUSEHOLD_PERMISSION_MODE: mode ?? CODEX_MODES.default }),
  async isReady(exec) {
    const state = await control(exec, "status");
    return { ready: state?.ready === true, ...(state?.failure ? { output: String(state.failure) } : {}) };
  },
  async isIdle(exec) {
    const state = await control(exec, "status");
    return state?.ready === true && state.busy === false && state.dialog === false;
  },
  translate: translatePacket,
  dialogs: { ask: askOf, answer: answerFor },
  async send(exec, text, canSubmit) {
    if (!canSubmit()) return { status: "refused", reason: "a dialog is open" };
    const state = await control(exec, "status");
    if (!state?.ready || state.dialog) return { status: "refused", reason: "Codex is not ready for input" };
    if (!canSubmit()) return { status: "refused", reason: "a dialog opened" };
    const result = await control(exec, "send", { text });
    if (!result) return { status: "stuck", reason: "Codex did not acknowledge the input" };
    return result.sent ? { status: "sent" } : { status: "refused", reason: "Codex declined the input" };
  },
  sessionFile: ".household-codex-thread",
  async interrupt(exec) {
    const result = await control(exec, "interrupt");
    return { status: result?.status === "stopped" ? "stopped" : result?.status === "idle" ? "idle" : "failed" };
  },
  // A bridge that is gone (or only left its failure behind) counts as blocked, as an unreachable one always has.
  async dialogVisible(exec) { const state = await control(exec, "status"); return !state || state.failure !== undefined || state.dialog === true; },
};
