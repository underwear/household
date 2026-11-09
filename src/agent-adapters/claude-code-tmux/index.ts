import type { AgentAdapter, Exec, KeyUse, SendResult } from "../../core/agent";
import type { Provider } from "../../core/keys";
import { HOME } from "./actions";
import { readAnthropicAllowance } from "./allowance";
import { answerFor, askOf } from "./dialogs";
import { translateHook } from "./translate";

/**
 * Placeholder in the shape of a `claude setup-token` OAuth token (a subscription's). Claude Code sends it as
 * `Authorization: Bearer …` to api.anthropic.com; the gateway swaps in the real token there.
 */
export const PLACEHOLDER_TOKEN = `sk-ant-oat01-household-placeholder-${"x".repeat(71)}AA`;
/**
 * Placeholder in the shape of an Anthropic API key. Claude Code sends it as `x-api-key`; the gateway swaps in the
 * real key. The entrypoint approves it in ~/.claude.json on every start (its last 20 characters), so no "use this
 * API key?" dialog, also in a home from before.
 */
export const PLACEHOLDER_API_KEY = `sk-ant-api03-household-placeholder-${"x".repeat(71)}AA`;

const ANTHROPIC = { host: "api.anthropic.com", port: 443 };

/** An Anthropic key by its value: a subscription's OAuth token, or an API key. */
function useKey(provider: Provider, value: string): KeyUse | { problem: string } {
  if (provider !== "anthropic") return { problem: `claude-code-tmux runs on anthropic keys, not ${provider}` };
  if (value.startsWith("sk-ant-oat")) {
    return { kind: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_TOKEN }, wire: [{ target: ANTHROPIC, header: "authorization", prefix: "Bearer " }] };
  }
  if (value.startsWith("sk-ant-api")) {
    return { kind: "API key", env: { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }, wire: [{ target: ANTHROPIC, header: "x-api-key", prefix: "" }] };
  }
  return { problem: "not an Anthropic key: a subscription token (sk-ant-oat01-…, from `claude setup-token`) or an API key (sk-ant-api03-…)" };
}

const SESSION = "main";
const CAPTURE = ["tmux", "capture-pane", "-p", "-t", SESSION];

// First-run dialogs (the seed files keep them away).
const FIRST_RUN = [
  "Do you trust the files in this folder",
  "Select login method",
  "Bypass Permissions mode",
  "Make auto mode your default", // auto mode's (its opt-in, skipAutoPermissionPrompt keeps away)
  "Teach auto mode about your environment?",
  "Choose the text style",
  "Detected a custom API key", // the entrypoint approves the placeholder; should claude ask anyway, it is a dialog
];
/**
 * The input box: `❯` lines between two full-width rules. Every dialog (question, permission, plan, form) takes
 * its place, so its absence is the dialog marker (claude 2.1.296 screens in test/agent-adapters). Past prompts are not
 * between rules; a dialog's own menu line under a rule (`❯ 4. Chat about this`) has none below it.
 */
const INPUT_BOX = /^─{20,}\n❯([^]*?)\n─{20,}$/m;

/** Shown in an empty input box while claude works through messages queued earlier. */
const PLACEHOLDER = "Press up to edit queued messages";

/** What the input box holds (`""`: empty), or undefined when no input box is on screen: a dialog is. */
export function inputBox(screen: string): string | undefined {
  if (FIRST_RUN.some((dialog) => screen.includes(dialog))) return undefined;
  const typed = INPUT_BOX.exec(screen)?.[1]!.trim();
  return typed === PLACEHOLDER ? "" : typed;
}

/** claude's status line while it works on a turn. */
const WORKING = "esc to interrupt";
/** After Escape, claude shows it waits for input within this many looks, this far apart. */
const STOP_LOOKS = 10;
const STOP_LOOK_MS = 300;

/** Waiting for input: no turn going on, and its input box on screen (no dialog); undefined when it is not. */
function idleBox(screen: string | undefined): string | undefined {
  return screen === undefined || screen.includes(WORKING) ? undefined : inputBox(screen);
}

/**
 * Escape, once, and only on a claude that works (never Ctrl-C: a third in a row closes it), after leaving tmux's
 * copy mode (a scrolled pane would take the key, and its screen is not claude's): then it should show it waits
 * for input.
 */
async function interrupt(exec: Exec): Promise<{ status: "stopped" | "idle" | "failed"; leftover?: string }> {
  const mode = await exec(["tmux", "display-message", "-p", "-t", SESSION, "#{pane_in_mode}"]);
  if (mode.ok && mode.output.trim() === "1") await exec(["tmux", "send-keys", "-t", SESSION, "-X", "cancel"]);
  const before = await screen(exec);
  if (before === undefined) return { status: "failed" };
  if (idleBox(before) !== undefined) return { status: "idle" };
  if (!(await exec(["tmux", "send-keys", "-t", SESSION, "Escape"])).ok) return { status: "failed" };
  for (let look = 0; look < STOP_LOOKS; look++) {
    await Bun.sleep(STOP_LOOK_MS);
    const box = idleBox(await screen(exec));
    if (box !== undefined) return { status: "stopped", ...(box ? { leftover: box } : {}) };
  }
  return { status: "failed" };
}

