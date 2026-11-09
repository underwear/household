import type { Contact } from "../channel-adapters/telegram";
import { HouseholdError } from "../core/errors";
import { houseFeatures, previewSettings } from "../core/house-features";
import { findHouse, type Household, type House } from "../core/household";
import { DEFAULT_LIFECYCLE } from "../core/lifecycle";
import { assertName } from "../core/names";
import { DEFAULT_PET_CPUS, DEFAULT_PET_MEMORY_MIB, gib, petCpuSchema, petMemorySchema, type HostCapacity } from "../core/resources";
import type { AlsoChannel, ConfigStore } from "../infra/config-store";
import type { LocalCodexLogin } from "./codex-login";
import { askOr, bold, choose, confirm, dim, green, until, yellow, type Terminal } from "./terminal";

export interface OnboardDeps {
  terminal: Terminal;
  config: ConfigStore;
  /** A bot token checked as `house channel add|set` checks it (`chat`: the channel it replaces the bot of). */
  checkBot(token: string, household: Household, house: string, chat?: string): Promise<{ own: Record<string, string>; also: AlsoChannel[]; bot: string }>;
  /** A configured bot's @username, when Telegram tells. */
  botName(token: string): Promise<string | undefined>;
  /** The first person to write to the bot from now, or undefined after a while. */
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
  capacity: HostCapacity;
  /** What this machine still lacks to run pets (said up front, not a stop). */
  missing(): Promise<string[]>;
  daemonUp(): Promise<boolean>;
  notifyDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
}

type Agent = "claude-code-tmux" | "codex-app-server";
const PROVIDER: Record<Agent, string> = { "claude-code-tmux": "anthropic", "codex-app-server": "openai" };
const STEPS = 6;
const step = (terminal: Terminal, n: number, title: string) => terminal.say(`\n${bold(`${n}/${STEPS}  ${title}`)}`);

/** What a run added and what it found and left as it was, for the summary at the end. */
interface Outcome { added: string[]; kept: string[] }

/**
 * `house onboard`: from nothing to a pet in Telegram, asking one thing at a time. Run again, it shows what there is,
 * offers it at every step and adds only what is chosen anew; nothing is removed. Every step is saved as it ends.
 */
export async function onboard(deps: OnboardDeps): Promise<void> {
  const { terminal: t, config } = deps;
  const outcome: Outcome = { added: [], kept: [] };
  const before = await config.load();
  t.say(bold("Household setup"));
  if (before.keys.length || before.houses.length) {
    t.say("You have Household set up already:");
    for (const line of await present(deps, before)) t.say(`  ${line}`);
    t.say(dim("This keeps all of it: every step offers what you have, or adds something new next to it."));
  } else {
    t.say("One workspace, one bot, a Telegram bot to talk to it. Ctrl-C stops at any point; what is done stays.");
  }
  for (const problem of await deps.missing()) t.say(yellow(`  ! ${problem}`));

  step(t, 1, "Harness and its key");
  const agent = await choose<Agent>(t, "Which harness will your bot run?", [
    { value: "claude-code-tmux", label: `Claude Code ${dim("— a Claude Pro or Max subscription (or an Anthropic API key)")}` },
    { value: "codex-app-server", label: `Codex ${dim("— a ChatGPT Plus or Pro subscription (or an OpenAI API key)")}` },
  ]);
  const key = await agentKey(deps, agent, outcome);

  step(t, 2, "Workspace");
  t.say(dim("A workspace is a trust zone: its own network allowlist, secrets, Telegram bot and owners."));
  const { house, created } = await houseOf(deps, outcome);

  step(t, 3, "Telegram");
  t.say(dim("Each workspace talks to you through its own bot; every bot and scout gets a thread in its chat. (More messengers are coming.)"));
  const channel = await telegram(deps, house, outcome);

  step(t, 4, "Bot");
  t.say(dim("A bot is an assistant powered by a harness in its own VM, with a home and memory that stay between sessions."));
  const pet = await petOf(deps, house, agent, key, channel.chat, outcome);

  const current = houseFeatures(findHouse(await config.load(), house)!);
  const feature = async (name: "scouts" | "sideworkers", label: string) => {
    if (created) return confirm(t, `Turn ${label} on?`);
    const on = await confirm(t, `${label[0]!.toUpperCase()}${label.slice(1)} are ${current[name] ? "on" : "off"} in '${house}'. Keep them ${current[name] ? "on" : "off"}?`);
    return on ? current[name] : !current[name];
  };
  step(t, 5, "Scouts");
  t.say(dim("Scouts are one-task helpers in their own VMs — a browser, media tools, dev tools. Your bot calls one by name"));
  t.say(dim("and you approve each run in the chat, so the bot itself never needs that access."));
  const scouts = await feature("scouts", "scouts");

  step(t, 6, "Sideworkers");
  t.say(dim("Sideworkers are like subagents for longer work: your bot starts an extra bot in its own VM, and you can talk"));
  t.say(dim("to it on its own, in parallel — one developing a project, say, while your bot carries on with the rest."));
  const sideworkers = await feature("sideworkers", "sideworkers");
  const now = findHouse(await config.load(), house)!;
  await config.setHouseFeatures(house, { features: { ...houseFeatures(now), scouts, sideworkers }, preview: previewSettings(now) });

  const up = await deps.daemonUp();
  if (up) await deps.notifyDaemon();
  t.say(`\n${green("✓ Done.")} Workspace ${bold(house)}: bot ${bold(pet)} in ${channel.bot}; scouts ${scouts ? "on" : "off"}, sideworkers ${sideworkers ? "on" : "off"}.`);
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
  if (up) return t.say(`\nHousehold is running and has the changes: write to ${channel.bot}.`);
  if (await confirm(t, `\nStart Household now (in this terminal, Ctrl-C stops it)?`)) {
    t.say(dim(`Then write to ${channel.bot} in Telegram.`));
    await deps.startDaemon();
  }
}

