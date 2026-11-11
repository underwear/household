import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupPage, setupFields, type SetupDraft } from "./components/setup";
import { BOT_PRESETS, CHANNELS, KEY_METHODS, guidePieces, presetInstructions } from "../src/core/onboarding";
import { routeOf } from "./router";
import type { KeyView } from "./api";

const HOST = { cpus: 8, memoryMiB: 16384 };
const claude = { name: "claude", provider: "anthropic", kind: "subscription" } as KeyView;
const page = (props: Partial<Parameters<typeof SetupPage>[0]>) =>
  renderToStaticMarkup(<SetupPage houses={[]} keys={[]} agents={[{ name: "claude-code-tmux" }, { name: "codex-app-server" }]} host={HOST} refresh={async () => {}} notify={() => {}} {...props} />);
const current = (html: string) => /<li class="setup-step current" aria-current="step">.*?<span class="setup-name">([^<]+)</.exec(html)?.[1];
const steps = (html: string) => [...html.matchAll(/<li class="setup-step (\w+)"/g)].map((match) => match[1]);

const assistant = BOT_PRESETS[0]!;
const chosen: SetupDraft = {
  key: { name: "claude", provider: "anthropic", label: "subscription" },
  workspace: { name: "home", cpus: 4, memoryMiB: 8192 },
  channel: { kind: "telegram-group", label: "Telegram group with topics", bot: "@home_bot", telegram: { listen: "w1", owner: { id: "777", name: "Igor" }, group: "-1001234567890" } },
  bot: { preset: assistant, name: "assistant", title: "Jarvis", emoji: "🤖", cpus: 2, memoryMiB: 4096, scouts: true, sideworkers: false },
};

test("/setup is the guided setup", () => {
  expect(routeOf("/setup")).toEqual({ page: "setup" });
});

test("the stepper: every step, the current one with its screens; what is chosen is said and can be opened again", () => {
  const fresh = page({});
  expect(current(fresh)).toBe("Model");
  expect(steps(fresh)).toEqual(["current", "todo", "todo", "todo", "todo"]);
  expect(fresh).toContain('<ol class="setup-subs"><li class="current"><span class="setup-sub">Provider</span></li><li><span class="setup-sub">Sign-in</span></li><li><span class="setup-sub">Connect</span></li></ol>');
  expect(fresh).not.toContain('<button type="button" class="setup-head">'); // nothing chosen, nothing to go back to

  const channel = page({ initial: { key: chosen.key, workspace: chosen.workspace } });
  expect(current(channel)).toBe("Channel");
  expect(steps(channel)).toEqual(["done", "done", "current", "todo", "todo"]);
  expect(channel).toContain('<span class="setup-summary">Claude · claude</span>');
  expect(channel).toContain('<span class="setup-summary">home · 4 vCPU · 8 GiB</span>');
  expect(channel.match(/<button type="button" class="setup-head">/g)).toHaveLength(2);
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
  const html = page({ initial: { key: chosen.key, workspace: chosen.workspace } });
  expect(CHANNELS.map((channel) => channel.kind)).toEqual(["telegram-group", "telegram-private", "telegram-dm", "slack-private"]);
  expect(html).toContain('Telegram group with topics<span class="soon">Recommended</span>');
  expect(html).toContain('Telegram, a thread per bot<span class="soon">Beta</span>');
  expect(html).toContain(">Skip for now<");
  expect(html).toMatch(/checked="" value="telegram-group"/);
});

test("review: everything chosen in one list, each with Change, and one button that makes it all; nothing is made before", () => {
  const html = page({ initial: chosen });
  expect(current(html)).toBe("Review");
  expect(html).toContain("Nothing is made yet");
  expect(html).toContain("Claude · key claude");
  expect(html).toContain("Telegram group with topics · @home_bot");
  expect(html).toContain("owner Igor");
  expect(html).toContain("🤖 Jarvis");
  expect(html.match(/>Change</g)).toHaveLength(4);
  expect(html).toContain(">Set it all up<");
});

test("the request that makes it all: a key by name or pasted, the group as the chat, the bot's role", () => {
  const fields = setupFields(chosen)!;
  expect(fields).toMatchObject({
    key: "claude",
    workspace: { name: "home", cpus: 4, memoryMiB: 8192 },
    channel: { telegram: { listen: "w1", owner: "777", chat: "-1001234567890" } },
    bot: { name: "assistant", title: "Jarvis", cpus: 2, memoryMiB: 4096 },
    features: { scouts: true, sideworkers: false },
  });
  expect(fields.bot.role).toStartWith("## Your role\n\nYou are Jarvis");
  expect(setupFields({ ...chosen, key: { name: "anthropic", provider: "anthropic", label: "Anthropic API key", pasted: "sk-ant-api03-x" } })!.key).toEqual({ name: "anthropic", provider: "anthropic", value: "sk-ant-api03-x", note: "Anthropic API key" });
  expect(setupFields({ ...chosen, channel: null })!.channel).toBeNull();
  expect(setupFields({ ...chosen, bot: undefined })).toBeUndefined();
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
