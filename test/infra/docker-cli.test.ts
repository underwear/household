import { expect, test } from "bun:test";
import { runCommand } from "../../src/infra/process";

test("a command is killed when its signal aborts (a stop does not wait for a build); one that cannot start fails, not throws", async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  expect(await runCommand(["sleep", "30"], { signal: stop.signal })).toEqual({ ok: false, stdout: "", stderr: "cancelled" });
  expect(await runCommand(["household-no-such-command"])).toMatchObject({ ok: false, stdout: "" });
});
