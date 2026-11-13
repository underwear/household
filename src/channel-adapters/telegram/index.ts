import { widgetTools } from "./widgets";
import { randomUUID } from "node:crypto";
import { topicPlaceKey } from "../../core/channels";
import type { Attachment, OutgoingAttachment } from "../../core/attachment";
import { DownloadRefused, RateLimited, StatusGone, type Channel, type Choices, type LinkButton, type InboundMessage, type MessageRef, type Place, type PostRef, type SenderRef, type StatusView } from "../../core/channel";
import { TelegramError } from "./bot-api";
import { pause, type BotChat, type TelegramBot } from "./bot";
import { isTelegramId } from "./kind";
import { keyboard, linkKeyboard, type InlineKeyboard } from "./keyboard";
import { telegramHtml, splitFormatted } from "./html";
import { MAX_TEXT, splitText } from "./split";
import { renderStatus } from "./status";
import { inboundMessage, messageIdOf, postRef, senderRef, type Parsed, type Update, type TelegramMessage } from "./updates";

export { TelegramBot, type TelegramBotOptions, type TelegramState } from "./bot";
export { isTelegramId, telegram, telegramPrivate, telegramDm, telegramGroup } from "./kind";
export { getMe, isBotToken, isRefusedToken, telegramBotToken, type BotInfo } from "./token";
export { checkGroup, groupProblems, watchSetup, type Contact, type FoundGroup } from "./first-contact";

/** Notices start so, in bold: a pet's reply cannot impersonate this prefix, even through formatting. */
const NOTICE = "🏠 Household:";
/** The heading of a card (an HTML notice): Household's name on a line of its own, then a blank line. */
const CARD_HEADING = "🏠 Notification from Household";
/** A post waits out this much of Telegram's rate limit (429) per piece, so a cut message is not sent twice. */
const MAX_POST_WAIT_S = 30;
/** How often a use of a place tries again a rename of its thread that failed passingly. */
const RENAME_RETRY_MS = 60_000;
/** Messages with buttons whose text is kept, so a choice can be written under it. */
const MAX_SHOWN = 500;
/** The largest file Telegram lets a bot download. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const TOO_BIG = "over 20 MB, and Telegram does not give bots larger files";

/** What a message with buttons says, as Telegram has it: its own text, and a note under it now (`setChoices`). */
interface Shown {
  text: string;
  entities?: object[];
  rich?: true;
  note?: string;
  /** Household's own notice: no link preview, also when it is edited. */
  quiet?: true;
}

/** Household's notices never unfold a link into a preview card: they are short status, not content. */
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

/** A reply that opens like a notice ("⚠️ …", "Household: …") gets its place's title in front. */
const looksLikeNotice = (text: string) => /^[^\p{L}\p{N}]*(⚠|household)/iu.test(text);

/**
 * A plain private bot chat, a private chat in Threaded Mode or a forum supergroup: each pet's place
 * has a thread named with its title, made by the bot the first time it is needed (it cannot be before the person
 * pressed Start), kept by the place's id, renamed when its title changes (the state keeps the last title Telegram
 * accepted); General is the inbox. The bot's poller (`TelegramBot`, shared by the
 * bot's channels) hands this chat's updates over. Plain DMs share one physical chat and attribute replies when
 * multiple bots talk there; temporary helpers always keep their titles. Pet HTML is decoded into native entities, cut to Telegram's limit.
 */
export class TelegramChannel implements Channel, BotChat {
  get inbox(): string { return this.mode === "dm" ? "Chat" : "General"; }
  get ignoreInboxMessages(): boolean { return this.mode !== "dm" && !this.forwardGeneral; }
  get forwardsInbox(): boolean { return this.forwardGeneral; }
  get stopDefaultPet(): boolean { return this.mode === "dm"; }
  readonly removePlace?: (place: Place) => Promise<boolean>;
  inInbox(place: Place): boolean { return this.mode === "dm" || place.kind === "house-inbox"; }
  readonly createPlace?: (title: string) => Promise<Place>;
  private onMessage?: (message: InboundMessage) => Promise<string | void>;
  /** Threads being created, so that posts at the same moment make one. */
  private readonly creating = new Map<string, Promise<number>>();
  /** The title each place is to have, as the last reload said (`retitle`). */
  private readonly wanted = new Map<string, string>();
  /** Renames of this chat's threads, one at a time. */
  private renames: Promise<void> = Promise.resolve();
  /** A rename that failed passingly, by place: a use of the place tries it again, not more than once a minute. */
  private readonly failed = new Map<string, { title: string; at: number }>();
  /**
   * The text of messages with buttons, by message id: from posting them, or from a press on them (Telegram sends
   * the message along, so this holds after a restart too). Dropped once resolved; the oldest go past MAX_SHOWN.
   */
  private readonly shown = new Map<number, Shown>();
  /** Names this bot's chat: in state keys and message refs (message ids are per chat). */
  private readonly prefix: string;
  private soloPlace?: string;

  /** General's messages go to a bot (forwarded into its thread) rather than being ignored: the channel's `forwardGeneral`. */
  private forwardGeneral = false;

