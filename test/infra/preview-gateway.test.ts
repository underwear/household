import { describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { PreviewGateway } from "../../src/infra/preview-gateway";

function gateway(port: number) {
  return new PreviewGateway(async (machine, requestedPort) => {
    expect(machine).toBe("household.test.pet"); expect(requestedPort).toBe(3000);
    return createConnection({ host: "127.0.0.1", port });
  });
}
const target = { machine: "household.test.pet", port: 3000, bindAddress: "127.0.0.1", publicHost: "localhost" };
describe("HTTP preview gateway", () => {
  test("HTTP methods, resources, binary bodies and redirects pass without following redirects", async () => {
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => req.url.endsWith("/redirect") ? Response.redirect("http://127.0.0.1:9/private") : new Response(await req.arrayBuffer(), { headers: { "X-Path": new URL(req.url).pathname } }) });
    const preview = await gateway(app.port!).open(target);
    try {
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      const response = await fetch(`${preview.url}/api/asset`, { method: "POST", body: bytes });
      expect(response.headers.get("x-path")).toBe("/api/asset");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      const redirect = await fetch(`${preview.url}/redirect`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("http://127.0.0.1:9/private");
    } finally { await preview.close(); await app.stop(true); }
    expect(fetch(preview.url)).rejects.toThrow();
  });
  test("WebSocket bidirectional binary and close terminate existing connections", async () => {
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response("hi"); }, websocket: { message(ws, message) { ws.send(message); } } });
    const preview = await gateway(app.port!).open(target);
    const ws = new WebSocket(preview.url.replace("http:", "ws:"));
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
      const response = new Promise(resolve => { ws.onmessage = e => resolve(e.data); });
      ws.send("preview hello");
      expect(await response).toBe("preview hello");
      ws.binaryType = "arraybuffer";
      const binary = new Promise<ArrayBuffer>(resolve => { ws.onmessage = e => resolve(e.data); });
      ws.send(new Uint8Array([0, 255, 128, 10]));
      expect(new Uint8Array(await binary)).toEqual(new Uint8Array([0, 255, 128, 10]));
      const ended = new Promise(resolve => { ws.onclose = resolve; });
      await preview.close();
      await ended;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally { ws.close(); await preview.close(); await app.stop(true); }
  });
  test("closing interrupts a streaming HTTP response", async () => {
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("started")); } })); } });
    const preview = await gateway(app.port!).open(target);
    try {
      const response = await fetch(preview.url);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("started");
      await preview.close();
      await expect(reader.read()).rejects.toThrow();
    } finally { await preview.close(); await app.stop(true); }
  });
  test("connection failure creates no listener and rejects invalid targets", async () => {
    const failed = new PreviewGateway(async () => { throw new Error("unreachable"); });
    await expect(failed.open(target)).rejects.toThrow("unreachable");
    await expect(failed.open({ ...target, machine: "--host" })).rejects.toThrow("Invalid");
    await expect(failed.open({ ...target, port: 1.5 })).rejects.toThrow("Invalid");
    await expect(failed.open({ ...target, publicHost: "evil/path" })).rejects.toThrow("host");
    await expect(failed.open({ ...target, bindAddress: "external.example" })).rejects.toThrow("IP");
  });
});

describe("preview isolation", () => {
  test("dashboard cookies never reach HTTP/WS applications and cannot be set or cleared by responses", async () => {
    let seenWsCookies: string | null = null;
    const replyHeaders = new Headers();
    replyHeaders.append("Set-Cookie", "household_session_8780=stolen; Path=/");
    replyHeaders.append("Set-Cookie", "household_session_9999=stolen; Domain=localhost");
    replyHeaders.append("Set-Cookie", "app_session=okay; Path=/");
    replyHeaders.set("Clear-Site-Data", '"cookies", "storage"');
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) {
      if (req.headers.get("upgrade")) { seenWsCookies = req.headers.get("cookie"); if (server.upgrade(req, { headers: replyHeaders })) return; }
      return new Response(req.headers.get("cookie"), { headers: replyHeaders });
    }, websocket: { message() {} } });
    const preview = await gateway(app.port!).open(target);
    const cookie = "household_session_8780=HOST_SECRET; app_session=app; household_session_9999=OTHER_SECRET";
    try {
      const response = await fetch(preview.url, { headers: { cookie } });
      expect(await response.text()).toBe("app_session=app");
      expect(response.headers.getSetCookie()).toEqual(["app_session=okay; Path=/"]);
      expect(response.headers.get("clear-site-data")).toBeNull();
      const { request } = await import("node:http");
      await new Promise<void>((resolve, reject) => {
        const req = request(preview.url, { headers: { cookie, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
        req.on("error", reject);
        req.on("upgrade", (res, socket) => {
          try {
            expect(seenWsCookies).toBe("app_session=app");
            expect(res.headers["set-cookie"]).toEqual(["app_session=okay; Path=/"]);
            expect(res.headers["clear-site-data"]).toBeUndefined();
            resolve();
          } catch (error) { reject(error); }
          finally { socket.destroy(); }
        });
        req.end();
      });
    } finally { await preview.close(); await app.stop(true); }
  });

  test("aborting during the VM probe never creates a listener", async () => {
    const abort = new AbortController();
    let complete!: (socket: import("node:stream").Duplex) => void;
    const deferred = new PreviewGateway(() => new Promise(resolve => { complete = resolve; }));
    const opened = deferred.open({ ...target, signal: abort.signal });
    abort.abort();
    const { PassThrough } = await import("node:stream");
    const probe = new PassThrough(); complete(probe);
    await expect(opened).rejects.toThrow();
    expect(probe.destroyed).toBe(true);
  });

  test("abort closes an existing listener", async () => {
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const abort = new AbortController();
    const preview = await gateway(app.port!).open({ ...target, signal: abort.signal });
    try {
      abort.abort(); await preview.close();
      await expect(fetch(preview.url)).rejects.toThrow();
    } finally { await preview.close(); await app.stop(true); }
  });

  test("64 active or pending connections bound guest exec processes", async () => {
    let dials = 0;
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("started")); } })) });
    const preview = await new PreviewGateway(async () => { dials++; return createConnection({ host: "127.0.0.1", port: app.port! }); }).open(target);
    const responses: Response[] = [];
    try {
      for (let i = 0; i < 64; i++) responses.push(await fetch(preview.url));
      const refused = await fetch(preview.url);
      expect(refused.status).toBe(502);
      expect(dials).toBe(65); // initial reachability probe + 64 active
      await responses.pop()!.body!.cancel();
      await Bun.sleep(10);
      responses.push(await fetch(preview.url));
      expect(responses.at(-1)!.status).toBe(200);
      expect(dials).toBe(66);
    } finally { for (const response of responses) await response.body?.cancel(); await preview.close(); await app.stop(true); }
  });
});