/** What the config has, a line each: its keys, then each house with its bot and pets. */
async function present(deps: OnboardDeps, household: Household): Promise<string[]> {
  const lines = household.keys.length ? [`keys: ${household.keys.map((key) => `${key.name} (${key.provider})`).join(", ")}`] : [];
  for (const house of household.houses) {
    const bot = await botOf(deps, house);
    const pets = house.pets.map((pet) => pet.name).join(", ") || "no bots";
    lines.push(`workspace ${house.name}: ${bot ? `${bot.name}, ` : ""}${pets}`);
  }
  return lines;
}

async function botOf(deps: OnboardDeps, house: House): Promise<{ chat: string; name: string } | undefined> {
  const channel = house.channels.find((each) => each.kind === "telegram-private") as ({ chat: string; token?: string } | undefined);
  if (!channel) return undefined;
  const name = channel.token ? await deps.botName(channel.token).catch(() => undefined) : undefined;
  return { chat: channel.chat, name: name ?? `the bot of chat ${channel.chat}` };
}

/** The key the pet runs on: one of its provider the config has, or a new one. */
async function agentKey(deps: OnboardDeps, agent: Agent, outcome: Outcome): Promise<string> {
  const { terminal: t, config } = deps;
  const provider = PROVIDER[agent];
  const household = await config.load();
  const existing = household.keys.filter((key) => key.provider === provider);
  if (existing.length) {
    const picked = await choose(t, `Your ${provider} ${existing.length === 1 ? "key" : "keys"}:`, [
      ...existing.map((key) => ({ value: key.name, label: `Use '${key.name}'${key.note ? ` ${dim(`— ${key.note}`)}` : ""}` })),
      { value: "", label: "Add a new key" },
    ]);
    if (picked) { outcome.kept.push(`key ${picked}`); return picked; }
  }
  const name = freeName(household.keys.map((key) => key.name), agent === "claude-code-tmux" ? "claude" : "codex");
  if (agent === "codex-app-server") {
    const local = deps.localCodex();
    const how = await choose(t, "How will Codex sign in?", [
      ...(local ? [{ value: "local", label: `With the ChatGPT login of your Codex here ${dim(`— ${[local.email, local.plan && `ChatGPT ${local.plan}`].filter(Boolean).join(", ") || "found in ~/.codex"}`)}` }] : []),
      { value: "chatgpt", label: `With your ChatGPT subscription ${dim("— a code to enter in any browser, your phone too; nothing to install")}` },
      { value: "api", label: "An OpenAI API key" },
    ]);
    if (how === "local") {
      t.say(dim("Household takes a copy and keeps it fresh itself. It is the same sign-in as your Codex's: if that one ends, sign Household in again."));
      try {
        await deps.codexImport(name);
        outcome.added.push(`key ${name}`);
        t.say(`${green("✓")} connected${local!.email ? ` as ${local!.email}` : ""}.`);
        return name;
      } catch (error) {
        t.say(yellow(`  ${(error as Error).message}; sign in with a code instead:`));
      }
    }
    if (how === "local" || how === "chatgpt") {
      for (;;) {
        try {
          t.say(dim("Household signs in with its own Codex, apart from yours: open the link it shows and enter the code."));
          await deps.codexLogin(name);
          outcome.added.push(`key ${name}`);
          return name;
        } catch (error) {
          t.say(yellow(`  ${(error as Error).message}`));
          if (!(await confirm(t, "Try again?"))) throw new HouseholdError("no key, so no bot: run `house onboard` again when Codex can sign in");
        }
      }
    }
  } else {
    const here = await deps.claudeHere();
    const how = here
      ? await choose(t, "Claude needs a long-lived token from Claude Code:", [
        { value: "here", label: `Make one with your Claude Code here ${dim("— runs claude setup-token: you sign in in the browser, it prints the token")}` },
        { value: "paste", label: `Paste one ${dim("(claude setup-token on another computer) or an Anthropic API key")}` },
      ])
      : "paste";
    if (how === "here") {
      if (!(await deps.claudeSetupToken())) t.say(yellow("  claude setup-token did not finish; paste a token if you have one."));
      t.say(`Copy the token it printed ${dim("(sk-ant-oat01-…)")} and paste it below.`);
    } else {
      t.say(`On any computer with Claude Code, run ${bold("claude setup-token")}, sign in in the browser and paste the token`);
      t.say(`it prints here ${dim("(sk-ant-oat01-…, good for a year)")}. An Anthropic API key ${dim("(sk-ant-api03-…)")} works too.`);
    }
  }
  const prefix = provider === "anthropic" ? "sk-ant-" : "sk-";
  await until(t, () => t.secret("Paste it (hidden): "), async (value) => {
    if (!value.startsWith(prefix)) throw new Error(`that does not look like ${provider === "anthropic" ? "an Anthropic token (sk-ant-…)" : "an OpenAI key (sk-…)"}`);
    await config.addKey(name, { provider, value });
  });
  outcome.added.push(`key ${name}`);
  return name;
}

