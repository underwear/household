import { googleOAuthCookieName } from "./google-connector-routes";
import type { HouseInboxes } from "./house-inboxes";
import { houseInboxSchema, inboxSubscriberSchema } from "../core/house-inboxes";
import { resolveSlackDm } from "../channel-adapters/slack/setup";
import type { Previews } from "./previews";
import { houseFeatures, previewSettings, houseFeatureSettingsSchema } from "../core/house-features";
import { sideworkerProfileProblems } from "./agents";
import { sideworkerProfilesSchema } from "../infra/config-schema";
import type { Sideworkers } from "./sideworkers";
import { DEFAULT_SIDEWORKER_LIMITS, sideworkerLimitsSchema, beyondHost } from "../core/resources";
import { petCpuSchema, petMemorySchema, petResources, type HostCapacity } from "../core/resources";
import { hostCapacity } from "../infra/host";
import type { Monitoring } from "./monitoring";
import type { PetMemory } from "./memory";
import { MemoryError, memoryWrite, memoryDelete } from "../core/memory";
import { householdTimezone, validTimezone } from "../core/timezone";
import type { Crons } from "./crons";
import { CronError, cronFields } from "../core/cron";
import { PetInstructions, InstructionFileError } from "../infra/pet-instructions";
import { HouseSkills, PetSkills, SkillFileError, builtinSkills, isBuiltinLink, isReservedSkillPath, PERSONAL_SKILLS } from "../infra/house-skills";
import type { PetEnvironment } from "./environment";
import { z } from "zod";
import { HouseholdError } from "../core/errors";
import { channelKey, channelName, defaultPet } from "../core/channels";
import { DEFAULT_PET_EMOJI } from "../core/emoji";
import { findHouse, petDisplay, petTitle, type House, type Household } from "../core/household";
import { PET_NAME_PATTERN } from "../core/names";
import { formatAllowEntry, sameEndpoint } from "../core/network-policy";
import { NOTE_MAX } from "../infra/config-schema";
import { NotFoundError, type ConfigStore } from "../infra/config-store";
import type { EventLog } from "../infra/event-log";
import type { WebHandler } from "../infra/web-server";
import { PROVIDERS } from "../core/keys";
import type { AgentModels } from "./agent-models";
import { agentHosts, agentOf, DEFAULT_AGENT, type Agents } from "./agents";
import { checkFields, fieldsShown, type ChannelChecks } from "./channel-fields";
import { keyViews, secretViews } from "./keys";
import { ownerProblem, type ChannelKinds, type Platforms } from "./kinds";
import type { PetStatus } from "./pet-plane";
import { requestDomain, requestPort, type NetworkRequests } from "./network-requests";
import { clearedCookie, cookieValue, sessionCookie, sessionCookieName, type WebAuth } from "./web-auth";
import type { AgentView, HouseView, KeysView, MeView, WriteView } from "./web-views";
import type { Allowance } from "../core/allowance";
import { LOG_KINDS, readLog, type LogKind } from "./household-log";
import { isPetLogSource, PET_LOG_SOURCES, type PetLogSource, type PetLogView } from "./pet-logs";
import { DEFAULT_LIFECYCLE, lifecycleSchema } from "../core/lifecycle";

const RESERVED_SKILL = "Names starting with household- are Household's own skills";
/** The skill a newly written file starts, when it is a skill's SKILL.md. */
const newSkill = (path: string) => /^([^/]+)\/SKILL\.md$/.exec(path)?.[1];

export interface WebRoutesDeps {
  connectorRoutes?: (request: Request) => Promise<Response | undefined>;
  scoutRoutes?: (request:Request)=>Promise<Response|undefined>;
  previews?: Pick<Previews, "list" | "close">;
  sideworkers?: Pick<Sideworkers, "list" | "closeForOwner" | "expanded">;
  auth: WebAuth;
  skills?: HouseSkills;
  petSkills?: PetSkills;
  /** The owner made a new skill (its SKILL.md): a house's shared one (no `pet`) or a pet's own. Tells the pets. */
  skillAdded?(house: string, pet: string | undefined, name: string): void;
  instructions?: PetInstructions;
  crons?: Crons;
  houseInboxes?: HouseInboxes;
  memory?: PetMemory;
  monitoring?: Pick<Monitoring, "history"> & Partial<Pick<Monitoring, "latest">>;
  config: ConfigStore;
  agents: Agents;
  /** The kinds of channel this build knows, with their fields. */
  channelKinds: ChannelKinds;
  /** What checks their fields a form gives (a bot token: its shape, with Telegram) and says what a value is. */
  checks: ChannelChecks;
  /** Their platforms (what an owner's id is). */
  platforms: Platforms;
  /** The daemon's reload (the same as `house reload`). */
  apply: () => Promise<unknown>;
  /** Update gateway secret rules without restarting pet sessions. */
  applySecrets?: () => Promise<unknown>;
  petStates: () => Promise<PetStatus[]>;
  /** A key's allowance as its provider last said it (the gateway's meter); undefined when it never did. */
  allowances?: (key: string) => Allowance | undefined;
  /** Why a house's channel (by key) is not open, if it is not. */
  channelProblem: (house: string, key: string) => string | undefined;
  state: () => MeView["state"];
  version: string;
  events: EventLog;
  networkRequests?: Pick<NetworkRequests, "active" | "revoke">;
  environment?: PetEnvironment;
  modelCatalog?: Pick<AgentModels, "list">;
  terminalSnapshot?: (house: string, pet: string, agent: string) => Promise<{ text: string } | undefined>;
  /** The Household log (events.jsonl), read by `/api/logs`. */
  eventLog?: string;
  /** One of a pet's logs in its VM; undefined when the VM is not running. */
  petLog?: (house: string, pet: string, source: PetLogSource, read: { lines?: number; after?: string }) => Promise<PetLogView | undefined>;
  /** The machine's CPUs and memory, what the forms weigh a pet's against; this one's when not given. */
  host?: HostCapacity;
}

/** The web routes, and the same API without a browser session for the daemon's own control socket (the CLI). */
export type ApiHandler = WebHandler & { local: (request: Request) => Promise<Response> };

/** A query parameter as a whole number from 0, or undefined when it is not there; a 400 when it is not one. */
function count(query: URLSearchParams, name: string): number | undefined {
  const value = query.get(name);
  if (value === null || value === "") return undefined;
  if (!/^\d{1,12}$/.test(value)) throw new HouseholdError(`${name} must be a whole number`);
  return Number(value);
}

