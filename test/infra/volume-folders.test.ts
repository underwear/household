import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { mountable, type MountState } from "../../src/infra/volume-folders";
import { tempDir } from "../helpers";

test("a privacy-prompt filesystem wait is bounded and repeated callers reuse the pending read-only probe", async () => {
  let finish!: (value: MountState) => void;
  let calls = 0;
  const check = () => { calls++; return new Promise<MountState>(resolve => { finish = resolve; }); };
  const options = { check, timeoutMs: 20 };
  const start = Date.now();
  expect(await Promise.all([mountable("/fixture", [], options), mountable("/fixture", [], options)])).toEqual(["unavailable", "unavailable"]);
  expect(await mountable("/fixture", [], options)).toBe("unavailable");
  expect(calls).toBe(1);
  expect(Date.now() - start).toBeLessThan(1000);
  finish("ok");
  await Bun.sleep(0);
  const next = mountable("/fixture", [], options);
  await Bun.sleep(0);
  expect(calls).toBe(2);
  finish("ok");
  expect(await next).toBe("ok");
});

test("denied access is unavailable, while missing, changed and protected paths retain their distinct states", async () => {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, "folder"));
  symlinkSync(join(root, "folder"), join(root, "link"));
  expect(await mountable(join(root, "folder"), [])).toBe("ok");
  expect(await mountable(join(root, "missing"), [])).toBe("missing");
  expect(await mountable(join(root, "link"), [])).toBe("unsafe");
  expect(await mountable(join(root, "folder"), [root])).toBe("unsafe");
  expect(await mountable(root, [], { check: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } })).toBe("unavailable");
});
