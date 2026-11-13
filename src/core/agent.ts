import type { AgentEvent } from "./agent-events";
import type { Allowance } from "./allowance";
import type { DialogAnswer, DialogQuestion } from "./dialog";
import type { AgentKey, Provider } from "./keys";
import type { Endpoint } from "./network-policy";

/** Runs a command inside the pet's container. A command that hangs counts as failed (`ok: false`). */
export type Exec = (command: string[], stdin?: string) => Promise<{ ok: boolean; output: string }>;

/** A public model picker entry, with the exact id passed back to the agent. */
export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort?: string;
}

/**
 * A setting of the agent's own, beyond model, effort and permission mode (`pets.<p>.settings.<key>`): a choice
 * among fixed options, which the adapter turns into the pet's environment. The web draws a field from this, the
 * config check validates against it; neither knows what the setting does.
 */
export interface AgentSetting {
  /** The config's key for it: a camelCase identifier (`subagentModel`). */
  key: string;
  /** Render a boolean choice as a checkbox (string values true/false in config). */
  checkbox?: boolean;
  /** Only pets configure this; sideworkers inherit it and scouts cannot use it. */
  petOnly?: boolean;
  /** Works only on a key whose account brings its connectors (`KeyUse.accountConnectors`); otherwise it does nothing. */
  needsAccountConnectors?: boolean;
  label: string;
  /** What choosing it does, in a line. */
  description?: string;
  options: readonly { id: string; label: string; description?: string }[];
  /** What the agent does when the config sets none («the pet's own model»): the Default option's words. */
  defaultLabel: string;
}

/**
 * How the agent's provider tells what is left of a subscription: on answers from `target`, the adapter reads the
 * allowance from the response headers (undefined on an answer that carries none: an API key's, an error's).
 */
export interface AllowanceReader {
  target: Endpoint;
  read(headers: Headers): Allowance | undefined;
}

/**
 * The contract for one kind of agent: what Household needs to build, start, watch and talk to a pet.
 * It is not IO-free domain logic — it names an image dir and talks to the container through `Exec` — but it
 * knows nothing of Docker or the daemon. Core owns the shape; each adapter (src/agent-adapters/<name>/) fills it in,
 * so a new agent needs no change here.
 */
export interface AgentAdapter {
  readonly name: string;
  /** Docker build context with a Dockerfile. The image's entrypoint is the agent's main process. */
  readonly imageContext: string;
  /** The agent user's home; Household keeps it on a per-pet volume so memory survives restarts. */
  readonly home: string;
  /** User skill discovery path relative to home; connected to the house directory. */
  readonly skillsDirectory?: string;
  /** Skill discovery path relative to the harness working directory, edited in the pet Skills tab. */
  readonly workspaceSkillsDirectory?: string;
  /** Native user-scope instructions, relative to the mounted home. */
  readonly instructionsFile?: string;
  /** Native files that would hide the main instruction document. */
  readonly instructionOverrides?: readonly string[];
  /** Agent-specific environment: CA trust, Household's URLs and instructions, the model (the key's placeholder is `useKey`'s). */
  env(context: PetContext): Record<string, string>;
  /** Picker seeds (also the strict allowed ids when acceptsModel is absent), and the default model. */
  readonly models: readonly string[];
  readonly defaultModel: string;
  /** Optional native picker. The trusted key scopes discovery; its secret must never be sent to the pet. */
  listModels?(exec: Exec, key: AgentKey): Promise<AgentModel[]>;
  /** Explicit offline model ids accepted beyond picker seeds; availability is still verified by the agent. */
  acceptsModel?(id: string): boolean;
  /** Static capabilities when native discovery is unavailable. */
  modelOptions?(model: string): AgentModel;
  /** Validates an explicit effort for this model; omission keeps the harness default. */
  acceptsReasoningEffort?(model: string, effort: string): boolean;
  /**
   * The permission modes a pet of this agent may run in (`pets.<p>.mode`: how much it may do without asking), as
   * the agent names them (`id`) and people call them (`label`), and the one it runs in when the config names
   * none. Absent: the agent has no modes.
   */
  readonly modes?: { readonly options: readonly { id: string; label: string; description?: string }[]; readonly default: string; readonly aliases?: Readonly<Record<string, string>> };
  /** Its own settings (`pets.<p>.settings`); absent: it has none. */
  readonly settings?: readonly AgentSetting[];
  /** How its provider reports a subscription's allowance; absent: it cannot be metered (nothing is refused). */
  readonly allowance?: AllowanceReader;
  /** The providers whose keys it runs on (a pet of it runs on one key of one of them). */
  readonly providers: readonly Provider[];
  /**
   * How it runs on a key of one of its providers, by the key's value: what kind of key that is, the placeholder
   * the pet holds instead, and where the gateway puts the real value. A value it cannot tell says why (never
   * repeating the value).
   */
  useKey(provider: Provider, value: string): KeyUse | { problem: string };
  /**
   * For each host its keys go to, every header that carries a credential there (`authorization`, `x-api-key`):
   * the gateway removes them all and sets just the pet's key's.
   */
  readonly credentialHeaders: readonly { target: Endpoint; headers: readonly string[] }[];
  /**
   * Whether the agent waits for input; `output` is what it looked at, for the log. `mode`: the permission mode
   * it was started in; `warning` when it can see it runs in another (one its model does not have, say).
   */
  isReady(exec: Exec, mode?: string): Promise<{ ready: boolean; output?: string; warning?: string }>;
  /** True only when the session is idle and safe for a scheduled prompt; unknown means false. */
  isIdle?(exec: Exec): Promise<boolean>;
  /** Turns one payload the agent posted to `PetContext.eventsUrl` into events (none if irrelevant). */
  translate(payload: unknown): AgentEvent[];
  /** Dialogs Household can answer for the person; without them, dialogs stay in the agent's session. */
  readonly dialogs?: {
    /** The dialog in a payload that waits for its answer (the agent holds the request open); undefined otherwise. */
    ask(payload: unknown): DialogQuestion | undefined;
    /** The answer to the agent for a payload `ask` read a dialog from. */
    answer(payload: unknown, answer: DialogAnswer): unknown;
  };
  /**
   * Types `text` into the agent as a message from its person. Refuses when it can see that input would land
   * somewhere else, e.g. in an open dialog. `canSubmit` is asked again right before the text is submitted, so
   * the caller can stop it when it learned of a dialog in the meantime.
   */
  send(exec: Exec, text: string, canSubmit: () => boolean): Promise<SendResult>;
  /**
   * Stops what the agent is doing (its turn), as a person would in its session, once, and sees that it did:
   * `stopped` (it waits for input; `leftover`: text it left in its input), `idle` (it was doing nothing: nothing
   * was pressed), `failed` (it could not tell it stopped). Absent: the agent cannot be stopped from outside.
   */
  interrupt?(exec: Exec): Promise<{ status: "stopped" | "idle" | "failed"; leftover?: string }>;
  /** Resume pointer filename in home; detached while the VM is stopped on explicit restart. */
  readonly sessionFile?: string;
  /** Whether something other than the agent's input (a dialog) is on screen; true when it cannot tell. */
  dialogVisible(exec: Exec): Promise<boolean>;
  /** Interactive command (with a TTY) that puts a person into the agent's session, if it has one. */
  readonly attach?: string[];
  /** Fixed read-only screen capture command; no caller-supplied arguments or terminal input. */
  readonly terminalSnapshot?: readonly string[];
}

