import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScoutStorage, scoutSetup } from "../../src/infra/scout-storage";
import type { CapabilityDefinition, ScoutDefinition } from "../../src/core/scouts";
import type { Secret } from "../../src/core/secrets";

const heroku: CapabilityDefinition = { name: "heroku", description: "Heroku CLI", install: "echo heroku", network: { any: false, allow: [{ host: "api.heroku.com", port: 443 }] }, keys: [{ secret: "heroku-key", via: "vm", env: "HEROKU_API_KEY" }, { secret: "dd-key", via: "gateway" }] };
const browser: CapabilityDefinition = { name: "browser", description: "Browser", install: "echo browser", network: { any: true, allow: [] }, keys: [] };
const definition: ScoutDefinition = { name: "helper", description: "Test", instructions: "", capabilities: ["browser", "heroku"] };
const secret = (name: string, env: string, onlyFor: string[] | undefined, value = `${name}-value`): Secret => ({ name, value, env, hosts: [{ host: "api.example.com", port: 443 }], header: "authorization", ...(onlyFor ? { onlyForCapabilities: onlyFor } : {}) });

async function withRoot(run: (root: string, storage: ScoutStorage) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "scout-storage-"));
  try { await run(root, new ScoutStorage(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

test("a run gets its capabilities' keys (only secrets restricted to them), task secrets, and their install scripts in order", () => withRoot(async (_root, storage) => {
  const prepared = await storage.prepare("work", "sc-a", definition, { capabilities: [heroku, browser], values: { phone: "synthetic" }, ownedSecrets: [secret("heroku-key", "IGNORED", ["heroku"]), secret("dd-key", "DD_API_KEY", ["heroku"])] });
  expect(prepared.env.HEROKU_API_KEY).toBe("heroku-key-value"); // inside its VM
  expect(prepared.env.DD_API_KEY).toBeUndefined(); // through the gateway: a placeholder, set elsewhere
  expect(prepared.gatewaySecrets.map(s => s.name)).toEqual(["dd-key"]);
  expect(prepared.env.SCOUT_SECRET_PHONE).toBe("synthetic");
  expect(await readFile(join(prepared.homePath, "../secrets/phone"), "utf8")).toBe("synthetic");
  expect((await stat(join(prepared.homePath, "../secrets/phone"))).mode & 0o777).toBe(0o600);
  expect(prepared.setup.indexOf("== capability browser")).toBeLessThan(prepared.setup.indexOf("== capability heroku")); // the scout's order
  expect(prepared.setup).toContain("sudo -n bash -euo pipefail");
  await expect(storage.prepare("work", "sc-a", definition, { capabilities: [heroku, browser], ownedSecrets: [] })).rejects.toThrow("already exists");
  await storage.deleteRun("work", "sc-a");
  expect(await stat(prepared.homePath).catch(() => null)).toBe(null);
}));

test("a key whose secret is not restricted to its capability never reaches the VM", () => withRoot(async (_root, storage) => {
  await expect(storage.prepare("work", "sc-b", definition, { capabilities: [heroku, browser], ownedSecrets: [secret("heroku-key", "X", undefined), secret("dd-key", "DD_API_KEY", ["other"])] })).rejects.toThrow("heroku-key");
  const gateway = await storage.prepare("work", "sc-c", { ...definition, capabilities: ["browser"] }, { capabilities: [heroku, browser], ownedSecrets: [secret("dd-key", "DD_API_KEY", undefined)] });
  expect(gateway.gatewaySecrets).toEqual([]); // a house secret is the pets', never a scout's
}));

test("the redactor knows the values of a scout's keys inside its VM", () => withRoot(async (_root, storage) => {
  expect(storage.vmValues("work", definition, [heroku, browser], [secret("heroku-key", "X", ["heroku"]), secret("dd-key", "Y", ["heroku"])])).toEqual(["heroku-key-value"]);
}));

test("skills: the house's and each capability's are copied, links excluded, and stay separate from their sources", () => withRoot(async (root, storage) => {
  const shared = join(root, "shared");
  await mkdir(join(shared, "demo"), { recursive: true });
  await writeFile(join(shared, "demo/SKILL.md"), "original");
  await symlink("/etc", join(shared, "escape"));
  await storage.skills("work", "browser").write("clicking/SKILL.md", "click well", null);
  const prepared = await storage.prepare("work", "sc-d", { ...definition, capabilities: ["browser"] }, { capabilities: [browser], ownedSecrets: [], sharedSkills: shared });
  expect(await readFile(join(prepared.skillsPath, "demo/SKILL.md"), "utf8")).toBe("original");
  expect(await readFile(join(prepared.skillsPath, "clicking/SKILL.md"), "utf8")).toBe("click well");
  expect(await stat(join(prepared.skillsPath, "escape")).catch(() => null)).toBe(null);
  await writeFile(join(prepared.skillsPath, "demo/SKILL.md"), "changed");
  expect(await readFile(join(shared, "demo/SKILL.md"), "utf8")).toBe("original");
}));

test("later task secrets cannot follow a replaced home directory", () => withRoot(async (root, storage) => {
  const prepared = await storage.prepare("work", "sc-e", { ...definition, capabilities: [] }, { capabilities: [], ownedSecrets: [] });
  await rm(join(prepared.homePath, "../secrets"), { recursive: true });
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(prepared.homePath, "../secrets"));
  await expect(storage.giveSecret("work", "sc-e", "key", "value")).rejects.toThrow();
  expect(await stat(join(root, "outside", "key")).catch(() => null)).toBe(null);
}));

test("setup clones the workspace fresh into ~/work after the install scripts", () => {
  const setup = scoutSetup([browser], { repo: "https://github.com/acme/ops.git", branch: "main" });
  expect(setup.indexOf("== capability browser")).toBeLessThan(setup.indexOf("git clone --depth 1"));
  expect(setup).toContain("--branch 'main' 'https://github.com/acme/ops.git' /tmp/household-workspace");
  expect(scoutSetup([], { repo: "https://x.example/$(touch pwned)'.git" })).toContain("'https://x.example/$(touch pwned)'\\''.git'"); // single-quoted: nothing expands
  expect(setup).toContain('cp -a /tmp/household-workspace/. "$HOME/work/"');
  expect(scoutSetup([{ name: "empty", install: "  " }])).not.toContain("== capability empty"); // nothing to install: no step
});

test("what a capability installs as root stays readable by the agent, whatever umask the setup runs under", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-umask-"));
  try {
    // As in the VM: the setup wrapper runs with umask 077; root here is this user (sudo -n dropped), HOME a temp dir.
    const setup = scoutSetup([{ name: "media", install: `mkdir -p "${dir}/lib/yt_dlp" && echo 'x' > "${dir}/lib/yt_dlp/__init__.py"` }])
      .replaceAll("sudo -n ", "").split("\n").filter(line => !line.includes(" /work")).join("\n"); // no /work link outside a VM
    const run = Bun.spawnSync(["bash", "-c", `umask 077\n${setup}`], { env: { ...process.env, HOME: dir } });
    expect(run.exitCode).toBe(0);
    expect((await stat(join(dir, "lib/yt_dlp/__init__.py"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(dir, "lib/yt_dlp"))).mode & 0o777).toBe(0o755);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a capability's root script gets the install variables itself, whatever sudo keeps", () => {
  const setup = scoutSetup([{ name: "browser", install: "playwright install chromium" }]);
  const step = setup.slice(setup.indexOf("<<'HOUSEHOLD_CAPABILITY_BROWSER'"));
  expect(step.indexOf("export PLAYWRIGHT_BROWSERS_PATH='/opt/household/playwright'")).toBeLessThan(step.indexOf("playwright install chromium"));
  expect(step).toContain("export PIPX_BIN_DIR='/usr/local/bin'");
  expect(step).toContain("export DEBIAN_FRONTEND='noninteractive'");
});
