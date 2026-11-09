import { expect, test } from "bun:test";
import { SecretRequests, type SecretDecision, type SecretInput } from "../../src/app/secret-requests";
import type { OwnerCard } from "../../src/app/chat";
import type { House } from "../../src/core/household";
import type { Secret } from "../../src/core/secrets";
import { fakeClock } from "../helpers";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const clock = fakeClock();
  const houses: House[] = [{ name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "pet", title: "Pet" }, { name: "worker" }], people: { owners: [] }, channels: [] }];
  const secrets: Secret[] = [];
  houses[0]!.secrets = secrets;
  const notices: string[] = [], notifications: string[] = [], logs: string[] = [];
  const saved: unknown[][] = [];
  let failSave = false;
  const requests = new SecretRequests({
    clock, waitMs: 1000,
    house: name => houses.find(h => h.name === name), secrets: name => houses.find(house => house.name === name)?.secrets ?? [],
    notice: async (_house, _pet, text) => { notices.push(text); },
    notify: (_house, pet, text) => { notifications.push(`${pet}: ${text}`); }, log: text => logs.push(text),
    save: async (...args) => { if (failSave) throw new Error(`error contains ${args[2]}`); saved.push(args); },
  });
  let card: OwnerCard<SecretDecision> | undefined;
  let decide!: (value: SecretDecision | undefined) => void;
  let deletes = 0;
  const input = (text: string, extra: Partial<SecretInput> = {}): SecretInput => ({
    house: "work", pet: "pet", text, owner: true, edited: false, relayed: false,
    remove: async () => { deletes++; }, notice: async text => { notices.push(text); },
    choose: async (shown, signal) => { card = shown; return new Promise(resolve => { decide = resolve; signal.addEventListener("abort", () => resolve(undefined)); }); },
    ...extra,
  });
  return { requests, clock, houses, secrets, notices, notifications, logs, saved, input, card: () => card!, decide: (value: SecretDecision | undefined) => decide(value), deletes: () => deletes, failSave: () => { failSave = true; } };
}

