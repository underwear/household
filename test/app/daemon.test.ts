import { telegramPrivate } from "../../src/channel-adapters/telegram/kind";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, type ApiAnswer, type DashboardLink, type ReloadReport, type StatusReport } from "../../src/app/daemon";
import { knownAgents } from "../../src/app/agents";
import { openChannels } from "../../src/app/channels";
import { ConfigStore } from "../../src/infra/config-store";
import { callControl } from "../../src/infra/control-socket";
import { EventLog } from "../../src/infra/event-log";
import { resolvePaths } from "../../src/infra/paths";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { fakeClock, tempDir, waitFor } from "../helpers";
import { FakeChannel, text } from "./fake-channel";
import { testServices } from "./test-services";
import type { HostNetworkPlane } from "../../src/app/host-network-plane";
import { FakeRuntime } from "./fake-runtime";
import { channelKey } from "../../src/core/channels";
import type { House } from "../../src/core/household";

const replyFormatJson = JSON.stringify(telegramPrivate.replyFormat).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** The test Household's one key: every pet runs on it (the only one that fits). */
const KEY = "sk-ant-oat01-daemon-test-key";
const BOT = "777:token-of-a-bot-for-the-daemon-tests";

/** Each test's gateway, by its state dir: what the agent API helpers read the published policy from. */
const planes = new Map<string, HostNetworkPlane>();
const policyOf = (paths: ReturnType<typeof resolvePaths>) => planes.get(paths.stateDir)!.policy;

function setup() {
  const paths = resolvePaths({ HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() });
  writeFileSync(paths.configFile, `daemon:\n  agentPort: 0 # any free port: never the real daemon's\n  webPort: 0\nkeys:\n  claude: {provider: anthropic, value: ${KEY}}\n`);
  const config = new ConfigStore(paths.configFile);
  const runtime = new FakeRuntime();
  const agents = knownAgents();
  const store = new SqliteStore(":memory:");
  const lines: string[] = [];
  /** Channels opened, by house (its first), and by house, key and bot (the same while those stay, as the real opener does). */
  const channels = new Map<string, FakeChannel>();
  const known = new Map<string, FakeChannel>();
  const services = testServices(paths, runtime);
  const network = () => {
    const plane = services.network();
    planes.set(paths.stateDir, plane);
    return plane;
  };
  const deps = {
    paths,
    config,
    agents,
    network: network(),
    pets: services.pets,
    events: new EventLog(paths.eventLog, (line) => lines.push(line)),
    messages: store,
    records: store,
    history: { search: async () => ({ records: [], more: false }) },
    openChannels: (houses: House[]) =>
      new Map(
        houses.map((house) => {
          const opened = new Map(
            house.channels.map((channel) => {
              const name = `${house.name}/${channelKey(channel)}/${channel.token}`;
              if (!known.has(name)) known.set(name, new FakeChannel());
              return [channelKey(channel), { channel: known.get(name)! }];
            }),
          );
          const [first] = opened.values();
          if (first) channels.set(house.name, first.channel);
          return [house.name, opened];
        }),
      ),
    channelChecks: new Map(), // no field checked here (the web routes' tests check them)
    sessions: store,
    webAssets: async () => new Map([["/index.html", { body: new TextEncoder().encode("<!doctype html><title>Household</title>"), type: "text/html;charset=utf-8" }]]),
  };
  return { paths, config, runtime, lines, deps, network, channels };
}

const status = (socket: string) => callControl<StatusReport>(socket, "/status");

/** The house's private chat with the bot of `token` (chat 1, its owner), every pet the house has so far placed in it. */
async function connect(config: ConfigStore, house: string, token = BOT, chat = "1"): Promise<void> {
  const pets = (await config.load()).houses.find(({ name }) => name === house)!.pets.map(({ name }) => name);
  await config.addOwner(house, "telegram", chat);
  await config.addChannel(house, { kind: "telegram-private", token, chat, pets, ...(pets.length > 1 ? { default: pets[0] } : {}) });
}

test("status over the socket; config edits apply on reload; stop cleans up", async () => {
  const { paths, config, runtime, deps, network } = setup();
  await config.createHouse("work");
  expect(await status(paths.socket)).toBeUndefined();

  const daemon = await startDaemon(deps);
  try {
    expect(await status(paths.socket)).toMatchObject({ state: "running", subjects: [{ subject: { kind: "house", name: "work" } }] });
    await config.createHouse("home");
    const reloaded = await callControl<StatusReport>(paths.socket, "/reload");
    expect(reloaded!.subjects.map((s) => s.subject.name)).toEqual(["work", "home"]);

    const callsBefore = [...runtime.calls];
    const second = { ...deps, network: network() };
    await expect(startDaemon(second)).rejects.toThrow("a daemon is already running");
    expect(runtime.calls).toEqual(callsBefore); // the running daemon's gateway was not touched
  } finally {
    await daemon.stop();
  }
  expect(existsSync(paths.socket)).toBe(false);
  expect(await status(paths.socket)).toBeUndefined();
});

test("web UI: `house dashboard`'s link signs a browser in; its writes reload like the CLI's; its session survives a restart", async () => {
  const { paths, config, runtime, deps, network, channels } = setup();
  // A fixed port, so the restarted daemon is on the same one: the cookie's name says which.
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = free.port!;
  await free.stop(true);
  writeFileSync(paths.configFile, readFileSync(paths.configFile, "utf8").replace("webPort: 0", `webPort: ${port}`));
  await config.createHouse("work");
  const database = join(paths.stateDir, "household.db");
  const daemon = await startDaemon({ ...deps, sessions: new SqliteStore(database) });
  const link = async () => ((await callControl<DashboardLink>(paths.socket, "/dashboard")) as { url: string }).url;
  let cookie = "";
  try {
    const url = await link();
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/login\\?token=[\\w-]{43}$`));
    expect((await status(paths.socket))!.web).toEqual({ url: `http://127.0.0.1:${port}` });
    const login = await fetch(url, { redirect: "manual" });
    expect(login.status).toBe(303);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toStartWith(`household_session_${port}=`);
    const origin = new URL(url).origin;
    expect(await (await fetch(`${origin}/`)).text()).toContain("<title>Household</title>");

    const created = await fetch(`${origin}/api/houses`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "lab" }) });
    expect(created.status).toBe(201);
    expect((await status(paths.socket))!.subjects.map((s) => s.subject.name)).toEqual(["work", "lab"]);

    await connect(config, "lab", "telegram-lab", "5"); // with the CLI, say: the next write's reload sees it
    const allowed = await fetch(`${origin}/api/houses/lab/allow`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ host: "example.com" }) });
    expect(allowed.status).toBe(200);
    expect(channels.get("lab")).toBeDefined(); // opened by that reload, no restart
  } finally {
    await daemon.stop();
  }

  const restarted = await startDaemon({ ...deps, network: network(), sessions: new SqliteStore(database) });
  try {
    const origin = new URL(await link()).origin;
    expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(200);
  } finally {
    await restarted.stop();
  }
});

