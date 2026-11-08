import { randomBytes } from "node:crypto";
/** The web UI's files by URL path: `/index.html` is the page, the rest are what it loads. */
export type WebAssets = Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>;

/**
 * Answers the requests the app owns (`/login`, `/api/…`); undefined for the rest, which get the UI's files.
 * `hold` lifts the idle timeout for this request: its answer may wait for a reload.
 */
export type WebHandler = (request: Request, hold: () => void) => Promise<Response | undefined>;

export interface WebServerOptions {
  port: number;
  assets: WebAssets;
  handle: WebHandler;
}

/** On every answer. Only this origin's scripts and styles; fonts come inlined in the stylesheet (data URLs). */
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // The sign-in link carries its token in the URL.
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
} as const;

const SAFE_METHODS = ["GET", "HEAD"];

/**
 * The daemon's web UI and its JSON API, on the Mac's loopback. Other local programs reach that too, and so does a
 * web page through DNS rebinding, so besides the app's session check every request must name this
 * server in its Host header, and one that changes something must come from this origin (Origin header).
 */
export function serveWeb({ port, assets, handle }: WebServerOptions): { port: number; stop: () => Promise<void> } {
  const nonce = randomBytes(24).toString("base64");
  const secure = (response: Response) => {
    secured(response);
    response.headers.set("content-security-policy", SECURITY_HEADERS["content-security-policy"].replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`));
    return response;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 10,
    // Scout owner uploads allow 16 MiB, encoded as base64 in authenticated JSON requests.
    maxRequestBodySize: 24 * 1024 * 1024,
    development: false,
    error: () => secure(new Response("internal error\n", { status: 500 })),
    async fetch(request, server) {
      const hosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const host = request.headers.get("host") ?? "";
      if (!hosts.includes(host)) return secure(new Response("unexpected Host header\n", { status: 421 }));
      if (!SAFE_METHODS.includes(request.method) && request.headers.get("origin") !== `http://${host}`) {
        return secure(Response.json({ error: "cross-origin request refused" }, { status: 403 }));
      }
      const answer = await handle(request, () => server.timeout(request, 0));
      return secure(answer ?? file(request, assets, nonce));
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

/** A file of the UI; any other path gets the page, which routes in the browser. */
function file(request: Request, assets: WebAssets, nonce: string): Response {
  if (!SAFE_METHODS.includes(request.method)) return Response.json({ error: "method not allowed" }, { status: 405 });
  const path = new URL(request.url).pathname;
  const asset = path === "/index.html" ? undefined : assets.get(path);
  if (asset) return new Response(asset.body, { headers: { "content-type": asset.type, "cache-control": "public, max-age=31536000, immutable" } });
  const page = assets.get("/index.html");
  if (!page) return new Response("the web UI is not built: see the daemon's log\n", { status: 503 });
  const html = new TextDecoder().decode(page.body).replace("</head>", `<meta name="style-nonce" content="${nonce}"></head>`);
  return new Response(html, { headers: { "content-type": page.type, "cache-control": "no-store" } });
}

function secured(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}
