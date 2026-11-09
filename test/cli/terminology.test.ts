import { expect, test } from "bun:test";
import { normalizeCliArgs, normalizeCommand } from "../../src/cli/terminology";

test("canonical flags map to the existing contract; values after -- stay literal", () => {
  expect(normalizeCliArgs(["bot", "add", "work", "helper", "--harness=codex-app-server", "--bots", "helper", "--workspaces=work", "--", "--harness=literal"])).toEqual(["bot", "add", "work", "helper", "--agent=codex-app-server", "--pets", "helper", "--houses=work", "--", "--harness=literal"]);
  expect(normalizeCliArgs(["--text", "--harness", "--note=--bot"])).toEqual(["--text", "--harness", "--note=--bot"]);
  expect(normalizeCliArgs(["--agent", "codex-app-server", "--house", "work"])).toEqual(["--agent", "codex-app-server", "--house", "work"]);
});

test("bot and workspace verbs preserve legacy commands without exposing daemon verbs", () => {
  expect(normalizeCommand("bot", ["show", "work", "helper"])).toEqual({ command: "pet", args: ["show", "work", "helper"] });
  expect(normalizeCommand("workspace", ["create", "work"])).toEqual({ command: "create", args: ["work"] });
  expect(normalizeCommand("workspace", ["rm", "work"])).toEqual({ command: "delete", args: ["work"] });
  expect(normalizeCommand("workspace", ["start"])).toEqual({ command: "workspace", args: ["start"] });
  expect(normalizeCommand("pet", ["show", "work", "helper"])).toEqual({ command: "pet", args: ["show", "work", "helper"] });
});
