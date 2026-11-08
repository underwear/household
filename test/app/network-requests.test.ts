import { expect, test } from "bun:test";
import type { OwnerCard } from "../../src/app/chat";
import { CONFIRM_CHOICES, NETWORK_CHOICES, NETWORK_TTL_MS, NetworkRequests, networkCard, requestDomain, requestPort, type NetworkStep } from "../../src/app/network-requests";
import type { NetworkPolicy } from "../../src/core/network-policy";
import type { Screened } from "../../src/infra/public-resolve";
import { fakeClock } from "../helpers";

/** What the stub DNS screen answers for a domain; any other resolves to GitHub's public address. */
const SCREENED: Record<string, Screened> = {
  "localtest.me": { private: "127.0.0.1" },
  "nowhere.example.org": { failed: "cannot resolve nowhere.example.org: ENOTFOUND" },
};
const GITHUB = "140.82.112.6";

/** A card as the owner sees it, moved as Chat moves it: `answer` presses a choice shown now, or (undefined) closes it. */
interface ShownCard { text: string; choices: string[][]; note?: string; answer: (index?: number) => void; signal: AbortSignal }

function show(card: OwnerCard<NetworkStep>, signal: AbortSignal, done: (state?: NetworkStep) => void): ShownCard {
  let state = card.start;
  const shown: ShownCard = { text: card.text, choices: [], signal, answer: (index) => {
    if (index === undefined) return done();
    if (index >= shown.choices.flat().length) return;
    state = card.press(state, index);
    view();
  } };
  const view = () => {
    const next = card.view(state);
    if ("outcome" in next) return done(state);
    shown.choices = next.choices;
    shown.note = next.note;
    if (next.text !== undefined) shown.text = next.text;
  };
  view();
  return shown;
}

function setup(saved = new Map<string, string>(), clock = fakeClock(), deferred = false) {
  const base: NetworkPolicy = { kind: "allowlist", allow: [{ host: "api.anthropic.com", port: 443 }] };
  const cards: ShownCard[] = [];
  const notices: string[] = [];
  const screened: string[] = [];
  const permanent: string[] = [];
  const permanentCallers: (string | undefined)[] = [];
  let available = true;
  let failApply = false;
  let applications = 0;
  let applied: NetworkPolicy = base;
  const service = new NetworkRequests({
    store: { get: (key) => saved.get(key), set: (key, value) => { saved.set(key, value); }, delete: (key) => { saved.delete(key); } },
    deferScreen: () => deferred,
    policy: () => available ? base : undefined,
    petTitle: () => "🐾 Sibling",
    screen: async (domain) => { screened.push(domain); return SCREENED[domain] ?? { address: GITHUB, addresses: [GITHUB] }; },
    choose: (_, __, card, signal) => new Promise((done) => cards.push(show(card, signal, done))),
    notice: async (_, __, text) => { notices.push(text); },
    permanent: async (_, domain, pet) => { permanentCallers.push(pet); permanent.push(domain); const [host, port] = domain.split(":"); base.allow.push({ host: host!, port: Number(port) }); },
    changed: async () => { applications++; if (failApply) throw new Error("gateway unavailable"); applied = service.effective("work", "sibling", base); },
    clock, waitMs: 1000,
  });
  return { service, cards, notices, screened, clock, saved, permanent, permanentCallers, base, applied: () => applied, applications: () => applications, removePet: () => { available = false; }, failApply: (value: boolean) => { failApply = value; } };
}
const reason = "GitHub API: read the repository issue requested by the owner";
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };


