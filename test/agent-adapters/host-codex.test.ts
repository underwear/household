import { expect, test } from "bun:test";
import root from "../../package.json" with { type: "json" };
import image from "../../src/agent-adapters/codex-app-server/codex/package.json" with { type: "json" };
import { hostCodex } from "../../src/agent-adapters/codex-app-server/host-codex";

test("Household's own Codex is the version the pets' image runs", () => {
  expect(root.dependencies["@openai/codex"]).toBe(image.dependencies["@openai/codex"]);
});

test("on this machine it is the pinned package's binary, not one on PATH; elsewhere, PATH's", () => {
  const binary = hostCodex(process.platform, process.arch, {});
  expect(binary).toContain(`@openai/codex-${process.platform}-${process.arch}`);
  expect(Bun.spawnSync([binary, "--version"]).stdout.toString()).toContain(image.dependencies["@openai/codex"]);
  expect(hostCodex("sunos", "x64", {})).toBe("codex");
  expect(hostCodex(process.platform, process.arch, { HOUSEHOLD_CODEX: "/opt/my/codex" })).toBe("/opt/my/codex");
});
