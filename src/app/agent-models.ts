import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentModel, Exec } from "../core/agent";
import { HouseholdError } from "../core/errors";
import type { Household } from "../core/household";
import type { AgentKey } from "../core/keys";
import { NotFoundError } from "../infra/config-store";
import { DEFAULT_AGENT, type Agents, type PlacedPet } from "./agents";
import type { AgentModelsView } from "./web-views";

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const fingerprint = (agent: string, key: AgentKey) => createHash("sha256").update(JSON.stringify([agent, key.name, key.provider, key.value])).digest("hex");

/** Keep only displayable public metadata. Neither a provider response nor a cache may introduce URLs/config. */
function publicModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("invalid model metadata");
  const result = new Map<string, AgentModel>();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || !ID.test(item.id)) continue;
    const label = typeof item.label === "string" ? item.label.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 160) : "";
    const description = typeof item.description === "string" ? item.description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 1200) : "";
    const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? [...new Map<string, { reasoningEffort: string; description: string }>(item.supportedReasoningEfforts.slice(0, 30).flatMap((option: unknown) => {
        if (!option || typeof option !== "object") return [];
        const { reasoningEffort, description } = option as Record<string, unknown>;
        return typeof reasoningEffort === "string" && ID.test(reasoningEffort)
          ? [[reasoningEffort, { reasoningEffort, description: typeof description === "string" ? description.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 1200) : "" }] as const] : [];
      })).values()] : undefined;
    const defaultReasoningEffort = typeof item.defaultReasoningEffort === "string" && supportedReasoningEfforts?.some(({ reasoningEffort }) => reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : undefined;
    result.set(item.id, { id: item.id, label: label || item.id, ...(description ? { description } : {}),
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}), ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) });
  }
  return [...result.values()];
}

export interface AgentModelsOptions {
  agents: Agents;
  configured(): Promise<Household>;
  /** Applied credentials/placements, rather than a possibly failed or in-flight config reload. */
  applied(): { keys: readonly AgentKey[]; pets: readonly PlacedPet[] };
  exec(house: string, pet: string): Exec;
  cacheFile: string;
  log?: (text: string) => void;
}

/** Native catalogs stay scoped to the exact configured credential, across restarts and key changes. */
export class AgentModels {
  private readonly cache = new Map<string, AgentModel[]>();
  private readonly requests = new Map<string, Promise<AgentModel[] | undefined>>();

  constructor(private readonly options: AgentModelsOptions) {
    try {
      const info = lstatSync(options.cacheFile);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) return;
      const saved = JSON.parse(readFileSync(options.cacheFile, "utf8"));
      if (saved.version !== 1 || !saved.catalogs || typeof saved.catalogs !== "object") return;
      chmodSync(options.cacheFile, 0o600);
      for (const [key, models] of Object.entries(saved.catalogs).slice(0, 100)) {
        if (/^[a-f0-9]{64}$/.test(key)) this.cache.set(key, publicModels(models));
      }
    } catch { /* Missing/corrupt metadata never changes which key or model a pet runs. */ }
  }

  async list(name: string, keyName: string): Promise<AgentModelsView> {
    const agent = this.options.agents.get(name);
    if (!agent) throw new NotFoundError(`unknown agent '${name}'`);
    const configured = await this.options.configured();
    const key = configured.keys.find(({ name }) => name === keyName);
    if (!key) throw new NotFoundError(`unknown key '${keyName}'`);
    const use = agent.useKey(key.provider, key.value);
    if ("problem" in use) throw new HouseholdError(use.problem);
    const id = fingerprint(name, key);
    let source: AgentModelsView["source"] = "default";
    let models: AgentModel[] | undefined;
    const applied = this.options.applied();
    const current = applied.keys.find(({ name }) => name === keyName);
    const candidate = current && fingerprint(name, current) === id
      ? applied.pets.find((pet) => pet.agent.name === name && pet.key === keyName)
      : undefined;
    if (agent.listModels && candidate) {
      let request = this.requests.get(id);
      if (!request) {
        request = (async () => {
          try {
            const result = publicModels(await agent.listModels!(this.options.exec(candidate.house, candidate.pet), key));
            const after = this.options.applied().keys.find(({ name }) => name === keyName);
            const latest = (await this.options.configured()).keys.find(({ name }) => name === keyName);
            if (!after || !latest || fingerprint(name, after) !== id || fingerprint(name, latest) !== id) return undefined;
            this.cache.delete(id); this.cache.set(id, result);
            while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
            this.persist();
            return result;
          } catch { return undefined; }
        })();
        this.requests.set(id, request);
        void request.finally(() => { if (this.requests.get(id) === request) this.requests.delete(id); });
      }
      models = await request;
      if (models) source = "live";
    }
    if (!models && this.cache.has(id)) { models = this.cache.get(id)!; source = "cache"; }
    if (!models) models = publicModels(agent.models.map((id) => agent.modelOptions?.(id) ?? { id, label: id }));
    // Preserve configured explicit selections without presenting an omitted model as account availability.
    const chosen = configured.houses.flatMap(({ pets }) => pets.filter((pet) => (pet.agent ?? DEFAULT_AGENT) === name && pet.key === keyName && pet.model).map(({ model }) => model!));
    // Older caches did not store effort metadata. Fill only missing fields from this exact model's
    // pinned options; an explicit empty native list remains authoritative.
    const selected = models.map((model) => {
      const fallback = agent.modelOptions?.(model.id);
      return source === "cache" && model.supportedReasoningEfforts === undefined && fallback?.supportedReasoningEfforts !== undefined
        ? { ...fallback, ...model } : model;
    });
    for (const model of chosen) if (ID.test(model) && !selected.some(({ id }) => id === model)) selected.push({ id: model, label: `${model} (unlisted)` });
    const latest = (await this.options.configured()).keys.find(({ name }) => name === keyName);
    if (!latest || fingerprint(name, latest) !== id) throw new HouseholdError("key changed while models were loading; load models again");
    return { models: selected, source };
  }

  private persist(): void {
    const file = this.options.cacheFile;
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify({ version: 1, catalogs: Object.fromEntries(this.cache) }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } catch { this.options.log?.("native model metadata could not be cached"); }
    finally { rmSync(temp, { force: true }); }
  }
}