test("network requests: temporary owner choice applies HTTPS only, persists, restores, and expires at the original deadline", async () => {
  const first = setup();
  await first.service.start();
  const answer = first.service.request("work", "sibling", " API.GitHub.com ", reason);
  await settle(); // its domain screened, its card up
  expect(first.cards[0]!.text).toBe(`<b>🐾 Sibling wants to reach <code>api.github.com</code></b>\n\nWhy:\n<blockquote>${reason}</blockquote>\n\nResolves to: <code>${GITHUB}</code>`);
  expect(first.cards[0]!.choices).toEqual([["Allow 15 min"], ["Allow forever"], ["Deny"]]);
  first.cards[0]!.answer(0);
  expect(await answer).toEqual({ domain: "api.github.com", port: 443, status: "temporary", expiresAt: NETWORK_TTL_MS });
  expect(first.applied().allow).toContainEqual({ host: "api.github.com", port: 443, expiresAt: NETWORK_TTL_MS, reach: { pinned: [GITHUB] } });
  expect(first.service.list("work", "sibling").temporary).toMatchObject([{ pet: "sibling", addresses: [GITHUB] }]);
  expect(first.service.active("another-house")).toEqual([]);
  // The grant is the asking pet's: a housemate neither holds nor lists it.
  expect(first.service.list("work", "chair").temporary).toEqual([]);
  expect(first.service.effective("work", "chair", first.base).allow).not.toContainEqual(expect.objectContaining({ host: "api.github.com" }));
  expect(first.service.petGrants("work")).toEqual([{ pet: "sibling", entry: { host: "api.github.com", port: 443, expiresAt: NETWORK_TTL_MS, reach: { pinned: [GITHUB] } } }]);
  first.clock.tick(60_000);
  first.service.stop();
  const restored = setup(first.saved, first.clock);
  await restored.service.start();
  expect(restored.service.active()[0]!.expiresAt).toBe(NETWORK_TTL_MS);
  restored.clock.tick(NETWORK_TTL_MS - 60_000);
  expect(restored.service.effective("work", "sibling", restored.base).allow).not.toContainEqual(expect.objectContaining({ host: "api.github.com", port: 443 }));
  await settle();
  expect(restored.applied().allow).not.toContainEqual(expect.objectContaining({ host: "api.github.com", port: 443 }));
  expect(restored.service.active()).toEqual([]);
  restored.service.stop();
});

test("network requests: permanent (confirmed) and deny are distinct choices; a closed card never allows", async () => {
  for (const [presses, status] of [[[1, 0], "permanent"], [[2], "denied"], [[undefined], "unavailable"], [[1, undefined], "unavailable"]] as const) {
    const { service, cards, permanent } = setup();
    const result = service.request("work", "sibling", "api.github.com", reason);
    await settle(); // its domain screened, its card up
    for (const press of presses) cards[0]!.answer(press);
    expect((await result).status).toBe(status);
    expect(permanent).toEqual(status === "permanent" ? ["api.github.com:443"] : []);
    expect(service.active()).toEqual([]);
    service.stop();
  }
});

test('the card: "Allow forever" asks again on the same card, "Cancel" goes back, "Yes, forever" decides; others decide at once', () => {
  const card = networkCard("text", "api.github.com:443");
  expect(card.text).toBe("text");
  expect(card.view(card.start)).toEqual({ choices: NETWORK_CHOICES, text: "text" });
  const confirming = card.press(card.start, 1);
  expect(card.view(confirming)).toEqual({ choices: CONFIRM_CHOICES, text: "<b>Allow <code>api.github.com:443</code> for good?</b>\n\nEvery pet in the house can reach it until you remove it from the allowlist." });
  expect(CONFIRM_CHOICES).toEqual([["Yes, forever"], ["Cancel"]]);
  expect(card.press(confirming, 1)).toEqual(card.start);
  expect(card.press(confirming, 0)).toEqual({ step: "resolved", decision: "permanent" });
  expect(card.press(card.start, 0)).toEqual({ step: "resolved", decision: "temporary" });
  expect(card.press(card.start, 2)).toEqual({ step: "resolved", decision: "denied" });
  // A choice it does not show moves nothing.
  expect(card.press(card.start, 3)).toEqual(card.start);
  expect(card.press(confirming, 2)).toEqual(confirming);
  expect([0, 2].map((index) => card.view(card.press(card.start, index)))).toEqual([{ outcome: "Allow 15 min" }, { outcome: "Deny" }]);
  expect(card.view(card.press(confirming, 0))).toEqual({ outcome: "Allow forever" });
});

