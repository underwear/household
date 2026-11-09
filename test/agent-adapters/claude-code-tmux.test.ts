import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionOf, HOME, program, short, shortPath } from "../../src/agent-adapters/claude-code-tmux/actions";
import { BASH_DESCRIPTIONS, claudeCodeTmux, inputBox, isClaudeReady, modeMismatch, PLACEHOLDER_API_KEY, PLACEHOLDER_TOKEN } from "../../src/agent-adapters/claude-code-tmux";
import type { Exec } from "../../src/core/agent";
import { DIALOG_WAIT_MS } from "../../src/app/chat";
import { MCP_SERVER } from "../../src/core/instructions";

const READY = ` ▐▛███▜▌   Claude Code v2.1.296
──────────────────────────────
❯
──────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

test("provisioning: CA trust in env; the key's placeholder by its kind, the real value only on the gateway's wire", () => {
  const context = { caCertPath: "/etc/household/ca.crt", eventsUrl: "http://gw:8080/events", mcpUrl: "http://gw:8080/mcp", instructions: "Be brief.", model: "sonnet" };
  expect(claudeCodeTmux.env(context)).toEqual({
    NODE_EXTRA_CA_CERTS: "/etc/household/ca.crt",
    HOUSEHOLD_EVENTS_URL: "http://gw:8080/events",
    HOUSEHOLD_MCP_URL: "http://gw:8080/mcp",
    HOUSEHOLD_INSTRUCTIONS: `Be brief.\n${BASH_DESCRIPTIONS}`, // and what claude is told of its own tools
    HOUSEHOLD_MODEL: "sonnet",
    // Household's timer is the only one on claude's permission dialogs (the name is in the 2.1.296 binary).
    CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // Fast mode is billed to credits whatever the plan: never in a pet.
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    MCP_TOOL_TIMEOUT: "330000",
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "330000",
  });
  // A pet's permission mode, one of claude's own (2.1.296 --help), goes to every launch.
  expect(claudeCodeTmux.modes!.options.map(({ id }) => id)).toEqual(["auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]);
  expect(claudeCodeTmux.modes!.default).toBe("bypassPermissions");
  expect(claudeCodeTmux.modes!.options.find(({ id }) => id === "acceptEdits")!.label).toBe("Accept edits");
  expect(claudeCodeTmux.env({ ...context, mode: "manual" }).HOUSEHOLD_PERMISSION_MODE).toBe("manual");
  expect(PLACEHOLDER_TOKEN).toHaveLength(108);
  expect(PLACEHOLDER_API_KEY).toHaveLength(108);
  const anthropic = { host: "api.anthropic.com", port: 443 };
  expect(claudeCodeTmux.providers).toEqual(["anthropic"]);
  expect(claudeCodeTmux.credentialHeaders).toEqual([{ target: anthropic, headers: ["authorization", "x-api-key"] }]); // all stripped
  // A subscription's OAuth token (`claude setup-token`): Bearer; an API key: x-api-key. The value is never in env.
  expect(claudeCodeTmux.useKey("anthropic", "sk-ant-oat01-real")).toEqual({
    kind: "subscription",
    env: { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_TOKEN },
    wire: [{ target: anthropic, header: "authorization", prefix: "Bearer " }],
  });
  expect(claudeCodeTmux.useKey("anthropic", "sk-ant-api03-real")).toEqual({
    kind: "API key",
    env: { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY },
    wire: [{ target: anthropic, header: "x-api-key", prefix: "" }],
  });
  const unknown = claudeCodeTmux.useKey("anthropic", "hunter2-not-a-key");
  expect(unknown).toEqual({ problem: expect.stringContaining("not an Anthropic key") });
  expect(JSON.stringify(unknown)).not.toContain("hunter2"); // never repeats the value
  expect(claudeCodeTmux.useKey("openai", "sk-x")).toEqual({ problem: "claude-code-tmux runs on anthropic keys, not openai" });
  // claude's question about an API key counts as a dialog on screen (should it come anyway).
  expect(inputBox("Detected a custom API key in your environment\n❯ 1. Yes")).toBeUndefined();
  expect(claudeCodeTmux.home).toBe("/home/agent");
  for (const file of ["Dockerfile", "entrypoint.sh", "household-hook", "mcp.json", "seed/.claude.json", "seed/.claude/settings.json"]) {
    expect(existsSync(join(claudeCodeTmux.imageContext, file))).toBe(true);
  }
});

test("claude gets Household's MCP server (and no other) from a root-owned file, and the instructions", async () => {
  const file = (name: string) => readFileSync(join(claudeCodeTmux.imageContext, name), "utf8");
  // claude expands ${VAR} in MCP configs (checked with 2.1.296), so the image needs no per-pet file.
  // The server's name is Household's (core); the model sees tools as mcp__<server>__<tool>.
  expect(JSON.parse(file("mcp.json"))).toEqual({ mcpServers: { [MCP_SERVER]: { type: "http", url: "${HOUSEHOLD_MCP_URL}", headers: { "x-household-token": "${HOUSEHOLD_PET_TOKEN}" } } } });
  expect(file("Dockerfile")).toContain("COPY --chmod=644 mcp.json /etc/household/mcp.json");
  expect(file("entrypoint.sh")).toContain(
    '--mcp-config /etc/household/mcp.json "$@" --model "$HOUSEHOLD_MODEL" \\\n  --permission-mode "$HOUSEHOLD_PERMISSION_MODE" --append-system-prompt "$HOUSEHOLD_INSTRUCTIONS"',
  );
});

test("models: Claude Code's family aliases, opus by default", () => {
  expect(claudeCodeTmux.models).toEqual(["opus", "sonnet", "haiku", "fable"]);
  expect(claudeCodeTmux.defaultModel).toBe("opus");
});

test("seed files switch off every first-run dialog and turn bypass on", async () => {
  const seed = (file: string) => Bun.file(join(claudeCodeTmux.imageContext, "seed", file)).json();
  expect(await seed(".claude.json")).toMatchObject({
    hasCompletedOnboarding: true,
    hasSeenAutoDefaultNudge: true,
    projects: { "/home/agent/work": { hasTrustDialogAccepted: true } },
  });
  expect(await seed(".claude/settings.json")).toEqual({
    skipDangerousModePermissionPrompt: true,
    permissions: { defaultMode: "bypassPermissions" },
  });
});

test("ready means an empty input prompt and no dialog, whatever mode the footer shows", () => {
  expect(isClaudeReady(READY)).toBe(true);
  expect(isClaudeReady(READY.replace("⏵⏵ bypass permissions on", "⏵⏵ accept edits on"))).toBe(true);
  expect(isClaudeReady(READY.replace("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents", "  ? for shortcuts"))).toBe(true); // manual
  expect(isClaudeReady(`${READY}\n Teach auto mode about your environment?`)).toBe(false);
  // The footer's mode against the one claude was started in: a warning for the log when they differ.
  expect(modeMismatch(READY, "bypassPermissions")).toBeUndefined();
  expect(modeMismatch(READY, "auto")).toBe("claude runs in bypassPermissions, not auto");
  expect(modeMismatch(READY.replace("⏵⏵ bypass permissions on", "? for shortcuts"), "manual")).toBeUndefined();
  expect(modeMismatch(READY.replace("⏵⏵ bypass permissions on", "? for shortcuts"), "auto")).toBe("claude runs in a mode without a footer (manual?), not auto");
  expect(isClaudeReady(READY.replace("❯\n", "❯\u00a0\n"))).toBe(true); // what tmux really shows
  expect(isClaudeReady(READY.replace("❯\n", "❯ say hi\n"))).toBe(false); // someone is typing
  expect(isClaudeReady("")).toBe(false);
  expect(isClaudeReady(" Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit")).toBe(false);
  expect(isClaudeReady(`${READY}\n Make auto mode your default permission mode?`)).toBe(false);
});

test("readiness reads the tmux pane through exec; a failed or hung capture is not ready", async () => {
  const seen: string[][] = [];
  const exec = (ok: boolean, output: string) => async (command: string[]) => {
    seen.push(command);
    return { ok, output };
  };
  expect(await claudeCodeTmux.isReady(exec(true, READY))).toEqual({ ready: true, output: READY });
  expect(seen[0]).toEqual(["tmux", "capture-pane", "-p", "-t", "main"]);
  expect((await claudeCodeTmux.isReady(exec(false, READY))).ready).toBe(false);
  expect(claudeCodeTmux.attach).toEqual(["tmux", "attach-session", "-t", "main"]);
});

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", `${name}.json`)).json();

/** The turn of the fixtures' session (its `prompt_id`: every hook of a turn carries it). */
const TURN = "812e2206-73e1-49a0-92b3-5007fe777b12";

test("hook payloads from a real session become agent-neutral events", async () => {
  const events = async (name: string) => claudeCodeTmux.translate(await fixture(name));
  const closed = { kind: "dialog-closed" } as const;
  const turn = TURN;
  expect(await events("SessionStart-0")).toEqual([closed, { kind: "session-started", model: "claude-sonnet-5-5" }]);
  expect(await events("UserPromptSubmit-0")).toEqual([
    closed,
    { kind: "prompt-accepted", text: expect.stringMatching(/^Run the shell command 'echo hello > note.txt'/), turn },
  ]);
  const bash = "toolu_01RiV8ez3ZXz94MeoegpspuF";
  // What the call does, in neutral terms: Bash runs a program and says what for (its description).
  expect(await events("PreToolUse-0")).toEqual([{ kind: "tool-started", tool: "Bash", summary: "echo hello > note.txt", action: { kind: "run", target: "echo", says: "Write hello to note.txt" }, turn, call: bash, input: expect.any(String) }]);
  expect(await events("PreToolUse-1")).toEqual([{ kind: "tool-started", tool: "Read", summary: "/home/agent/work/note.txt", action: { kind: "read", target: "note.txt" }, turn, call: "toolu_01WAQ8t8M141SoYLmZamswGZ", input: expect.any(String) }]);
  expect(await events("PreToolUse-2")).toEqual([ // before the dialog is drawn: PreToolUse is synchronous
    { kind: "tool-started", tool: "AskUserQuestion", summary: "", action: { kind: "ask" }, turn, call: "toolu_01UpZ1YjgNDEtm9Qj7ydiBNz", input: expect.any(String) },
    { kind: "dialog-opened", dialog: "question", summary: "Which color do you prefer?", input: expect.any(String) },
  ]);
  expect(await events("PostToolUse-0")).toEqual([closed, { kind: "tool-finished", tool: "Bash", turn, call: bash, ms: 30 }]);
  const fromSubagent = { ...(await fixture("PostToolUse-0")), agent_id: "a1b2", agent_type: "Explore" };
  expect(claudeCodeTmux.translate(fromSubagent)).toEqual([{ kind: "tool-finished", tool: "Bash", turn, call: bash, agent: "a1b2", ms: 30 }]);
  expect(await events("PermissionRequest-0")).toEqual([
    { kind: "dialog-opened", dialog: "question", summary: "Which color do you prefer?", input: expect.any(String) },
  ]);
  expect(await events("PermissionRequest-plan")).toEqual([{ kind: "dialog-opened", dialog: "plan", summary: "Add a README", input: expect.any(String) }]);
  expect(await events("Elicitation-0")).toEqual([{ kind: "dialog-opened", dialog: "form", summary: "elic: Who are you?" }]);
  // A permission prompt (it also comes ~6 s into a PermissionRequest that waits: then a dialog is open already).
  expect(await events("Notification-0")).toEqual([
    { kind: "dialog-opened", dialog: "unknown", summary: "Claude needs your permission" },
    { kind: "notification", text: "Claude needs your permission" },
  ]);
  expect(await events("Stop-0")).toEqual([closed, { kind: "turn-finished", text: expect.stringContaining("You picked green"), turn }]);
  expect(claudeCodeTmux.translate({ hook_event_name: "PreCompact" })).toEqual([]);
  expect(claudeCodeTmux.translate("not an object")).toEqual([]);
  expect(claudeCodeTmux.translate({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /" } })).toEqual([
    { kind: "dialog-opened", dialog: "permission", summary: "Bash: rm -rf /", input: expect.any(String) },
  ]);
});

/** An Exec that records commands; capture-pane shows the next of `screens` (the last one stays). */
function fakeExec(screens: string[], failing = "") {
  const calls: string[] = [];
  const exec: Exec = async (command, stdin) => {
    calls.push(`${command.join(" ")}${stdin === undefined ? "" : ` < ${stdin}`}`);
    const ok = !failing || !command.includes(failing);
    const output = command.includes("capture-pane") ? (screens.length > 1 ? screens.shift()! : screens[0]!) : "";
    return { ok, output };
  };
  return { exec, calls };
}

const yes = () => true;
/** Screens of claude 2.1.296 in a pet (160×48), captured 03.11.2026. */
const screen = (name: string) => readFileSync(join(import.meta.dir, "screens", `${name}.txt`), "utf8");

test("send pastes through a tmux buffer into an empty input box and presses Enter", async () => {
  const { exec, calls } = fakeExec([READY]);
  const text = "héllo wörld, $HOME `x`\nsecond line\twith a tab";
  expect(await claudeCodeTmux.send(exec, text, yes)).toEqual({ status: "sent" });
  expect(calls).toEqual([
    "tmux capture-pane -p -t main",
    `tmux load-buffer -b household - < ${text}`,
    "tmux paste-buffer -p -d -b household -t main",
    "tmux capture-pane -p -t main",
    "tmux send-keys -t main Enter",
  ]);
});

test("control characters never reach the agent as keys", async () => {
  const { exec, calls } = fakeExec([READY]);
  await claudeCodeTmux.send(exec, "a\u001b[201~b\r\u0007c\u009bd\n", yes);
  expect(calls[1]).toBe("tmux load-buffer -b household - < a[201~bcd\n");
});

test("send refuses, typing nothing, while a dialog is on screen, the box is not empty or the screen is unreadable", async () => {
  for (const name of ["ask", "plan", "perm"]) {
    const dialog = fakeExec([screen(name)]);
    expect(await claudeCodeTmux.send(dialog.exec, "x", yes)).toEqual({ status: "refused", reason: "a dialog is on screen" });
    expect(dialog.calls).toEqual(["tmux capture-pane -p -t main"]);
  }
  const typing = fakeExec([READY.replace("❯\n", "❯ someone types\n")]);
  expect(await claudeCodeTmux.send(typing.exec, "x", yes)).toEqual({ status: "refused", reason: "the input box is not empty" });
  expect((await claudeCodeTmux.send(fakeExec([READY], "capture-pane").exec, "x", yes)).status).toBe("refused");
  expect((await claudeCodeTmux.send(fakeExec([READY]).exec, "x", () => false)).status).toBe("refused");
});

test("a dialog that opens during the paste gets no Enter, and the message is reported stuck", async () => {
  const drawn = fakeExec([READY, screen("ask")]);
  expect(await claudeCodeTmux.send(drawn.exec, "x", yes)).toMatchObject({ status: "stuck" });
  expect(drawn.calls.some((call) => call.includes("send-keys"))).toBe(false);

  // Delivery learned of a dialog (PreToolUse) while the text was being pasted.
  const told = fakeExec([READY]);
  const pasted = () => told.calls.some((call) => call.includes("paste-buffer"));
  expect(await claudeCodeTmux.send(told.exec, "x", () => !pasted())).toMatchObject({ status: "stuck" });
  expect(told.calls.some((call) => call.includes("send-keys"))).toBe(false);
});

test("the input box is the dialog marker on real screens; past prompts and menu lines are not the box", async () => {
  expect(inputBox(screen("idle"))).toBe(""); // its transcript has the past prompt `❯ 1. say only the word ok`
  expect(inputBox(screen("busy-queued"))).toBe(""); // only the placeholder shown while a message waits
  for (const name of ["ask", "plan", "perm"]) expect(inputBox(screen(name))).toBeUndefined();
  const lastOption = screen("ask").replace("❯ 1. Red", "  1. Red").replace("  4. Chat about this", "❯ 4. Chat about this");
  expect(inputBox(lastOption)).toBeUndefined(); // the selected option sits right under a rule
  expect(await claudeCodeTmux.dialogVisible(fakeExec([screen("ask")]).exec)).toBe(true);
  expect(await claudeCodeTmux.dialogVisible(fakeExec([screen("idle")]).exec)).toBe(false);
  expect(await claudeCodeTmux.dialogVisible(fakeExec([READY], "capture-pane").exec)).toBe(true); // cannot tell
});

test("failed tools and Household's own tools become agent-neutral events; the agent's text is no event", async () => {
  const events = async (name: string) => claudeCodeTmux.translate(await fixture(name));
  const turn = TURN; // prompt_id, as on every other hook of the turn
  expect(claudeCodeTmux.translate({ hook_event_name: "MessageDisplay", prompt_id: turn, message_id: "m", index: 0, final: true, delta: "x" })).toEqual([]);
  // A failed tool ends its dialog, as a finished one does.
  expect(await events("PostToolUseFailure-0")).toEqual([
    { kind: "dialog-closed" },
    { kind: "tool-finished", tool: "Bash", turn, call: "toolu_01Fa1LedXq9w2kVb7nTzR3Yc", ms: 59, failed: true },
  ]);
  const reply = { ...(await fixture("PreToolUse-0")), tool_name: "mcp__household__reply", tool_input: { text: "Done" } };
  expect(claudeCodeTmux.translate(reply)).toEqual([
    { kind: "tool-started", tool: "mcp__household__reply", summary: "reply", action: { kind: "other", target: "household: reply" }, turn, call: "toolu_01RiV8ez3ZXz94MeoegpspuF", internal: true, input: expect.any(String) },
  ]);
  expect(JSON.stringify(claudeCodeTmux.translate(reply))).not.toContain("Done");
  const secret = { ...reply, tool_name: "mcp__household__scout_secret", tool_input: { value: "QA_RAW_SECRET_NEVER_IN_ACTIVITY", id: "scout-test", key: "token" } };
  expect(claudeCodeTmux.translate(secret)[0]).toMatchObject({ summary: "scout_secret", internal: true });
  expect(JSON.stringify(claudeCodeTmux.translate(secret))).not.toContain("QA_RAW_SECRET_NEVER_IN_ACTIVITY");
  const other = { ...reply, tool_name: "mcp__householdish__reply" };
  expect(claudeCodeTmux.translate(other)[0]).not.toHaveProperty("internal");
  // A turn ending in an API error: StopFailure, the turn's id; a session going on (compacted, cleared, resumed) loses nothing.
  expect(claudeCodeTmux.translate({ hook_event_name: "StopFailure", prompt_id: turn, error: "overloaded_error", last_assistant_message: "" })).toEqual([
    { kind: "dialog-closed" },
    { kind: "turn-failed", error: "overloaded_error", turn },
  ]);
  for (const source of ["compact", "clear", "resume"]) {
    expect(claudeCodeTmux.translate({ ...(await fixture("SessionStart-0")), source })).toEqual([{ kind: "dialog-closed" }, { kind: "session-started", model: "claude-sonnet-5-5", continues: true }]);
  }
  // Cut short on code points: an emoji is never halved; a lone surrogate is mended.
  const long = { ...(await fixture("PreToolUse-0")), tool_input: { command: `${"x".repeat(118)}🐾🐾🐾 \uD800` } };
  expect((claudeCodeTmux.translate(long)[0] as { summary: string }).summary).toBe(`${"x".repeat(118)}🐾…`);
});

test("hooks come from a root-owned --settings file for all supported events, through the hook script", async () => {
  const settings = await Bun.file(join(claudeCodeTmux.imageContext, "claude-settings.json")).json();
  expect(Object.keys(settings.hooks).sort()).toEqual([
    "Elicitation",
    "Notification",
    "PermissionDenied",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "StopFailure",
    "UserPromptSubmit",
  ]);
  expect(settings.disableAllHooks).toBe(false); // wins over the agent-writable user settings
  // PermissionRequest may wait for the person: its curl has no time limit, and claude's outlasts Household's
  // wait, so Household's timeout answer comes first. The others give up quickly.
  for (const [event, [{ hooks }]] of Object.entries(settings.hooks) as [string, [{ hooks: { command: string; timeout?: number }[] }]][]) {
    const expected = event === "PermissionRequest" ? { type: "command", command: "/usr/local/bin/household-hook", timeout: 1860 } : { type: "command", command: "/usr/local/bin/household-hook 4", timeout: 5 };
    expect(hooks).toEqual([expected] as never);
  }
  expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBeGreaterThan(DIALOG_WAIT_MS / 1000 + 30);
  // Root-owned, so old homes get them too: Household's tools never ask, auto mode's opt-in never shows.
  expect(settings.permissions).toEqual({ allow: ["mcp__household"] });
  expect(settings.skipAutoPermissionPrompt).toBe(true);
  const entrypoint = await Bun.file(join(claudeCodeTmux.imageContext, "entrypoint.sh")).text();
  expect(entrypoint).toContain("claude --settings /etc/household/claude-settings.json");
  const dockerfile = await Bun.file(join(claudeCodeTmux.imageContext, "Dockerfile")).text();
  expect(dockerfile).toContain("COPY --chmod=644 claude-settings.json /etc/household/claude-settings.json");
});

test("native auto-mode denials attach to their exact tool; successful tools never imply classifier approval", () => {
  const hook = { hook_event_name: "PermissionDenied", permission_mode: "auto", prompt_id: "turn", tool_use_id: "call", tool_name: "Bash", tool_input: { command: "private command" }, reason: "[Data Exfiltration] secret value" };
  expect(claudeCodeTmux.translate(hook)).toEqual([{ kind: "tool-review", review: "claude-auto:call", call: "call", turn: "turn", status: "denied", scope: "action" }]);
  // Native PermissionDenied also covers unavailable/no-verdict classifiers. It still means denied,
  // never a fabricated verdict, risk score, or exposure of Claude's free-form reason.
  expect(claudeCodeTmux.translate({ ...hook, agent_id: "sub", reason: "Classifier unavailable" })).toEqual([{ kind: "tool-review", review: "claude-auto:call", call: "call", turn: "turn", agent: "sub", status: "denied", scope: "action" }]);
  expect(claudeCodeTmux.translate({ ...hook, tool_use_id: undefined })).toEqual([]);
  expect(claudeCodeTmux.dialogs!.ask(hook)).toBeUndefined();
  for (const hook_event_name of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]) {
    expect(claudeCodeTmux.translate({ ...hook, hook_event_name }).some(event => event.kind === "tool-review")).toBe(false);
  }
});

test("the dialogs Household answers: questions, plans and permissions at PermissionRequest, nothing else", async () => {
  const { ask } = claudeCodeTmux.dialogs!;
  expect(ask(await fixture("PermissionRequest-0"))).toEqual({
    kind: "questions",
    questions: [{ text: "Which color do you prefer?", options: [{ label: "Red", description: "Prefer red" }, { label: "Green", description: "Prefer green" }], multiSelect: false }],
    input: expect.any(String), // its call's fingerprint
  });
  expect(ask(await fixture("PermissionRequest-multi"))).toMatchObject({
    questions: [{ text: "Which colors do you like?", multiSelect: true }, { text: "Which size?", options: [{ label: "M" }, { label: "L" }], multiSelect: false }],
  });
  expect(ask(await fixture("PermissionRequest-plan"))).toEqual({ kind: "plan", plan: "# Add a README\n\n1. Write README.md\n2. Commit", input: expect.any(String) });
  expect(ask(await fixture("PreToolUse-2"))).toBeUndefined(); // the same question, but its hook does not wait
  expect(ask(await fixture("Elicitation-0"))).toBeUndefined(); // MCP forms stay in the terminal
  // Any other tool: a permission (claude's safety check, live 05.11; any ask in manual mode), with what for, and the
  // fingerprint of its call: the same as its PreToolUse's, whatever the order of the input's keys.
  const tool_input = { command: 'rm "$x/$f.gz"', description: "Remove the extracted archive" };
  const rm = { hook_event_name: "PermissionRequest", permission_mode: "bypassPermissions", tool_name: "Bash", tool_input };
  const started = claudeCodeTmux.translate({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { description: tool_input.description, command: tool_input.command }, tool_use_id: "c" });
  const input = (started[0] as { input: string }).input;
  expect(ask(rm)).toEqual({ kind: "permission", tool: "Bash", detail: 'rm "$x/$f.gz"', about: "Remove the extracted archive", input });
  expect(claudeCodeTmux.translate(rm)).toEqual([{ kind: "dialog-opened", dialog: "permission", summary: 'Bash: rm "$x/$f.gz"', input }]);
  expect(ask({ ...rm, permission_mode: "manual", tool_name: "Write", tool_input: { file_path: "/etc/x" } })).toEqual({ kind: "permission", tool: "Write", detail: "/etc/x", input: expect.any(String) }); // no words of its own: none
  // A permission prompt claude asks without the hook: a dialog only the terminal can answer.
  expect(claudeCodeTmux.translate({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" })).toEqual([
    { kind: "dialog-opened", dialog: "unknown", summary: "Claude needs your permission" },
    { kind: "notification", text: "Claude needs your permission" },
  ]);
  expect(ask({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toBeUndefined();
  // Over Household's limits, or two questions alike: left to the terminal.
  const asking = (questions: object[]) => ask({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } });
  const q = (question: string, options = [{ label: "a" }, { label: "b" }]) => ({ question, options });
  expect(asking([q("no options", [])])).toBeUndefined();
  expect(asking([q("1"), q("2"), q("3"), q("4")])).toBeDefined();
  expect(asking([q("1"), q("2"), q("3"), q("4"), q("5")])).toBeUndefined();
  expect(asking([q("x", Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })))])).toBeUndefined();
  expect(asking([q("x", [{ label: "l".repeat(65) }])])).toBeUndefined();
  expect(asking([q("x", [{ label: "a", description: "d".repeat(301) } as never])])).toBeUndefined();
  expect(asking([q("q".repeat(1001))])).toBeUndefined();
  expect(asking([q("same"), q("same")])).toBeUndefined();
  expect(ask({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "p".repeat(16_385) } })).toBeUndefined();
});

test("answers in claude's terms: allow with the original input and answers (several as 'A, B'), deny with a message", async () => {
  const { answer } = claudeCodeTmux.dialogs!;
  const decision = (output: unknown) => (output as { hookSpecificOutput: { hookEventName: string; decision: object } }).hookSpecificOutput;
  // A permission: a bare allow (with updatedInput claude would check the call again, and its safety check ask again), or a deny.
  const rm = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm x" } };
  expect(decision(answer(rm, { kind: "allow" }))).toEqual({ hookEventName: "PermissionRequest", decision: { behavior: "allow" } });
  expect(decision(answer(rm, { kind: "deny" }))).toEqual({ hookEventName: "PermissionRequest", decision: { behavior: "deny", message: expect.stringContaining("Your human said no") } });
  // Stopped while it waited: refused, and its turn interrupted (claude 2.1.296 takes `interrupt` on a deny).
  expect(decision(answer(rm, { kind: "stopped" }))).toEqual({ hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Your human stopped you.", interrupt: true } });
  // Nobody answered: refused, but not as a no.
  const unanswered = decision(answer(rm, { kind: "unanswered", waitedMs: 30_000 })) as { decision: { behavior: string; message: string } };
  expect(unanswered.decision.behavior).toBe("deny");
  expect(unanswered.decision.message).toStartWith("No answer from your human in 30 s");
  expect(unanswered.decision.message).not.toContain("said no to");
  const one = await fixture("PermissionRequest-0");
  expect(decision(answer(one, { kind: "answers", answers: [{ chosen: ["Green"] }] }))).toEqual({
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow", updatedInput: { ...one.tool_input, answers: { "Which color do you prefer?": "Green" } } },
  });
  const multi = await fixture("PermissionRequest-multi");
  const both = answer(multi, { kind: "answers", answers: [{ chosen: ["Green", "Blue"] }, { text: "XL, if there is one" }] });
  expect(decision(both)).toMatchObject({
    decision: { behavior: "allow", updatedInput: { questions: multi.tool_input.questions, answers: { "Which colors do you like?": "Green, Blue", "Which size?": "XL, if there is one" } } },
  });
  const plan = await fixture("PermissionRequest-plan");
  expect(decision(answer(plan, { kind: "approve" }))).toEqual({
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow", updatedInput: plan.tool_input }, // a bare allow of a plan is ignored
  });
  expect(decision(answer(plan, { kind: "revise", text: "and tests" }))).toEqual({
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: "Your human asks you to revise the plan: and tests" },
  });
  expect(decision(answer(one, { kind: "refused", message: "Household could not put this to your human: …" }))).toEqual({
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: "Household could not put this to your human: …" },
  });
  expect(decision(answer(one, { kind: "timeout", answers: [undefined] }))).toEqual({
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: expect.stringMatching(/^Your human did not answer in time\. Carry on/) },
  });
  expect(decision(answer(multi, { kind: "timeout", answers: [{ chosen: ["Blue"] }, undefined] }))).toMatchObject({
    decision: { behavior: "deny", message: expect.stringContaining('They answered only some questions: "Which colors do you like?": "Blue".') },
  });
});

test.skipIf(!Bun.which("jq"))("the entrypoint approves the API key placeholder on every start, also in a home from before; an OAuth pet is left alone", () => {
  const entrypoint = readFileSync(join(claudeCodeTmux.imageContext, "entrypoint.sh"), "utf8");
  const approve = /^if \[ -n "\$\{ANTHROPIC_API_KEY:-\}" \]; then\n[^]*?\nfi$/m.exec(entrypoint)![0];
  const home = mkdtempSync(join(tmpdir(), "household-entrypoint-"));
  const run = (env: Record<string, string>) => Bun.spawnSync(["sh", "-eu", "-c", approve], { env: { PATH: process.env.PATH!, HOME: home, ...env } });
  try {
    const file = join(home, ".claude.json");
    writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["older"], rejected: [PLACEHOLDER_API_KEY.slice(-20)] } }));
    expect(run({ ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }).exitCode).toBe(0);
    expect(run({ ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }).exitCode).toBe(0); // again: once in the list
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after).toEqual({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["older", PLACEHOLDER_API_KEY.slice(-20)], rejected: [] } });
    writeFileSync(file, "{}");
    expect(run({ CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_TOKEN }).exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("{}");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("what a call does, in one table, in neutral terms: its kind, what it is on, the agent's own words; and what it runs on", () => {
  const of = (tool: string, input: Record<string, unknown>) => actionOf(tool, input);
  expect(of("Bash", { command: "tar -xzf a.tgz", description: "Extract all files" })).toEqual({ action: { kind: "run", target: "tar", says: "Extract all files" }, summary: "tar -xzf a.tgz", internal: false });
  expect(of("Read", { file_path: `${HOME}/work/src/JWT.php` })).toEqual({ action: { kind: "read", target: "src/JWT.php" }, summary: `${HOME}/work/src/JWT.php`, internal: false });
  expect(of("Edit", { file_path: `${HOME}/notes.md` }).action).toEqual({ kind: "edit", target: "~/notes.md" });
  expect(of("Write", { file_path: `${HOME}/work/${"deep/".repeat(10)}out.txt` }).action).toEqual({ kind: "write", target: "out.txt" }); // long: its name
  expect(of("Grep", { pattern: "TODO" }).action).toEqual({ kind: "search", target: "TODO" });
  expect(of("WebSearch", { query: "bun sqlite" }).action).toEqual({ kind: "search", target: "bun sqlite" });
  expect(of("WebFetch", { url: "https://docs.example.com/a/b?c=1" })).toEqual({ action: { kind: "fetch", target: "docs.example.com" }, summary: "https://docs.example.com/a/b?c=1", internal: false });
  expect(of("Task", { description: "Find .txt files" })).toEqual({ action: { kind: "delegate", says: "Find .txt files" }, summary: "Find .txt files", internal: false }); // a subagent: work
  expect(of("ExitPlanMode", {}).action).toEqual({ kind: "plan" });
  expect(of("mcp__github__create_issue", { title: "Bug" })).toEqual({ action: { kind: "other", target: "github: create issue" }, summary: "Bug", internal: false });
  expect(of("NotebookRead", {}).action).toEqual({ kind: "other", target: "Notebook read" });
  // Plumbing, no work to show: finding tools, the task list and background tasks, MCP resources, every Household tool.
  for (const tool of ["ToolSearch", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop", "BashOutput", "KillShell", "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__household__reply"]) {
    expect(of(tool, {}).internal).toBe(true);
  }
  expect(shortPath("/etc/hosts")).toBe("/etc/hosts");
  expect(claudeCodeTmux.home).toBe(HOME);
  expect(short("👨‍👩‍👧🇺🇦abc", 3)).toBe("👨‍👩‍👧🇺🇦…"); // a flag or a family emoji is one character
});

test("the program a command runs: past set-up, wrappers, assignments, quotes, comments and the shell's marks", () => {
  const cases: [string, string | undefined][] = [
    ["cd app && npm test", "npm"],
    ['FOO="a b" curl -s x', "curl"],
    ["(cd x && make)", "make"],
    ["# note\nnpm i", "npm"],
    ["'curl' https://x", "curl"],
    ["sudo -u root apt-get install jq", "apt-get"],
    ["env LANG=C /usr/bin/find . -name x", "find"],
    ["time make -j4", "make"],
    ["timeout 10 curl x", "curl"],
    ["nohup ./server.sh &", "server.sh"],
    ["export A=1; cd /tmp; ls -la", "ls"],
    ["! grep -q x f", "grep"],
    ["{ echo a; echo b; }", "echo"],
    ["cat log | grep error", "cat"],
    ["cd /tmp", undefined],
    ["", undefined],
  ];
  expect(cases.map(([command]) => program(command))).toEqual(cases.map(([, want]) => want));
});

test("stopping claude: out of copy mode, Escape once on a claude that works, and seen waiting for input; never on an idle one", async () => {
  const BUSY = screen("busy-queued");
  const run = async (screens: string[], inMode = "0") => {
    const calls: string[] = [];
    const exec: Exec = async (command) => {
      calls.push(command.join(" "));
      const output = command.includes("capture-pane") ? (screens.length > 1 ? screens.shift()! : screens[0]!) : command.includes("display-message") ? `${inMode}\n` : "";
      return { ok: true, output };
    };
    return { result: await claudeCodeTmux.interrupt!(exec), calls };
  };
  const stopped = await run([BUSY, BUSY, READY], "1");
  expect(stopped.result).toEqual({ status: "stopped" });
  expect(stopped.calls.filter((call) => !call.includes("capture-pane"))).toEqual([
    "tmux display-message -p -t main #{pane_in_mode}",
    "tmux send-keys -t main -X cancel", // copy mode first: a scrolled pane would take the key
    "tmux send-keys -t main Escape",
  ]);
  // Idle already: no key at all.
  const idle = await run([READY]);
  expect(idle.result).toEqual({ status: "idle" });
  expect(idle.calls.some((call) => call.includes("Escape"))).toBe(false);
  // Text left in its input after the stop: said, so nothing is pasted over it.
  expect((await run([BUSY, READY.replace("❯\n", "❯ half typed\n")])).result).toEqual({ status: "stopped", leftover: "half typed" });
  // Still working after the looks: not stopped (no second Escape).
  const stuck = await run([BUSY]);
  expect(stuck.result).toEqual({ status: "failed" });
  expect(stuck.calls.filter((call) => call.includes("Escape"))).toHaveLength(1);
}, 10_000);

test("Claude's pinned Anthropic aliases expose native effort levels and pass only an explicit selection in its native environment", () => {
  const context = { caCertPath: "/ca", eventsUrl: "http://unused/events", mcpUrl: "http://unused/mcp", instructions: "", model: "haiku" };
  for (const model of claudeCodeTmux.models) {
    expect(claudeCodeTmux.modelOptions!(model).supportedReasoningEfforts!.map(option => option.reasoningEffort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claudeCodeTmux.modelOptions!(model).defaultReasoningEffort).toBe(model === "fable" ? "high" : "medium");
    expect(claudeCodeTmux.acceptsReasoningEffort!(model, "ultra")).toBe(false);
    expect(claudeCodeTmux.acceptsReasoningEffort!(model, "ultracode")).toBe(false);
    for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(claudeCodeTmux.acceptsReasoningEffort!(model, reasoningEffort)).toBe(true);
      expect(claudeCodeTmux.env({ ...context, model, reasoningEffort }).CLAUDE_CODE_EFFORT_LEVEL).toBe(reasoningEffort);
    }
  }
  expect(claudeCodeTmux.env(context)).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
  expect(claudeCodeTmux.acceptsReasoningEffort!("unknown", "high")).toBe(false);
});

test("the subagent model is claude's own setting: one of its model aliases, into CLAUDE_CODE_SUBAGENT_MODEL; none set leaves subagents on the pet's model", () => {
  const context = { caCertPath: "/ca", eventsUrl: "http://gw/events", mcpUrl: "http://gw/mcp", instructions: "", model: "opus" };
  const subagent = claudeCodeTmux.settings!.find(setting => setting.key === "subagentModel");
  expect(subagent!.key).toBe("subagentModel");
  expect(subagent!.options.map(({ id }) => id)).toEqual(["opus", "sonnet", "haiku", "fable"]);
  expect(subagent!.defaultLabel).toBe("the pet's own model");
  expect(claudeCodeTmux.env({ ...context, settings: { subagentModel: "haiku" } }).CLAUDE_CODE_SUBAGENT_MODEL).toBe("haiku");
  expect(claudeCodeTmux.env(context)).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL");
});

// Opt in to the installed, pinned binary. This executes only the local /effort command;
// isolated configuration and no credentials ensure that no model inference can occur.
test.skipIf(process.env.HOUSEHOLD_NATIVE_ADAPTER_SMOKE !== "1" || !Bun.which("claude"))("native pinned Claude launch reads adapter effort, including default, for every alias without inference", () => {
  const home = mkdtempSync(join(tmpdir(), "household-claude-effort-native-"));
  try {
    const version = Bun.spawnSync(["claude", "--version"]);
    expect(version.stdout.toString().trim()).toStartWith("2.1.296 ");
    for (const model of claudeCodeTmux.models) {
      for (const reasoningEffort of [undefined, "low", "max"]) {
        const context = { caCertPath: "/unused", eventsUrl: "http://unused/events", mcpUrl: "http://unused/mcp", instructions: "", model, reasoningEffort };
        const adapterEnv = claudeCodeTmux.env(context);
        const child = Bun.spawnSync(["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", adapterEnv.HOUSEHOLD_MODEL!], {
          cwd: home,
          env: { PATH: process.env.PATH!, HOME: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
            ...(adapterEnv.CLAUDE_CODE_EFFORT_LEVEL ? { CLAUDE_CODE_EFFORT_LEVEL: adapterEnv.CLAUDE_CODE_EFFORT_LEVEL } : {}) },
          stdin: Buffer.from(JSON.stringify({ type: "user", message: { role: "user", content: "/effort status" } }) + "\n"),
        });
        expect(child.exitCode).toBe(0);
        const result = child.stdout.toString().trim().split("\n").map(line => JSON.parse(line)).find(packet => packet.type === "result");
        if (reasoningEffort === undefined) expect(result.result).toBe(`Effort level: auto (currently ${model === "fable" ? "high" : "medium"})`);
        else expect(result.result).toStartWith(`Current effort level: ${reasoningEffort}`);
        expect(result.duration_api_ms).toBe(0);
        expect(result.num_turns).toBe(0);
        expect(result.total_cost_usd).toBe(0);
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("scheduled readiness distinguishes busy Claude from its editable input box", async () => {
  for (const [output, idle] of [[READY, true], [READY + "\nesc to interrupt", false], ["dialog", false]] as const) {
    expect(await claudeCodeTmux.isIdle!(async () => ({ ok: true, output }))).toBe(idle);
  }
  expect(await claudeCodeTmux.isIdle!(async () => ({ ok: false, output: READY }))).toBe(false);
});


test("account connectors are opt-in for pets and always off for scouts, including the launch arguments", () => {
  const context = { caCertPath: "/ca", eventsUrl: "http://gw/events", mcpUrl: "http://gw/mcp", instructions: "", model: "opus" };
  const entrypoint = readFileSync(join(claudeCodeTmux.imageContext, "entrypoint.sh"), "utf8");
  const launch = entrypoint.slice(entrypoint.indexOf("set -- --strict-mcp-config"));
  for (const scout of [false, true]) for (const enabled of [undefined, "false", "true"]) {
    const env = claudeCodeTmux.env({ ...context, scout, settings: enabled ? { claudeAiConnectors: enabled } : {} });
    const expected = !scout && enabled === "true";
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe(String(expected));
    const result = Bun.spawnSync(["sh", "-c", `tmux() { if [ "$1" = has-session ]; then return 1; fi; printf '%s\n' "$@"; }; ${launch}`], { env });
    expect(result.exitCode).toBe(0);
    const args = result.stdout.toString().trim().split("\n");
    expect(args.includes("--strict-mcp-config")).toBe(!expected);
    expect(args).toContain("/etc/household/mcp.json");
  }
});