/** Ready: an empty input box (no first-run dialog in its place), whatever permission mode its footer shows. */
export function isClaudeReady(screen: string): boolean {
  return inputBox(screen) === "";
}

/** Control characters would act as keys, e.g. ESC [201~ ends the bracketed paste and types the rest. */
const typeable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

async function screen(exec: Exec): Promise<string | undefined> {
  const result = await exec(CAPTURE);
  return result.ok ? result.output : undefined;
}

/**
 * load-buffer + paste-buffer + Enter: multi-line text arrives intact (tmux experiment, 31.10). Pastes only into
 * an empty input box, so it never joins someone's typing or an earlier message left unsent, and presses Enter
 * only if the box is still there and the caller agrees: a dialog opening meanwhile would take the Enter.
 */
async function paste(exec: Exec, text: string, canSubmit: () => boolean): Promise<SendResult> {
  const before = await screen(exec);
  if (before === undefined) return { status: "refused", reason: "cannot read the session" };
  const box = inputBox(before);
  if (box === undefined) return { status: "refused", reason: "a dialog is on screen" };
  if (box !== "") return { status: "refused", reason: "the input box is not empty" };
  if (!canSubmit()) return { status: "refused", reason: "a dialog opened" };
  if (!(await exec(["tmux", "load-buffer", "-b", "household", "-"], typeable(text))).ok) {
    return { status: "refused", reason: "load-buffer failed" };
  }
  if (!(await exec(["tmux", "paste-buffer", "-p", "-d", "-b", "household", "-t", SESSION])).ok) {
    return { status: "stuck", reason: "paste-buffer failed" };
  }
  await Bun.sleep(300); // let the TUI take the paste before Enter
  const after = await screen(exec);
  if (after === undefined || inputBox(after) === undefined || !canSubmit()) {
    return { status: "stuck", reason: "the input box was gone after the paste (a dialog?), so no Enter" };
  }
  const enter = await exec(["tmux", "send-keys", "-t", SESSION, "Enter"]);
  return enter.ok ? { status: "sent" } : { status: "stuck", reason: "send-keys failed after the paste" };
}

/** What claude is told about its own tools, after Household's instructions: its person reads each Bash call's description as what it is busy with. */
export const BASH_DESCRIPTIONS = "- Give every Bash call a short `description` of what you are doing, in your human's language: they read it as what you are busy with.";

/** Claude Code's aliases for the latest model of each family (`claude --model`). */
const MODELS = ["opus", "sonnet", "haiku", "fable"] as const;

/** Anthropic aliases in pinned Claude Code 2.1.296; native model-config docs checked 2026-11-05.
 * All four current aliases support these levels; ultracode is a workflow switch, not an effort level.
 * https://code.claude.com/docs/en/model-config#adjust-effort-level */
function claudeModelOptions(model: string) {
  if (!(MODELS as readonly string[]).includes(model)) return { id: model, label: model };
  return { id: model, label: model, defaultReasoningEffort: model === "fable" ? "high" : "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Quick exchanges and small changes" },
      { reasoningEffort: "medium", description: "Day-to-day engineering work with a clear scope" },
      { reasoningEffort: "high", description: "Work where verification and edge cases matter" },
      { reasoningEffort: "xhigh", description: "Deeper reasoning at higher token spend" },
      { reasoningEffort: "max", description: "Deepest reasoning for hard problems" },
    ],
  };
}

/**
 * Claude Code's own knobs a pet may set, beyond model, effort and mode (`pets.<p>.settings`), each an environment
 * variable of 2.1.296.
 */
const SETTINGS = [
  {
    key: "claudeAiConnectors",
    label: "Claude.ai connectors",
    description: "Use this account’s Claude.ai connectors for this pet and its sideworkers. Scouts always run without them. Also allows other MCP servers configured in the agent’s environment.",
    checkbox: true,
    petOnly: true,
    options: [{ id: "true", label: "Enabled" }, { id: "false", label: "Disabled" }],
    defaultLabel: "disabled",
  },
  {
    key: "subagentModel",
    label: "Subagent model",
    description: "What claude's subagents (Agent tool, Explore, Plan…) run on.",
    options: MODELS.map((id) => ({ id, label: id })),
    defaultLabel: "the pet's own model",
  },
] as const;

