import { HouseSkills, houseSkillsRoot } from "../../src/infra/house-skills";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedicatedAuthRoot } from "../../src/app/codex-auth-backup";
import { parseManifest, stamp, type BackupDeps } from "../../src/app/backup";
import { backupRuntime } from "../../src/app/backup-runtime";
import { exportHousehold } from "../../src/app/export";
import { importHousehold } from "../../src/app/import";
import { instanceId } from "../../src/app/pet-plane";
import { REPO_ROOT, VERSION } from "../../src/app/version";
import { checkoutCommit } from "../../src/infra/git";
import { ConfigStore } from "../../src/infra/config-store";
import { serveControl } from "../../src/infra/control-socket";
import { resolvePaths } from "../../src/infra/paths";
import { runCommand } from "../../src/infra/process";
import { SCHEMA_VERSION, SqliteStore } from "../../src/infra/sqlite-store";
import { packDir, unpackFile } from "../../src/infra/tarball";
import { tarArchive, tempDir } from "../helpers";
import { FakeRuntime } from "./fake-runtime";

const SIBLING = "household.work.sibling";
const HOME = `${SIBLING}.home`;
const NOW = new Date(2026, 10, 3, 22, 15, 7);
const BAK = `.bak-${NOW.getTime()}`;
const NEXT = "next: `house doctor`, then `house start`";
const TOKEN = "4242:the-bot-token";
const KEY = "sk-ant-oat01-the-key";

/** A Household with no config or state yet: its paths, a fake Docker, the lines it logs. */
function blank() {
  const paths = resolvePaths({ HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() });
  const runtime = new FakeRuntime();
  const lines: string[] = [];
  const deps: BackupDeps = { paths, runtime, log: (line) => lines.push(line), now: () => NOW };
  return { paths, runtime, lines, deps, owner: { "household.owner": instanceId(paths.stateDir) } };
}

/** House work: pet sibling (running, a home with files) and pet stool (never ran), a key and a bot token in the config; its TLS dir. */
async function household() {
  const setup = blank();
  const { paths, runtime } = setup;
  const config = new ConfigStore(paths.configFile);
  await config.addKey("claude", { provider: "anthropic", value: KEY });
  await config.createHouse("work");
  await config.addPet("work", "sibling", { title: "Sibling", key: "claude" });
  await config.addPet("work", "stool", { key: "claude" });
  await config.addOwner("work", "telegram", "1");
  await config.addChannel("work", { kind: "telegram-private", token: TOKEN, chat: "1" });
  const store = new SqliteStore(paths.database);
  store.set("telegram.offset", "42");
  store.close();
  runtime.volumes.set(HOME, { ".claude.json": "{}", "memory.md": "Oleg loves elephants" });
  runtime.containers.set(SIBLING, { state: "running", labels: setup.owner });
  mkdirSync(join(paths.tlsDir, "leaf"), { recursive: true });
  writeFileSync(join(paths.tlsDir, "ca.crt"), "CA-CERT", { mode: 0o644 });
  writeFileSync(join(paths.tlsDir, "ca.key"), "CA-KEY", { mode: 0o600 });
  writeFileSync(join(paths.tlsDir, "leaf", "leaf.key"), "LEAF-KEY", { mode: 0o600 });
  return setup;
}

async function exported() {
  const setup = await household();
  const file = join(tempDir(), "backup.tar.gz");
  await exportHousehold(setup.deps, file);
  setup.runtime.calls = [];
  return { ...setup, file };
}

/** Changes an archive: unpacked into a dir, `change`d there, packed again. */
async function altered(file: string, change: (dir: string) => void): Promise<string> {
  const dir = tempDir();
  await unpackFile(file, dir, 1e9);
  change(dir);
  const out = join(tempDir(), "altered.tar.gz");
  await packDir(dir, out);
  return out;
}

const fails = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("did not fail");
};