  /** Refreshed on every config reload, including when the channel connection is reused. */
  setSoloPlace(id?: string): void { this.soloPlace = id; }
  /** Refreshed on every config reload, like `setSoloPlace`. */
  setForwardGeneral(on: boolean): void { this.forwardGeneral = this.mode !== "dm" && on; }

  private attributeDm(place: Place): boolean {
    const solo = this.soloPlace !== undefined && (place.id === this.soloPlace || place.kind === "house-inbox");
    return this.mode === "dm" && (place.forceAttribution === true || !solo);
  }
  private readonly keys: { creation: (place: string) => string; thread: (place: string) => string; title: (place: string) => string; place: (thread: number) => string };

  constructor(
    private readonly bot: TelegramBot,
    /** Positive user id for private chats; negative -100… id for forum supergroups. */
    readonly chat: number,
    /** For log lines, e.g. `house work DM`. */
    private readonly name: string,
    private readonly mode: "private" | "group" | "dm" = "private",
  ) {
    if (mode !== "dm") this.removePlace = (place) => this.removeThread(place);
    this.prefix = `telegram.${bot.id}.${chat}`;
    if (mode === "group") this.createPlace = async title => {
      if (!title.trim() || title.trim().length > 128) throw new Error("Topic title must contain 1–128 characters");
      const place: Place = { id: topicPlaceKey(randomUUID(), `telegram-group:${chat}`), kind: "topic", title: title.trim() };
      await this.thread(place);
      this.saveTopic(place);
      return { ...place };
    };
    this.keys = {
      creation: (place) => `${this.prefix}.creation.${place}`,
      thread: (place) => `${this.prefix}.thread.${place}`,
      title: (place) => `${this.prefix}.title.${place}`,
      place: (thread) => `${this.prefix}.place.${thread}`,
    };
  }