/** One of the houses there are, or a new one. */
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
  const house = await until(t, () => askOr(t, "Name", freeName(houses.map((house) => house.name), "my-workspace")), async (name) => {
    if (findHouse(await config.load(), name)) throw new Error(`'${name}' is taken: pick it from the list instead, or another name`);
    await config.createHouse(name);
    return name;
  });
  outcome.added.push(`workspace ${house}`);
  return { house, created: true };
}

/** The house's bot and its owner: the one it has (or the same chat with a new bot), or a new bot and whoever writes to it first. */
async function telegram(deps: OnboardDeps, house: string, outcome: Outcome): Promise<{ chat: string; bot: string }> {
  const { terminal: t, config } = deps;
  const present = await botOf(deps, findHouse(await config.load(), house)!);
  if (present) {
    const keep = await choose(t, `'${house}' talks through ${present.name}.`, [
      { value: "keep", label: "Keep it" },
      { value: "replace", label: `Another bot in the same chat ${dim("— a new token; owners and bots stay")}` },
    ]);
    if (keep === "keep") { outcome.kept.push(present.name); return { chat: present.chat, bot: present.name }; }
    botHowTo(t);
    const { own, also, bot } = await until(t, () => t.secret("New bot token (hidden): "), async (token) => deps.checkBot(token, await config.load(), house, present.chat));
    await config.updateChannel(house, present.chat, own, also);
    t.say(`${green("✓")} ${bot}, threads on. ${dim("Send it a message once, so it can write to you.")}`);
    outcome.added.push(bot);
    return { chat: present.chat, bot };
  }
  botHowTo(t);
  const { token, bot, own, also } = await until(t, () => t.secret("Bot token (hidden): "), async (token) => ({ token, ...(await deps.checkBot(token, await config.load(), house)) }));
  t.say(`${green("✓")} ${bot}, threads on.`);
  t.say(`Now open ${bold(`https://t.me/${bot.slice(1)}`)} and send the bot any message (Start works): that tells Household who you are.`);
  t.say(dim("Waiting up to 3 minutes…"));
  let contact: Contact | undefined;
  try {
    contact = await deps.firstContact(token);
  } catch (error) {
    t.say(yellow(`  could not listen to the bot (${(error as Error).message})`));
  }
  if (contact && !(await confirm(t, `Message from ${contact.name}${contact.username ? ` (@${contact.username})` : ""}. Is that you?`))) contact = undefined;
  const id = contact?.id ?? await until(t, () => t.ask(`Your numeric Telegram id ${dim("(@userinfobot tells it)")}: `), (id) => {
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new Error("a number, like 123456789");
    return id;
  });
  await config.addOwner(house, "telegram", id, contact?.name);
  await config.addChannel(house, { kind: "telegram-private", ...own, chat: id }, also);
  outcome.added.push(`${bot} with owner ${contact?.name ?? id}`);
  return { chat: id, bot };
}

function botHowTo(t: Terminal): void {
  t.say(`  1. In Telegram open ${bold("@BotFather")}, send ${bold("/newbot")}, pick a name and a username; it gives you a token.`);
  t.say(`  2. In BotFather's Mini App (the menu button) → your bot → ${bold("Bot Settings → Threads Settings")}:`);
  t.say(`     turn ${bold("Threaded Mode")} on, and stop users from creating threads (Household opens them).`);
}

/** The house's pets as they are, or a new one with its name, title and allocation, put in the chat. */
async function petOf(deps: OnboardDeps, house: string, agent: Agent, key: string, chat: string, outcome: Outcome): Promise<string> {
  const { terminal: t, config } = deps;
  const pets = findHouse(await config.load(), house)!.pets;
  if (pets.length) {
    const keep = await choose(t, `'${house}' has ${pets.map((pet) => `${pet.name} ${dim(`(${pet.agent ?? "claude-code-tmux"}, key ${pet.key})`)}`).join(", ")}.`, [
      { value: "keep", label: "Keep them as they are" },
      { value: "add", label: `Add another bot ${dim(`(${agent}, key ${key})`)}` },
    ]);
    if (keep === "keep") { outcome.kept.push(`bots ${pets.map((pet) => pet.name).join(", ")}`); return pets[0]!.name; }
  }
  const pet = await until(t, () => askOr(t, "Name", freeName(pets.map((each) => each.name), "assistant")), (name) => {
    assertName("pet", name);
    if (pets.some((each) => each.name === name)) throw new Error(`'${name}' is already in the workspace: another name`);
    return name;
  });
  const title = await askOr(t, "Its name in the chat", pet.charAt(0).toUpperCase() + pet.slice(1));
  const host = deps.capacity;
  t.say(dim(`This machine has ${host.cpus} CPUs and ${gib(host.memoryMiB)} of memory; a VM uses its share only while it works.`));
  const cpus = await until(t, () => askOr(t, "CPUs", String(DEFAULT_PET_CPUS)), (answer) => {
    const cpus = Number(answer);
    if (!petCpuSchema.safeParse(cpus).success || cpus > host.cpus) throw new Error(`a whole number from 1 to ${host.cpus}`);
    return cpus;
  });
  const memoryMiB = await until(t, () => askOr(t, "Memory, GiB", String(DEFAULT_PET_MEMORY_MIB / 1024)), (answer) => {
    const memoryMiB = Number(answer) * 1024;
    if (!petMemorySchema.safeParse(memoryMiB).success || memoryMiB > host.memoryMiB) throw new Error(`from 0.5 to ${gib(host.memoryMiB)}, in steps of 0.125`);
    return memoryMiB;
  });
  await config.addPet(house, pet, { agent, key, title, cpus, memoryMiB, lifecycle: DEFAULT_LIFECYCLE }, [chat]);
  outcome.added.push(`bot ${pet}`);
  return pet;
}

function freeName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}