test("web UI off when its port is taken or its files do not build: logged, shown, and everything else runs", async () => {
  const { paths, config, runtime, lines, deps, network } = setup();
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("someone else") });
  writeFileSync(paths.configFile, readFileSync(paths.configFile, "utf8").replace("webPort: 0", `webPort: ${taken.port}`));
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  try {
    const daemon = await startDaemon(deps);
    try {
      const off = { off: `port ${taken.port} is taken: set daemon.webPort in the config, then restart` };
      expect(await callControl(paths.socket, "/dashboard")).toEqual(off);
      expect((await status(paths.socket))!).toMatchObject({ state: "running", web: off, pets: [{ pet: "sibling", state: "running" }] });
      expect(runtime.calls).toContain("run household.work.sibling");
      expect(lines.some((line) => line.includes(`ERROR web UI off: port ${taken.port} is taken`))).toBe(true);
    } finally {
      await daemon.stop();
    }
  } finally {
    await taken.stop(true);
  }

  writeFileSync(paths.configFile, readFileSync(paths.configFile, "utf8").replace(`webPort: ${taken.port}`, "webPort: 0"));
  const unbuilt = await startDaemon({ ...deps, network: network(), webAssets: async () => Promise.reject(new Error("the web UI did not build")) });
  try {
    expect(await callControl(paths.socket, "/dashboard")).toEqual({ off: "the web UI did not build" });
  } finally {
    await unbuilt.stop();
  }
});

test("a broken config fails the reload and keeps the previous subjects", async () => {
  const { paths, config, lines, deps } = setup();
  await config.createHouse("work");
  const daemon = await startDaemon(deps);
  try {
    await Bun.write(paths.configFile, "houses:\n  work: {}\n");
    await expect(callControl(paths.socket, "/reload")).rejects.toThrow("daemon: invalid config");
    expect((await status(paths.socket))!.subjects.map((s) => s.subject.name)).toEqual(["work"]);
    expect(lines.some((line) => line.includes("ERROR reload failed"))).toBe(true);
  } finally {
    await daemon.stop();
  }
});

test("a reload applies the network policy and the channels: a gone one stops, a new one opens, no restart", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  await config.createHouse("work");
  await connect(config, "work");
  const daemon = await startDaemon(deps);
  try {
    const channel = channels.get("work")!;
    await config.removeChannel("work", "1");
    await connect(config, "work", "telegram-other", "2");
    await Bun.write(paths.configFile, (await Bun.file(paths.configFile).text()).replace("allow: []", "allow: [example.com]"));
    runtime.calls = [];
    const reloaded = await callControl<ReloadReport>(paths.socket, "/reload");
    expect(reloaded!.warnings).toEqual([]);
    expect(channel.stopped).toBe(true);
    expect(channels.get("work")).not.toBe(channel);
    expect(channels.get("work")!.stopped).toBe(false);
    expect(reloaded!.subjects[0]!.policy.allow).toContainEqual({ host: "example.com", port: 443 });
    expect(policyOf(paths).rules[0]!.policy.allow).toContainEqual({ host: "example.com", port: 443 }); // in force at the gateway
  } finally {
    await daemon.stop();
  }
});

test("while starting, status answers and reloads wait for the startup to finish", async () => {
  const { paths, config, runtime, deps } = setup();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  let finishBuild = () => {};
  runtime.gate = new Promise((resolve) => (finishBuild = resolve)); // the pet's image build
  const starting = startDaemon(deps);
  await waitFor(() => runtime.calls.some((call) => call.startsWith("build ")));
  expect(await status(paths.socket)).toMatchObject({ state: "starting" });
  await config.createHouse("home");
  const reload = callControl<StatusReport>(paths.socket, "/reload");
  finishBuild();
  expect((await reload)!.subjects.map((s) => s.subject.name)).toEqual(["work", "home"]);
  await (await starting).stop();
});

test("stop waits for an in-flight reload before it stops the gateway", async () => {
  const { paths, config, runtime, deps } = setup();
  const daemon = await startDaemon(deps);
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  let finishBuild = () => {};
  runtime.gate = new Promise((resolve) => (finishBuild = resolve));
  const reload = callControl(paths.socket, "/reload");
  await waitFor(() => runtime.calls.some((call) => call.startsWith("build ")));
  const stopped = daemon.stop();
  await Bun.sleep(20);
  finishBuild();
  await stopped;
  expect(await reload).toMatchObject({ subjects: [{ subject: { name: "work" } }] });
});

test("a socket left by a dead daemon does not block start", async () => {
  const { paths, deps } = setup();
  mkdirSync(paths.stateDir, { recursive: true });
  // A process that binds the socket and dies without cleaning up.
  const script = `Bun.listen({ unix: ${JSON.stringify(paths.socket)}, socket: { data() {} } }); process.kill(process.pid, "SIGKILL");`;
  Bun.spawnSync(["bun", "-e", script]);
  expect(existsSync(paths.socket)).toBe(true);
  const daemon = await startDaemon(deps);
  expect(await status(paths.socket)).toMatchObject({ state: "running", subjects: [], pets: [] });
  await daemon.stop();
});

test("the gateway's connections land in the event log as they happen", async () => {
  const { paths, lines, deps } = setup();
  const daemon = await startDaemon(deps);
  try {
    // A caller with no pet's token, as a stray process on the host would be.
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: deps.network.proxyPort, socket: { data() {} } });
    socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    await waitFor(() => lines.some((line) => line.includes("DENY")));
    socket.end();
    expect(lines.find((line) => line.includes("DENY"))).toMatch(/^\d\d:\d\d:\d\d DENY  unknown 127\.0\.0\.1(:\d+)? CONNECT example\.com:443 \(.* is not a known pet\)$/);
    const events = (await Bun.file(paths.eventLog).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === "proxy")).toMatchObject({ type: "proxy", kind: "connect", verdict: "DENY", target: "example.com:443" });
    expect(existsSync(join(paths.stateDir, "gateway"))).toBe(false); // no gateway log file of its own
  } finally {
    await daemon.stop();
  }
});

test("pets come up; the house gets the hosts its pets' keys go to; each pet's key reaches the gateway, by pet", async () => {
  const { paths, config, runtime, lines, deps } = setup();
  runtime.output = () => "❯\u00a0\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  await config.createHouse("work");
  await config.addKey("api", { provider: "anthropic", value: "sk-ant-api03-daemon-test-key" });
  await config.addPet("work", "sibling", { key: "claude" });
  await config.addPet("work", "chair", { key: "api" });
  const daemon = await startDaemon(deps);
  try {
    const report = (await status(paths.socket))!;
    const anthropic = { host: "api.anthropic.com", port: 443 };
    expect(report.subjects[0]!.intercept).toEqual([anthropic]);
    // `allow:` is empty in the config; the hosts the keys go to are what makes api.anthropic.com reachable.
    expect(report.subjects[0]!.policy.allow).toEqual([anthropic]);
    expect(report.pets.map((pet) => `${pet.pet} ${pet.state}`)).toEqual(["sibling running", "chair running"]);
    expect(lines.some((line) => line.includes("bot work/sibling started"))).toBe(true);
    // Each key's value in the gateway's dir; the policy names which pet gets which, by pet, never by value.
    expect(readdirSync(paths.gatewaySecretsDir).sort()).toEqual(["household-agent-api", "key.api", "key.claude"]);
    expect(readFileSync(`${paths.gatewaySecretsDir}/key.claude`, "utf8")).toBe(KEY);
    const policy = JSON.stringify(policyOf(paths));
    expect(JSON.parse(policy).keys).toEqual([
      { house: "work", pet: "sibling", credentials: [{ target: anthropic, header: "authorization", prefix: "Bearer ", secret: "key.claude", strip: ["authorization", "x-api-key"] }] },
      { house: "work", pet: "chair", credentials: [{ target: anthropic, header: "x-api-key", prefix: "", secret: "key.api", strip: ["x-api-key", "authorization"] }] },
    ]);
    expect(policy).not.toContain(KEY);
    // The pet holds the placeholder of its key's kind, never a value.
    const env = (pet: string) => runtime.specs.find((spec) => spec.name === `household.work.${pet}`)!.env!;
    expect(Object.keys(env("sibling"))).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(Object.keys(env("chair"))).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(runtime.specs)).not.toContain("daemon-test-key");
    expect(lines.join("\n")).not.toContain("daemon-test-key");
  } finally {
    await daemon.stop();
  }
  expect(runtime.containers.has("household.work.sibling")).toBe(true); // pets outlive the daemon
});

