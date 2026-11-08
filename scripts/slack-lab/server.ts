#!/usr/bin/env bun
/** Local, synthetic protocol lab. Real SlackChannel + Chat; scripted agent, no Slack account or VM. */
import { Chat } from "../../src/app/chat";
import { Dialogs } from "../../src/app/dialogs";
import { SlackBot, SlackChannel } from "../../src/channel-adapters/slack";
import type { SlackApi } from "../../src/channel-adapters/slack/api";
import { channelKey } from "../../src/core/channels";
import type { House } from "../../src/core/household";
import type { Message, MessageDraft } from "../../src/core/message";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { EventLog } from "../../src/infra/event-log";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const labDir = join(import.meta.dir, "../../.qa/slack-lab");
mkdirSync(labDir, { recursive: true, mode: 0o700 });
const store = new SqliteStore(":memory:");
const log = new EventLog(join(labDir, "events.log"), () => {});
let serial = 0, version = 0, delivered = 0, edited = 0;
const ts = () => `${Math.floor(Date.now() / 1000)}.${String(++serial).padStart(6, "0")}`;
type Post = { ts: string; text: string; thread_ts?: string; blocks?: any[]; user?: string; reaction?: string; deleted?: boolean };
const posts: Post[] = [];
const ephemeral: string[] = [];
const api: SlackApi = { async call<T>(method: string, params: Record<string, any> = {}): Promise<T> {
  if (method === "auth.test") return { team_id: "TLAB", bot_id: "BLAB", user_id: "UBOT" } as T;
  if (method === "conversations.info") return { channel: { is_im: true } } as T;
  if (method === "chat.postMessage") { const post = { ...params, ts: ts() } as Post; posts.push(post); version++; return { ts: post.ts } as T; }
  const post = posts.find(post => post.ts === (params.ts ?? params.timestamp));
  if (method === "chat.update" && post) { Object.assign(post, params); edited++; }
  if (method === "chat.delete" && post) post.deleted = true;
  if (method === "reactions.add" && post) post.reaction = params.name;
  if (method === "reactions.remove" && post) post.reaction = undefined;
  if (method === "chat.postEphemeral") ephemeral.push(params.text);
  if (method === "chat.getPermalink") return { permalink: `http://127.0.0.1:${server.port}/#${params.message_ts}` } as T;
  version++;
  return { ok: true } as T;
} };
const bot = new SlackBot({ token: "xoxb-local-lab-synthetic-000000", appToken: "xapp-local-lab-synthetic-000000", state: store, log, api, socket: () => ({ on() {}, async start() {}, async disconnect() {} }) });
const channel = new SlackChannel(bot, "TLAB:DLAB");
const config = { kind: "slack-private" as const, token: "synthetic", appToken: "synthetic", chat: "TLAB:DLAB", pets: ["sibling", "owl"], default: "sibling" };
const house: House = { name: "lab", network: { kind: "allowlist", allow: [] }, people: { owners: [{ platform: "slack", id: "TLAB:UOWNER" }] }, pets: [{ name: "sibling", title: "Сиблинг", emoji: "🐾" }, { name: "owl", title: "Исследователь", emoji: "🦉", aliases: ["Исследователь"] }], channels: [config] };
const running = new Map<string, AbortController>();
let chat: Chat;
const scheduled = new Set<Promise<void>>();
async function runPet(pet: string, draft: MessageDraft): Promise<void> {
  const controller = new AbortController();
  running.get(pet)?.abort(); running.set(pet, controller);
  const turn = ts();
  const message: Message = { ...draft, id: serial, status: "delivered" };
  chat.onDelivery({ kind: "delivered", house: "lab", pet, messages: [message] });
  chat.onDelivery({ kind: "turn-started", house: "lab", pet, turn, messages: [message] });
  const progress = (line: string, call: string) => chat.onDelivery({ kind: "progress", house: "lab", pet, event: { kind: "tool-started", tool: "lab", summary: line, action: { kind: "run", says: line }, turn, call } });
  progress("Разбираю запрос", "read");
  const pause = async (ms: number) => { await Bun.sleep(ms); if (controller.signal.aborted) throw new Error("stopped"); };
  try {
    await pause(900);
    const input = draft.text.toLowerCase();
    if (/доступ|access|network/.test(input)) {
      const result = await chat.ownerCard("lab", pet, { text: "Доступ к api.example.com\nЛокальная демонстрация: реальная сеть не меняется.", start: "waiting", view: state => state === "waiting" ? { choices: [["На 15 минут"], ["Постоянно"], ["Отказать"]] } : { outcome: state }, press: (_state, index) => ["Разрешено на 15 минут", "Разрешено постоянно", "Отказано"][index]! }, controller.signal);
      if (result) await chat.reply("lab", pet, `Решение получено: *${result}*.\nВ настоящем канале эта же карточка управляет запросом House.`, undefined, "c1");
    } else if (/долг|long|stop/.test(input)) {
      await chat.notice("lab", pet, "Запущена долгая демонстрационная работа. Нажми Stop в статусе — House её остановит.");
      for (let i = 0; i < 20; i++) {
        if (i % 5 === 0) progress(`Проверяю сценарий · шаг ${i / 5 + 1} из 4`, `step-${i}`);
        await pause(1000);
      }
      await chat.reply("lab", pet, "Работа завершена. Все сообщения остались в этом треде.", undefined, "c1");
    } else {
      await chat.reply("lab", pet, `*${pet === "owl" ? "План проверки" : "Slack-адаптер на связи"}*\n\n• Один тред на каждого пета\n• Статус обновляется на месте\n• Решения — кнопками под сообщением\n• Токены остаются на хосте\n\nЭто ответ сценарного агента в локальном стенде. Маршрутизация, статусы и кнопки работают через настоящий House.`, [["Запросить доступ", "Долгая работа"]], "c1");
    }
    chat.onDelivery({ kind: "turn-finished", house: "lab", pet, turn });
  } catch { if (!controller.signal.aborted) chat.onDelivery({ kind: "turn-lost", house: "lab", pet, turn, why: "failed" }); }
  finally { if (running.get(pet) === controller) running.delete(pet); }
}
chat = new Chat({
  send: (_house, pet, draft) => { delivered++; const task = new Promise<void>(resolve => setTimeout(resolve, 50)).then(() => runPet(pet, draft)).catch(() => {}); scheduled.add(task); void task.finally(() => scheduled.delete(task)); return { activity: "idle", queued: 1 }; },
  answered() {}, reject: () => true,
  interrupt: async (_house, pet) => { running.get(pet)?.abort(); return { status: "stopped" }; },
}, () => new Map([["lab", new Map([[channelKey(config), { channel }]])]]), log, new Dialogs(log), store);
await chat.setHouses([house]);
const csrf = crypto.randomUUID();
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.SLACK_LAB_PORT ?? 8793), async fetch(request) {
  const url = new URL(request.url);
  if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Wrong host", { status: 403 });
  if (request.method === "GET" && url.pathname === "/") return new Response((await Bun.file(join(import.meta.dir, "index.html")).text()).replaceAll("__CSRF__", csrf), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (request.method === "GET" && url.pathname === "/state") return Response.json({ version, posts: posts.filter(post => !post.deleted), ephemeral: ephemeral.slice(-3), delivered, edited }, { headers: { "cache-control": "no-store" } });
  if (request.method !== "POST" || request.headers.get("origin") !== url.origin || request.headers.get("x-lab-token") !== csrf) return new Response("Forbidden", { status: 403 });
  try {
    const input = await request.json() as { text?: string; thread?: string; ts?: string; index?: number; label?: string; guest?: boolean };
    const user = input.guest ? "UGUEST" : "UOWNER";
    if (url.pathname === "/message" && typeof input.text === "string" && input.text.length <= 4000) {
      const stamp = ts();
      posts.push({ ts: stamp, user, text: input.text, ...(input.thread ? { thread_ts: input.thread } : {}) }); version++;
      await bot.take({ team_id: "TLAB", event_id: `Ev${stamp}`, event: { type: "message", user, channel: "DLAB", text: input.text, ts: stamp, thread_ts: input.thread } });
    } else if (url.pathname === "/press" && input.ts && Number.isInteger(input.index)) {
      const post = posts.find(post => post.ts === input.ts);
      if (!post) throw new Error("Card is gone");
      await bot.take({ type: "block_actions", team: { id: "TLAB" }, channel: { id: "DLAB" }, user: { id: user, name: input.guest ? "Гость" : "Игорь" }, message: { ts: post.ts, thread_ts: post.thread_ts }, container: { message_ts: post.ts }, actions: [{ action_id: `household_choice_${input.index}`, value: String(input.index), action_ts: ts(), text: { text: input.label } }] });
    } else return new Response("Unknown operation", { status: 400 });
    return Response.json({ ok: true });
  } catch { return Response.json({ error: "Не удалось выполнить действие" }, { status: 400 }); }
} });
console.log(`Slack adapter lab: http://127.0.0.1:${server.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { for (const task of running.values()) task.abort(); await chat.stop(); server.stop(true); store.close(); process.exit(0); });
