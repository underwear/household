import { GoogleConnectors } from "../../src/app/google-connectors";
import { googleConnectorRoutes } from "../../src/app/google-connector-routes";
import { HouseInboxes } from "../../src/app/house-inboxes";
import { Sideworkers } from "../../src/app/sideworkers";
import { PetInstructions } from "../../src/infra/pet-instructions";
import { PetMemory } from "../../src/app/memory";
import { Crons } from "../../src/app/crons";
import { HouseSkills, PetSkills } from "../../src/infra/house-skills";
import { petEnvironment, type PetEnvironment } from "../../src/app/environment";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knownAgents } from "../../src/app/agents";
import { channelChecks } from "../../src/app/channel-fields";
import { configCheck, knownChannelKinds, knownPlatforms } from "../../src/app/kinds";
import { slack, slackPrivate } from "../../src/channel-adapters/slack";
import { telegram, telegramPrivate, telegramDm, telegramGroup } from "../../src/channel-adapters/telegram";
import { WebAuth } from "../../src/app/web-auth";
import { webRoutes, withoutPaths, type WebRoutesDeps } from "../../src/app/web-routes";
import type { HouseView, KeysView, KeyView, WriteView } from "../../src/app/web-views";
import { ConfigStore } from "../../src/infra/config-store";
import { EventLog } from "../../src/infra/event-log";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { serveWeb, type WebAssets } from "../../src/infra/web-server";
import { fakeTelegram } from "../fake-telegram";
import { tempDir } from "../helpers";

const encode = (text: string) => new TextEncoder().encode(text);
const ASSETS: WebAssets = new Map([
  ["/index.html", { body: encode("<!doctype html><title>Household</title>"), type: "text/html;charset=utf-8" }],
  ["/chunk-abc.js", { body: encode("console.log(1)"), type: "text/javascript;charset=utf-8" }],
]);

const servers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

/** Bot tokens the fake Bot API knows (bots 4242 and 4343), and one it does not. */
const BOT = `4242:${"A".repeat(35)}`;
const BOT_NEW = `4242:${"B".repeat(35)}`;
const OTHER_BOT = `4343:${"C".repeat(35)}`;
const UNKNOWN_BOT = `4444:${"D".repeat(35)}`;
const KEY = "sk-ant-oat01-web-routes-test-key";
/** The machine the routes and the config check weigh pets against: 8 CPUs, 16 GiB. */
const HOST = { cpus: 8, memoryMiB: 16384 };

const CONFIG =
  `# my household\nkeys:\n  claude: {provider: anthropic, value: ${KEY}}\nhouses:\n  work: # the rich house\n    network:\n      allow: [github.com] # keep me\n    pets:\n      sibling:\n        key: claude\n` +
  `    people: {owners: {telegram: [100200300]}}\n    channels:\n      - {kind: telegram-private, name: DM, token: "${BOT}", chat: 100200300, pets: [sibling]}\n`;

