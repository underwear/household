import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dedicatedAuthRoot } from "../../src/app/codex-auth-backup";
import { ConfigStore } from "../../src/infra/config-store";
import { resolvePaths } from "../../src/infra/paths";
import { tempDir } from "../helpers";

const cli = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const credential = (exp = Math.floor(Date.now() / 1000) + 3600) => ({ auth_mode: "chatgpt", tokens: {
  account_id: "own-account", access_token: `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.private-signature`, refresh_token: "portable-refresh-secret",
} });

function setupLogin() {
  const dirs = { HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() };
  const paths = resolvePaths(dirs);
  const bin = tempDir();
  const called = join(bin, "calls");
  const fake = (body: string) => writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const run = async (name = "subscription") => {
    const child = Bun.spawn([process.execPath, cli, "key", "codex", name], {
      env: { ...process.env, ...dirs, PATH: `${bin}:${process.env.PATH}`, OPENAI_API_KEY: "unwanted-provider-secret", CODEX_HOME: "/unrelated/cli/login", HTTPS_PROXY: "http://unwanted-proxy" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: out + err };
  };
  return { paths, called, fake, run, root: dedicatedAuthRoot(paths.configFile) };
}

test("dedicated valid login attaches without running Codex, stores only an account marker and secures credentials", async () => {
  const setup = setupLogin();
  const home = join(setup.root, "subscription");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify(credential()), { mode: 0o644 });
  setup.fake(`throw new Error('must not start');`);
  const result = await setup.run();
  expect(result.code).toBe(0);
  expect(result.out).toContain("dedicated credentials stay with Household");
  expect(result.out).not.toContain("portable-refresh-secret");
  expect(readFileSync(setup.paths.configFile, "utf8")).toContain("codex-chatgpt:own-account");
  expect(readFileSync(setup.paths.configFile, "utf8")).not.toContain("portable-refresh-secret");
  expect([setup.root, home].map((path) => statSync(path).mode & 0o777)).toEqual([0o700, 0o700]);
  expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  expect((await setup.run()).code).toBe(0); // repeating the command reattaches the same key
});

test("missing dedicated login starts device auth with sanitized env, independent of global CODEX_HOME", async () => {
  const setup = setupLogin();
  setup.fake(`import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(setup.called)}, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,api:!!process.env.OPENAI_API_KEY,proxy:!!process.env.HTTPS_PROXY}));
writeFileSync(process.env.CODEX_HOME+'/auth.json', ${JSON.stringify(JSON.stringify(credential()))});`);
  const result = await setup.run();
  expect(result.code).toBe(0);
  const called = JSON.parse(readFileSync(setup.called, "utf8"));
  expect(called.home).toBe(join(setup.root, "subscription"));
  expect(called.api).toBe(false);
  expect(called.proxy).toBe(false);
  expect(called.args.slice(-2)).toEqual(["login", "--device-auth"]);
  expect(called.args).toContain('cli_auth_credentials_store="file"');
  expect(called.args).toContain('forced_login_method="chatgpt"');
  expect(result.out).not.toContain("portable-refresh-secret");
});

test("expired dedicated credentials refresh through auth-only app-server before device login is considered", async () => {
  const setup = setupLogin();
  const home = join(setup.root, "subscription");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify(credential(1)));
  setup.fake(`import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(setup.called)}, process.argv.slice(2).join(' '));
createInterface({input:process.stdin}).on('line',line=>{
const p=JSON.parse(line);if(p.id===1)console.log(JSON.stringify({id:1,result:{}}));
if(p.id===2){writeFileSync(process.env.CODEX_HOME+'/auth.json', ${JSON.stringify(JSON.stringify(credential()))});console.log(JSON.stringify({id:2,result:{account:{type:'chatgpt'}}}));}
});`);
  expect((await setup.run()).code).toBe(0);
  expect(readFileSync(setup.called, "utf8")).toContain("app-server --stdio");
  expect(readFileSync(setup.called, "utf8")).not.toContain("--device-auth");
});

test("unsafe names and existing API keys fail before credential paths or login are created", async () => {
  const invalid = setupLogin();
  expect((await invalid.run("../outside")).code).toBe(1);
  expect(existsSync(invalid.root)).toBe(false);
  const existing = setupLogin();
  await new ConfigStore(existing.paths.configFile).addKey("subscription", { provider: "openai", value: "sk-api-existing" });
  const result = await existing.run();
  expect(result.code).toBe(1);
  expect(result.out).toContain("choose another name");
  expect(existsSync(existing.root)).toBe(false);
});
