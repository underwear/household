import { Document } from "yaml";
import { migrateHouseSecrets } from "./config-migrations";
import { houseInboxesSchema, telegramInboxProblems } from "../core/house-inboxes";
import { houseFeaturesSchema, previewSettingsSchema } from "../core/house-features";
import { workspaceResourcesSchema, workspaceBudget, petCpuSchema, petMemorySchema } from "../core/resources";
import { validTimezone } from "../core/timezone";
import { z } from "zod";
import { botProblems, channelProblems, PLATFORMS, type Platform } from "../core/channels";
import { emojiOf } from "../core/emoji";
import { environmentSetupProblem } from "../core/environment";
import { lifecycleSchema } from "../core/lifecycle";
import { HouseholdError } from "../core/errors";
import type { Household, Owner } from "../core/household";
import { PROVIDERS } from "../core/keys";
import { DEFAULT_SECRET_HEADER, envProblem, secretHost } from "../core/secrets";
import { scoutProblems, blueprintCapabilities } from "../core/scouts";
import { NAME_PATTERN, PET_NAME_HINT, PET_NAME_PATTERN } from "../core/names";
import { allowEntryError, parseAllowEntry, parseEndpoint } from "../core/network-policy";
import { nestingIn, volumeFieldsSchema, volumePathProblem } from "../core/volumes";

const name = z.string().regex(NAME_PATTERN, `must match ${NAME_PATTERN.source}`);
const petName = z.string().regex(PET_NAME_PATTERN, PET_NAME_HINT);

const endpoint = z.string().transform((text, ctx) => {
  const parsed = parseAllowEntry(text);
  if (parsed) return parsed;
  ctx.addIssue({ code: "custom", message: allowEntryError(text) });
  return z.NEVER;
});

// A key with no value (`pets:`) is YAML null; read it as empty.
// A grant the owner approved from a pet's request in chat: one exact host, reaching public addresses only.
const granted = z.string().transform((text, ctx) => {
  const parsed = parseEndpoint(text);
  if (parsed) return { ...parsed, reach: "public" as const };
  ctx.addIssue({ code: "custom", message: `'${text}' is not host or host:port: a grant names one exact host` });
  return z.NEVER;
});

const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform((value) => value ?? []);
const map = <T extends z.ZodType>(value: T, key: z.ZodString = name) => z.record(key, value).nullish().transform((record) => record ?? {});

// An alias is matched at the start of a message, before `,` `:` or a line break, so it holds none of them.
const alias = z.string().trim().min(1).max(64).regex(/^[^,:\r\n]+$/, "an alias has no , : or line break");

// A pet's mark: one emoji (a ZWJ sequence, a skin tone, a flag is one), nothing else; read fully qualified (❤ → ❤️).
// YAML takes an unquoted `#` for a comment: `emoji: #️⃣` is null, so it says how to write it.
const emoji = z.string().nullable().transform((text, ctx) => {
  const found = text === null ? undefined : emojiOf(text.trim());
  if (found) return found;
  ctx.addIssue({ code: "custom", message: text === null ? 'emoji is empty; quote it in YAML, e.g. emoji: "#️⃣"' : "must be one emoji (🦉, 👩‍💻, 🤖 …), nothing else" });
  return z.NEVER;
});