test("a pet without a key, or with one that is not its agent's, fails the reload before any container changes", async () => {
  const { paths, config, runtime, deps } = setup();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  const daemon = await startDaemon(deps);
  try {
    runtime.calls = [];
    await Bun.write(paths.configFile, "keys:\n  a: {provider: anthropic, value: sk-ant-oat01-a}\n  b: {provider: anthropic, value: sk-ant-oat01-b}\n  gpt: {provider: openai, value: sk-x}\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling:\n      chair: {key: gpt}\n");
    const failed = callControl(paths.socket, "/reload");
    await expect(failed).rejects.toThrow("bot work/sibling: no key: name the key it runs on (key:; one of: a, b)");
    await expect(callControl(paths.socket, "/reload")).rejects.toThrow("bot work/chair: key 'gpt' is an openai key, and claude-code-tmux takes anthropic keys");
    expect(runtime.calls).toEqual([]);
  } finally {
    await daemon.stop();
  }
});

test("an unknown agent fails the reload before any container changes", async () => {
  const { paths, config, runtime, deps } = setup();
  await config.createHouse("work");
  const daemon = await startDaemon(deps);
  try {
    await Bun.write(paths.configFile, "houses:\n  work:\n    network: {allow: []}\n    pets:\n      x: {agent: codex}\n");
    runtime.calls = [];
    await expect(callControl(paths.socket, "/reload")).rejects.toThrow("bot work/x: unknown harness 'codex'");
    expect(runtime.calls).toEqual([]);
  } finally {
    await daemon.stop();
  }
});

