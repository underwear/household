import type { Contact } from "../channel-adapters/telegram";
import { HouseholdError } from "../core/errors";
import { houseFeatures, previewSettings } from "../core/house-features";
import { findHouse, type Household, type House } from "../core/household";
import { DEFAULT_LIFECYCLE } from "../core/lifecycle";
import { assertName } from "../core/names";
import { BOT_PRESETS, CHANNELS, KEY_METHODS, PROVIDERS, SLACK_MEMBER_STEPS, TELEGRAM_GROUP_ID, TELEGRAM_USER_ID, guidePieces, presetInstructions, suggestedBudget, type BotPreset, type ChannelOption, type KeyMethod, type Provider } from "../core/onboarding";
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
  /** The first person to write to the bot in private from now, or undefined after a while. */
  firstContact(token: string): Promise<Contact | undefined>;
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
  /** `text` added to the end of a new bot's instructions (its role); throws when they cannot be written. */
  addInstructions(house: string, pet: string, text: string): Promise<void>;
  capacity: HostCapacity;
  /** What this machine still lacks to run pets (said up front, not a stop). */
  missing(): Promise<string[]>;
  daemonUp(): Promise<boolean>;
  notifyDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
}

const STEPS = 6;
const step = (terminal: Terminal, n: number, title: string) => terminal.say(`\n${bold(`${n}/${STEPS}  ${title}`)}`);
const HARNESS = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.harness])) as Record<Provider, string>;

/** A guide line for the terminal: `code` and **bold** in bold, a link as its words and then its address. */
const line = (text: string) => guidePieces(text).map((piece) => piece.kind === "code" || piece.kind === "bold" ? bold(piece.text) : piece.kind === "link" ? `${piece.text} ${dim(`(${piece.href})`)}` : piece.text).join("");
/** What to do, in order: numbered lines of the catalog. */
function guide(t: Terminal, steps: string[]): void {
  steps.forEach((each, index) => t.say(`  ${index + 1}. ${line(each)}`));
}
/** An option's label: its words, its marks, and a dim line on what it is. */
const option = (label: string, description: string, marks: string[] = []) => `${label}${marks.map((mark) => ` ${yellow(`[${mark}]`)}`).join("")} ${dim(`— ${description}`)}`;

/** What a run added and what it found and left as it was, for the summary at the end. */
interface Outcome { added: string[]; kept: string[] }
/** The channel a run ends with: what to call it, its chat (none when skipped), and its bot for Telegram. */
interface Connected { label: string; kind: string; chat?: string; bot?: string }

/**
 * `house onboard`: from nothing to a bot in a messenger, asking one thing at a time, as the web admin's setup does
 * (both draw on core/onboarding.ts): a provider and how to sign in, a workspace and its budget, a channel and who
 * owns it, a bot for a purpose. Run again, it shows what there is, offers it at every step and adds only what is
 * chosen anew; nothing is removed. Every step is saved as it ends.
 */
