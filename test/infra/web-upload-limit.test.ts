import { expect, test } from "bun:test";
import { serveWeb } from "../../src/infra/web-server";

test("web transport accepts the 16 MiB scout file encoded as JSON", async () => {
  const web = serveWeb({ port: 0, assets: new Map(), handle: async request => {
    const data = await request.json() as { content: string };
    return Response.json({ bytes: Buffer.byteLength(data.content, "base64") });
  } });
  try {
    const origin = `http://127.0.0.1:${web.port}`;
    const response = await fetch(`${origin}/api/houses/work/scouts/test/files`, { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ path: "~/fixture.bin", content: Buffer.alloc(16 * 1024 * 1024).toString("base64") }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 16 * 1024 * 1024 });
  } finally { await web.stop(); }
});
