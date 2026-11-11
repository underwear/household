/**
 * What setup offers, the same in the web admin (/setup) and `house onboard`: the ways to give Household a model (a
 * provider, then how to sign in), the channels to talk through, and ready setups for a first bot, each with the
 * steps to get what it needs. A step is a line of words with a little markup each front end draws its own way:
 * `code`, **bold** and [text](https://…).
 */

export type Provider = "anthropic" | "openai";

export interface ProviderOption {
  id: Provider;
  label: string;
  description: string;
  /** The harness its keys run. */
  harness: "claude-code-tmux" | "codex-app-server";
}

export const PROVIDERS: ProviderOption[] = [
  { id: "anthropic", label: "Claude", description: "Your bots run Claude Code. A Claude Pro or Max subscription, or an Anthropic API key.", harness: "claude-code-tmux" },
  { id: "openai", label: "ChatGPT / OpenAI", description: "Your bots run Codex. A ChatGPT Plus or Pro subscription, or an OpenAI API key.", harness: "codex-app-server" },
];

/** How a key gets in: pasted, a ChatGPT sign-in by code, or a copy of this machine's Codex login. */
export type KeyInput = { kind: "paste"; label: string; placeholder: string; prefix: string; wrong: string } | { kind: "device" } | { kind: "local" };

export interface KeyMethod {
  id: string;
  provider: Provider;
  label: string;
  description: string;
  /** The key's name in Household. */
  name: string;
  /** What to do to get the credential, in order. */
  steps: string[];
  input: KeyInput;
  /** Offered only when this machine has a Codex login to copy. */
  needsLocalCodex?: true;
}

export const KEY_METHODS: KeyMethod[] = [
  {
    id: "claude-subscription", provider: "anthropic", name: "claude",
    label: "Claude subscription", description: "Pro or Max. Usage counts against your plan; nothing is billed apart.",
    steps: [
      "Install Claude Code on any computer ([how](https://code.claude.com/docs/en/setup)).",
      "Run `claude setup-token` and sign in with your Claude account in the browser.",
      "Copy the token it prints (`sk-ant-oat01-…`, valid for a year) and paste it here.",
    ],
    input: { kind: "paste", label: "Token", placeholder: "sk-ant-oat01-…", prefix: "sk-ant-", wrong: "That does not look like a Claude token (sk-ant-oat01-…)." },
  },
  {
    id: "anthropic-api", provider: "anthropic", name: "anthropic",
    label: "Anthropic API key", description: "Pay per use, billed by Anthropic.",
    steps: [
      "Open [API keys in the Claude Console](https://platform.claude.com/settings/keys) and sign in.",
      "Press **Create key** and name it, for example “Household”.",
      "Copy the key (`sk-ant-api03-…`) and paste it here. The Console shows it only once.",
    ],
    input: { kind: "paste", label: "API key", placeholder: "sk-ant-api03-…", prefix: "sk-ant-", wrong: "That does not look like an Anthropic API key (sk-ant-api03-…)." },
  },
  {
    id: "chatgpt-local", provider: "openai", name: "chatgpt", needsLocalCodex: true,
    label: "ChatGPT login of Codex on this machine", description: "Household takes a copy and keeps it fresh. Nothing to type.",
    steps: [
      "Household copies the ChatGPT login of the Codex installed here (`~/.codex`).",
      "It is the same sign-in: if you sign out of Codex there, sign Household in again.",
    ],
    input: { kind: "local" },
  },
  {
    id: "chatgpt", provider: "openai", name: "chatgpt",
    label: "ChatGPT subscription", description: "Plus or Pro. Sign in with a code on any device, your phone included.",
    steps: [
      "Start the sign-in: Household shows a link and a one-time code.",
      "Open the link, sign in to ChatGPT and enter the code. If ChatGPT refuses device codes, allow them in its security settings ([help](https://learn.chatgpt.com/docs/auth?surface=cli#login-on-headless-devices)).",
      "Setup goes on by itself once you are signed in.",
    ],
    input: { kind: "device" },
  },
  {
    id: "openai-api", provider: "openai", name: "openai",
    label: "OpenAI API key", description: "Pay per use, billed by OpenAI.",
    steps: [
      "Open [API keys on the OpenAI Platform](https://platform.openai.com/api-keys) and sign in.",
      "Press **Create new secret key** and name it, for example “Household”.",
      "Copy the key (`sk-…`) and paste it here. The Platform shows it only once.",
    ],
    input: { kind: "paste", label: "API key", placeholder: "sk-proj-…", prefix: "sk-", wrong: "That does not look like an OpenAI API key (sk-…)." },
  },
];