const RULE = "─".repeat(40);
const READY = `${RULE}\n❯\u00a0\n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

/** Posts a hook payload to the agent API the way the gateway relay would. */
async function postEvent(paths: ReturnType<typeof resolvePaths>, pet: string, payload: object) {
  const secret = readFileSync(`${paths.gatewaySecretsDir}/household-agent-api`, "utf8");
  const url = `${policyOf(paths).agentApi}/events`;
  const headers = { "x-household-secret": secret, "x-household-house": "work", "x-household-pet": pet };
  return fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
}

test("agent events reach the log; a send waits while a dialog is open and goes out when it closes", async () => {
  const { paths, config, runtime, lines, deps } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  const daemon = await startDaemon(deps);
  try {
    expect(await (await postEvent(paths, "sibling", { hook_event_name: "UserPromptSubmit", prompt: "hi" })).json()).toEqual({});
    const question = { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Red or green?" }] } };
    await postEvent(paths, "sibling", question);
    expect(lines.some((line) => line.includes("PET   work/sibling dialog open (question): Red or green?"))).toBe(true);

    runtime.execs = [];
    expect(await callControl(paths.socket, "/send", { house: "work", pet: "sibling", text: "next" })).toEqual({
      activity: "dialog",
      queued: 1,
    });
    await Bun.sleep(50);
    expect(runtime.execs.some((exec) => exec.includes("paste-buffer"))).toBe(false);

    await postEvent(paths, "sibling", { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" });
    await waitFor(() => runtime.execs.some((exec) => exec.includes("send-keys")));
    expect(runtime.execs).toContain("household.work.sibling: tmux load-buffer -b household - < next");
    expect(lines.some((line) => line.includes("PET   work/sibling dialog closed"))).toBe(true);
    const events = readFileSync(paths.eventLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((e) => e.type === "agent").map((e) => e.event.kind)).toEqual([
      "prompt-accepted",
      "dialog-opened",
      "dialog-closed",
      "tool-finished",
    ]);
  } finally {
    await daemon.stop();
  }
});

test("the agent API needs the secret and ignores unknown pets; send to an unknown pet fails", async () => {
  const { paths, config, deps } = setup();
  await config.createHouse("work");
  const daemon = await startDaemon(deps);
  try {
    const url = `${policyOf(paths).agentApi}/events`;
    const wrong = await fetch(url, { method: "POST", headers: { "x-household-secret": "guess" }, body: "{}" });
    expect(wrong.status).toBe(401);
    expect((await postEvent(paths, "ghost", { hook_event_name: "Stop" })).status).toBe(200);
    await expect(callControl(paths.socket, "/send", { house: "work", pet: "ghost", text: "x" })).rejects.toThrow(
      "unknown bot work/ghost",
    );
  } finally {
    await daemon.stop();
  }
});

test("after a restart, a pet left with a dialog on screen holds its messages until the screen shows none", async () => {
  const { paths, config, runtime, lines, deps, network } = setup();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  runtime.output = () => READY;
  await (await startDaemon(deps)).stop();
  runtime.output = () => "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel";
  runtime.execs = [];
  const daemon = await startDaemon({ ...deps, network: network() });
  try {
    expect(lines.some((line) => line.includes("PET   work/sibling dialog open (unknown): already on screen"))).toBe(true);
    expect(runtime.calls.filter((call) => call === "run household.work.sibling")).toHaveLength(1); // adopted
    await callControl(paths.socket, "/send", { house: "work", pet: "sibling", text: "x" });
    await Bun.sleep(50);
    expect(runtime.execs.some((exec) => exec.includes("paste-buffer"))).toBe(false);
  } finally {
    await daemon.stop();
  }
});

/** Calls the agent API's MCP server the way the gateway relay would. */
async function callMcp(paths: ReturnType<typeof resolvePaths>, pet: string, body: object) {
  const secret = readFileSync(`${paths.gatewaySecretsDir}/household-agent-api`, "utf8");
  const url = `${policyOf(paths).agentApi}/mcp`;
  const headers = { "x-household-secret": secret, "x-household-house": "work", "x-household-pet": pet, "content-type": "application/json" };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
  return (await response.json()) as { result: any };
}

test("a turn on the person's message gets its live message in the pet's thread; hooks are answered at once, the channel hanging or not", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await connect(config, "work");
  const daemon = await startDaemon(deps);
  try {
    const channel = channels.get("work")!;
    await waitFor(() => channel.calls.length > 0);
    await channel.say(text("how's it going?"));
    await waitFor(() => runtime.execs.some((exec) => exec.includes("load-buffer")), 5_000);
    const typed = runtime.execs.find((exec) => exec.includes("load-buffer"))!.split(" < ").slice(1).join(" < ");
    const hook = async (payload: object) => {
      const started = Date.now();
      const answer = await (await postEvent(paths, "sibling", { prompt_id: "t1", ...payload })).json();
      return { answer, ms: Date.now() - started };
    };
    // General forwarding notices are outward messages too. Let them finish before
    // opening progress so this test can deliberately hold an edit on that post.
    await waitFor(() => channel.calls.some(call => call.includes("From General:")));
    await hook({ hook_event_name: "UserPromptSubmit", prompt: typed });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "uptime", description: "Shows the uptime" }, tool_use_id: "c1" });
    await waitFor(() => channel.statuses.length === 1);
    // In the pet's own thread, though the person wrote in General: where its reply goes. What it does now, its words.
    expect(channel.statuses).toEqual(["post status-1 🤖 Sibling: working Shows the uptime… [Stop]"]);

    // Hooks are answered at once, even while the channel hangs.
    channel.editHold = new Promise(() => {});
    for (const payload of [
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "uptime" }, tool_use_id: "c1", duration_ms: 12 },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "df", description: "Shows disk space" }, tool_use_id: "c2" },
    ]) {
      const { answer, ms } = await hook(payload);
      expect(answer).toEqual({});
      expect(ms).toBeLessThan(500);
    }
    await waitFor(() => channel.editing === 1, 5_000); // the edit to the new action, hanging
    // A further hook must not wait for the outstanding status edit either.
    const notification = await hook({ hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "idle_prompt" });
    expect(notification.answer).toEqual({});
    expect(notification.ms).toBeLessThan(500);
  } finally {
    await daemon.stop();
  }
}, 15_000);

test("the person's message reaches the pet's session; its reply through MCP reaches the chat; a (re)started pet is announced", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await connect(config, "work");
  const daemon = await startDaemon(deps);
  try {
    const channel = channels.get("work")!;
    await waitFor(() => channel.calls.length > 0);
    expect(channel.calls[0]).toStartWith("notice 🤖 Sibling: 🤖 Sibling started.");

    await channel.say(text("how's it going?"));
    await waitFor(() => channel.calls.includes("seen how's it going?"), 5_000); // after the batch window (1.2 s)
    // m1: the start notice, in sibling's thread; the person wrote in General: the same channel, c1; m3, m4: Household's notes about it.
    const header =
      `{"event":{"kind":"message","id":"m2"},"from":{"id":"p1","name":"Oleg","trust":"owner"},"channel":{"id":"c1","kind":"telegram-private","name":"Telegram Bot DM (threaded)","audience":"private","replyFormat":${replyFormatJson},"meta":{"message":1}},"place":{"id":"inbox@c1","kind":"house-inbox","title":"General"}}`;
    expect(runtime.execs).toContain(`household.work.sibling: tmux load-buffer -b household - < <household-message id="m2">\n<household-header>\n${header}\n</household-header>\n<household-content>\nhow's it going?\n</household-content>\n</household-message>`);

    const tools = await callMcp(paths, "sibling", { method: "tools/list" });
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["reply", "react", "history", "household_connectors_slack_accounts", "household_connectors_slack_operations", "household_connectors_slack_request", "household_connectors_google_accounts", "household_connectors_google_operations", "household_connectors_google_request", "preview_open", "preview_list", "preview_close", "secret_request", "workspace_resources", "sideworker_spawn", "sideworker_profiles", "sideworkers", "sideworker_close", "house_members", "house_send", "send_file", "edit_reply", "places", "place_create", "channel_format", "network_list", "network_request", "environment_setup", "environment_on_start", "environment_get", "environment_update"]);
    const replyTo = (args: object) => callMcp(paths, "sibling", { method: "tools/call", params: { name: "reply", arguments: args } });
    expect((await replyTo({ text: "fine" })).result).toEqual({ content: [{ type: "text", text: '{"id":"m5","channel":"c1","place":"pet:sibling@c1"}' }] });
    expect(channel.calls).toContain("post 🤖 Sibling: fine");
    expect((await replyTo({ text: "and here", channel: "c1" })).result.content[0].text).toBe('{"id":"m6","channel":"c1","place":"pet:sibling@c1"}');
    // Channels are Household's ids, and only the pet's own: a raw id is no way to post somewhere else.
    const refused = async (args: object) => {
      const { result } = await replyTo(args);
      expect(result.isError).toBe(true);
      return result.content[0].text;
    };
    const raw = "is not a Household id: use an id from a header (event.id, from.id, channel.id)";
    expect(await refused({ text: "x", chat_id: 1 })).toBe("unknown arguments: chat_id (reply takes: place, text, format, buttons, channel)");
    expect(await refused({ text: "x", channel: 100200300 })).toBe(`100200300 ${raw}`);
    expect(await refused({ text: "x", channel: "General" })).toBe(`General ${raw}`);
    expect(await refused({ text: "x", channel: "c2" })).toBe("there is no channel c2 in your workspace (yours: c1): use one of them, or leave channel out");
    const react = (args: object) => callMcp(paths, "sibling", { method: "tools/call", params: { name: "react", arguments: args } });
    expect((await react({ channel: "c1", message: "m2", emoji: "👍" })).result).toEqual({ content: [{ type: "text", text: '{"id":"m2","reaction":"👍"}' }] });
    expect(channel.calls).toContain("react how's it going?: 👍"); // m2: the person's message, by its channel ref
    expect((await react({ channel: "c1", message: "m2", emoji: "" })).result.content[0].text).toBe('{"id":"m2","reaction":null}');
    expect((await react({ channel: "c1", message: "m2", emoji: "👍", chat_id: 1 })).result.content[0].text).toBe("unknown arguments: chat_id (react takes: channel, message, emoji)");
    expect((await react({ message: "m2", emoji: "👍" })).result).toEqual({ content: [{ type: "text", text: "channel must be a Household id (a string), e.g. from a header" }], isError: true });
    for (const message of ["500", 500]) {
      expect((await react({ channel: "c1", message, emoji: "👍" })).result).toEqual({ content: [{ type: "text", text: `500 ${raw}` }], isError: true });
    }
    const ghost = await callMcp(paths, "ghost", { method: "tools/call", params: { name: "reply", arguments: { text: "x" } } });
    expect(ghost.result).toEqual({ content: [{ type: "text", text: "unknown bot work/ghost" }], isError: true });
  } finally {
    await daemon.stop();
  }
  expect(channels.get("work")!.stopped).toBe(true);
});

