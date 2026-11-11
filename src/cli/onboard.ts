import type { Contact, FoundGroup } from "../channel-adapters/telegram";
import { HouseholdError } from "../core/errors";
import { houseFeatures, previewSettings } from "../core/house-features";
import { findHouse, type Household, type House } from "../core/household";
import { DEFAULT_LIFECYCLE } from "../core/lifecycle";
import { assertName } from "../core/names";
import { CHANNELS, DEFAULT_BOT, KEY_METHODS, SETUP_FEATURES, PROVIDERS, SLACK_MEMBER_STEPS, TELEGRAM_GROUP_ID, TELEGRAM_USER_ID, defaultBotSize, guidePieces, suggestedBudget, type ChannelOption, type KeyMethod, type Provider } from "../core/onboarding";
import { gib, petCpuSchema, petMemorySchema, workspaceBudget, type HostCapacity } from "../core/resources";
import type { AlsoChannel, ConfigStore } from "../infra/config-store";
import type { LocalCodexLogin } from "../app/codex-login";
import { askOr, bold, choose, confirm, dim, green, until, yellow, type Terminal } from "./terminal";

export interface OnboardDeps {
  terminal: Terminal;
  config: ConfigStore;
  /** A bot token checked as `house channel add|set` checks it for a channel of `kind` (`chat`: the channel it replaces the bot of). */
  checkBot(token: string, household: Household, house: string, kind: string, chat?: string): Promise<{ own: Record<string, string>; also: AlsoChannel[]; bot: string }>;
  /** A Slack app's two tokens checked, and the DM of member `member` with it: the channel's chat and its owner. */
  checkSlack(tokens: { token: string; appToken: string }, member: string, household: Household, house: string): Promise<{ own: Record<string, string>; also: AlsoChannel[]; chat: string; owner: string }>;
  /** A configured bot's @username, when Telegram tells. */
  botName(token: string): Promise<string | undefined>;
  /** Watches a new bot for its owner (the first to write in private) and, with `group`, its group, for a few minutes (or until `signal` aborts). */
  watch(token: string, options: { group: boolean; signal: AbortSignal; onContact: (contact: Contact) => void; onGroup: (group: FoundGroup) => void }): Promise<"done" | "timeout">;
  /** What a group the bot is in still needs. */
  checkGroup(token: string, chat: string): Promise<FoundGroup>;
  /** Household's own ChatGPT sign-in, saved as key `name`. */
  codexLogin(name: string): Promise<void>;
  /** The ChatGPT login of the Codex on this machine, if it has one. */
  localCodex(): LocalCodexLogin | undefined;
  /** A copy of that login, saved as key `name`. */
  codexImport(name: string): Promise<void>;
  /** Whether Claude Code is on this machine. */
  claudeHere(): Promise<boolean>;
  /** `claude setup-token` on this terminal; whether it finished. */
  claudeSetupToken(): Promise<boolean>;
  capacity: HostCapacity;
  /** What this machine still lacks to run pets (said up front, not a stop). */
  missing(): Promise<string[]>;
  daemonUp(): Promise<boolean>;
  notifyDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
}

const STEPS = 3;
const step = (terminal: Terminal, n: number, title: string) => terminal.say(`${bold(`${n}/${STEPS}  ${title}`)}`);
const HARNESS = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.harness])) as Record<Provider, string>;

/** A guide line for the terminal: `code` and **bold** in bold, a link as its words and then its address. */
const line = (text: string) => guidePieces(text).map((piece) => piece.kind === "code" || piece.kind === "bold" ? bold(piece.text) : piece.kind === "link" ? `${piece.text} ${dim(`(${piece.href})`)}` : piece.text).join("");
/** What to do, in order: numbered lines of the catalog. */
function guide(t: Terminal, steps: string[]): void {
  steps.forEach((each, index) => t.say(`  ${index + 1}. ${line(each)}`));
}
/** An option's label: its words, its marks, and a dim line on what it is. */
const option = (label: string, description: string, marks: string[] = []) => `${label}${marks.map((mark) => ` ${yellow(`[${mark}]`)}`).join("")} ${dim(`— ${description}`)}`;

/** The terminal with a blank line after every answer, so each exchange stands apart. */
function spaced(t: Terminal): Terminal {
  return {
    say: (text) => t.say(text),
    ask: async (question, signal) => { const answer = await t.ask(question, signal); t.say(); return answer; },
    secret: async (question) => { const answer = await t.secret(question); t.say(); return answer; },
  };
}

