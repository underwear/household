import { spawn } from "node:child_process";
import { createServer, request, Agent, type IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { Duplex } from "node:stream";

export interface PreviewListener { url: string; close(): Promise<void> }
export interface PreviewTarget { machine: string; port: number; bindAddress: string; publicHost: string; signal?: AbortSignal }
export type PreviewDial = (machine: string, port: number) => Promise<Duplex>;

// A byte stream over the runtime's guest exec channel, never a persistent port mapping.
// stdin EOF (including Household's exit) closes the guest connection and ends the helper.
const CONNECT = `import os,select,socket,sys
s=socket.create_connection(('127.0.0.1',int(sys.argv[1])),5)
s.settimeout(None)
os.write(1,b'\\x00')
try:
 while True:
  ready,_,_=select.select([0,s],[],[])
  if 0 in ready:
   b=os.read(0,65536)
   if not b: break
   s.sendall(b)
  if s in ready:
   b=s.recv(65536)
   if not b: break
   view=memoryview(b)
   while view:
    n=os.write(1,view)
    view=view[n:]
finally:
 s.close()
`;

/** Only a port in this named VM, via fixed loopback; no agent-provided upstream URL. */
export const dialPreviewVm: PreviewDial = (machine, port) => new Promise((resolve, reject) => {
  const child = spawn("msb", ["exec", "--quiet", "--stream", "--timeout", "15m", machine, "--", "python3", "-u", "-c", CONNECT, String(port)], { stdio: ["pipe", "pipe", "ignore"] });
  let connected = false;
  const timer = setTimeout(() => fail(), 10_000);
  const fail = () => { clearTimeout(timer); child.kill("SIGKILL"); if (!connected) reject(new Error("Could not connect to the application inside the VM")); };
  child.once("error", fail);
  child.once("exit", () => { if (!connected) fail(); });
  child.stdout.once("data", (chunk: Buffer) => {
    if (chunk[0] !== 0) { fail(); return; }
    connected = true;
    clearTimeout(timer);
    child.stdout.pause();
    if (chunk.length > 1) child.stdout.unshift(chunk.subarray(1));
    const socket = new Duplex({
      read() { child.stdout.resume(); },
      write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
      final(callback) { child.stdin.end(callback); },
      destroy(error, callback) { child.kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy(); callback(error); },
    });
    child.stdout.on("data", chunk => { if (!socket.push(chunk)) child.stdout.pause(); });
    child.stdout.once("end", () => socket.push(null));
    child.stdin.on("error", error => socket.destroy(error));
    child.stdout.on("error", error => socket.destroy(error));
    socket.once("close", () => child.kill("SIGKILL"));
    // Guest exit ends both sides even when an HTTP client is still writing.
    child.once("exit", () => socket.destroy());
    resolve(socket);
  });
});

function headers(input: IncomingHttpHeaders, websocket = false): IncomingHttpHeaders {
  const result = { ...input };
  for (const name of String(input.connection ?? "").split(",")) delete result[name.trim().toLowerCase()];
  for (const name of ["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) delete result[name];
  // Cookies are scoped to hosts, not ports: a separate preview origin must not
  // receive or overwrite the dashboard's session, including WebSocket handshakes.
  if (result.cookie) {
    const safe = result.cookie.split(";").filter(part => !/^household_session_/i.test(part.trim().split("=", 1)[0] ?? "")).join(";");
    if (safe.trim()) result.cookie = safe.trim(); else delete result.cookie;
  }
  if (result["set-cookie"]) {
    const safe = result["set-cookie"].filter(value => !/^household_session_/i.test(value.trim().split("=", 1)[0] ?? ""));
    if (safe.length) result["set-cookie"] = safe; else delete result["set-cookie"];
  }
  delete result["clear-site-data"];
  if (websocket) { result.connection = "Upgrade"; result.upgrade = "websocket"; }
  return result;
}

export class PreviewGateway {
  constructor(private readonly dial: PreviewDial = dialPreviewVm) {}

  async open(target: PreviewTarget): Promise<PreviewListener> {
    target.signal?.throwIfAborted();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(target.machine) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("Invalid VM preview target");
    if (!isIP(target.bindAddress)) throw new Error("Preview bind address must be an IP address");
    const host = target.publicHost.replace(/^\[|\]$/g, "");
    if (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) throw new Error("Preview link host must be a hostname or IP address, without a port or path");
    // Fail before advertising a listener if the application is not reachable.
    const probe = await this.dial(target.machine, target.port);
    probe.destroy();
    target.signal?.throwIfAborted();
    let closed = false;
    const sockets = new Set<Duplex>();
    const track = (socket: Duplex) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      if (closed) socket.destroy();
      return socket;
    };
    const agent = new Agent({ keepAlive: false });
    // Count pending dials too: each consumes a guest exec process. Upgraded sockets
    // leave Node's Agent pool, so its maxSockets setting alone cannot bound these.
    let connections = 0;
    agent.createConnection = (_options, done) => {
      if (closed || connections >= 64) {
        queueMicrotask(() => done?.(new Error("Preview connection limit reached or preview closed"), undefined as never));
        return undefined as never;
      }
      connections++;
      this.dial(target.machine, target.port).then(socket => {
        socket.once("close", () => connections--);
        if (closed) { socket.destroy(); done?.(new Error("Preview closed"), socket); }
        else done?.(null, track(socket));
      }, error => { connections--; done?.(error, undefined as never); });
      return undefined as never;
    };
    const server = createServer((incoming, outgoing) => {
      if (!incoming.url?.startsWith("/") || incoming.method === "CONNECT") { outgoing.writeHead(400).end(); return; }
      const upstream = request({ hostname: "127.0.0.1", port: target.port, path: incoming.url, method: incoming.method, headers: headers(incoming.headers), agent }, response => {
        outgoing.writeHead(response.statusCode ?? 502, headers(response.headers));
        response.pipe(outgoing);
        response.on("error", () => outgoing.destroy());
      });
      incoming.on("aborted", () => upstream.destroy());
      outgoing.on("close", () => upstream.destroy());
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end("Preview application unavailable"); else outgoing.destroy(); });
      incoming.pipe(upstream);
    });
    server.on("connection", track);
    server.on("connect", (_request, socket) => socket.destroy());
    server.on("upgrade", (incoming, client, head) => {
      if (!incoming.url?.startsWith("/") || incoming.headers.upgrade?.toLowerCase() !== "websocket") { client.destroy(); return; }
      const upstream = request({ hostname: "127.0.0.1", port: target.port, path: incoming.url, method: "GET", headers: headers(incoming.headers, true), agent });
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.on("response", response => { response.destroy(); client.destroy(); });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        track(remote);
        client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers(response.headers, true)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter(v => v !== undefined).map(v => `${name}: ${v}\r\n`)).join("")}\r\n`);
        if (remoteHead.length) client.write(remoteHead);
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
        client.once("close", () => remote.destroy());
        remote.once("close", () => client.destroy());
      });
      upstream.end();
    });
    try {
      target.signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, target.bindAddress, () => { server.off("error", reject); resolve(); }); });
    } catch (error) { closed = true; agent.destroy(); for (const socket of sockets) socket.destroy(); throw error; }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Preview listener address unavailable");
    let closing: Promise<void> | undefined;
    const abort = () => { void close(); };
    const close = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      target.signal?.removeEventListener("abort", abort);
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      closing = new Promise<void>(resolve => server.close(() => resolve()));
      return closing;
    };
    target.signal?.addEventListener("abort", abort, { once: true });
    if (target.signal?.aborted) { await close(); target.signal.throwIfAborted(); }
    return { url: `http://${isIP(host) === 6 ? `[${host}]` : host}:${address.port}`, close };
  }
}