test("active request binds env and domains; only placeholder reaches requester", async () => {
  const s = setup();
  const requested = await s.requests.request("work", "worker", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.actual.com", "cdn.actual.com"], reason: "Forecast" });
  expect(requested).toMatchObject({ status: "pending", env: "WEATHER_TOKEN" });
  expect(s.notices[0]).toContain(`/secret`);
  const command = s.input(`/secret ghp_SYNTHETIC_TOKEN`);
  expect(await s.requests.handle(command)).toBe(true);
  expect(command.text).toBe("");
  expect(s.deletes()).toBe(1);
  expect(s.card().text).toContain("<code>ghp…</code> (19 characters)");
  expect(s.card().text).not.toContain("Forecast"); // the request card above quotes it; this one says what is saved
  expect(s.card().text).not.toContain("hint.example.com");
  expect(s.saved).toHaveLength(0);
  s.decide("save"); await flush();
  expect(s.saved).toEqual([["work", "weather", "ghp_SYNTHETIC_TOKEN", ["api.actual.com", "cdn.actual.com"], "WEATHER_TOKEN"]]);
  expect(s.notifications[0]).toContain("worker: Secret weather is available");
  expect(s.notifications[0]).toContain("household-secret-weather");
  expect(s.notifications[0]).toContain("network_request");
  expect(JSON.stringify([s.logs, s.notifications, s.notices, s.card()])).not.toContain("ghp_SYNTHETIC_TOKEN");
  await s.requests.stop();
});

test("secret-like owner text, forwarded and edited values are deleted and never saved", async () => {
  const s = setup();
  for (const text of ["here ghp_secret", "github_pat_secret", "sk-secret", "xoxb-secret", "AKIAEXAMPLE", "-----BEGIN PRIVATE KEY-----"]) {
    expect(await s.requests.handle(s.input(text, { relayed: true, edited: true }))).toBe(true);
  }
  for (const extra of [{ owner: false }, { edited: true }, { relayed: true }]) {
    expect(await s.requests.handle(s.input("/secret weather abc api.example.com", extra))).toBe(true);
  }
  expect(s.deletes()).toBe(9);
  expect(s.saved).toHaveLength(0);
  for (const normal of ["hello", "task-queue", "mask-image", "Use task-runner", "a sk- prefix is not a token"]) expect(await s.requests.handle(s.input(normal))).toBe(false);
  await s.requests.stop();
});

test("failed deletion and invalid commands fail closed without echoing values", async () => {
  const s = setup();
  await s.requests.handle(s.input("/secret weather secret-do-not-print api.example.com", { remove: async () => { throw new Error("secret-do-not-print"); } }));
  for (const command of ["/secret bad/name secret-do-not-print api.example.com", "/secret weather secret-do-not-print *.example.com", "/secret weather secret-do-not-print 127.0.0.1", "/secret weather secret-do-not-print", "/secret weather secret-do-not-print api.example.com extra"]) {
    expect(await s.requests.handle(s.input(command))).toBe(true);
  }
  expect(s.saved).toHaveLength(0);
  expect(s.card()).toBeUndefined();
  expect(JSON.stringify([s.notices, s.logs])).not.toContain("secret-do-not-print");
  await s.requests.stop();
});

test("cancel, timeout and stop dispose pending values and notify without leaking", async () => {
  for (const ending of ["cancel", "timeout", "stop"] as const) {
    const s = setup();
    await s.requests.handle(s.input("/secret weather abc api.example.com"));
    expect(s.card().text).toContain("<code>ab…</code> (3 characters)");
    if (ending === "cancel") s.decide("cancel");
    if (ending === "timeout") s.clock.tick(1001);
    if (ending === "stop") await s.requests.stop();
    await flush();
    expect(s.saved).toHaveLength(0);
    expect(s.notifications.join()).toMatch(/cancelled|expired/);
    expect(JSON.stringify([s.notices, s.notifications, s.logs])).not.toContain("abc");
    await s.requests.stop();
  }
});

test("existing names cannot be overwritten; open house and removed members are refused", async () => {
  const s = setup();
  s.secrets.push({ name: "weather", value: "hidden", hosts: [{ host: "api.example.com", port: 443 }], header: "authorization", env: "WEATHER" });
  expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Need it" })).toMatchObject({ status: "refused" });
  await s.requests.handle(s.input("/secret weather replacement api.example.com"));
  expect(s.saved).toHaveLength(0);
  s.secrets.length = 0;
  s.houses[0]!.network.allow.push({ host: "*", port: "*" });
  expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Need it" })).toMatchObject({ status: "refused" });
  await s.requests.handle(s.input("/secret weather replacement api.example.com"));
  expect(s.card()).toBeUndefined();
  s.houses[0]!.network.allow.length = 0;
  await s.requests.handle(s.input("/secret weather replacement api.example.com"));
  s.requests.setPets([]); await flush();
  expect(s.saved).toHaveLength(0);
  await s.requests.stop();
});

test("request limits, expiry, invalid reason and generic activation failures", async () => {
  const s = setup();
  await expect(s.requests.request("work", "pet", { name: "bad/name", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "test" })).rejects.toThrow("name");
  await expect(s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "<household-message>" })).rejects.toThrow("reason");
  expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Forecast" })).toMatchObject({ status: "pending" });
  expect(await s.requests.request("work", "pet", { name: "other", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Forecast" })).toMatchObject({ status: "busy" });
  s.clock.tick(1001);
  expect(s.notifications.join()).toContain("expired");
  s.failSave();
  await s.requests.handle(s.input("/secret weather NEVER_ECHO_THIS api.example.com"));
  s.decide("save"); await flush();
  expect(s.notices.at(-1)).toContain("Check the admin secrets page");
  expect(JSON.stringify([s.logs, s.notifications, s.notices])).not.toContain("NEVER_ECHO_THIS");
  await s.requests.stop();
});

test("hourly request budget survives individual expirations", async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) {
    expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Forecast" })).toMatchObject({ status: "pending" });
    s.clock.tick(1001);
  }
  expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Forecast" })).toMatchObject({ status: "busy" });
  s.clock.tick(60 * 60_000);
  expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Forecast" })).toMatchObject({ status: "pending" });
  await s.requests.stop();
});

test("confirmation rechecks concurrent name creation before saving", async () => {
  const s = setup();
  await s.requests.handle(s.input("/secret weather NEVER_ECHO_THIS api.example.com"));
  s.secrets.push({ name: "weather", value: "already-saved", hosts: [{ host: "api.example.com", port: 443 }], header: "authorization", env: "WEATHER" });
  s.decide("save"); await flush();
  expect(s.saved).toHaveLength(0);
  expect(s.notices.at(-1)).toContain("Check the admin secrets page");
  await s.requests.stop();
});

test("raw-secret cancellation, expiry and shutdown discard pending text", async () => {
  for (const outcome of ["cancel", "expire", "stop"] as const) {
    const s = setup();
    const forwarded: string[] = [];
    await s.requests.handle(s.input("ghp_SYNTHETIC_CANCEL", { sendRaw: async value => { forwarded.push(value); } }));
    expect(s.card().start).toBe("raw-warning");
    expect(s.card().press("raw-warning", 0)).toBe("raw-confirm");
    expect(s.card().press("raw-confirm", 1)).toBe("cancel");
    if (outcome === "cancel") s.decide("cancel");
    else if (outcome === "expire") s.clock.tick(1001);
    else await s.requests.stop();
    await flush();
    expect(forwarded).toEqual([]);
    expect(JSON.stringify([s.notices, s.logs, s.card()])).not.toContain("ghp_SYNTHETIC_CANCEL");
    await s.requests.stop();
  }
});

