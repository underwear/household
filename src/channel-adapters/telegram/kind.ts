import type { ChannelKindSpec, PlatformSpec } from "../../core/channels";

const MAX_ID = BigInt(Number.MAX_SAFE_INTEGER);

/** A Telegram user id: digits, no leading zero, at most 2^53 − 1 (Telegram's own bound), compared as written. */
export const isTelegramId = (id: string): boolean => /^[1-9]\d*$/.test(id) && BigInt(id) <= MAX_ID;

/** Telegram's people: a user id names one on every chat and bot alike. */
export const telegram: PlatformSpec = {
  platform: "telegram",
  label: "Telegram",
  // Telegram's logo (simple-icons, CC0): the paper plane in its circle.
  icon: {
    viewBox: "0 0 24 24",
    d: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  },
  ownerId: { label: "Telegram user id", placeholder: "100200300", hint: "A number; @userinfobot tells yours." },
  valid: isTelegramId,
};

/** `telegram-private`: a private chat of the owner with the house's bot, in Threaded Mode. */
export const telegramPrivate: ChannelKindSpec = {
  kind: "telegram-private",
  replyFormat: {
    name: "telegram-html",
    instructions: 'reply text uses Telegram HTML by default, not Markdown. Use <b>bold</b>, <i>italic</i>, <code>inline code</code>, <pre>multiline code or keys</pre>, <a href="https://example.com">link</a>, <blockquote>quote</blockquote>. Escape literal & as &amp;, < as &lt;, > as &gt;, including inside code/pre. Use newlines, not <br>; no Markdown fences, headings, tables or paragraph tags. Buttons and send_file captions are plain text.',
    rich: {
      name: "telegram-rich-markdown",
      instructions: 'Use reply format="rich" for structured reports. Text is Telegram Rich Markdown, close to GitHub Markdown: # headings, **bold**, fenced code, lists, tables, and <details><summary>Title</summary>Body</details>. Household adds your pet title. Keep text under 32768 characters including that title. Use ordinary reply for short chat. This version supports text and the existing buttons; send media through send_file. edit_reply takes replacement text in the original format.',
    },
  },
  platform: "telegram",
  audience: "private",
  label: "Telegram Bot DM (threaded)",
  description: "Your private chat with the house's bot: a thread per pet, General for the house.",
  chat: { key: "chat", label: "Chat id", placeholder: "your Telegram user id", mono: true },
  fields: [{ key: "token", label: "Bot token", mono: true, wide: true, placeholder: "123456789:AAH4x…from @BotFather", hint: "From @BotFather; the bot needs Threaded Mode on." }],
};