/** What a run added and what it found and left as it was, for the summary at the end. */
interface Outcome { added: string[]; kept: string[] }
/** The channel a run ends with: what to call it, its chat, and its bot for Telegram. */
interface Connected { label: string; kind: string; chat: string; bot?: string }

/**
 * `house onboard`: from nothing to a bot in a messenger, asking one thing at a time, as the web admin's setup does
 * (both draw on core/onboarding.ts): a key (a saved one, or a provider and a way to sign in), a workspace and its
 * budget, a channel and who owns it (and its group, found by itself); then the workspace's bot, setup's own. Run
 * again, it shows what there is, offers it at every step and adds only what is chosen anew; nothing is removed.
 * Every step is saved as it ends; the daemon is told once, at the end.
 */
export async function onboard(given: OnboardDeps): Promise<void> {
  const deps = { ...given, terminal: spaced(given.terminal) };
  const { terminal: t, config } = deps;
  const outcome: Outcome = { added: [], kept: [] };
  const before = await config.load();
  t.say(bold("Household setup"));
  if (before.keys.length || before.houses.length) {
    t.say("You have Household set up already:");
    for (const each of await present(deps, before)) t.say(`  ${each}`);
    t.say(dim("This keeps all of it: every step offers what you have, or adds something new next to it."));
  } else {
    t.say("A model, a workspace and a messenger to talk in; then your bot. Ctrl-C stops at any point; what is done stays.");
  }
  for (const problem of await deps.missing()) t.say(yellow(`  ! ${problem}`));
  t.say();

  step(t, 1, "Model");
  t.say(dim("Bots never see the key: Household's gateway adds it to their requests."));
  const { key, provider } = await modelKey(deps, outcome);

  step(t, 2, "Workspace");
  t.say(dim("A workspace is a trust zone: its own bots, network allowlist, secrets, channels and owners."));
  const { house, created } = await houseOf(deps, outcome);

  step(t, 3, "Channel");
  t.say(dim("Where you talk to your bots. More channels can be added later in the admin."));
  const channel = await channelOf(deps, house, outcome);

  t.say(`${green("✓")} Got everything. Setting it up, please wait…`);
  const pet = await botOf(deps, house, provider, key, channel?.chat, outcome);
  if (created) {
    // Setup's helpers on (scouts going on seed the workspace's General scout).
    const made = findHouse(await config.load(), house)!;
    await config.setHouseFeatures(house, { features: { ...houseFeatures(made), ...SETUP_FEATURES }, preview: previewSettings(made) });
  }

  const up = await deps.daemonUp();
  if (up) await deps.notifyDaemon();
  t.say(`${green("✓ Done.")} Workspace ${bold(house)}: bot ${bold(pet)}${channel ? ` in ${channel.bot ?? channel.label}` : ", no channel yet"}.`);
  if (outcome.added.length) t.say(`  Added: ${outcome.added.join(", ")}.`);
  if (outcome.kept.length) t.say(dim(`  Kept as it was: ${outcome.kept.join(", ")}.`));
  t.say(`
  ${bold("house start")}       run Household ${dim("(a new bot's first start downloads its image: a minute or two)")}
  ${bold("house dashboard")}   sign in to the web admin: a one-time link, opened in your browser
  ${bold("house status")}      what runs;  ${bold("house doctor")}  what is missing;  ${bold("house --help")}  everything else

${bold("Bonus:")} the household skill lets your coding assistant set up and run Household for you
${dim("(as a login service, more bots, secrets, scouts):")}
  Claude Code  claude plugin marketplace add underwear/household && claude plugin install household@household
  Codex        codex plugin marketplace add underwear/household && codex plugin add household@household
`);
  const where = whereToWrite(channel);
  if (up) return t.say(`Household is running and has the changes${where ? `: ${where}` : "."}`);
  if (await confirm(t, `Start Household now (in this terminal, Ctrl-C stops it)?`)) {
    if (where) t.say(dim(`Then ${where}`));
    await deps.startDaemon();
  }
}

/** Where to say hi, by the channel's kind; undefined for none. */
function whereToWrite(channel: Connected | undefined): string | undefined {
  if (!channel) return undefined;
  if (channel.kind === "telegram-group") return "write in your Telegram group: each bot has its own topic there.";
  if (channel.kind === "slack-private") return "write to it in your DM with the Slack app.";
  return `write to ${channel.bot ?? "your bot"} in Telegram${channel.kind === "telegram-private" ? ": it answers in its own thread." : "."}`;
}

