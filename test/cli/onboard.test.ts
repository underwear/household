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
  const house = async (name = "my-house") => (await config.load()).houses.find((each) => each.name === name)!;
  return { config, calls, run, house };
}

/** The first run with Enter everywhere, not starting the daemon. */
const FIRST = ["", "sk-ant-oat01-onboard-test", "", TOKEN, "", "", "", "", "", "", "", "n"];

test("Enter all the way: a Claude key, my-house, the bot and its first writer as owner, assistant, scouts and sideworkers on, then the daemon", async () => {
  const { config, calls, run, house } = setup();
  const io = await run([...FIRST.slice(0, -1), ""]);
  expect((await config.load()).keys).toMatchObject([{ name: "claude", provider: "anthropic", value: "sk-ant-oat01-onboard-test" }]);
  const home = await house();
  expect(home.people.owners).toMatchObject([{ platform: "telegram", id: "777" }]);
  expect(home.channels).toMatchObject([{ kind: "telegram-private", chat: "777", token: TOKEN, pets: ["assistant"] }]);
  expect(home.pets).toMatchObject([{ name: "assistant", title: "Assistant", agent: "claude-code-tmux", key: "claude", cpus: 2, memoryMiB: 1024 }]);
  expect(houseFeatures(home)).toMatchObject({ scouts: true, sideworkers: true });
  expect(home.scouts?.length).toBeGreaterThan(0); // the General scout, seeded when scouts first go on
  expect(calls).toEqual(["start"]);
  expect(io.said()).toContain("Added: key claude, house my-house, @house_bot with owner Igor, pet assistant");
  expect(io.said()).toContain("house dashboard");
  expect(io.said()).toContain("claude plugin install household@household");
});

test("wrong answers are said and asked again; Codex signs in; features off; a running daemon is told, not started", async () => {
  const { calls, run, house } = setup({ daemonUp: async () => true });
  const io = await run([
    "2", "",                     // Codex, with ChatGPT
    "Bad Name", "home",          // house
    "123:nope", TOKEN,           // bot token: refused, then good
    "n", "abc", "555",           // not me; a typed id, wrong then right
    "helper", "Helper", "0", "4", "0.3", "3", // pet with resources outside, then inside the bounds
    "n", "n",                    // scouts, sideworkers off
  ]);
  const home = await house("home");
  expect(home.pets).toMatchObject([{ name: "helper", agent: "codex-app-server", key: "codex", cpus: 4, memoryMiB: 3072 }]);
  expect(home.people.owners).toMatchObject([{ id: "555" }]);
  expect(houseFeatures(home)).toMatchObject({ scouts: false, sideworkers: false });
  expect(calls).toEqual(["codex codex", "notify"]);
  expect(io.said()).toContain("Telegram does not know this bot token");
  expect(io.said()).toContain("a whole number from 1 to 8");
});

test("run again with Enter: what there is is shown, picked and kept; nothing is added", async () => {
  const { config, run, house } = setup();
  await run(FIRST);
  const before = await config.load();
  // agent, use claude, house my-house, keep the bot, keep the pets, keep scouts on, keep sideworkers on, no start
  const io = await run(["", "", "", "", "", "", "", "n"]);
  expect(io.said()).toContain("You have Household set up already");
  expect(io.said()).toContain("house my-house: @house_bot, assistant");
  expect(io.said()).toContain("Kept as it was: key claude, house my-house, @house_bot, pets assistant");
  expect(io.said()).not.toContain("Added:");
  expect(await config.load()).toEqual(before);
  expect(houseFeatures(await house())).toMatchObject({ scouts: true, sideworkers: true });
});