/** A request to an API route: the parts its pattern captured, decoded. */
interface Call {
  request: Request;
  params: string[];
}

type Route = [method: string, pattern: RegExp, handle: (call: Call) => Promise<Response>];

const nameBody = z.strictObject({ name: z.string() });
const hostBody = z.strictObject({ host: z.string() });
const hostsBody = z.strictObject({ hosts: z.array(z.string()).min(1).max(50) });
const ownerBody = z.strictObject({ platform: z.string(), id: z.string(), note: z.string().nullish() });
const ownerNoteBody = z.strictObject({ note: z.string().nullable() });
// A field left out stays as it is; null (or "") removes it. The config's own rules check the values.
const optional = z.string().nullish();
const petFields = { cpus: petCpuSchema.nullish(), memoryMiB: petMemorySchema.nullish(), enabled: z.boolean().optional(), title: optional, emoji: optional, aliases: z.array(z.string()).nullish(), agent: optional, model: optional, reasoningEffort: optional, mode: optional, settings: z.record(z.string(), z.string().nullable()).nullish(), key: optional, lifecycle: lifecycleSchema.nullish() };
const newKeyBody = z.strictObject({ name: z.string(), provider: z.string(), value: z.string(), note: optional, houses: z.array(z.string()).nullish(), allowOverage: z.boolean().nullish() });
const keyBody = z.strictObject({ provider: z.string().optional(), value: z.string().optional(), note: optional, houses: z.array(z.string()).nullish(), allowOverage: z.boolean().nullish() });
const secretFields = { onlyForCapabilities: z.array(z.string()).nullish(), value: z.string().optional(), hosts: z.array(z.string()).max(20).optional(), header: optional, env: z.string().optional(), note: optional };
const newSecretBody = z.strictObject({ name: z.string(), ...secretFields });
const secretBody = z.strictObject(secretFields);
// `channels`: the chats of the house's channels it joins as it is added.
const newPetBody = z.strictObject({ name: z.string(), channels: z.array(z.string()).max(50).optional(), ...petFields });
const petBody = z.strictObject(petFields);
// The fields every channel has, and its chat (given when it is added, never changed: another chat is another
// channel); its kind's own (token, …) are strings, checked against the kind's descriptor (`ownFields`), then by
// the config's rules.
const commonChannel = { name: optional, note: optional, pets: z.array(z.string()).optional(), default: optional };
const newChannelBody = z.object({ kind: z.string(), chat: z.string(), slackMember: z.string().optional(), ...commonChannel }).catchall(z.string());
const NO_NEW_CHAT = "a channel's chat names it: another chat is another channel (remove this one, add that one)";
const channelBody = z.object({ chat: z.never({ error: NO_NEW_CHAT }).optional(), ...commonChannel }).catchall(z.string());

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const failure = (status: number, error: string) => json({ error }, status);

