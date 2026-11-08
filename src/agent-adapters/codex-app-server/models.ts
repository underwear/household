import type { AgentModel } from "../../core/agent";

/** Accept provider-shaped explicit ids offline, never URLs, arbitrary labels, control chars or config syntax.
 * The native account catalog is a picker hint; the configured Codex thread verifies actual availability. */
export function acceptsCodexModel(id: string): boolean {
  return id.length <= 128 && /^(?:gpt-[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9]+)*|o[1-9][0-9]*(?:-[a-z0-9]+)*|codex-mini(?:-[a-z0-9]+)*)$/.test(id);
}

/** Public fields from the installed 0.162.1 ModelListResponse. Hidden entries never leave the bridge. */
export function codexModelOptions(data: unknown): AgentModel[] {
  if (!Array.isArray(data) || data.length > 1000) throw new Error("invalid Codex model catalog");
  const models = new Map<string, AgentModel>();
  for (const item of data) {
    if (!item || item.hidden !== false) continue;
    // `model`, rather than the catalog's record `id`, is the executable configuration slug.
    if (typeof item.model !== "string" || !acceptsCodexModel(item.model)) continue;
    const label = typeof item.displayName === "string" ? item.displayName.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 160) : "";
    const description = typeof item.description === "string" ? item.description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 1200) : "";
    const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter((option: any) => option && typeof option.reasoningEffort === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(option.reasoningEffort))
        .slice(0, 20).map((option: any) => ({ reasoningEffort: option.reasoningEffort, description: typeof option.description === "string" ? option.description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 1200) : "" }))
      : undefined;
    const defaultReasoningEffort = typeof item.defaultReasoningEffort === "string" && supportedReasoningEfforts?.some((option: { reasoningEffort: string }) => option.reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : undefined;
    models.set(item.model, { id: item.model, label: label || item.model, ...(description ? { description } : {}),
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}), ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) });
  }
  return [...models.values()];
}

// Observed from the pinned 0.162.1 app-server's credential-free built-in model/list.
// Unknown models (including Terra, absent from that offline list) need their live account catalog.
const EFFORTS = [
  { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
  { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
  { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];
const DEFAULTS: Record<string, string> = { "gpt-6.1-sol": "low", "gpt-6-astra": "low", "gpt-6-sol": "medium", "gpt-6-luna": "medium", "gpt-5.6-sol": "low", "gpt-5.6-terra": "medium", "gpt-5.6-luna": "medium", "gpt-5.5": "medium" };
export function codexFallbackModel(model: string): AgentModel {
  const defaultReasoningEffort = DEFAULTS[model];
  if (!defaultReasoningEffort) return { id: model, label: model };
  const count = model === "gpt-5.5" ? 4 : model.endsWith("-luna") ? 5 : 6;
  return { id: model, label: model, supportedReasoningEfforts: EFFORTS.slice(0, count), defaultReasoningEffort };
}
export function acceptsCodexReasoningEffort(model: string, effort: string): boolean {
  const options = codexFallbackModel(model).supportedReasoningEfforts;
  return acceptsCodexModel(model) && (options ? options.some(option => option.reasoningEffort === effort) : ["none", "minimal", ...EFFORTS.map(option => option.reasoningEffort)].includes(effort));
}