export type SetupChannelKind = "telegram-group" | "telegram-private" | "telegram-dm" | "slack-private";

/** A channel setup connects: its kind, what to get ready, and how its owner is found. */
export interface ChannelOption {
  kind: SetupChannelKind;
  label: string;
  description: string;
  recommended?: true;
  beta?: true;
  steps: string[];
}

const BOTFATHER = "In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username. It gives you a token.";

export const CHANNELS: ChannelOption[] = [
  {
    kind: "telegram-group", recommended: true,
    label: "Telegram group with topics",
    description: "A Telegram group of yours with Topics on: a topic per bot, scout and sideworker. Others you add can talk to the bots as guests.",
    steps: [
      BOTFATHER,
      "Create a group (or open yours) and turn on **Topics** in its settings.",
      "Add your bot to the group and make it an admin with **Manage topics** and **Delete messages**.",
      "Find the group's id: open [Telegram Web](https://web.telegram.org/a), open the group, and copy everything after `#` in the address (`-100…`).",
      "Paste the token and the id here.",
    ],
  },
  {
    kind: "telegram-private", beta: true,
    label: "Telegram, a thread per bot",
    description: "Your private chat with a Telegram bot, with a thread per bot. Uses Telegram's bot Threaded Mode, which is still in beta.",
    steps: [
      BOTFATHER,
      "In BotFather's Mini App (the menu button), open your bot → **Bot Settings → Threads Settings**.",
      "Turn **Threaded Mode** on, and stop users from creating threads: Household creates them.",
      "Paste the token here.",
    ],
  },
  {
    kind: "telegram-dm",
    label: "Telegram, one plain chat",
    description: "An ordinary private chat. Every bot answers there; call one by name (“Chef, …”) or reply to its message.",
    steps: [BOTFATHER, "Paste the token here."],
  },
  {
    kind: "slack-private",
    label: "Slack DM",
    description: "A direct message with a Slack app of yours, in your Slack workspace. Bots answer in threads.",
    steps: [
      "Create a Slack app from the Household manifest and install it in your workspace ([guide](https://github.com/underwear/household/blob/main/docs/slack.md#install)).",
      "In the app's settings, copy the **Bot User OAuth Token** (OAuth & Permissions, `xoxb-…`).",
      "Under **Basic Information → App-Level Tokens**, make one with `connections:write` (`xapp-…`).",
      "Paste both here.",
    ],
  },
];

/** How a Slack member finds their member ID, for the owner's step. */
export const SLACK_MEMBER_STEPS = ["In Slack, open your profile → **More** (⋯) → **Copy member ID**.", "Paste it here."];

/** A Telegram group's id: a negative number starting with -100. */
export const TELEGRAM_GROUP_ID = /^-100\d{5,16}$/;
/** A Telegram user's id. */
export const TELEGRAM_USER_ID = /^[1-9]\d{0,15}$/;

/** A ready setup for a first bot: its names, its share of the workspace, the helpers it gets, and its role. */
export interface BotPreset {
  id: string;
  label: string;
  description: string;
  name: string;
  title: string;
  emoji: string;
  cpus: number;
  memoryMiB: number;
  scouts: boolean;
  sideworkers: boolean;
  /** What it is for, added to its instructions; none for a blank bot. */
  role?: string;
}