/** A message for the browser: absolute paths (the config's, the state dir's) cut to their last part. */
export const withoutPaths = (message: string) => message.replace(/(?<![\w.:/])\/(?:[^\s/'"():]+\/)*([^\s/'"():]+)/g, "$1");

/** A request's JSON body checked against `schema`; a HouseholdError (so a 400) when it does not fit. */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HouseholdError("the body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HouseholdError(z.prettifyError(parsed.error));
  return parsed.data;
}

/** A failed reload after a write (the reload logs why): the change is in household.yaml all the same. */
class NotApplied extends Error {}

/**
 * The web UI's routes: `/login` (a sign-in link) and the JSON API under `/api/`, all but sign-in and sign-out for
 * a signed-in browser only. Writes go to household.yaml through the ConfigStore, as the CLI's do, then the same
 * reload as `house reload`.
 */
export function webRoutes(deps: WebRoutesDeps): ApiHandler {
  const { auth, config, events } = deps;
  const host = deps.host ?? hostCapacity();
  const loadEffective = async () => {
    const household = await config.load();
    return deps.sideworkers?.expanded(household) ?? household;
  };

  const agents: AgentView[] = [...deps.agents.values()].map(({ name, models, defaultModel, modes, settings, providers, listModels, modelOptions, terminalSnapshot }) => ({
    name,
    terminal: !!terminalSnapshot,
    models,
    defaultModel,
    dynamicModels: !!listModels,
    modelOptions: models.map((id) => modelOptions?.(id) ?? { id, label: id }),
    modes: modes ? modes.options.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) })) : [],
    defaultMode: modes?.default ?? null,
    settings: settings?.map((setting) => ({ ...setting, options: [...setting.options] })) ?? [],
    providers,
  }));
  const channelKinds = [...deps.channelKinds.values()];
  // What a form needs of a platform (its check is the server's).
  const platforms = [...deps.platforms.values()].map(({ valid: _, ...view }) => view);

  /**
   * A channel's own fields as a request gives them, checked against its kind: only the kind's fields; when it is
   * added, every one of them, and its chat.
   */
  const ownFields = (kind: string, own: Record<string, string>, added?: { chat: string }): void => {
    const spec = deps.channelKinds.get(kind);
    if (!spec) throw new HouseholdError(`unknown channel kind '${kind}' (known: ${[...deps.channelKinds.keys()].join(", ")})`);
    for (const key of Object.keys(own)) {
      if (!spec.fields.some((field) => field.key === key)) throw new HouseholdError(`a ${spec.label} channel has no field '${key}' (its fields: ${spec.fields.map((field) => field.key).join(", ")})`);
    }
    if (!added) return;
    for (const field of [spec.chat, ...spec.fields]) if (!(field === spec.chat ? added.chat : own[field.key])?.trim()) throw new HouseholdError(`${field.label} is required`);
  };

  const houseView = (house: House, states: PetStatus[], keys: Household["keys"]): HouseView => {
    const own = house.network.allow;
    const implied = agentHosts(deps.agents, house, keys).filter((host) => !own.some((entry) => sameEndpoint(entry, host)));
    return {
      name: house.name,
      features: houseFeatures(house),
      preview: previewSettings(house),
      sideworkerLimits: house.sideworkerLimits ?? DEFAULT_SIDEWORKER_LIMITS,
      sideworkerProfiles: house.sideworkerProfiles ?? [],
      allow: [
        ...own.map((host) => ({ host: formatAllowEntry(host), byAgent: false, ...(host.reach ? { granted: true } : {}) })),
        ...implied.map((host) => ({ host: formatAllowEntry(host), byAgent: true })),
      ],
      ...(deps.networkRequests ? { temporary: deps.networkRequests.active(house.name) } : {}),
      owners: house.people.owners.map((owner) => ({ platform: owner.platform, id: owner.id, note: owner.note ?? null, problem: ownerProblem(deps.platforms, owner) ?? null })),
      channels: house.channels.map((channel) => ({
          kind: channel.kind,
          platform: deps.channelKinds.get(channel.kind)?.platform ?? "",
          label: deps.channelKinds.get(channel.kind)?.label ?? channel.kind,
          name: channelName(deps.channelKinds, channel),
          ownName: channel.name ?? null,
          note: channel.note ?? null,
          fields: Object.fromEntries((deps.channelKinds.get(channel.kind)?.fields ?? []).map(({ key }) => [key, String((channel as unknown as Record<string, unknown>)[key] ?? "")])),
          shown: fieldsShown(deps.checks, channel),
          chat: channel.chat,
          pets: channel.pets.filter(name => !house.pets.find(pet => pet.name === name)?.sideworker),
          default: defaultPet(channel) ?? null,
          problem: deps.channelProblem(house.name, channelKey(channel)) ?? null,
        })),
      pets: house.pets.map((pet) => {
        // A pet whose agent, model or key is wrong (typed in by hand) is shown, marked: the page can fix it.
        const found = agentOf(deps.agents, pet, keys, house.name);
        const agent = pet.agent ?? DEFAULT_AGENT;
        return {
          name: pet.name,
          ...(pet.sideworker ? { sideworker: pet.sideworker } : {}),
          enabled: pet.enabled !== false,
          title: petTitle(pet),
          display: petDisplay(pet),
          ownTitle: pet.title ?? null,
          emoji: pet.emoji ?? DEFAULT_PET_EMOJI,
          ownEmoji: pet.emoji ?? null,
          aliases: pet.aliases ?? [],
          agent,
          model: "problem" in found ? (pet.model ?? deps.agents.get(agent)?.defaultModel ?? "") : found.model,
          ...petResources(pet),
          reasoningEffort: pet.reasoningEffort ?? null,
          settings: pet.settings ?? {},
          lifecycle: pet.lifecycle ?? null,
          mode: "problem" in found ? (pet.mode ?? deps.agents.get(agent)?.modes?.default ?? null) : (found.mode ?? null),
          key: pet.key ?? null,
          problem: "problem" in found ? found.problem : null,
          state: states.find((status) => status.house === house.name && status.pet === pet.name)?.state ?? "missing",
        };
      }),
    };
  };
  const viewOf = async (household: Household, name: string) => {
    const effective = deps.sideworkers?.expanded(household) ?? household;
    const house = findHouse(effective, name);
    return house && houseView(house, await deps.petStates(), household.keys);
  };

  /** After a write to the keys: the reload, and the keys as written. */
  const keysWritten = async (household: Household, what: string, status = 200): Promise<Response> => {
    events.info(`web: key ${what}`);
    try {
      await deps.apply();
    } catch {
      throw new NotApplied();
    }
    return json({ keys: keyViews(deps.agents, household, deps.allowances) } satisfies KeysView, status);
  };

  /** After a write to the secrets: the reload, and the secrets as written (never their values in the log). */
  const secretsWritten = async (household: Household, houseName: string, what: string, status = 200): Promise<Response> => {
    events.info(`web: secret ${what}`);
    try {
      await (deps.applySecrets ?? deps.apply)();
    } catch {
      throw new NotApplied();
    }
    return json({ secrets: secretViews(household.houses.find(house => house.name === houseName)!) }, status);
  };

  /** After a write: the reload, and the answer with the house as written (none for a delete). */
  const written = async (household: Household, name: string, what: string, status = 200): Promise<Response> => {
    events.info(`web: workspace ${name} ${what}`);
    try {
      await deps.apply();
    } catch {
      throw new NotApplied();
    }
    return json({ house: await viewOf(household, name) } satisfies WriteView, status);
  };
  /** A route under one house's path, e.g. `at("/pets/([^/]+)")`. */
  const at = (path: string) => new RegExp(`^/api/houses/([^/]+)${path}$`);

  const instructionTarget = async (house: string, pet: string) => {
    const configured = findHouse(await loadEffective(), house)?.pets.find(item => item.name === pet);
    if (!configured) throw new NotFoundError("bot not found");
    const adapter = deps.agents.get(configured.agent ?? DEFAULT_AGENT);
    if (!adapter?.instructionsFile || !deps.instructions) throw new InstructionFileError("Instructions are unavailable for this adapter", 503);
    return { store: deps.instructions, adapter };
  };
  const skills = async (house: string) => {
    if (!findHouse(await config.load(), house)) throw new NotFoundError("workspace not found");
    if (!deps.skills) throw new SkillFileError("Skills unavailable", 503);
    return deps.skills;
  };
  const petSkills = async (house: string, pet: string) => {
    const configured = findHouse(await loadEffective(), house)?.pets.find(item => item.name === pet);
    if (!configured) throw new NotFoundError("bot not found");
    const adapter = deps.agents.get(configured.agent ?? DEFAULT_AGENT);
    if (!adapter?.workspaceSkillsDirectory || !deps.petSkills) throw new SkillFileError("Workspace skills are unavailable for this adapter", 503);
    const home = configured.sideworker?.parentHome ?? adapter.home;
    const cwd = configured.sideworker?.cwd ?? `${home}/work`;
    if (cwd !== home && !cwd.startsWith(`${home}/`)) throw new SkillFileError("The skills editor is available for working directories in the shared bot home", 409);
    const relative = cwd.slice(home.length).replace(/^\//, "");
    // A pet's own are in .agents/skills, which every harness reads (infra/guest-skills.ts links them); a
    // sideworker's directory is a project unless it shares the parent's personal workspace.
    // In that workspace use the canonical directory rather than following the harness symlink on the host.
    const personalWorkspace = cwd === `${home}/work`;
    const directory = !configured.sideworker || personalWorkspace ? PERSONAL_SKILLS.slice("work/".length) : adapter.workspaceSkillsDirectory;
    const target = [relative, directory].filter(Boolean).join("/");
    return { files: deps.petSkills.at(house, configured.sideworker?.parent ?? pet, target), path: `${cwd}/${directory}` };
  };
  const fileBody = z.strictObject({ path: z.string(), content: z.string(), revision: z.string().nullable() });
  const routes: Route[] = [
    ["PUT", at("/features"), async ({ request, params: [house] }) => {
      const settings = await bodyOf(request, houseFeatureSettingsSchema);
      return written(await config.setHouseFeatures(house!, settings), house!, "house features changed");
    }],
    ["GET", at("/sideworkers"), async ({ params: [house] }) => {
      if (!findHouse(await config.load(), house!)) throw new NotFoundError("workspace not found");
      return json(deps.sideworkers?.list(house!) ?? []);
    }],
    ["DELETE", at("/sideworkers/([^/]+)"), async ({ params: [house, name] }) => {
      if (!deps.sideworkers?.list(house!).some(worker => worker.name === name)) throw new NotFoundError("sideworker not found");
      await deps.sideworkers.closeForOwner(house!, name!);
      return json({ ok: true });
    }],
    ["PUT", at("/sideworker-profiles"), async ({ request, params: [house] }) => {
      const { profiles } = await bodyOf(request, z.strictObject({ profiles: sideworkerProfilesSchema }));
      const household = await config.load();
      const current = findHouse(household, house!);
      if (!current) throw new NotFoundError("workspace not found");
      const problems = sideworkerProfileProblems(deps.agents, { ...current, sideworkerProfiles: profiles }, household.keys);
      if (problems.length) throw new HouseholdError(problems.join("; "));
      return written(await config.setSideworkerProfiles(house!, profiles), house!, "sideworker profiles changed");
    }],
    ["PUT", at("/sideworker-limits"), async ({ request, params: [house] }) => {
      const limits = await bodyOf(request, sideworkerLimitsSchema);
      const problems = beyondHost(limits, host);
      if (problems.length) throw new HouseholdError(problems.join("; "));
      return written(await config.setSideworkerLimits(house!, limits), house!, "sideworker limits changed");
    }],
    ["GET", /^\/api\/timezone$/, async () => json({ timezone: householdTimezone((await config.load()).timezone) })],
    ["PUT", /^\/api\/timezone$/, async ({ request }) => {
      const { timezone } = await bodyOf(request,z.strictObject({timezone:z.string().max(100).refine(validTimezone,"Expected an IANA timezone")}));
      await config.setTimezone(timezone);
      try { await deps.apply(); } catch { throw new NotApplied(); }
      events.info(`web: Household timezone changed to ${timezone}`);
      return json({timezone});
    }],
    ["GET", at("/skills"), async ({ params: [house] }) => json((await (await skills(house!)).list(house!)).filter((entry) => !isBuiltinLink(entry, builtinSkills().map((skill) => skill.name))))],
    ["GET", /^\/api\/builtin-skills$/, async () => json(builtinSkills())],
    ["GET", at("/skills/file"), async ({ request, params: [house] }) => json(await (await skills(house!)).read(house!, new URL(request.url).searchParams.get("path") ?? ""))],
    ["PUT", at("/skills/file"), async ({ request, params: [house] }) => {
      const store = await skills(house!); const b = await bodyOf(request, fileBody);
      if (isReservedSkillPath(b.path)) throw new SkillFileError(RESERVED_SKILL, 400);
      const written = await store.write(house!, b.path, b.content, b.revision);
      if (b.revision === null && newSkill(b.path)) deps.skillAdded?.(house!, undefined, newSkill(b.path)!);
      return json(written);
    }],
    ["DELETE", at("/skills/file"), async ({ request, params: [house] }) => {
      const store = await skills(house!); const b = await bodyOf(request, z.strictObject({path:z.string(), revision:z.string()}));
      return json(await store.delete(house!, b.path, b.revision));
    }],
    ["GET", at("/pets/([^/]+)/skills"), async ({ params: [house, pet] }) => {
      const { files, path } = await petSkills(house!, pet!);
      return json({ path, entries: await files.list() });
    }],
    ["GET", at("/pets/([^/]+)/skills/file"), async ({ request, params: [house, pet] }) => json(await (await petSkills(house!, pet!)).files.read(new URL(request.url).searchParams.get("path") ?? ""))],
    ["PUT", at("/pets/([^/]+)/skills/file"), async ({ request, params: [house, pet] }) => {
      const { files } = await petSkills(house!, pet!); const b = await bodyOf(request, fileBody);
      if (isReservedSkillPath(b.path)) throw new SkillFileError(RESERVED_SKILL, 400);
      const written = await files.write(b.path, b.content, b.revision);
      if (b.revision === null && newSkill(b.path)) deps.skillAdded?.(house!, pet!, newSkill(b.path)!);
      return json(written);
    }],
    ["DELETE", at("/pets/([^/]+)/skills/file"), async ({ request, params: [house, pet] }) => {
      const { files } = await petSkills(house!, pet!); const b = await bodyOf(request, z.strictObject({path:z.string(), revision:z.string()}));
      return json(await files.delete(b.path, b.revision));
    }],
    ["GET", /^\/api\/me$/, async () => json({ version: deps.version, state: deps.state(), agents, channelKinds, platforms, providers: PROVIDERS, noteMax: NOTE_MAX, host } satisfies MeView)],
    ["GET", /^\/api\/agents\/([^/]+)\/models$/, async ({ request, params: [agent] }) => {
      const key = new URL(request.url).searchParams.get("key");
      if (!key) throw new HouseholdError("choose a key before loading native models");
      if (!deps.modelCatalog) return failure(503, "native model discovery is unavailable");
      return json(await deps.modelCatalog.list(agent!, key));
    }],
    ["GET", /^\/api\/houses$/, async () => {
      const [household, states] = await Promise.all([loadEffective(), deps.petStates()]);
      return json(household.houses.map((house) => houseView(house, states, household.keys)));
    }],
    ["GET", /^\/api\/keys$/, async () => json(keyViews(deps.agents, await config.load(), deps.allowances))],
    ["POST", /^\/api\/keys$/, async ({ request }) => {
      const { name, ...fields } = await bodyOf(request, newKeyBody);
      return keysWritten(await config.addKey(name, fields), `${name} added`, 201);
    }],
    ["PATCH", /^\/api\/keys\/([^/]+)$/, async ({ request, params: [name] }) => {
      const fields = await bodyOf(request, keyBody);
      const effective = await loadEffective();
      const keys = effective.keys.map(key => key.name !== name ? key : { ...key,
        ...(fields.provider === undefined ? {} : { provider: fields.provider as typeof key.provider }),
        ...(fields.value === undefined ? {} : { value: fields.value.trim() }),
        ...(fields.houses === undefined ? {} : { houses: fields.houses ?? undefined }),
      });
      for (const house of effective.houses) for (const pet of house.pets.filter(pet => pet.sideworker && pet.key === name)) {
        const found = agentOf(deps.agents, pet, keys, house.name);
        if ("problem" in found) throw new HouseholdError(`sideworker ${house.name}/${pet.name}: ${found.problem}`);
      }
      return keysWritten(await config.updateKey(name!, fields), `${name} changed`);
    }],
    ["DELETE", /^\/api\/keys\/([^/]+)$/, async ({ params: [name] }) => {
      const active = (await loadEffective()).houses.flatMap(house => house.pets.filter(pet => pet.sideworker && pet.key === name).map(pet => `${house.name}/${pet.name}`));
      if (active.length) throw new HouseholdError(`key '${name}' is used by sideworkers: ${active.join(", ")}; close them first`);
      return keysWritten(await config.removeKey(name!), `${name} removed`);
    }],
    ["GET", /^\/api\/houses\/([^/]+)\/secrets$/, async ({ params: [houseName] }) => {
      const house = (await config.load()).houses.find(house => house.name === houseName);
      if (!house) throw new NotFoundError(`unknown workspace '${houseName}'`);
      return json(secretViews(house));
    }],
    ["POST", /^\/api\/houses\/([^/]+)\/secrets$/, async ({ request, params: [houseName] }) => {
      const { name, ...fields } = await bodyOf(request, newSecretBody);
      return secretsWritten(await config.addSecret(houseName!, name, fields), houseName!, `${houseName}/${name} added`, 201);
    }],
    ["PATCH", /^\/api\/houses\/([^/]+)\/secrets\/([^/]+)$/, async ({ request, params: [houseName, name] }) =>
      secretsWritten(await config.updateSecret(houseName!, name!, await bodyOf(request, secretBody)), houseName!, `${houseName}/${name} changed`)],
    ["DELETE", /^\/api\/houses\/([^/]+)\/secrets\/([^/]+)$/, async ({ params: [houseName, name] }) => secretsWritten(await config.removeSecret(houseName!, name!), houseName!, `${houseName}/${name} removed`)],
    ["POST", /^\/api\/houses$/, async ({ request }) => {
      const { name } = await bodyOf(request, nameBody);
      return written(await config.createHouse(name), name, "created", 201);
    }],
    ["GET", /^\/api\/houses\/([^/]+)$/, async ({ params: [name] }) => {
      const view = await viewOf(await config.load(), name!);
      return view ? json(view) : failure(404, `unknown house '${name}'`);
    }],
    ["DELETE", /^\/api\/houses\/([^/]+)$/, async ({ params: [name] }) => written(await config.deleteHouse(name!), name!, "deleted")],
    ["POST", /^\/api\/houses\/([^/]+)\/allow$/, async ({ request, params: [name] }) => {
      const { host } = await bodyOf(request, hostBody);
      const { household, entry, changed } = await config.allowHost(name!, host);
      return written(household, name!, changed ? `allows ${entry}` : `already allows ${entry}`);
    }],
    ["POST", /^\/api\/houses\/([^/]+)\/allow\/bulk$/, async ({ request, params: [name] }) => {
      const { hosts } = await bodyOf(request, hostsBody);
      const { household, added } = await config.allowHosts(name!, hosts);
      return written(household, name!, added.length ? `allows ${added.join(", ")}` : "already allows these hosts");
    }],
    ["DELETE", /^\/api\/houses\/([^/]+)\/allow\/([^/]+)$/, async ({ params: [name, host] }) => {
      const { household, entry, changed } = await config.disallowHost(name!, host!);
      return written(household, name!, changed ? `no longer allows ${entry}` : `has no allowlist entry ${entry}`);
    }],
    ["DELETE", /^\/api\/houses\/([^/]+)\/temporary\/([^/]+)$/, async ({ request, params: [name, domain] }) => {
      const household = await config.load();
      if (!findHouse(household, name!)) throw new NotFoundError(`unknown workspace '${name}'`);
      if (!deps.networkRequests) return failure(503, "temporary network grants are unavailable");
      const query = new URL(request.url).searchParams;
      const ports = query.getAll("port");
      if (ports.length > 1 || (ports.length === 1 && !/^[0-9]+$/.test(ports[0]!))) throw new HouseholdError("port must be an integer from 1 to 65535");
      const port = requestPort(ports.length === 0 ? undefined : Number(ports[0]));
      // A grant is one pet's: which pet's goes is said, never guessed.
      const pets = query.getAll("pet");
      if (pets.length !== 1 || !PET_NAME_PATTERN.test(pets[0]!)) throw new HouseholdError("bot must name the bot holding the grant");
      await deps.networkRequests.revoke(name!, pets[0]!, requestDomain(domain!), port);
      events.info(`web: workspace ${name} revoked ${pets[0]}'s temporary access to ${domain}:${port}`);
      return json({ house: await viewOf(household, name!) } satisfies WriteView);
    }],
    ["POST", at("/slack/resolve"), async ({ request, params: [name] }) => {
      const { token, appToken, member } = await bodyOf(request, z.strictObject({ token: z.string(), appToken: z.string(), member: z.string() }));
      const household = await config.load();
      if (!findHouse(household, name!)) throw new NotFoundError(`unknown workspace '${name}'`);
      await checkFields(deps.channelKinds, deps.checks, "slack-private", { token, appToken }, { household, house: name! });
      return json(await resolveSlackDm(token.trim(), member));
    }],
    ["POST", at("/channels"), async ({ request, params: [name] }) => {
      const { kind, chat, slackMember, name: shown, note, pets, default: first, ...own } = await bodyOf(request, newChannelBody);
      if (slackMember !== undefined && kind !== "slack-private") throw new HouseholdError("Slack member is only for Slack channels.");
      ownFields(kind, own, { chat });
      const household = await config.load();
      if (!findHouse(household, name!)) throw new NotFoundError(`unknown workspace '${name}'`); // before Telegram is asked
      const { own: kept, also } = await checkFields(deps.channelKinds, deps.checks, kind, own, { household, house: name! });
      const destination = slackMember === undefined ? undefined : await resolveSlackDm(kept.token!, slackMember);
      if (destination && destination.chat !== chat) throw new HouseholdError("Slack destination changed. Go back and find your DM again.");
      const channel = { kind, chat, ...kept, ...(shown === undefined ? {} : { name: shown }), ...(note === undefined ? {} : { note: note?.trim() || null }), ...(pets === undefined ? {} : { pets }), ...(first === undefined ? {} : { default: first }) };
      return written(await config.addChannel(name!, channel, also, destination ? { platform: "slack", id: destination.owner } : undefined), name!, `is in a ${kind} chat`, 201);
    }],
    ["PATCH", at("/channels/([^/]+)"), async ({ request, params: [name, chat] }) => {
      const { chat: _, name: shown, note, pets, default: first, ...own } = await bodyOf(request, channelBody);
      const household = await config.load();
      const house = findHouse(household, name!);
      if (!house) throw new NotFoundError(`unknown workspace '${name}'`); // before Telegram is asked
      const known = house.channels.find((channel) => channel.chat === chat!.trim());
      if (!known) throw new NotFoundError(`workspace '${name}' has no channel of chat '${chat}'`);
      ownFields(known.kind, own);
      // A new token of its bot goes to the house's other channels on that bot too (`also`): one token per bot.
      const { own: kept, also } = await checkFields(deps.channelKinds, deps.checks, known.kind, own, { household, house: name!, chat: known.chat });
      const fields = { ...kept, ...(shown === undefined ? {} : { name: shown }), ...(note === undefined ? {} : { note: note?.trim() || null }), ...(pets === undefined ? {} : { pets }), ...(first === undefined ? {} : { default: first }) };
      const after = await config.updateChannel(name!, chat!.trim(), fields, also);
      if (also.length > 0) events.info(`web: workspace ${name}: its bot's new token also went to its channels of chat ${also.map((other) => other.chat).join(", ")}`);
      return written(after, name!, `changed its channel of chat ${chat}`);
    }],
    ["DELETE", at("/channels/([^/]+)"), async ({ params: [name, chat] }) =>
      written((await config.removeChannel(name!, chat!)).household, name!, `is no longer in chat ${chat}`)],
    ["POST", at("/owners"), async ({ request, params: [name] }) => {
      const { platform, id, note } = await bodyOf(request, ownerBody);
      return written(await config.addOwner(name!, platform, id, note), name!, `has owner ${platform} ${id.trim()}`, 201);
    }],
    ["PATCH", at("/owners/([^/]+)/([^/]+)"), async ({ request, params: [name, platform, id] }) => {
      const { note } = await bodyOf(request, ownerNoteBody);
      return written(await config.updateOwner(name!, platform!, id!, note), name!, `changed the note of owner ${platform} ${id}`);
    }],
    ["DELETE", at("/owners/([^/]+)/([^/]+)"), async ({ params: [name, platform, id] }) =>
      written(await config.removeOwner(name!, platform!, id!), name!, `no longer has owner ${platform} ${id}`)],
    ["GET", at("/pets/([^/]+)/instructions"), async ({ params: [house, pet] }) => {
      const { store, adapter } = await instructionTarget(house!, pet!);
      return json(await store.read(house!, pet!, adapter.instructionsFile!, adapter.instructionOverrides));
    }],
    ["PUT", at("/pets/([^/]+)/instructions"), async ({ request, params: [house, pet] }) => {
      const { store, adapter } = await instructionTarget(house!, pet!);
      const body = await bodyOf(request, z.strictObject({ content: z.string().max(32768), revision: z.string() }));
      return json(await store.write(house!, pet!, adapter.instructionsFile!, adapter.instructionOverrides ?? [], body.content, body.revision));
    }],
    ["GET", at("/metrics"), async ({ params: [house] }) => {
      const configured = findHouse(await loadEffective(), house!);
      if (!configured) return failure(404, "house not found");
      return json(Object.fromEntries(configured.pets.map(pet => [pet.name, pet.enabled === false ? null : deps.monitoring?.latest?.(house!, pet.name) ?? null])));
    }],
    ["GET", at("/pets/([^/]+)/metrics"), async ({ request, params: [house, pet] }) => {
      const configured = findHouse(await loadEffective(), house!)?.pets.find(item => item.name === pet);
      if (!configured) return failure(404, "pet not found");
      const range = new URL(request.url).searchParams.get("range") ?? "1h";
      if (range !== "1h" && range !== "24h" && range !== "7d") return failure(400, "range must be 1h, 24h or 7d");
      if (!deps.monitoring) return failure(503, "monitoring unavailable");
      return json(deps.monitoring.history(house!, pet!, range));
    }],
    ["GET", at("/pets/([^/]+)/previews"), async ({ params: [house, pet] }) => {
      if (!findHouse(await loadEffective(), house!)?.pets.some(p => p.name === pet)) return failure(404, "pet not found");
      return json(deps.previews?.list({ house: house!, pet: pet! }) ?? []);
    }],
    ["DELETE", at("/pets/([^/]+)/previews/([^/]+)"), async ({ params: [house, pet, id] }) => {
      if (!deps.previews) return failure(503, "previews unavailable");
      await deps.previews.close({ house: house!, pet: pet! }, id!);
      return json({ ok: true });
    }],
    ["GET", at("/pets/([^/]+)/terminal"), async ({ params: [house, pet] }) => {
      const household = await loadEffective();
      const configured = findHouse(household, house!)?.pets.find((item) => item.name === pet);
      if (!configured) return failure(404, "pet not found");
      const agent = agentOf(deps.agents, configured, household.keys, house!);
      if ("problem" in agent || !agent.agent.terminalSnapshot) return failure(400, "this pet has no terminal screen");
      if (!deps.terminalSnapshot) return failure(503, "terminal screen is unavailable");
      const snapshot = await deps.terminalSnapshot(house!, pet!, agent.agent.name);
      return snapshot ? json(snapshot) : failure(409, "pet terminal is unavailable; its VM must be running");
    }],
    ["GET", /^\/api\/logs$/, async ({ request }) => {
      if (!deps.eventLog) return failure(503, "the Household log is unavailable");
      const query = new URL(request.url).searchParams;
      const kinds = query.get("kinds")?.split(",").filter(Boolean);
      if (kinds?.some((kind) => !LOG_KINDS.includes(kind as LogKind))) throw new HouseholdError(`kinds: ${LOG_KINDS.join(", ")}`);
      return json(readLog(deps.eventLog, {
        after: query.get("after") ?? undefined,
        limit: Math.min(count(query, "limit") ?? 300, 2000),
        filter: { house: query.get("house") || undefined, pet: query.get("pet") || undefined, kinds: kinds as LogKind[] | undefined, problems: query.get("problems") === "true", query: query.get("q") || undefined },
      }));
    }],
    ["GET", at("/pets/([^/]+)/logs"), async ({ request, params: [house, pet] }) => {
      if (!findHouse(await loadEffective(), house!)?.pets.some((item) => item.name === pet)) return failure(404, "pet not found");
      const query = new URL(request.url).searchParams;
      const source = query.get("source") ?? "setup";
      if (!isPetLogSource(source)) throw new HouseholdError(`source: ${Object.keys(PET_LOG_SOURCES).join(", ")}`);
      if (!deps.petLog) return failure(503, "pet logs are unavailable");
      const view = await deps.petLog(house!, pet!, source, { lines: count(query, "lines"), after: query.get("after") ?? undefined });
      return view ? json(view) : failure(409, "the pet's VM is not running");
    }],
    ["GET", at("/pets/([^/]+)/memory"), async ({ request, params: [house, pet] }) => {
      if (!deps.memory) return failure(503, "memory unavailable");
      const q = new URL(request.url).searchParams;
      return json(deps.memory.list(house!,pet!,{...(q.has("prefix")?{prefix:q.get("prefix")}:{}),...(q.has("query")?{query:q.get("query")}:{}),...(q.has("after")?{after:q.get("after")}:{}),deleted:q.get("deleted")==="true"}));
    }],
    ["GET", at("/pets/([^/]+)/memory/([^/]+)"), async ({ params: [house, pet, key] }) => {
      if (!deps.memory) return failure(503, "memory unavailable");
      return json(deps.memory.get(house!,pet!,key!));
    }],
    ["GET", at("/pets/([^/]+)/memory/([^/]+)/history"), async ({ request, params: [house, pet, key] }) => {
      if (!deps.memory) return failure(503, "memory unavailable");
      const before = new URL(request.url).searchParams.get("before");
      return json(deps.memory.history(house!,pet!,key!,before===null?undefined:Number(before)));
    }],
    ["PUT", at("/pets/([^/]+)/memory"), async ({ request, params: [house, pet] }) => {
      if (!deps.memory) return failure(503, "memory unavailable");
      return json(deps.memory.write(house!,pet!,await bodyOf(request,memoryWrite),"owner"));
    }],
    ["DELETE", at("/pets/([^/]+)/memory"), async ({ request, params: [house, pet] }) => {
      if (!deps.memory) return failure(503, "memory unavailable");
      return json(deps.memory.delete(house!,pet!,await bodyOf(request,memoryDelete),"owner"));
    }],
    ["GET", at("/inboxes"), async ({ params: [house] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      if (!findHouse(await config.load(), house!)) throw new NotFoundError("Workspace not found");
      return json(deps.houseInboxes.list(house!));
    }],
    ["POST", at("/inboxes/test"), async ({ request, params: [house] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      if (!findHouse(await config.load(), house!)) throw new NotFoundError("Workspace not found");
      return json(await deps.houseInboxes.test(await bodyOf(request, houseInboxSchema)));
    }],
    ["POST", at("/inboxes"), async ({ request, params: [house] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      const inbox = await bodyOf(request, houseInboxSchema);
      return deps.houseInboxes.edit(house!, inbox.name, async () =>
        written(await config.putInbox(house!, inbox, true), house!, `added inbox ${inbox.name}`, 201));
    }],
    ["PUT", at("/inboxes/([^/]+)"), async ({ request, params: [house, name] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      const inbox = await bodyOf(request, houseInboxSchema);
      if (inbox.name !== name) throw new HouseholdError("An inbox's ID cannot be changed");
      return deps.houseInboxes.edit(house!, name!, async () => {
        deps.houseInboxes!.assertChange(house!, inbox);
        return written(await config.putInbox(house!, inbox), house!, `updated inbox ${name}`);
      });
    }],
    ["PUT", at("/inboxes/([^/]+)/subscribers/([^/]+)"), async ({ request, params: [house, name, pet] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      const subscriber = await bodyOf(request, inboxSubscriberSchema);
      return deps.houseInboxes.edit(house!, name!, async () =>
        written(await config.setInboxSubscriber(house!, name!, pet!, subscriber), house!, `${subscriber.subscribed ? "subscribed" : "unsubscribed"} ${pet} ${subscriber.subscribed ? "to" : "from"} inbox ${name}`));
    }],
    ["DELETE", at("/inboxes/([^/]+)"), async ({ params: [house, name] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      return deps.houseInboxes.edit(house!, name!, async () =>
        written(await config.removeInbox(house!, name!), house!, `removed inbox ${name}`), true);
    }],
    ["POST", at("/inboxes/([^/]+)/poll"), async ({ params: [house, name] }) => {
      if (!deps.houseInboxes) return failure(503, "Inbox polling unavailable");
      return json(await deps.houseInboxes.run(house!, name!));
    }],
    ["GET", at("/pets/([^/]+)/crons"), async ({ params: [house, pet] }) => {
      if (!deps.crons) return failure(503, "scheduler unavailable");
      return json(deps.crons.list(house!, pet!));
    }],
    ["POST", at("/pets/([^/]+)/crons"), async ({ request, params: [house, pet] }) => {
      if (!deps.crons) return failure(503, "scheduler unavailable");
      return json(deps.crons.create(house!, pet!, await bodyOf(request, cronFields)), 201);
    }],
    ["PUT", at("/pets/([^/]+)/crons/([^/]+)"), async ({ request, params: [house, pet, id] }) => {
      if (!deps.crons) return failure(503, "scheduler unavailable");
      const { revision, ...fields } = await bodyOf(request, cronFields.extend({ revision: z.number().int().positive() }));
      return json(deps.crons.update(house!, pet!, id!, revision, fields));
    }],
    ["DELETE", at("/pets/([^/]+)/crons/([^/]+)"), async ({ request, params: [house, pet, id] }) => {
      if (!deps.crons) return failure(503, "scheduler unavailable");
      const { revision } = await bodyOf(request, z.strictObject({ revision: z.number().int().positive() }));
      return json(deps.crons.delete(house!, pet!, id!, revision));
    }],
    ["GET", at("/pets/([^/]+)/environment"), async ({ params: [house, pet] }) => {
      if (!deps.environment) return failure(503, "environment setup is unavailable");
      return json(await deps.environment.getEnvironment(house!, pet!));
    }],
    ["PATCH", at("/pets/([^/]+)/environment"), async ({ request, params: [house, pet] }) => {
      if (!deps.environment) return failure(503, "environment setup is unavailable");
      const fields = await bodyOf(request, z.strictObject({ setup: z.string().nullable().optional(), onStart: z.string().nullable().optional() }));
      const view = await deps.environment.updateEnvironment(house!, pet!, fields);
      events.info(`web: workspace ${house} changed bot ${pet} environment`);
      return json(view);
    }],
    ["POST", at("/pets/([^/]+)/disable"), async ({ request, params: [house, pet] }) => {
      const { mode } = await bodyOf(request, z.strictObject({ mode: z.enum(["now", "notify"]) }));
      if (!deps.environment?.disableEnvironment) return failure(503, "pet disable is unavailable");
      await deps.environment.disableEnvironment(house!, pet!, mode);
      return json({ ok: true });
    }],
    ["POST", at("/pets/([^/]+)/environment/restart"), async ({ request, params: [house, pet] }) => {
      const { mode } = await bodyOf(request, z.strictObject({ mode: z.enum(["now", "notify"]).optional() }));
      if (!deps.environment) return failure(503, "environment setup is unavailable");
      const view = await deps.environment.restartEnvironment(house!, pet!, mode);
      events.info(`web: workspace ${house} restarted bot ${pet} VM`);
      return json(view);
    }],
    ["POST", at("/pets/([^/]+)/environment/run"), async ({ request, params: [house, pet] }) => {
      const { phase } = await bodyOf(request, z.strictObject({ phase: z.enum(["setup", "onStart"]).optional() }));
      if (!deps.environment) return failure(503, "environment setup is unavailable");
      return json(await deps.environment.runEnvironmentSetup(house!, pet!, phase));
    }],
    ["POST", at("/pets"), async ({ request, params: [name] }) => {
      const { name: pet, channels, ...fields } = await bodyOf(request, newPetBody);
      return written(await config.addPet(name!, pet, { lifecycle: DEFAULT_LIFECYCLE, ...fields }, channels), name!, `has pet ${pet}${channels?.length ? ` in chat ${channels.join(", ")}` : ""}`, 201);
    }],
    ["PATCH", at("/pets/([^/]+)"), async ({ request, params: [name, pet] }) =>
      written(await config.updatePet(name!, pet!, await bodyOf(request, petBody)), name!, `changed pet ${pet}`)],
    ["DELETE", at("/pets/([^/]+)"), async ({ params: [name, pet] }) => written(await config.removePet(name!, pet!), name!, `no longer has pet ${pet}`)],
  ];

  async function api(request: Request, path: string): Promise<Response> {
    const matching = routes.map(([method, pattern, handle]) => ({ method, handle, match: pattern.exec(path) })).filter(({ match }) => match);
    if (matching.length === 0) return failure(404, "not found");
    const route = matching.find(({ method }) => method === request.method);
    if (!route) return failure(405, "method not allowed");
    let params: string[];
    try {
      params = route.match!.slice(1).map((part) => decodeURIComponent(part));
    } catch {
      return failure(404, "not found"); // not a valid URI, so no such house or host
    }
    return route.handle({ request, params });
  }

  /** An API request's answer: its route's, or the failure its error stands for. */
  async function answer(request: Request, path: string): Promise<Response> {
    try {
      return await deps.connectorRoutes?.(request) ?? await deps.scoutRoutes?.(request) ?? await api(request, path);
    } catch (error) {
      if (error instanceof InstructionFileError) return failure(error.status, error.message);
      if (error instanceof MemoryError) return failure(error.status, error.message);
      if (error instanceof CronError) return failure(error.status, error.message);
      if (error instanceof SkillFileError) return failure(error.status, error.message);
      if (error instanceof NotFoundError) return failure(404, error.message);
      if (error instanceof HouseholdError) return failure(400, withoutPaths(error.message));
      // The reload logged its failure already.
      if (error instanceof NotApplied) return failure(500, "saved in household.yaml, but the daemon could not apply it: see its log");
      events.error(`web: ${request.method} ${path} failed: ${(error as Error).message}`);
      return failure(500, "internal error: see the daemon's log");
    }
  }

  const handle: WebHandler = async (request, hold) => {
    const url = new URL(request.url);
    // Cookies do not tell ports apart; their names do.
    const cookie = sessionCookieName(url.port);
    if (url.pathname === "/login" && request.method === "GET") {
      const session = auth.signIn(url.searchParams.get("token") ?? "");
      // To the UI either way, so the token leaves the address bar; a failed link says so there.
      const headers = new Headers({ location: session ? "/" : "/?signin=failed", "cache-control": "no-store" });
      if (session) headers.set("set-cookie", sessionCookie(cookie, session));
      return new Response(null, { status: 303, headers });
    }
    if (!url.pathname.startsWith("/api/")) return undefined;
    const session = cookieValue(request.headers.get("cookie"), cookie) ?? (url.pathname === "/api/connectors/google/callback" && request.method === "GET" ? cookieValue(request.headers.get("cookie"), googleOAuthCookieName(url.port)) : undefined);
    if (url.pathname === "/api/logout" && request.method === "POST") {
      auth.signOut(session);
      return new Response(null, { status: 204, headers: { "set-cookie": clearedCookie(cookie) } });
    }
    if (!auth.signedIn(session)) return failure(401, "not signed in: run `house dashboard`");
    hold(); // a write waits for the reload
    const response = await answer(request, url.pathname);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  // The control socket is the owner's (mode 0700, like household.yaml): no session there.
  return Object.assign(handle, { local: (request: Request) => answer(request, new URL(request.url).pathname) });
}
