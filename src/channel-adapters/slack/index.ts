import { slackHtml } from "./html";
import type { Attachment, OutgoingAttachment } from "../../core/attachment";
import { DownloadRefused, RateLimited, type Channel, type Choices, type InboundMessage, type LinkButton, type MessageRef, type Place, type PostRef, type SenderRef, type StatusView } from "../../core/channel";
import { SlackBot, type SlackState } from "./bot";
import { SlackError, statusCall } from "./api";
import { isSlackChat, isSlackOwner } from "./kind";
import { parseInbound, senderRef, messageRef, timestamp, type SlackPayload } from "./events";
import { blocks, cut, escapeSlack, pieces, plainHtml, quietMarkdown, slackCommands, statusText } from "./render";
export { SlackBot } from "./bot";
export { slack, slackPrivate, slackTokenCheck, slackAppTokenCheck, isSlackBotToken, isSlackAppToken } from "./kind";

interface Shown { text: string; notice?: boolean; }
const MAX_FILE = 20 * 1024 * 1024;
const EMOJI: Record<string, string> = { "👀": "eyes", "👍": "+1", "👎": "-1", "❤️": "heart", "❤": "heart", "✅": "white_check_mark", "🎉": "tada", "🔥": "fire", "🤔": "thinking_face", "🙏": "pray" };

