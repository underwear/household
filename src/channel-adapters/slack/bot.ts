import { SocketModeClient, LogLevel } from "@slack/socket-mode";
import type { SlackApi } from "./api";
import { SlackWebApi } from "./api";
import type { SlackIdentity } from "./kind";
import type { SlackPayload } from "./events";

export interface SlackState { get(key: string): string | undefined; set(key: string, value: string): void; }
export interface SlackChat { take(body: SlackPayload): Promise<void>; }
export interface SocketClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
export interface SlackBotOptions {
  token: string; appToken: string; state: SlackState;
  log: { info(message: string): void; error(message: string): void };
  claimIdentity?(identity: string, bot: SlackBot): void;
  releaseIdentity?(bot: SlackBot): void;
  api?: SlackApi; socket?: () => SocketClient;
}

/** One socket per installed bot; no user token, public listener, or credentials inside a pet. */
export class SlackBot {
  readonly api: SlackApi;
  private readonly chats = new Map<string, SlackChat>();
  private socket?: SocketClient;
  private generation = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private identity?: Promise<SlackIdentity>;
  private queue = Promise.resolve();
  private readonly inFlight = new Set<string>();
  constructor(readonly options: SlackBotOptions) { this.api = options.api ?? new SlackWebApi(options.token); }
  me(): Promise<SlackIdentity> {
    return this.identity ??= this.api.call<SlackIdentity>("auth.test").then(me => {
      if (!me.bot_id || !/^T[A-Z0-9]+$/.test(me.team_id)) throw new Error("Slack bot identity is invalid");
      if (this.chats.size) this.options.claimIdentity?.(`${me.team_id}:${me.bot_id}`, this);
      return me;
    }).catch(error => { this.identity = undefined; throw error; });
  }
  add(chat: string, handler: SlackChat): void {
    this.chats.set(chat, handler);
    if (!this.socket && !this.retry) void this.connect();
  }
  async leave(chat: string, handler: SlackChat): Promise<void> {
    if (this.chats.get(chat) === handler) this.chats.delete(chat);
    if (this.chats.size) return;
    this.generation++;
    clearTimeout(this.retry); this.retry = undefined;
    const socket = this.socket; this.socket = undefined;
    await socket?.disconnect();
    await this.queue;
    this.identity = undefined;
    this.options.releaseIdentity?.(this);
  }
  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const socket = this.options.socket?.() ?? new SocketModeClient({
      appToken: this.options.appToken,
      logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} },
      clientOptions: { timeout: 15_000, retryConfig: { retries: 0 } },
    });
    this.socket = socket;
    socket.on("slack_event", ({ body, ack }: { body: SlackPayload; ack: () => Promise<void> }) => {
      // Slack requires a fast acknowledgement. Core owns durable delivery after take().
      void ack().catch(() => this.options.log.error("Slack acknowledgement failed"));
      void this.take(body).catch(() => this.options.log.error("Slack event delivery failed; no message content logged"));
    });
    socket.on("error", () => this.options.log.error("Slack connection error; reconnecting"));
    try {
      await this.me();
      if (this.generation !== generation || !this.chats.size) return;
      await socket.start();
      if (this.generation !== generation) { await socket.disconnect(); return; }
      this.options.log.info("Slack Socket Mode connected");
    } catch {
      await socket.disconnect().catch(() => {});
      if (this.generation !== generation) return;
      this.socket = undefined;
      this.options.log.error("Slack connection failed; check bot/app tokens and Socket Mode. Retrying in 30s");
      if (this.chats.size) this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 30_000);
    }
  }
  /** Shared by the real socket and the local protocol test harness. No unconfigured chat is dispatched. */
  async take(body: SlackPayload): Promise<void> {
    const me = await this.me();
    const team = body.team_id ?? body.team?.id;
    if (team !== me.team_id) return;
    const channel = body.event?.channel ?? body.event?.item?.channel ?? body.channel?.id ?? body.container?.channel_id;
    if (!channel || !channel.startsWith("D")) return;
    const chat = this.chats.get(`${team}:${channel}`);
    if (!chat) return;
    if ((body.event?.message ?? body.event)?.user === me.user_id) return;
    const id = body.event_id ?? (body.type === "block_actions" ? `${body.user?.id}:${body.container?.message_ts ?? body.message?.ts}:${body.actions?.[0]?.action_ts}` : undefined);
    if (!id) return;
    const key = `slack.${team}.${me.bot_id}.seen`;
    const seen: string[] = JSON.parse(this.options.state.get(key) ?? "[]");
    if (seen.includes(id) || this.inFlight.has(id)) return;
    if (this.inFlight.size >= 200) throw new Error("Slack inbound queue is full");
    this.inFlight.add(id);
    const work = this.queue.then(async () => {
      if (this.chats.get(`${team}:${channel}`) !== chat) return;
      await chat.take(body);
      const latest: string[] = JSON.parse(this.options.state.get(key) ?? "[]");
      this.options.state.set(key, JSON.stringify([...latest, id].slice(-1000)));
    });
    this.queue = work.catch(() => {});
    try { await work; } finally { this.inFlight.delete(id); }
  }
}