test("export: one archive (mode 600) of the manifest, the config (keys and tokens in it), the database, the CA and the homes; the running pet paused just for its home", async () => {
  const { deps, runtime, lines } = await household();
  const file = join(tempDir(), "backup.tar.gz");
  await exportHousehold(deps, file);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const listing = await runCommand(["tar", "-tzf", file]);
  expect(listing.stdout.split("\n").sort()).toEqual([
    "./",
    "./household.db",
    "./household.yaml",
    "./manifest.json",
    "./skills/",
    "./tls/",
    "./tls/ca.crt",
    "./tls/ca.key",
    "./volumes/",
    `./volumes/${HOME}.tar`,
  ]);
  expect(runtime.calls).toEqual([`pause ${SIBLING}`, `save ${HOME}`, `unpause ${SIBLING}`]);
  expect(runtime.containers.get(SIBLING)!.state).toBe("running");
  expect(lines).toEqual([
    `database: snapshot, schema ${SCHEMA_VERSION}`,
    "tls: ca.crt, ca.key",
    `pet work/sibling: home ${HOME} (paused while saved)`,
    "pet work/stool: no home yet, skipped",
  ]);
  const dir = tempDir();
  await unpackFile(file, dir, 1e9);
  const manifest = parseManifest(readFileSync(join(dir, "manifest.json"), "utf8"));
  // From a git checkout, its commit; from a plain copy, none.
  expect(manifest).toEqual({ format: 4, created: NOW.toISOString(), household: { version: VERSION, commit: await checkoutCommit(REPO_ROOT) }, schema: SCHEMA_VERSION });
  expect(statSync(join(dir, "household.yaml")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "tls", "ca.crt")).mode & 0o777).toBe(0o600);
  // The config's token and key and the CA key are in it, in plain form; the leaf (made again) and an old secret file are not.
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)));
  expect([TOKEN, KEY, "CA-KEY", "Oleg loves elephants", "LEAF-KEY"].map((part) => text.includes(part))).toEqual([true, true, true, true, false]);
});

test("portable export/import preserves config-owned setup without relying on a generated home copy", async () => {
  const source = await household();
  const setup = "#!/usr/bin/env bash\n# repeatable source\nprintf '%s\\n' 'Grüß dich $HOME'  \n\n";
  await new ConfigStore(source.paths.configFile).updatePetEnvironment("work", "sibling", { setup });
  // Deliberately different stale output: configuration must survive independently of materialized files.
  source.runtime.volumes.get(HOME)!["environment/setup.sh"] = "echo stale";
  const file = join(tempDir(), "setup-backup.tar.gz");
  await exportHousehold(source.deps, file);
  const target = blank();
  await importHousehold(target.deps, file);
  const restored = await new ConfigStore(target.paths.configFile).load();
  expect(restored.houses[0]!.pets[0]!.environment?.setup).toBe(setup);
  expect(target.runtime.volumes.get(HOME)!["environment/setup.sh"]).toBe("echo stale");
  expect(readFileSync(target.paths.configFile, "utf8")).toBe(readFileSync(source.paths.configFile, "utf8"));
});

test("export: the default name is household-<YYYYMMDD-HHMM>.tar.gz in the current dir; a stopped pet is saved as is, a paused one left paused", async () => {
  const { deps, runtime, lines } = await household();
  runtime.containers.get(SIBLING)!.state = "paused";
  const cwd = process.cwd();
  process.chdir(tempDir());
  try {
    const { file, bytes } = await exportHousehold(deps);
    expect(file).toBe(join(process.cwd(), `household-${stamp(NOW)}.tar.gz`));
    expect(bytes).toBe(statSync(file).size);
    expect(stamp(NOW)).toBe("20261103-2215");
  } finally {
    process.chdir(cwd);
  }
  expect(runtime.calls).toEqual([`save ${HOME}`]);
  expect(runtime.containers.get(SIBLING)!.state).toBe("paused");
  expect(lines).toContain(`pet work/sibling: home ${HOME} (it was paused, left so)`);
});

test("export refuses to write over a file, and needs a config and a database", async () => {
  const { deps, paths } = await household();
  const file = join(tempDir(), "taken.tar.gz");
  writeFileSync(file, "mine");
  expect(await fails(exportHousehold(deps, file))).toBe(`${file} exists; give another file name`);
  expect(readFileSync(file, "utf8")).toBe("mine");
  rmSync(paths.database);
  expect(await fails(exportHousehold(deps, join(tempDir(), "x.tar.gz")))).toBe(`nothing to export: no database at ${paths.database}`);
});

test("Ctrl-C during the pause or during the save: the pet is unpaused, no archive is left", async () => {
  for (const step of ["pause", "save"] as const) {
    const { deps, runtime } = await household();
    runtime.fail.add(step); // as the cancelled docker call fails; a cut-short pause may have paused already
    const file = join(tempDir(), "x.tar.gz");
    expect(await fails(exportHousehold(deps, file))).toBe("cancelled");
    expect(runtime.calls.at(-1)).toBe(`unpause ${SIBLING}`);
    expect(runtime.containers.get(SIBLING)!.state).toBe("running");
    expect(existsSync(file)).toBe(false);
  }
  const { deps } = await household();
  const stop = new AbortController();
  stop.abort();
  const file = join(tempDir(), "x.tar.gz");
  await fails(exportHousehold(deps, file, stop.signal));
  expect(existsSync(file)).toBe(false);
});