/** Bot DM only. Persistent root cards give every pet a named, directly linkable Slack thread. */
export class SlackChannel implements Channel {
  readonly inbox = "Inbox";
  readonly retainsIncomingSecrets = true;
  readonly team: string;
  readonly chat: string;
  readonly prefix: string;
  private readonly state: SlackState;
  private handler?: (message: InboundMessage) => Promise<string | void>;
  private checked?: Promise<void>;
  private readonly creating = new Map<string, Promise<string>>();
  private readonly wanted = new Map<string, Place>();
  private mainPlace?: string;
  setMainPlace(id: string | undefined): void { this.mainPlace = id; }
  inInbox(place: Place): boolean { return place.kind === "house-inbox" || place.id === this.mainPlace; }
  constructor(readonly bot: SlackBot, readonly address: string) {
    if (!isSlackChat(address)) throw new Error("Slack private chat must be WORKSPACE:DM (T…:D…)");
    [this.team, this.chat] = address.split(":") as [string, string];
    this.prefix = `slack.${this.team}.${this.chat}`;
    this.state = bot.options.state;
  }
  isSender(ref: SenderRef, id: string): boolean {
    if (!isSlackOwner(id)) return false;
    const [team, user] = id.split(":") as [string, string];
    return team === this.team && ref === senderRef(team, user);
  }
  start(onMessage: (message: InboundMessage) => Promise<string | void>): void { this.handler = onMessage; this.bot.add(this.address, this); }
  async stop(): Promise<void> { this.handler = undefined; await this.bot.leave(this.address, this); }
  private ready(): Promise<void> {
    return this.checked ??= (async () => {
      const me = await this.bot.me();
      if (me.team_id !== this.team) throw new Error("Slack bot and channel belong to different workspaces");
      const { channel } = await this.bot.api.call<{ channel?: { is_im?: boolean } }>("conversations.info", { channel: this.chat });
      if (!channel?.is_im) throw new Error("Slack private adapter requires a direct message conversation");
    })().catch(error => { this.checked = undefined; throw error; });
  }
  private key(kind: string, id: string) { return `${this.prefix}.${kind}.${id}`; }
  private postRef(ts: string) { return messageRef(this.prefix, ts) as unknown as PostRef; }
  private ts(ref: MessageRef | PostRef): string {
    const ts = ref.startsWith(`${this.prefix}.`) ? ref.slice(this.prefix.length + 1).split(".").slice(0, 2).join(".") : "";
    if (!timestamp(ts)) throw new Error("Invalid Slack message reference");
    return ts;
  }
  private remember(ref: PostRef, shown: Shown): void {
    const ts = this.ts(ref);
    const indexKey = this.key("cards", "index");
    const previous: string[] = JSON.parse(this.state.get(indexKey) ?? "[]");
    const recent = [...previous.filter(value => value !== ts), ts];
    for (const old of recent.slice(0, -500)) this.state.set(this.key("card", old), "");
    this.state.set(indexKey, JSON.stringify(recent.slice(-500)));
    this.state.set(this.key("card", ts), JSON.stringify(shown));
  }
  private shown(ref: PostRef): Shown {
    const value = this.state.get(this.key("card", this.ts(ref)));
    if (!value) throw new Error("This Slack card is no longer available");
    return JSON.parse(value);
  }
  private async where(place: Place): Promise<{ thread_ts?: string }> {
    await this.ready();
    return this.inInbox(place) ? {} : { thread_ts: await this.thread(place) };
  }
  private thread(place: Place): Promise<string> {
    const known = this.state.get(this.key("thread", place.id));
    if (known) return Promise.resolve(known);
    let pending = this.creating.get(place.id);
    if (!pending) {
      pending = this.makeThread(place).finally(() => this.creating.delete(place.id));
      this.creating.set(place.id, pending);
    }
    return pending;
  }
  private rootText(place: Place): string {
    return `🏠 *${escapeSlack(place.title)}*\nReply in this thread to talk to ${escapeSlack(place.title)}.\nMessages, approvals and progress stay together here.`;
  }
  private async makeThread(place: Place): Promise<string> {
    const current = this.wanted.get(place.id) ?? place;
    const { ts } = await this.sendMessage({
      channel: this.chat, text: plainHtml(current.title), blocks: blocks(this.rootText(current)), unfurl_links: false, unfurl_media: false,
    });
    if (!timestamp(ts)) throw new Error("Slack did not return a thread timestamp");
    this.state.set(this.key("thread", place.id), ts);
    this.state.set(this.key("place", ts), place.id);
    this.state.set(this.key("title", place.id), current.title);
    return ts;
  }
  private async sendMessage(params: Record<string, unknown>): Promise<{ ts: string }> {
    // Retry only an explicit 429: retrying an ambiguous network failure can duplicate a message.
    for (let attempt = 0; ; attempt++) {
      try { return await this.bot.api.call<{ ts: string }>("chat.postMessage", params); }
      catch (error) {
        if (!(error instanceof RateLimited) || error.retryAfterMs > 30_000 || attempt >= 2) throw error;
        await Bun.sleep(Math.max(100, error.retryAfterMs));
      }
    }
  }
  async ensurePlace(place: Place): Promise<void> { await this.where(place); }
  async placeLink(place: Place): Promise<string | undefined> {
    if (this.inInbox(place)) return `https://app.slack.com/client/${this.team}/${this.chat}`;
    const { thread_ts } = await this.where(place);
    const result = await this.bot.api.call<{ permalink: string }>("chat.getPermalink", { channel: this.chat, message_ts: thread_ts });
    return result.permalink;
  }
  async retitle(place: Place): Promise<void> {
    this.wanted.set(place.id, place);
    const ts = this.state.get(this.key("thread", place.id));
    if (this.inInbox(place)) {
      if (ts && this.state.get(this.key("title", place.id)) !== `main:${place.title}`) {
        try {
          await this.ready();
          const text = `*${escapeSlack(place.title)}* now replies in Messages. Continue in the main conversation; this earlier test thread stays as history.`;
          await this.bot.api.call("chat.update", { channel: this.chat, ts, text, blocks: blocks(text) });
          this.state.set(this.key("title", place.id), `main:${place.title}`);
        } catch { this.bot.options.log.error("Slack main conversation migration notice failed"); }
      }
      return;
    }
    if (!ts || this.state.get(this.key("title", place.id)) === place.title) return;
    try {
      await this.ready();
      await this.bot.api.call("chat.update", { channel: this.chat, ts, text: place.title, blocks: blocks(this.rootText(place)) });
      this.state.set(this.key("title", place.id), place.title);
    } catch { this.bot.options.log.error("Slack thread title update failed; will retry on reload"); }
  }
  async post(place: Place, text: string, choices?: Choices): Promise<PostRef[]> {
    return this.send(place, quietMarkdown(text), choices, false);
  }
  async notice(place: Place, text: string, choices?: Choices, format?: "plain" | "html"): Promise<PostRef[]> {
    return this.send(place, `🏠 *Household*\n${slackCommands(format === "html" ? slackHtml(text) : escapeSlack(text))}`, choices, true);
  }
  async quote(place: Place, heading: string, body: string): Promise<PostRef[]> {
    return this.send(place, `🏠 *Household* · ${escapeSlack(heading)}\n${escapeSlack(body).split("\n").map(line => `> ${line}`).join("\n")}`, undefined, true);
  }
  private async send(place: Place, text: string, choices: Choices | undefined, notice: boolean): Promise<PostRef[]> {
    const where = await this.where(place);
    const split = pieces(text);
    const result: PostRef[] = [];
    for (let i = 0; i < split.length; i++) {
      const body = split[i]!;
      const buttons = i === split.length - 1 ? choices : undefined;
      const attributed = notice ? body : `*${escapeSlack(place.title)}*\n${body}`;
      const { ts } = await this.sendMessage({
        channel: this.chat, ...where, text: attributed, blocks: blocks(attributed, buttons), unfurl_links: false, unfurl_media: false,
      });
      if (!timestamp(ts)) throw new Error("Slack did not return a message timestamp");
      const ref = this.postRef(ts);
      if (buttons?.length) this.remember(ref, { text: attributed, notice });
      result.push(ref);
    }
    return result;
  }
  async editPost(place: Place, ref: PostRef, text: string, choices?: Choices): Promise<void> {
    if (pieces(text).length > 1) throw new Error("Edited Slack reply is too long; send a new reply");
    const body = `*${escapeSlack(place.title)}*\n${quietMarkdown(text)}`;
    await this.update(ref, body, blocks(body, choices));
    if (choices?.length) this.remember(ref, { text: body });
  }
  private async update(ref: PostRef, text: string, rendered: object[]): Promise<void> {
    await this.ready();
    await this.bot.api.call("chat.update", { channel: this.chat, ts: this.ts(ref), text, blocks: rendered });
  }
  async setChoices(ref: PostRef, choices: Choices, note?: string, replacement?: { text: string; format?: "plain" | "html"; link?: LinkButton }): Promise<void> {
    const shown = replacement ? { text: `🏠 *Household*\n${slackCommands(replacement.format === "html" ? slackHtml(replacement.text) : escapeSlack(replacement.text))}`, notice: true } : this.shown(ref);
    const rendered = blocks(shown.text, choices, note);
    if (!choices.length && replacement?.link) rendered.push({ type: "actions", elements: [{ type: "button", action_id: "household_link", text: { type: "plain_text", text: cut(replacement.link.label, 75) }, url: replacement.link.url }] });
    await this.update(ref, shown.text, rendered);
    this.remember(ref, shown);
  }
  async resolve(ref: PostRef, outcome: string): Promise<void> {
    await this.setChoices(ref, [], outcome);
    this.state.set(this.key("card", this.ts(ref)), "");
  }
  async postStatus(place: Place, view: StatusView): Promise<PostRef> {
    return statusCall(async () => {
      const text = `🏠 *Household*\n${statusText(view)}`;
      const where = await this.where(place);
      const choices = view.state === "working" && view.stop ? [[view.stop]] : undefined;
      const { ts } = await this.bot.api.call<{ ts: string }>("chat.postMessage", { channel: this.chat, ...where, text, blocks: blocks(text, choices), unfurl_links: false, unfurl_media: false });
      const ref = this.postRef(ts);
      this.remember(ref, { text, notice: true });
      return ref;
    });
  }
  async editStatus(ref: PostRef, view: StatusView): Promise<void> {
    return statusCall(async () => {
      const text = `🏠 *Household*\n${statusText(view)}`;
      await this.update(ref, text, blocks(text, view.state === "working" && view.stop ? [[view.stop]] : undefined));
      this.remember(ref, { text, notice: true });
    });
  }
  async dropStatus(ref: PostRef): Promise<void> {
    await this.ready();
    await this.bot.api.call("chat.delete", { channel: this.chat, ts: this.ts(ref) });
    this.state.set(this.key("card", this.ts(ref)), "");
  }
  delivered(ref: MessageRef): Promise<void> { return this.react(ref, "👀"); }
  async react(ref: MessageRef | PostRef, emoji: string | undefined): Promise<void> {
    await this.ready();
    const ts = this.ts(ref);
    const key = this.key("reaction", ts);
    const old = this.state.get(key);
    const name = emoji ? EMOJI[emoji] ?? emoji.replace(/^:|:$/g, "") : undefined;
    if (name && !/^[a-z0-9_+\-]+$/.test(name)) throw new Error("Unsupported Slack emoji; use a Slack emoji name");
    if (old === name) return;
    if (old) {
      try { await this.bot.api.call("reactions.remove", { channel: this.chat, timestamp: ts, name: old }); }
      catch (error) { if (!(error instanceof SlackError && error.code === "no_reaction")) throw error; }
      this.state.set(key, "");
    }
    if (name) {
      try { await this.bot.api.call("reactions.add", { channel: this.chat, timestamp: ts, name }); }
      catch (error) { if (!(error instanceof SlackError && error.code === "already_reacted")) throw error; }
      this.state.set(key, name);
    }
  }
  async take(body: SlackPayload): Promise<void> {
    if (!this.handler) return;
    await this.ready();
    if (body.type === "block_actions") {
      const action = body.actions?.[0];
      const ts = body.container?.message_ts ?? body.message?.ts;
      const user = body.user?.id;
      if (!action || !timestamp(ts) || !user || !/^[UW][A-Z0-9]+$/.test(user) || !/^household_choice_\d+$/.test(action.action_id ?? "") || !/^\d+$/.test(action.value ?? "")) return;
      if (action.action_id !== `household_choice_${action.value}` || !timestamp(action.action_ts)) return;
      const ref = this.postRef(ts);
      const place = this.state.get(this.key("place", body.message?.thread_ts ?? body.container?.thread_ts ?? ""));
      const answer = await this.handler({ kind: "choice", ref: messageRef(this.prefix, `${ts}.${user}.${action.action_ts}`), ...(place ? { place } : {}), from: { ref: senderRef(this.team, user), name: body.user?.name ?? "Slack user" }, external: {}, answersTo: ref, index: Number(action.value), label: action.text?.text ?? "" });
      if (answer) await this.bot.api.call("chat.postEphemeral", { channel: this.chat, user, text: answer, ...(body.message?.thread_ts ? { thread_ts: body.message.thread_ts } : {}) });
      return;
    }
    const event = body.event;
    if (event?.type === "message" && !event.subtype && !event.bot_id && event.user && event.thread_ts && !this.state.get(this.key("place", event.thread_ts))) {
      await this.bot.api.call("chat.postEphemeral", { channel: this.chat, user: event.user, thread_ts: event.thread_ts, text: "This is not a pet thread. Open a named pet thread above, or write in the main conversation to reach the default pet." });
      return;
    }
    const message = parseInbound(body, this.prefix, this.team, ts => this.state.get(this.key("place", ts)) || undefined);
    if (message) await this.handler(message);
  }
  async download(attachment: Attachment, signal: AbortSignal): Promise<Uint8Array> {
    const prefix = `${this.prefix}.file.`;
    const fileId = attachment.file.startsWith(prefix) ? attachment.file.slice(prefix.length) : "";
    if (!/^F[A-Z0-9]+$/.test(fileId)) throw new DownloadRefused("Invalid Slack file reference");
    if ((attachment.size ?? 0) > MAX_FILE) throw new DownloadRefused("Slack attachments are limited to 20 MB in this prototype");
    await this.ready();
    const { file } = await this.bot.api.call<{ file?: { url_private_download?: string; url_private?: string; size?: number } }>("files.info", { file: fileId });
    if (!file || (file.size ?? 0) > MAX_FILE) throw new DownloadRefused("Slack file is missing or larger than 20 MB");
    const url = new URL(file.url_private_download ?? file.url_private ?? "https://invalid.invalid");
    if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password || url.port) throw new DownloadRefused("Slack file URL is not trusted");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.bot.options.token}` }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }).catch(() => { throw new Error("Slack file download failed"); });
    if (!response.ok || !response.body) throw new DownloadRefused("Slack file download was refused");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_FILE) throw new DownloadRefused("Slack file exceeds 20 MB"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async sendAttachment(place: Place, attachment: OutgoingAttachment, signal?: AbortSignal): Promise<PostRef> {
    if (!attachment.bytes.length || attachment.bytes.length > MAX_FILE) throw new Error("Slack files must be between 1 byte and 20 MB");
    const where = await this.where(place);
    const upload = await this.bot.api.call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", { filename: attachment.name, length: attachment.bytes.length });
    const url = new URL(upload.upload_url);
    if (url.protocol !== "https:" || !(url.hostname === "files.slack.com" || url.hostname.endsWith(".slack.com")) || url.username || url.password || url.port) throw new Error("Slack upload URL is not trusted");
    const response = await fetch(url, { method: "POST", body: new Blob([attachment.bytes as BlobPart]), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) }).catch(() => { throw new Error("Slack file upload failed"); });
    if (!response.ok) throw new Error("Slack file upload failed");
    await this.bot.api.call("files.completeUploadExternal", { files: [{ id: upload.file_id, title: attachment.name }], channel_id: this.chat, ...where, initial_comment: escapeSlack(`${place.title}${attachment.caption ? `: ${attachment.caption}` : ""}`) });
    return `${this.prefix}.file.${upload.file_id}` as PostRef;
  }
}
