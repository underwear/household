import { expect, test } from "bun:test";
import { slackDownload, slackUpload, SLACK_FILE_MAX_BYTES } from "../../src/infra/slack/files";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { PetInboxFiles } from "../../src/infra/pet-inbox";
import type { SlackFetch } from "../../src/infra/slack/client";

const signal = () => new AbortController().signal;
const metadata = (url = "https://files.slack.com/files-pri/F123", extra = {}) => Response.json({ ok: true, file: { name: "photo.png", mimetype: "image/png", url_private_download: url, ...extra } });

test("downloads follow relative and CDN redirects without forwarding the bearer token to CDN", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: SlackFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return metadata();
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "/redirected" } });
    if (calls.length === 3) return new Response(null, { status: 307, headers: { location: "https://downloads.slack-edge.com/F123?signature=private" } });
    return new Response(new Uint8Array([0, 255, 7]));
  };
  const result = await slackDownload(fetcher, "secret", "F123", signal());
  expect(result.bytes).toEqual(Buffer.from([0, 255, 7]));
  expect(calls[2]!.url).toBe("https://files.slack.com/redirected");
  for (const call of calls.slice(1)) expect(call.init?.redirect).toBe("manual");
  expect(new Headers(calls[2]!.init?.headers).get("authorization")).toBe("Bearer secret");
  expect(new Headers(calls[3]!.init?.headers).has("authorization")).toBe(false);
});
test("untrusted initial URLs and redirects are rejected before contacting them", async () => {
  for (const url of ["http://files.slack.com/file", "https://files.slack.com.evil.test/file", "https://localhost/file", "https://127.0.0.1/file", "https://files.slack.com:444/file", "https://user:pass@files.slack.com/file", "file:///etc/passwd", "https://slack.com/login"]) {
    for (const redirect of [false, true]) {
      let calls = 0;
      const fetcher: SlackFetch = async () => {
        calls++;
        return calls === 1 ? metadata(redirect ? undefined : url) : new Response(null, { status: 302, headers: { location: url } });
      };
      await expect(slackDownload(fetcher, "secret", "F123", signal())).rejects.toThrow("invalid_file_url");
      expect(calls).toBe(redirect ? 2 : 1);
    }
  }
});
test("redirect loops and redirects without Location are bounded", async () => {
  let calls = 0;
  await expect(slackDownload(async () => ++calls === 1 ? metadata() : new Response(null, { status: 302, headers: { location: "/again" } }), "secret", "F123", signal())).rejects.toThrow("too_many_redirects");
  expect(calls).toBe(7);
  calls = 0;
  await expect(slackDownload(async () => ++calls === 1 ? metadata() : new Response(null, { status: 302 }), "secret", "F123", signal())).rejects.toThrow("invalid_file_url");
});
test("file downloads enforce metadata, Content-Length and actual stream size bounds", async () => {
  let calls = 0;
  await expect(slackDownload(async () => { calls++; return metadata(undefined, { size: SLACK_FILE_MAX_BYTES + 1 }); }, "secret", "F123", signal())).rejects.toThrow("file_too_large");
  expect(calls).toBe(1);
  for (const declared of [true, false]) {
    calls = 0; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    await expect(slackDownload(async () => ++calls === 1 ? metadata() : new Response(stream, { headers: declared ? { "content-length": String(SLACK_FILE_MAX_BYTES + 1) } : {} }), "secret", "F123", signal())).rejects.toThrow("file_too_large");
    expect(cancelled).toBe(true);
  }
});
test("download falls back to url_private and sanitizes the filename", async () => {
  let calls = 0;
  const result = await slackDownload(async () => ++calls === 1 ? metadata(undefined, { url_private_download: undefined, url_private: "https://files.slack.com/file", name: "../bad\\name.png" }) : new Response("abc"), "secret", "F123", signal());
  expect(result.filename).toBe("F123-name.png");
  expect(result.bytes.toString()).toBe("abc");
});
test("file HTTP errors preserve rate limits but never reflect upstream text", async () => {
  let calls = 0;
  await expect(slackDownload(async () => ++calls === 1 ? metadata() : new Response("secret", { status: 429, headers: { "retry-after": "37" } }), "secret", "F123", signal())).rejects.toThrow("37 seconds");
});
test("upload refuses an untrusted URL and never retries failed byte POST or completion", async () => {
  for (const failure of ["url", "post", "complete"]) {
    let calls = 0;
    const fetcher: SlackFetch = async (_url, init) => {
      calls++;
      if (calls === 1) return Response.json({ ok: true, file_id: "F123", upload_url: failure === "url" ? "https://evil.test/upload" : "https://files.slack.com/upload/v1/test" });
      if (calls === 2) {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        if (failure === "post") return new Response("sensitive upstream text", { status: 500 });
        return new Response("OK");
      }
      throw new Error("completion connection lost");
    };
    await expect(slackUpload(fetcher, "secret", { filename: "file.bin" }, new Uint8Array([1]), signal())).rejects.toThrow();
    expect(calls).toBe(failure === "url" ? 1 : failure === "post" ? 2 : 3);
  }
});
test("revocation between upload steps prevents the next side effect even if transport ignores abort", async () => {
  for (const abortAt of [1, 2]) {
    const controller = new AbortController(); let calls = 0;
    const fetcher: SlackFetch = async () => {
      calls++;
      if (calls === abortAt) controller.abort();
      return calls === 1 ? Response.json({ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/v1/test" }) : new Response("OK");
    };
    await expect(slackUpload(fetcher, "secret", { filename: "file.bin" }, new Uint8Array([1]), controller.signal)).rejects.toThrow();
    expect(calls).toBe(abortAt);
  }
});
test("downloads stop before following redirects after cancellation", async () => {
  const controller = new AbortController(); let calls = 0;
  await expect(slackDownload(async () => {
    calls++;
    if (calls === 1) return metadata();
    controller.abort();
    return new Response(null, { status: 302, headers: { location: "/next" } });
  }, "secret", "F123", controller.signal)).rejects.toThrow();
  expect(calls).toBe(2);
});

test("download filenames, including hidden and multibyte names, work with the real inbox storage", async () => {
  const homes = tempDir(), volume = "household.home.alice.home";
  mkdirSync(join(homes, volume));
  const files = new PetInboxFiles(homes);
  for (const name of [".env", "𝒜".repeat(100) + ".png"]) {
    let calls = 0;
    const downloaded = await slackDownload(async () => ++calls === 1 ? metadata(undefined, { name }) : new Response("file content"), "secret", "F123", signal());
    const path = await files.save(volume, "2026-11-14", downloaded.filename, downloaded.bytes);
    expect(readFileSync(join(homes, volume, path), "utf8")).toBe("file content");
    expect(Buffer.byteLength(downloaded.filename)).toBeLessThanOrEqual(200);
  }
});
