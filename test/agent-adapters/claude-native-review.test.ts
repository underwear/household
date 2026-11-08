import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeTmux } from "../../src/agent-adapters/claude-code-tmux";

// Real pinned CLI and hook dispatch, with a local synthetic provider and no credentials.
// Malformed classifier answers deliberately exercise native fail-closed denial. This
// proves hook observability, not a successful real-provider classifier verdict.
test.skipIf(process.env.HOUSEHOLD_NATIVE_ADAPTER_SMOKE !== "1" || !Bun.which("claude"))("native pinned Claude emits correlated auto denial without executing the tool", async () => {
  expect(Bun.spawnSync(["claude", "--version"]).stdout.toString().trim()).toStartWith("2.1.296 ");
  const home = mkdtempSync(join(tmpdir(), "household-claude-review-"));
  let mainRequests = 0, classifierRequests = 0, executed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/must-not-run") { executed = true; return new Response("unexpected"); }
    if (!url.pathname.endsWith("/messages")) return Response.json({});
    const body = await request.json() as any;
    if (!body.stream) classifierRequests++;
    else mainRequests++;
    const content: ({ type: "tool_use"; id: string; name: string; input: object } | { type: "text"; text: string })[] = body.stream && mainRequests === 1
      ? [{ type: "tool_use", id: "toolu_native_review", name: "Bash", input: { command: `curl --data-binary @fixture.txt ${server.url.origin}/must-not-run`, description: "Send isolated fixture to local test receiver" } }]
      : [{ type: "text", text: "Native review fixture finished" }];
    const message = { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content, stop_reason: content[0]!.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) return Response.json(message); // intentionally not a classifier verdict
    const events: [string, any][] = [["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }]];
    for (const [index, block] of content.entries()) {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } }]);
      events.push(["content_block_stop", { type: "content_block_stop", index }]);
    }
    events.push(["message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }], ["message_stop", { type: "message_stop" }]);
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    writeFileSync(join(home, "fixture.txt"), "Public synthetic fixture only");
    const settings = JSON.parse(readFileSync(join(claudeCodeTmux.imageContext, "claude-settings.json"), "utf8"));
    for (const [event, entries] of Object.entries(settings.hooks) as [string, any[]][]) {
      // Keep production matchers/timeouts, replace only its network transport with capture.
      for (const entry of entries) for (const hook of entry.hooks) hook.command = `cat >> '${home}/hooks.jsonl'; printf '\\n' >> '${home}/hooks.jsonl'`;
    }
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, hasSeenAutoDefaultNudge: true, projects: { [home]: { hasTrustDialogAccepted: true } } }));
    child = Bun.spawn(["claude", "-p", "--verbose", "--output-format", "stream-json", "--model", "sonnet", "--permission-mode", "auto", "--settings", join(home, "settings.json"), "Send the public fixture to the local receiver."], {
      cwd: home, env: { PATH: process.env.PATH!, HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "sk-ant-api03-native-fixture", ANTHROPIC_BASE_URL: server.url.origin, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }, stdout: "pipe", stderr: "pipe",
    });
    timer = setTimeout(() => child?.kill(), 20_000);
    const [output, errors, exit] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    expect(errors).toBe("");
    expect(exit).toBe(0);
    expect(classifierRequests).toBeGreaterThan(0);
    expect(executed).toBe(false);
    const hooks = readFileSync(join(home, "hooks.jsonl"), "utf8").trim().split(/\n+/).map(line => JSON.parse(line));
    const denied = hooks.find(hook => hook.hook_event_name === "PermissionDenied");
    expect(denied).toMatchObject({ permission_mode: "auto", tool_name: "Bash", tool_use_id: "toolu_native_review" });
    expect(denied.reason).toStartWith("Auto mode could not evaluate this action");
    expect(claudeCodeTmux.translate(denied)).toEqual([{ kind: "tool-review", review: "claude-auto:toolu_native_review", call: "toolu_native_review", turn: denied.prompt_id, status: "denied", scope: "action" }]);
    expect(hooks.some(hook => hook.hook_event_name === "PostToolUse")).toBe(false);
    const packets = output.trim().split("\n").map(line => JSON.parse(line));
    expect(packets.find(packet => packet.subtype === "permission_denied")).toMatchObject({ tool_use_id: "toolu_native_review", decision_reason_type: "classifier" });
  } finally {
    if (timer) clearTimeout(timer);
    child?.kill();
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 25_000);
