import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { AttachmentFetcher, sweepInboxes, type FetchTiming } from "../../src/app/attachments";
import { TelegramBot, TelegramChannel } from "../../src/channel-adapters/telegram";
import type { Attachment, FileRef } from "../../src/core/attachment";
import type { Message } from "../../src/core/message";
import { PetInboxFiles } from "../../src/infra/pet-inbox";
import { fakeTelegram } from "../fake-telegram";
import { tempDir, waitFor } from "../helpers";

const TOKEN = "123456:secret-part-of-the-token";
const TIMING: FetchTiming = { retriesMs: [1, 1], attemptMs: 2_000 };
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** sibling's home on the host, a fake Telegram, and a fetcher that downloads through a Telegram channel into that home. */
function setup() {
  const api = fakeTelegram(TOKEN);
  stops.push(api.stop);
  const homes = realpathSync(tempDir());
  const home = join(homes, "household.work.sibling.home");
  mkdirSync(home);
  const lines: string[] = [];
  const log = { info: (line: string) => lines.push(line), error: (line: string) => lines.push(`ERROR ${line}`) };
  const bot = new TelegramBot({ name: "house work", token: TOKEN, log, apiBase: api.url, state: { get: () => undefined, set: () => {} } });
  const channel = new TelegramChannel(bot, 1, "house work");
  const places: (string | undefined)[] = [];
  const fetcher = new AttachmentFetcher(
    (_house, place, attachment, signal) => (places.push(place), channel.download(attachment, signal)),
    new PetInboxFiles(homes),
    log,
    () => "UTC",
    TIMING,
  );
  const message = (attachments: Attachment[]): Message => ({
    id: 9, text: "", status: "received", origin: "chat", place: "c1.sibling", attachments,
    header: { event: { kind: "message", id: "m3" }, from: { id: "p1", name: "Oleg", trust: "owner" }, channel: { id: "c1", kind: "telegram-private", name: "DM", audience: "private" } },
  });
  const today = new Date().toISOString().slice(0, 10);
  return { api, home, homes, lines, fetcher, message, today, places };
}

test("each file is saved in the pet's inbox under Household's name; one that cannot come gets why, after tries again only when it may pass", async () => {
  const { api, home, lines, fetcher, message, today, places } = setup();
  api.file("voice", new Uint8Array([9]), "voice/file_1.oga");
  api.file("photo", new TextEncoder().encode("jpeg"), "photos/file_2.jpg");
  api.file("keys", new TextEncoder().encode("ssh-ed25519 …"), "documents/file_3");
  api.fail("file", 502, "Bad Gateway", 3); // the voice's three tries
  const voice: Attachment = { kind: "voice", file: "voice" as FileRef, mime: "audio/ogg", duration: 3 };
  const photo: Attachment = { kind: "photo", file: "photo" as FileRef, mime: "image/jpeg" };
  const keys: Attachment = { kind: "document", file: "keys" as FileRef, name: "../../.ssh/authorized_keys" };
  const big: Attachment = { kind: "video", file: "big" as FileRef, name: "película.mp4", size: 30 * 1024 * 1024 };
  const gone: Attachment = { kind: "document", file: "gone" as FileRef, name: "viejo.pdf" };
  const done: Attachment = { ...photo, path: "/home/agent/elsewhere.jpg" };

  const fetched = await fetcher.fetch("work", "sibling", "/home/agent", message([voice, photo, keys, big, gone, done]));
  const inbox = `/home/agent/.household/inbox/${today}`;
  expect(fetched).toEqual([
    { ...voice, failed: "not downloaded: file: 502 refused" },
    { ...photo, path: `${inbox}/m3-photo.jpg` },
    { ...keys, path: `${inbox}/m3-authorized_keys.bin` },
    { ...big, failed: "not downloaded: over 20 MB, and Telegram does not give bots larger files" },
    { ...gone, failed: "not downloaded: Telegram refused (getFile: 400 Bad Request: invalid file_id)" },
    done, // fetched before: as it was
  ]);
  const day = join(home, ".household/inbox", today);
  expect(readdirSync(day).sort()).toEqual(["m3-authorized_keys.bin", "m3-photo.jpg"]);
  expect(readFileSync(join(day, "m3-photo.jpg"), "utf8")).toBe("jpeg");
  expect(api.sent("getFile").map(({ file_id }) => file_id)).toEqual(["voice", "voice", "voice", "photo", "keys", "gone"]);
  expect(places.every((place) => place === "c1.sibling")).toBe(true);
  expect(lines).toContain("ERROR pet work/sibling: voice of m3 not downloaded: file: 502 refused");
  expect(lines).toContain(`pet work/sibling: photo of m3 saved to .household/inbox/${today}/m3-photo.jpg`);
  expect(lines.some((line) => line.includes(TOKEN))).toBe(false);
});