/** What the config has, a line each: its keys, then each house with its channels and pets. */
async function present(deps: OnboardDeps, household: Household): Promise<string[]> {
  const lines = household.keys.length ? [`keys: ${household.keys.map((key) => `${key.name} (${key.provider})`).join(", ")}`] : [];
  for (const house of household.houses) {
    const channels = await Promise.all(house.channels.map((channel) => channelName(deps, channel)));
    const pets = house.pets.map((pet) => pet.name).join(", ") || "no bots";
    lines.push(`workspace ${house.name}: ${channels.length ? `${channels.join(", ")}, ` : ""}${pets}`);
  }
  return lines;
}

/** A channel in a word or two: a Telegram one by its bot's @username, when Telegram tells; else its kind's label. */
async function channelName(deps: OnboardDeps, channel: House["channels"][number]): Promise<string> {
  const token = (channel as { token?: string }).token;
  const bot = channel.kind.startsWith("telegram") && token ? await deps.botName(token).catch(() => undefined) : undefined;
  return bot ?? CHANNELS.find((each) => each.kind === channel.kind)?.label ?? channel.kind;
}

// ── 1. Model ────────────────────────────────────────────────────────────────────────────────────────────────

/** The key bots run on: a saved one, or a new one by a provider and a way to sign in. */
async function modelKey(deps: OnboardDeps, outcome: Outcome): Promise<{ key: string; provider: Provider }> {
  const { terminal: t, config } = deps;
  const household = await config.load();
  const saved = household.keys.filter((key) => key.provider in HARNESS);
  const picked = await choose<string>(t, "Which model will your bots use?", [
    ...saved.map((key, index) => ({
      value: `key:${key.name}`,
      label: `${key.name} ${dim(`— ${PROVIDERS.find((each) => each.id === key.provider)!.label}${key.note ? `, ${key.note}` : ""}`)}`,
      ...(index === 0 ? { heading: "Saved keys" } : {}),
    })),
    ...PROVIDERS.map((each, index) => ({ value: each.id, label: option(each.label, each.description), ...(index === 0 && saved.length ? { heading: "Add a new key" } : {}) })),
  ]);
  const known = saved.find((key) => `key:${key.name}` === picked);
  if (known) {
    outcome.kept.push(`key ${known.name}`);
    return { key: known.name, provider: known.provider as Provider };
  }
  const provider = picked as Provider;
  const local = deps.localCodex();
  const methods = KEY_METHODS.filter((method) => method.provider === provider && (!method.needsLocalCodex || local));
  const methodId = await choose(t, `How will ${provider === "openai" ? "Codex" : "Claude Code"} sign in?`, methods.map((method) => ({
    value: method.id,
    label: option(method.label, method.id === "chatgpt-local" && local ? [local.email, local.plan && `ChatGPT ${local.plan}`].filter(Boolean).join(", ") || method.description : method.description),
  })));
  const method = methods.find((each) => each.id === methodId)!;
  const name = freeName(household.keys.map((key) => key.name), method.name);
  await connectKey(deps, method, name, local);
  outcome.added.push(`key ${name}`);
  return { key: name, provider };
}

/** Key `name` by `method`: its guide, then what it takes (a paste, a ChatGPT sign-in, a copy of Codex's login). */
async function connectKey(deps: OnboardDeps, method: KeyMethod, name: string, local: LocalCodexLogin | undefined): Promise<void> {
  const { terminal: t, config } = deps;
  t.say(bold(method.label));
  if (method.input.kind === "local") {
    guide(t, method.steps);
    try {
      await deps.codexImport(name);
      t.say(`${green("✓")} connected${local?.email ? ` as ${local.email}` : ""}.`);
      return t.say();
    } catch (error) {
      t.say(yellow(`  ${(error as Error).message}; sign in with ChatGPT instead:`));
    }
  }
  if (method.input.kind === "local" || method.input.kind === "device") {
    guide(t, KEY_METHODS.find((each) => each.id === "chatgpt")!.steps);
    for (;;) {
      try {
        await deps.codexLogin(name);
        return t.say();
      } catch (error) {
        t.say(yellow(`  ${(error as Error).message}`));
        if (!(await confirm(t, "Try again?"))) throw new HouseholdError("no key, so no bot: run `house onboard` again when Codex can sign in");
      }
    }
  }
  const input = method.input;
  // A Claude subscription's token can be made right here, when Claude Code is.
  if (method.id === "claude-subscription" && await deps.claudeHere() && await confirm(t, `Run ${bold("claude setup-token")} here now? It signs you in in the browser and prints the token.`)) {
    if (!(await deps.claudeSetupToken())) t.say(yellow("  claude setup-token did not finish; paste a token if you have one."));
    t.say(`Copy the token it printed ${dim("(sk-ant-oat01-…)")} and paste it below.`);
  } else {
    guide(t, method.steps);
  }
  await until(t, () => t.secret(`${input.label} (hidden): `), async (value) => {
    if (!value.startsWith(input.prefix)) throw new Error(input.wrong);
    await config.addKey(name, { provider: method.provider, value, note: method.label });
  });
}