const setup = z.string().superRefine((script, ctx) => {
  const problem = environmentSetupProblem(script);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
const environment = z.strictObject({ setup: setup.optional(), onStart: setup.optional() });

// Display names accept any language, punctuation and emoji, on one printable line.
const petTitle = z.string().trim().min(1).max(64).regex(/^[^\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u, "a display name is plain text on one line (no control or direction characters)");

// `sibling:` (null) is a pet with all defaults. Emoji and title go into a thread name (Telegram: ≤ 128).
// An agent's own settings (`AgentAdapter.settings`): camelCase keys, short values; which keys and values are right
// is the agent's to say (`agentOf`), not the file's shape.
const settingKey = z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/, "a setting's key is a camelCase identifier");
const settings = z.record(settingKey, z.string().trim().min(1).max(64)).optional();
const pet = z
  .strictObject({ cpus: petCpuSchema.optional(), memoryMiB: petMemorySchema.optional(), enabled: z.boolean().optional(), environment: environment.optional(), lifecycle: lifecycleSchema.optional(), agent: name.optional(), model: z.string().trim().min(1).max(64).optional(), reasoningEffort: z.string().trim().min(1).max(64).optional(), mode: z.string().trim().min(1).max(64).optional(), settings, key: name.optional(), title: petTitle.optional(), emoji: emoji.optional(), aliases: list(alias) })
  .nullable()
  .transform((value) => value ?? { aliases: [] });

const TOO_LARGE = "too large for a YAML number: quote it";

/**
 * An owner's id as the config writes it: a number (a Telegram user id; one past 2^53 is rounded by YAML, so it
 * must be quoted) or a string (later: a phone number), trimmed; what is not an id says why.
 */
export function ownerIdOf(value: unknown): { id: string } | { problem: string } {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return { problem: TOO_LARGE };
    return value >= 0 ? { id: String(value) } : { problem: "an owner id is not negative" };
  }
  if (typeof value === "string" && value.trim() && value.trim().length <= 64) return { id: value.trim() };
  return { problem: "an owner id is a number or a string (64 characters at most)" };
}

/** A note's rule (an owner's, a channel's, a key's): plain text on one line, 200 characters at most. */
export const NOTE_MAX = 200;
/** What a note never holds: control characters (a tab is fine), line and paragraph separators, bidi overrides and isolates. */
const NOT_IN_A_NOTE = /(?!\t)[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
/** Whether `text` is fit for a note (trimmed); what is wrong with it otherwise. */
export function noteProblem(text: string): string | undefined {
  if (text.length > NOTE_MAX) return `a note is ${NOTE_MAX} characters at most`;
  if (NOT_IN_A_NOTE.test(text)) return "a note is plain text on one line (no control or direction characters)";
  return undefined;
}
// `note: ""` and `note:` (null) are no note. The check apart from the trim: in a union, a failing transform would
// hide its message.
const noteText = z
  .string()
  .nullish()
  .superRefine((text, ctx) => {
    const problem = text?.trim() ? noteProblem(text.trim()) : undefined;
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  });
const noteOf = (text: string | null | undefined) => text?.trim() || undefined;
const note = noteText.transform(noteOf);

/** The old shapes (a bare id; `- telegram: <id>`) as the map they become, in block YAML; an id YAML rounded is not printed. */
function ownersReplacement(items: unknown[]): string {
  const byPlatform = new Map<string, string[]>();
  for (const item of items) {
    const [platform, value] = item !== null && typeof item === "object" ? (Object.entries(item)[0] ?? ["telegram", undefined]) : ["telegram", item];
    const found = ownerIdOf(value);
    const shown = "id" in found ? found.id : '"<the id, quoted>"';
    byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), shown]);
  }
  return [...byPlatform].map(([platform, ids]) => `    ${platform}:\n${ids.map((id) => `      - ${id}`).join("\n")}`).join("\n");
}

// An owner's id: a number or a string (anything else fails on its type, so the union below says what the other
// shape is), checked by `ownerIdOf`. Checks, not transforms, inside the union: a failing transform would hide its message.
const ownerId = z
  .custom<number | string>((value) => typeof value === "number" || typeof value === "string", { message: "an owner id is a number or a string" })
  .superRefine((value, ctx) => {
    const found = ownerIdOf(value);
    if (!("id" in found)) ctx.addIssue({ code: "custom", message: found.problem });
  });
const SHAPE = "an owner is an id, or {id, note}";
/** An owner in a platform's list: its id bare, or `{id, note}`. */
const ownerItem = z
  .union([z.strictObject({ id: ownerId, note: noteText }, { error: (issue) => (issue.code === "unrecognized_keys" ? SHAPE : undefined) }), ownerId], { error: SHAPE })
  .transform((item) => {
    const [id, said] = typeof item === "object" ? [item.id, noteOf(item.note)] : [item, undefined];
    return { id: (ownerIdOf(id) as { id: string }).id, note: said };
  });
/** A platform's owners: a list; one bare item (`telegram: 777`) is a list of one. */
const ownerItems = (ids: unknown) => (ids === null || ids === undefined ? z.array(ownerItem).safeParse([]) : Array.isArray(ids) ? z.array(ownerItem).safeParse(ids) : ownerItem.transform((item) => [item]).safeParse(ids));