  tools() {
    if (this.mode === "group" || this.chat <= 0) return [];
    return widgetTools({
      send: async (place, params, signal) => {
        const where = await this.where(place);
        const sent = await this.bot.api.call<{ message_id: number }>("sendWidget", { ...params, chat_id: this.chat, ...where, allow_queries: true }, { signal });
        if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) throw new Error("sendWidget returned no message id");
        this.bot.options.state.set(`${this.prefix}.widget.${sent.message_id}`, place.id);
        return postRef(this.prefix, sent.message_id);
      },
      update: async (place, target, params, signal) => {
        const id = messageIdOf(this.prefix, target);
        if (id === undefined || this.bot.options.state.get(`${this.prefix}.widget.${id}`) !== place.id) throw new Error("Not a widget in this place");
        await this.bot.api.call("editMessageWidgetData", { ...params, chat_id: this.chat, message_id: id }, { signal });
      },
    });
  }

  private async takeWidget(query: NonNullable<Update["widget_query"]>): Promise<void> {
    const { state, log } = this.bot.options;
    const place = query.message_id === undefined ? undefined : state.get(`${this.prefix}.widget.${query.message_id}`);
    const valid = this.mode !== "group" && this.chat > 0 && query.chat?.id === this.chat && query.from.id === this.chat && !query.from.is_bot &&
      query.type.type === "data" && typeof query.data === "string" && Buffer.byteLength(query.data) > 0 && Buffer.byteLength(query.data) <= 64 && !!place;
    // Acknowledge before agent delivery: Telegram allows only 15 seconds for this response.
    await this.bot.api.call("answerWidgetQuery", { widget_query_id: query.id, data: JSON.stringify({ received: !!valid }) }, { timeoutMs: 5000 })
      .catch(error => log.error(`telegram ${this.name}: widget query acknowledgement failed: ${(error as Error).message}`));
    if (!valid || !this.onMessage) return;
    await this.onMessage({
      kind: "text", ref: `${this.prefix}.widget-query.${query.id}` as MessageRef,
      place, from: { ref: senderRef(query.from.id), name: [query.from.first_name, query.from.last_name].filter(Boolean).join(" ") || "Telegram user" },
      replyTo: postRef(this.prefix, query.message_id!), interaction: true,
      text: `Widget action: ${query.data}`,
      external: { widget: { event: "data", data: query.data } },
    });
  }

  listPlaces(): Place[] {
    if (this.mode !== "group") return [];
    return JSON.parse(this.bot.options.state.get(`${this.prefix}.topics`) || "[]");
  }

  private saveTopic(place: Place): void {
    const places = this.listPlaces();
    const index = places.findIndex(p => p.id === place.id);
    if (index < 0) places.push(place); else places[index] = place;
    this.bot.options.state.set(`${this.prefix}.topics`, JSON.stringify(places));
  }

  /** Discover a human's topic before routing its first message, including topics created while offline. */
  private discoverTopic(message: TelegramMessage | undefined): void {
    if (this.mode !== "group" || !message || message.chat.id !== this.chat) return;
    const thread = message.is_topic_message ? message.message_thread_id : undefined;
    if (!thread || !Number.isSafeInteger(thread) || thread <= 1) return; // General has id 1.
    const state = this.bot.options.state;
    const known = state.get(this.keys.place(thread));
    const existing = this.listPlaces().find(p => p.id === known);
    if (known && !known.startsWith("topic:")) return; // A pet's dedicated topic is never adopted or renamed.
    if (!known && (!message.from || message.from.is_bot)) return;
    const title = message.forum_topic_edited?.name ?? message.forum_topic_created?.name ?? (!existing ? message.reply_to_message?.forum_topic_created?.name : undefined);
    if (existing && (!title?.trim() || title.trim() === existing.title)) return;
    const place: Place = { id: existing?.id ?? known ?? topicPlaceKey(randomUUID(), `telegram-group:${this.chat}`), kind: "topic", title: title?.trim() || existing?.title || "Topic" };
    state.set(this.keys.thread(place.id), String(thread));
    state.set(this.keys.place(thread), place.id);
    this.saveTopic(place);
  }

  /** A Telegram user id names a person on every chat and bot alike. */
  isSender(ref: SenderRef, id: string): boolean {
    return isTelegramId(id) && ref === senderRef(id);
  }

  /**
   * Takes its chat's updates from now on. Only now is the chat this channel's: a channel opened but not started
   * yet (on a reload, while the one it replaces still runs) takes nothing away from that one.
   */
  start(onMessage: (message: InboundMessage) => Promise<string | void>): void {
    this.onMessage = onMessage;
    this.bot.add(this.chat, this);
    this.bot.listen(this);
  }

  stop(): Promise<void> {
    return this.bot.leave(this);
  }

  /** Every piece of a pet's text that opens like a notice gets the place's title in front (room is left for it). */
  post(place: Place, text: string, choices?: Choices, format: "regular" | "rich" = "regular"): Promise<PostRef[]> {
    if (format === "rich") return this.postRich(place, text, choices);
    const pieces = splitFormatted(telegramHtml(text), MAX_TEXT - place.title.length - 2).map(piece => {
      if (!this.attributeDm(place) && !looksLikeNotice(piece.text)) return piece;
      const prefix = `${place.title}: `;
      return { text: prefix + piece.text, entities: piece.entities.map(entity => ({ ...entity, offset: entity.offset + prefix.length })) };
    });
    return this.send(place, pieces.map(piece => piece.text), { pieceEntities: pieces.map(piece => piece.entities), ...(choices ? { reply_markup: keyboard(choices) } : {}) });
  }

  private async postRich(place: Place, text: string, choices?: Choices): Promise<PostRef[]> {
    if (this.mode === "group") throw new Error("Rich replies are not supported in Telegram groups; use regular Telegram HTML");
    const markdown = richMarkdown(place, text, this.mode !== "dm" || this.attributeDm(place));
    const where = await this.where(place);
    const sent = await this.sendPiece({ chat_id: this.chat, ...where, rich_message: { markdown }, ...(choices ? { reply_markup: keyboard(choices) } : {}) }, "sendRichMessage");
    if (choices) this.remember(sent.message_id, { text: markdown, rich: true });
    return [postRef(this.prefix, sent.message_id)];
  }

  /** Replace one pet post; unlike new regular replies, edits cannot grow into multiple messages. */
  async editPost(place: Place, ref: PostRef, text: string, choices?: Choices, format: "regular" | "rich" = "regular"): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId === undefined) throw new Error("Invalid Telegram post reference");
    let content: object;
    let shown: Shown;
    if (format === "rich") {
      if (this.mode === "group") throw new Error("Rich replies are not supported in Telegram groups; use regular Telegram HTML");
      const markdown = richMarkdown(place, text, this.mode !== "dm" || this.attributeDm(place));
      content = { rich_message: { markdown } };
      shown = { text: markdown, rich: true };
    } else {
      const parsed = telegramHtml(text);
      if (!parsed.text.trim()) throw new Error("The edited text is empty");
      const prefix = this.attributeDm(place) || looksLikeNotice(parsed.text) ? `${place.title}: ` : "";
      const rendered = prefix + parsed.text;
      if (!rendered.trim()) throw new Error("The edited text is empty");
      if (rendered.length > MAX_TEXT) throw new Error("The edited message exceeds Telegram's 4096 character limit; send a new reply instead");
      const entities = parsed.entities.map(entity => ({ ...entity, offset: entity.offset + prefix.length }));
      content = { text: rendered, entities };
      shown = { text: rendered, entities };
    }
    const reply_markup = choices ? keyboard(choices) : { inline_keyboard: [] };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.edit(ref, "editMessageText", { ...content, reply_markup });
        break;
      } catch (error) {
        const { code, retryAfter } = error as TelegramError;
        if (code !== 429 || !retryAfter || retryAfter > MAX_POST_WAIT_S || attempt >= 3) throw error;
        await pause(retryAfter * 1000);
      }
    }
    if (choices) this.remember(messageId, shown);
    else this.shown.delete(messageId);
  }

  /** Upload bytes, never a host path or a remote URL. Only explicit rate-limit refusals are retried. */
  async sendAttachment(place: Place, attachment: OutgoingAttachment, signal?: AbortSignal): Promise<PostRef> {
    const { kind, name, bytes, mime } = attachment;
    const limit = (kind === "photo" ? 10 : 50) * 1024 * 1024;
    if (bytes.byteLength === 0) throw new Error("cannot send an empty file");
    if (bytes.byteLength > limit) throw new Error(`Telegram ${kind} limit is ${limit / 1024 / 1024} MB`);
    if (kind === "voice" && !/\.(ogg|opus|mp3|m4a)$/i.test(name)) {
      throw new Error("Voice messages need OGG/Opus, MP3 or M4A; convert the audio or send it as a document");
    }
    if (kind === "video" && !/\.(mp4|m4v|mov)$/i.test(name)) {
      throw new Error("Videos play in the chat as MP4 (H.264 + AAC); convert the video or send it as a document");
    }
    const caption = this.attributeDm(place) ? `${place.title}: ${attachment.caption ?? ""}`.trimEnd() : attachment.caption && looksLikeNotice(attachment.caption) ? `${place.title}: ${attachment.caption}` : attachment.caption;
    if ((caption?.length ?? 0) > 1024) throw new Error("Telegram attachment captions must be at most 1024 characters");
    const where = await this.where(place);
    const form = new FormData();
    form.set("chat_id", String(this.chat));
    if (where.message_thread_id !== undefined) form.set("message_thread_id", String(where.message_thread_id));
    if (caption) form.set("caption", caption);
    // A video streams: it starts playing before it has fully downloaded.
    if (kind === "video") form.set("supports_streaming", "true");
    const mediaTypes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime" };
    const contentType = mime ?? mediaTypes[name.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream";
    form.set(kind, new Blob([Buffer.from(bytes)], { type: contentType }), name);
    const method = { document: "sendDocument", photo: "sendPhoto", voice: "sendVoice", video: "sendVideo" }[kind];
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const sent = await this.bot.api.call<{ message_id: number }>(method, form, { timeoutMs: 120_000, signal });
        return postRef(this.prefix, sent.message_id);
      } catch (error) {
        const { code, retryAfter } = error as TelegramError;
        if (code !== 429 || !retryAfter || retryAfter > MAX_POST_WAIT_S || attempt >= 3) throw error;
        await pause(retryAfter * 1000);
      }
    }
  }

  /** Repeat the heading on split posts; quote offsets and lengths are Telegram's UTF-16 units. */
  quote(place: Place, heading: string, body: string): Promise<PostRef[]> {
    const prefix = `${heading.trim()}\n\n`;
    if (prefix.length > MAX_TEXT - 2) throw new Error("Quote heading is too long");
    const pieces = splitText(body, MAX_TEXT - prefix.length).map(piece => prefix + piece);
    return this.send(place, pieces, { quoteOffset: prefix.length });
  }

  async answer(message: InboundMessage, text: string): Promise<PostRef[]> {
    const id = messageIdOf(this.prefix, message.ref);
    if (id === undefined) return [];
    const thread = this.mode === "dm" ? undefined : message.kept?.thread;
    const sent = await this.sendPiece({
      chat_id: this.chat,
      ...(typeof thread === "number" ? { message_thread_id: thread } : {}),
      text: `${NOTICE} ${text}`,
      entities: [{ type: "bold", offset: 0, length: NOTICE.length }],
      reply_parameters: { message_id: id, allow_sending_without_reply: true },
      ...NO_PREVIEW,
    });
    return [postRef(this.prefix, sent.message_id)];
  }

  notice(place: Place, text: string, choices?: Choices, format: "plain" | "html" = "plain"): Promise<PostRef[]> {
    if (format === "html") {
      const pieces = splitFormatted(telegramHtml(`<b>${CARD_HEADING}</b>\n\n${text}`), MAX_TEXT);
      return this.send(place, pieces.map(piece => piece.text), {
        pieceEntities: pieces.map(piece => piece.entities),
        quiet: true,
        ...(choices ? { reply_markup: keyboard(choices) } : {}),
      });
    }
    return this.send(place, splitText(`${NOTICE} ${text}`), {
      entities: [{ type: "bold", offset: 0, length: NOTICE.length }],
      quiet: true,
      ...(choices ? { reply_markup: keyboard(choices) } : {}),
    });
  }

  /**
   * Only the buttons change, unless the note does: then the text is the message's own with the note under it.
   * When the text is unknown or would get too long, the buttons only change.
   */
  async setChoices(ref: PostRef, choices: Choices, note?: string, replacement?: { text: string; format?: "plain" | "html"; link?: LinkButton }): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    const shown = messageId === undefined ? undefined : this.shown.get(messageId);
    const reply_markup = replacement?.link && choices.length === 0 ? linkKeyboard(replacement.link) : keyboard(choices);
    if (replacement) {
      const content = replacement.format === "html"
        ? telegramHtml(`<b>${CARD_HEADING}</b>\n\n${replacement.text}`)
        : { text: `${NOTICE} ${replacement.text}`, entities: [{ type: "bold", offset: 0, length: NOTICE.length }] };
      if (content.text.length > MAX_TEXT) throw new Error("Replacement notice is too long");
      await this.edit(ref, "editMessageText", { ...content, reply_markup, ...NO_PREVIEW });
      this.remember(messageId!, { ...content, quiet: true });
      return;
    }
    const text = shown && (note === undefined ? shown.text : `${shown.text}\n\n${note}`);
    if (!shown || shown.rich || !text || shown.note === note || text.length > MAX_TEXT) return this.edit(ref, "editMessageReplyMarkup", { reply_markup });
    const entities = shown.entities ? { entities: shown.entities } : {};
    await this.edit(ref, "editMessageText", { text, ...entities, reply_markup, ...(shown.quiet ? NO_PREVIEW : {}) });
    this.remember(messageId!, { text: shown.text, ...entities, ...(note === undefined ? {} : { note }), ...(shown.quiet ? { quiet: true as const } : {}) });
  }

  /**
   * The buttons go, and `→ outcome` is written under the text (entities kept). When the text is unknown or would
   * get too long, the buttons only go.
   */
  async resolve(ref: PostRef, outcome: string): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    const shown = messageId === undefined ? undefined : this.shown.get(messageId);
    const text = shown && `${shown.text}\n\n→ ${outcome}`;
    if (!shown?.rich && text && text.length <= MAX_TEXT) await this.edit(ref, "editMessageText", { text, ...(shown.entities ? { entities: shown.entities } : {}), ...(shown.quiet ? NO_PREVIEW : {}) });
    else await this.edit(ref, "editMessageReplyMarkup", { reply_markup: { inline_keyboard: [] } });
    if (messageId !== undefined) this.shown.delete(messageId);
  }

  /**
   * Silent (no notification), without link previews (a step may name a URL). A 429 is not waited out: the caller
   * has a newer view by then.
   */
  async postStatus(place: Place, view: StatusView): Promise<PostRef> {
    const where = await this.where(place);
    const params = { chat_id: this.chat, ...where, ...statusMessage(view), disable_notification: true };
    const sent = await statusCall(() => this.bot.api.call<{ message_id: number }>("sendMessage", params));
    return postRef(this.prefix, sent.message_id);
  }

  /** The stop button goes with every edit while working (an edit without it would take it away), and then goes. */
  async editStatus(ref: PostRef, view: StatusView): Promise<void> {
    await statusCall(() => this.edit(ref, "editMessageText", statusMessage(view)));
  }

  async dropStatus(ref: PostRef): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId !== undefined) await statusCall(() => this.bot.api.call("deleteMessage", { chat_id: this.chat, message_id: messageId }));
  }

  async typing(place: Place, signal: AbortSignal): Promise<void> {
    const where = await this.where(place);
    if (signal.aborted) return;
    await statusCall(() => this.bot.api.call("sendChatAction", { chat_id: this.chat, ...where, action: "typing" }, { signal, timeoutMs: 4_000 }));
  }

  async delivered(ref: MessageRef): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId === undefined) return;
    const reaction = [{ type: "emoji", emoji: "👀" }];
    await this.bot.api.call("setMessageReaction", { chat_id: this.chat, message_id: messageId, reaction });
  }

  /**
   * getFile, then the file. A file over Telegram's limit for bots is refused before anything is asked, or when
   * Telegram says so; any other refusal (a 4xx but 429: the file id unknown, …) is for good too.
   */
  async download(attachment: Attachment, signal: AbortSignal): Promise<Uint8Array> {
    if ((attachment.size ?? 0) > MAX_DOWNLOAD) throw new DownloadRefused(TOO_BIG);
    try {
      const { file_path } = await this.bot.api.call<{ file_path?: string }>("getFile", { file_id: attachment.file }, { signal });
      if (!file_path) throw new DownloadRefused("Telegram gave no link to the file");
      return await this.bot.api.file(file_path, MAX_DOWNLOAD, signal);
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
      if (error.code === 413 || /too big/i.test(error.message)) throw new DownloadRefused(TOO_BIG);
      if (error.code >= 400 && error.code < 500 && error.code !== 429) throw new DownloadRefused(`Telegram refused (${error.message})`);
      throw error;
    }
  }

  /** Telegram takes only its standard reaction emoji from a bot; its refusal says so. */
  async react(ref: MessageRef | PostRef, emoji: string | undefined): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId === undefined) throw new Error("not a message of this chat");
    const reaction = emoji ? [{ type: "emoji", emoji }] : [];
    try {
      await this.bot.api.call("setMessageReaction", { chat_id: this.chat, message_id: messageId, reaction });
    } catch (error) {
      if (!(error as Error).message.includes("REACTION_INVALID")) throw error;
      throw new Error(`Telegram does not take ${emoji} as a reaction: use one of its standard reaction emoji`);
    }
  }

  /**
   * The place is to be titled `place.title` (every reload says so): its thread is renamed when Telegram has it
   * under another title (see `rename`); a thread made later gets it anyway.
   */
  retitle(place: Place): Promise<void> {
    if (this.mode === "dm" || place.kind !== "pet-thread") return Promise.resolve();
    this.wanted.set(place.id, place.title);
    return this.queueRename(place.id);
  }

  async ensurePlace(place: Place): Promise<void> {
    if (this.mode === "dm" || place.kind === "house-inbox") return;
    this.wanted.set(place.id, place.title);
    await this.thread(place);
  }

  /**
   * `https://t.me/<bot>/<thread>`, the thread made first if need be. Only this form opens a thread of a private chat
   * cleanly in Telegram's apps (checked by hand): one with a message id in it (`t.me/<bot>/<thread>/<message>`,
   * `?thread=`, `tg://resolve?…&post=…&thread=…`) opens the thread but says the message is not found,
   * `t.me/<bot>/<message>` goes to General, and `t.me/c/…` is refused for a private chat.
   */
  async placeLink(place: Place, { create = true }: { create?: boolean } = {}): Promise<string | undefined> {
    if (this.mode === "dm" || place.kind === "house-inbox") return undefined;
    // Asked not to make one: only a thread there is already.
    if (!create && !this.bot.options.state.get(this.keys.thread(place.id))) return undefined;
    if (this.mode === "group") return `https://t.me/c/${String(this.chat).slice(4)}/${await this.thread(place)}`;
    const [thread, username] = await Promise.all([this.thread(place), this.bot.username()]);
    return username ? `https://t.me/${username}/${thread}` : undefined;
  }

  /**
   * deleteForumTopic (works in a private chat with topics), then the place's thread is forgotten: a place of the
   * same id later would get a new one. A thread Telegram no longer has counts as deleted.
   */
  private async removeThread(place: Place): Promise<boolean> {
    if (place.kind !== "pet-thread") return false;
    await this.creating.get(place.id)?.catch(() => {});
    const { state, log } = this.bot.options;
    const thread = state.get(this.keys.thread(place.id));
    if (!thread) return false;
    try {
      await this.bot.api.call("deleteForumTopic", { chat_id: this.chat, message_thread_id: Number(thread) });
    } catch (error) {
      if (!/thread not found|TOPIC_ID_INVALID/i.test((error as Error).message)) throw error;
    }
    for (const key of [this.keys.creation(place.id), this.keys.thread(place.id), this.keys.title(place.id), this.keys.place(Number(thread))]) state.set(key, "");
    this.wanted.delete(place.id);
    this.failed.delete(place.id);
    log.info(`telegram ${this.name}: thread for ${place.id} deleted`);
    return true;
  }

  /** A rename of the place, after the ones before it (one at a time per chat). */
  private queueRename(id: string): Promise<void> {
    const job = this.renames.then(() => this.rename(id));
    this.renames = job.catch(() => {});
    return job.catch((error) => this.bot.options.log.error(`telegram ${this.name}: thread for ${id} not renamed: ${(error as Error).message}`));
  }

  /**
   * Renames the place's thread (editForumTopic; Bot API 9.3+ in a private chat with topics) to the title wanted
   * when its turn comes (so A → B → A, or reloads that overlap, end where the last one said), after a thread being
   * made. The state keeps the last title Telegram accepted (or refused for good). A 429 is waited out; a refusal
   * for good (4xx but 403 and 429; "not modified" is no refusal) is logged once and the thread keeps its name, a
   * new one is never made for it; anything else (403, 5xx, no answer, thread not found) is logged and tried again
   * on the next reload, and on a later use of the place (at most once a minute).
   */
  private async rename(id: string): Promise<void> {
    await this.creating.get(id)?.catch(() => {});
    const { state, log } = this.bot.options;
    const thread = state.get(this.keys.thread(id));
    const title = this.wanted.get(id);
    if (!thread || title === undefined || state.get(this.keys.title(id)) === title) return;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.bot.api.call("editForumTopic", { chat_id: this.chat, message_thread_id: Number(thread), name: title });
        log.info(`telegram ${this.name}: thread for ${id} renamed`);
      } catch (error) {
        const { code, message, retryAfter } = error as TelegramError;
        if (code === 429 && retryAfter && retryAfter <= MAX_POST_WAIT_S && attempt < 3) {
          await pause(retryAfter * 1000);
          continue;
        }
        if (!message.includes("TOPIC_NOT_MODIFIED")) {
          const refused = code >= 400 && code < 500 && code !== 403 && code !== 429 && !/thread not found/i.test(message);
          log.error(`telegram ${this.name}: thread for ${id} not renamed (${message}); ${refused ? "it keeps its name" : "tried again later"}`);
          if (!refused) {
            this.failed.set(id, { title, at: Date.now() });
            return;
          }
        }
      }
      break;
    }
    this.failed.delete(id);
    state.set(this.keys.title(id), title);
  }

  /** On a use of the place: a rename still owed (one that failed passingly, a title changed while it was made). */
  private renameIfOwed(id: string): void {
    const title = this.wanted.get(id);
    if (title === undefined || this.bot.options.state.get(this.keys.title(id)) === title) return;
    const failed = this.failed.get(id);
    if (failed?.title === title && Date.now() - failed.at < RENAME_RETRY_MS) return;
    void this.queueRename(id);
  }

  /** Sends the pieces: `entities` apply to the first, quotes to each, the keyboard goes under the last; resolves to their refs. */
  private async send(place: Place, pieces: string[], { entities, reply_markup, quoteOffset, pieceEntities, quiet }: { entities?: object[]; reply_markup?: InlineKeyboard; quoteOffset?: number; pieceEntities?: object[][]; /** A notice of Household's: no link previews. */ quiet?: boolean }): Promise<PostRef[]> {
    const where = await this.where(place);
    const refs: PostRef[] = [];
    for (const [i, piece] of pieces.entries()) {
      const first = pieceEntities?.[i]?.length ? { entities: pieceEntities[i] } : quoteOffset === undefined
        ? i === 0 && entities ? { entities } : {}
        : { entities: [{ type: "expandable_blockquote", offset: quoteOffset, length: piece.length - quoteOffset }] };
      const under = i === pieces.length - 1 && reply_markup ? { reply_markup } : {};
      const sent = await this.sendPiece({ chat_id: this.chat, ...where, text: piece, ...first, ...under, ...(quiet ? NO_PREVIEW : {}) });
      if (reply_markup && i === pieces.length - 1) this.remember(sent.message_id, { text: piece, ...first, ...(quiet ? { quiet: true as const } : {}) });
      refs.push(postRef(this.prefix, sent.message_id));
    }
    if (refs.length === 0) throw new Error("nothing to post: the text is empty");
    return refs;
  }

  private remember(messageId: number, shown: Shown): void {
    this.shown.delete(messageId);
    this.shown.set(messageId, shown);
    if (this.shown.size > MAX_SHOWN) this.shown.delete(this.shown.keys().next().value!);
  }

  /** A person's message of General, forwarded into a place's thread (made if it is not yet). */
  async forward(ref: MessageRef, place: Place): Promise<PostRef[]> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId === undefined || this.mode === "dm" || place.kind === "house-inbox") return [];
    const where = await this.where(place);
    const sent = await this.sendPiece({ chat_id: this.chat, from_chat_id: this.chat, message_id: messageId, ...where }, "forwardMessage");
    return [postRef(this.prefix, sent.message_id)];
  }

  async removeMessage(ref: MessageRef): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId === undefined) throw new Error("Invalid Telegram message reference");
    await this.bot.api.call("deleteMessage", { chat_id: this.chat, message_id: messageId });
  }

  /** Edits a message of this chat. Already like that is fine: a press may be taken twice (a replay). */
  private async edit(ref: PostRef, method: string, params: object): Promise<void> {
    const messageId = messageIdOf(this.prefix, ref);
    if (messageId === undefined) return;
    try {
      await this.bot.api.call(method, { chat_id: this.chat, message_id: messageId, ...params });
    } catch (error) {
      if (!(error as Error).message.includes("message is not modified")) throw error;
    }
  }

  /** One sendMessage; a 429 is waited out (briefly) and tried again, so the pieces before it are not repeated. */
  private async sendPiece(params: object, method = "sendMessage"): Promise<{ message_id: number }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.bot.api.call<{ message_id: number }>(method, params);
      } catch (error) {
        const { code, retryAfter } = error as TelegramError;
        if (code !== 429 || !retryAfter || retryAfter > MAX_POST_WAIT_S || attempt >= 3) throw error;
        await pause(retryAfter * 1000);
      }
    }
  }

  /** Where in the chat a place is: its thread, or General (no thread) for the inbox. */
  private async where(place: Place): Promise<{ message_thread_id?: number }> {
    return this.mode === "dm" || place.kind === "house-inbox" ? {} : { message_thread_id: await this.thread(place) };
  }

  private thread(place: Place): Promise<number> {
    const known = this.bot.options.state.get(this.keys.thread(place.id));
    if (known) {
      this.renameIfOwed(place.id);
      return Promise.resolve(Number(known));
    }
    let creating = this.creating.get(place.id);
    if (!creating) {
      creating = this.createThread(place).finally(() => this.creating.delete(place.id));
      this.creating.set(place.id, creating);
    }
    return creating.then((thread) => {
      this.renameIfOwed(place.id);
      return thread;
    });
  }

  private async checkForum(): Promise<void> {
    const chat = await this.bot.api.call<{ type: string; is_forum?: boolean }>("getChat", { chat_id: this.chat });
    if (chat.type !== "supergroup" || !chat.is_forum) throw new Error("Enable Topics in this Telegram supergroup before connecting it");
    const member = await this.bot.api.call<{ status: string; can_manage_topics?: boolean; can_delete_messages?: boolean }>("getChatMember", { chat_id: this.chat, user_id: Number(this.bot.id) });
    if (member.status !== "administrator" || !member.can_manage_topics || !member.can_delete_messages) throw new Error("Make the Telegram bot an administrator with Manage topics and Delete messages rights");
  }

  private async createThread(place: Place): Promise<number> {
    const { state } = this.bot.options;
    const key = this.keys.creation(place.id);
    const previous = state.get(key);
    if (previous) {
      let retryAt: number | undefined;
      let failure: string | undefined;
      try { const attempt = JSON.parse(previous); retryAt = attempt.retryAt; failure = typeof attempt.failure === "string" ? attempt.failure : undefined; } catch { /* An unreadable attempt is uncertain too. */ }
      if (typeof retryAt !== "number" || !Number.isFinite(retryAt) || retryAt > Date.now()) {
        throw new Error(`Topic creation for ${place.id} is blocked after an earlier attempt${failure ? ` (${failure})` : ""}; inspect existing Telegram topics before repairing its mapping. No new topic was requested.`);
      }
    }
    if (this.mode === "group") await this.checkForum();
    // createForumTopic is not idempotent. Persist BEFORE sending: a timeout, API refusal or process crash
    // can leave a topic on Telegram without its id here. Typing/status/reloads must never create another.
    state.set(key, JSON.stringify({ attemptedAt: Date.now() }));
    let thread: number;
    try {
      const result = await this.bot.api.call<{ message_thread_id: number }>("createForumTopic", { chat_id: this.chat, name: place.title });
      thread = result?.message_thread_id;
      if (!Number.isSafeInteger(thread) || thread <= 0) throw new Error("createForumTopic returned no valid thread id; inspect Telegram before retrying");
    } catch (error) {
      // An explicit rate limit is the only safe automatic retry, after Telegram's deadline.
      if (error instanceof TelegramError && error.code === 429) {
        const seconds = Number.isFinite(error.retryAfter) && error.retryAfter! > 0 ? error.retryAfter! : 60;
        state.set(key, JSON.stringify({ retryAt: Date.now() + seconds * 1000 }));
      } else if (error instanceof TelegramError) {
        state.set(key, JSON.stringify({ attemptedAt: Date.now(), failure: error.message }));
      }
      throw error;
    }
    // Save the id first: even if later writes fail, subsequent uses reuse it.
    state.set(this.keys.thread(place.id), String(thread));
    state.set(this.keys.title(place.id), place.title);
    state.set(this.keys.place(thread), place.id);
    state.set(key, "");
    this.bot.options.log.info(`telegram ${this.name}: thread for ${place.id} created`);
    return thread;
  }

  /**
   * A command for this bot by name (`/stop@house_bot`) is the command (`/stop`); one for another bot keeps its name
   * (so it is no command of Household's).
   */
  private async ownCommand(message: InboundMessage): Promise<InboundMessage> {
    if (message.kind !== "text") return message;
    const named = /^(\/\w+)@(\w+)(\s[^]*)?$/.exec(message.text);
    if (!named) return message;
    const own = await this.bot.username();
    return own?.toLowerCase() === named[2]!.toLowerCase() ? { ...message, text: `${named[1]}${named[3] ?? ""}` } : message;
  }

  /**
   * Hands one update of this chat over. A message that cannot be read or taken is logged and passed over. Every
   * press is answered, whoever made it, so the button stops spinning: once it is taken, with what Household says
   * to it (only the owner can answer, …); one on a button that is gone says so.
   */
  async take(update: Update): Promise<void> {
    if (update.widget_query) {
      try { await this.takeWidget(update.widget_query); }
      catch (error) { this.bot.options.log.error(`telegram ${this.name}: widget event failed: ${(error as Error).message}`); }
      return;
    }
    const { log, state } = this.bot.options;
    const { name, onMessage } = this;
    let parsed: Parsed | undefined;
    let answer: string | void = undefined;
    try {
      this.discoverTopic(update.message ?? update.edited_message ?? update.callback_query?.message);
      parsed = inboundMessage(update, { chat: this.chat, prefix: this.prefix, placeOf: (thread) => this.mode === "dm" ? undefined : state.get(this.keys.place(thread)) || undefined });
      if (parsed && "skipped" in parsed) {
        answer = parsed.answer;
        log.info(`telegram ${name}: update ${update.update_id} skipped (${parsed.skipped})`);
      } else if (parsed && onMessage) {
        const pressedOn = update.callback_query?.message;
        // Its text as posted is kept: what Telegram sends along has a note under it, if one is shown.
        if (pressedOn?.rich_message && !this.shown.has(pressedOn.message_id)) {
          this.remember(pressedOn.message_id, { text: "", rich: true });
        } else if (typeof pressedOn?.text === "string" && !this.shown.has(pressedOn.message_id)) {
          const entities = Array.isArray(pressedOn.entities) ? { entities: pressedOn.entities as object[] } : {};
          this.remember(pressedOn.message_id, { text: pressedOn.text, ...entities });
        }
        answer = await onMessage(await this.ownCommand(parsed.message));
      }
    } catch (error) {
      log.error(`telegram ${name}: update ${update.update_id} was not taken: ${(error as Error).message}`);
    }
    if (!update.callback_query) return;
    await this.bot.api
      .call("answerCallbackQuery", { callback_query_id: update.callback_query.id, ...(answer ? { text: answer } : {}) })
      .catch((error) => log.error(`telegram ${name}: a press was not answered: ${(error as Error).message}`));
  }
}

