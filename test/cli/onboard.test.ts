import { expect, test } from "bun:test";
import { knownAgents } from "../../src/app/agents";
import { configCheck } from "../../src/app/kinds";
import { onboard, type OnboardDeps } from "../../src/cli/onboard";
import type { Terminal } from "../../src/cli/terminal";
import { houseFeatures } from "../../src/core/house-features";
import { ConfigStore } from "../../src/infra/config-store";
import { resolvePaths } from "../../src/infra/paths";
import { tempDir } from "../helpers";

const TOKEN = "4242:good-token-of-the-house-bot-0001";
const OTHER = "4343:good-token-of-another-bot-00001";
const BOTS: Record<string, string> = { [TOKEN]: "@house_bot", [OTHER]: "@other_bot" };

/** A terminal that answers from a script, in order, and keeps what was said. */
function scripted(script: string[]) {
  const answers = [...script];
  const said: string[] = [];
  const asked: string[] = [];
  const next = async (question: string) => {
    asked.push(question);
    if (answers.length === 0) throw new Error(`no answer scripted for: ${question}\n--- said:\n${said.join("\n")}`);
    return answers.shift()!;
  };
  const terminal: Terminal = { say: (text = "") => { said.push(text); }, ask: next, secret: next };
  return { terminal, said: () => said.join("\n"), asked, left: () => answers.length };
}

function setup(overrides: Partial<OnboardDeps> = {}) {
  const paths = resolvePaths({ HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() });
  const config = new ConfigStore(paths.configFile, configCheck(knownAgents()));
  const calls: string[] = [];
  const deps: Omit<OnboardDeps, "terminal"> = {
    config, capacity: { cpus: 8, memoryMiB: 16384 },
    async checkBot(token) {
      if (!BOTS[token]) throw new Error("Telegram does not know this bot token");
      return { own: { token }, also: [], bot: BOTS[token] };
    },
    async checkSlack(tokens, member) {
      if (!/^U[A-Z0-9]+$/.test(member)) throw new Error("Copy your member ID from your Slack profile");
      return { own: tokens, also: [], chat: "T0123456789:D0123456789", owner: `T0123456789:${member}` };
    },
    addInstructions: async (house, pet, text) => { calls.push(`role ${house}/${pet}: ${text.split("\n")[2]}`); },
    botName: async (token) => BOTS[token],
    firstContact: async () => ({ id: "777", name: "Igor", username: "igor" }),
    codexLogin: async (name) => { calls.push(`codex ${name}`); await config.addKey(name, { provider: "openai", value: "sk-codex-test" }); },
    localCodex: () => undefined,
    codexImport: async (name) => { calls.push(`import ${name}`); await config.addKey(name, { provider: "openai", value: "codex-chatgpt:local" }); },
    claudeHere: async () => false,
    claudeSetupToken: async () => { calls.push("setup-token"); return true; },
    missing: async () => [],
    daemonUp: async () => false,
    notifyDaemon: async () => { calls.push("notify"); },
    startDaemon: async () => { calls.push("start"); },
    ...overrides,
  };
  /** Runs onboarding with these answers; fails if any is left over. */
  const run = async (answers: string[], more: Partial<OnboardDeps> = {}) => {
    const io = scripted(answers);
    await onboard({ ...deps, ...more, terminal: io.terminal });
    expect(io.left()).toBe(0);
    return io;
  };
  const house = async (name = "home") => (await config.load()).houses.find((each) => each.name === name)!;
  return { config, calls, run, house };
}

/** The group the first run connects. */
const GROUP = "-1001234567890";
/**
 * The first run with Enter everywhere, not starting the daemon: Claude by subscription, workspace home with its
 * suggested budget, a Telegram group (recommended, the first offered), a personal assistant.
 */
const FIRST = [
  "", "", "sk-ant-oat01-onboard-test", // Claude, its subscription, the token
  "", "", "",                          // home, 4 vCPU, 8 GiB (half of the 8 / 16 GiB machine)
  "", TOKEN, GROUP, "",                // a group: the bot, its id, "that's me"
  "", "", "", "", "",                  // a personal assistant: name, title, cpus, memory
  "", "",                              // scouts (on), sideworkers (off): the assistant's defaults
  "n",
];

