import { createHash } from "node:crypto";
import { z } from "zod";
import { HouseholdError } from "../core/errors";
import { capabilityKind, scoutLimits, scoutNetwork, scoutProblems, blueprintCapabilities, type CapabilityDefinition } from "../core/scouts";
import { formatAllowEntry } from "../core/network-policy";
import { CAPABILITY_TEMPLATES } from "../builtin-capabilities";
import { capabilityDefinitionSchema, scoutAgentSchema, scoutDefinitionSchema, scoutLimitsSchema } from "../infra/config-schema";
import { ConfigStore, NotFoundError, ScoutRevisionError, capabilityDefinitionInput, scoutDefinitionInput } from "../infra/config-store";
import { isReservedSkillPath, SkillFileError } from "../infra/house-skills";
import type { ScoutStorage } from "../infra/scout-storage";
import type { Capabilities } from "./capabilities";
import type { CapabilityTests } from "./capability-test";
import { isPetLogSource, PET_LOG_SOURCES, type PetLogSource, type PetLogView } from "./pet-logs";
import type { Scouts, ScoutRun } from "./scouts";

export interface ScoutRoutesDeps {
  config: ConfigStore;
  storage: ScoutStorage;
  scouts: Pick<Scouts, "list" | "cancel"> & Partial<Pick<Scouts, "ownerSpawn">>;
  /** A run's VM, while it runs: a log inside it (as a pet's), and its agent's terminal screen (agents with one). */
  vm?: {
    log(house: string, run: string, source: PetLogSource, read: { lines?: number; after?: string }): Promise<PetLogView | undefined>;
    screen(house: string, run: string): Promise<{ text: string } | undefined>;
  };
  capabilities: Capabilities;
  tests?: CapabilityTests;
  apply(): Promise<unknown>;
  /** Secrets changed: the gateway takes them at once. */
  applySecrets(): Promise<unknown>;
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const document = (content: string) => ({ content, revision: createHash("sha256").update(content).digest("hex") });
const runView = (run: ScoutRun) => ({ id: run.id, scout: run.scout, ...(run.blueprint ? { blueprint: run.blueprint } : {}), ...(run.number ? { number: run.number } : {}), ...(run.byOwner ? { byOwner: true } : {}),
  capabilities: run.capabilities.map(c => c.name), parent: run.parent, task: run.task, status: run.status, steps: run.steps,
  ...(run.startedAt ? { startedAt: new Date(run.startedAt).toISOString() } : {}),
  ...(run.endedAt ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
  ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.reportText ? { report: run.reportText } : {}), ...(run.setupFailure ? { setupFailure: run.setupFailure } : {}),
});
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown; try { raw = await request.json(); } catch { throw new HouseholdError("The body must be JSON"); }
  const value = schema.safeParse(raw); if (!value.success) throw new HouseholdError(z.prettifyError(value.error)); return value.data;
}
const fileBody = z.strictObject({ path: z.string(), content: z.string().max(24 * 1024 * 1024), revision: z.string().nullable() });
const ended = (status: string) => ["done", "failed", "cancelled"].includes(status);
const keyBody = z.strictObject({
  secret: z.string(), value: z.string().min(1).max(4096), hosts: z.array(z.string()).min(1).max(20),
  via: z.enum(["gateway", "vm"]), env: z.string(), header: z.string().nullish(),
});