export async function onboard(deps: OnboardDeps): Promise<void> {
  const { terminal: t, config } = deps;
  const outcome: Outcome = { added: [], kept: [] };
  const before = await config.load();
  t.say(bold("Household setup"));
  if (before.keys.length || before.houses.length) {
    t.say("You have Household set up already:");
    for (const each of await present(deps, before)) t.say(`  ${each}`);
    t.say(dim("This keeps all of it: every step offers what you have, or adds something new next to it."));
  } else {
    t.say("A model, a workspace, a messenger to talk in, and your first bot. Ctrl-C stops at any point; what is done stays.");
  }
  for (const problem of await deps.missing()) t.say(yellow(`  ! ${problem}`));

  step(t, 1, "Model");
  t.say(dim("Bots never see the key: Household's gateway adds it to their requests."));
  const { key, provider } = await modelKey(deps, outcome);

  step(t, 2, "Workspace");
  t.say(dim("A workspace is a trust zone: its own bots, network allowlist, secrets, channels and owners."));
  const { house, created } = await houseOf(deps, outcome);

  step(t, 3, "Channel");
  t.say(dim("Where you talk to your bots. More channels can be added later in the admin."));
  const channel = await channelOf(deps, house, outcome);

  step(t, 4, "Bot");
  t.say(dim("A bot is an assistant powered by a harness in its own VM, with a home and memory that stay between sessions."));
  const { pet, preset } = await petOf(deps, house, provider, key, channel?.chat, outcome);

  const current = houseFeatures(findHouse(await config.load(), house)!);
  const feature = async (name: "scouts" | "sideworkers", label: string) => {
    if (created || preset) return confirm(t, `Turn ${label} on?`, preset?.[name] ?? true);
    const on = await confirm(t, `${label[0]!.toUpperCase()}${label.slice(1)} are ${current[name] ? "on" : "off"} in '${house}'. Keep them ${current[name] ? "on" : "off"}?`);
    return on ? current[name] : !current[name];
  };
  step(t, 5, "Scouts");
  t.say(dim("Scouts are one-task helpers in their own VMs — a browser, media tools, dev tools. Your bot calls one by name"));
  t.say(dim("and you approve each run in the chat, so the bot itself never needs that access."));
  const scouts = await feature("scouts", "scouts");

  step(t, 6, "Sideworkers");
  t.say(dim("Sideworkers are like subagents for longer work: your bot starts an extra bot in its own VM, sized for the job"));
  t.say(dim("from what the workspace has free, and you can talk to it on its own — one developing a project, say, while"));
  t.say(dim("your bot carries on with the rest."));
  const sideworkers = await feature("sideworkers", "sideworkers");
  const now = findHouse(await config.load(), house)!;
  await config.setHouseFeatures(house, { features: { ...houseFeatures(now), scouts, sideworkers }, preview: previewSettings(now) });

  const up = await deps.daemonUp();
  if (up) await deps.notifyDaemon();
  t.say(`\n${green("✓ Done.")} Workspace ${bold(house)}: bot ${bold(pet)}${channel ? ` in ${channel.bot ?? channel.label}` : ", no channel yet"}; scouts ${scouts ? "on" : "off"}, sideworkers ${sideworkers ? "on" : "off"}.`);
  if (outcome.added.length) t.say(`  Added: ${outcome.added.join(", ")}.`);
  if (outcome.kept.length) t.say(dim(`  Kept as it was: ${outcome.kept.join(", ")}.`));
  t.say(`
  ${bold("house start")}       run Household ${dim("(a new bot's first start downloads its image: a minute or two)")}
  ${bold("house dashboard")}   sign in to the web admin: a one-time link, opened in your browser
  ${bold("house status")}      what runs;  ${bold("house doctor")}  what is missing;  ${bold("house --help")}  everything else

${bold("Bonus:")} the household skill lets your coding assistant set up and run Household for you
${dim("(as a login service, more bots, secrets, scouts):")}
  Claude Code  claude plugin marketplace add underwear/household && claude plugin install household@household
  Codex        codex plugin marketplace add underwear/household && codex plugin add household@household`);
  const where = whereToWrite(channel);
  if (up) return t.say(`\nHousehold is running and has the changes${where ? `: ${where}` : "."}`);
  if (await confirm(t, `\nStart Household now (in this terminal, Ctrl-C stops it)?`)) {
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

/** The key bots run on: one of the config's, or a new one by a provider and a way to sign in. */
async function modelKey(deps: OnboardDeps, outcome: Outcome): Promise<{ key: string; provider: Provider }> {
  const { terminal: t, config } = deps;
  const household = await config.load();
  const existing = household.keys.filter((key) => key.provider in HARNESS);
  const picked = await choose<string>(t, existing.length ? "Your keys:" : "Which model will your bots use?", [
    ...existing.map((key) => ({ value: `key:${key.name}`, label: `Use '${key.name}' ${dim(`— ${PROVIDERS.find((each) => each.id === key.provider)!.label}${key.note ? `, ${key.note}` : ""}`)}` })),
    ...PROVIDERS.map((each) => ({ value: each.id, label: option(existing.length ? `Add ${each.label}` : each.label, each.description) })),
  ]);
  const known = existing.find((key) => `key:${key.name}` === picked);
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
      return t.say(`${green("✓")} connected${local?.email ? ` as ${local.email}` : ""}.`);
    } catch (error) {
      t.say(yellow(`  ${(error as Error).message}; sign in with ChatGPT instead:`));
    }
  }
  if (method.input.kind === "local" || method.input.kind === "device") {
    guide(t, KEY_METHODS.find((each) => each.id === "chatgpt")!.steps);
    for (;;) {
      try {
        return await deps.codexLogin(name);
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
      ...houses.map((house) => ({ value: house.name, label: `Add to '${house.name}' ${dim(`— ${house.pets.map((pet) => pet.name).join(", ") || "no bots yet"}`)}` })),
      { value: "", label: "A new workspace" },
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

/** A Telegram channel: its bot, a group's id, and its owner, who writes to the bot first (or types their id). */
async function telegram(deps: OnboardDeps, house: string, chosen: ChannelOption, outcome: Outcome): Promise<Connected> {
  const { terminal: t, config } = deps;
  const { token, bot, own, also } = await until(t, () => t.secret("Bot token (hidden): "), async (value) => ({ token: value, ...(await deps.checkBot(value, await config.load(), house, chosen.kind)) }));
  t.say(`${green("✓")} ${bot}.`);
  const group = chosen.kind === "telegram-group"
    ? await until(t, () => t.ask(`Group id ${dim("(-100…)")}: `), (value) => {
      if (!TELEGRAM_GROUP_ID.test(value)) throw new Error("a negative number starting with -100, like -1001234567890");
      return value;
    })
    : undefined;
  // A bot Household runs already: its updates are the daemon's, so the person's id is asked for instead.
  const identity = token.split(":")[0];
  const running = (await config.load()).houses.some((each) => each.channels.some((channel) => (channel as { token?: string }).token?.split(":")[0] === identity));
  let contact: Contact | undefined;
  if (running) {
    t.say(dim(`Household already runs ${bot}, so it cannot listen for your message here.`));
  } else {
    t.say(`Now open ${bold(`https://t.me/${bot.slice(1)}`)} and send the bot any message${group ? " in a private chat, not in the group" : ""} (Start works): that tells Household who you are.`);
    t.say(dim("Waiting up to 3 minutes…"));
    try {
      contact = await deps.firstContact(token);
    } catch (error) {
      t.say(yellow(`  could not listen to the bot (${(error as Error).message})`));
    }
  }
  if (contact && !(await confirm(t, `Message from ${contact.name}${contact.username ? ` (@${contact.username})` : ""}. Is that you?`))) contact = undefined;
  const id = contact?.id ?? await until(t, () => t.ask(`Your numeric Telegram id ${dim("(@userinfobot tells it)")}: `), (value) => {
    if (!TELEGRAM_USER_ID.test(value)) throw new Error("a number, like 123456789");
    return value;
  });
  const chat = group ?? id;
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
  outcome.added.push(`Slack DM with owner ${found.owner}`);
  return { label: chosen.label, kind: chosen.kind, chat: found.chat };
}

// ── 4. Bot ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The house's pets as they are, or a new one for a purpose: its names and allocation, its role, in the chat. */
async function petOf(deps: OnboardDeps, house: string, provider: Provider, key: string, chat: string | undefined, outcome: Outcome): Promise<{ pet: string; preset?: BotPreset }> {
  const { terminal: t, config } = deps;
  const found = findHouse(await config.load(), house)!;
  const pets = found.pets;
  if (pets.length) {
    const keep = await choose(t, `'${house}' has ${pets.map((pet) => `${pet.name} ${dim(`(${pet.agent ?? "claude-code-tmux"}, key ${pet.key})`)}`).join(", ")}.`, [
      { value: "keep", label: "Keep them as they are" },
      { value: "add", label: `Add another bot ${dim(`(${HARNESS[provider]}, key ${key})`)}` },
    ]);
    if (keep === "keep") { outcome.kept.push(`bots ${pets.map((pet) => pet.name).join(", ")}`); return { pet: pets[0]!.name }; }
  }
  const presetId = await choose(t, "What is it for?", BOT_PRESETS.map((each) => ({ value: each.id, label: option(`${each.emoji} ${each.label}`, each.description) })));
  const preset = BOT_PRESETS.find((each) => each.id === presetId)!;
  const pet = await until(t, () => askOr(t, "Name", freeName(pets.map((each) => each.name), preset.name)), (name) => {
    assertName("pet", name);
    if (pets.some((each) => each.name === name)) throw new Error(`'${name}' is already in the workspace: another name`);
    return name;
  });
  const title = await askOr(t, "Its name in the chat", preset.name === pet ? preset.title : pet.charAt(0).toUpperCase() + pet.slice(1));
  const free = workspaceBudget(found).available;
  if (free.cpus < 1 || free.memoryMiB < 512) throw new HouseholdError(`'${house}' has no room for another bot (${free.cpus} vCPU, ${gib(free.memoryMiB)} free): raise its budget on its Resources page, then run house onboard again`);
  t.say(dim(`The workspace has ${free.cpus} vCPU and ${gib(free.memoryMiB)} free. A bot reserves its share even while it sleeps.`));
  const cpus = await until(t, () => askOr(t, "CPUs", String(Math.max(1, Math.min(preset.cpus, free.cpus)))), (answer) => {
    const value = Number(answer);
    if (!petCpuSchema.safeParse(value).success || value > free.cpus) throw new Error(`a whole number from 1 to ${free.cpus}`);
    return value;
  });
  const memoryMiB = await until(t, () => askOr(t, "Memory, GiB", String(Math.max(512, Math.min(preset.memoryMiB, free.memoryMiB)) / 1024)), (answer) => {
    const value = Number(answer) * 1024;
    if (!petMemorySchema.safeParse(value).success || value > free.memoryMiB) throw new Error(`from 0.5 to ${gib(free.memoryMiB)}, in steps of 0.125`);
    return value;
  });
  await config.addPet(house, pet, { agent: HARNESS[provider], key, title, emoji: preset.emoji, cpus, memoryMiB, lifecycle: DEFAULT_LIFECYCLE }, chat ? [chat] : []);
  const role = presetInstructions(preset, title);
  if (role) {
    try {
      await deps.addInstructions(house, pet, role);
    } catch (error) {
      t.say(yellow(`  its role was not added to its instructions (${(error as Error).message}): add it on the bot's Instructions tab`));
    }
  }
  outcome.added.push(`bot ${pet}`);
  return { pet, preset };
}

function freeName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}