test("Enter all the way: a Claude key, a workspace with a budget, a group and its owner, an assistant with its role", async () => {
  const { config, calls, run, house } = setup();
  const io = await run([...FIRST.slice(0, -1), ""]);
  expect((await config.load()).keys).toMatchObject([{ name: "claude", provider: "anthropic", value: "sk-ant-oat01-onboard-test", note: "Claude subscription" }]);
  const home = await house();
  expect(home.resources).toEqual({ cpus: 4, memoryMiB: 8192 });
  expect(home.people.owners).toMatchObject([{ platform: "telegram", id: "777" }]);
  expect(home.channels).toMatchObject([{ kind: "telegram-group", chat: GROUP, token: TOKEN, pets: ["assistant"] }]);
  expect(home.pets).toMatchObject([{ name: "assistant", title: "Assistant", emoji: "🤖", agent: "claude-code-tmux", key: "claude", cpus: 2, memoryMiB: 4096 }]);
  expect(houseFeatures(home)).toMatchObject({ scouts: true, sideworkers: false });
  expect(home.scouts?.length).toBeGreaterThan(0); // the General scout, seeded when scouts first go on
  expect(calls).toEqual(["role home/assistant: You are Assistant, your owner's personal assistant. Help with everyday questions, writing, planning, reminders and quick research.", "start"]);
  const said = io.said();
  expect(said).toContain("Telegram group with topics [recommended]");
  expect(said).toContain("Telegram, a thread per bot [beta]");
  expect(said).toContain("1. In Telegram, open @BotFather (https://t.me/BotFather), send /newbot");
  expect(said).toContain("in a private chat, not in the group");
  expect(said).toContain("Added: key claude, workspace home, @house_bot with owner Igor, bot assistant");
  expect(said).toContain("write in your Telegram group: each bot has its own topic there.");
  expect(said).toContain("claude plugin install household@household");
});

test("wrong answers are said and asked again; Codex signs in; a plain chat; a blank bot; a running daemon is told, not started", async () => {
  const { calls, run, house } = setup({ daemonUp: async () => true });
  const io = await run([
    "2", "",                     // ChatGPT / OpenAI, with ChatGPT
    "Bad Name", "lab",           // workspace
    "0", "1", "0.3", "0.5",      // its budget: outside, then inside the bounds
    "3", "123:nope", TOKEN,      // one plain chat; the token refused, then good
    "n", "abc", "555",           // not me; a typed id, wrong then right
    "4", "helper", "Helper", "", "", // a blank bot: its size is what is free
    "n", "n",                    // scouts, sideworkers off
  ]);
  const lab = await house("lab");
  expect(lab.resources).toEqual({ cpus: 1, memoryMiB: 512 });
  expect(lab.channels).toMatchObject([{ kind: "telegram-dm", chat: "555", pets: ["helper"] }]);
  expect(lab.pets).toMatchObject([{ name: "helper", agent: "codex-app-server", key: "chatgpt", cpus: 1, memoryMiB: 512 }]);
  expect(lab.people.owners).toMatchObject([{ id: "555" }]);
  expect(houseFeatures(lab)).toMatchObject({ scouts: false, sideworkers: false });
  expect(calls).toEqual(["codex chatgpt", "notify"]); // a blank bot has no role to add
  expect(io.said()).toContain("Telegram does not know this bot token");
  expect(io.said()).toContain("a whole number from 1 to 8");
  expect(io.said()).toContain("write to @house_bot in Telegram.");
});

test("run again with Enter: what there is is shown, picked and kept; nothing is added", async () => {
  const { config, run, house } = setup();
  await run(FIRST);
  const before = await config.load();
  // use claude, workspace home, keep the channel, keep the bots, keep scouts on, keep sideworkers off, no start
  const io = await run(["", "", "", "", "", "", "n"]);
  expect(io.said()).toContain("You have Household set up already");
  expect(io.said()).toContain("workspace home: @house_bot, assistant");
  expect(io.said()).toContain("Kept as it was: key claude, workspace home, @house_bot, bots assistant");
  expect(io.said()).not.toContain("Added:");
  expect(await config.load()).toEqual(before);
  expect(houseFeatures(await house())).toMatchObject({ scouts: true, sideworkers: false });
});

test("run again to extend: an Anthropic API key, a second bot in the same channel, scouts turned off", async () => {
  const { config, run, house } = setup();
  await run(FIRST);
  const io = await run([
    "2", "2", "sk-ant-api03-second", // add Claude, by an API key
    "", "",                          // home, keep the channel
    "2", "", "", "", "", "",         // add a bot: an assistant, assistant-2, its title, cpus, memory
    "n", "",                         // scouts off; sideworkers as the assistant has them (off)
    "n",
  ]);
  expect(io.said()).toContain("API keys in the Claude Console (https://platform.claude.com/settings/keys)");
  expect((await config.load()).keys.map((key) => key.name)).toEqual(["claude", "anthropic"]);
  const home = await house();
  expect(home.pets.map((pet) => [pet.name, pet.key])).toEqual([["assistant", "claude"], ["assistant-2", "anthropic"]]);
  expect(home.channels[0]!.pets).toEqual(["assistant", "assistant-2"]);
  expect(houseFeatures(home)).toMatchObject({ scouts: false, sideworkers: false });
  expect(io.said()).toContain("Added: key anthropic, bot assistant-2");
});

test("another bot in the same chat: the token changes, owners and pets stay", async () => {
  const { run, house } = setup();
  await run(FIRST);
  const io = await run(["", "", "2", "bad", OTHER, "", "", "", "n"]);
  const home = await house();
  expect(home.channels).toMatchObject([{ chat: GROUP, token: OTHER, pets: ["assistant"] }]);
  expect(home.people.owners).toMatchObject([{ id: "777" }]);
  expect(io.said()).toContain("Telegram does not know this bot token");
  expect(io.said()).toContain("Added: @other_bot");
});