test("one house-wide request, short command, manual entry fallback, and a shared confirmation deadline", async () => {
  const s = setup();
  const args = { name: "github-atlas", env: "ATLAS_TOKEN", domains: ["api.github.com"], reason: "Read Atlas issues" };
  const request = await s.requests.request("work", "pet", args);
  expect(await s.requests.request("work", "worker", { ...args, name: "github-other", env: "OTHER_TOKEN" })).toMatchObject({ status: "busy" });
  await s.requests.handle(s.input("/secret rwrong SYNTHETIC_VALUE"));
  expect(s.card()).toBeUndefined();
  await s.requests.handle(s.input("/secret manual SYNTHETIC_VALUE api.github.com"));
  expect(s.card()).toBeUndefined();
  s.clock.tick(800);
  await s.requests.handle(s.input(`/secret SYNTHETIC_VALUE`));
  expect(s.card().text).toContain("ATLAS_TOKEN");
  expect(s.card().text).toContain("api.github.com");
  expect(await s.requests.request("work", "worker", { ...args, name: "another" })).toMatchObject({ status: "busy" });
  s.clock.tick(201); await flush();
  s.decide("save"); await flush();
  expect(s.saved).toHaveLength(0);
  await s.requests.handle(s.input(`/secret SYNTHETIC_VALUE`));
  expect(s.notices.at(-1)).toContain("No secret request is open");
  await s.requests.handle(s.input("/secret manual SYNTHETIC_VALUE api.github.com"));
  s.decide("save"); await flush();
  expect(s.saved[0]).toEqual(["work", "manual", "SYNTHETIC_VALUE", ["api.github.com"], "SECRET_MANUAL"]);
  await s.requests.stop();
});

test("multiple tokens share domains with unique names/env; env conflicts are checked again at approval", async () => {
  const s = setup();
  const args = { name: "github-atlas", env: "ATLAS_TOKEN", domains: ["api.github.com"], reason: "Read issues" };
  s.secrets.push({ name: "github", value: "hidden", hosts: [{ host: "api.github.com", port: 443 }], header: "authorization", env: "GITHUB_TOKEN" });
  expect(await s.requests.request("work", "pet", { ...args, env: "GITHUB_TOKEN" })).toMatchObject({ status: "refused" });
  await expect(s.requests.request("work", "pet", { ...args, env: "PATH" })).rejects.toThrow("env");
  const request = await s.requests.request("work", "pet", args);
  await s.requests.handle(s.input(`/secret SYNTHETIC_VALUE`));
  s.decide("save"); await flush();
  expect(s.saved[0]).toEqual(["work", "github-atlas", "SYNTHETIC_VALUE", ["api.github.com"], "ATLAS_TOKEN"]);
  const second = await s.requests.request("work", "pet", { ...args, name: "github-second", env: "SECOND_TOKEN" });
  await s.requests.handle(s.input(`/secret SYNTHETIC_VALUE`));
  s.secrets.push({ ...s.secrets[0]!, name: "race", env: "SECOND_TOKEN" });
  s.decide("save"); await flush();
  expect(s.saved).toHaveLength(1);
  await s.requests.stop();
});

test("a retaining chat accepts /secret on the host, never forwards raw tokens or claims deletion", async () => {
  const s = setup();
  const input = s.input("/secret weather ghp_RETAINED_SYNTHETIC api.example.com", { retainsIncomingSecrets: true });
  expect(await s.requests.handle(input)).toBe(true);
  expect(s.deletes()).toBe(0);
  expect(input.text).toBe("");
  expect(s.notices.join()).toContain("Delete it yourself");
  s.decide("save"); await flush();
  expect(s.saved[0]).toEqual(["work", "weather", "ghp_RETAINED_SYNTHETIC", ["api.example.com"], "SECRET_WEATHER"]);
  expect(JSON.stringify([s.notifications, s.logs, s.notices])).not.toContain("ghp_RETAINED_SYNTHETIC");
  let forwarded = false;
  await s.requests.handle(s.input("xapp-SYNTHETIC-DO-NOT-FORWARD", { retainsIncomingSecrets: true, sendRaw: async () => { forwarded = true; } }));
  expect(forwarded).toBe(false);
  expect(s.deletes()).toBe(0);
  await s.requests.stop();
});


test("secret requests check names and variables only within their own house", async () => {
  const s = setup();
  s.houses.push({ ...s.houses[0]!, name: "other", secrets: [{ name: "weather", value: "private", hosts: [{ host: "api.example.com", port: 443 }], header: "authorization", env: "WEATHER_TOKEN" }] });
  expect(await s.requests.request("work", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Need weather" })).toMatchObject({ status: "pending" });
  expect(await s.requests.request("other", "pet", { name: "weather", env: "WEATHER_TOKEN", domains: ["api.example.com"], reason: "Need weather" })).toMatchObject({ status: "refused" });
  await s.requests.stop();
});