// The house's owners by platform: `owners: {telegram: [100200300, {id: 777, note: Vera}]}` (a platform of core's
// PLATFORMS, then the ids it knows them by, each bare or with a note of the owner's). Whether an id is one of the
// platform's is the app's check (its adapter's).
const owners = z.unknown().transform((value, ctx): Owner[] => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    ctx.addIssue({ code: "custom", message: `owners are listed by platform now; write:\n  owners:\n${ownersReplacement(value)}` });
    return z.NEVER;
  }
  if (typeof value !== "object") {
    ctx.addIssue({ code: "custom", message: "owners are a map of platform to ids, e.g. owners: {telegram: [100200300]}" });
    return z.NEVER;
  }
  const found: Owner[] = [];
  for (const [platform, ids] of Object.entries(value)) {
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      ctx.addIssue({ code: "custom", path: [platform], message: `unknown platform '${platform}' (known: ${PLATFORMS.join(", ")})` });
      continue;
    }
    const items = ownerItems(ids);
    if (!items.success) {
      for (const issue of items.error.issues) ctx.addIssue({ code: "custom", path: [platform, ...issue.path], message: issue.message });
      continue;
    }
    for (const { id, note: said } of items.data) found.push({ platform: platform as Platform, id, ...(said === undefined ? {} : { note: said }) });
  }
  return found;
});
const people = z.strictObject({ owners });

// A private chat with the bot: its id is its person's Telegram user id.
const CHAT_ID = "must be a Telegram chat id (a private chat's: your user id, digits)";
const telegramChat = z.unknown().transform((value, ctx): string => {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) ctx.addIssue({ code: "custom", message: TOO_LARGE });
  else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  else if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  else ctx.addIssue({ code: "custom", message: CHAT_ID });
  return z.NEVER;
});
// A token or key as the config holds it: printable ASCII, no spaces (it goes into a URL or a header as it is).
const credential = (what: string) => z.string().trim().min(1, `${what} is empty`).max(1024).regex(/^[\x21-\x7e]+$/, `${what} is printable ASCII without spaces`);

const telegramPrivate = z.strictObject({
  kind: z.literal("telegram-private"),
  name: z.string().trim().min(1).max(64).optional(),
  note,
  token: credential("a bot token"), // whether it is one is the adapter's check (the daemon's, a form's)
  chat: telegramChat,
  pets: list(petName),
  default: petName.optional(),
});
const telegramDm = telegramPrivate.extend({ kind: z.literal("telegram-dm") });
const telegramGroup = telegramPrivate.extend({
  kind: z.literal("telegram-group"),
  chat: z.union([z.string(), z.number().int().safe()]).transform(String).refine(value => /^-100[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)), "must be a Telegram supergroup id (-100…)"),
});
const slackPrivate = telegramPrivate.extend({
  kind: z.literal("slack-private"),
  chat: z.string().regex(/^T[A-Z0-9]+:D[A-Z0-9]+$/, "Slack private address must be T…:D… (workspace:DM)"),
  appToken: credential("a Socket Mode app token"),
});
const kinds = z.discriminatedUnion("kind", [telegramPrivate, telegramDm, telegramGroup, slackPrivate]);
const channel = kinds;

const houseNames = z.array(name).min(1).optional();
const key = z.strictObject({ provider: z.enum(PROVIDERS), value: credential("a key's value"), note, houses: houseNames, allowOverage: z.boolean().optional() });
const secretHostEntry = z.string().transform((text, ctx) => {
  const found = secretHost(text);
  if ("host" in found) return found;
  ctx.addIssue({ code: "custom", message: found.problem });
  return z.NEVER;
});
const secret = z.strictObject({
  value: credential("a secret's value"),
  hosts: z.array(secretHostEntry).min(1, "a secret needs at least one host"),
  header: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,64}$/, "a header name: letters, digits and -").optional(),
  env: z.string().superRefine((text, ctx) => { const problem = envProblem(text); if (problem) ctx.addIssue({ code: "custom", message: problem }); }),
  onlyForCapabilities: z.array(name).optional(),
  note,
});
// A secret written for v1 scouts (onlyForScouts) stays restricted, to no capability, until its owner picks some.
const secretInput = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || !("onlyForScouts" in raw)) return raw;
  const { onlyForScouts: _old, ...rest } = raw as Record<string, unknown>;
  return { onlyForCapabilities: [], ...rest };
}, secret);