export const BOT_PRESETS: BotPreset[] = [
  {
    id: "assistant",
    label: "Personal assistant",
    description: "Everyday help: questions, notes, reminders, planning, quick research. Scouts on, so it can browse with your approval.",
    name: "assistant", title: "Assistant", emoji: "🤖",
    cpus: 2, memoryMiB: 4096, scouts: true, sideworkers: false,
    role: `You are {title}, your owner's personal assistant. Help with everyday questions, writing, planning, reminders and quick research.
- Answer briefly and to the point; ask when a request is ambiguous.
- Keep what you learn about your owner's preferences in your memory, and use it.
- Use scheduled tasks for reminders and recurring checks.
- When you need the web, a browser or other tools you lack, use a scout.`,
  },
  {
    id: "developer",
    label: "Developer",
    description: "Writes and runs code in its VM: projects, scripts, tests, reviews. More CPU and memory; sideworkers on for parallel work.",
    name: "dev", title: "Dev", emoji: "🧑‍💻",
    cpus: 4, memoryMiB: 8192, scouts: true, sideworkers: true,
    role: `You are {title}, a software engineer working for your owner in your own VM.
- Keep projects under ~/work, each in its own git repository; commit small, well-described steps.
- Run the code and its tests before saying something works; show what you ran.
- For long, separate pieces of work, start a sideworker and keep your owner posted.
- Ask before anything destructive or outward-facing (pushing, publishing, deleting data).`,
  },
  {
    id: "researcher",
    label: "Researcher",
    description: "Digs into a topic and reports back with sources. Uses scouts for the browser.",
    name: "researcher", title: "Researcher", emoji: "🔎",
    cpus: 2, memoryMiB: 4096, scouts: true, sideworkers: false,
    role: `You are {title}, a research assistant.
- Find, compare and summarize information; always give your sources.
- Separate what the sources say from your own conclusions, and say how sure you are.
- Use a scout with a browser for the web; keep notes of long investigations in ~/work.`,
  },
  {
    id: "blank",
    label: "Blank",
    description: "Household's defaults, no role: you write its instructions yourself.",
    name: "bot", title: "Bot", emoji: "🤖",
    cpus: 2, memoryMiB: 2048, scouts: false, sideworkers: false,
  },
];

/** The preset's role as a section of a bot's instructions, under its display name; undefined for none. */
export function presetInstructions(preset: BotPreset, title: string): string | undefined {
  return preset.role ? `## Your role\n\n${preset.role.replaceAll("{title}", title)}` : undefined;
}

/** A guide line's pieces: words, `code`, **bold** and [text](url) links, in order. */
export type GuidePiece = { kind: "text" | "code" | "bold"; text: string } | { kind: "link"; text: string; href: string };

export function guidePieces(line: string): GuidePiece[] {
  const pieces: GuidePiece[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let at = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > at) pieces.push({ kind: "text", text: line.slice(at, match.index) });
    if (match[1] !== undefined) pieces.push({ kind: "code", text: match[1] });
    else if (match[2] !== undefined) pieces.push({ kind: "bold", text: match[2] });
    else pieces.push({ kind: "link", text: match[3]!, href: match[4]! });
    at = match.index + match[0].length;
  }
  if (at < line.length) pieces.push({ kind: "text", text: line.slice(at) });
  return pieces;
}

/** A sensible first budget for a workspace on this machine: half of it, at most 8 vCPU and 16 GiB. */
export function suggestedBudget(host: { cpus: number; memoryMiB: number }): { cpus: number; memoryMiB: number } {
  return { cpus: Math.max(1, Math.min(8, Math.floor(host.cpus / 2))), memoryMiB: Math.max(1, Math.min(16, Math.floor(host.memoryMiB / 1024 / 2))) * 1024 };
}