test("round trip: import into an empty Household restores the config (600), the database, TLS (700/600) and the homes of the config's pets", async () => {
  const source = await exported();
  const { deps, paths, runtime, lines } = blank();
  await importHousehold(deps, source.file);
  expect(readFileSync(paths.configFile, "utf8")).toBe(readFileSync(source.paths.configFile, "utf8"));
  const store = new SqliteStore(paths.database);
  expect(store.get("telegram.offset")).toBe("42");
  store.close();
  expect(statSync(paths.database).mode & 0o777).toBe(0o600);
  expect(runtime.volumes.get(HOME)).toEqual(source.runtime.volumes.get(HOME)!);
  expect(runtime.volumes.has("household.work.stool.home")).toBe(false);
  expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
  // The same CA: pets keep trusting it.
  expect(readFileSync(join(paths.tlsDir, "ca.key"), "utf8")).toBe("CA-KEY");
  expect(readdirSync(paths.tlsDir)).toEqual(["ca.crt", "ca.key"]); // the leaf: made on the next start
  expect(statSync(paths.tlsDir).mode & 0o777).toBe(0o700);
  expect(["ca.crt", "ca.key"].map((name) => statSync(join(paths.tlsDir, name)).mode & 0o777)).toEqual([0o600, 0o600]);
  expect(lines).toEqual([
    expect.stringMatching(new RegExp(`^archive from Household ${VERSION.replaceAll(".", "\\.")}( at \\S+)? \\(schema ${SCHEMA_VERSION}\\), made ${NOW.toISOString()}$`)),
    `config: ${paths.configFile}`,
    `database: ${paths.database} (schema ${SCHEMA_VERSION})`,
    `tls: ${paths.tlsDir}`,
    `volume ${HOME}: restored`,
    NEXT,
  ]);
});

test("import refuses to replace a config, a database or a home with files unless --force, before any change; an empty home is fine", async () => {
  const { file, deps, paths, runtime } = await exported(); // the same Household: everything is there
  runtime.containers.get(SIBLING)!.state = "exited";
  writeFileSync(`${paths.database}-wal`, "crash leftovers");
  writeFileSync(`${paths.database}-shm`, "crash leftovers");
  const config = readFileSync(paths.configFile, "utf8");
  expect(await fails(importHousehold(deps, file))).toBe(
    `would replace:\n  ${paths.configFile}\n  ${paths.database}\n  ${paths.database}-wal\n  ${paths.database}-shm\n  ${paths.tlsDir}\n` +
      `  volume ${HOME} (has files)\n` +
      "run again with --force: the config, the database and TLS are moved aside to *.bak-<time>, the homes replaced",
  );
  expect(readFileSync(paths.configFile, "utf8")).toBe(config);
  expect(runtime.calls.some((call) => call.startsWith("load "))).toBe(false);

  const fresh = blank();
  fresh.runtime.volumes.set(HOME, {});
  await importHousehold(fresh.deps, file);
  expect(fresh.runtime.volumes.get(HOME)).toEqual(runtime.volumes.get(HOME)!);
});

test("import refuses, even with --force, a pet that is running, paused or between states, and a container of another Household or not Household's", async () => {
  const { file } = await exported();
  const cases: [string, Record<string, string> | "mine", string][] = [
    ["running", "mine", `pet work/sibling is running: stop it first (msb stop ${SIBLING})`],
    ["paused", "mine", `pet work/sibling is paused: stop it first (msb stop ${SIBLING})`],
    // On its way up or down, or its agent in a state the runtime cannot read: it may still write its home.
    ["stopping", "mine", `pet work/sibling is stopping: stop it first (msb stop ${SIBLING})`],
    ["unknown", "mine", `pet work/sibling is unknown: stop it first (msb stop ${SIBLING})`],
    ["exited", { "household.owner": "0123456789ab" }, `container ${SIBLING} is another Household's (instance 0123456789ab): its home is not this Household's to replace`],
    ["exited", {}, `container ${SIBLING} is not Household's: its home is not this Household's to replace`],
  ];
  for (const [state, labels, message] of cases) {
    const { deps, runtime, paths, owner } = blank();
    runtime.containers.set(SIBLING, { state, labels: labels === "mine" ? owner : labels });
    expect(await fails(importHousehold(deps, file, { force: true }))).toBe(message);
    expect(existsSync(paths.configFile)).toBe(false);
    expect(runtime.calls).toEqual([]);
  }
});