function setup(config = CONFIG, networkRequests?: WebRoutesDeps["networkRequests"], modelCatalog?: WebRoutesDeps["modelCatalog"], environment?: (store: ConfigStore) => PetEnvironment, terminalSnapshot?: WebRoutesDeps["terminalSnapshot"], crons?: Crons, memory?: PetMemory, monitoring?: WebRoutesDeps["monitoring"], sideworkers?: WebRoutesDeps["sideworkers"]) {
  const dir = tempDir();
  const telegram = fakeTelegram(BOT, BOT_NEW, OTHER_BOT);
  servers.push({ stop: async () => telegram.stop() });
  const configFile = join(dir, "household.yaml");
  writeFileSync(configFile, config);
  const auth = new WebAuth(new SqliteStore(":memory:"));
  const applied: string[] = [];
  const logged: string[] = [];
  const added: string[] = [];
  let applyError: Error | undefined;
  let statesError: Error | undefined;
  const store = new ConfigStore(configFile, configCheck(knownAgents(), HOST));
  const inboxPosts: string[] = [];
  const inboxPets: string[] = [];
  const houseInboxes = new HouseInboxes(new SqliteStore(":memory:"), { post: async (_h, _i, event) => { inboxPosts.push(event.title); }, pet: (_h, _i, pet) => { inboxPets.push(pet); } });
  const connectors = new GoogleConnectors(new SqliteStore(":memory:"), { id: "test", secret: "test" });
  const problems = new Map<string, string>();
  const server = serveWeb({
    port: 0,
    assets: ASSETS,
    handle: webRoutes({
      connectorRoutes: googleConnectorRoutes(connectors),
      auth,
      houseInboxes,
      sideworkers,
      monitoring,
      crons,
      memory,
      instructions: new PetInstructions(join(dir, "homes")),
      skills: new HouseSkills(join(dir, "house-skills")),
      petSkills: new PetSkills(join(dir, "homes")),
      skillAdded: (house, pet, name) => added.push(`${house}/${pet ?? "*"}:${name}`),
      networkRequests,
      modelCatalog,
      terminalSnapshot,
      environment: environment?.(store),
      config: store,
      agents: knownAgents(),
      channelKinds: knownChannelKinds(),
      platforms: knownPlatforms(),
      checks: channelChecks(telegram.url),
      apply: async () => {
        applied.push("reload");
        houseInboxes.setHouses((await store.load()).houses);
        if (applyError) throw applyError;
      },
      petStates: async () => {
        if (statesError) throw statesError;
        return [{ house: "work", pet: "sibling", agent: "claude-code-tmux", container: "household.work.sibling", state: "running" }];
      },
      channelProblem: (house, key) => problems.get(`${house}/${key}`),
      state: () => "running",
      version: "0.1.0",
      events: new EventLog(join(dir, "events.jsonl"), (line) => logged.push(line)),
      host: HOST,
    }),
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const name = `household_session_${server.port}`;
  let session = "";
  const cookie = () => `household_session_1=other; ${name}=${session}`;
  /** A request as the UI makes it: right Host (fetch sets it), this origin, the session cookie once signed in. */
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + path, {
      method,
      redirect: "manual",
      headers: { origin, ...(session ? { cookie: cookie() } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const signIn = async () => {
    houseInboxes.setHouses((await store.load()).houses);
    connectors.setHouses((await store.load()).houses);
    const response = await call("GET", `/login?token=${auth.mintToken()}`);
    session = new RegExp(`${name}=([^;]+)`).exec(response.headers.get("set-cookie") ?? "")![1]!;
    return response;
  };
  const text = () => Bun.file(configFile).text();
  return {
    auth, origin, name, call, signIn, text, applied, logged, cookie, configFile, store, telegram, dir, added,
    problems, inboxPosts, inboxPets, houseInboxes,
    failApply: (error: Error) => (applyError = error),
    failStates: (error: Error) => (statesError = error),
  };
}

test("signing in: the link sets this port's session cookie and sends the browser to /, without the token; a used link fails", async () => {
  const { auth, call, name } = setup();
  const token = auth.mintToken();
  const response = await call("GET", `/login?token=${token}`);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${name}=[\\w-]{43}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800$`));
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");

  const again = await call("GET", `/login?token=${token}`);
  expect(again.headers.get("location")).toBe("/?signin=failed");
  expect(again.headers.get("set-cookie")).toBeNull();
});

test("many failed sign-ins do not lock the owner out", async () => {
  const { auth, call } = setup();
  for (let i = 0; i < 20; i++) expect((await call("GET", `/login?token=wrong${i}`)).headers.get("location")).toBe("/?signin=failed");
  expect((await call("GET", `/login?token=${auth.mintToken()}`)).headers.get("location")).toBe("/");
});

test("without a session: the page (the sign-in screen) and its files, but /api answers 401; every answer has the security headers", async () => {
  const { call } = setup();
  for (const path of ["/", "/houses/work", "/chunk-abc.js"]) {
    const response = await call("GET", path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect(await (await call("GET", "/houses/work")).text()).toContain("<title>Household</title>");
  for (const [method, path] of [["GET", "/api/me"], ["GET", "/api/houses"], ["POST", "/api/houses"], ["DELETE", "/api/houses/work"]] as const) {
    const response = await call(method, path, method === "POST" ? { name: "lab" } : undefined);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not signed in: run `house dashboard`" });
  }
});

test("another port's cookie of the same session id is not this one's", async () => {
  const { call, signIn, origin, cookie } = setup();
  await signIn();
  const theirs = cookie().replace(/household_session_\d+=/g, "household_session_1=");
  expect((await fetch(`${origin}/api/me`, { headers: { cookie: theirs } })).status).toBe(401);
  expect((await call("GET", "/api/me")).status).toBe(200);
});

test("a request naming another host (DNS rebinding, a container's host.docker.internal) is refused, signed in or not", async () => {
  const { call, signIn, origin } = setup();
  await signIn();
  const port = new URL(origin).port;
  for (const host of ["evil.example", `evil.example:${port}`, `host.docker.internal:${port}`, "127.0.0.1:1"]) {
    expect((await call("GET", "/api/houses", undefined, { host })).status).toBe(421);
    expect((await call("GET", "/", undefined, { host })).status).toBe(421);
  }
  expect((await call("GET", "/", undefined, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).toBe(200);
});

test("a write must come from this origin: none or another is refused before anything changes", async () => {
  const { call, signIn, text, applied, origin, cookie } = setup();
  await signIn();
  const before = await text();
  expect((await call("POST", "/api/houses", { name: "lab" }, { origin: "http://evil.example" })).status).toBe(403);
  expect((await call("POST", "/api/houses", { name: "lab" }, { origin: "http://localhost:1" })).status).toBe(403);
  expect((await fetch(`${origin}/api/houses/work`, { method: "DELETE", headers: { cookie: cookie() } })).status).toBe(403);
  expect(await text()).toBe(before);
  expect(applied).toEqual([]);
});

test("sign-out ends the session", async () => {
  const { call, signIn, name } = setup();
  await signIn();
  expect((await call("GET", "/api/me")).status).toBe(200);
  const out = await call("POST", "/api/logout");
  expect(out.status).toBe(204);
  expect(out.headers.get("set-cookie")).toStartWith(`${name}=; `);
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await call("GET", "/api/me")).status).toBe(401);
});

test("houses: list and one, with the hosts their pets' agents add; me", async () => {
  const { call, signIn } = setup();
  await signIn();
  expect(await (await call("GET", "/api/me")).json()).toEqual({
    version: "0.1.0",
    state: "running",
    // Its permission modes as claude calls them, bypass by default.
    agents: expect.arrayContaining([{ name: "claude-code-tmux", terminal: true, dynamicModels: false, modelOptions: expect.any(Array), models: ["opus", "sonnet", "haiku", "fable"], defaultModel: "opus", modes: [{ id: "auto", label: "Auto" }, { id: "manual", label: "Manual" }, { id: "acceptEdits", label: "Accept edits" }, { id: "plan", label: "Plan" }, { id: "bypassPermissions", label: "Bypass permissions" }, { id: "dontAsk", label: "Don't ask" }], defaultMode: "bypassPermissions", settings: [expect.objectContaining({ key: "claudeAiConnectors", checkbox: true, petOnly: true, defaultLabel: "disabled" }), { key: "subagentModel", label: "Subagent model", description: expect.any(String), options: [{ id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet" }, { id: "haiku", label: "haiku" }, { id: "fable", label: "fable" }], defaultLabel: "the bot's own model" }], providers: ["anthropic"] }]),
    channelKinds: [telegramPrivate, telegramDm, telegramGroup, slackPrivate], // the kinds, with their own fields, as their adapters describe them
    platforms: [telegram, slack].map(({ valid: _valid, ...spec }) => spec), // its check stays on the server
    providers: ["anthropic", "openai"],
    noteMax: 200,
    host: HOST, // the most one pet may be given
  });
  expect(telegramPrivate).toMatchObject({ platform: "telegram", audience: "private", chat: { key: "chat" }, fields: [{ key: "token", mono: true, wide: true }] });
  const work: HouseView = {
    name: "work",
    features: { preview: false, sideworkers: true, scouts: false },
    preview: { bindAddress: "127.0.0.1", publicHost: "127.0.0.1" },
    resources: expect.any(Object), sideworkerLimits: { cpus: 2, memoryMiB: 1024 },
    sideworkerProfiles: [],
    allow: [
      { host: "github.com", byAgent: false },
      { host: "api.anthropic.com", byAgent: true },
    ],
    owners: [{ platform: "telegram", id: "100200300", note: null, problem: null }],
    channels: [
      // Its token in full (the owner's own screen), and what it is: its bot (its id until Telegram has said its @username).
      { kind: "telegram-private", platform: "telegram", label: "Telegram Bot DM (threaded)", name: "DM", ownName: "DM", note: null, fields: { token: BOT }, shown: { token: expect.stringMatching(/^(bot 4242|@fake_bot)$/) as never }, chat: "100200300", pets: ["sibling"], default: "sibling", problem: null },
    ],
    pets: [{ name: "sibling", cpus: 2, memoryMiB: 1024, enabled: true, title: "Sibling", ownTitle: null, display: "🤖 Sibling", emoji: "🤖", ownEmoji: null, aliases: [], agent: "claude-code-tmux", model: "opus", reasoningEffort: null, settings: {}, lifecycle: null, mode: "bypassPermissions", key: "claude", problem: null, state: "running" }],
  };
  const list = await call("GET", "/api/houses");
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(await list.json()).toEqual([work]);
  expect(await (await call("GET", "/api/houses/work")).json()).toEqual(work);
  const unknown = await call("GET", "/api/houses/home");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "unknown house 'home'" });
});

test("create a house, add and remove hosts, delete it: in household.yaml with its comments, each reloaded", async () => {
  const { call, signIn, text, applied, store } = setup();
  await signIn();
  const created = await call("POST", "/api/houses", { name: "lab" });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ house: { name: "lab", features: { preview: false, sideworkers: true, scouts: false }, preview: { bindAddress: "127.0.0.1", publicHost: "127.0.0.1" }, resources: expect.any(Object), sideworkerLimits: { cpus: 2, memoryMiB: 1024 }, sideworkerProfiles: [], allow: [], owners: [], channels: [], pets: [] } } satisfies WriteView);
  expect(applied).toEqual(["reload"]);

  const added = await call("POST", "/api/houses/work/allow", { host: "db.internal:5432" });
  expect(((await added.json()) as WriteView).house!.allow.map((entry) => entry.host)).toEqual(["github.com", "db.internal:5432", "api.anthropic.com"]);
  // Another editor (the CLI) adds a host meanwhile: a tab that still shows the old list removes one host, not that one.
  await store.allowHost("work", "pypi.org");
  const removed = await call("DELETE", `/api/houses/work/allow/${encodeURIComponent("db.internal:5432")}`);
  expect(((await removed.json()) as WriteView).house!.allow.map((entry) => entry.host)).toEqual(["github.com", "pypi.org", "api.anthropic.com"]);

  await call("POST", "/api/houses/work/allow", { host: "example.org" });
  const yaml = await text();
  expect(yaml).toStartWith("# my household\nkeys:\n");
  expect(yaml).toContain("# the rich house"); // the yaml library moves it below its key
  expect(yaml).toContain("allow: [ github.com, pypi.org, example.org ] # keep me");

  const deleted = await call("DELETE", "/api/houses/lab");
  expect(await deleted.json()).toEqual({});
  expect(await text()).not.toContain("lab");
  expect(applied).toHaveLength(5);
});

test("invalid input is a 400 with the reason, an unknown house or a bad URI a 404; nothing is written or reloaded", async () => {
  const { call, signIn, text, applied } = setup();
  await signIn();
  const before = await text();
  const cases: [string, string, unknown, number, string][] = [
    ["POST", "/api/houses", { name: "Lab" }, 400, "invalid workspace name 'Lab'"],
    ["POST", "/api/houses", { name: "work" }, 400, "workspace 'work' already exists"],
    ["POST", "/api/houses", { name: 7 }, 400, "expected string"],
    ["POST", "/api/houses", "{not json", 400, "the body must be JSON"],
    ["POST", "/api/houses/work/allow", { host: "a b" }, 400, "'a b' is not host or host:port (wildcards: *.example.com, * for any public host, *:* on any port)"],
    ["POST", "/api/houses/home/allow", { host: "example.com" }, 404, "unknown workspace 'home'"],
    ["PATCH", "/api/houses/work", { telegram: null }, 405, "method not allowed"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT, chat: "12", pets: ["nobody"] }, 400, "'nobody' is not a bot of workspace work"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-group", token: BOT, chat: "12" }, 400, "must be a Telegram supergroup id"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT, chat: "12", phone: "+34600000000" }, 400, "a Telegram Bot DM (threaded) channel has no field 'phone' (its fields: token)"], // another kind's
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", chat: "12" }, 400, "Bot token is required"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: "telegram-work", chat: "12" }, 400, "that is not a bot token: one looks like 123456789:AAH4x… (from @BotFather)"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: UNKNOWN_BOT, chat: "12" }, 400, "Telegram does not know this bot token (revoked, or mistyped?)"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT, chat: "12", pets: "sibling" }, 400, "expected array"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT, chat: "100200300" }, 400, "the same chat as an earlier channel"],
    ["PATCH", "/api/houses/work/channels/1", { name: "x" }, 404, "workspace 'work' has no channel of chat '1'"],
    ["PATCH", "/api/houses/work/channels/100200300", { chat: "1" }, 400, "a channel's chat names it"], // another chat is another channel, by the schema
    ["PATCH", "/api/houses/work/channels/%20100200300%20", { phone: "1" }, 400, "has no field 'phone'"], // found by its trimmed chat
    ["PATCH", "/api/houses/home/channels/1", { token: UNKNOWN_BOT }, 404, "unknown workspace 'home'"], // before the token is looked at
    ["POST", "/api/houses/home/channels", { kind: "telegram-private", token: UNKNOWN_BOT, chat: "1" }, 404, "unknown workspace 'home'"],
    ["PATCH", "/api/houses/work/channels/777", { token: BOT }, 404, "workspace 'work' has no channel of chat '777'"],
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT }, 400, "chat"],
    ["PATCH", "/api/houses/work/channels/100200300", { phone: "1" }, 400, "a Telegram Bot DM (threaded) channel has no field 'phone'"],
    ["PATCH", "/api/houses/work/channels/100200300", { token: " " }, 400, "Bot token is required"],
    ["POST", "/api/keys", { name: "gpt", provider: "mistral", value: "x" }, 400, "unknown provider 'mistral' (known: anthropic, openai)"],
    ["POST", "/api/keys", { name: "claude", provider: "anthropic", value: "x" }, 400, "key 'claude' already exists"],
    ["POST", "/api/keys", { name: "spaced", provider: "anthropic", value: "a b" }, 400, "printable ASCII without spaces"],
    ["PATCH", "/api/keys/nope", { note: "x" }, 404, "unknown key 'nope'"],
    ["DELETE", "/api/keys/claude", undefined, 400, "key 'claude' is in use by work/sibling: give it another key first"], // one check, the store's
    ["POST", "/api/houses/work/pets", { name: "chair", key: "nope" }, 400, "bot work/chair: unknown key 'nope' (one of: claude)"],
    ["POST", "/api/houses/work/pets", { name: "chair" }, 400, "bot work/chair: no key: name the key it runs on (key:; one of: claude)"], // always named
    ["POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT, chat: "abc" }, 400, "must be a Telegram chat id"],
    ["DELETE", "/api/houses/work/owners/telegram/100200300", undefined, 400, "a house with telegram channels needs an owner on telegram"],
    ["POST", "/api/houses/work/owners", { platform: "telegram", id: " " }, 400, "is not a person's id"],
    ["POST", "/api/houses/work/owners", { platform: "telegram", id: "@oleg" }, 400, "'@oleg' is not a Telegram user id (A number; @userinfobot tells yours.)"], // the platform's check
    ["POST", "/api/houses/work/owners", { platform: "telegram", id: "9007199254740992" }, 400, "is not a Telegram user id"], // past 2^53 - 1
    ["POST", "/api/houses/work/owners", { platform: "Telegram", id: "1" }, 400, "unknown platform 'Telegram' (known: telegram, slack)"],
    ["POST", "/api/houses/work/owners", { id: "7" }, 400, "platform"],
    ["POST", "/api/houses/work/pets", { name: "Chair" }, 400, "invalid bot name 'Chair'"],
    ["POST", "/api/houses/work/pets", { name: "sibling" }, 400, "bot 'sibling' already exists"],
    ["POST", "/api/houses/work/pets", { name: "chair", model: "gpt-9" }, 400, "unknown model 'gpt-9' for harness claude-code-tmux (its models: opus, sonnet, haiku, fable)"],
    ["POST", "/api/houses/work/pets", { name: "chair", agent: "codex" }, 400, "unknown harness 'codex'"],
    ["POST", "/api/houses/work/pets", { name: "chair", key: "claude", mode: "yolo" }, 400, "unknown mode 'yolo' for harness claude-code-tmux (its modes: auto, manual, acceptEdits, plan, bypassPermissions, dontAsk)"],
    ["PATCH", "/api/houses/work/pets/sibling", { aliases: ["a, b"] }, 400, "an alias has no , : or line break"],
    ["PATCH", "/api/houses/work/pets/sibling", { emoji: "🦉🦉" }, 400, "must be one emoji"],
    ["PATCH", "/api/houses/work/pets/nobody", { title: "X" }, 404, "workspace 'work' has no bot 'nobody'"],
    ["DELETE", "/api/houses/work/pets/nobody", undefined, 404, "workspace 'work' has no bot 'nobody'"],
    ["DELETE", "/api/houses/home", undefined, 404, "unknown workspace 'home'"],
    ["GET", "/api/houses/%E0%A4%A", undefined, 404, "not found"],
    ["DELETE", "/api/houses/work/allow/%E0%A4%A", undefined, 404, "not found"],
    ["PUT", "/api/houses/work", {}, 405, "method not allowed"],
    ["GET", "/api/nothing", undefined, 404, "not found"],
  ];
  for (const [method, path, body, status, error] of cases) {
    const response = await call(method, path, body);
    expect([method, path, response.status]).toEqual([method, path, status]);
    expect(((await response.json()) as { error: string }).error).toContain(error);
  }
  expect(await text()).toBe(before);
  expect(applied).toEqual([]);
});

test("error bodies carry no absolute paths; an unexpected failure is a generic 500, its details in the log", async () => {
  expect(withoutPaths("invalid config /Users/me/.config/household/household.yaml:\n✖ at houses.work")).toBe("invalid config household.yaml:\n✖ at houses.work");
  expect(withoutPaths("'db.internal:5432' and http://127.0.0.1:8780/login stay")).toBe("'db.internal:5432' and http://127.0.0.1:8780/login stay");

  const { call, signIn, configFile } = setup();
  await signIn();
  writeFileSync(configFile, "houses:\n  work:\n    netwrok: {}\n");
  const invalid = await call("GET", "/api/houses");
  expect(invalid.status).toBe(400);
  const { error } = (await invalid.json()) as { error: string };
  expect(error).toStartWith("invalid config household.yaml:");
  expect(error).not.toContain(configFile);

  writeFileSync(configFile, CONFIG);
  const broken = setup();
  await broken.signIn();
  broken.failApply(new Error("docker exploded in /Users/me/secret-place"));
  const notApplied = await broken.call("POST", "/api/houses", { name: "lab" });
  expect(notApplied.status).toBe(500);
  expect(await notApplied.json()).toEqual({ error: "saved in household.yaml, but the daemon could not apply it: see its log" });
  expect(await broken.text()).toContain("lab:");
  expect(broken.logged.some((line) => line.includes("ERROR"))).toBe(false); // the reload logs its own failure

  broken.failStates(new Error("docker ps failed in /Users/me/secret-place"));
  const internal = await broken.call("GET", "/api/houses");
  expect(internal.status).toBe(500);
  expect(await internal.json()).toEqual({ error: "internal error: see the daemon's log" });
  expect(broken.logged.some((line) => line.includes("web: GET /api/houses failed: docker ps failed in /Users/me/secret-place"))).toBe(true);
});

test("channels, owners and pets: added, changed and removed in household.yaml (comments kept), each reloaded; a pet removed leaves its channels", async () => {
  const { call, signIn, text, applied, problems } = setup(CONFIG.replace("      sibling:\n", "      sibling: # the first\n"));
  await signIn();
  const house = async (response: Response) => ((await response.json()) as WriteView).house!;

  // Owners: one more, then it goes again.
  const oleg = { platform: "telegram" as const, id: "100200300", note: null, problem: null };
  expect((await house(await call("POST", "/api/houses/work/owners", { platform: "telegram", id: "777" }))).owners).toEqual([oleg, { platform: "telegram" as const, id: "777", note: null, problem: null }]);
  expect(await text()).toContain("{ owners: { telegram: [ 100200300, 777 ] } }"); // the flow style the file had
  const noted = await house(await call("PATCH", "/api/houses/work/owners/telegram/777", { note: " Vera " }));
  expect(noted.owners[1]).toEqual({ platform: "telegram", id: "777", note: "Vera", problem: null });
  expect((await call("PATCH", "/api/houses/work/owners/telegram/1", { note: "x" })).status).toBe(404);
  expect((await house(await call("POST", "/api/houses/work/owners", { platform: "telegram", id: "778", note: "test" }))).owners[2]).toMatchObject({ id: "778", note: "test" });
  await call("DELETE", "/api/houses/work/owners/telegram/778");
  expect((await house(await call("DELETE", "/api/houses/work/owners/telegram/777"))).owners).toEqual([oleg]);

  // Pets: added with its agent and model, changed.
  const added = await call("POST", "/api/houses/work/pets", { name: "chair", title: "Chair", aliases: ["Armchair"], agent: "claude-code-tmux", model: "sonnet", key: "claude" });
  expect(added.status).toBe(201);
  expect((await house(added)).pets[1]).toMatchObject({ name: "chair", title: "Chair", ownTitle: "Chair", aliases: ["Armchair"], model: "sonnet" });
  expect((await house(await call("PATCH", "/api/houses/work/pets/chair", { emoji: "🪑" }))).pets[1]).toMatchObject({ emoji: "🪑", ownEmoji: "🪑" });
  const changed = await house(await call("PATCH", "/api/houses/work/pets/chair", { title: null, emoji: null, aliases: [], model: "haiku" }));
  expect(changed.pets[1]).toMatchObject({ title: "Chair", ownTitle: null, display: "🤖 Chair", emoji: "🤖", ownEmoji: null, aliases: [], model: "haiku", problem: null });
  expect(changed.pets[0]).toMatchObject({ model: "opus" });

  // Channels: a second one with both pets (default required), changed, a problem shown.
  const channel = { kind: "telegram-private", token: OTHER_BOT, chat: "555", name: "Home", note: "test bot", pets: ["sibling", "chair"], default: "chair" };
  const two = await house(await call("POST", "/api/houses/work/channels", channel));
  expect(two.channels[1]).toEqual({ kind: "telegram-private", platform: "telegram", label: "Telegram Bot DM (threaded)", name: "Home", ownName: "Home", note: "test bot", fields: { token: OTHER_BOT }, shown: { token: "@fake_bot" }, chat: "555", pets: ["sibling", "chair"], default: "chair", problem: null });
  const noDefault = await call("POST", "/api/houses/work/channels", { ...channel, chat: "556", default: null });
  expect(((await noDefault.json()) as { error: string }).error).toContain("default is required when a channel has two bots or more");
  problems.set("work/telegram-private:555", "bot secret 'telegram-home' is missing or unreadable");
  const edited = await house(await call("PATCH", "/api/houses/work/channels/555", { name: null }));
  expect(edited.channels[1]).toMatchObject({ name: "Telegram Bot DM (threaded)", ownName: null, chat: "555", problem: "bot secret 'telegram-home' is missing or unreadable" });

  // Removing chair, the default of a channel that keeps one pet: it leaves that channel, sibling is its default now.
  const removed = await house(await call("DELETE", "/api/houses/work/pets/chair"));
  expect(removed.pets.map((pet) => pet.name)).toEqual(["sibling"]);
  expect(removed.channels[1]).toMatchObject({ pets: ["sibling"], default: "sibling" });
  expect((await house(await call("DELETE", "/api/houses/work/channels/555"))).channels).toHaveLength(1);

  const yaml = await text();
  expect(yaml).toStartWith("# my household\n");
  expect(yaml).toContain("# the first");
  expect(yaml).toContain("# keep me");
  expect(yaml).not.toContain("chair");
  expect(applied).toHaveLength(12); // every write but the refused ones
});

test("a pet that is the default of a channel keeping two pets or more is not removed: the owner picks another default", async () => {
  const config = CONFIG.replace("      sibling:\n        key: claude\n", "      sibling:\n        key: claude\n      chair: {key: claude}\n      desk: {key: claude}\n").replace("pets: [sibling]}", "pets: [sibling, chair, desk], default: chair}");
  const { call, signIn, text, applied } = setup(config);
  await signIn();
  const before = await text();
  const refused = await call("DELETE", "/api/houses/work/pets/chair");
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toBe("chair is the default of channel DM (chat 100200300), which has other bots: make another one its default first");
  expect(await text()).toBe(before);
  expect(applied).toEqual([]);
  // Not the default: it just leaves the channel.
  const removed = (await (await call("DELETE", "/api/houses/work/pets/desk")).json()) as WriteView;
  expect(removed.house!.channels[0]).toMatchObject({ pets: ["sibling", "chair"], default: "chair" });
});

test("a pet whose model was typed wrong in household.yaml is shown marked, and can be fixed from the page", async () => {
  const { call, signIn } = setup(CONFIG.replace("      sibling:\n        key: claude\n", "      sibling: {model: gpt-9, key: claude}\n"));
  await signIn();
  const [work] = (await (await call("GET", "/api/houses")).json()) as HouseView[];
  expect(work!.pets[0]).toMatchObject({ model: "gpt-9", problem: "unknown model 'gpt-9' for harness claude-code-tmux (its models: opus, sonnet, haiku, fable)" });
  const fixed = (await (await call("PATCH", "/api/houses/work/pets/sibling", { model: "opus" })).json()) as WriteView;
  expect(fixed.house!.pets[0]).toMatchObject({ model: "opus", problem: null });
});

test("one bot, one house, by the bot's id: another house's bot is refused; a new token of a bot goes to this house's other channels on it", async () => {
  const { call, signIn, text, logged, telegram } = setup();
  await signIn();
  const added = await call("POST", "/api/houses/work/channels", { kind: "telegram-private", token: BOT_NEW, chat: "555" });
  expect(added.status).toBe(201);
  expect((await text()).match(new RegExp(BOT_NEW, "g"))).toHaveLength(2); // DM goes on with the new token too
  expect(await text()).not.toContain(BOT);
  expect(logged.join("\n")).not.toContain(BOT_NEW);

  await call("POST", "/api/houses", { name: "home" });
  await call("POST", "/api/houses/home/owners", { platform: "telegram", id: "5" });
  const calls = telegram.sent("getMe").length;
  const before = await text();
  const refused = await call("POST", "/api/houses/home/channels", { kind: "telegram-private", token: BOT, chat: "5" });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toBe("@fake_bot is workspace work's bot, and a bot serves one workspace");
  expect(telegram.sent("getMe")).toHaveLength(calls + 1); // asked who it is; nothing written
  expect(await text()).toBe(before);
});

test("a bot token given in the form: checked with Telegram (not again when unchanged), kept in the config as given (trimmed), shown back, never logged", async () => {
  const { call, signIn, text, logged, telegram } = setup();
  await signIn();
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await call(method, path, body);
    return { status: response.status, answer: (await response.json()) as WriteView & { error?: string } };
  };

  const added = await send("POST", "/api/houses/work/channels", { kind: "telegram-private", token: ` ${OTHER_BOT} `, chat: "555", name: "Home" });
  expect(added.status).toBe(201);
  const asked = () => telegram.calls.filter((each) => each.method === "getMe" && each.bot === "4343").length;
  expect(asked()).toBe(1); // checked once; what it said is remembered for the view
  expect(added.answer.house!.channels[1]).toMatchObject({ fields: { token: OTHER_BOT }, shown: { token: "@fake_bot" } });
  expect(await text()).toContain(`token: ${OTHER_BOT}`);

  // Editing with the token as it is asks Telegram nothing; a changed one is checked; one Telegram refuses changes nothing.
  expect((await send("PATCH", "/api/houses/work/channels/555", { token: OTHER_BOT, name: "Home 2" })).status).toBe(200);
  expect(asked()).toBe(1);
  const before = await text();
  expect((await send("PATCH", "/api/houses/work/channels/555", { token: UNKNOWN_BOT })).answer.error).toBe("Telegram does not know this bot token (revoked, or mistyped?)");
  expect(await text()).toBe(before);
  for (const token of [BOT, BOT_NEW, OTHER_BOT, UNKNOWN_BOT]) expect(logged.join("\n")).not.toContain(token);
});

test("keys: listed with their kind, value and pets; added, changed, removed (not while a pet runs on it); a pet picks one", async () => {
  const { call, signIn, text, logged, applied } = setup();
  await signIn();
  const keys = async (response: Response) => ((await response.json()) as KeysView).keys;
  const claude: KeyView = { name: "claude", provider: "anthropic", kind: "subscription", value: KEY, note: null, pets: ["work/sibling"], houses: null, allowOverage: false, allowance: null };
  expect(await (await call("GET", "/api/keys")).json()).toEqual([claude]);

  const added = await call("POST", "/api/keys", { name: "api", provider: "anthropic", value: " sk-ant-api03-web-routes-test ", note: "pay as you go" });
  expect(added.status).toBe(201);
  expect(await keys(added)).toEqual([claude, { name: "api", provider: "anthropic", kind: "API key", value: "sk-ant-api03-web-routes-test", note: "pay as you go", pets: [], houses: null, allowOverage: false, allowance: null }]);
  // Two keys fit now; sibling names its own, as every pet does: nothing changes for it.
  const [work] = (await (await call("GET", "/api/houses")).json()) as HouseView[];
  expect(work!.pets[0]).toMatchObject({ key: "claude", problem: null });
  const picked = (await (await call("PATCH", "/api/houses/work/pets/sibling", { key: "api" })).json()) as WriteView;
  expect(picked.house!.pets[0]).toMatchObject({ key: "api", problem: null });
  expect(await text()).toContain("sibling:\n        key: api");

  expect(await keys(await call("PATCH", "/api/keys/claude", { value: "sk-ant-oat01-rotated", note: "Max" }))).toContainEqual({ ...claude, value: "sk-ant-oat01-rotated", note: "Max", pets: [] });
  const inUse = await call("DELETE", "/api/keys/api");
  expect(((await inUse.json()) as { error: string }).error).toBe("key 'api' is in use by work/sibling: give it another key first");
  expect(await keys(await call("DELETE", "/api/keys/claude"))).toEqual([{ name: "api", provider: "anthropic", kind: "API key", value: "sk-ant-api03-web-routes-test", note: "pay as you go", pets: ["work/sibling"], houses: null, allowOverage: false, allowance: null }]);
  expect(applied).toHaveLength(4);
  expect(logged.some((line) => line.includes("web: key api added"))).toBe(true);
  for (const value of [KEY, "sk-ant-oat01-rotated", "sk-ant-api03-web-routes-test"]) expect(logged.join("\n")).not.toContain(value);
});

test("temporary grants are separate from config allowances; only signed-in owners may revoke one pet's without a full reload", async () => {
  let active = [{ house: "work", pet: "sibling", domain: "api.github.com", port: 443, addresses: ["140.82.112.6"], reason: "GitHub issue lookup", expiresAt: Date.now() + 900_000 }];
  active.push({ ...active[0]!, port: 22 });
  const removed: string[] = [];
  const { call, signIn, applied, text } = setup(CONFIG, {
    active: (house) => active.filter((grant) => house === undefined || grant.house === house),
    revoke: async (house, pet, domain, port = 443) => { removed.push(`${house}/${pet}/${domain}:${port}`); active = active.filter((grant) => grant.house !== house || grant.pet !== pet || grant.domain !== domain || grant.port !== port); },
  });
  expect((await call("DELETE", "/api/houses/work/temporary/api.github.com")).status).toBe(401);
  await signIn();
  const shown = await (await call("GET", "/api/houses/work")).json() as HouseView;
  expect(shown.temporary).toEqual(active);
  expect(shown.allow.some(({ host }) => host === "api.github.com")).toBe(false);
  const before = await text();
  expect((await call("DELETE", "/api/houses/work/temporary/*.github.com")).status).toBe(400);
  expect((await call("DELETE", "/api/houses/unknown/temporary/api.github.com")).status).toBe(404);
  for (const query of ["port=&pet=sibling", "port=0&pet=sibling", "port=65536&pet=sibling", "port=22.5&pet=sibling", "port=abc&pet=sibling", "port=22&port=443&pet=sibling", "port=-1&pet=sibling", "port=1e2&pet=sibling",
    "port=22", "port=22&pet=", "port=22&pet=Sibling", "port=22&pet=sibling&pet=chair"]) {
    expect((await call("DELETE", `/api/houses/work/temporary/api.github.com?${query}`)).status).toBe(400);
  }
  expect(removed).toEqual([]);
  const exact = await call("DELETE", "/api/houses/work/temporary/api.github.com?port=22&pet=sibling");
  expect(exact.status).toBe(200);
  expect(((await exact.json()) as WriteView).house!.temporary!.map(({ port }) => port)).toEqual([443]);
  const revoked = await call("DELETE", "/api/houses/work/temporary/api.github.com?pet=sibling");
  expect(revoked.status).toBe(200);
  expect(((await revoked.json()) as WriteView).house!.temporary).toEqual([]);
  expect(removed).toEqual(["work/sibling/api.github.com:22", "work/sibling/api.github.com:443"]);
  expect(applied).toEqual([]);
  expect(await text()).toBe(before);
});


test("native model picker is authenticated and scoped to an explicit key; /me advertises native discovery and mode descriptions", async () => {
  const calls: string[] = [];
  const view = { models: [{ id: "gpt-6-astra", label: "Astra" }], source: "live" as const };
  const env = setup(CONFIG, undefined, { list: async (agent, key) => { calls.push(`${agent}/${key}`); return view; } });
  expect((await env.call("GET", "/api/agents/codex-app-server/models?key=one")).status).toBe(401);
  await env.signIn();
  expect((await env.call("GET", "/api/agents/codex-app-server/models")).status).toBe(400);
  const response = await env.call("GET", "/api/agents/codex-app-server/models?key=one");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(view);
  expect(calls).toEqual(["codex-app-server/one"]);
  const me = await (await env.call("GET", "/api/me")).json() as { agents: { name: string; dynamicModels?: boolean; modes: { description?: string }[] }[] };
  const codex = me.agents.find(({ name }) => name === "codex-app-server")!;
  expect(codex.dynamicModels).toBe(true);
  expect(codex.modes.some(({ description }) => !!description)).toBe(true);
});

test("pet reasoning effort is saved, returned, preserved on unrelated writes and cleared with null", async () => {
  const { call, signIn } = setup();
  await signIn();
  const saved = await call("PATCH", "/api/houses/work/pets/sibling", { reasoningEffort: "high" });
  expect(saved.status).toBe(200);
  expect((await saved.json()).house.pets[0].reasoningEffort).toBe("high");
  const changed = await call("PATCH", "/api/houses/work/pets/sibling", { title: "Effort test" });
  expect((await changed.json()).house.pets[0].reasoningEffort).toBe("high");
  const cleared = await call("PATCH", "/api/houses/work/pets/sibling", { reasoningEffort: null });
  expect((await cleared.json()).house.pets[0].reasoningEffort).toBeNull();
});

test("bulk allowlist route requires owner session and origin, adds one atomic batch and reloads once", async () => {
  const { call, signIn, text, applied } = setup();
  const path = "/api/houses/work/allow/bulk";
  const batch = { hosts: ["github.com:443", "pypi.org", "PyPI.org:443", "files.pythonhosted.org"] };
  const before = await text();
  expect((await call("POST", path, batch)).status).toBe(401);
  await signIn();
  expect((await call("POST", path, batch, { origin: "https://evil.example" })).status).toBe(403);
  expect((await call("POST", path, { hosts: ["pypi.org", "bad host"] })).status).toBe(400);
  expect((await call("POST", path, { hosts: [] })).status).toBe(400);
  expect((await call("POST", path, { hosts: ["pypi.org"], hidden: true })).status).toBe(400);
  expect(await text()).toBe(before);
  expect(applied).toEqual([]);
  const response = await call("POST", path, batch);
  expect(response.status).toBe(200);
  const view = await response.json() as WriteView;
  expect(view.house!.allow.filter((entry) => !entry.byAgent).map((entry) => entry.host)).toEqual(["github.com", "pypi.org", "files.pythonhosted.org"]);
  expect(applied).toEqual(["reload"]);
  expect((await call("POST", path, batch)).status).toBe(200);
  expect((await call("POST", "/api/houses/missing/allow/bulk", batch)).status).toBe(404);
});


test("environment API requires sign-in, saves and runs latest script without reload, and clears it", async () => {
  const calls: unknown[][] = [];
  const result = { status: "complete" as const, logPath: "/home/pet/environment/setup.log", statusPath: "/home/pet/environment/setup.status" };
  const { call, signIn, applied, store } = setup(CONFIG, undefined, undefined, (store) => petEnvironment(store, {
    environmentSetupResult: (_h, _p, phase) => phase === "onStart" ? undefined : result,
    runEnvironmentSetup: async (...args) => { calls.push(args); return result; },
  }, (job) => job(), () => true));
  const path = "/api/houses/work/pets/sibling/environment";
  expect((await call("GET", path)).status).toBe(401);
  expect((await call("PATCH", path, { setup: "attack" })).status).toBe(401);
  expect((await call("POST", `${path}/run`, {})).status).toBe(401);
  await signIn();
  expect((await call("PATCH", path, { setup: "printf ready" })).status).toBe(200);
  expect(await (await call("GET", path)).json()).toEqual({ setup: "printf ready", onStart: null, lastRun: result, onStartLastRun: null });
  expect((await call("POST", `${path}/run`, { command: "attack" })).status).toBe(400);
  expect((await call("POST", `${path}/run`, {})).status).toBe(200);
  expect(calls).toEqual([["work", "sibling", "printf ready", "setup"]]);
  expect((await call("PATCH", path, { setup: null })).status).toBe(200);
  expect((await store.load()).houses[0]!.pets[0]!.environment).toBeUndefined();
  expect((await call("PATCH", path, { setup: "x".repeat(65537) })).status).toBe(400);
  expect((await call("GET", path.replace("sibling", "missing"))).status).toBe(404);
  expect(applied).toEqual([]);
});


test("environment restart is authenticated, validates its body and uses saved config without reload", async () => {
  const restarts: unknown[][] = [];
  const { call, signIn, applied } = setup(CONFIG, undefined, undefined, (store) => petEnvironment(store, {
    environmentSetupResult: () => undefined,
    runEnvironmentSetup: async () => { throw new Error("unexpected direct setup"); },
  }, (job) => job(), () => true, async (...args) => { restarts.push(args); }));
  const path = "/api/houses/work/pets/sibling/environment";
  expect((await call("POST", `${path}/restart`, {})).status).toBe(401);
  await signIn();
  await call("PATCH", path, { setup: "printf latest" });
  expect((await call("POST", `${path}/restart`, { setup: "attack" })).status).toBe(400);
  const response = await call("POST", `${path}/restart`, {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ setup: "printf latest", onStart: null, lastRun: null, onStartLastRun: null });
  expect(restarts).toEqual([["work", "sibling", "printf latest", undefined]]);
  expect((await call("POST", path.replace("sibling", "missing") + "/restart", {})).status).toBe(404);
  expect(applied).toEqual([]);
});

test("terminal requires authentication, configured pet and read-only adapter capability", async () => {
  const captures: string[][] = [];
  const env = setup(CONFIG, undefined, undefined, undefined, async (...args) => {
    captures.push(args);
    return { text: "<script>screen text</script>\n❯" };
  });
  expect((await env.call("GET", "/api/houses/work/pets/sibling/terminal")).status).toBe(401);
  expect(captures).toEqual([]);
  await env.signIn();
  for (const path of ["/api/houses/missing/pets/sibling/terminal", "/api/houses/work/pets/missing/terminal"]) {
    const response = await env.call("GET", path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const response = await env.call("GET", "/api/houses/work/pets/sibling/terminal?command=send-keys&session=other");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ text: "<script>screen text</script>\n❯" });
  expect(captures).toEqual([["work", "sibling", "claude-code-tmux"]]);
  expect((await env.call("POST", "/api/houses/work/pets/sibling/terminal", { command: "send-keys" })).status).toBe(405);
  expect(captures).toHaveLength(1);

  const codexConfig = CONFIG.replace(`provider: anthropic, value: ${KEY}`, "provider: openai, value: sk-test").replace("key: claude", "key: claude\n        agent: codex-app-server");
  const unsupported = setup(codexConfig, undefined, undefined, undefined, async () => { throw new Error("must not capture"); });
  await unsupported.signIn();
  const refused = await unsupported.call("GET", "/api/houses/work/pets/sibling/terminal");
  expect(refused.status).toBe(400);
  expect(refused.headers.get("cache-control")).toBe("no-store");
});

test("terminal reports unavailable VM without returning guest output", async () => {
  const env = setup(CONFIG, undefined, undefined, undefined, async () => undefined);
  await env.signIn();
  const response = await env.call("GET", "/api/houses/work/pets/sibling/terminal");
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "pet terminal is unavailable; its VM must be running" });
});


test("skills routes require a session and an existing house; writes use revisions without reloading pets", async () => {
  const env = setup();
  expect((await env.call("GET", "/api/houses/work/skills")).status).toBe(401);
  await env.signIn();
  expect((await env.call("GET", "/api/houses/missing/skills")).status).toBe(404);
  const path = "/api/houses/work/skills/file";
  const created = await env.call("PUT", path, {path:"review/SKILL.md",content:"# Review",revision:null});
  expect(created.status).toBe(200);
  expect(env.added).toEqual(["work/*:review"]); // a new skill is announced to the house's pets
  const file = await created.json();
  expect((await env.call("GET", path + "?path=review%2FSKILL.md")).status).toBe(200);
  expect((await env.call("PUT", path, {...file,content:"updated"})).status).toBe(200);
  expect(env.added).toHaveLength(1); // an edit is not
  expect((await env.call("PUT", path, {...file,content:"stale"})).status).toBe(409);
  expect((await env.call("DELETE", path, {path:file.path,revision:file.revision})).status).toBe(409);
  expect((await env.call("PUT", path, {path:"../escape",content:"bad",revision:null})).status).toBe(400);
  expect((await env.call("GET", "/api/houses/work/skills")).headers.get("cache-control")).toBe("no-store");
  expect(env.applied).toEqual([]);
});

test("Household's own skills are listed read-only, and a pet's link to one is not offered for editing", async () => {
  const env = setup();
  expect((await env.call("GET", "/api/builtin-skills")).status).toBe(401);
  await env.signIn();
  const builtin = await (await env.call("GET", "/api/builtin-skills")).json() as { name: string; description: string; content: string }[];
  expect(builtin.map((skill) => skill.name)).toContain("household-sideworkers");
  expect(builtin.every((skill) => skill.name.startsWith("household-") && skill.description && skill.content.startsWith("---\n"))).toBe(true);
  // A VM links each one into the house's shared skills; the editor leaves those links out.
  await env.call("PUT", "/api/houses/work/skills/file", { path: "review/SKILL.md", content: "# Review", revision: null });
  const house = join(realpathSync(join(env.dir, "house-skills")), "work");
  symlinkSync("/opt/household/builtin-skills/household-network", join(house, "household-network"));
  symlinkSync("/opt/household/skills/.x", join(house, "household-zzz")); // a pet's, posing as one: stays in sight
  const listed = await (await env.call("GET", "/api/houses/work/skills")).json() as { path: string }[];
  expect(listed.map((entry) => entry.path)).toEqual(["household-zzz", "review", "review/SKILL.md"]);
  expect((await env.call("PUT", "/api/houses/work/skills/file", { path: "Household-x/SKILL.md", content: "#", revision: null })).status).toBe(400);
  // Their names are Household's: neither the house nor a pet may write one.
  const reserved = await env.call("PUT", "/api/houses/work/skills/file", { path: "household-network/SKILL.md", content: "# Mine", revision: null });
  expect(reserved.status).toBe(400);
  expect(((await reserved.json()) as { error: string }).error).toContain("household-");
});

test("per-pet scheduled tasks require web auth and validate revisions and schedules", async () => {
  const db=new SqliteStore(":memory:");
  const crons=new Crons(db.crons,{acceptScheduled:()=>{}},(house,pet)=>house==="work"&&pet==="sibling",()=>{});
  const {call,signIn,applied}=setup(CONFIG,undefined,undefined,undefined,undefined,crons);
  const path="/api/houses/work/pets/sibling/crons";
  const fields={name:"Reminder",body:"Check status",at:new Date(Date.now()+3600_000).toISOString().slice(0,-1)};
  expect((await call("POST",path,fields)).status).toBe(401);
  await signIn();
  const response=await call("POST",path,fields);expect(response.status).toBe(201);const job=await response.json();
  expect((await call("GET","/api/houses/work/pets/other/crons")).status).toBe(404);
  expect((await call("POST",path,{...fields,at:"yesterday"})).status).toBe(400);
  expect((await call("PUT",`${path}/${job.id}`,{...fields,revision:99})).status).toBe(409);
  expect((await call("PUT",`${path}/${job.id}`,{name:"Daily",body:"Check",cron:"0 9 * * *",revision:1})).status).toBe(200);
  expect((await call("DELETE",`${path}/${job.id}`,{revision:2})).status).toBe(200);
  const view=await (await call("GET",path)).json();expect(view.jobs[0].state).toBe("deleted");expect(view.events).toHaveLength(3);
  expect(applied).toHaveLength(0);db.close();
});

test("Household timezone is a global setting, validated and applied once", async()=>{
  const {call,signIn,text,applied}=setup();await signIn();
  expect((await call("PUT","/api/timezone",{timezone:"Not/AZone"})).status).toBe(400);
  expect((await call("PUT","/api/timezone",{timezone:"Europe/Madrid"})).status).toBe(200);
  expect(await (await call("GET","/api/timezone")).json()).toEqual({timezone:"Europe/Madrid"});
  expect(await text()).toContain("timezone: Europe/Madrid");expect(applied).toEqual(["reload"]);
});


test("memory API requires auth, scopes identities, reports stale edits and exposes recovery history", async () => {
  const db=new SqliteStore(":memory:");
  try {
    const memory=new PetMemory(db.memory,(h,p)=>h==="work"&&p==="sibling");
    const {call,signIn}=setup(CONFIG,undefined,undefined,undefined,undefined,undefined,memory);
    const url="/api/houses/work/pets/sibling/memory";
    expect((await call("GET",url)).status).toBe(401);
    await signIn();
    let response=await call("PUT",url,{key:"user.preference",value:"Grüß dich",revision:0});
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({revision:1,actor:"owner"});
    expect((await call("PUT",url,{key:"user.preference",value:"stale",revision:0})).status).toBe(409);
    expect((await call("GET",url.replace("sibling","missing"))).status).toBe(404);
    expect((await call("PUT",url,{key:"core",value:"x".repeat(8001),revision:0})).status).toBe(400);
    response=await call("GET",url+"?query="+encodeURIComponent("Grü"));
    expect((await response.json()).entries).toHaveLength(1);
    expect((await call("DELETE",url,{key:"user.preference",revision:1})).status).toBe(200);
    expect((await (await call("GET",url)).json()).entries).toHaveLength(0);
    expect((await (await call("GET",url+"?deleted=true")).json()).entries[0].deleted).toBe(true);
    const history=await (await call("GET",url+"/user.preference/history")).json();
    expect(history.map((v:any)=>v.value)).toEqual([null,"Grüß dich"]);
    expect((await call("PUT",url,{key:"user.preference",value:history[1].value,revision:2})).status).toBe(200);
  } finally { db.close(); }
});

test("pet enabled flag defaults on and persists boolean updates without changing its other fields", async () => {
  const { call, signIn, store } = setup();
  await signIn();
  for (const enabled of [false, true]) {
    const response = await call("PATCH", "/api/houses/work/pets/sibling", { enabled });
    expect(response.status).toBe(200);
    const config = await store.load();
    expect(config.houses[0]!.pets[0]).toMatchObject({ name: "sibling", key: "claude", enabled });
    const view = await (await call("GET", "/api/houses/work")).json();
    expect(view.pets[0].enabled).toBe(enabled);
  }
  expect((await call("PATCH", "/api/houses/work/pets/sibling", { enabled: "false" })).status).toBe(400);
});


test("instruction API uses the configured adapter and detects conflicting saves", async () => {
  const { call, signIn } = setup();
  const path = "/api/houses/work/pets/sibling/instructions";
  expect((await call("GET", path)).status).toBe(401);
  await signIn();
  const initial = await (await call("GET",path)).json();
  expect(initial.path).toBe(".claude/CLAUDE.md");
  const response = await call("PUT",path,{content:"# My pet",revision:initial.revision});
  expect(response.status).toBe(200);
  expect((await response.json()).content).toBe("# My pet");
  expect((await call("PUT",path,{content:"stale",revision:initial.revision})).status).toBe(409);
  expect((await call("PUT",path,{content:"bad",revision:initial.revision,path:"/tmp/bad"})).status).toBe(400);
  expect((await call("GET","/api/houses/work/pets/missing/instructions")).status).toBe(404);
});


test("metrics API is authenticated, validates history range and scopes only configured pets", async () => {
  const calls: string[][] = [];
  const { call, signIn } = setup(CONFIG, undefined, undefined, undefined, undefined, undefined, undefined, {
    history(house, pet, range) { calls.push([house, pet, range]); return { from: 0, to: 60_000, interval: 60_000, samples: [] }; },
  });
  const path = "/api/houses/work/pets/sibling/metrics";
  expect((await call("GET", path)).status).toBe(401);
  await signIn();
  expect((await call("GET", path + "?range=7d")).status).toBe(200);
  expect(calls).toEqual([["work", "sibling", "7d"]]);
  expect((await call("GET", path + "?range=all")).status).toBe(400);
  expect((await call("GET", path.replace("sibling", "missing"))).status).toBe(404);
  expect((await call("GET", path.replace("work", "missing"))).status).toBe(404);
  expect(calls).toHaveLength(1);
});


test("pet CPU and RAM are validated against the schema and this host, persisted, preserved on unrelated edits and resettable", async () => {
  const { call, signIn, store } = setup();
  await signIn();
  const path = "/api/houses/work/pets/sibling";
  const error = async (fields: object) => {
    const response = await call("PATCH", path, fields);
    expect(response.status).toBe(400);
    return ((await response.json()) as { error: string }).error;
  };
  for (const fields of [{cpus: 0}, {cpus: 1.5}, {cpus: 1025}, {memoryMiB: 128}, {memoryMiB: 513}]) await error(fields);
  // Beyond the host: refused, saying what it has.
  expect(await error({cpus: 9})).toBe("bot work/sibling: 9 vCPU, more than this host's 8");
  expect(await error({memoryMiB: 16384 + 128})).toBe("bot work/sibling: 16.125 GiB of RAM, more than this host's 16 GiB");
  expect((await call("PATCH", path, {cpus: 8, memoryMiB: 16384})).status).toBe(200); // all of it: a warning in the UI, not a refusal
  expect((await call("PATCH", path, {memoryMiB: 512})).status).toBe(200);
  expect((await call("PATCH", path, {cpus: 4, memoryMiB: 4096})).status).toBe(200);
  await call("PATCH", path, {title: "New name"});
  expect((await store.load()).houses[0]!.pets[0]).toMatchObject({cpus: 4, memoryMiB: 4096, title: "New name"});
  expect((await call("PATCH", path, {cpus: null, memoryMiB: null})).status).toBe(200);
  const pet = (await store.load()).houses[0]!.pets[0]!;
  expect(pet.cpus).toBeUndefined(); expect(pet.memoryMiB).toBeUndefined();
  const shown = (await (await call("GET", "/api/houses/work")).json()) as HouseView;
  expect(shown.pets[0]).toMatchObject({cpus: 2, memoryMiB: 1024}); // the defaults
});

test("a new pet joins the channels it is added with in the same write: each keeps its default, one alone needs none", async () => {
  const config = CONFIG.replace("pets: [sibling]}\n", "pets: [sibling]}\n      - {kind: telegram-private, token: \"${OTHER_BOT}\", chat: 555, pets: []}\n".replace("${OTHER_BOT}", OTHER_BOT));
  const { call, signIn, applied, text } = setup(config);
  await signIn();
  const added = await call("POST", "/api/houses/work/pets", { name: "chair", key: "claude", channels: ["100200300", "555"] });
  expect(added.status).toBe(201);
  const house = ((await added.json()) as WriteView).house!;
  expect(house.channels.map(({ chat, pets, default: first }) => ({ chat, pets, default: first }))).toEqual([
    { chat: "100200300", pets: ["sibling", "chair"], default: "sibling" }, // the one there stays the default, now written
    { chat: "555", pets: ["chair"], default: "chair" },
  ]);
  expect(await text()).toContain("pets: [ sibling, chair ],\n          default: sibling\n");
  expect(applied).toEqual(["reload"]); // one reload: it starts in its channels
  // A new pet restarts every night at 04:00 until its owner says otherwise.
  expect(house.pets.find((pet) => pet.name === "chair")!.lifecycle).toEqual({ enabled: true, every: "daily", at: "04:00", notice: 5 });
  // A chat the house has no channel of: nothing written.
  const before = await text();
  expect((await call("POST", "/api/houses/work/pets", { name: "desk", key: "claude", channels: ["999"] })).status).toBe(404);
  expect(await text()).toBe(before);
});


test("house metrics summary requires authentication and only reads configured enabled pets", async () => {
  const calls: string[][] = [];
  const { call, signIn } = setup(CONFIG, undefined, undefined, undefined, undefined, undefined, undefined, {
    history: () => ({from: 0, to: 0, interval: 60000, samples: []}),
    latest(house, pet) { calls.push([house, pet]); return null; },
  });
  const path = "/api/houses/work/metrics";
  expect((await call("GET", path)).status).toBe(401);
  await signIn();
  expect(await (await call("GET", path)).json()).toEqual({ sibling: null });
  expect(calls).toEqual([["work", "sibling"]]);
  expect((await call("GET", "/api/houses/other/metrics")).status).toBe(404);
  await call("PATCH", "/api/houses/work/pets/sibling", {enabled:false});
  calls.length = 0;
  expect(await (await call("GET", path)).json()).toEqual({ sibling: null });
  expect(calls).toEqual([]);
});

test("a grant approved from chat shows as such in the allowlist and is removed like any entry", async () => {
  const { call, signIn, text } = setup(CONFIG.replace("allow: [github.com] # keep me", "allow: [github.com] # keep me\n      granted: [api.example.org]"));
  await signIn();
  const shown = await (await call("GET", "/api/houses/work")).json() as HouseView;
  expect(shown.allow.filter(({ byAgent }) => !byAgent)).toEqual([{ host: "github.com", byAgent: false }, { host: "api.example.org", byAgent: false, granted: true }]);
  expect((await call("DELETE", "/api/houses/work/allow/api.example.org")).status).toBe(200);
  expect(await text()).not.toContain("api.example.org");
});

test("a pet's personal skills are in work/.agents/skills whatever its agent, apart from the shared ones", async () => {
  const env = setup();
  const base = "/api/houses/work/pets/sibling/skills";
  expect((await env.call("GET", base)).status).toBe(401);
  await env.signIn();
  expect((await env.call("GET", "/api/houses/work/pets/missing/skills")).status).toBe(404);
  const empty = await (await env.call("GET", base)).json();
  expect(empty).toEqual({ path: "/home/agent/work/.agents/skills", entries: [] }); // a Claude pet's too: .claude/skills links there
  const created = await env.call("PUT", base + "/file", { path: "review/SKILL.md", content: "# Pet review", revision: null });
  expect(created.status).toBe(200);
  expect(env.added).toEqual(["work/sibling:review"]); // announced to that pet alone
  const file = await created.json();
  expect((await (await env.call("GET", base + "/file?path=review%2FSKILL.md")).json()).content).toBe("# Pet review");
  expect(await (await env.call("GET", "/api/houses/work/skills")).json()).toEqual([]);
  expect((await env.call("PUT", base + "/file", { ...file, content: "updated" })).status).toBe(200);
  expect((await env.call("PUT", base + "/file", { ...file, content: "stale" })).status).toBe(409);
  expect((await env.call("PUT", base + "/file", { path: "../escape", content: "bad", revision: null })).status).toBe(400);
  expect(env.applied).toEqual([]);
});


test("sideworker size defaults save, discard obsolete counts, and reject invalid host allocation", async () => {
  const { call, signIn, store } = setup();
  await signIn();
  const path = "/api/houses/work/sideworker-limits";
  expect((await call("PUT", path, { maxWorkers: 0, cpus: 1, memoryMiB: 512 })).status).toBe(200);
  expect((await store.load()).houses[0]!.sideworkerLimits).toEqual({ cpus: 1, memoryMiB: 512 });
  for (const limits of [{ maxWorkers: -1, cpus: 1, memoryMiB: 512 }, { maxWorkers: 2, cpus: 9, memoryMiB: 1024 }, { maxWorkers: 2, cpus: 1, memoryMiB: 256 }, { maxWorkers: 2, cpus: 1, memoryMiB: 32768 }]) {
    expect((await call("PUT", path, limits)).status).toBe(400);
  }
  expect((await store.load()).houses[0]!.sideworkerLimits?.maxWorkers).toBeUndefined();
  expect((await call("PUT", "/api/houses/missing/sideworker-limits", { maxWorkers: 1, cpus: 1, memoryMiB: 1024 })).status).toBe(404);
});

test("worker views are readable without becoming configured pets and their skills edit the parent project", async () => {
  const db = new SqliteStore(":memory:");
  const record = { house: "work", name: "sw-test", parent: "sibling", cwd: "/home/agent/projects/demo", createdAt: 1, cpus: 1, memoryMiB: 512 };
  db.set("sideworkers.v1", JSON.stringify([record]));
  let reloaded = 0;
  const workers = new Sideworkers({ store: db, agents: knownAgents(), configured: async () => { throw new Error("not called"); }, reload: async () => { reloaded++; }, resolveDirectory: async (_house, _pet, cwd) => cwd, ready: async () => true, dispatch: async () => {}, isIdle: async () => true, send: () => {}, log: () => {} });
  const env = setup(CONFIG, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workers);
  const endpoint = "/api/houses/work/sideworkers";
  expect((await env.call("DELETE", endpoint + "/sw-test")).status).toBe(401);
  await env.signIn();
  expect(await (await env.call("GET", endpoint)).json()).toEqual([record]);
  const house = (await (await env.call("GET", "/api/houses")).json())[0];
  expect(house.pets.find((pet: { name: string }) => pet.name === record.name)).toMatchObject({ sideworker: { parent: "sibling", cwd: record.cwd }, cpus: 1, memoryMiB: 512 });
  expect(house.channels[0].pets).toEqual(["sibling"]);
  const skills = "/api/houses/work/pets/sw-test/skills";
  expect(await (await env.call("GET", skills)).json()).toEqual({ path: "/home/agent/projects/demo/.claude/skills", entries: [] });
  expect((await env.call("PUT", skills + "/file", { path: "review/SKILL.md", content: "# Project review", revision: null })).status).toBe(200);
  const parent = new PetSkills(join(env.configFile, "..", "homes")).at("work", "sibling", "projects/demo/.claude/skills");
  expect((await parent.read("review/SKILL.md")).content).toBe("# Project review");
  expect((await env.call("PATCH", "/api/houses/work/pets/sw-test", { title: "Not configurable" })).status).toBe(404);
  expect((await env.call("DELETE", endpoint + "/sw-test")).status).toBe(200);
  expect(reloaded).toBe(1);
  expect(await (await env.call("GET", endpoint)).json()).toEqual([]);
  expect((await env.call("GET", skills)).status).toBe(404);
  expect((await env.call("DELETE", endpoint + "/sw-test")).status).toBe(404);
  expect((await parent.read("review/SKILL.md")).content).toBe("# Project review");
  expect(await env.text()).not.toContain("sw-test");
});

test("house sideworker profile API validates adapter settings without storing invalid profiles", async () => {
  const env = setup(); await env.signIn();
  const path = "/api/houses/work/sideworker-profiles";
  const profile = { name: "claude-review", agent: "claude-code-tmux", key: "claude", model: "sonnet", mode: "auto" };
  const answer = await env.call("PUT", path, { profiles: [profile] });
  expect(answer.status).toBe(200);
  expect((await answer.json()).house.sideworkerProfiles).toEqual([profile]);
  for (const invalid of [{ ...profile, agent: "missing" }, { ...profile, key: "missing" }, { ...profile, model: "missing" }, { ...profile, mode: "invalid" }, { ...profile, reasoningEffort: "invalid" }]) {
    expect((await env.call("PUT", path, { profiles: [invalid] })).status).toBe(400);
  }
  expect((await env.store.load()).houses[0]!.sideworkerProfiles).toEqual([profile]);
  expect((await env.call("PUT", path, { profiles: [profile, profile] })).status).toBe(400);
  expect((await env.call("PUT", "/api/houses/absent/sideworker-profiles", { profiles: [] })).status).toBe(404);
});

test("active worker snapshot protects its credential after the profile is removed", async () => {
  const db = new SqliteStore(":memory:");
  db.set("sideworkers.v1", JSON.stringify([{ house: "work", name: "sw-snapshot", parent: "sibling", parentHome: "/home/agent", cwd: "/home/agent/work", createdAt: 1, cpus: 1, memoryMiB: 512,
    profile: "removed-profile", launch: { agent: "codex-app-server", key: "worker-only", model: "gpt-6.1-terra", mode: "auto" } }]));
  const workers = new Sideworkers({ agents: knownAgents(), store: db, configured: async () => { throw new Error("unused"); }, reload: async () => {}, resolveDirectory: async (_h, _p, cwd) => cwd, ready: async () => true, dispatch: async () => {}, isIdle: async () => true, send: () => {}, log: () => {} });
  const env = setup(CONFIG, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workers);
  await env.store.addKey("worker-only", { provider: "openai", value: "sk-household-worker-test-key" });
  await env.signIn();
  expect((await env.call("DELETE", "/api/keys/worker-only")).status).toBe(400);
  expect((await env.call("PATCH", "/api/keys/worker-only", { provider: "anthropic", value: "sk-ant-api03-invalid-for-worker" })).status).toBe(400);
  expect((await env.call("PATCH", "/api/keys/worker-only", { value: "sk-household-valid-rotation" })).status).toBe(200);
  expect((await env.store.load()).keys.find(key => key.name === "worker-only")!.provider).toBe("openai");
  db.close();
});

test("a Claude worker in the parent's work directory edits canonical personal skills without following its harness symlink", async () => {
  const db = new SqliteStore(":memory:");
  db.set("sideworkers.v1", JSON.stringify([{ house: "work", name: "sw-personal", parent: "sibling", parentHome: "/home/agent", cwd: "/home/agent/work", createdAt: 1, cpus: 1, memoryMiB: 512 }]));
  const workers = new Sideworkers({ store: db, agents: knownAgents(), configured: async () => { throw new Error("not called"); }, reload: async () => {}, resolveDirectory: async (_house, _pet, cwd) => cwd, ready: async () => true, dispatch: async () => {}, isIdle: async () => true, send: () => {}, log: () => {} });
  const env = setup(CONFIG, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workers);
  await env.signIn();
  const parentSkills = "/api/houses/work/pets/sibling/skills";
  expect((await env.call("PUT", parentSkills + "/file", { path: "review/SKILL.md", content: "# Personal", revision: null })).status).toBe(200);
  const workspace = join(env.configFile, "..", "homes", "household.work.sibling.home", "work");
  mkdirSync(join(workspace, ".claude"));
  symlinkSync("../.agents/skills", join(workspace, ".claude/skills"));
  const workerSkills = "/api/houses/work/pets/sw-personal/skills";
  const listed = await env.call("GET", workerSkills);
  expect(listed.status).toBe(200);
  expect((await listed.json()).path).toBe("/home/agent/work/.agents/skills");
  const read = await (await env.call("GET", workerSkills + "/file?path=review%2FSKILL.md")).json();
  expect(read.content).toBe("# Personal");
  expect((await env.call("PUT", workerSkills + "/file", { path: "review/SKILL.md", content: "# Updated", revision: read.revision })).status).toBe(200);
  expect((await (await env.call("GET", parentSkills + "/file?path=review%2FSKILL.md")).json()).content).toBe("# Updated");
});

test("house feature settings require owner session, validate addresses, persist and reload", async () => {
  const env = setup();
  const path = "/api/houses/work/features";
  const settings = { features: { preview: true, sideworkers: false }, preview: { bindAddress: "127.0.0.1", publicHost: "localhost" } };
  expect((await env.call("PUT", path, settings)).status).toBe(401);
  await env.signIn();
  const response = await env.call("PUT", path, settings);
  expect(response.status).toBe(200);
  expect((await response.json()).house).toMatchObject(settings);
  expect((await env.store.load()).houses[0]).toMatchObject(settings);
  expect(env.applied).toEqual(["reload"]);
  expect((await env.call("PUT", path, { ...settings, features: { preview: "true" } })).status).toBe(400);
  expect((await env.call("PUT", path, { ...settings, preview: { ...settings.preview, publicHost: "localhost:8780" } })).status).toBe(400);
  expect((await env.call("PUT", "/api/houses/missing/features", settings)).status).toBe(404);
});

test("Slack onboarding requires a session and rejects invalid credentials without changing config", async () => {
  const { call, signIn, text } = setup();
  const before = await text();
  const fields = { token: "invalid", appToken: "invalid", member: "U123" };
  expect((await call("POST", "/api/houses/work/slack/resolve", fields)).status).toBe(401);
  await signIn();
  expect((await call("POST", "/api/houses/work/slack/resolve", fields)).status).toBe(400);
  expect((await call("POST", "/api/houses/missing/slack/resolve", fields)).status).toBe(404);
  expect(await text()).toBe(before);
});

test("inbox API creates, tests, polls, deduplicates, changes frequency and removes a host source", async () => {
  const events: { id: string; title: string; text: string }[] = [];
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ version: 1, items: events }) });
  try {
    const s = setup();
    const body = { name: "incoming", title: "Incoming", enabled: true, intervalSeconds: 60, channel: "100200300", pets: ["sibling"], initial: "new", source: { kind: "http", url: `http://127.0.0.1:${source.port}/events`, headers: { Authorization: "Bearer test-only" } } };
    const path = "/api/houses/work/inboxes";
    expect((await s.call("GET", path)).status).toBe(401);
    await s.signIn();
    expect((await s.call("POST", path + "/test", body)).status).toBe(200);
    expect(s.inboxPosts).toEqual([]);
    expect((await s.call("POST", path, body)).status).toBe(201);
    expect((await s.call("POST", path + "/incoming/poll")).status).toBe(200);
    events.push({ id: "one", title: "New message", text: "body" });
    expect((await s.call("POST", path + "/incoming/poll")).status).toBe(200);
    expect((await s.call("POST", path + "/incoming/poll")).status).toBe(200);
    expect(s.inboxPosts).toEqual(["New message"]);
    expect(s.inboxPets).toEqual(["sibling"]);
    expect((await s.call("PUT", path + "/incoming", { ...body, intervalSeconds: 900 })).status).toBe(200);
    const list = await (await s.call("GET", path)).json();
    expect(list[0].inbox.intervalSeconds).toBe(900);
    expect(list[0].status.pendingCount).toBe(0);
    const subscriber = path + "/incoming/subscribers/sibling";
    expect((await s.call("PUT", subscriber, { subscribed: true, quiet: true })).status).toBe(200);
    expect((await (await s.call("GET", path)).json())[0].inbox).toMatchObject({ pets: ["sibling"], quiet: ["sibling"] });
    expect((await s.call("PUT", subscriber, { subscribed: false, quiet: true })).status).toBe(200);
    expect((await (await s.call("GET", path)).json())[0].inbox).toMatchObject({ pets: [], quiet: [] });
    expect((await s.call("PUT", path + "/incoming/subscribers/stranger", { subscribed: true, quiet: false })).status).toBe(400);
    expect((await s.call("PUT", subscriber, { subscribed: true })).status).toBe(400);
    expect((await s.call("PUT", path + "/incoming", { ...body, pets: ["missing"] })).status).toBe(400);
    expect((await s.call("DELETE", path + "/incoming")).status).toBe(200);
    expect(await (await s.call("GET", path)).json()).toEqual([]);
  } finally { source.stop(true); }
});


test("Google enrollment and metadata require the dashboard session and same-origin writes", async () => {
  const s = setup();
  const path = "/api/houses/work/connectors/google";
  expect((await s.call("GET", path)).status).toBe(401);
  expect((await s.call("GET", "/api/connectors/google/callback?code=private-code&state=bad")).status).toBe(401);
  await s.signIn();
  expect((await s.call("GET", path)).status).toBe(200);
  expect((await s.call("POST", path + "/connect", { services: ["gmail"], pets: ["sibling"] }, { origin: "https://evil.test" })).status).toBe(403);
  const result = await s.call("POST", path + "/connect", { services: ["gmail"], pets: ["sibling"] });
  expect(result.status).toBe(200);
  expect((await result.json()).url).toStartWith("https://accounts.google.com/");
  const oauthCookie = result.headers.get("set-cookie")!;
  expect(oauthCookie).toContain("SameSite=Lax; Path=/api/connectors/google/callback; Max-Age=600");
  const callbackCookie = oauthCookie.split(";")[0]!;
  expect((await s.call("GET", path, undefined, { cookie: callbackCookie })).status).toBe(401);
  const callback = await s.call("GET", "/api/connectors/google/callback?code=private-code&state=bad", undefined, { cookie: callbackCookie });
  expect(callback.status).toBe(400); // authenticated, but bad OAuth state
  expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
  const bad = await s.call("GET", "/api/connectors/google/callback?code=private-code&state=bad");
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toContain("private-code");
});

test("workspace resources API reports reservations and validates edits against pets and host", async () => {
  const { call, signIn } = setup(); await signIn();
  const path = "/api/houses/work/resources";
  const budget = await (await call("GET", path)).json();
  expect(budget).toMatchObject({ total: { cpus: 8, memoryMiB: 8192 }, reserved: { cpus: 2, memoryMiB: 1024 }, available: { cpus: 6, memoryMiB: 7168 } });
  expect((await call("PUT", path, { cpus: 4, memoryMiB: 4096 })).status).toBe(200);
  expect((await (await call("GET", path)).json()).available).toEqual({ cpus: 2, memoryMiB: 3072 });
  expect((await call("PUT", path, { cpus: 1, memoryMiB: 4096 })).status).toBe(400);
  expect((await call("PUT", path, { cpus: HOST.cpus + 1, memoryMiB: 4096 })).status).toBe(400);
  expect((await call("GET", "/api/houses/missing/resources")).status).toBe(404);
});