test("a sideworker file is stored in its own volume and exposed under its own guest home", async () => {
  const { api, home, homes, fetcher, message, today } = setup();
  const worker = join(homes, "household.work.helper.home");
  mkdirSync(worker);
  api.file("photo", new Uint8Array([1, 2]), "photos/file.jpg");
  const photo: Attachment = { kind: "photo", file: "photo" as FileRef, mime: "image/jpeg" };
  expect(await fetcher.fetch("work", "helper", "/home/worker", message([photo]))).toEqual([
    { ...photo, path: `/home/worker/.household/inbox/${today}/m3-photo.jpg` },
  ]);
  expect([...readFileSync(join(worker, ".household/inbox", today, "m3-photo.jpg"))]).toEqual([1, 2]);
  expect(readdirSync(home)).toEqual([]);
});

test("a passing failure is tried again until the file comes; a home whose inbox is not Household's to write gets why", async () => {
  const { api, home, fetcher, message, today } = setup();
  api.file("photo", new Uint8Array([1]), "photos/file_2.jpg");
  api.fail("getFile", 500, "Internal Server Error", 2);
  const photo: Attachment = { kind: "photo", file: "photo" as FileRef, mime: "image/jpeg" };
  expect(await fetcher.fetch("work", "sibling", "/home/agent", message([photo]))).toEqual([{ ...photo, path: `/home/agent/.household/inbox/${today}/m3-photo.jpg` }]);

  // The pet made its `.household` a link: Household never writes through it.
  mkdirSync(join(home, "real"));
  rmSync(join(home, ".household"), { recursive: true });
  symlinkSync(join(home, "real"), join(home, ".household"));
  expect(await fetcher.fetch("work", "sibling", "/home/agent", message([photo]))).toEqual([
    { ...photo, failed: "not downloaded: could not write to ~/.household/inbox (unsafe or unavailable inbox path)" },
  ]);
  expect(readdirSync(join(home, "real"))).toEqual([]);
});

test("the inboxes are swept at the start and then every period, files older than three days; stopping stops it", async () => {
  const befores: number[] = [];
  const lines: string[] = [];
  const stop = sweepInboxes({ sweep: async (before) => (befores.push(before.getTime()), 2) }, { info: (line) => lines.push(line), error: (line) => lines.push(line) }, 30);
  expect(befores).toHaveLength(1);
  expect(Math.abs(Date.now() - 3 * 24 * 60 * 60_000 - befores[0]!)).toBeLessThan(1_000);
  await waitFor(() => befores.length >= 3);
  stop();
  const swept = befores.length;
  await Bun.sleep(80);
  expect(befores).toHaveLength(swept);
  expect(lines[0]).toBe("inboxes: 2 file(s) older than 3 days deleted");

  const failing = sweepInboxes({ sweep: async () => { throw new Error("disk gone"); } }, { info: () => {}, error: (line) => lines.push(line) });
  await waitFor(() => lines.includes("inboxes: not swept (disk gone)"));
  failing();
});