// ── 2. Workspace ────────────────────────────────────────────────────────────────────────────────────────────

/** One of the houses there are, or a new one with its name and budget. */
async function houseOf(deps: OnboardDeps, outcome: Outcome): Promise<{ house: string; created: boolean }> {
  const { terminal: t, config } = deps;
  const houses = (await config.load()).houses;
  if (houses.length) {
    const picked = await choose(t, "Which workspace?", [
      ...houses.map((house, index) => ({ value: house.name, label: `${house.name} ${dim(`— ${house.pets.map((pet) => pet.name).join(", ") || "no bots yet"}`)}`, ...(index === 0 ? { heading: "Your workspaces" } : {}) })),
      { value: "", label: "A new workspace", heading: "Or" },
    ]);
    if (picked) { outcome.kept.push(`workspace ${picked}`); return { house: picked, created: false }; }
  }
  const house = await until(t, () => askOr(t, "Name", freeName(houses.map((each) => each.name), "home")), async (name) => {
    assertName("house", name);
    if (findHouse(await config.load(), name)) throw new Error(`'${name}' is taken: pick it from the list instead, or another name`);
    return name;
  });
  const host = deps.capacity;
  const suggested = suggestedBudget(host);
  t.say(dim(`How much of this machine (${host.cpus} vCPU, ${gib(host.memoryMiB)}) the workspace may use. Each bot reserves its own`));
  t.say(dim("share; scouts and sideworkers take theirs from the rest while they run. Change it later on its Resources page."));
  const cpus = await until(t, () => askOr(t, "CPUs", String(suggested.cpus)), (answer) => {
    const value = Number(answer);
    if (!petCpuSchema.safeParse(value).success || value > host.cpus) throw new Error(`a whole number from 1 to ${host.cpus}`);
    return value;
  });
  const memoryMiB = await until(t, () => askOr(t, "Memory, GiB", String(suggested.memoryMiB / 1024)), (answer) => {
    const value = Number(answer) * 1024;
    if (!petMemorySchema.safeParse(value).success || value > host.memoryMiB) throw new Error(`from 0.5 to ${gib(host.memoryMiB)}, in steps of 0.125`);
    return value;
  });
  await config.createHouse(house);
  await config.setWorkspaceResources(house, { cpus, memoryMiB });
  outcome.added.push(`workspace ${house}`);
  return { house, created: true };
}

// ── 3. Channel ──────────────────────────────────────────────────────────────────────────────────────────────

