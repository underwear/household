import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupPage } from "./components/setup";
import { BOT_PRESETS, CHANNELS, KEY_METHODS, guidePieces, presetInstructions } from "../src/core/onboarding";
import { routeOf } from "./router";
import type { BotView, KeyView, WorkspaceView } from "./api";

const HOST = { cpus: 8, memoryMiB: 16384 };
const claude = { name: "claude", provider: "anthropic", kind: "subscription" } as KeyView;
const empty: WorkspaceView = { name: "home", allow: [], owners: [], channels: [], pets: [], resources: { total: { cpus: 4, memoryMiB: 8192 }, reserved: { cpus: 0, memoryMiB: 0 }, helpers: { cpus: 0, memoryMiB: 0 }, available: { cpus: 4, memoryMiB: 8192 }, allocations: [] } };
const page = (props: Partial<Parameters<typeof SetupPage>[0]>) =>
  renderToStaticMarkup(<SetupPage houses={[]} keys={[]} agents={[]} host={HOST} refresh={async () => {}} notify={() => {}} {...props} />);
const current = (html: string) => /<li class="setup-step current" aria-current="step">.*?<span class="setup-name">([^<]+)</.exec(html)?.[1];
const steps = (html: string) => [...html.matchAll(/<li class="setup-step (\w+)"/g)].map((match) => match[1]);

test("/setup is the guided setup", () => {
  expect(routeOf("/setup")).toEqual({ page: "setup" });
});

test("the stepper: every step, the current one with its screens; what is done says what was chosen and can be opened again", () => {
  const fresh = page({});
  expect(current(fresh)).toBe("Model");
  expect(steps(fresh)).toEqual(["current", "todo", "todo", "todo", "todo"]);
  expect(fresh).toContain('<ol class="setup-subs"><li class="current"><span class="setup-sub">Provider</span></li><li><span class="setup-sub">Sign-in</span></li><li><span class="setup-sub">Connect</span></li></ol>');
  expect(fresh).not.toContain('<button type="button" class="setup-head">'); // nothing done, nothing to go back to

  const channel = page({ houses: [empty], keys: [claude], resume: "home" });
  expect(current(channel)).toBe("Channel");
  expect(steps(channel)).toEqual(["done", "done", "current", "todo", "todo"]);
  expect(channel).toContain('<span class="setup-summary">Claude · claude</span>');
  expect(channel).toContain('<span class="setup-summary">home · 4 vCPU · 8 GiB</span>');
  expect(channel.match(/<button type="button" class="setup-head">/g)).toHaveLength(2); // the key and the workspace
});

test("the model starts with a provider (a key added before offered first); each way to sign in has its own guide", () => {
  const fresh = page({});
  expect(fresh).toContain(">Claude<");
  expect(fresh).toContain(">ChatGPT / OpenAI<");
  expect(page({ keys: [claude] })).toContain('Use key <span class="id">claude</span>');
  expect(page({ keys: [claude] })).toContain(">Add Claude<");
  for (const method of KEY_METHODS) expect(method.steps.length).toBeGreaterThan(1);
  expect(KEY_METHODS.filter((method) => method.provider === "openai").map((method) => method.input.kind)).toEqual(["local", "device", "paste"]);
});

test("channels: a Telegram group with topics recommended, the bot's own threads marked beta, plain DM and Slack too", () => {
  const html = page({ houses: [empty], keys: [claude], resume: "home" });
  expect(CHANNELS.map((channel) => channel.kind)).toEqual(["telegram-group", "telegram-private", "telegram-dm", "slack-private"]);
  expect(html).toContain('Telegram group with topics<span class="soon">Recommended</span>');
  expect(html).toContain('Telegram, a thread per bot<span class="soon">Beta</span>');
  expect(html).toContain(">Skip for now<");
  expect(html).toMatch(/checked="" value="telegram-group"/);
});

test("resumed for a workspace with a channel, setup asks what the bot is for; with a bot, it says how to reach it", () => {
  const telegram = { kind: "telegram-private", chat: "555", label: "Telegram", shown: { token: "@home_bot" }, pets: [] } as unknown as WorkspaceView["channels"][number];
  const withChannel = { ...empty, channels: [telegram] };
  const bot = page({ houses: [withChannel], keys: [claude], resume: "home" });
  expect(current(bot)).toBe("Bot");
  expect(bot).toContain('<span class="setup-summary">Telegram, a thread per bot · @home_bot</span>');
  for (const preset of BOT_PRESETS) expect(bot).toContain(preset.label);
  const done = page({ houses: [{ ...withChannel, pets: [{ name: "assistant", display: "🤖 Assistant", state: "running", key: "claude" } as BotView] }], keys: [claude], resume: "home" });
  expect(current(done)).toBe("Say hi");
  expect(done).toContain("https://t.me/home_bot");
  expect(done).toContain("It answers in its own thread.");
});

test("a preset's role goes into the bot's instructions under its display name; a blank bot gets none", () => {
  expect(presetInstructions(BOT_PRESETS[0]!, "Jarvis")).toStartWith("## Your role\n\nYou are Jarvis, your owner's personal assistant.");
  expect(presetInstructions(BOT_PRESETS.find((preset) => preset.id === "blank")!, "Bot")).toBeUndefined();
});

test("a guide line's markup: words, code, bold and links, in order", () => {
  expect(guidePieces("Run `claude setup-token`, press **Create key** ([help](https://example.com/a)).")).toEqual([
    { kind: "text", text: "Run " }, { kind: "code", text: "claude setup-token" }, { kind: "text", text: ", press " },
    { kind: "bold", text: "Create key" }, { kind: "text", text: " (" }, { kind: "link", text: "help", href: "https://example.com/a" }, { kind: "text", text: ")." },
  ]);
});