/** How an agent runs on one key (none of it holds the value). */
export interface KeyUse {
  /** What kind of key it is, as people call it: `subscription`, `API key`. */
  kind: string;
  /** The pet's environment for it: a placeholder in the shape of such a key, never the value. */
  env: Record<string, string>;
  /** Where the gateway puts the value: on requests to `target`, header `header` becomes `prefix` + the value. */
  wire: { target: Endpoint; header: string; prefix: string }[];
  /** The account's own connectors (claude.ai's, ChatGPT's apps) can reach the bot on this key: a sign-in's. */
  accountConnectors?: boolean;
  /**
   * Where the value goes too, only for a bot that turned the account's connectors on (a setting with
   * `needsAccountConnectors`), never for a scout: the connectors' own hosts, unreachable otherwise.
   */
  connectorWire?: { target: Endpoint; header: string; prefix: string }[];
}

/**
 * The key's use as the gateway applies it to one pet: its connector hosts (`KeyUse.connectorWire`) join its wire only
 * when the pet turned the account's connectors on and is no scout.
 */
export function placedKeyUse(use: KeyUse, agent: Pick<AgentAdapter, "settings">, settings: Record<string, string> | undefined, scout: boolean): KeyUse {
  const { connectorWire, ...rest } = use;
  const on = !scout && (agent.settings ?? []).some((setting) => setting.needsAccountConnectors && settings?.[setting.key] === "true");
  return on && connectorWire?.length ? { ...rest, wire: [...rest.wire, ...connectorWire] } : rest;
}

export type SendResult =
  | { status: "sent" }
  /** Nothing was typed: the caller may try again later. */
  | { status: "refused"; reason: string }
  /** The text may sit in the agent's input, not submitted: trying again could type it twice. */
  | { status: "stuck"; reason: string };

export interface PetContext {
  /** Scouts must not inherit account integrations. */
  scout?: boolean;
  /** Override the native home and initial cwd for an isolated sideworker session. */
  home?: string;
  workspace?: string;
  /** Exact configured guest shares, never their parent or host paths. The adapter skips absent folders at launch. */
  additionalDirectories?: readonly string[];
  /** Path inside the container of the CA certificate the gateway's interception certificates chain to. */
  caCertPath: string;
  /** Where the agent posts its events (JSON, POST). The answer body goes back to the agent. */
  eventsUrl: string;
  /** Household's MCP server for the pet (streamable HTTP): the `reply` tool. */
  mcpUrl: string;
  /** Household's standing instructions, for the agent's system prompt (or its equivalent). */
  instructions: string;
  /** A model accepted by the adapter: the config's, or its default. */
  model: string;
  /** Explicit model reasoning effort; absent leaves the native harness default. */
  reasoningEffort?: string;
  /** One of the agent's `modes`, the same way; undefined for an agent without modes. */
  mode?: string;
  /** The agent's own settings the config sets (each one of its `settings`, a valid option); absent when none. */
  settings?: Readonly<Record<string, string>>;
}

/** The harness of a bot whose config names none (the claude-code-tmux adapter's name). */
export const DEFAULT_HARNESS = "claude-code-tmux";