test("a new workspace next to one there is: its own name, budget, channel and bot", async () => {
  const { config, run } = setup();
  await run(FIRST);
  await run(["", "2", "home", "", "", "", "", OTHER, "-1009876543210", "", "", "", "", "", "", "", "", "n"]); // home is taken: the offered name
  const houses = (await config.load()).houses;
  expect(houses.map((house) => house.name)).toEqual(["home", "home-2"]);
  expect(houses[1]).toMatchObject({ resources: { cpus: 4, memoryMiB: 8192 }, channels: [{ token: OTHER, chat: "-1009876543210" }], pets: [{ name: "assistant", key: "claude" }] });
});

test("a group's id is checked; nobody writes to the bot, or it cannot be listened to: the owner's id is asked for", async () => {
  for (const firstContact of [async () => undefined, async () => { throw new Error("getUpdates: 409 Conflict"); }]) {
    const { run, house } = setup({ firstContact });
    const io = await run([...FIRST.slice(0, 8), "12345", GROUP, "999", ...FIRST.slice(10)]);
    expect((await house()).people.owners).toMatchObject([{ id: "999" }]);
    expect((await house()).channels).toMatchObject([{ chat: GROUP }]);
    expect(io.said()).toContain("a negative number starting with -100");
    expect(io.asked.some((question) => question.includes("numeric Telegram id"))).toBe(true);
  }
});

test("Slack: the app's two tokens, then the member ID finds the DM; the member becomes the owner", async () => {
  const { run, house } = setup();
  const io = await run([...FIRST.slice(0, 6), "4", "xoxb-not-it", `xoxb-${"1".repeat(24)}`, `xapp-${"2".repeat(24)}`, "me", "U0123456789", ...FIRST.slice(10, -1), ""]); // and start: where to write is said
  const home = await house();
  expect(home.channels).toMatchObject([{ kind: "slack-private", chat: "T0123456789:D0123456789", pets: ["assistant"] }]);
  expect(home.people.owners).toMatchObject([{ platform: "slack", id: "T0123456789:U0123456789" }]);
  expect(io.said()).toContain("paste the Bot User OAuth Token");
  expect(io.said()).toContain("Copy your member ID from your Slack profile");
  expect(io.said()).toContain("write to it in your DM with the Slack app.");
});

test("the channel can wait: the bot joins none, and the summary says so", async () => {
  const { run, house } = setup();
  const io = await run([...FIRST.slice(0, 6), "5", ...FIRST.slice(10)]);
  const home = await house();
  expect(home.channels).toEqual([]);
  expect(home.pets).toMatchObject([{ name: "assistant" }]);
  expect(io.said()).toContain("bot assistant, no channel yet");
});

test("Codex here: its login is offered first and copied; if that fails, a ChatGPT sign-in follows", async () => {
  const local = { file: "/home/me/.codex/auth.json", email: "me@example.com", plan: "pro" };
  const answers = ["2", "", ...FIRST.slice(3)];
  const copied = setup({ localCodex: () => local });
  const io = await copied.run(answers);
  expect(io.said()).toContain("ChatGPT login of Codex on this machine — me@example.com, ChatGPT pro");
  expect(copied.calls[0]).toBe("import chatgpt");
  expect((await copied.house()).pets).toMatchObject([{ key: "chatgpt", agent: "codex-app-server" }]);
  const failing = setup({ localCodex: () => local, codexImport: async () => { throw new Error("that Codex login has ended"); } });
  const after = await failing.run(answers);
  expect(after.said()).toContain("that Codex login has ended; sign in with ChatGPT instead");
  expect(failing.calls[0]).toBe("codex chatgpt");
});

test("Claude Code here: the wizard offers claude setup-token, then takes the token it printed", async () => {
  const { calls, config, run } = setup({ claudeHere: async () => true });
  await run(["", "", "", "sk-ant-oat01-made-here", ...FIRST.slice(3)]);
  expect(calls[0]).toBe("setup-token");
  expect((await config.load()).keys).toMatchObject([{ name: "claude", value: "sk-ant-oat01-made-here" }]);
});

test("a bot Household runs already is not listened to (the daemon reads it): the owner's id is asked for", async () => {
  let listened = 0;
  const { run, house } = setup({ firstContact: async () => { listened++; return { id: "777", name: "Igor" }; } });
  await run(FIRST);
  // home's bot again, now as a plain chat with someone else: another channel of the same workspace
  await run(["", "", "3", "3", TOKEN, "888", "", "", "", "n"]);
  expect(listened).toBe(1);
  const home = await house();
  expect(home.channels.map((channel) => `${channel.kind}:${channel.chat}`)).toEqual([`telegram-group:${GROUP}`, "telegram-dm:888"]);
  expect(home.people.owners.map((owner) => owner.id)).toEqual(["777", "888"]);
});