test("a dialog hook waits for the person's press in the chat and gets claude's answer; a reply's buttons come back as a message", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await connect(config, "work");
  const daemon = await startDaemon(deps);
  try {
    const channel = channels.get("work")!;
    await waitFor(() => channel.calls.length > 0); // the start notice
    const tool_input = { questions: [{ question: "Red or green?", options: [{ label: "Red" }, { label: "Green" }], multiSelect: false }] };
    const hook = postEvent(paths, "sibling", { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input });
    await waitFor(() => channel.calls.some((call) => call.includes("Sibling asks")));
    const card = `post-${channel.calls.length}`;
    await channel.press(card, 1, "Green", { place: "c1" });
    expect(await (await hook).json()).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...tool_input, answers: { "Red or green?": "Green" } } } },
    });

    const call = { name: "reply", arguments: { text: "More?", buttons: [["Yes", "No"]] } };
    const reply = await callMcp(paths, "sibling", { method: "tools/call", params: call });
    const posted = `post-${channel.calls.length}`;
    const { id, channel: where } = JSON.parse(reply.result.content[0].text);
    expect(where).toBe("c1");
    expect(channel.calls.at(-1)).toBe("post 🤖 Sibling: More? {Yes|No}");
    const bad = { name: "reply", arguments: { text: "x", buttons: ["Yes"] } };
    expect((await callMcp(paths, "sibling", { method: "tools/call", params: bad })).result).toEqual({
      content: [{ type: "text", text: 'buttons must be rows of labels, e.g. [["Yes", "No"]]' }],
      isError: true,
    });
    runtime.execs = [];
    await channel.press(posted, 0, "Yes", { place: "c1" });
    await waitFor(() => runtime.execs.some((exec) => exec.includes("load-buffer")));
    const header = `{"event":{"kind":"button","label":"Yes","on":{"id":"${id}","excerpt":"More?"}},"from":{"id":"p1","name":"Oleg","trust":"owner"},"channel":{"id":"c1","kind":"telegram-private","name":"Telegram Bot DM (threaded)","audience":"private","replyFormat":${replyFormatJson}},"place":{"id":"inbox@c1","kind":"house-inbox","title":"General"}}`;
    expect(runtime.execs).toContain(`household.work.sibling: tmux load-buffer -b household - < <household-message>\n<household-header>\n${header}\n</household-header>\n</household-message>`);
  } finally {
    await daemon.stop();
  }
});

test("claude's permission card retires old progress, preserves its waiting state for following tools and answers the hook", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await connect(config, "work");
  const daemon = await startDaemon(deps);
  try {
    const channel = channels.get("work")!;
    await waitFor(() => channel.calls.length > 0); // the start notice
    await channel.say(text("clean up the archives"));
    await waitFor(() => runtime.execs.some((exec) => exec.includes("load-buffer")), 5_000);
    const typed = runtime.execs.find((exec) => exec.includes("load-buffer"))!.split(" < ").slice(1).join(" < ");
    const event = (payload: object) => postEvent(paths, "sibling", { prompt_id: "t1", ...payload });
    await waitFor(() => channel.calls.some(call => call.includes("From General:")));
    await event({ hook_event_name: "UserPromptSubmit", prompt: typed });
    const tool_input = { command: 'rm "$x/$f.gz"', description: "Remove the extracted archive" };
    await event({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input, tool_use_id: "c1" });
    await waitFor(() => channel.statuses.length === 1, 5_000);
    // Keep the simulated native dialog visible while the card and its new progress segment post.
    runtime.output = () => "Do you want to proceed?\n❯ 1. Yes\n  2. No";
    const hook = event({ hook_event_name: "PermissionRequest", permission_mode: "bypassPermissions", tool_name: "Bash", tool_input });
    await waitFor(() => channel.calls.some((call) => call.includes("Sibling asks for permission")));
    const permissionRef = `post-${channel.calls.length}`;
    expect(channel.calls.at(-1)).toBe('notice General: 🤖 Sibling asks for permission (an action inside its VM):\n\nBash: rm "$x/$f.gz"\n(Remove the extracted archive)\n\nNo answer in 30 s means no. {Yes|No}');
    await waitFor(() => channel.statuses.at(-1) === "drop status-1", 5_000);
    // The permission card remains answerable. Further work gets a new status below it,
    // retaining the real outstanding permission instead of completing that call.
    const nextInput = { command: "df", description: "Shows disk space" };
    await event({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: nextInput, tool_use_id: "c2" });
    await waitFor(() => channel.statuses.at(-1) === "post status-2 🤖 Sibling: working Waiting for permission: Remove the extracted archive [Stop]", 5_000);
    await channel.press(permissionRef, 0, "Yes", { place: "c1" });
    expect(await (await hook).json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(channel.calls.at(-1)).toMatch(/^resolve post-\d+: Allowed$/);
    await event({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input, tool_use_id: "c1", duration_ms: 40 });
    await event({ hook_event_name: "Stop", last_assistant_message: "" });
    await waitFor(() => channel.statuses.at(-1) === "drop status-2", 5_000); // finished: the new segment goes
  } finally {
    await daemon.stop();
  }
}, 20_000);

test("a message queued when the daemon stopped is delivered after the restart", async () => {
  const { paths, config, runtime, deps, network } = setup();
  const store = new SqliteStore(`${tempDir()}/household.db`);
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  runtime.output = () => "Do you want to proceed?\n❯ 1. Yes\n  2. No"; // a dialog: nothing is pasted
  const first = await startDaemon({ ...deps, messages: store });
  await callControl(paths.socket, "/send", { house: "work", pet: "sibling", text: "stay in touch" });
  await first.stop();
  expect(runtime.execs.some((exec) => exec.includes("load-buffer"))).toBe(false);

  runtime.output = () => READY;
  const second = await startDaemon({ ...deps, network: network(), messages: store });
  try {
    await waitFor(() => runtime.execs.includes("household.work.sibling: tmux load-buffer -b household - < stay in touch"));
  } finally {
    await second.stop();
  }
});

test("a house whose token is not a bot's runs without a chat, says so in the log and the reload's answer, and gets it once fixed", async () => {
  const { paths, config, lines, deps } = setup();
  await config.createHouse("work");
  await connect(config, "work", "not-a-bot-token");
  const state = new SqliteStore(":memory:");
  const telegramApi = "http://127.0.0.1:1"; // nothing answers: the channel only fails to poll
  const daemon = await startDaemon({ ...deps, openChannels: openChannels({ state, events: deps.events, telegramApi }) });
  const problem = "its token is not a bot token (one looks like 123456789:AAH4x…, from @BotFather)";
  try {
    expect(lines.some((line) => line.includes(`ERROR workspace work, channel Telegram Bot DM (threaded): ${problem}`))).toBe(true);
    const missing = await callControl<ReloadReport>(paths.socket, "/reload");
    expect(missing!.warnings).toEqual([`workspace work, channel Telegram Bot DM (threaded): ${problem}`]);
    expect(lines.filter((line) => line.includes(problem))).toHaveLength(1); // logged once, not every reload
    await config.updateChannel("work", "1", { token: BOT });
    expect((await callControl<ReloadReport>(paths.socket, "/reload"))!.warnings).toEqual([]);
  } finally {
    await daemon.stop();
  }
});

test("a bot serves one house, whatever its token", async () => {
  const { paths, config, lines, deps } = setup();
  for (const [house, token] of [["work", BOT], ["home", "777:another-token-of-the-same-bot-0000"]] as const) {
    await config.createHouse(house);
    await connect(config, house, token);
  }
  const state = new SqliteStore(":memory:");
  const telegramApi = "http://127.0.0.1:1"; // nothing answers: these channels only fail to poll
  const daemon = await startDaemon({ ...deps, openChannels: openChannels({ state, events: deps.events, telegramApi }) });
  try {
    expect(lines.some((line) => line.includes("ERROR workspace home, channel Telegram Bot DM (threaded): its bot is house work's, and a bot serves one house; no chat there"))).toBe(true);
    expect((await status(paths.socket))!.subjects.map((s) => s.subject.name)).toEqual(["work", "home"]);
  } finally {
    await daemon.stop();
  }
});

