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
  const answered = async (question: string) => { const answer = await next(question); said.push("<answer>"); return answer; };
  // A question that can be taken back (a wait): taken back before it is answered when the wait ends at once;
  // "<wait>" leaves it unanswered until then.
  const ask = async (question: string, signal?: AbortSignal) => {
    if (!signal) return answered(question);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal.aborted) return "";
    if (answers[0] === "<wait>") {
      answers.shift();
      await new Promise((resolve) => signal.aborted ? resolve(undefined) : signal.addEventListener("abort", resolve, { once: true }));
      return "";
    }
    return answered(question);
  };
  const terminal: Terminal = { say: (text = "") => { said.push(text); }, ask, secret: answered };
  return { terminal, said: () => said.filter((text) => text !== "<answer>").join("\n"), saidLines: () => [...said], asked, left: () => answers.length };
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
    async watch(_token, { group, onContact, onGroup }) {
      onContact({ id: "777", name: "Igor", username: "igor" });
      if (group) onGroup({ id: GROUP, title: "Home", problems: [] });
      return "done";
    },
    checkGroup: async (_token, chat) => ({ id: chat, title: "Home", problems: [] }),
    botName: async (token) => BOTS[token],
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

/** The group the bot is found in. */
const GROUP = "-1001234567890";
/**
 * The first run with Enter everywhere, not starting the daemon: Claude by subscription, workspace home with its
 * suggested budget, a Telegram group (recommended, the first offered) found by watching the bot; then the bot.
 */
const FIRST = [
  "", "", "sk-ant-oat01-onboard-test", // Claude, its subscription, the token
  "", "", "",                          // home, 4 vCPU, 8 GiB (half of the 8 / 16 GiB machine)
  "", TOKEN, "",                       // a group: the bot; Igor wrote, "that's me"; the group was found
  "n",
];

test("Enter all the way: a Claude key, a workspace with a budget, a group found by itself with its owner, and the workspace's bot", async () => {
  const { config, calls, run, house } = setup();
  const io = await run([...FIRST.slice(0, -1), ""]);
  expect((await config.load()).keys).toMatchObject([{ name: "claude", provider: "anthropic", value: "sk-ant-oat01-onboard-test", note: "Claude subscription" }]);
  const home = await house();
  expect(home.resources).toEqual({ cpus: 4, memoryMiB: 8192 });
  expect(home.people.owners).toMatchObject([{ platform: "telegram", id: "777" }]);
  expect(home.channels).toMatchObject([{ kind: "telegram-group", chat: GROUP, token: TOKEN, pets: ["assistant"] }]);
  expect(home.pets).toMatchObject([{ name: "assistant", title: "Assistant", agent: "claude-code-tmux", key: "claude", cpus: 2, memoryMiB: 1024 }]);
  expect(houseFeatures(home)).toMatchObject({ scouts: true, sideworkers: true });
  expect(home.scouts?.length).toBeGreaterThan(0); // the General scout, seeded as the features are written
  expect(calls).toEqual(["start"]);
  const said = io.said();
  expect(said).toContain("1/3  Model");
  expect(said).not.toContain("4/");
  expect(said).not.toContain("Saved keys"); // none yet
  expect(said).toContain("Telegram group with topics [recommended]");
  expect(said).toContain("Telegram, a thread per bot [beta]");
  expect(said).toContain("1. In Telegram, open @BotFather (https://t.me/BotFather), send /newbot");
  expect(said).toContain("✓ message from Igor (@igor)");
  expect(said).toContain("✓ group Home is ready.");
  expect(said.indexOf("✓ Got everything. Setting it up, please wait…")).toBeGreaterThan(said.indexOf("✓ group Home is ready."));
  expect(said).toContain("Added: key claude, workspace home, @house_bot with owner Igor, bot assistant");
  expect(said).toContain("write in your Telegram group: each bot has its own topic there.");
  // Every answer is followed by a blank line: no wall of text.
  expect(io.saidLines().filter((text, index, all) => all[index - 1] === "<answer>" && text !== "")).toEqual([]);
});

