import { expect, test } from "bun:test";
import { api } from "./api";
import { scoutApi } from "./scout-api";

test("renamed bot and harness controls preserve daemon endpoints and serialized fields", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; method: string; body?: unknown }[] = [];
  try {
    globalThis.fetch = (async (url, options) => {
      requests.push({ url: String(url), method: options!.method!, ...(options!.body ? { body: JSON.parse(options!.body as string) } : {}) });
      return Response.json({});
    }) as typeof fetch;
    const harness = { agent: "claude-code-tmux", model: "default", key: "provider" };
    await scoutApi.agent("my workspace");
    await scoutApi.setHarness("my workspace", harness);
    await scoutApi.update("my workspace", "helper", { agent: undefined });
    await api.updateBot("my workspace", "my/bot", harness);
    expect(requests).toEqual([
      { url: "/api/houses/my%20workspace/scout-agent", method: "GET" },
      { url: "/api/houses/my%20workspace/scout-agent", method: "PUT", body: harness },
      { url: "/api/houses/my%20workspace/scouts/helper", method: "PATCH", body: { agent: null } },
      { url: "/api/houses/my%20workspace/pets/my%2Fbot", method: "PATCH", body: harness },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