test('the wait runs on through the confirmation: a card left at "Allow forever?" times out and grants nothing', async () => {
  const { service, cards, clock, permanent } = setup();
  const result = service.request("work", "sibling", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  cards[0]!.answer(1);
  expect(cards[0]!.choices).toEqual(CONFIRM_CHOICES);
  clock.tick(1000);
  expect((await result).status).toBe("timeout");
  expect(cards[0]!.signal.aborted).toBe(true);
  cards[0]!.answer(0); // too late
  await settle();
  expect(permanent).toEqual([]);
  await service.stop();
});

test("a pet that leaves the config takes its grants and pending requests with it; a disabled one, still in it, keeps them", async () => {
  const { service, cards, saved, applied } = setup();
  const granted = service.request("work", "sibling", "api.github.com", reason);
  const housemate = service.request("work", "chair", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  cards[0]!.answer(0);
  cards[1]!.answer(0);
  await Promise.all([granted, housemate]);
  const pending = service.request("work", "sibling", "github.com", reason);
  await settle(); // its domain screened, its card up
  service.setPets([{ house: "work", pet: "sibling" }, { house: "work", pet: "chair" }]);
  expect(service.active().map(({ pet }) => pet)).toEqual(["sibling", "chair"]);
  expect(cards[2]!.signal.aborted).toBe(false);
  service.setPets([{ house: "work", pet: "chair" }]);
  expect(service.active().map(({ pet }) => pet)).toEqual(["chair"]);
  expect(JSON.parse(saved.get("network.temporary-grants.v1")!).map(({ pet }: { pet: string }) => pet)).toEqual(["chair"]);
  expect(cards[2]!.signal.aborted).toBe(true);
  expect((await pending).status).toBe("cancelled");
  // Applying the policy is the reload's; then the gateway has the grant no more.
  expect(service.petGrants("work").map(({ pet }) => pet)).toEqual(["chair"]);
  expect(applied().allow).toContainEqual(expect.objectContaining({ host: "api.github.com" }));
  await service.stop();
});

test("network requests: reject widening syntax, local names, control characters, tags and missing explanations before posting", async () => {
  const { service, cards } = setup();
  for (const domain of ["*", "*.github.com", "https://github.com", "github.com:443", "127.0.0.1", "0x7f000001", "[::1]", "localhost", "box.local", "box.internal", "bad-.com", "-bad.com", "github.com.", "github\n.com"]) {
    expect(() => requestDomain(domain)).toThrow();
  }
  for (const explanation of ["", "  ", "x".repeat(601), "what\nwhy", "bad\u0000reason", "<household-message>"]) {
    await expect(service.request("work", "sibling", "github.com", explanation)).rejects.toThrow();
  }
  expect(cards).toEqual([]);
  service.stop();
});

test("network requests: duplicate waits share one card; bounded requests, cancellation, timeout and pet removal fail closed", async () => {
  const { service, cards, clock, removePet } = setup();
  const controller = new AbortController();
  const first = service.request("work", "sibling", "api.github.com", reason);
  const duplicate = service.request("work", "sibling", "api.github.com", reason, 443, controller.signal);
  await settle(); // its domain screened, its card up
  expect(cards).toHaveLength(1);
  expect((await service.request("work", "sibling", "api.github.com", "another reason")).status).toBe("busy");
  // A housemate's request is its own: it would get its own grant, so it asks on its own card.
  const housemate = service.request("work", "chair", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  expect(cards).toHaveLength(2);
  cards[1]!.answer(2);
  expect((await housemate).status).toBe("denied");
  controller.abort();
  expect((await first).status).toBe("cancelled");
  expect((await duplicate).status).toBe("cancelled");
  cards[0]!.answer(0); // A late press cannot resurrect the cancelled request.
  await settle();
  expect(service.active()).toEqual([]);
  const pending = ["a.github.com", "b.github.com", "c.github.com"].map((domain) => service.request("work", "sibling", domain, reason));
  expect((await service.request("work", "sibling", "d.github.com", reason)).status).toBe("busy");
  await settle();
  clock.tick(1000);
  expect((await Promise.all(pending)).map(({ status }) => status)).toEqual(["timeout", "timeout", "timeout"]);
  const removed = service.request("work", "sibling", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  removePet();
  cards.at(-1)!.answer(0);
  expect((await removed).status).toBe("unavailable");
  expect(service.active()).toEqual([]);
  service.stop();
});

test("network requests: already allowed domains need no card, apply failures roll back, and expiry retries revocation", async () => {
  const env = setup();
  expect((await env.service.request("work", "sibling", "api.anthropic.com", reason)).status).toBe("already-allowed");
  expect(env.cards).toEqual([]);
  env.failApply(true);
  const failed = env.service.request("work", "sibling", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  env.cards[0]!.answer(0);
  expect((await failed).status).toBe("failed");
  expect(env.service.active()).toEqual([]);
  env.failApply(false);
  const allowed = env.service.request("work", "sibling", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  env.cards[1]!.answer(0);
  await allowed;
  env.failApply(true);
  env.clock.tick(NETWORK_TTL_MS);
  await settle();
  const beforeRetry = env.applications();
  env.failApply(false);
  env.clock.tick(1000);
  await settle();
  expect(env.applications()).toBeGreaterThan(beforeRetry);
  expect(env.applied().allow).not.toContainEqual(expect.objectContaining({ host: "api.github.com", port: 443 }));
  env.service.stop();
});

test("a saved permanent approval reports pending on application failure, and shutdown drains a save without applying late policy", async () => {
  const failed = setup();
  failed.failApply(true);
  const pending = failed.service.request("work", "sibling", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  failed.cards[0]!.answer(1);
  failed.cards[0]!.answer(0);
  expect(await pending).toMatchObject({ status: "permanent-pending", message: expect.stringContaining("saved") });
  expect(failed.permanent).toEqual(["api.github.com:443"]);
  await failed.service.stop();

  const gate = Promise.withResolvers<void>();
  const selected = Promise.withResolvers<NetworkStep | undefined>();
  let saving = false;
  let applied = false;
  let stopped = false;
  const service = new NetworkRequests({
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    policy: () => ({ kind: "allowlist", allow: [] }), petTitle: () => "Sibling",
    screen: async () => ({ address: GITHUB, addresses: [GITHUB] }), notice: async () => {},
    choose: async () => selected.promise,
    permanent: async () => { saving = true; await gate.promise; },
    changed: async () => { applied = true; },
  });
  const request = service.request("work", "sibling", "api.github.com", reason);
  selected.resolve({ step: "resolved", decision: "permanent" });
  await settle();
  expect(saving).toBe(true);
  const stopping = service.stop().then(() => { stopped = true; });
  await settle();
  expect(stopped).toBe(false);
  gate.resolve();
  expect((await request).status).toBe("permanent-pending");
  await stopping;
  expect(stopped).toBe(true);
  expect(applied).toBe(false);
});

test("a persistence failure at expiry retries rather than leaving an unhandled timer rejection", async () => {
  const clock = fakeClock();
  let broken = false;
  let choice: ((step: NetworkStep) => void) | undefined;
  let applied = 0;
  const service = new NetworkRequests({
    store: { get: () => undefined, set: () => { if (broken) throw new Error("disk unavailable"); }, delete: () => {} },
    policy: () => ({ kind: "allowlist", allow: [] }), petTitle: () => "Sibling", clock,
    screen: async () => ({ address: GITHUB, addresses: [GITHUB] }), notice: async () => {},
    choose: () => new Promise((resolve) => { choice = resolve; }), permanent: async () => {},
    changed: async () => { applied++; },
  });
  const request = service.request("work", "sibling", "api.github.com", reason);
  await settle(); // its domain screened, its card up
  choice!({ step: "resolved", decision: "temporary" });
  await request;
  broken = true;
  clock.tick(NETWORK_TTL_MS);
  await settle();
  expect(service.active()).toEqual([]);
  const before = applied;
  broken = false;
  clock.tick(1000);
  await settle();
  expect(applied).toBeGreaterThan(before);
  await service.stop();
});

test("endpoint approvals keep pending cards, grants and revocation isolated by port", async () => {
  const env = setup();
  const https = env.service.request("work", "sibling", "github.com", reason);
  const ssh = env.service.request("work", "sibling", "github.com", reason, 22);
  await settle(); // its domain screened, its card up
  expect(env.cards).toHaveLength(2);
  expect(env.cards[0]!.text).toContain("wants to reach <code>github.com</code></b>");
  expect(env.cards[1]!.text).toContain("wants to reach <code>github.com:22</code></b>");
  expect(env.cards[1]!.choices).toEqual(NETWORK_CHOICES);
  env.cards[0]!.answer(0);
  env.cards[1]!.answer(0);
  expect((await https).port).toBe(443);
  expect((await ssh).port).toBe(22);
  expect(env.service.active().map(({ port }) => port)).toEqual([443, 22]);
  expect((await env.service.request("work", "sibling", "github.com", reason, 22)).status).toBe("already-allowed");
  const third = env.service.request("work", "sibling", "github.com", reason, 8443);
  await settle(); // its domain screened, its card up
  expect(env.cards).toHaveLength(3);
  env.cards[2]!.answer(2);
  expect((await third).status).toBe("denied");
  await env.service.revoke("work", "chair", "github.com", 22); // not chair's: nothing goes
  expect(env.service.active().map(({ port }) => port)).toEqual([443, 22]);
  await env.service.revoke("work", "sibling", "github.com", 22);
  expect(env.service.active().map(({ port }) => port)).toEqual([443]);
  expect(env.applied().allow).not.toContainEqual(expect.objectContaining({ host: "github.com", port: 22 }));
  expect(env.applied().allow).toContainEqual(expect.objectContaining({ host: "github.com", port: 443 }));
  await env.service.revoke("work", "sibling", "github.com");
  expect(env.service.active()).toEqual([]);
  await env.service.stop();
});

test("port validation and durable state preserve legacy443 without accepting malformed endpoints", async () => {
  const env = setup();
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, "22", null, true]) {
    expect(() => requestPort(port)).toThrow();
    await expect(env.service.request("work", "sibling", "github.com", reason, port as number)).rejects.toThrow();
  }
  expect(env.cards).toEqual([]);
  expect(requestPort()).toBe(443);
  expect(requestPort(1)).toBe(1);
  expect(requestPort(65535)).toBe(65535);
  const grant = { house: "work", pet: "sibling", domain: "github.com", addresses: [GITHUB], reason, expiresAt: NETWORK_TTL_MS };
  const saved = new Map([["network.temporary-grants.v1", JSON.stringify([
    grant, { ...grant, port: 22 }, { ...grant, port: "22" }, { ...grant, port: null },
    { ...grant, port: 0 }, { ...grant, port: 65536 }, { ...grant, domain: "127.0.0.1", port: 22 },
    // Never restored: without the addresses it was screened at, or pinned off the public internet.
    { ...grant, port: 8443, addresses: undefined }, { ...grant, port: 8443, addresses: [] }, { ...grant, port: 8443, addresses: ["127.0.0.1"] },
    { ...grant, port: 8443, addresses: ["2606:4700::1111"] },
  ])]]);
  const restored = setup(saved, env.clock);
  await restored.service.start();
  expect(restored.service.active().map(({ port }) => port)).toEqual([443, 22]);
  expect(JSON.parse(saved.get("network.temporary-grants.v1")!).map(({ port }: { port: number }) => port)).toEqual([443, 22]);
  restored.clock.tick(NETWORK_TTL_MS);
  await settle();
  expect(restored.service.active()).toEqual([]);
  expect(restored.applied().allow).not.toContainEqual(expect.objectContaining({ host: "github.com" }));
  await restored.service.stop();
  await env.service.stop();
});

test("permanent non443 approval saves only its exact endpoint", async () => {
  const env = setup();
  const pending = env.service.request("work", "sibling", "github.com", reason, 22);
  await settle(); // its domain screened, its card up
  env.cards[0]!.answer(1);
  env.cards[0]!.answer(0);
  expect(await pending).toEqual({ domain: "github.com", port: 22, status: "permanent" });
  expect(env.permanent).toEqual(["github.com:22"]);
  expect(env.applied().allow).toContainEqual({ host: "github.com", port: 22 });
  expect(env.applied().allow).not.toContainEqual({ host: "github.com", port: 443 });
  await env.service.stop();
});

test("a domain that resolves off the public internet is refused without a card, and its owner is told", async () => {
  const env = setup();
  const result = await env.service.request("work", "sibling", "localtest.me", reason, 8080);
  expect(result).toMatchObject({ domain: "localtest.me", port: 8080, status: "refused" });
  expect(result.message).toContain("not on the public internet");
  expect(result.message).not.toContain("127.0.0.1");
  expect(env.cards).toEqual([]);
  expect(env.notices).toEqual([expect.stringContaining("Denied 🐾 Sibling access to localtest.me:8080: it points to a private address (127.0.0.1)")]);
  expect(env.service.active()).toEqual([]);
  expect(env.permanent).toEqual([]);
  expect(await env.service.request("work", "sibling", "nowhere.example.org", reason)).toMatchObject({ status: "unresolvable" });
  expect(env.cards).toEqual([]);
  expect(env.screened).toEqual(["localtest.me", "nowhere.example.org"]);
  await env.service.stop();
});


test("closed scouts never resolve requested domains before owner Allow, including Deny and timeout", async () => {
  for (const choice of ["deny", "timeout", "cancel"] as const) {
    const env=setup(new Map(),fakeClock(),true);
    const result=env.service.request("work","scout-1","unapproved-secret.evil.com",reason);
    await settle();
    expect(env.screened).toEqual([]); expect(env.cards).toHaveLength(1);
    expect(env.cards[0]!.text).toContain("Resolves: checked only after you allow it");
    expect(env.cards[0]!.text).not.toContain(GITHUB);
    if(choice==="deny")env.cards[0]!.answer(1); // a scout's card: Allow 15 min · Deny
    else if(choice==="timeout")env.clock.tick(1000);
    else env.service.setPets([]);
    expect((await result).status).toBe(choice==="deny"?"denied":choice==="timeout"?"timeout":"cancelled");
    expect(env.screened).toEqual([]); expect(env.service.active()).toEqual([]);
    await env.service.stop();
  }
});

test("scout Allow screens afterwards, pins only public addresses and scopes the grant to its run", async () => {
  const env=setup(new Map(),fakeClock(),true);
  const pending=env.service.request("work","scout-1","api.github.com",reason,8443);
  await settle();expect(env.screened).toEqual([]);
  env.cards[0]!.answer(0);
  expect(await pending).toMatchObject({status:"temporary",port:8443});
  expect(env.screened).toEqual(["api.github.com"]);
  expect(env.service.petGrants("work")).toEqual([{pet:"scout-1",entry:{host:"api.github.com",port:8443,expiresAt:NETWORK_TTL_MS,reach:{pinned:[GITHUB]}}}]);
  expect(env.service.list("work","scout-2").temporary).toEqual([]);
  expect(env.service.list("work","parent").temporary).toEqual([]);
  await env.service.stop();
});

test("scout private or failed DNS after approval never becomes a grant", async () => {
  for(const [domain,status] of [["localtest.me","refused"],["nowhere.example.org","unresolvable"]] as const){
    const env=setup(new Map(),fakeClock(),true);
    const pending=env.service.request("work","scout-1",domain,reason);
    await settle();expect(env.screened).toEqual([]);
    expect(env.cards[0]!.text).toContain("For: this run of the scout only");
    env.cards[0]!.answer(0);
    expect((await pending).status).toBe(status);
    expect(env.screened).toEqual([domain]);expect(env.permanent).toEqual([]);expect(env.service.active()).toEqual([]);
    if(status==="refused")expect(env.notices).toContain("Access refused: the approved domain resolves to a non-public address.");
    await env.service.stop();
  }
});

test("a scout's card has no forever: its network is its capabilities', a grant lasts for the run", async () => {
  const env=setup(new Map(),fakeClock(),true);
  const pending=env.service.request("work","scout-1","db.example.com",reason,5432);
  await settle();
  const card=networkCard("text","db.example.com:5432",true);
  expect((card.view(card.start) as {choices:string[][]}).choices).toEqual([["Allow 15 min"],["Deny"]]);
  env.cards[0]!.answer(0);
  expect(await pending).toMatchObject({domain:"db.example.com",port:5432,status:"temporary"});
  expect(env.permanent).toEqual([]);
  await env.service.stop();
});