/** `house start` (over a fake VM runtime) as a process; `HANG_BUILD`: its image build waits until cancelled. */
async function daemonProcess(config = "daemon:\n  agentPort: 0 # any free port: never the real daemon's\n  webPort: 0\n", hang = false) {
  const dirs = { HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() };
  const paths = resolvePaths(dirs);
  writeFileSync(paths.configFile, config);
  const env: Record<string, string | undefined> = { ...process.env, ...dirs, HOUSEHOLD_TELEGRAM_API: undefined, HANG_BUILD: hang ? "1" : undefined };
  const proc = Bun.spawn(["bun", join(import.meta.dir, "run-daemon.ts")], { env, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then((parts) => parts.join(""));
  return { paths, proc, output };
}

async function reaches(socket: string, proc: Bun.Subprocess, state: StatusReport["state"]): Promise<void> {
  const deadline = Date.now() + 5000;
  while ((await status(socket).catch(() => undefined))?.state !== state) {
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`the daemon did not reach ${state}`);
    await Bun.sleep(20);
  }
}

test("as a process: SIGTERM stops it cleanly (exit 0), also while it starts, and a second one does not kill it; a failed start exits 1", async () => {
  const term = await daemonProcess();
  const withPet = "daemon:\n  agentPort: 0\n  webPort: 0\nkeys:\n  claude: {provider: anthropic, value: sk-ant-oat01-process}\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {key: claude}\n";
  const starting = await daemonProcess(withPet, true);
  try {
    await reaches(term.paths.socket, term.proc, "running");
    term.proc.kill("SIGTERM");
    term.proc.kill("SIGTERM");
    expect(await term.proc.exited).toBe(0);
    expect(await term.output).toContain("SIGTERM: stopping");
    expect(await term.output).toContain("stopped");
    expect(existsSync(term.paths.socket)).toBe(false);

    await reaches(starting.paths.socket, starting.proc, "starting"); // its pet's image is being built
    starting.proc.kill("SIGINT");
    expect(await starting.proc.exited).toBe(0);
    expect(await starting.output).toContain("stopped while starting (cancelled)");
  } finally {
    term.proc.kill(); // exact PIDs: only these test daemons, if a check above failed
    starting.proc.kill();
  }

  const broken = await daemonProcess("houses:\n  work: {}\n");
  expect(await broken.proc.exited).toBe(1);
  expect(await broken.output).toContain("invalid config");
}, 15_000);

test("network approvals apply only network policy: temporary grants are the pet's, survive restart, expire, appear in admin and revoke; permanent grants enter config", async () => {
  const { paths, config, runtime, deps, network, channels } = setup();
  const clock = fakeClock();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await connect(config, "work");
  // The domain's addresses, as the stub DNS answers: what the owner is shown and the grant is pinned to.
  const networkResolve = async (host: string) => (host === "localtest.me" ? ["127.0.0.1"] : ["140.82.112.6"]);
  let daemon = await startDaemon({ ...deps, networkClock: clock, networkResolve });
  const request = async (domain: string, index: number) => {
    const channel = channels.get("work")!;
    const before = channel.calls.length;
    const pending = callMcp(paths, "sibling", { method: "tools/call", params: {
      name: "network_request", arguments: { domain, reason: "GitHub API for the requested issue lookup" },
    } });
    await waitFor(() => channel.calls.slice(before).some((line) => line.includes(`wants to reach ${domain}</b>`)));
    const card = `post-${channel.calls.length}`;
    await channel.press(card, index, ["Allow 15 min", "Allow forever", "Deny"][index]!);
    // For good is asked again, on the same card.
    if (index === 1) {
      expect(channel.calls.at(-1)).toBe(`choices ${card}: {Yes, forever}{Cancel}`);
      await channel.press(card, 0, "Yes, forever");
    }
    return JSON.parse((await pending).result.content[0].text);
  };
  try {
    const runs = runtime.calls.filter((line) => line === "run household.work.sibling").length;
    expect((await request("api.github.com", 0)).status).toBe("temporary");
    expect(channels.get("work")!.calls.some((line) => line.includes("Resolves to: <code>140.82.112.6</code>"))).toBe(true);
    const grants = () => policyOf(paths).rules[0]!.grants ?? [];
    const first = (await status(paths.socket))!.subjects[0]!.grants?.find(({ entry }) => entry.host === "api.github.com");
    expect(first).toEqual({ pet: "sibling", entry: { host: "api.github.com", port: 443, expiresAt: 900_000, reach: { pinned: ["140.82.112.6"] } } });
    expect(policyOf(paths).rules[0]!.policy.allow.some(({ host }) => host === "api.github.com")).toBe(false);
    expect((await config.load()).houses[0]!.network.allow).toEqual([]);
    expect(runtime.calls.filter((line) => line === "run household.work.sibling")).toHaveLength(runs);
    await daemon.stop();
    clock.tick(60_000);
    daemon = await startDaemon({ ...deps, network: network(), networkClock: clock, networkResolve });
    expect((await status(paths.socket))!.subjects[0]!.grants).toContainEqual(first!);
    clock.tick(840_000);
    await waitFor(() => grants().length === 0);
    expect((await request("api.github.com", 0)).status).toBe("temporary");
    const dashboard = await callControl<DashboardLink>(paths.socket, "/dashboard");
    if (!dashboard || !("url" in dashboard)) throw new Error("web UI off");
    const origin = new URL(dashboard.url).origin;
    const login = await fetch(dashboard.url, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const shown = await (await fetch(`${origin}/api/houses/work`, { headers: { cookie } })).json() as { temporary: { domain: string; expiresAt: number }[] };
    expect(shown.temporary).toMatchObject([{ pet: "sibling", domain: "api.github.com", addresses: ["140.82.112.6"], expiresAt: 1_800_000 }]);
    expect((await fetch(`${origin}/api/houses/work/temporary/api.github.com?pet=sibling`, { method: "DELETE", headers: { cookie, origin } })).status).toBe(200);
    expect((await status(paths.socket))!.subjects[0]!.grants).toEqual([]);
    expect((await request("api.github.com", 1)).status).toBe("permanent");
    // A grant approved for good is the house's, kept apart from the owner's allowlist: public addresses only.
    expect((await config.load()).houses[0]!.network.allow).toContainEqual({ host: "api.github.com", port: 443, reach: "public" });
    expect(readFileSync(paths.configFile, "utf8")).toContain("granted:\n        - api.github.com\n");
    // A name that leads to the host itself is refused before any card: its owner is told instead.
    const before = channels.get("work")!.calls.length;
    const refused = JSON.parse((await callMcp(paths, "sibling", { method: "tools/call", params: {
      name: "network_request", arguments: { domain: "localtest.me", port: 8080, reason: "a local dev server" },
    } })).result.content[0].text);
    expect(refused.status).toBe("refused");
    const posted = channels.get("work")!.calls.slice(before);
    expect(posted.some((line) => line.includes("localtest.me:8080") && line.includes("127.0.0.1"))).toBe(true);
    expect(posted.some((line) => line.includes("wants to reach"))).toBe(false);
  } finally { await daemon.stop(); }
}, 15_000);

test("a pet removed from the config takes its temporary grants with it, out of the gateway, on the reload", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await config.addPet("work", "chair", { title: "Chair", key: "claude" });
  await connect(config, "work");
  const daemon = await startDaemon({ ...deps, networkResolve: async () => ["140.82.112.6"] });
  try {
    for (const pet of ["sibling", "chair"]) {
      const channel = channels.get("work")!;
      const before = channel.calls.length;
      const pending = callMcp(paths, pet, { method: "tools/call", params: {
        name: "network_request", arguments: { domain: "api.github.com", reason: "GitHub API for the requested issue lookup" },
      } });
      await waitFor(() => channel.calls.slice(before).some((line) => line.includes("wants to reach api.github.com</b>")));
      await channel.press(`post-${channel.calls.length}`, 0, "Allow 15 min");
      expect(JSON.parse((await pending).result.content[0].text).status).toBe("temporary");
    }
    const grants = () => policyOf(paths).rules[0]!.grants ?? [];
    expect(grants().map(({ pet }) => pet).sort()).toEqual(["chair", "sibling"]);
    await config.removePet("work", "sibling");
    await callControl(paths.socket, "/reload");
    expect(grants().map(({ pet }) => pet)).toEqual(["chair"]);
    expect((await status(paths.socket))!.subjects[0]!.grants!.map(({ pet }) => pet)).toEqual(["chair"]);
  } finally { await daemon.stop(); }
}, 15_000);

test("failed startup setup starts repair through normal delivery and exposes a scoped rerun without restarting the pet", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  const result = { status: "failed" as "failed" | "complete", logPath: "/home/pet/environment/setup.log", statusPath: "/home/pet/environment/setup.status" };
  const reruns: string[] = [];
  const scripts: (string | undefined)[] = [];
  Object.assign(runtime, {
    environmentSetupResult: () => result,
    runEnvironmentSetup: async (name: string, setup?: string) => { reruns.push(name); scripts.push(setup); return { ...result, status: "complete" as const }; },
  });
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  await connect(config, "work");
  const daemon = await startDaemon(deps);
  try {
    await waitFor(() => runtime.execs.some((entry) => entry.includes("Household: environment setup failed on this boot")), 5_000);
    expect(channels.get("work")!.calls.some((entry) => entry.includes("The setup script failed"))).toBe(true);
    const launches = runtime.calls.filter((entry) => entry.startsWith("run "));
    const saved = await callMcp(paths, "sibling", { method: "tools/call", params: { name: "environment_update", arguments: { setup: "printf configured" } } });
    expect(saved.result.isError).toBeUndefined();
    expect(JSON.parse(saved.result.content[0].text).setup).toBe("printf configured");
    expect((await config.load()).houses[0]!.pets[0]!.environment?.setup).toBe("printf configured");
    expect((await callMcp(paths, "sibling", { method: "tools/call", params: { name: "environment_update", arguments: { setup: "attack", pet: "other" } } })).result.isError).toBe(true);
    const rerun = await callMcp(paths, "sibling", { method: "tools/call", params: { name: "environment_setup", arguments: {} } });
    expect(JSON.parse(rerun.result.content[0].text).status).toBe("complete");
    expect(reruns).toEqual(["household.work.sibling"]);
    expect(scripts).toEqual(["printf configured"]);
    expect(runtime.calls.filter((entry) => entry.startsWith("run "))).toEqual(launches);
    const promptsBefore = runtime.execs.filter((entry) => entry.includes("Household: environment setup failed on this boot")).length;
    await callControl(paths.socket, "/reload");
    const loaded = await callMcp(paths, "sibling", { method: "tools/call", params: { name: "environment_get", arguments: {} } });
    expect(JSON.parse(loaded.result.content[0].text).setup).toBe("printf configured");
    expect(runtime.calls.filter((entry) => entry.startsWith("run "))).toEqual(launches);
    await callMcp(paths, "sibling", { method: "tools/call", params: { name: "environment_update", arguments: { setup: "" } } });
    expect((await config.load()).houses[0]!.pets[0]!.environment).toBeUndefined();
    expect(runtime.execs.filter((entry) => entry.includes("Household: environment setup failed on this boot"))).toHaveLength(promptsBefore);
  } finally {
    await daemon.stop();
  }
});

