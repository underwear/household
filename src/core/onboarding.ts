import { DEFAULT_PET_CPUS, DEFAULT_PET_MEMORY_MIB } from "./resources";

/**
 * What setup offers, the same in the web admin (/setup) and `house onboard`: the ways to give Household a model (a
 * provider, then how to sign in) and the channels to talk through, each with the steps to get what it needs, and
 * the bot it makes. A step is a line of words with a little markup each front end draws its own way:
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

/** How a key gets in: pasted, a ChatGPT sign-in by device code, or a Claude sign-in (a link, then the code it shows). */
export type KeyInput = { kind: "paste"; label: string; placeholder: string; prefix: string; wrong: string } | { kind: "device" } | { kind: "claude-signin" };

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
  /** The one to pick when unsure. */
  recommended?: true;
}

export const KEY_METHODS: KeyMethod[] = [
  {
    id: "claude-signin", provider: "anthropic", name: "claude", recommended: true,
    label: "Sign in to Claude", description: "Pro, Max or Team. Your bots also get this account's claude.ai connectors. Sign in again about once a month.",
    steps: [
      "Household starts Claude Code's own sign-in for you and shows its link.",
      "Open the link on any device, your phone too, and sign in to the account your bots should use.",
      "Paste the code Claude shows. Household keeps the sign-in fresh, and asks you to sign in again when Claude ends it (about monthly).",
    ],
    input: { kind: "claude-signin" },
  },
  {
    id: "claude-subscription", provider: "anthropic", name: "claude",
    label: "Claude subscription token", description: "One token for a year, nothing to renew. No claude.ai connectors.",
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
    id: "chatgpt", provider: "openai", name: "chatgpt", recommended: true,
    label: "Sign in to ChatGPT", description: "Plus or Pro, with a code on any device. Your bots can also get this account's ChatGPT apps.",
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
      "Paste the token here: Household finds the group by itself and checks it.",
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

/** The helpers setup turns on in a new workspace, as its bot's first tools (sideworkers are on by default anyway). */
export const SETUP_FEATURES = { scouts: true } as const;

/** The bot setup makes in a new workspace: an assistant, of the default size as far as the budget allows. */
export const DEFAULT_BOT = { name: "assistant", title: "Assistant" };
export function defaultBotSize(budget: { cpus: number; memoryMiB: number }): { cpus: number; memoryMiB: number } {
  return { cpus: Math.max(1, Math.min(DEFAULT_PET_CPUS, budget.cpus)), memoryMiB: Math.max(512, Math.min(DEFAULT_PET_MEMORY_MIB, budget.memoryMiB)) };
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