test("import --force moves the config, the database (with its WAL) and TLS aside, then replaces the homes", async () => {
  const { file, paths, runtime: before } = await exported();
  const target = await household();
  const { deps, runtime, lines } = target;
  runtime.containers.get(SIBLING)!.state = "exited"; // the pet's own container, stopped: it stays
  await new ConfigStore(target.paths.configFile).createHouse("home"); // a config that differs from the backup's
  const oldConfig = readFileSync(target.paths.configFile, "utf8");
  writeFileSync(`${target.paths.database}-wal`, "crash leftovers");
  runtime.volumes.set(HOME, { "other.md": "another life" });
  writeFileSync(join(target.paths.tlsDir, "ca.key"), "ANOTHER-CA-KEY");

  await importHousehold(deps, file, { force: true });
  expect(readFileSync(join(target.paths.tlsDir, "ca.key"), "utf8")).toBe("CA-KEY");
  expect(existsSync(join(target.paths.tlsDir, "leaf"))).toBe(false); // the old leaf went aside with its dir
  expect(readFileSync(join(`${target.paths.tlsDir}${BAK}`, "ca.key"), "utf8")).toBe("ANOTHER-CA-KEY");
  expect(readFileSync(target.paths.configFile, "utf8")).toBe(readFileSync(paths.configFile, "utf8"));
  expect(readFileSync(`${target.paths.configFile}${BAK}`, "utf8")).toBe(oldConfig);
  expect(existsSync(`${target.paths.database}${BAK}`)).toBe(true);
  expect(readFileSync(`${target.paths.database}${BAK}-wal`, "utf8")).toBe("crash leftovers"); // where SQLite looks for it
  expect(existsSync(`${target.paths.database}-wal`)).toBe(false); // a stale WAL beside the restored database would corrupt it
  expect(runtime.volumes.get(HOME)).toEqual(before.volumes.get(HOME)!);
  expect(runtime.containers.has(SIBLING)).toBe(true);
  expect(lines).toContain(`moved aside: ${target.paths.database}-wal → ${target.paths.database}${BAK}-wal`);
  expect(lines.slice(-2)).toEqual([`volume ${HOME}: replaced`, NEXT]);
});

test("a home that fails to restore keeps its files, and the log says what was restored before", async () => {
  const { file } = await exported();
  const { deps, runtime, lines } = blank();
  runtime.volumes.set(HOME, {});
  runtime.fail.add("load");
  expect(await fails(importHousehold(deps, file))).toBe(`restoring volume ${HOME} failed`);
  expect(runtime.volumes.get(HOME)).toEqual({});
  expect(lines.at(-1)).toBe("restored before the failure: config, database, tls");
});

test("an archive of another Household version is restored, with a warning", async () => {
  const { file } = await exported();
  const older = await altered(file, (dir) => {
    const path = join(dir, "manifest.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), household: { version: "0.0.9" } }));
  });
  const { deps, lines } = blank();
  await importHousehold(deps, older);
  expect(lines.slice(0, 2)).toEqual([
    `archive from Household 0.0.9 (schema ${SCHEMA_VERSION}), made ${NOW.toISOString()}`,
    `warning: the archive is from Household 0.0.9, this is ${VERSION}; restoring anyway`,
  ]);
  expect(lines.at(-1)).toBe(NEXT);
});

test("house --version: package.json's version, and the commit from a checkout", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "--version"], { stdout: "pipe" });
  expect(await proc.exited).toBe(0);
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
  expect(version).toBe(VERSION);
  // The commit (with `-dirty` for local changes) only from a git checkout.
  const commit = await checkoutCommit(REPO_ROOT);
  expect((await new Response(proc.stdout).text()).trim()).toBe(`household ${VERSION}${commit ? ` (${commit})` : ""}`);
});

test("an import stopped by its signal changes nothing and leaves no unpacked archive behind", async () => {
  const { file } = await exported();
  const { deps, paths } = blank();
  const staged = () => readdirSync(tmpdir()).filter((name) => name.startsWith("household-import-")).length;
  const before = staged();
  const stop = new AbortController();
  stop.abort();
  await fails(importHousehold(deps, file, { signal: stop.signal }));
  expect(staged()).toBe(before);
  expect(existsSync(paths.configFile)).toBe(false);
});