export const sideworkerProfilesSchema = z.array(z.strictObject({
  name, agent: name, key: name,
  model: z.string().trim().min(1).max(64).optional(),
  reasoningEffort: z.string().trim().min(1).max(64).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
})).superRefine((profiles, ctx) => {
  const names = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    if (names.has(profile.name)) ctx.addIssue({ code: "custom", path: [index, "name"], message: "Profile names must be unique within a workspace" });
    names.add(profile.name);
  }
});

export const scoutLimitsSchema = z.strictObject({
  maxScouts: z.number().int().min(0).max(64).optional(),
  cpus: petCpuSchema.optional(),
  memoryMiB: petMemorySchema.optional(),
}).transform(({ maxScouts: _legacy, ...resources }) => resources);
/** The agent every scout of a house runs on. */
export const scoutAgentSchema = z.strictObject({
  agent: name, key: name,
  model: z.string().trim().min(1).max(64).optional(),
  reasoningEffort: z.string().trim().min(1).max(64).optional(),
  mode: z.string().trim().min(1).max(64).optional(),
});
const capabilityKey = z.discriminatedUnion("via", [
  z.strictObject({ secret: name, via: z.literal("gateway") }),
  z.strictObject({ secret: name, via: z.literal("vm"), env: z.string().superRefine((value, ctx) => { const problem = envProblem(value); if (problem) ctx.addIssue({ code: "custom", message: problem }); }) }),
]);
export const capabilityDefinitionSchema = z.strictObject({
  name,
  description: z.string().trim().max(1000).default(""),
  install: z.string().max(100_000).default(""),
  network: z.strictObject({ any: z.boolean().default(true), allow: list(endpoint) }).default({ any: true, allow: [] }),
  keys: z.array(capabilityKey).max(32).default([]),
  owner: name.optional(),
}).superRefine((capability, ctx) => {
  const ids = capability.keys.map(key => key.secret);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["keys"], message: "A secret is listed twice" });
  if (!capability.network.any && capability.network.allow.length === 0) ctx.addIssue({ code: "custom", path: ["network"], message: "Name at least one host, or choose Any" });
});
export const capabilityDefinitionsSchema = z.array(capabilityDefinitionSchema).superRefine((capabilities, ctx) => {
  if (new Set(capabilities.map(capability => capability.name)).size !== capabilities.length) ctx.addIssue({ code: "custom", message: "Capability names must be unique within a workspace" });
});
export const scoutDefinitionSchema = z.strictObject({
  name, title: petTitle.optional(), emoji: emoji.optional(),
  description: z.string().trim().min(1).max(1000),
  instructions: z.string().max(100_000).default(""),
  capabilities: z.array(name).max(32).default([]).refine(names => new Set(names).size === names.length, "A capability is listed twice"),
  workspace: z.strictObject({
    repo: z.string().trim().max(2048).refine(repo => { try { return new URL(repo).protocol === "https:"; } catch { return false; } }, "Use an https:// repository URL"),
    branch: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._\/-]+$/, "A branch name").optional(),
  }).optional(),
  agent: scoutAgentSchema.optional(),
  resources: z.strictObject({ cpus: petCpuSchema.optional(), memoryMiB: petMemorySchema.optional() }).optional(),
});
export const scoutDefinitionsSchema = z.array(scoutDefinitionSchema).superRefine((scouts, ctx) => {
  if (new Set(scouts.map(scout => scout.name)).size !== scouts.length) ctx.addIssue({ code: "custom", message: "Scout names must be unique within a workspace" });
});

/**
 * Fields earlier scouts carried and blueprints do not: their own keys, login, files, setup and network (v1); who may
 * call them (every run is approved now). An earlier scout's agent (a name, with key, model… beside it) and resources
 * were required, not chosen: they go too, and it runs on the house's. Dropped on load, not migrated; the entry
 * stays, so the YAML and the parsed list keep the same order (edits address scouts by index).
 */
const LEGACY_SCOUT_FIELDS = ["setup", "network", "secrets", "login", "files", "call", "key", "model", "reasoningEffort", "mode"];
const legacyScout = (scout: Record<string, unknown>) => typeof scout.agent === "string"
  ? Object.fromEntries(Object.entries(scout).filter(([key]) => !LEGACY_SCOUT_FIELDS.includes(key) && key !== "agent" && key !== "resources"))
  : Object.fromEntries(Object.entries(scout).filter(([key]) => !LEGACY_SCOUT_FIELDS.includes(key)).map(([key, value]) => [key, key === "resources" ? withoutTimeout(value) : value]));