test("wrong answers are said and asked again; Codex signs in; a plain chat; a running daemon is told, not started", async () => {
  const { calls, run, house } = setup({ daemonUp: async () => true });
  const io = await run([
    "2", "",                     // ChatGPT / OpenAI, with ChatGPT
    "Bad Name", "lab",           // workspace
    "0", "1", "0.3", "0.5",      // its budget: outside, then inside the bounds
    "3", "123:nope", TOKEN,      // one plain chat; the token refused, then good
    "n", "abc", "555",           // not me; a typed id, wrong then right
  ]);
  const lab = await house("lab");
  expect(lab.resources).toEqual({ cpus: 1, memoryMiB: 512 });
  expect(lab.channels).toMatchObject([{ kind: "telegram-dm", chat: "555", pets: ["assistant"] }]);
  expect(lab.pets).toMatchObject([{ name: "assistant", agent: "codex-app-server", key: "chatgpt", cpus: 1, memoryMiB: 512 }]); // as much as the budget allows
  expect(lab.people.owners).toMatchObject([{ id: "555" }]);
  expect(calls).toEqual(["codex chatgpt", "notify"]);
  expect(io.said()).toContain("Telegram does not know this bot token");
  expect(io.said()).toContain("a whole number from 1 to 8");
  expect(io.said()).toContain("write to @house_bot in Telegram.");
});

test("run again with Enter: saved keys apart from new ones; what there is is picked and kept; nothing is added", async () => {
  const { config, run } = setup();
  await run(FIRST);
  const before = await config.load();
  const io = await run(["", "", "", "n"]); // the saved claude key, workspace home, keep the channel, no start
  const said = io.said();
  expect(said).toContain("You have Household set up already");
  expect(said).toContain("workspace home: @house_bot, assistant");
  expect(said.indexOf("Saved keys")).toBeGreaterThan(-1);
  expect(said.indexOf("Saved keys")).toBeLessThan(said.indexOf("Add a new key"));
  expect(said).toContain("Kept as it was: key claude, workspace home, @house_bot, bots assistant");
  expect(said).not.toContain("Added:");
  expect(await config.load()).toEqual(before);
});

test("run again with a new key: an Anthropic API key, with its guide; the bot stays as it is", async () => {
  const { config, run, house } = setup();
  await run(FIRST);
  const io = await run(["2", "2", "sk-ant-api03-second", "", "", "n"]); // add Claude, by an API key; home; keep the channel
  expect(io.said()).toContain("API keys in the Claude Console (https://platform.claude.com/settings/keys)");
  expect((await config.load()).keys.map((key) => key.name)).toEqual(["claude", "anthropic"]);
  expect((await house()).pets.map((pet) => [pet.name, pet.key])).toEqual([["assistant", "claude"]]);
  expect(io.said()).toContain("Added: key anthropic.");
});

test("another bot in the same chat: the token changes, owners and pets stay", async () => {
  const { run, house } = setup();
  await run(FIRST);
  const io = await run(["", "", "2", "bad", OTHER, "n"]);
  const home = await house();
  expect(home.channels).toMatchObject([{ chat: GROUP, token: OTHER, pets: ["assistant"] }]);
  expect(home.people.owners).toMatchObject([{ id: "777" }]);
  expect(io.said()).toContain("Telegram does not know this bot token");
  expect(io.said()).toContain("Added: @other_bot");
});

test("a new workspace next to one there is: its own name, budget, channel and bot", async () => {
  const { config, run } = setup();
  await run(FIRST);
  await run(["", "2", "home", "", "", "", "", OTHER, "", "n"]); // home is taken: the offered name
  const houses = (await config.load()).houses;
  expect(houses.map((house) => house.name)).toEqual(["home", "home-2"]);
  expect(houses[1]).toMatchObject({ resources: { cpus: 4, memoryMiB: 8192 }, channels: [{ token: OTHER, chat: GROUP }], pets: [{ name: "assistant", key: "claude" }] });
});

test("nothing found by watching, or the watch fails: the ids are asked for, and the group is checked until it is ready", async () => {
  for (const watch of [async () => "timeout" as const, async () => { throw new Error("getUpdates: 409 Conflict"); }]) {
    let checks = 0;
    const checkGroup = async (_token: string, chat: string) => ({ id: chat, title: "Home", problems: checks++ === 0 ? ["turn on Topics in the group's settings"] : [] });
    const { run, house } = setup({ watch, checkGroup });
    const io = await run([...FIRST.slice(0, 8), "999", "12345", GROUP, "", "n"]); // the owner's id; the group's, wrong then right; Enter to check again
    expect((await house()).people.owners).toMatchObject([{ id: "999" }]);
    expect((await house()).channels).toMatchObject([{ chat: GROUP }]);
    expect(io.said()).toContain("a negative number starting with -100");
    expect(io.said()).toContain("! group Home still needs: turn on Topics in the group's settings");
    expect(io.said()).toContain("✓ group Home is ready.");
    expect(checks).toBe(2);
  }
});