test("import takes the pets from the restored config: a volume no pet has is ignored", async () => {
  const { file } = await exported();
  const extra = await altered(file, (dir) => writeFileSync(join(dir, "volumes", "household.work.ghost.home.tar"), "{}"));
  const { deps, runtime, lines } = blank();
  await importHousehold(deps, extra);
  expect(lines).toContain("ignored: volumes/household.work.ghost.home.tar (no such pet in the backup's config)");
  expect([...runtime.volumes.keys()]).toEqual([HOME]);
});

test("import refuses what is not a backup this Household can restore, before any change", async () => {
  const { file } = await exported();
  const refuse = async (change: (dir: string) => void) => {
    const { deps, paths, runtime } = blank();
    const message = await fails(importHousehold(deps, await altered(file, change)));
    expect(existsSync(paths.configFile)).toBe(false);
    expect(runtime.calls).toEqual([]);
    return message;
  };
  expect(
    await refuse((dir) => {
      const db = new Database(join(dir, "household.db"));
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      db.close();
    }),
  ).toBe(`the backup's database has schema ${SCHEMA_VERSION + 1}, newer than this Household knows (${SCHEMA_VERSION}): update Household first`);
  expect(await refuse((dir) => writeFileSync(join(dir, "manifest.json"), '{"format":1}'))).toBe(
    "archive format 1 is from before secrets were included; export again",
  );
  expect(await refuse((dir) => writeFileSync(join(dir, "manifest.json"), '{"format":5}'))).toBe("archive format 5 is not one this Household reads (4)");
  // Its strings are printed: nothing long or odd, such as a terminal escape.
  const manifest = (household: unknown) => JSON.stringify({ format: 3, created: "2026-11-03T21:15:07.000Z", household, schema: 11 });
  for (const household of [{ version: "\u001b[2J0.1.0" }, { version: "0.1.0", commit: "x".repeat(65) }, {}]) {
    expect(await refuse((dir) => writeFileSync(join(dir, "manifest.json"), manifest(household)))).toBe(
      "not a Household backup: manifest.json lacks its time, Household version or schema",
    );
  }
  expect(await refuse((dir) => symlinkSync("/etc/hosts", join(dir, "tls", "ca.crt.link")))).toEndWith("/tls/ca.crt.link is not a plain file or folder (a link?): not copied");
  // Links in the archive are not followed: not to a file, not as the volumes dir.
  expect(
    await refuse((dir) => {
      rmSync(join(dir, "household.yaml"));
      symlinkSync("/etc/hosts", join(dir, "household.yaml"));
    }),
  ).toStartWith("not a Household backup: no household.yaml in ");
  expect(
    await refuse((dir) => {
      const elsewhere = tempDir();
      rmSync(elsewhere, { recursive: true });
      renameSync(join(dir, "volumes"), elsewhere);
      symlinkSync(elsewhere, join(dir, "volumes"));
    }),
  ).toStartWith("not a Household backup: no volumes in ");
  // An archive from before keys were in the config: by hand.
  expect(await refuse((dir) => writeFileSync(join(dir, "manifest.json"), '{"format":2}'))).toBe(
    "archive format 2 is from before keys-in-config: unpack it by hand (its secrets/ go into household.yaml as keys and tokens)",
  );
});

test("an archive entry that climbs out with `..` (secrets/../x) is not unpacked", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "token"), "x");
  const evil = join(tempDir(), "evil.tar.gz");
  writeFileSync(evil, Bun.gzipSync(tarArchive([{ name: "secrets/../token", content: "x" }]))); // the name a hostile archive would carry
  const { deps, paths } = blank();
  expect(await fails(importHousehold(deps, evil))).toStartWith(`cannot unpack ${evil}:`);
  expect(existsSync(join(paths.configFile, "..", "token"))).toBe(false);
});

test("an archive that would unpack to more than the cap is not unpacked", async () => {
  const { file } = await exported();
  const dir = tempDir();
  expect(await fails(unpackFile(file, dir, 1000))).toBe(`${file} unpacks to more than 1000 bytes; not unpacked`);
  expect(existsSync(join(dir, "household.db"))).toBe(false);
  expect(await fails(unpackFile(join(dir, "nothing.tar.gz"), dir, 1000))).toStartWith("cannot unpack ");
});

