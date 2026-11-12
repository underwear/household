import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupPage, setupFields, type SetupDraft } from "./components/setup";
import { CHANNELS, KEY_METHODS, guidePieces } from "../src/core/onboarding";
import { routeOf } from "./router";
import type { KeyView } from "./api";

const HOST = { cpus: 8, memoryMiB: 16384 };
const claude = { name: "claude", provider: "anthropic", kind: "subscription" } as KeyView;
const page = (props: Partial<Parameters<typeof SetupPage>[0]>) =>
  renderToStaticMarkup(<SetupPage houses={[]} keys={[]} agents={[{ name: "claude-code-tmux" }, { name: "codex-app-server" }]} host={HOST} refresh={async () => {}} {...props} />);
const current = (html: string) => /<li class="setup-step current" aria-current="step">.*?<span class="setup-name">([^<]+)</.exec(html)?.[1];
const steps = (html: string) => [...html.matchAll(/<li class="setup-step (\w+)"/g)].map((match) => match[1]);

const chosen: SetupDraft = {
  key: { name: "claude", provider: "anthropic", label: "subscription" },
  workspace: { name: "home", cpus: 4, memoryMiB: 8192 },
  channel: { kind: "telegram-group", label: "Telegram group with topics", bot: "@home_bot", telegram: { listen: "w1", owner: { id: "777", name: "Igor" }, group: { id: "-1001234567890", title: "Family" } } },
};

test("/setup is the guided setup", () => {
  expect(routeOf("/setup")).toEqual({ page: "setup" });
});

test("the stepper: every step, the current one with its screens; what is chosen is said and can be opened again", () => {
  const fresh = page({});
  expect(current(fresh)).toBe("Model");
  expect(steps(fresh)).toEqual(["current", "todo", "todo", "todo"]);
  expect(fresh).toContain('<ol class="setup-subs"><li class="current"><span class="setup-sub">Provider</span></li><li><span class="setup-sub">Sign-in</span></li><li><span class="setup-sub">Connect</span></li></ol>');
  expect(fresh).not.toContain('<button type="button" class="setup-head">'); // nothing chosen, nothing to go back to

  const channel = page({ initial: { key: chosen.key, workspace: chosen.workspace } });
  expect(current(channel)).toBe("Channel");
  expect(steps(channel)).toEqual(["done", "done", "current", "todo"]);
  expect(channel).toContain('<span class="setup-summary">Claude · claude</span>');
  expect(channel).toContain('<span class="setup-summary">home · 4 vCPU · 8 GiB</span>');
  expect(channel.match(/<button type="button" class="setup-head">/g)).toHaveLength(2);
});

test("the model: saved keys apart from adding a new one; each way to sign in has its own guide", () => {
  const fresh = page({});
  expect(fresh).toContain('<legend class="field-label">Provider</legend>');
  expect(fresh).not.toContain("Saved keys");
  expect(fresh).toContain(">Claude<");
  expect(fresh).toContain(">ChatGPT / OpenAI<");
  const known = page({ keys: [claude] });
  expect(known).toContain('<legend class="field-label">Saved keys</legend>');
  expect(known).toContain('<span class="mono">claude</span>');
  expect(known).toContain('<legend class="field-label">Add a new key</legend>');
  expect(known.indexOf("Saved keys")).toBeLessThan(known.indexOf("Add a new key"));
  for (const method of KEY_METHODS) expect(method.steps.length).toBeGreaterThan(1);
  expect(KEY_METHODS.filter((method) => method.provider === "openai").map((method) => method.input.kind)).toEqual(["device", "paste"]);
  expect(KEY_METHODS.filter((method) => method.provider === "anthropic").map((method) => method.input.kind)).toEqual(["claude-signin", "paste", "paste"]);
});

test("channels: a Telegram group with topics recommended, the bot's own threads marked beta, plain DM and Slack too", () => {
  const html = page({ initial: { key: chosen.key, workspace: chosen.workspace } });
  expect(CHANNELS.map((channel) => channel.kind)).toEqual(["telegram-group", "telegram-private", "telegram-dm", "slack-private"]);
  expect(html).toContain('Telegram group with topics<span class="soon">Recommended</span>');
  expect(html).toContain('Telegram, a thread per bot<span class="soon">Beta</span>');
  expect(html).toContain(">Skip for now<");
  expect(html).toMatch(/checked="" value="telegram-group"/);
});

test("review: everything chosen in one list, each with Change, setup's own bot, and one button that makes it all", () => {
  const html = page({ initial: chosen });
  expect(current(html)).toBe("Review");
  expect(html).toContain("Nothing is made yet");
  expect(html).toContain("Claude · key claude");
  expect(html).toContain("Telegram group with topics · @home_bot");
  expect(html).toContain("owner Igor · group Family");
  expect(html).toContain("🤖 Assistant");
  expect(html).toContain("Claude Code · 2 vCPU · 1 GiB");
  expect(html.match(/>Change</g)).toHaveLength(3); // the bot is setup's own
  expect(html).toContain(">Set it all up<");
});

test("the request that makes it all: a key by name or pasted, the channel with its owner and group", () => {
  expect(setupFields(chosen)).toEqual({
    key: "claude",
    workspace: { name: "home", cpus: 4, memoryMiB: 8192 },
    channel: { telegram: { listen: "w1", owner: "777", chat: "-1001234567890" } },
  });
  expect(setupFields({ ...chosen, key: { name: "anthropic", provider: "anthropic", label: "Anthropic API key", pasted: "sk-ant-api03-x" } })!.key).toEqual({ name: "anthropic", provider: "anthropic", value: "sk-ant-api03-x", note: "Anthropic API key" });
  expect(setupFields({ ...chosen, channel: null })!.channel).toBeNull();
  expect(setupFields({ ...chosen, channel: undefined })).toBeUndefined();
});

test("a guide line's markup: words, code, bold and links, in order", () => {
  expect(guidePieces("Run `claude setup-token`, press **Create key** ([help](https://example.com/a)).")).toEqual([
    { kind: "text", text: "Run " }, { kind: "code", text: "claude setup-token" }, { kind: "text", text: ", press " },
    { kind: "bold", text: "Create key" }, { kind: "text", text: " (" }, { kind: "link", text: "help", href: "https://example.com/a" }, { kind: "text", text: ")." },
  ]);
});
