import type { Update } from "../src/channel-adapters/telegram/updates";

export interface BotCall {
  method: string;
  params: Record<string, any>;
  /** The bot's id (the token's part before `:`). */
  bot: string;
}

/**
 * A fake Bot API on 127.0.0.1: records every call, serves queued updates to getUpdates (honouring the offset,
 * like Telegram), answers createForumTopic with fresh thread ids (editForumTopic renames them, as Telegram does:
 * TOPIC_NOT_MODIFIED for the same name) and sendMessage with fresh message ids (kept in `messages`). `fail` makes the next calls of a method fail.
 * Files added with `file` are given by getFile and downloaded from `/file/bot<token>/<path>` (method `file` for `fail`).
 */
export function fakeTelegram(token: string, ...others: string[]) {
  const calls: BotCall[] = [];
  const messages: (Record<string, any> & { message_id: number })[] = [];
  /** Each bot's own updates, by token (Telegram keeps one queue per bot). */
  const queues = new Map([token, ...others].map((known) => [known, [] as Update[]]));
  const failures = new Map<string, { code: number; description: string; retry_after?: number }[]>();
  let nextUpdate = 1;
  let nextThread = 100;
  /** Thread names, by chat and thread id (`chat/thread`). */
  const topics = new Map<string, string>();
  let nextMessage = 1000;
  /** Files by id: where getFile says they are, and their bytes. */
  const files = new Map<string, { path: string; bytes: Uint8Array }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/file/")) {
        const [, , bot = "", ...path] = url.pathname.split("/");
        calls.push({ method: "file", params: { path: path.join("/") }, bot: bot.slice(3).split(":")[0]! });
        const failure = failures.get("file")?.shift();
        if (failure) return new Response(failure.description, { status: failure.code });
        const found = queues.has(bot.slice(3)) && [...files.values()].find((file) => file.path === path.join("/"));
        return found ? new Response(new Blob([Buffer.from(found.bytes)])) : new Response("Not Found", { status: 404 });
      }
      const [, bot = "", method = ""] = url.pathname.split("/");
      const updates = queues.get(bot.slice(3));
      if (!bot.startsWith("bot") || !updates) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      const params = (request.headers.get("content-type")?.startsWith("multipart/form-data")
        ? Object.fromEntries(await request.formData())
        : await request.json().catch(() => ({}))) as Record<string, any>;
      calls.push({ method, params, bot: bot.slice(3).split(":")[0]! });
      const failure = failures.get(method)?.shift();
      if (failure) {
        const { code, description, retry_after } = failure;
        return Response.json({ ok: false, error_code: code, description, parameters: { retry_after } }, { status: code });
      }
      if (method === "getUpdates") {
        const pending = () => updates.filter((update) => update.update_id >= (params.offset ?? 0));
        // A short long poll: answers as soon as there is something, or empty after a moment.
        for (let i = 0; i < 10 && pending().length === 0; i++) await Bun.sleep(10);
        return Response.json({ ok: true, result: pending() });
      }
      if (method === "getFile") {
        const file = files.get(params.file_id);
        if (!file) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
        return Response.json({ ok: true, result: { file_id: params.file_id, file_path: file.path, file_size: file.bytes.byteLength } });
      }
      if (method === "getMe") return Response.json({ ok: true, result: { id: Number(bot.slice(3).split(":")[0]), is_bot: true, username: "fake_bot", has_topics_enabled: true } });
      if (method === "createForumTopic") {
        topics.set(`${params.chat_id}/${nextThread}`, params.name);
        return Response.json({ ok: true, result: { message_thread_id: nextThread++, name: params.name } });
      }
      if (method === "editForumTopic") {
        const topic = `${params.chat_id}/${params.message_thread_id}`;
        const refuse = (description: string) => Response.json({ ok: false, error_code: 400, description }, { status: 400 });
        if (!topics.has(topic)) return refuse("Bad Request: message thread not found");
        if (topics.get(topic) === params.name) return refuse("Bad Request: TOPIC_NOT_MODIFIED");
        topics.set(topic, params.name);
        return Response.json({ ok: true, result: true });
      }
      if (["sendMessage", "sendRichMessage", "sendDocument", "sendPhoto", "sendVoice", "sendVideo"].includes(method)) {
        messages.push({ ...params, message_id: nextMessage++ });
        return Response.json({ ok: true, result: { message_id: messages.at(-1)!.message_id, text: params.text } });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    /** Messages sent, with the ids they got. */
    messages,
    /** Thread names as Telegram has them, by `chat/thread`. */
    topics,
    /** Calls of one method, their params. */
    sent: (method: string) => calls.filter((call) => call.method === method).map((call) => call.params),
    /** Queues an update for the bot of `to` (the first token's, unless given); `update_id` is filled in. */
    push(update: Omit<Update, "update_id">, to = token): number {
      const id = nextUpdate++;
      queues.get(to)!.push({ update_id: id, ...update });
      return id;
    },
    /** A file the bot can download, by its id. */
    file(id: string, bytes: Uint8Array, path = `documents/${id}`) {
      files.set(id, { path, bytes });
    },
    fail(method: string, code: number, description: string, times = 1, retry_after?: number) {
      const list = failures.get(method) ?? [];
      for (let i = 0; i < times; i++) list.push({ code, description, retry_after });
      failures.set(method, list);
    },
    stop: () => server.stop(true),
  };
}
