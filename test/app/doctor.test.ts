import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { knownAgents } from "../../src/app/agents";
import { doctor, type DoctorDeps } from "../../src/app/doctor";
import { VERSION } from "../../src/app/version";
import { ConfigStore } from "../../src/infra/config-store";
import { resolvePaths } from "../../src/infra/paths";
import { fakeTelegram } from "../fake-telegram";
import { tempDir } from "../helpers";

const GOOD = "4242:good-token-of-the-house-bot-0001";
const telegram = fakeTelegram(GOOD);
afterAll(() => telegram.stop());

async function setup(run: DoctorDeps["run"], released?: DoctorDeps["released"]) {
  const paths = resolvePaths({ HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() });
  const config = new ConfigStore(paths.configFile);
  const check = () => doctor({ paths, config, agents: knownAgents(), run, telegramApi: telegram.url, ...(released ? { released } : {}) });
  return { paths, config, check };
}

const healthy: DoctorDeps["run"] = async ([command]) => ({
  ok: true,
  stdout: command === "msb" ? "msb 0.7.13" : command === "docker" ? "OrbStack, Docker 29.4.0" : "OpenSSL 4.0.3 29 Sep 2026",
  stderr: "",
});

/** A house with a pet on key `claude` and a private chat with the bot of `token`. */
async function house(config: ConfigStore, token = GOOD, chat = "1") {
  await config.addKey("claude", { provider: "anthropic", value: "sk-ant-oat01-doctor-test" });
  await config.createHouse("work");
  await config.addPet("work", "sibling", { key: "claude" });
  await config.addOwner("work", "telegram", "1");
  await config.addChannel("work", { kind: "telegram-private", token, chat });
}

test("all good: every check passes (the daemon may be down); each key with its pets, each bot with Telegram", async () => {
  const { paths, config, check } = await setup(healthy);
  await house(config);
  expect(await check()).toEqual([
    { ok: true, text: "docker: OrbStack, Docker 29.4.0" },
    { ok: true, text: "microsandbox: 0.7.13, virtualization ready" },
    { ok: true, text: "python3: file helpers ready (skills, instructions, inbox)" },
    { ok: true, text: "openssl: OpenSSL 4.0.3 29 Sep 2026" },
    { ok: true, text: `config: valid, houses: work, pets: 1 (${paths.configFile})` },
    { ok: true, text: "key claude (subscription): pets work/sibling" },
    { ok: true, text: "bot of house work, channel Telegram Bot DM (threaded): @fake_bot, threads on" },
    { ok: true, text: "daemon: not running; start it with `house start`" },
  ]);
  expect(telegram.calls.map((call) => call.method)).toEqual(["getMe"]); // the only network call
});

test("each problem is said in plain words: no docker or openssl, a config others can read, a refused token, a pet with no key", async () => {
  const { paths, config, check } = await setup(async () => ({ ok: false, stdout: "", stderr: "failed to connect to the docker API at unix:///x\nmore" }));
  await house(config, "4242:wrong-token-telegram-does-not-know");
  chmodSync(paths.configFile, 0o644);
  const findings = await check();
  expect(findings.filter((finding) => finding.ok === false).map((finding) => finding.text)).toEqual([
    "docker: not reachable (failed to connect to the docker API at unix:///x); start OrbStack (or Docker)",
    "microsandbox: requires 0.7.13; install the pinned runtime",
    "python3: required for house skills, pet instructions and inbox files",
    "openssl: not found; Household makes its certificates with it, install it",
    `config: others can read it (mode 644), and it holds keys and bot tokens; chmod 600 ${paths.configFile}`,
    "bot of house work, channel Telegram Bot DM (threaded): Telegram did not accept the token (getMe: 401 Unauthorized)",
  ]);
  expect(JSON.stringify(findings)).not.toContain("wrong"); // never the token
  expect(JSON.stringify(findings)).not.toContain("doctor-test"); // nor the key

  // Its only key gone, by hand: the config check says so.
  writeFileSync(paths.configFile, (await Bun.file(paths.configFile).text()).replace(/keys:\n(  .*\n)+/, ""));
  expect((await check()).some((finding) => !finding.ok && finding.text.includes("pet work/sibling: unknown key 'claude' (the Household has none: add one under keys:)"))).toBe(true);
});

test("a private chat whose person is not among the house's owners is a warning, not a failure", async () => {
  const { config, check } = await setup(healthy);
  await house(config, GOOD, "2");
  const findings = await check();
  expect(findings.filter((finding) => finding.warning)).toEqual([
    { ok: true, warning: true, text: "channel Telegram Bot DM (threaded) of house work: its chat 2 is not among the owners, so its person is a guest there (`house owner add work telegram 2` if they are yours)" },
  ]);
  expect(findings.every((finding) => finding.ok)).toBe(true);
});

test("an invalid config fails its check and skips the bots it would name", async () => {
  const { paths, check } = await setup(healthy);
  writeFileSync(paths.configFile, "houses:\n  work:\n    pets:\n      sibling: { agent: codex }\n    network: { allow: [] }\n", { mode: 0o600 });
  const findings = await check();
  expect(findings.map((finding) => finding.ok)).toEqual([true, true, true, true, false, true]);
  expect(findings[4]!.text).toContain("pet work/sibling: unknown agent 'codex'");
});

test("a Telegram that does not answer is unreachable, not a refusal", async () => {
  const { paths, config } = await setup(healthy);
  await house(config);
  const nowhere = await doctor({ paths, config, agents: knownAgents(), run: healthy, telegramApi: "http://127.0.0.1:1" });
  expect(nowhere.filter((finding) => finding.text.startsWith("bot"))).toEqual([
    { ok: false, text: "bot of house work, channel Telegram Bot DM (threaded): Telegram unreachable (getMe: unreachable)" },
  ]);
});

test("an owner the config names wrong is a config failure", async () => {
  const { paths, check } = await setup(healthy);
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, "houses:\n  work:\n    network: {allow: []}\n    people: {owners: {telegram: ['@oleg']}}\n", { mode: 0o600 });
  const config = (await check()).find((finding) => finding.text.startsWith("config:"));
  expect(config).toEqual({ ok: false, text: "config: houses.work.people.owners.telegram: '@oleg' is not a Telegram user id (A number; @userinfobot tells yours.)" });
});

test("a token that is no bot token is a failure, and is never sent to Telegram", async () => {
  const { config, check } = await setup(healthy);
  await house(config, "sk-ant-not-a-bot-token");
  const before = telegram.calls.length;
  expect(await check()).toContainEqual({ ok: false, text: "bot of house work, channel Telegram Bot DM (threaded): its token is not a bot token (one looks like 123456789:AAH4x…, from @BotFather); not sent to Telegram" });
  expect(telegram.calls.length).toBe(before);
});

test("with every image released, Docker is not asked for; one built here needs it", async () => {
  const commands: string[] = [];
  const recording: DoctorDeps["run"] = async (command) => { commands.push(command[0]!); return healthy(command); };
  const { check } = await setup(recording, async (tag) => `ghcr.io/underwear/${tag}:v${VERSION}`);
  expect((await check())[0]).toEqual({ ok: true, text: `images: release v${VERSION} from ghcr.io/underwear, no Docker needed` });
  expect(commands).not.toContain("docker");
  const partly = await setup(async () => ({ ok: false, stdout: "", stderr: "no docker" }), async (tag) => tag.endsWith("codex-app-server") ? undefined : `ghcr.io/underwear/${tag}:v${VERSION}`);
  expect((await partly.check())[0]).toEqual({ ok: false, text: "docker: not reachable (no docker); start OrbStack (or Docker)" });
});