test("house import refuses while the daemon runs", async () => {
  const { file } = await exported();
  const { paths } = blank();
  mkdirSync(paths.stateDir, { recursive: true });
  const control = await serveControl(paths.socket, { "/status": async () => ({ state: "running" }) });
  try {
    const cli = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
    const env = { ...process.env, HOUSEHOLD_CONFIG_DIR: join(paths.configFile, ".."), HOUSEHOLD_STATE_DIR: paths.stateDir };
    const proc = Bun.spawn(["bun", cli, "import", file], { env, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    expect((await new Response(proc.stderr).text()).trim()).toBe("the daemon is running: stop it first (Ctrl-C or SIGTERM), then import");
  } finally {
    await control.stop();
  }
  expect(existsSync(paths.configFile)).toBe(false);
});


const CODEX_AUTH = JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "portable-account", access_token: "expired-but-refreshable", refresh_token: "portable-refresh-secret" } });
async function subscriptionHousehold() {
  const setup = await household();
  await new ConfigStore(setup.paths.configFile).addKey("codex", { provider: "openai", value: "codex-chatgpt:portable-account" });
  const root = dedicatedAuthRoot(setup.paths.configFile);
  mkdirSync(join(root, "codex"), { recursive: true });
  writeFileSync(join(root, "codex", "auth.json"), CODEX_AUTH);
  writeFileSync(join(root, "codex", "config.toml"), "host-specific-settings");
  mkdirSync(join(root, "unreferenced"));
  writeFileSync(join(root, "unreferenced", "auth.json"), "unreferenced-secret");
  const file = join(tempDir(), "codex-backup.tar.gz");
  await exportHousehold(setup.deps, file);
  return { ...setup, file };
}

