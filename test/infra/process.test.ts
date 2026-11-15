import { expect, test } from "bun:test";
import { collectCommand, runCommand } from "../../src/infra/process";

test("command deadlines include output inherited by descendants after a successful parent exit", async () => {
  const start = Date.now();
  const result = await runCommand(["sh", "-c", "sleep 2 & printf 'parent output'; printf 'parent error' >&2"], { timeoutMs: 100 });
  expect(result).toEqual({ ok: false, stdout: "parent output", stderr: "parent error" });
  expect(Date.now() - start).toBeLessThan(1500);
});

test("cancellation releases inherited pipes even when the parent has already exited", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const result = runCommand(["sh", "-c", "sleep 2 & printf parent"], { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    expect(await result).toEqual({ ok: false, stdout: "parent", stderr: "cancelled" });
    expect(Date.now() - start).toBeLessThan(1500);
  } finally { clearTimeout(timer); }
});

test("the process deadline also kills a parent that is still running", async () => {
  const result = await runCommand(["sh", "-c", "printf started; exec sleep 2"], { timeoutMs: 100 });
  expect(result).toEqual({ ok: false, stdout: "started", stderr: "timed out after 100 ms" });
});

test("raw command capture preserves whitespace and UTF-8 while runCommand trims it", async () => {
  const command = ["sh", "-c", "printf '  привет\\n'; printf ' error\\n' >&2"];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  expect(await collectCommand(child, { timeoutMs: 1000 })).toEqual({ ok: true, stdout: "  привет\n", stderr: " error\n", code: 0 });
  expect(await runCommand(command)).toEqual({ ok: true, stdout: "привет", stderr: "error" });
  expect(await runCommand(["sh", "-c", "printf failed >&2; exit 7"])).toEqual({ ok: false, stdout: "", stderr: "failed" });
});