test("a group found with something missing: said as it is found, and checked again until it is ready", async () => {
  let fixed = false;
  const { run, house } = setup({
    async watch(_token, { onContact, onGroup }) {
      onGroup({ id: GROUP, title: "Home", problems: ["make the bot an administrator of the group, with Manage topics and Delete messages"] });
      onContact({ id: "777", name: "Igor" });
      return "timeout";
    },
    checkGroup: async (_token, chat) => { const problems = fixed ? [] : ["give the bot the Delete messages right"]; fixed = true; return { id: chat, title: "Home", problems }; },
  });
  const io = await run([...FIRST.slice(0, 9), "", "", "n"]); // that's me; Enter to check again, twice
  expect((await house()).channels).toMatchObject([{ kind: "telegram-group", chat: GROUP }]);
  expect(io.said()).toContain("! group Home still needs: make the bot an administrator");
  expect(io.said()).toContain("! group Home still needs: give the bot the Delete messages right");
});

test("Slack: the app's two tokens, then the member ID finds the DM; the member becomes the owner", async () => {
  const { run, house } = setup();
  const io = await run([...FIRST.slice(0, 6), "4", "xoxb-not-it", `xoxb-${"1".repeat(24)}`, `xapp-${"2".repeat(24)}`, "me", "U0123456789", ""]); // and start: where to write is said
  const home = await house();
  expect(home.channels).toMatchObject([{ kind: "slack-private", chat: "T0123456789:D0123456789", pets: ["assistant"] }]);
  expect(home.people.owners).toMatchObject([{ platform: "slack", id: "T0123456789:U0123456789" }]);
  expect(io.said()).toContain("paste the Bot User OAuth Token");
  expect(io.said()).toContain("Copy your member ID from your Slack profile");
  expect(io.said()).toContain("write to it in your DM with the Slack app.");
});

test("the channel can wait: the bot joins none, and the summary says so", async () => {
  const { run, house } = setup();
  const io = await run([...FIRST.slice(0, 6), "5", "n"]);
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

test("a bot Household runs already is not watched (the daemon reads it): the owner's id is asked for", async () => {
  let watched = 0;
  const { run, house } = setup({ async watch(_token, { group, onContact, onGroup }) { watched++; onContact({ id: "777", name: "Igor" }); if (group) onGroup({ id: GROUP, title: "Home", problems: [] }); return "done"; } });
  await run(FIRST);
  // home's bot again, now as a plain chat with someone else: another channel of the same workspace
  await run(["", "", "3", "3", TOKEN, "888", "n"]);
  expect(watched).toBe(1);
  const home = await house();
  expect(home.channels.map((channel) => `${channel.kind}:${channel.chat}`)).toEqual([`telegram-group:${GROUP}`, "telegram-dm:888"]);
  expect(home.people.owners.map((owner) => owner.id)).toEqual(["777", "888"]);
});

test("while it waits, Enter says again what it is waiting for; once the wait ends, the ids missing are asked for", async () => {
  const { run, house } = setup({
    watch: (_token, { onContact }) => {
      onContact({ id: "777", name: "Igor" });
      return new Promise((resolve) => setTimeout(() => resolve("timeout"), 30));
    },
  });
  const io = await run([...FIRST.slice(0, 8), "", "<wait>", "", GROUP, "n"]); // Enter while it waits; then it ends: that's me; the group's id
  expect(io.said()).toContain("Waiting for the group: Add @house_bot to your group as an admin (Manage topics, Delete messages); if it is in the group already, send /start@house_bot there.");
  expect(io.said()).not.toContain("Waiting for your private message"); // Igor wrote already
  expect((await house()).channels).toMatchObject([{ kind: "telegram-group", chat: GROUP }]);
});

test("a group stuck on something: another group's id can be typed at the check, and is checked in its place", async () => {
  const checked: string[] = [];
  const { run, house } = setup({
    async watch(_token, { onContact, onGroup }) {
      onContact({ id: "777", name: "Igor" });
      onGroup({ id: "-5198099867", title: "Old", problems: ["turn on Topics in the group's settings"] });
      return "timeout";
    },
    checkGroup: async (_token, chat) => { checked.push(chat); return { id: chat, title: "Ours", problems: chat === GROUP ? [] : ["turn on Topics in the group's settings"] }; },
  });
  const io = await run([...FIRST.slice(0, 8), "", "", "12345", GROUP, "n"]); // that's me; Enter: check again; a wrong id, then the right one
  expect(checked).toEqual(["-5198099867", GROUP]);
  expect(io.said()).toContain("a negative number starting with -100");
  expect((await house()).channels).toMatchObject([{ kind: "telegram-group", chat: GROUP }]);
});
