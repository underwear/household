import { codexModelOptions, acceptsCodexReasoningEffort } from "./models";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { codexPermissions } from "./modes";

type Packet = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type BridgeOptions = { command?: string[]; socket?: string; home?: string; env?: Record<string, string | undefined>; post?: (packet: Packet, signal?: AbortSignal) => Promise<any> };

/** Keep native error details private; only this precise local resume failure permits a new thread. */
class CodexRequestError extends Error {
  readonly missingRollout: boolean;
  constructor(error: { code: number; message: string }) {
    super("Codex rejected the request");
    this.missingRollout = error.code === -32600 && /^no rollout found for thread id [a-zA-Z0-9-]+$/.test(error.message);
  }
}

/** The credential-free bridge and all Codex tools run inside the pet container. */
export async function runBridge(options: BridgeOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? "/home/agent";
  const socket = options.socket ?? "/tmp/household-codex.sock";
  const model = env.HOUSEHOLD_MODEL ?? "gpt-6.1-terra";
  const reasoningEffort = env.HOUSEHOLD_REASONING_EFFORT;
  if (reasoningEffort !== undefined && !acceptsCodexReasoningEffort(model, reasoningEffort)) throw new Error("Unsupported Codex reasoning effort");
  const account = env.HOUSEHOLD_CODEX_ACCOUNT;
  const token = env.HOUSEHOLD_CODEX_TOKEN;
  const apiKey = env.HOUSEHOLD_CODEX_AUTH === "apiKey";
  if (!token || (!apiKey && !account)) throw new Error("OpenAI credential placeholder is required");
  const workspace = env.HOUSEHOLD_WORKSPACE ?? `${home}/work`, codexHome = `${home}/.codex`, threadFile = `${home}/.household-codex-thread`;
  if (!env.HOUSEHOLD_WORKSPACE) await mkdir(workspace, { recursive: true });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await rm(socket, { force: true });
  const permissions = codexPermissions(env.HOUSEHOLD_PERMISSION_MODE);
  const config = { ...(reasoningEffort === undefined ? {} : { config: { model_reasoning_effort: reasoningEffort } }), model, modelProvider: "openai", cwd: workspace, ...permissions,
    developerInstructions: env.HOUSEHOLD_INSTRUCTIONS ?? "",
  };
  const args = ["app-server", "--stdio", "-c", `forced_login_method="${apiKey ? "api" : "chatgpt"}"`, "-c", 'model_provider="openai"', "-c", `model=${JSON.stringify(model)}`,
    "-c", `approval_policy=${JSON.stringify(permissions.approvalPolicy)}`, "-c", `sandbox_mode=${JSON.stringify(permissions.sandbox)}`, "-c", `approvals_reviewer=${JSON.stringify(permissions.approvalsReviewer)}`,
    ...(reasoningEffort === undefined ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]),
    "-c", "features.guardian_approval=true",
    "-c", 'cli_auth_credentials_store="ephemeral"', "-c", "check_for_update_on_startup=false", "-c", "features.default_mode_request_user_input=true",
    "-c", "features.in_app_local_automation=false",
    "-c", "features.memories=false",
    "-c", "memories.generate_memories=false",
    "-c", "memories.use_memories=false",
    "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.remote_plugin=false",
    "-c", "features.browser_use=false", "-c", "features.browser_use_external=false", "-c", "features.computer_use=false", "-c", "features.in_app_browser=false",
    "-c", `mcp_servers.household.url=${JSON.stringify(env.HOUSEHOLD_MCP_URL)}`, "-c", "mcp_servers.household.required=true",
    // Household's tools enforce routing and owner approvals themselves. In manual mode, a second MCP
    // consent would otherwise block even reply/react and prevent the person hearing the outcome.
    "-c", 'mcp_servers.household.default_tools_approval_mode="approve"',
    // Guest setup has a five-minute limit plus termination grace; let its result return.
    "-c", "mcp_servers.household.tool_timeout_sec=330",
    ...(env.HOUSEHOLD_PET_TOKEN ? ["-c", `mcp_servers.household.http_headers={\"x-household-token\"=${JSON.stringify(env.HOUSEHOLD_PET_TOKEN)}}`] : []),
  ];
  // In particular, no API keys, access tokens, provider/base overrides or host config.
  const childEnv = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "CODEX_CA_CERTIFICATE", "NODE_EXTRA_CA_CERTS"]
    .flatMap(k => env[k] ? [[k, env[k]!]] : []));
  childEnv.HOME = home; childEnv.CODEX_HOME = codexHome;
  const command = options.command ?? ["codex"];
  const child = spawn(command[0]!, [...command.slice(1), ...args], { cwd: workspace, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  // Codex diagnostics can contain account metadata; operational failures have a generic message below.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let markClosed: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  let ready = false, stopped = false, failure: string | undefined, threadId = "", activeTurn: string | undefined, lastCompleted = "", lastMessage = "", seq = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: Timer }>();
  const dialogs = new Map<string | number, AbortController>();
  const cancelledTurns = new Set<string>();
  const turnCommands = new Map<string, Set<string>>();
  let stoppingTurn: string | undefined, stopWork: Promise<"stopped" | "failed"> | undefined;
  let stoppedCompletion: Packet | undefined;
  let eventQueue = Promise.resolve();
  const post = options.post ?? (async (packet: Packet, signal?: AbortSignal) => {
    const response = await fetch(env.HOUSEHOLD_EVENTS_URL!, { method: "POST", headers: { "content-type": "application/json", ...(env.HOUSEHOLD_PET_TOKEN ? { "x-household-token": env.HOUSEHOLD_PET_TOKEN } : {}) }, body: JSON.stringify(packet), signal });
    if (!response.ok) throw new Error("Household event delivery failed");
    return response.json();
  });
  const emit = (packet: Packet) => { eventQueue = eventQueue.then(() => cancelledTurns.has(packet.params?.turnId) ? undefined : post(packet)).then(() => {}, () => {}); return eventQueue; };
  const send = (packet: Packet) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(packet) + "\n"); };
  const rpc = (method: string, params: any, timeoutMs = 60_000): Promise<any> => new Promise((resolve, reject) => {
    if (stopped || failure) return reject(new Error("Codex unavailable"));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex request timed out")); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  const closeDialogs = () => { for (const controller of dialogs.values()) controller.abort(); dialogs.clear(); };
  async function serverRequest(packet: Packet) {
    if (!apiKey && packet.method === "account/chatgptAuthTokens/refresh") {
      // Refreshing the real credential is exclusively the trusted host broker's job.
      send({ id: packet.id, result: { accessToken: token, chatgptAccountId: account, chatgptPlanType: null } }); return;
    }
    const permissionsRequest = packet.method === "item/permissions/requestApproval";
    const isApproval = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(packet.method ?? "");
    if (cancelledTurns.has(packet.params?.turnId)) {
      send({ id: packet.id, result: permissionsRequest ? { permissions: {}, scope: "turn" } : isApproval ? { decision: "cancel" } : { answers: {} } }); return;
    }
    if (!isApproval && !["item/tool/requestUserInput", "tool/requestUserInput"].includes(packet.method ?? "")) {
      send({ id: packet.id, error: { code: -32601, message: "Unsupported Household dialog" } }); return;
    }
    const abort = new AbortController(); dialogs.set(packet.id!, abort);
    try {
      await eventQueue;
      const answer = await post(packet, abort.signal);
      if (dialogs.get(packet.id!) !== abort) return;
      // A malformed/unsupported question never leaves Codex waiting indefinitely.
      const result = permissionsRequest ? (answer?.permissions && answer.scope === "turn" ? answer : { permissions: {}, scope: "turn" }) : isApproval ? (answer && ["accept", "decline", "cancel"].includes(answer.decision) ? answer : { decision: "decline" }) : (answer?.answers ? answer : { answers: {} });
      send({ id: packet.id, result });
    } catch {
      send({ id: packet.id, result: permissionsRequest ? { permissions: {}, scope: "turn" } : isApproval ? { decision: "cancel" } : { answers: {} } });
    } finally { if (dialogs.get(packet.id!) === abort) dialogs.delete(packet.id!); }
  }
  lines.on("line", line => {
    let packet: Packet; try { packet = JSON.parse(line); } catch { return; }
    if (packet.id !== undefined && !packet.method) {
      const request = pending.get(Number(packet.id));
      if (request) { clearTimeout(request.timer); pending.delete(Number(packet.id)); packet.error ? request.reject(new CodexRequestError(packet.error)) : request.resolve(packet.result); }
      return;
    }
    if (packet.id !== undefined && packet.method) { void serverRequest(packet); return; }
    if (packet.params?.threadId && threadId && packet.params.threadId !== threadId) return;
    const turn = packet.method === "turn/completed" || packet.method === "turn/started" ? packet.params.turn.id : packet.params?.turnId;
    if (["item/started", "item/completed"].includes(packet.method ?? "") && packet.params.item.type === "commandExecution" && typeof turn === "string") {
      let commands = turnCommands.get(turn); if (!commands) turnCommands.set(turn, commands = new Set());
      commands.add(packet.params.item.id);
      if (packet.params.item.processId) commands.add(packet.params.item.processId);
    }
    if (cancelledTurns.has(turn)) {
      if (packet.method === "turn/completed" && turn === stoppingTurn) {
        if (activeTurn === turn) activeTurn = undefined;
        stoppedCompletion = packet; packet.params.lastMessage = "";
      }
      return;
    }
    if (packet.method === "turn/started") { activeTurn = turn; lastMessage = ""; }
    if (packet.method === "item/completed" && packet.params.item.type === "agentMessage" && turn === activeTurn) lastMessage = packet.params.item.text;
    if (packet.method === "turn/completed") {
      if (activeTurn && activeTurn !== turn) return;
      lastCompleted = packet.params.turn.id; activeTurn = undefined; closeDialogs(); packet.params.lastMessage = lastMessage;
      turnCommands.delete(turn);
    }
    if (["thread/compacted", "item/started", "item/completed", "turn/completed", "item/autoApprovalReview/started", "item/autoApprovalReview/completed"].includes(packet.method ?? "")) void emit(packet);
  });
  const failed = () => {
    markClosed();
    if (stopped) return;
    failure = "Codex process disconnected"; ready = false; closeDialogs();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(failure)); } pending.clear();
    void emit({ method: "household/failed", params: {} });
  };
  child.stdin.on("error", failed);
  child.on("error", failed); child.on("exit", failed);
  async function interruptTurn(turnId: string): Promise<"stopped" | "failed"> {
    const deadline = Date.now() + 4000;
    const call = (method: string, params: any) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new Error("Stop verification timed out"));
      return rpc(method, params, Math.min(remaining, 1000));
    };
    try {
      if (activeTurn === turnId) await call("turn/interrupt", { threadId, turnId });
      // Interrupting generation does not terminate unified-exec sessions. Stop only this turn's terminals,
      // identified by the item/process IDs Codex emitted; unrelated earlier background work is preserved.
      let empty = 0;
      while (Date.now() < deadline) {
        const listed = [];
        let cursor: string | null = null;
        do {
          const page = await call("thread/backgroundTerminals/list", { threadId, limit: 100, cursor });
          if (!Array.isArray(page.data)) throw new Error("Invalid terminal inventory");
          listed.push(...page.data); cursor = page.nextCursor ?? null;
        } while (cursor);
        const commands = turnCommands.get(turnId) ?? new Set();
        const matching = listed.filter(item => commands.has(item.itemId) || commands.has(item.processId));
        for (const item of matching) await call("thread/backgroundTerminals/terminate", { threadId, processId: item.processId });
        if (!matching.length && activeTurn !== turnId) {
          if (++empty >= 2) {
            lastCompleted = turnId; stoppingTurn = undefined; turnCommands.delete(turnId);
            if (stoppedCompletion) { const completed = stoppedCompletion; stoppedCompletion = undefined; void emit(completed); }
            return failure ? "failed" : "stopped";
          }
        } else empty = 0;
        await Bun.sleep(40);
      }
    } catch { /* Remain blocked for input; another Stop can retry verification. */ }
    return "failed";
  }
  async function listModels() {
    const rows = [];
    const seen = new Set<string>();
    const deadline = Date.now() + 3500;
    let cursor: string | null = null;
    do {
      if (Date.now() >= deadline) throw new Error("Codex model discovery timed out");
      const page = await rpc("model/list", { includeHidden: false, limit: 100, cursor }, deadline - Date.now());
      if (!Array.isArray(page.data) || rows.length + page.data.length > 1000) throw new Error("Invalid model catalog");
      rows.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor !== null && (typeof cursor !== "string" || seen.has(cursor))) throw new Error("Invalid model cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return codexModelOptions(rows);
  }
  const server = Bun.serve({ unix: socket, ...({ idleTimeout: 0 } as object), async fetch(request) {
    const action = new URL(request.url).pathname;
    if (action === "/status") return Response.json({ ready, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), dialog: dialogs.size > 0, busy: !!activeTurn || !!stoppingTurn, ...(failure ? { failure } : {}) });
    if (!ready || failure) return Response.json({ sent: false }, { status: 503 });
    if (action === "/models") {
      try {
        return Response.json({ models: await listModels(), authType: apiKey ? "apiKey" : "chatgpt", accountId: account ?? null });
      } catch { return Response.json({ error: "Codex model discovery is unavailable" }, { status: 503 }); }
    }
    if (action === "/send") {
      if (dialogs.size || stoppingTurn) return Response.json({ sent: false });
      const body = await request.json().catch(() => undefined) as { text?: unknown } | undefined;
      if (typeof body?.text !== "string" || !body.text.trim()) return Response.json({ sent: false });
      try {
        const result = await rpc("turn/start", { threadId, model, ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }), input: [{ type: "text", text: body.text, text_elements: [] }] });
        if (!cancelledTurns.has(result.turn?.id)) activeTurn = result.turn?.status === "completed" || result.turn?.id === lastCompleted ? undefined : result.turn?.id;
        return Response.json({ sent: true });
      } catch { return Response.json({ sent: false }, { status: 502 }); }
    }
    if (action === "/interrupt") {
      const turnId = stoppingTurn ?? activeTurn;
      if (!turnId) return Response.json({ status: "idle" });
      stoppingTurn = turnId; cancelledTurns.add(turnId);
      closeDialogs();
      if (!stopWork) stopWork = interruptTurn(turnId).finally(() => { stopWork = undefined; });
      return Response.json({ status: await stopWork });
    }
    return new Response("not found", { status: 404 });
  } });
  const stop = async () => {
    if (stopped) return;
    stopped = true; ready = false; closeDialogs(); await server.stop(true);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Bridge stopped")); } pending.clear();
    child.stdin.end(); child.kill("SIGTERM"); lines.close();
    await Promise.race([new Promise(resolve => child.exitCode !== null || child.signalCode !== null || !child.pid ? resolve(undefined) : child.once("close", resolve)), Bun.sleep(1000)]);
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  try {
    await rpc("initialize", { clientInfo: { name: "household", title: "Household", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    await rpc("account/login/start", apiKey ? { type: "apiKey", apiKey: token } : { type: "chatgptAuthTokens", accessToken: token, chatgptAccountId: account });
    const auth = await rpc("account/read", { refreshToken: false });
    if (auth.account?.type !== (apiKey ? "apiKey" : "chatgpt")) throw new Error("Unexpected authentication mode");
    if (reasoningEffort !== undefined) {
      const selected = (await listModels()).find(option => option.id === model);
      if (selected?.supportedReasoningEfforts && !selected.supportedReasoningEfforts.some(option => option.reasoningEffort === reasoningEffort)) throw new Error("Unsupported Codex reasoning effort for selected model");
    }
    let previous = ""; try { previous = (await readFile(threadFile, "utf8")).trim(); } catch {}
    let result;
    if (previous) {
      try { result = await rpc("thread/resume", { ...config, threadId: previous, excludeTurns: true }); }
      catch (error) {
        // Codex persists a new thread only after its first turn. Restarting before that leaves a valid
        // pointer without a rollout. Recover only this case; auth/corruption/other failures must not erase history.
        if (!(error instanceof CodexRequestError) || !error.missingRollout) throw error;
        previous = "";
      }
    }
    if (!previous) result = await rpc("thread/start", config);
    if (result.model !== model || result.thread.modelProvider !== "openai") throw new Error("Unexpected model/provider");
    threadId = result.thread.id;
    await writeFile(`${threadFile}.tmp`, threadId + "\n", { mode: 0o600 }); await rename(`${threadFile}.tmp`, threadFile);
    await emit({ method: "household/sessionStarted", params: { model, continues: !!previous } }); ready = true;
  } catch { failure = "Codex startup failed (check authentication, gateway and MCP availability)"; await stop(); }
  return { stop, socket, closed, get ready() { return ready; } };
}

if (import.meta.main) {
  const bridge = await runBridge();
  if (!bridge.ready) { console.error("Codex startup failed; the bot stopped"); process.exit(1); }
  let shuttingDown = false;
  void bridge.closed.then(async () => { if (!shuttingDown) { await bridge.stop(); process.exit(1); } });
  const shutdown = () => { shuttingDown = true; void bridge.stop().then(() => process.exit(0)); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
