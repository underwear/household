import { expect, test } from "bun:test";
import { join } from "node:path";
import { claudeCodeTmux, inputBox } from "../../src/agent-adapters/claude-code-tmux";
import type { Exec } from "../../src/core/agent";

// E2E_CLAUDE_TMUX=1 bun test test/agent-adapters/claude-tmux-native.test.ts
// Build the current adapter as household-qa-claude:0.9.3 first. No real accounts or network.
test.skipIf(process.env.E2E_CLAUDE_TMUX !== "1")("native Claude 2.1.323 + tmux: startup, paste, queue, permissions, copy mode and interrupt", async () => {
  const name = `household-qa-tmux-${process.pid}`;
  const instructions = "Synthetic QA\n" + 'literal $HOME $(touch /tmp/prompt-must-stay-data) `echo nope` "quotes" Привет 🐾\n'.repeat(500);
  async function docker(args: string[], stdin?: string) {
    const child = Bun.spawn(["docker", ...args], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`docker ${args[0]} failed: ${error}`);
    return output;
  }
  const exec: Exec = async (args, stdin) => {
    try { return { ok: true, output: await docker(["exec", ...(stdin === undefined ? [] : ["-i"]), name, ...args], stdin) }; }
    catch { return { ok: false, output: "" }; }
  };
  const run = (args: string[], stdin?: string) => docker(["exec", ...(stdin === undefined ? [] : ["-i"]), name, ...args], stdin);
  const screen = () => run(["tmux", "capture-pane", "-p", "-e", "-t", "=main:0.0"]);
  const hooks = async () => (await run(["cat", "/tmp/qa/hooks.jsonl"])).trim().split(/\n/).filter(Boolean).map(line => JSON.parse(line));
  async function until(check: () => Promise<boolean>, label: string, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await check()) return; await Bun.sleep(100); }
    throw new Error(`Timed out: ${label}\n${await screen().catch(() => "no pane")}`);
  }
  const setNext = (step: object) => run(["sh", "-c", "cat > /tmp/qa/next.json"], JSON.stringify(step));
  const accepted = async (text: string) => (await hooks()).some(h => h.hook_event_name === "UserPromptSubmit" && h.prompt === text);
  const idle = () => until(() => claudeCodeTmux.isIdle!(exec), "idle input");
  async function done(text: string) {
    await until(async () => {
      const all = await hooks();
      const turn = all.find(h => h.hook_event_name === "UserPromptSubmit" && h.prompt === text)?.prompt_id;
      return !!turn && all.some(h => h.hook_event_name === "Stop" && h.prompt_id === turn);
    }, `turn finished: ${text}`);
    await idle();
  }
  try {
    await docker(["run", "-d", "--name", name, "--network", "none", "--entrypoint", "sleep", "-e", "ANTHROPIC_API_KEY=sk-ant-api03-qa-fixture", "-e", "ANTHROPIC_BASE_URL=http://127.0.0.1:18080", "-e", "HOUSEHOLD_MODEL=sonnet", "-e", "HOUSEHOLD_PERMISSION_MODE=manual", "-e", `HOUSEHOLD_INSTRUCTIONS=${instructions}`, "-e", "HOUSEHOLD_EVENTS_URL=http://127.0.0.1:18080/events", "-e", "HOUSEHOLD_MCP_URL=http://127.0.0.1:18080/mcp", "-e", "DISABLE_TELEMETRY=1", "-e", 'HOUSEHOLD_ADDITIONAL_DIRECTORIES=["/volumes/server"]', process.env.CLAUDE_QA_IMAGE ?? "household-qa-claude:0.9.3", "infinity"]);
    expect(await run(["claude", "--version"])).toStartWith("2.1.323 ");
    // An existing home can contain Python modules and user settings. Neither may change startup plumbing.
    await run(["sh", "-c", 'printf \'raise RuntimeError("must not import from bot home")\n\' > "$HOME/json.py"; mkdir -p "$HOME/.claude"; printf \'{"promptSuggestionEnabled":true}\' > "$HOME/.claude/settings.json"']);
    await docker(["cp", join(import.meta.dir, "native-fixtures/claude-provider.py"), `${name}:/tmp/provider.py`]);
    await docker(["exec", "-d", name, "python3", "/tmp/provider.py"]);
    await docker(["exec", "-u", "root", name, "sh", "-c", "mkdir -p /volumes/server /volumes/other; printf 'public memory' > /volumes/server/memory.txt; printf 'private fixture' > /volumes/other/memory.txt"]);
    // An older tmux server must not supply stale configuration to the pane launcher.
    await run(["env", "HOUSEHOLD_INSTRUCTIONS=stale", "HOUSEHOLD_MODEL=stale", "tmux", "new-session", "-d", "-s", "preexisting", "sleep", "infinity"]);
    await docker(["exec", "-d", name, "household-entrypoint"]);
    await until(async () => (await claudeCodeTmux.isReady(exec)).ready, "startup");
    const launched = JSON.parse(await run(["python3", "-I", "-c", 'import glob,json; matches=[]\nfor path in glob.glob("/proc/[0-9]*/cmdline"):\n try: args=open(path,"rb").read().split(b"\\0")\n except OSError: continue\n if b"--append-system-prompt" in args: matches.append([a.decode() for a in args])\nprint(json.dumps(matches))']));
    expect(launched).toHaveLength(1);
    expect(launched[0][launched[0].indexOf("--append-system-prompt") + 1]).toBe(instructions);
    expect(launched[0][launched[0].indexOf("--model") + 1]).toBe("sonnet");
    expect(await run(["sh", "-c", "test ! -e /tmp/prompt-must-stay-data && find /tmp -maxdepth 1 -name 'household-claude-launch.*'"])).toBe("");
    const multiline = 'Привет 🐾 $HOME `literal`\nsecond line';
    expect(await claudeCodeTmux.send(exec, multiline, () => true)).toEqual({ status: "sent" });
    await until(() => accepted(multiline), "literal multiline prompt");
    await done(multiline);
    const quotedDialog = 'Explain "Do you trust the files in this folder" and "Bypass Permissions mode"';
    expect((await claudeCodeTmux.send(exec, quotedDialog, () => true)).status).toBe("sent");
    await done(quotedDialog);

    // A user's draft, including placeholder-like text, is never overwritten.
    await run(["tmux", "send-keys", "-t", "=main:0.0", "-l", 'Try "refactor <filepath>"']);
    await until(async () => inputBox(await screen()) === 'Try "refactor <filepath>"', "draft");
    expect((await claudeCodeTmux.send(exec, "must not overwrite", () => true)).status).toBe("refused");
    await run(["tmux", "send-keys", "-t", "=main:0.0", "C-u"]);
    await idle();

    await run(["tmux", "copy-mode", "-t", "=main:0.0"]);
    expect((await claudeCodeTmux.send(exec, "not in copy mode", () => true)).status).toBe("refused");
    await run(["tmux", "send-keys", "-t", "=main:0.0", "-X", "cancel"]);

    await setNext({ delay: 2, match: "slow turn" });
    expect((await claudeCodeTmux.send(exec, "slow turn", () => true)).status).toBe("sent");
    await until(async () => (await screen()).includes("esc to interrupt"), "busy turn");
    expect((await claudeCodeTmux.send(exec, "queued turn", () => true)).status).toBe("sent");
    await until(() => accepted("queued turn"), "queued prompt accepted");
    await Bun.write("/tmp/household-qa-queued-screen.txt", await screen());
    expect(inputBox(await screen())).toBe("");
    expect((await claudeCodeTmux.send(exec, "third queued turn", () => true)).status).toBe("sent");
    await until(() => accepted("third queued turn"), "third prompt accepted");
    // Claude coalesces multiple queued prompts into one next turn.
    await until(async () => (await hooks()).filter(h => h.hook_event_name === "Stop").length >= 4, "queued batch finished");
    await idle();

    await setNext({ match: "read external file", content: [{ type: "tool_use", id: "toolu_read_permission", name: "Read", input: { file_path: "/etc/hostname" } }] });
    expect((await claudeCodeTmux.send(exec, "read external file", () => true)).status).toBe("sent");
    await until(async () => (await hooks()).some(h => h.hook_event_name === "PermissionRequest"), "permission hook");
    expect((await claudeCodeTmux.send(exec, "hook already blocks input", () => false)).status).toBe("refused");
    await until(() => claudeCodeTmux.dialogVisible(exec), "permission drawn");
    expect((await claudeCodeTmux.send(exec, "must not approve", () => true)).status).toBe("refused");
    expect((await hooks()).some(h => h.hook_event_name === "PostToolUse" && h.tool_use_id === "toolu_read_permission")).toBe(false);
    await run(["sh", "-c", "cat > /tmp/qa/decision.json"], JSON.stringify({ behavior: "deny", message: "QA denied" }));
    await done("read external file");

    await setNext({ delay: 5, match: "interrupt this" });
    expect((await claudeCodeTmux.send(exec, "interrupt this", () => true)).status).toBe("sent");
    await until(async () => (await screen()).includes("esc to interrupt"), "interruptible turn");
    await run(["tmux", "copy-mode", "-t", "=main:0.0"]);
    const interrupted = await claudeCodeTmux.interrupt!(exec);
    expect(interrupted.status).toBe("stopped");
    if (interrupted.leftover) {
      expect(interrupted.leftover).toBe("interrupt this");
      expect((await claudeCodeTmux.send(exec, "must not overwrite restored input", () => true)).status).toBe("refused");
      await run(["tmux", "send-keys", "-t", "=main:0.0", "C-u"]); // owner's explicit clearing
    }
    await idle();
    expect((await claudeCodeTmux.send(exec, "after interrupt", () => true)).status).toBe("sent");
    await until(() => accepted("after interrupt"), "recovery after interrupt");
    await done("after interrupt");

    await setNext({ match: "read shared memory", content: [{ type: "tool_use", id: "toolu_shared_read", name: "Read", input: { file_path: "/volumes/server/memory.txt" } }] });
    expect((await claudeCodeTmux.send(exec, "read shared memory", () => true)).status).toBe("sent");
    await done("read shared memory");
    const shared = await hooks();
    expect(shared.some(h => h.hook_event_name === "PostToolUse" && h.tool_use_id === "toolu_shared_read")).toBe(true);
    expect(shared.some(h => h.hook_event_name === "PermissionRequest" && h.tool_input?.file_path === "/volumes/server/memory.txt")).toBe(false);
    await setNext({ match: "read unshared sibling", content: [{ type: "tool_use", id: "toolu_unshared_read", name: "Read", input: { file_path: "/volumes/other/memory.txt" } }] });
    expect((await claudeCodeTmux.send(exec, "read unshared sibling", () => true)).status).toBe("sent");
    await done("read unshared sibling");
    expect((await hooks()).some(h => h.hook_event_name === "PermissionRequest" && h.tool_input?.file_path === "/volumes/other/memory.txt")).toBe(true);
    expect((await hooks()).some(h => h.hook_event_name === "PostToolUse" && h.tool_use_id === "toolu_unshared_read")).toBe(false);

    // A real question is blocked like a permission, then answered through the production hook.
    await run(["rm", "/tmp/qa/decision.json"]);
    const question = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "Red option" }, { label: "Blue", description: "Blue option" }], multiSelect: false }] };
    await setNext({ match: "ask a question", content: [{ type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: question }] });
    expect((await claudeCodeTmux.send(exec, "ask a question", () => true)).status).toBe("sent");
    await until(async () => (await hooks()).some(h => h.hook_event_name === "PermissionRequest" && h.tool_name === "AskUserQuestion"), "question hook");
    await until(() => claudeCodeTmux.dialogVisible(exec), "question drawn");
    expect((await claudeCodeTmux.send(exec, "must not answer a question", () => true)).status).toBe("refused");
    await run(["sh", "-c", "cat > /tmp/qa/decision.json"], JSON.stringify({ behavior: "allow", updatedInput: { ...question, answers: { "Which color?": "Blue" } } }));
    await done("ask a question");
    expect((await hooks()).find(h => h.hook_event_name === "PostToolUse" && h.tool_use_id === "toolu_question")?.tool_response.answers).toEqual({ "Which color?": "Blue" });

    // The tool asks between paste and Enter. Production delivery's canSubmit gate must win.
    await run(["rm", "/tmp/qa/decision.json"]);
    await setNext({ delay: 1, match: "late permission", content: [{ type: "tool_use", id: "toolu_late", name: "Read", input: { file_path: "/etc/hosts" } }] });
    expect((await claudeCodeTmux.send(exec, "late permission", () => true)).status).toBe("sent");
    await until(async () => (await screen()).includes("esc to interrupt"), "working before permission");
    let permitted = true;
    const racingExec: Exec = async (args, stdin) => {
      const result = await exec(args, stdin);
      if (args.includes("paste-buffer")) {
        await until(async () => (await hooks()).some(h => h.hook_event_name === "PermissionRequest" && h.tool_input?.file_path === "/etc/hosts"), "permission during paste");
        permitted = false;
      }
      return result;
    };
    expect((await claudeCodeTmux.send(racingExec, "never submit during dialog", () => permitted)).status).toBe("stuck");
    expect(await accepted("never submit during dialog")).toBe(false);
    expect((await hooks()).some(h => h.hook_event_name === "PostToolUse" && h.tool_use_id === "toolu_late")).toBe(false);
    await run(["sh", "-c", "cat > /tmp/qa/decision.json"], JSON.stringify({ behavior: "deny", message: "QA denied" }));
    await until(async () => !(await screen()).includes("esc to interrupt") && inputBox(await screen()) !== undefined, "permission dismissed");
    await run(["tmux", "send-keys", "-t", "=main:0.0", "C-u"]); // clear the deliberately stuck draft
    await idle();

    // Selecting another pane cannot redirect Household's input away from Claude.
    await run(["tmux", "split-window", "-d", "-t", "=main:0.0", "sleep", "60"]);
    await run(["tmux", "select-pane", "-t", "=main:0.1"]);
    expect((await claudeCodeTmux.send(exec, "fixed pane target", () => true)).status).toBe("sent");
    await done("fixed pane target");
    await run(["tmux", "kill-pane", "-t", "=main:0.1"]);
    await run(["tmux", "resize-window", "-t", "=main:0", "-x", "80", "-y", "24"]);
    await idle(); // resize redraws the input box asynchronously
    const large = Array.from({ length: 80 }, (_, i) => `line ${i} Кириллица 🐾 and literal $HOME`).join("\n");
    expect((await claudeCodeTmux.send(exec, large, () => true)).status).toBe("sent");
    await until(() => accepted(large), "collapsed large paste preserved");
    await done(large);

    await run(["tmux", "kill-server"]);
    await docker(["exec", "-d", name, "env", "HOUSEHOLD_PERMISSION_MODE=plan", "household-entrypoint"]);
    await until(async () => (await claudeCodeTmux.isReady(exec, "plan")).ready, "plan startup");
    await setNext({ match: "load plan tool", content: [{ type: "tool_use", id: "toolu_plan_search", name: "ToolSearch", input: { query: "select:ExitPlanMode", max_results: 1 } }] });
    expect((await claudeCodeTmux.send(exec, "load plan tool", () => true)).status).toBe("sent");
    await done("load plan tool");
    await run(["rm", "/tmp/qa/decision.json"]);
    await setNext({ match: "propose a plan", content: [{ type: "tool_use", id: "toolu_plan", name: "ExitPlanMode", input: { plan: "# QA plan\nRead the public fixture." } }] });
    expect((await claudeCodeTmux.send(exec, "propose a plan", () => true)).status).toBe("sent");
    await until(async () => (await hooks()).some(h => h.hook_event_name === "PermissionRequest" && h.tool_name === "ExitPlanMode"), "plan hook");
    await until(() => claudeCodeTmux.dialogVisible(exec), "plan drawn");
    expect((await claudeCodeTmux.send(exec, "must not approve a plan", () => true)).status).toBe("refused");
    await run(["sh", "-c", "cat > /tmp/qa/decision.json"], JSON.stringify({ behavior: "deny", message: "QA revise plan" }));
    await done("propose a plan");

    // Exercise the reported mode as well: shared memory is readable in native auto.
    await run(["tmux", "kill-server"]);
    await docker(["exec", "-d", name, "env", "-u", "DISABLE_TELEMETRY", "HOUSEHOLD_PERMISSION_MODE=auto", "household-entrypoint"]);
    await until(async () => (await claudeCodeTmux.isReady(exec, "auto")).ready, "auto startup");
    expect((await claudeCodeTmux.isReady(exec, "auto")).warning).toBeUndefined();
    await setNext({ match: "auto shared memory", content: [{ type: "tool_use", id: "toolu_auto_read", name: "Read", input: { file_path: "/volumes/server/memory.txt" } }] });
    expect((await claudeCodeTmux.send(exec, "auto shared memory", () => true)).status).toBe("sent");
    await done("auto shared memory");
    expect((await hooks()).some(h => h.hook_event_name === "PostToolUse" && h.tool_use_id === "toolu_auto_read")).toBe(true);
    expect((await hooks()).some(h => h.hook_event_name === "PermissionRequest" && h.permission_mode === "auto")).toBe(false);

    // Check the actual model requests, not just Claude's process arguments, across
    // ordinary turns and both restarts above. The whole append must remain system text.
    const requests = (await run(["cat", "/tmp/qa/requests.jsonl"])).trim().split(/\n/)
      .map(line => JSON.parse(line)).filter(request => request.stream && request.tools?.length);
    expect(requests.length).toBeGreaterThan(10);
    for (const request of requests) {
      const system = typeof request.system === "string" ? request.system
        : request.system.map((block: { text?: string }) => block.text ?? "").join("\n");
      expect(system).toContain(instructions);
      expect(system.split(instructions)).toHaveLength(2);
    }

  } finally {
    const fs = await import("node:fs/promises");
    await fs.mkdir("/tmp/household-qa-native-artifacts", { recursive: true });
    for (const file of ["hooks.jsonl", "requests.jsonl"]) await fs.writeFile(`/tmp/household-qa-native-artifacts/${file}`, await run(["cat", `/tmp/qa/${file}`]).catch(() => ""));
    await fs.writeFile("/tmp/household-qa-native-artifacts/screen.txt", await screen().catch(() => ""));
    await docker(["rm", "-f", name]).catch(() => {}); }
}, 90_000);