/** Mounted behind the existing owner authentication (and on the owner's private CLI socket). */
export function scoutRoutes(deps: ScoutRoutesDeps): (request: Request) => Promise<Response | undefined> {
  return async request => {
    const url = new URL(request.url), match = /^\/api\/houses\/([^/]+)\/(scouts|scout-runs|scout-limits|scout-agent|capabilities|capability-drafts|capability-templates)(?:\/([^/]+))?(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return undefined;
    try {
      const houseName = decodeURIComponent(match[1]!), area = match[2]!, name = match[3] && decodeURIComponent(match[3]), tail = match[4] ?? "";
      const config = await deps.config.load(), house = config.houses.find(h => h.name === houseName);
      if (!house) throw new NotFoundError("Unknown workspace");
      const runs = () => deps.scouts.list(houseName);
      const capabilities = house.capabilities ?? [];
      const envOf = (secret: string) => config.secrets.find(item => item.name === secret)?.env;
      const capabilityView = (capability: CapabilityDefinition) => ({
        ...capabilityDefinitionInput(capability), kind: capabilityKind(capability),
        ...(capability.owner ? { ownerTitle: (house.scouts ?? []).find(scout => scout.name === capability.owner)?.title ?? capability.owner } : {}),
        usedBy: capability.owner ? [capability.owner] : (house.scouts ?? []).filter(scout => scout.capabilities.includes(capability.name)).map(scout => scout.name),
        keyVariables: capability.keys.map(key => ({ secret: key.secret, via: key.via, env: key.via === "vm" ? key.env : envOf(key.secret) ?? "" })),
        lastTest: deps.tests?.last(houseName, capability.name) ?? null, testing: deps.tests?.busy(houseName, capability.name) ?? false,
        revisions: deps.capabilities.history(houseName, capability.name).length,
      });
      const draftView = (draft: ReturnType<Capabilities["drafts"]>[number]) => ({ ...draft, definition: capabilityDefinitionInput(draft.definition) });
      const scoutView = (scout: NonNullable<typeof house.scouts>[number]) => {
        const names = blueprintCapabilities(scout, capabilities), network = scoutNetwork({ capabilities: names, workspace: scout.workspace }, capabilities);
        const own = capabilities.find(c => c.owner === scout.name);
        return { ...scout, own: own ? capabilityView(own) : null, network: { open: network.open, allow: network.allow.map(formatAllowEntry), limitedBy: network.limitedBy },
          keysInVm: capabilities.filter(c => names.includes(c.name)).flatMap(c => c.keys.filter(k => k.via === "vm").map(k => ({ capability: c.name, env: k.via === "vm" ? k.env : "" }))),
          problems: scoutProblems({ capabilities: names }, capabilities, envOf) };
      };

      if (area === "scout-runs") {
        if (!name) return request.method === "GET" ? json(runs().map(runView)) : json({ error: "Not found" }, 404);
        const run = runs().find(r => r.id === name);
        if (!run) throw new NotFoundError("Unknown scout run");
        if (!tail && request.method === "GET") {
          return json({ ...runView(run), createdAt: new Date(run.createdAt).toISOString(), ...(run.runtime ? { runtime: run.runtime } : {}),
            files: run.files, secretRequests: run.secretRequests, networkRequests: run.networkRequests ?? [], tools: run.actions.reduce<Record<string, number>>((counts, action) => ({ ...counts, [action.tool]: (counts[action.tool] ?? 0) + 1 }), {}) });
        }
        if (!tail && request.method === "DELETE") { await deps.scouts.cancel({ house: houseName, pet: "owner" }, name); return json({ ok: true }); }
        if ((tail === "logs" || tail === "screen") && request.method === "GET") {
          if (!deps.vm) return json({ error: "Scout VMs are unavailable" }, 503);
          if (ended(run.status)) return json({ error: `The run has ended (${run.status}): its VM is gone` }, 409);
          if (tail === "screen") {
            const screen = await deps.vm.screen(houseName, name);
            return screen ? json(screen) : json({ error: "No terminal screen: its VM is not up yet, or its agent has none" }, 409);
          }
          const source = url.searchParams.get("source") ?? "setup";
          if (!isPetLogSource(source)) throw new HouseholdError(`source: ${Object.keys(PET_LOG_SOURCES).join(", ")}`);
          const lines = url.searchParams.get("lines"), after = url.searchParams.get("after");
          const view = await deps.vm.log(houseName, name, source, { ...(lines ? { lines: Number(lines) } : {}), ...(after ? { after } : {}) });
          return view ? json(view) : json({ error: "Its VM is not up yet" }, 409);
        }
        return json({ error: "Not found" }, 404);
      }
      if (area === "scout-limits") {
        if (name) return json({ error: "Not found" }, 404);
        if (request.method === "GET") return json(scoutLimits(house));
        if (request.method !== "PUT") return json({ error: "Not found" }, 404);
        const value = await body(request, scoutLimitsSchema);
        await deps.config.setScoutLimits(houseName, value); await deps.apply(); return json(value);
      }
      if (area === "scout-agent") {
        if (name) return json({ error: "Not found" }, 404);
        if (request.method === "GET") return json(house.scoutAgent ?? null);
        if (request.method !== "PUT") return json({ error: "Not found" }, 404);
        const value = await body(request, scoutAgentSchema);
        await deps.config.setScoutAgent(houseName, value); await deps.apply(); return json(value);
      }
      if (area === "capability-templates") {
        if (request.method !== "GET" || name) return json({ error: "Not found" }, 404);
        return json(CAPABILITY_TEMPLATES.map(template => ({ ...template, network: { any: template.network.any, allow: template.network.allow.map(formatAllowEntry) } })));
      }
      if (area === "capability-drafts") {
        if (!name) return request.method === "GET" ? json(deps.capabilities.drafts(houseName).map(draftView)) : json({ error: "Not found" }, 404);
        if (tail === "apply" && request.method === "POST") return json(await deps.capabilities.applyDraft(houseName, name));
        if (!tail && request.method === "DELETE") { deps.capabilities.discard(houseName, name); return json({ ok: true }); }
        return json({ error: "Not found" }, 404);
      }
      if (area === "capabilities") {
        if (!name) {
          if (request.method === "GET") return json({ capabilities: capabilities.filter(c => !c.owner).map(capabilityView), drafts: deps.capabilities.drafts(houseName).map(draftView) });
          if (request.method === "POST") { const value = await body(request, capabilityDefinitionSchema); if (capabilities.some(c => c.name === value.name)) throw new HouseholdError(`A capability named ${value.name} already exists`); const { owner: _owner, ...shared } = value; return json(await deps.capabilities.save(houseName, { ...shared, keys: [] }), 201); }
          return json({ error: "Not found" }, 404);
        }
        const capability = capabilities.find(c => c.name === name);
        if (!capability) throw new NotFoundError("Unknown capability");
        if (!tail) {
          if (request.method === "GET") return json({ capability: capabilityView(capability), history: deps.capabilities.history(houseName, name).map(revision => ({ ...revision, definition: capabilityDefinitionInput(revision.definition) })).reverse(), drafts: deps.capabilities.drafts(houseName).filter(d => d.capability === name).map(draftView) });
          if (request.method === "PUT") {
            const value = await body(request, capabilityDefinitionSchema);
            if (value.name !== name) throw new HouseholdError("A capability's name cannot be changed");
            // Keys are added and removed on their own (they create and remove secrets), its blueprint is fixed: a save keeps both.
            const { owner: _owner, ...fields } = value;
            return json(await deps.capabilities.save(houseName, { ...fields, keys: capability.keys, ...(capability.owner ? { owner: capability.owner } : {}) }));
          }
          if (request.method === "DELETE") {
            await deps.capabilities.remove(houseName, name); await deps.storage.removeCapability(houseName, name); deps.tests?.forget(houseName, name);
            return json({ ok: true });
          }
        }
        if (tail === "restore" && request.method === "POST") { const value = await body(request, z.strictObject({ rev: z.number().int().min(1) })); return json(await deps.capabilities.restore(houseName, name, value.rev)); }
        if (tail === "duplicate" && request.method === "POST" && !capability.owner) { const value = await body(request, z.strictObject({ as: z.string() })); return json(await deps.capabilities.duplicate(houseName, name, value.as), 201); }
        if (tail === "test" && request.method === "POST") {
          if (!deps.tests) return json({ error: "Tests are unavailable" }, 503);
          return json(await deps.tests.run(houseName, capability));
        }
        if (tail === "keys" && request.method === "POST") {
          const value = await body(request, keyBody);
          if (config.secrets.some(secret => secret.name === value.secret)) throw new HouseholdError(`A secret named ${value.secret} already exists`);
          await deps.config.addSecret(value.secret, { value: value.value, hosts: value.hosts, env: value.env, header: value.header ?? null, houses: [houseName], onlyForCapabilities: [name] });
          try {
            await deps.capabilities.save(houseName, { ...capability, keys: [...capability.keys, value.via === "vm" ? { secret: value.secret, via: "vm", env: value.env } : { secret: value.secret, via: "gateway" }] });
          } catch (error) { await deps.config.removeSecret(value.secret).catch(() => {}); throw error; }
          await deps.applySecrets(); return json({ ok: true }, 201);
        }
        const keyMatch = /^keys\/([^/]+)$/.exec(tail);
        if (keyMatch && request.method === "DELETE") {
          const secret = decodeURIComponent(keyMatch[1]!);
          if (!capability.keys.some(key => key.secret === secret)) throw new NotFoundError("Unknown key");
          await deps.capabilities.save(houseName, { ...capability, keys: capability.keys.filter(key => key.secret !== secret) });
          await deps.config.removeSecret(secret); await deps.applySecrets(); return json({ ok: true });
        }
        if (tail === "skills" && request.method === "GET") return json(await deps.storage.skills(houseName, name).list());
        if (tail === "skills/file") {
          const skills = deps.storage.skills(houseName, name);
          if (request.method === "GET") return json(await skills.read(url.searchParams.get("path") ?? ""));
          if (request.method === "PUT") {
            const value = await body(request, fileBody); if (isReservedSkillPath(value.path)) throw new HouseholdError("Names starting with household- are Household's own skills");
            return json(await skills.write(value.path, value.content, value.revision));
          }
          if (request.method === "DELETE") { const value = await body(request, z.strictObject({ path: z.string(), revision: z.string() })); return json(await skills.delete(value.path, value.revision)); }
        }
        return json({ error: "Not found" }, 404);
      }

      // Scouts.
      if (!name) {
        if (request.method === "GET") return json({ scouts: (house.scouts ?? []).map(scoutView), capabilities: capabilities.filter(c => !c.owner).map(capabilityView), runs: runs().map(runView), limits: scoutLimits(house), agent: house.scoutAgent ?? null });
        if (request.method === "POST") {
          const value = await body(request, scoutDefinitionSchema);
          if (value.capabilities.some(c => capabilities.find(each => each.name === c)?.owner)) throw new HouseholdError("A blueprint ticks shared capabilities only");
          const problems = scoutProblems(value, capabilities, envOf); if (problems.length) throw new HouseholdError(problems.join("; "));
          await deps.config.addScout(houseName, value); await deps.apply(); return json({ scout: scoutView(value) }, 201);
        }
        return json({ error: "Not found" }, 404);
      }
      const scout = house.scouts?.find(s => s.name === name);
      if (!scout) throw new NotFoundError("Unknown scout");
      if (!tail) {
        if (request.method === "GET") return json({ scout: scoutView(scout), capabilities: capabilities.filter(c => !c.owner).map(capabilityView), runs: runs().filter(r => r.blueprint === name).map(runView), defaults: { agent: house.scoutAgent ?? null, limits: scoutLimits(house) } });
        if (request.method === "PATCH") {
          const fields = await body(request, z.record(z.string(), z.unknown()));
          const merged: Record<string, unknown> = { ...scoutDefinitionInput(scout), ...fields };
          for (const optional of ["title", "emoji", "workspace", "agent", "resources"]) if (merged[optional] === null) delete merged[optional];
          const parsed = scoutDefinitionSchema.safeParse(merged);
          if (!parsed.success) throw new HouseholdError(z.prettifyError(parsed.error));
          if (parsed.data.capabilities.some(c => capabilities.find(each => each.name === c)?.owner)) throw new HouseholdError("A blueprint ticks shared capabilities only");
          const problems = scoutProblems({ capabilities: blueprintCapabilities(parsed.data, capabilities) }, capabilities, envOf); if (problems.length) throw new HouseholdError(problems.join("; "));
          await deps.config.updateScout(houseName, name, parsed.data); await deps.apply(); return json({ scout: scoutView(parsed.data) });
        }
        if (request.method === "DELETE") {
          if (runs().some(r => r.blueprint === name && !ended(r.status))) return json({ error: "Stop this scout's running jobs before deleting it" }, 409);
          // Its own capability goes with it (history, skills, test); its keys stay, kept for no one.
          const own = capabilities.find(c => c.owner === name);
          if (own) { await deps.capabilities.remove(houseName, own.name); await deps.storage.removeCapability(houseName, own.name); deps.tests?.forget(houseName, own.name); }
          await deps.config.removeScout(houseName, name); await deps.apply(); return json({ ok: true });
        }
      }
      // The owner starts it themself: no Run card.
      if (tail === "runs" && request.method === "POST") {
        if (!deps.scouts.ownerSpawn) return json({ error: "Scouts are unavailable" }, 503);
        const value = await body(request, z.strictObject({ task: z.string(), pet: z.string().optional(), place: z.string().optional(), placement: z.enum(["same", "thread"]).optional() }));
        return json(await deps.scouts.ownerSpawn(houseName, name, value), 201);
      }
      // A blueprint's own capability: created here, edited on its capability page, deleted with the blueprint.
      if (tail === "own" && request.method === "POST") {
        if (capabilities.some(c => c.owner === name)) throw new HouseholdError("This blueprint already has its own capability");
        if (capabilities.some(c => c.name === name)) throw new HouseholdError(`A shared capability is already named ${name}: rename one of them`);
        return json(await deps.capabilities.save(houseName, { name, description: `${scout.title ?? name}'s own`, install: "", network: { any: true, allow: [] }, keys: [], owner: name }), 201);
      }
      if (tail === "instructions") {
        if (request.method === "GET") return json(document(scout.instructions));
        if (request.method === "PUT") {
          const value = await body(request, z.strictObject({ content: z.string().max(100_000), revision: z.string() }));
          await deps.config.updateScoutDocument(houseName, name, "instructions", value.content, value.revision); await deps.apply(); return json(document(value.content));
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const status = error instanceof NotFoundError ? 404 : error instanceof ScoutRevisionError ? 409 : error instanceof SkillFileError ? error.status : 400;
      return json({ error: error instanceof Error ? error.message : "Scout request failed" }, status);
    }
  };
}