test("run again to extend: a new key, a second pet in the same chat, scouts turned off", async () => {
  const { config, run, house } = setup();
  await run(FIRST);
  const io = await run([
    "", "2", "sk-ant-api03-second", // Claude, a new key
    "", "",                         // my-house, keep the bot
    "2", "", "", "", "",            // add a pet: assistant-2, its title, cpus, memory
    "n", "",                        // scouts: not kept on; sideworkers kept on
    "n",
  ]);
  expect((await config.load()).keys.map((key) => key.name)).toEqual(["claude", "claude-2"]);
  const home = await house();
  expect(home.pets.map((pet) => [pet.name, pet.key])).toEqual([["assistant", "claude"], ["assistant-2", "claude-2"]]);
  expect(home.channels[0]!.pets).toEqual(["assistant", "assistant-2"]);
  expect(houseFeatures(home)).toMatchObject({ scouts: false, sideworkers: true });
  expect(io.said()).toContain("Added: key claude-2, pet assistant-2");
});

test("another bot in the same chat: the token changes, owners and pets stay", async () => {
  const { run, house } = setup();
  await run(FIRST);
  const io = await run(["", "", "", "2", "bad", OTHER, "", "", "", "n"]);
  const home = await house();
  expect(home.channels).toMatchObject([{ chat: "777", token: OTHER, pets: ["assistant"] }]);
  expect(home.people.owners).toMatchObject([{ id: "777" }]);
  expect(io.said()).toContain("Telegram does not know this bot token");
  expect(io.said()).toContain("Added: @other_bot");
});

test("a new house next to one there is: its own name, bot and pet", async () => {
  const { config, run } = setup();
  await run(FIRST);
  await run(["", "", "2", "my-house", "", OTHER, "", "", "", "", "", "", "", "n"]); // my-house is taken: the offered name
  const houses = (await config.load()).houses;
  expect(houses.map((house) => house.name)).toEqual(["my-house", "my-house-2"]);
  expect(houses[1]).toMatchObject({ channels: [{ token: OTHER }], pets: [{ name: "assistant", key: "claude" }] });
});

test("nobody writes to the bot, or it cannot be listened to: the id is asked for", async () => {
  for (const firstContact of [async () => undefined, async () => { throw new Error("getUpdates: 409 Conflict"); }]) {
    const { run, house } = setup({ firstContact });
    const io = await run(["", "sk-ant-oat01-onboard-test", "", TOKEN, "999", "", "", "", "", "", "", "n"]);
    expect((await house()).people.owners).toMatchObject([{ id: "999" }]);
    expect(io.asked.some((question) => question.includes("numeric Telegram id"))).toBe(true);
  }
});

test("Codex here: its login is offered first and copied; if that fails, a code sign-in follows", async () => {
  const local = { file: "/home/me/.codex/auth.json", email: "me@example.com", plan: "pro" };
  const copied = setup({ localCodex: () => local });
  const io = await copied.run(["2", "", "", TOKEN, "", "", "", "", "", "", "", "n"]);
  expect(io.said()).toContain("With the ChatGPT login of your Codex here — me@example.com, ChatGPT pro");
  expect(copied.calls).toEqual(["import codex"]);
  expect((await copied.house()).pets).toMatchObject([{ key: "codex", agent: "codex-app-server" }]);
  const failing = setup({ localCodex: () => local, codexImport: async () => { throw new Error("that Codex login has ended"); } });
  const after = await failing.run(["2", "", "", TOKEN, "", "", "", "", "", "", "", "n"]);
  expect(after.said()).toContain("that Codex login has ended; sign in with a code instead");
  expect(failing.calls).toEqual(["codex codex"]);
});

test("Claude Code here: the wizard runs claude setup-token, then takes the token it printed", async () => {
  const { calls, config, run } = setup({ claudeHere: async () => true });
  await run(["", "", "sk-ant-oat01-made-here", "", TOKEN, "", "", "", "", "", "", "", "n"]);
  expect(calls).toEqual(["setup-token"]);
  expect((await config.load()).keys).toMatchObject([{ name: "claude", value: "sk-ant-oat01-made-here" }]);
});