/** The house's channel: the one it has (or the same chat with a new bot), a new one, or none for now. */
async function channelOf(deps: OnboardDeps, house: string, outcome: Outcome): Promise<Connected | undefined> {
  const { terminal: t, config } = deps;
  const present = findHouse(await config.load(), house)!.channels[0];
  if (present) {
    const shown = await channelName(deps, present);
    const label = CHANNELS.find((each) => each.kind === present.kind)?.label ?? present.kind;
    const telegram = present.kind.startsWith("telegram");
    const keep = await choose(t, `'${house}' talks through ${shown}.`, [
      { value: "keep", label: "Keep it" },
      ...(telegram ? [{ value: "replace", label: `Another Telegram bot in the same chat ${dim("— a new token; owners and bots stay")}` }] : []),
      { value: "add", label: "Connect another channel too" },
    ]);
    if (keep === "keep") {
      outcome.kept.push(shown);
      return { label, kind: present.kind, chat: present.chat, ...(telegram ? { bot: shown } : {}) };
    }
    if (keep === "replace") {
      guide(t, CHANNELS.find((each) => each.kind === present.kind)?.steps.slice(0, -1) ?? []);
      const { own, also, bot } = await until(t, () => t.secret("New bot token (hidden): "), async (token) => deps.checkBot(token, await config.load(), house, present.kind, present.chat));
      await config.updateChannel(house, present.chat, own, also);
      t.say(`${green("✓")} ${bot}. ${dim("Send it a message once, so it can write to you.")}`);
      t.say();
      outcome.added.push(bot);
      return { label, kind: present.kind, chat: present.chat, bot };
    }
  }
  const kind = await choose(t, "Where will you talk to your bots?", [
    ...CHANNELS.map((each) => ({ value: each.kind as string, label: option(each.label, each.description, [...(each.recommended ? ["recommended"] : []), ...(each.beta ? ["beta"] : [])]) })),
    { value: "", label: `Skip for now ${dim("— add a channel later in the admin")}` },
  ]);
  if (!kind) return undefined;
  const chosen = CHANNELS.find((each) => each.kind === kind)!;
  t.say(bold(chosen.label));
  guide(t, chosen.steps);
  return chosen.kind === "slack-private" ? slack(deps, house, chosen, outcome) : telegram(deps, house, chosen, outcome);
}

/**
 * A Telegram channel: its bot, then its owner (the first to write to the bot in private) and, for a group, the
 * group the bot is in, both found by watching the bot, the group checked until it has what it needs. A bot
 * Household runs already is not watched (its updates are the daemon's): the ids are asked for instead.
 */