test("portable subscription backup restores only configured dedicated OAuth auth.json into the new config directory with private modes", async () => {
  const source = await subscriptionHousehold();
  const listing = await runCommand(["tar", "-tzf", source.file]);
  expect(listing.stdout).toContain("./codex-auth/codex/auth.json");
  expect(listing.stdout).not.toContain("unreferenced");
  expect(listing.stdout).not.toContain("config.toml");
  const dest = blank();
  await importHousehold(dest.deps, source.file);
  const root = dedicatedAuthRoot(dest.paths.configFile);
  expect(readFileSync(join(root, "codex", "auth.json"), "utf8")).toBe(CODEX_AUTH);
  expect([root, join(root, "codex")].map((path) => statSync(path).mode & 0o777)).toEqual([0o700, 0o700]);
  expect(statSync(join(root, "codex", "auth.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(root)).toEqual(["codex"]);
  expect(dest.lines.join("\n")).not.toContain("portable-refresh-secret");
});

test("restoring dedicated subscription auth refuses existing credentials unless forced, then moves only that key aside", async () => {
  const source = await subscriptionHousehold();
  const dest = blank();
  const root = dedicatedAuthRoot(dest.paths.configFile);
  mkdirSync(join(root, "codex"), { recursive: true });
  writeFileSync(join(root, "codex", "auth.json"), "existing-private-auth");
  mkdirSync(join(root, "other"));
  writeFileSync(join(root, "other", "auth.json"), "unrelated-private-auth");
  expect(await fails(importHousehold(dest.deps, source.file))).toContain(join(root, "codex"));
  expect(existsSync(dest.paths.configFile)).toBe(false);
  expect(readFileSync(join(root, "codex", "auth.json"), "utf8")).toBe("existing-private-auth");
  await importHousehold(dest.deps, source.file, { force: true });
  expect(readFileSync(join(root, "codex", "auth.json"), "utf8")).toBe(CODEX_AUTH);
  expect(readFileSync(join(root, `codex${BAK}`, "auth.json"), "utf8")).toBe("existing-private-auth");
  expect(readFileSync(join(root, "other", "auth.json"), "utf8")).toBe("unrelated-private-auth");
});

test("portable subscription auth rejects missing, linked or mismatched archived credentials before changing anything", async () => {
  const source = await subscriptionHousehold();
  for (const change of [
    (dir: string) => rmSync(join(dir, "codex-auth"), { recursive: true }),
    (dir: string) => writeFileSync(join(dir, "codex-auth", "codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "other", access_token: "private-secret" } })),
    (dir: string) => writeFileSync(join(dir, "codex-auth", "codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "portable-account", access_token: "private-secret" } })),
    (dir: string) => { const file = join(dir, "codex-auth", "codex", "auth.json"); rmSync(file); symlinkSync("/etc/hosts", file); },
    (dir: string) => { const folder = join(dir, "codex-auth", "codex"); rmSync(folder, { recursive: true }); symlinkSync(tempDir(), folder); },
  ]) {
    const dest = blank();
    const failure = await fails(importHousehold(dest.deps, await altered(source.file, change), { force: true }));
    expect(failure).toContain("Codex subscription codex:");
    expect(failure).not.toContain("private-secret");
    expect(existsSync(dest.paths.configFile)).toBe(false);
    expect(dest.runtime.calls).toEqual([]);
  }
});

test("subscription export refuses an access-only credential that cannot survive token expiry", async () => {
  const source = await subscriptionHousehold();
  const file = join(dedicatedAuthRoot(source.paths.configFile), "codex", "auth.json");
  writeFileSync(file, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "portable-account", access_token: "private-secret" } }));
  const destination = join(tempDir(), "incomplete-auth.tar.gz");
  const failure = await fails(exportHousehold(source.deps, destination));
  expect(failure).toContain("dedicated authentication does not match");
  expect(failure).not.toContain("private-secret");
  expect(existsSync(destination)).toBe(false);
});

test("subscription export and restore refuse linked dedicated auth roots instead of touching unrelated CLI stores", async () => {
  const source = await subscriptionHousehold();
  const root = dedicatedAuthRoot(source.paths.configFile);
  const elsewhere = tempDir();
  rmSync(root, { recursive: true });
  symlinkSync(elsewhere, root);
  const file = join(tempDir(), "failed.tar.gz");
  expect(await fails(exportHousehold(source.deps, file))).toContain("plain dedicated auth.json");
  expect(existsSync(file)).toBe(false);
  const dest = blank();
  symlinkSync(elsewhere, dedicatedAuthRoot(dest.paths.configFile));
  expect(await fails(importHousehold(dest.deps, source.file, { force: true }))).toContain("must be a plain folder");
  expect(existsSync(dest.paths.configFile)).toBe(false);
  expect(readdirSync(elsewhere)).toEqual([]);
});


test("export refuses foreign or unlabeled same-named runtimes before inspecting home storage or pausing them", async () => {
  for (const labels of [{ "household.owner": "another-instance" }, {}] as Record<string, string>[]) {
    const { deps, runtime } = await household();
    runtime.containers.get(SIBLING)!.labels = labels;
    let readHome = false;
    runtime.volumeHasFiles = async () => { readHome = true; return true; };
    const file = join(tempDir(), "foreign.tar.gz");
    expect(await fails(exportHousehold(deps, file))).toContain("same-named runtime belongs to another Household");
    expect(readHome).toBe(false);
    expect(runtime.calls).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(runtime.containers.get(SIBLING)!.state).toBe("running");
  }
});


test("resident VM with an ended main workload is still paused for export and blocks import", async () => {
  const setup = await household();
  const { paths, runtime } = setup;
  const combined = backupRuntime(paths, {
    pets: { machine: runtime.container.bind(runtime), pause: runtime.pause.bind(runtime), unpause: runtime.unpause.bind(runtime), cancel() {} },
    homes: { volumeHasFiles: runtime.volumeHasFiles.bind(runtime), saveVolume: runtime.saveVolume.bind(runtime), loadVolume: runtime.loadVolume.bind(runtime), cancel() {} },
  });
  // The workload-aware API would report exited; this raw lifecycle seam reports the resident machine running.
  const file = join(tempDir(), "resident.tar.gz");
  await exportHousehold({ ...setup.deps, runtime: combined }, file);
  expect(runtime.calls).toEqual([`pause ${SIBLING}`, `save ${HOME}`, `unpause ${SIBLING}`]);
  const fresh = blank();
  fresh.runtime.containers.set(SIBLING, { state: "running", labels: fresh.owner });
  const target = backupRuntime(fresh.paths, {
    pets: { machine: fresh.runtime.container.bind(fresh.runtime), pause: fresh.runtime.pause.bind(fresh.runtime), unpause: fresh.runtime.unpause.bind(fresh.runtime), cancel() {} },
    homes: { volumeHasFiles: fresh.runtime.volumeHasFiles.bind(fresh.runtime), saveVolume: fresh.runtime.saveVolume.bind(fresh.runtime), loadVolume: fresh.runtime.loadVolume.bind(fresh.runtime), cancel() {} },
  });
  expect(await fails(importHousehold({ ...fresh.deps, runtime: target }, file, { force: true }))).toContain("is running: stop it first");
  expect(existsSync(fresh.paths.configFile)).toBe(false);
});


test("underscore pet names round-trip their Unicode display names and home volumes in backups", async () => {
  const source = await household();
  const name = "my_pet-2", volume = "household.work.my_pet-2.home";
  const title = "Φίλος 朋友 & café 👩‍💻";
  await new ConfigStore(source.paths.configFile).addPet("work", name, { title, key: "claude" });
  source.runtime.volumes.set(volume, { "memory.md": "kept memory" });
  const file = join(tempDir(), "backup.tar.gz");
  await exportHousehold(source.deps, file);
  const target = blank();
  await importHousehold(target.deps, file);
  expect((await new ConfigStore(target.paths.configFile).load()).houses[0]!.pets).toContainEqual({ name, title, key: "claude" });
  expect(target.runtime.volumes.get(volume)).toEqual({ "memory.md": "kept memory" });
});


test("shared skills roundtrip once per house, retain scripts/assets, and old backups remain readable", async () => {
  const source = await household();
  const skills = new HouseSkills(houseSkillsRoot(source.paths.stateDir));
  await skills.write("work", "review/SKILL.md", "# Shared\n", null);
  await skills.write("work", "review/scripts/check.sh", "echo check\n", null);
  const file = join(tempDir(), "shared.tar.gz");
  await exportHousehold(source.deps, file);
  expect(source.runtime.calls.filter(call => call === `pause ${SIBLING}`).length).toBe(2);
  const target = blank();
  await importHousehold(target.deps, file);
  const restored = new HouseSkills(houseSkillsRoot(target.paths.stateDir));
  expect((await restored.read("work", "review/SKILL.md")).content).toBe("# Shared\n");
  expect((await restored.read("work", "review/scripts/check.sh")).content).toBe("echo check\n");
  const dir = tempDir(); await unpackFile(file, dir, 1e9);
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.format = 3;
  writeFileSync(manifestPath, JSON.stringify(manifest)); rmSync(join(dir, "skills"), {recursive:true});
  const old = join(tempDir(), "old.tar.gz"); await packDir(dir, old);
  const legacy = blank(); await importHousehold(legacy.deps, old);
  expect(await new HouseSkills(houseSkillsRoot(legacy.paths.stateDir)).list("work")).toEqual([]);
});

test("export refuses active workers before archiving homes; closed workers permit backup", async () => {
  const { paths, runtime, deps } = await household();
  const store = new SqliteStore(paths.database);
  store.set("sideworkers.v1", JSON.stringify([{ house: "work", name: "sw-review", parent: "sibling" }]));
  const file = join(tempDir(), "workers.tar.gz");
  await expect(exportHousehold(deps, file)).rejects.toThrow("Close all sideworkers before backup or restore");
  expect(existsSync(file)).toBe(false);
  expect(runtime.calls).toEqual([]);
  store.set("sideworkers.v1", "[]");
  store.set("sideworkers.v1.used-names", '["work/sw-review"]');
  await exportHousehold(deps, file);
  expect(existsSync(file)).toBe(true);
  store.close();
});

test("export discards a backup if a worker was created and closed while homes were being read", async () => {
  const { paths, runtime, deps } = await household();
  const store = new SqliteStore(paths.database);
  const save = runtime.saveVolume.bind(runtime);
  runtime.saveVolume = async (volume, file) => {
    await save(volume, file);
    store.set("sideworkers.v1.used-names", '["work/sw-transient"]');
  };
  const file = join(tempDir(), "workers.tar.gz");
  await expect(exportHousehold(deps, file)).rejects.toThrow("sideworker started during export");
  expect(existsSync(file)).toBe(false);
  store.close();
});


test("import refuses current workers even when configured pets are stopped", async () => {
  const { file } = await exported();
  const target = await household();
  target.runtime.containers.clear();
  const store = new SqliteStore(target.paths.database);
  store.set("sideworkers.v1", '[{"house":"work","name":"sw-review","parent":"sibling"}]');
  await expect(importHousehold(target.deps, file, { force: true })).rejects.toThrow("Close all sideworkers before backup or restore");
  expect(store.get("sideworkers.v1")).toContain("sw-review");
  expect(target.runtime.calls).toEqual([]);
  store.close();
});