test("web VM restart uses latest saved setup, preserves the VM and recovers after startup failure", async () => {
  const { paths, config, runtime, deps, channels } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  await connect(config, "work");
  const lifecycle: string[] = [];
  let fail = false;
  Object.assign(runtime, {
    configureEnvironmentSetup: (_name: string, setup?: string) => { lifecycle.push(`setup ${setup}`); },
    stopContainer: async (name: string) => { lifecycle.push("stop"); runtime.containers.get(name)!.state = "stopped"; },
    startContainer: async (name: string) => { lifecycle.push("start"); if (fail) throw new Error("fixture start failure"); runtime.containers.get(name)!.state = "running"; },
  });
  const daemon = await startDaemon(deps);
  try {
    const dashboard = await callControl<DashboardLink>(paths.socket, "/dashboard");
    if (!dashboard || !("url" in dashboard)) throw new Error("web UI off");
    const origin = new URL(dashboard.url).origin;
    const login = await fetch(dashboard.url, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { cookie, origin, "content-type": "application/json" };
    const path = `${origin}/api/houses/work/pets/sibling/environment`;
    const identity = runtime.containers.get("household.work.sibling");
    const births = runtime.calls.filter((entry) => entry.startsWith("run ")).length;
    expect((await fetch(path, { method: "PATCH", headers, body: JSON.stringify({ setup: "printf latest" }) })).status).toBe(200);
    lifecycle.length = 0;
    const notices = channels.get("work")!.calls;
    notices.length = 0;
    expect((await fetch(`${path}/restart`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(lifecycle).toEqual(["setup printf latest", "stop", "start"]);
    expect(notices).toEqual(["notice 🤖 Sibling: 🤖 Sibling stopped.", "notice 🤖 Sibling: 🤖 Sibling started."]);
    notices.length = 0;
    expect(runtime.containers.get("household.work.sibling")).toBe(identity);
    expect(runtime.calls.filter((entry) => entry.startsWith("run "))).toHaveLength(births);
    fail = true;
    expect((await fetch(`${path}/restart`, { method: "POST", headers, body: "{}" })).status).toBe(500);
    expect(notices).toEqual(["notice 🤖 Sibling: 🤖 Sibling stopped."]);
    const execCount = runtime.execs.length;
    await callControl(paths.socket, "/send", { house: "work", pet: "sibling", text: "wait until recovery" });
    await Bun.sleep(20);
    expect(runtime.execs).toHaveLength(execCount);
    fail = false;
    expect((await fetch(`${path}/restart`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    await waitFor(() => runtime.execs.some((entry) => entry.includes("wait until recovery")), 5000);
    expect(runtime.containers.get("household.work.sibling")).toBe(identity);
  } finally {
    await daemon.stop();
  }
});

test("host scheduler MCP -> durable inbox -> pet session, with Household clock and no Telegram post", async()=>{
  const {paths,config,runtime,deps,channels}=setup();
  await config.createHouse("work");await config.addPet("work","sibling",{key:"claude"});await config.setTimezone("UTC");await connect(config,"work");
  runtime.output=()=>READY;
  const daemon=await startDaemon({...deps,crons:deps.messages.crons});
  try {
    const channel=channels.get("work")!;const before=channel.calls.length;
    const created=await callMcp(paths,"sibling",{method:"tools/call",params:{name:"cron_create",arguments:{name:"Scheduled probe",body:"Read your own notes silently.",at:new Date(Date.now()+100).toISOString().slice(0,-1)}}});
    expect(created.result.isError).toBeUndefined();
    await waitFor(()=>runtime.execs.some(x=>x.includes("load-buffer")&&x.includes("Read your own notes silently.")),4000);
    const prompt=runtime.execs.find(x=>x.includes("load-buffer")&&x.includes("Read your own notes silently."))!;
    expect(prompt).toContain("<household-clock>");expect(prompt).toContain('"timezone":"UTC"');
    expect(channel.calls).toHaveLength(before);expect(channel.statuses).toHaveLength(0);
    const listed=await callMcp(paths,"sibling",{method:"tools/call",params:{name:"cron_list",arguments:{}}});
    const view=JSON.parse(listed.result.content[0].text);
    expect(view.timezone).toBe("UTC");expect(view.runs).toHaveLength(1);
  }finally{await daemon.stop();}
});

test("disabled pets stay stopped across daemon restart and enable reuses the same VM", async () => {
  const { paths, config, runtime, deps, network, channels } = setup();
  runtime.output = () => READY;
  Object.assign(runtime, {
    stopContainer: async (name: string) => { runtime.calls.push(`stop ${name}`); runtime.containers.get(name)!.state = "stopped"; },
    startContainer: async (name: string) => { runtime.calls.push(`start ${name}`); runtime.containers.get(name)!.state = "running"; },
  });
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  await connect(config, "work");
  let daemon = await startDaemon(deps);
  try {
    const notices = channels.get("work")!.calls;
    notices.length = 0;
    const vm = runtime.containers.get("household.work.sibling");
    await config.updatePet("work", "sibling", { enabled: false });
    await callControl(paths.socket, "/reload");
    expect((await status(paths.socket))!.pets[0]!.state).toBe("disabled");
    expect(vm!.state).toBe("stopped");
    expect(notices).toEqual(["notice 🤖 Sibling: 🤖 Sibling stopped."]);
    notices.length = 0;
    await callControl(paths.socket, "/reload");
    expect(notices).toEqual([]);
    await daemon.stop();
    daemon = await startDaemon({ ...deps, network: network(), pets: testServices(paths, runtime).pets });
    expect((await status(paths.socket))!.pets[0]!.state).toBe("disabled");
    expect(runtime.containers.get("household.work.sibling")).toBe(vm);
    expect(channels.get("work")!.calls).toEqual([]);
    await config.updatePet("work", "sibling", { enabled: true });
    await callControl(paths.socket, "/reload");
    expect((await status(paths.socket))!.pets[0]!.state).toBe("running");
    expect(channels.get("work")!.calls).toEqual(["notice 🤖 Sibling: 🤖 Sibling started."]);
    expect(runtime.containers.get("household.work.sibling")).toBe(vm);
  } finally { await daemon.stop(); }
});

test("secret add/rotate/remove hot-applies gateway rules without restarting a pet or granting network", async () => {
  const { paths, config, runtime, deps } = setup();
  runtime.output = () => READY;
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  const daemon = await startDaemon(deps);
  try {
    const lifecycle = () => runtime.calls.filter(line => /^(?:start|stop|launch|rm|create) /.test(line));
    const before = lifecycle();
    const api = (method: string, path: string, body?: object) => callControl<ApiAnswer>(paths.socket, "/api", { method, path, body });
    const added = await api("POST", "/api/houses/work/secrets", { name: "qa", value: "qa-hot-one", hosts: ["example.com"], env: "SECRET_QA" });
    expect(added!.status).toBe(201);
    expect(lifecycle()).toEqual(before);
    expect(policyOf(paths).rules[0]!.intercept).toContainEqual({ host: "example.com", port: 443 });
    expect(policyOf(paths).rules[0]!.policy.allow.some(entry => entry.host === "example.com")).toBe(false);
    expect(readFileSync(`${paths.gatewaySecretsDir}/secret.work.qa`, "utf8")).toBe("qa-hot-one");
    expect((await api("PATCH", "/api/houses/work/secrets/qa", { value: "qa-hot-two" }))!.status).toBe(200);
    expect(readFileSync(`${paths.gatewaySecretsDir}/secret.work.qa`, "utf8")).toBe("qa-hot-two");
    expect(lifecycle()).toEqual(before);
    expect((await api("DELETE", "/api/houses/work/secrets/qa"))!.status).toBe(200);
    expect(policyOf(paths).rules[0]!.intercept.some(entry => entry.host === "example.com")).toBe(false);
    expect(lifecycle()).toEqual(before);
  } finally { await daemon.stop(); }
});

test("reload rejects an out-of-process pet growth that overcommits active helpers", async () => {
  const { paths, config, deps, runtime } = setup();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { agent: "claude-code-tmux", key: "claude", cpus: 2, memoryMiB: 1024 });
  deps.records.set("sideworkers.v1", JSON.stringify([{ house: "work", name: "sw-one", parent: "sibling", cwd: "/home/agent", createdAt: 1, cpus: 6, memoryMiB: 1024 }]));
  const daemon = await startDaemon(deps);
  try {
    // Simulate a hand edit or an older CLI with no live allocation callback.
    await new ConfigStore(paths.configFile).updatePet("work", "sibling", { cpus: 4 });
    const before = [...runtime.calls];
    await expect(callControl(paths.socket, "/reload")).rejects.toThrow("resource budget exceeded");
    expect(runtime.calls).toEqual(before);
    // Closing the helper, as the error says, gets it back under the budget: its own reload is not refused.
    const closed = await callControl<{status: number}>(paths.socket, "/api", {method: "DELETE", path: "/api/houses/work/sideworkers/sw-one"});
    expect(closed!.status).toBe(200);
  } finally { await daemon.stop(); }
});

test("startup keeps management available for legacy overcommit with disabled pet reservations", async () => {
  const { config, deps, paths } = setup();
  await config.createHouse("work");
  await config.addPet("work", "sibling", { agent: "claude-code-tmux", key: "claude", cpus: 6, memoryMiB: 1024, enabled: false });
  deps.records.set("sideworkers.v1", JSON.stringify([{ house: "work", name: "sw-one", parent: "sibling", cwd: "/home/agent", createdAt: 1, cpus: 4, memoryMiB: 1024 }]));
  const daemon = await startDaemon(deps);
  try {
    const budget = await callControl<{status: number; body: {available: {cpus: number}}}>(paths.socket, "/api", {method: "GET", path: "/api/houses/work/resources"});
    expect(budget!.status).toBe(200);
    expect(budget!.body.available.cpus).toBe(0);
    const closed = await callControl<{status: number}>(paths.socket, "/api", {method: "DELETE", path: "/api/houses/work/sideworkers/sw-one"});
    expect(closed!.status).toBe(200);
  } finally { await daemon.stop(); }
});