async function telegram(deps: OnboardDeps, house: string, chosen: ChannelOption, outcome: Outcome): Promise<Connected> {
  const { terminal: t, config } = deps;
  const { token, bot, own, also } = await until(t, () => t.secret("Bot token (hidden): "), async (value) => ({ token: value, ...(await deps.checkBot(value, await config.load(), house, chosen.kind)) }));
  t.say(`${green("✓")} ${bot}.`);
  const needsGroup = chosen.kind === "telegram-group";
  const identity = token.split(":")[0];
  const running = (await config.load()).houses.some((each) => each.channels.some((channel) => (channel as { token?: string }).token?.split(":")[0] === identity));
  let contact: Contact | undefined;
  let group: FoundGroup | undefined;
  if (running) {
    t.say(dim(`Household already runs ${bot}, so it cannot watch it here.`));
  } else {
    const groupHow = `Add ${bot} to your group as an admin (Manage topics, Delete messages); if it is in the group already, send ${bold(`/start@${bot.slice(1)}`)} there.`;
    t.say(`Now open ${bold(`https://t.me/${bot.slice(1)}`)} and send the bot any message in a private chat (Start works): you become the workspace's owner.`);
    if (needsGroup) t.say(`Household finds the group by itself: ${groupHow}`);
    const said = new Set<string>();
    const stop = new AbortController();
    const watching = deps.watch(token, {
      group: needsGroup,
      signal: stop.signal,
      onContact: (found) => { contact = found; t.say(`${green("✓")} message from ${found.name}${found.username ? ` (@${found.username})` : ""}`); },
      onGroup: (found) => {
        group = found;
        const text = found.problems.length ? `${yellow("!")} group ${found.title} still needs: ${found.problems.join("; ")}` : `${green("✓")} group ${found.title}`;
        if (!said.has(text)) { said.add(text); t.say(text); }
      },
    }).catch((error) => { t.say(yellow(`  could not watch the bot (${(error as Error).message})`)); return "timeout" as const; })
      .finally(() => stop.abort());
    // While it waits (up to 3 minutes), Enter says again what it is waiting for; the watch's end takes the question back.
    const left = () => [
      ...(contact ? [] : [`your private message to ${bot}: open ${bold(`https://t.me/${bot.slice(1)}`)} and send it anything (Start works)`]),
      ...(!needsGroup || (group && group.problems.length === 0) ? [] : group
        ? [`the group ${group.title}, which still needs: ${group.problems.join("; ")}`]
        : [`the group: ${groupHow}`]),
    ];
    while (!stop.signal.aborted) {
      await t.ask(`${dim("Waiting up to 3 minutes…")}\n`, stop.signal);
      if (stop.signal.aborted) break;
      for (const each of left()) t.say(`Waiting for ${each}`);
    }
    await watching;
  }
  if (contact && !(await confirm(t, `Is ${contact.name} you?`))) contact = undefined;
  const id = contact?.id ?? await until(t, () => t.ask(`Your numeric Telegram id ${dim("(@userinfobot tells it)")}: `), (value) => {
    if (!TELEGRAM_USER_ID.test(value)) throw new Error("a number, like 123456789");
    return value;
  });
  let chat = id;
  if (needsGroup) {
    if (!group) {
      const typed = await until(t, () => t.ask(`Group id ${dim("(-100…: in Telegram Web, the part of the group's address after #)")}: `), (value) => {
        if (!TELEGRAM_GROUP_ID.test(value)) throw new Error("a negative number starting with -100, like -1001234567890");
        return value;
      });
      group = await deps.checkGroup(token, typed);
    }
    // Asked again until the group has what it needs, or another group's id is typed; Ctrl-C leaves, with what is saved so far.
    while (group.problems.length) {
      t.say(`${yellow("!")} group ${group.title} still needs: ${group.problems.join("; ")}`);
      const other = await until(t, () => t.ask(dim("Press Enter to check again, or type the group's id (-100…) ")), (value) => {
        if (value && !TELEGRAM_GROUP_ID.test(value)) throw new Error("a negative number starting with -100, like -1001234567890");
        return value;
      });
      group = await deps.checkGroup(token, other || group.id);
    }
    t.say(`${green("✓")} group ${group.title} is ready.`);
    t.say();
    chat = group.id;
  }
  await config.addChannel(house, { kind: chosen.kind, ...own, chat }, also, { platform: "telegram", id });
  outcome.added.push(`${bot} with owner ${contact?.name ?? id}`);
  return { label: chosen.label, kind: chosen.kind, chat, bot };
}

/** A Slack DM: the app's two tokens, then the owner's member ID, from which their DM with the app is found. */
async function slack(deps: OnboardDeps, house: string, chosen: ChannelOption, outcome: Outcome): Promise<Connected> {
  const { terminal: t, config } = deps;
  const token = await until(t, () => t.secret(`Bot token ${dim("(xoxb-…, hidden)")}: `), (value) => {
    if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(value)) throw new Error("paste the Bot User OAuth Token (xoxb-…)");
    return value;
  });
  const appToken = await until(t, () => t.secret(`App-level token ${dim("(xapp-…, hidden)")}: `), (value) => {
    if (!/^xapp-[A-Za-z0-9-]{20,}$/.test(value)) throw new Error("paste the app-level token (xapp-…)");
    return value;
  });
  t.say(bold("Your Slack account") + dim(" — it becomes the workspace's owner"));
  guide(t, SLACK_MEMBER_STEPS);
  const found = await until(t, () => t.ask("Member ID: "), async (member) => deps.checkSlack({ token, appToken }, member, await config.load(), house));
  await config.addChannel(house, { kind: chosen.kind, ...found.own, chat: found.chat }, found.also, { platform: "slack", id: found.owner });
  t.say(`${green("✓")} found your DM with the app.`);
  t.say();
  outcome.added.push(`Slack DM with owner ${found.owner}`);
  return { label: chosen.label, kind: chosen.kind, chat: found.chat };
}

// ── The bot ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The house's bot: the one it has, or setup's own (DEFAULT_BOT) on the key chosen, sized within the budget left. */
async function botOf(deps: OnboardDeps, house: string, provider: Provider, key: string, chat: string | undefined, outcome: Outcome): Promise<string> {
  const { config } = deps;
  const found = findHouse(await config.load(), house)!;
  const own = found.pets.filter((pet) => !pet.scout && !pet.sideworker);
  if (own.length) {
    outcome.kept.push(`bots ${own.map((pet) => pet.name).join(", ")}`);
    return own[0]!.name;
  }
  const free = workspaceBudget(found).available;
  if (free.cpus < 1 || free.memoryMiB < 512) throw new HouseholdError(`'${house}' has no room for a bot (${free.cpus} vCPU, ${gib(free.memoryMiB)} free): raise its budget on its Resources page, then run house onboard again`);
  const pet = freeName(found.pets.map((each) => each.name), DEFAULT_BOT.name);
  await config.addPet(house, pet, { agent: HARNESS[provider], key, title: DEFAULT_BOT.title, ...defaultBotSize(free), lifecycle: DEFAULT_LIFECYCLE }, chat ? [chat] : []);
  outcome.added.push(`bot ${pet}`);
  return pet;
}

function freeName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}