/** Scouts once had a maximum run time; now they run until they finish or are stopped. The config store drops it. */
const withoutTimeout = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "timeoutMinutes")) : value;
const scoutsInput = z.preprocess((raw) => Array.isArray(raw) ? raw.map(scout => scout && typeof scout === "object" ? legacyScout(scout as Record<string, unknown>) : scout) : raw, scoutDefinitionsSchema);
const house = z.strictObject({
  secrets: map(secretInput),
  resources: workspaceResourcesSchema.optional(),
  inboxes: houseInboxesSchema.optional(),
  capabilities: capabilityDefinitionsSchema.optional(),
  scouts: scoutsInput.optional(),
  scoutLimits: z.preprocess(withoutTimeout, scoutLimitsSchema).optional(),
  scoutAgent: scoutAgentSchema.optional(),
  /** Legacy: the capabilities pets once assembled a scout from. The config store turns it into the General scout. */
  defaultScout: z.unknown().optional(),
  features: houseFeaturesSchema.optional(),
  preview: previewSettingsSchema.optional(),
  /** Legacy: sideworkers' default VM size. Bots size each one now; dropped on load, and migration 6 removes it. */
  sideworkerLimits: z.unknown().optional(),
  sideworkerProfiles: sideworkerProfilesSchema.optional(),
  volumes: map(volumeFieldsSchema.superRefine((volume, ctx) => {
    const problem = volumePathProblem(volume.path);
    if (problem) ctx.addIssue({ code: "custom", path: ["path"], message: problem });
  })),
  network: z.strictObject({ allow: list(endpoint), granted: list(granted) }),
  pets: map(pet, petName),
  people: people.nullish(),
  channels: list(channel),
});

// Port 0: any free port (tests).
const port = z.number().int().min(0).max(65535).optional();
const daemon = z.strictObject({ agentPort: port, webPort: port });

// An empty file is YAML null too.
const file = z.strictObject({ version: z.number().int().min(0).optional(), timezone: z.string().max(100).refine(validTimezone, "Expected an IANA timezone").optional(), daemon: daemon.optional(), keys: map(key), houses: map(house) }).nullable();