/**
 * A status call, its failures sorted: 429 → `RateLimited`; a refusal (400: the message gone, no longer editable,
 * its text not taken; 403: the bot shut out) → `StatusGone`; anything else (no answer, 5xx, …) as it is, which is
 * passing. «message is not modified» is no failure (`edit` takes it).
 */
async function statusCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const { code, message, retryAfter } = error as TelegramError;
    if (code === 429) throw new RateLimited((retryAfter ?? 5) * 1000);
    // Any other refusal of a status call would come again the same way (its text, the message gone): never again.
    if (code === 403 || code === 400) throw new StatusGone(message);
    throw error;
  }
}

/** A status post's text, entities and buttons (the stop button while working; none once over), no link previews. */
function statusMessage(view: StatusView): object {
  const stop = view.state === "working" && view.stop !== undefined ? keyboard([[view.stop]]) : { inline_keyboard: [] };
  return { text: renderStatus(view), reply_markup: stop, ...NO_PREVIEW };
}

/** Attribution avoids parsing rich Markdown just to distinguish pet reports from Household notices. */
function richMarkdown(place: Place, text: string, attribute = true): string {
  if (!text.trim()) throw new Error("The rich message text is empty");
  const title = place.title.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
  const markdown = attribute || looksLikeNotice(text) ? `**${title}**\n\n${text}` : text;
  if ([...markdown].length > 32768) throw new Error("The rich message exceeds Telegram's 32768 character limit including its bot title");
  return markdown;
}
