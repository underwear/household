import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeTmux } from "../../src/agent-adapters/claude-code-tmux";
import { sameScreenDialog, screenDialogOf } from "../../src/agent-adapters/claude-code-tmux/screen-dialog";

const screen = (name: string) => readFileSync(join(import.meta.dir, "screens", `${name}.txt`), "utf8");

test("Claude's permission prompt is read off the screen: what it is about, the question, and each numbered option", () => {
  const read = screenDialogOf(screen("perm"))!;
  expect(read.question).toBe("Bash command\nWrite current date to now.txt\ndate > now.txt\nDo you want to proceed?");
  expect(read.options.map(option => option.key)).toEqual(["1", "2", "3", "4"]);
  expect(read.options[0]).toEqual({ key: "1", label: "1. Yes" });
  // A long option is cut to a label; its whole text is its description.
  expect(read.options[1]!.label.length).toBeLessThanOrEqual(64);
  expect(read.options[1]!.description).toBe("2. Yes, and always allow access to /home/agent/work from this project");
  expect(read.options[3]).toEqual({ key: "4", label: "4. No" });
});

test("the plan prompt is read too, without the option that opens a field to type in; a screen with no dialog, or one Household cannot read, gives nothing", () => {
  expect(screenDialogOf(screen("plan"))?.options.map(option => option.label)).toEqual([
    "1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) f…", "2. Yes, manually approve edits",
  ]);
  for (const name of ["idle", "busy-queued", "first-run-trust-2.1.323", "ask"]) expect(screenDialogOf(screen(name))).toBeUndefined();
  // Numbered text that is not Claude's dialog: no option marked as chosen, or not numbered 1, 2, … in order.
  expect(screenDialogOf(screen("perm").replace("❯ 1. Yes", "  1. Yes"))).toBeUndefined();
  expect(screenDialogOf(screen("perm").replace("   2. Yes, and", "   5. Yes, and"))).toBeUndefined();
});

test("two dialogs that differ only past what the card shows are not the same", () => {
  const long = (tail: string) => screen("perm").replace("date > now.txt\n╌", `echo ${"x".repeat(1200)} ${tail}\n╌`);
  const a = screenDialogOf(long("&& true"))!, b = screenDialogOf(long("&& rm -rf ~"))!;
  expect(a.question).toBe(b.question); // the card cuts both alike
  expect(sameScreenDialog(a, b)).toBe(false);
  expect(sameScreenDialog(a, screenDialogOf(long("&& true"))!)).toBe(true);
});

test("an option is pressed only while the same dialog is still drawn, and never outside copy mode's back", async () => {
  const perm = screen("perm");
  const read = screenDialogOf(perm)!;
  let shown = perm;
  let mode = "0";
  const keys: string[][] = [];
  const exec = async (argv: string[]) => {
    if (argv[1] === "display-message") return { ok: true, output: `${mode}\n` };
    if (argv[1] === "capture-pane") return { ok: true, output: shown };
    keys.push(argv);
    return { ok: true, output: "" };
  };
  expect(await claudeCodeTmux.screenDialog!.read(exec)).toEqual(read);
  expect(await claudeCodeTmux.screenDialog!.choose(exec, read, "1")).toBe(true);
  expect(keys).toEqual([["tmux", "send-keys", "-t", "=main:0.0", "-l", "1"]]);
  expect(await claudeCodeTmux.screenDialog!.choose(exec, read, "9")).toBe(false);
  mode = "1";
  expect(await claudeCodeTmux.screenDialog!.choose(exec, read, "1")).toBe(false);
  mode = "0";
  shown = perm.replace("date > now.txt\n╌", "rm -rf /\n╌");
  expect(await claudeCodeTmux.screenDialog!.choose(exec, read, "1")).toBe(false);
  shown = screen("idle");
  expect(await claudeCodeTmux.screenDialog!.read(exec)).toBeUndefined();
  expect(keys).toHaveLength(1);
});