/** Validates the plain-JS form of household.yaml and turns it into the domain model. */
export function parseHousehold(raw: unknown, source: string): Household {
  if (raw && typeof raw === "object" && "secrets" in raw && (!("version" in raw) || Number(raw.version) < 4)) {
    const doc = new Document(raw);
    migrateHouseSecrets(doc);
    raw = doc.toJS();
  }
  const result = file.safeParse(raw);
  if (!result.success) throw new HouseholdError(`invalid config ${source}:\n${z.prettifyError(result.error)}`);
  const household: Household = {
    daemon: result.data?.daemon ?? {},
    ...(result.data?.timezone ? {timezone: result.data.timezone} : {}),
    keys: Object.entries(result.data?.keys ?? {}).map(([keyName, { provider, value, note: said, houses, allowOverage }]) => ({ name: keyName, provider, value, ...(said === undefined ? {} : { note: said }), ...(houses === undefined ? {} : { houses }), ...(allowOverage ? { allowOverage } : {}) })),
    houses: Object.entries(result.data?.houses ?? {}).map(([houseName, value]) => ({
      name: houseName,
      ...(Object.keys(value.secrets).length ? { secrets: Object.entries(value.secrets).map(([name, { header, ...secret }]) => ({ name, ...secret, header: header ?? DEFAULT_SECRET_HEADER })) } : {}),
      ...(value.resources ? { resources: value.resources } : {}),
      ...(value.inboxes ? { inboxes: value.inboxes } : {}),
      ...(value.capabilities ? { capabilities: value.capabilities } : {}),
      ...(value.scouts ? { scouts: value.scouts } : {}),
      ...(value.scoutLimits ? { scoutLimits: value.scoutLimits } : {}),
      ...(value.scoutAgent ? { scoutAgent: value.scoutAgent } : {}),
      ...(value.features ? { features: value.features } : {}),
      ...(value.preview ? { preview: value.preview } : {}),
      ...(value.sideworkerProfiles ? { sideworkerProfiles: value.sideworkerProfiles } : {}),
      ...(Object.keys(value.volumes).length ? { volumes: Object.entries(value.volumes).map(([name, { path, access, bots, note: said }]) => ({ name, path, access, bots, ...(said === undefined ? {} : { note: said }) })) } : {}),
      network: { kind: "allowlist", allow: [...value.network.allow, ...value.network.granted] },
      pets: Object.entries(value.pets).map(([petName, { enabled, cpus, memoryMiB, environment, lifecycle, agent, model, reasoningEffort, mode, settings: own, key: keyName, title, emoji: mark, aliases }]) => ({
        name: petName,
        ...(cpus === undefined ? {} : { cpus }),
        ...(memoryMiB === undefined ? {} : { memoryMiB }),
        ...(enabled === undefined ? {} : { enabled }),
        ...((environment?.setup || environment?.onStart) ? { environment } : {}),
        ...(lifecycle === undefined ? {} : { lifecycle }),
        agent,
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(mode === undefined ? {} : { mode }),
        ...(own === undefined || Object.keys(own).length === 0 ? {} : { settings: own }),
        ...(keyName === undefined ? {} : { key: keyName }),
        title,
        ...(mark === undefined ? {} : { emoji: mark }),
        ...(aliases.length > 0 ? { aliases } : {}),
      })),
      people: { owners: value.people?.owners ?? [] },
      channels: value.channels.map(({ kind, name: shown, note: said, token, chat, pets, default: first, ...adapterFields }) => ({
        ...adapterFields,
        kind,
        ...(shown === undefined ? {} : { name: shown }),
        ...(said === undefined ? {} : { note: said }),
        token,
        chat,
        pets,
        ...(first === undefined ? {} : { default: first }),
      })),
    })),
  };
  const problems = [...household.houses.flatMap(channelProblems), ...botProblems(household.houses), ...telegramInboxProblems(household.houses)];
  for (const house of household.houses) {
    const budget = workspaceBudget(house);
    if (budget.reserved.cpus > budget.total.cpus || budget.reserved.memoryMiB > budget.total.memoryMiB) problems.push(`workspace '${house.name}': pet reservations exceed the CPU/RAM budget`);
    for (const volume of house.volumes ?? []) for (const bot of volume.bots) if (!house.pets.some(pet => pet.name === bot))
      problems.push(`volume '${house.name}/${volume.name}' is for unknown bot '${bot}'`);
    for (const volume of house.volumes ?? []) {
      const nested = nestingIn(household.houses, house.name, volume.name, volume.path, volume.access);
      if (nested) problems.push(`volume '${house.name}/${volume.name}': ${nested}`);
    }
    for (const capability of house.capabilities ?? []) for (const key of capability.keys) {
      const secret = (house.secrets ?? []).find(item => item.name === key.secret);
      if (!secret || !secret.onlyForCapabilities?.includes(capability.name))
        problems.push(`capability '${house.name}/${capability.name}' key '${key.secret}' must be a secret restricted to this capability and house`);
    }
    for (const capability of house.capabilities ?? []) if (capability.owner && !house.scouts?.some(scout => scout.name === capability.owner))
      problems.push(`capability '${house.name}/${capability.name}' belongs to unknown scout blueprint '${capability.owner}'`);
    for (const scout of house.scouts ?? []) {
      for (const name of scout.capabilities) if (house.capabilities?.find(capability => capability.name === name)?.owner) problems.push(`scout '${house.name}/${scout.name}': '${name}' is another blueprint's own capability`);
      for (const problem of scoutProblems({ capabilities: blueprintCapabilities(scout, house.capabilities ?? []) }, house.capabilities ?? [], secret => (house.secrets ?? []).find(item => item.name === secret)?.env))
        problems.push(`scout '${house.name}/${scout.name}': ${problem}`);
    }
  }
  for (const house of household.houses) {
    const secrets = house.secrets ?? [];
    for (let i = 0; i < secrets.length; i++) {
      const first = secrets[i]!;
      for (const second of secrets.slice(i + 1)) {
        if (first.env !== second.env) continue;
        const sharedRecipients = first.onlyForCapabilities === undefined && second.onlyForCapabilities === undefined || !!first.onlyForCapabilities?.some(capability => second.onlyForCapabilities?.includes(capability));
        if (sharedRecipients) problems.push(`secrets '${first.name}' and '${second.name}' use the same environment variable '${first.env}' in workspace '${house.name}'`);
      }
    }
  }
  if (problems.length > 0) throw new HouseholdError(`invalid config ${source}:\n${problems.map((problem) => `✖ ${problem}`).join("\n")}`);
  return household;
}
