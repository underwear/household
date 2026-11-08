import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveControl } from "../../src/infra/control-socket";
import { resolvePaths } from "../../src/infra/paths";
import { tempDir } from "../helpers";

const cli = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const LINK = "http://127.0.0.1:8780/login?token=fake-token";

/** `house dashboard` against a fake daemon socket; `open` and `xdg-open` are fakes that note what they were given. */
async function dashboard(args: string[], daemon = true, answer: object = { url: LINK }) {
  const dirs = { HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() };
  const paths = resolvePaths(dirs);
  const bin = tempDir();
  const opened = join(bin, "opened");
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(bin, opener), `#!/bin/sh\necho "$@" >> '${opened}'\n`);
    chmodSync(join(bin, opener), 0o755);
  }
  let asked = 0;
  const control = daemon ? await serveControl(paths.socket, { "/dashboard": async () => (asked++, answer) }) : undefined;
  try {
    const proc = Bun.spawn([process.execPath, cli, "dashboard", ...args], {
      env: { ...process.env, ...dirs, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out: out + err, asked, opened: existsSync(opened) ? readFileSync(opened, "utf8").trim() : undefined };
  } finally {
    await control?.stop();
  }
}

test("prints the daemon's one-time link and opens it in the browser", async () => {
  const run = await dashboard([]);
  expect(run.code).toBe(0);
  expect(run.asked).toBe(1);
  expect(run.out).toContain(`sign-in link (works once, for 60 s):\n${LINK}\n`);
  expect(run.opened).toBe(LINK);
});

test("--no-open only prints it", async () => {
  const run = await dashboard(["--no-open"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(LINK);
  expect(run.opened).toBeUndefined();
});

test("without a daemon there is no link", async () => {
  const run = await dashboard(["--no-open"], false);
  expect(run.code).toBe(1);
  expect(run.out).toContain("daemon not running; start it with `house start`");
});

test("a daemon running without its web UI says why", async () => {
  const run = await dashboard([], true, { off: "port 8780 is taken: set daemon.webPort in the config, then restart" });
  expect(run.code).toBe(1);
  expect(run.out).toContain("web UI off: port 8780 is taken: set daemon.webPort in the config, then restart");
  expect(run.opened).toBeUndefined();
});