/** `claude --permission-mode` choices (2.1.296 `--help`), as its own screens call them. */
const MODES = [
  { id: "auto", label: "Auto" },
  { id: "manual", label: "Manual" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
  { id: "bypassPermissions", label: "Bypass permissions" },
  { id: "dontAsk", label: "Don't ask" },
];

/** What the footer says in each mode that shows one (2.1.296); manual and don't ask show none. */
const FOOTERS: Record<string, string> = { auto: "auto mode on", acceptEdits: "accept edits on", plan: "plan mode on", bypassPermissions: "bypass permissions on" };

/**
 * The mode the footer shows is not `mode` (claude started in another: auto is not there for every model, say):
 * what to log; undefined when it is, or the screen cannot tell.
 */
export function modeMismatch(screen: string, mode: string | undefined): string | undefined {
  if (mode === undefined) return undefined;
  const shown = Object.entries(FOOTERS).find(([, footer]) => screen.includes(footer))?.[0];
  if (shown === mode || (shown === undefined && FOOTERS[mode] === undefined)) return undefined;
  return `claude runs in ${shown ?? "a mode without a footer (manual?)"}, not ${mode}`;
}

/** Interactive Claude Code in tmux session `main`, bypass mode, no first-run dialogs. */
export const claudeCodeTmux: AgentAdapter = {
  name: "claude-code-tmux",
  imageContext: import.meta.dir,
  instructionsFile: ".claude/CLAUDE.md",
  skillsDirectory: ".claude/skills",
  workspaceSkillsDirectory: ".claude/skills",
  home: HOME,
  env: ({ caCertPath, eventsUrl, mcpUrl, instructions, model, mode, reasoningEffort, settings, home, workspace, scout }) => ({
    ...(home === undefined ? {} : { HOME: home }),
    ...(workspace === undefined ? {} : { HOUSEHOLD_WORKSPACE: workspace }),
    // Household's timer is the only one on claude's permission dialogs (it puts them to the person, then refuses).
    CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: "1",
    CLAUDE_CODE_DISABLE_CRON: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: !scout && settings?.claudeAiConnectors === "true" ? "true" : "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // Fast mode is billed to credits whatever the plan, and nothing in a pet asks for it: no `/fast`, ever.
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    // Setup may use its full five-minute guest limit plus termination grace and transport time.
    MCP_TOOL_TIMEOUT: "330000",
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "330000",
    NODE_EXTRA_CA_CERTS: caCertPath,
    HOUSEHOLD_EVENTS_URL: eventsUrl, // read by ./household-hook
    HOUSEHOLD_MCP_URL: mcpUrl, // expanded by claude in ./mcp.json
    HOUSEHOLD_INSTRUCTIONS: `${instructions}\n${BASH_DESCRIPTIONS}`, // appended to the system prompt by ./entrypoint.sh
    HOUSEHOLD_MODEL: model, // claude --model, by ./entrypoint.sh
    ...(reasoningEffort === undefined ? {} : { CLAUDE_CODE_EFFORT_LEVEL: reasoningEffort }),
    ...(settings?.subagentModel === undefined ? {} : { CLAUDE_CODE_SUBAGENT_MODEL: settings.subagentModel }),
    // claude --permission-mode, by ./entrypoint.sh: on every launch (the seed's defaultMode only reaches new homes)
    ...(mode === undefined ? {} : { HOUSEHOLD_PERMISSION_MODE: mode }),
  }),
  models: MODELS,
  modelOptions: claudeModelOptions,
  acceptsReasoningEffort: (model, effort) => claudeModelOptions(model).supportedReasoningEfforts?.some(option => option.reasoningEffort === effort) ?? false,
  defaultModel: "opus",
  modes: { options: MODES, default: "bypassPermissions" },
  settings: SETTINGS,
  allowance: { target: ANTHROPIC, read: readAnthropicAllowance },
  providers: ["anthropic"],
  useKey,
  credentialHeaders: [{ target: ANTHROPIC, headers: ["authorization", "x-api-key"] }],
  async isReady(exec, mode) {
    const { ok, output } = await exec(CAPTURE);
    const ready = ok && isClaudeReady(output);
    const warning = ready ? modeMismatch(output, mode) : undefined;
    return { ready, output, ...(warning ? { warning } : {}) };
  },
  translate: translateHook,
  dialogs: { ask: askOf, answer: answerFor },
  async isIdle(exec) { return idleBox(await screen(exec)) === ""; },
  send: paste,
  interrupt,
  async dialogVisible(exec) {
    const shown = await screen(exec);
    return shown === undefined || inputBox(shown) === undefined;
  },
  attach: ["tmux", "attach-session", "-t", SESSION],
  terminalSnapshot: ["tmux", "capture-pane", "-p", "-t", "=main:0.0", "-S", "-200"],
};
