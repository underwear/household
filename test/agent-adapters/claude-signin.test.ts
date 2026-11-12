import { expect, test } from "bun:test";
import { claudeCodeTmux } from "../../src/agent-adapters/claude-code-tmux";
import { placedKeyUse } from "../../src/core/agent";
import {
  checkCode, credentialsFile, finishLogin, parseCredentials, parseSigninMarker, parseStatus, renew, SIGNIN_SCOPES, startLogin,
  type ClaudeCredentials, type VmExec,
} from "../../src/agent-adapters/claude-code-tmux/signin";

const credentials: ClaudeCredentials = {
  accessToken: "sk-ant-oat01-access", refreshToken: "sk-ant-ort01-refresh", expiresAt: 1_800_000_000_000,
  refreshTokenExpiresAt: 1_802_000_000_000, scopes: ["user:inference", "user:mcp_servers", "user:profile"], subscriptionType: "max",
};
const status = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com", orgId: "org-1", orgName: "Home", subscriptionType: "max" });
const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=abc";
const fast = { tries: 5, everyMs: 1 };

/** A VM that answers each command by its first words; every call is kept. */
function vm(answers: Record<string, () => { ok: boolean; output: string }>) {
  const calls: { command: string[]; stdin?: string }[] = [];
  const exec: VmExec = async (command, stdin) => {
    calls.push({ command, stdin });
    const words = command.join(" ");
    const match = Object.keys(answers).find((prefix) => words.startsWith(prefix) || words.includes(prefix));
    return match ? answers[match]!() : { ok: false, output: "" };
  };
  return { exec, calls };
}

test("a sign-in key is a reference: the bot gets a placeholder and the sign-in's scopes, the gateway the token on both Anthropic hosts", () => {
  expect(parseSigninMarker("claude-signin:org-1")).toBe("org-1");
  expect(parseSigninMarker("claude-signin:../x")).toBeUndefined();
  expect(parseSigninMarker("sk-ant-oat01-x")).toBeUndefined();
  const use = claudeCodeTmux.useKey("anthropic", "claude-signin:org-1");
  if ("problem" in use) throw new Error(use.problem);
  expect(use).toMatchObject({ kind: "sign-in", accountConnectors: true, env: { CLAUDE_CODE_OAUTH_SCOPES: SIGNIN_SCOPES } });
  expect(use.env.CLAUDE_CODE_OAUTH_TOKEN).not.toContain("org-1");
  expect(use.wire.map(({ target }) => target.host)).toEqual(["api.anthropic.com"]);
  // The connectors' proxy gets the token only for a bot that turned them on, never for a scout.
  expect(placedKeyUse(use, claudeCodeTmux, { claudeAiConnectors: "true" }, false).wire.map(({ target }) => target.host)).toEqual(["api.anthropic.com", "mcp-proxy.anthropic.com"]);
  expect(placedKeyUse(use, claudeCodeTmux, {}, false).wire.map(({ target }) => target.host)).toEqual(["api.anthropic.com"]);
  expect(placedKeyUse(use, claudeCodeTmux, { claudeAiConnectors: "true" }, true).wire.map(({ target }) => target.host)).toEqual(["api.anthropic.com"]);
  // A pasted token stays inference-only: no scopes claude could read connectors from.
  const token = claudeCodeTmux.useKey("anthropic", "sk-ant-oat01-x");
  if ("problem" in token) throw new Error(token.problem);
  expect(token.accountConnectors).toBeUndefined();
  expect(token.env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined();
});

test("Claude Code's credentials file is read back as written, and a bad one is refused without quoting it", () => {
  expect(parseCredentials(credentialsFile(credentials))).toEqual(credentials);
  for (const bad of ["{not json sk-ant-oat01-secret", JSON.stringify({ claudeAiOauth: { ...credentials, refreshToken: "nope" } }), "{}"]) {
    expect(() => parseCredentials(bad)).toThrow("sign in again");
    try { parseCredentials(bad); } catch (error) { expect((error as Error).message).not.toContain("secret"); }
  }
});

test("`claude auth status` names a claude.ai account; an API-key login or garbage is none", () => {
  expect(parseStatus(`noise\n${status}`)).toEqual({ email: "me@example.com", orgId: "org-1", orgName: "Home", subscriptionType: "max" });
  expect(parseStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key", orgId: "org-1" }))).toBeUndefined();
  expect(parseStatus("Not logged in")).toBeUndefined();
});

test("the code from Claude's page is taken as it is; anything a shell or tmux could read is refused", () => {
  expect(checkCode("  U0BCbDDQLf2Zet#YjBAqd0dArLUuf  ")).toBe("U0BCbDDQLf2Zet#YjBAqd0dArLUuf");
  for (const bad of ["", "short", "abc def ghijkl", "abcdefgh;rm -rf /", "abcdefgh$(x)"]) expect(() => checkCode(bad)).toThrow("not the code");
});

test("sign-in: the link Claude Code printed in its tmux, then the code typed in and what it saved read back", async () => {
  let typed = false;
  const { exec, calls } = vm({
    "tmux capture-pane": () => ({ ok: true, output: `Opening browser to sign in…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted >` }),
    "tmux send-keys": () => { typed = true; return { ok: true, output: "" }; },
    "cat": () => (typed ? { ok: true, output: credentialsFile(credentials) } : { ok: false, output: "" }),
    "claude auth status": () => ({ ok: true, output: status }),
  });
  expect(await startLogin(exec, fast)).toBe(LINK);
  const done = await finishLogin(exec, "Abcdefgh1234#Ijklmnop5678", fast);
  expect(done).toEqual({ credentials, account: { email: "me@example.com", orgId: "org-1", orgName: "Home", subscriptionType: "max" } });
  expect(calls.find(({ command }) => command.includes("-l"))?.command).toEqual(["tmux", "send-keys", "-t", "signin", "-l", "Abcdefgh1234#Ijklmnop5678"]);
});

test("sign-in: Claude's refusal of a code is said, and no link means no sign-in", async () => {
  const refused = vm({ "tmux send-keys": () => ({ ok: true, output: "" }), "tmux capture-pane": () => ({ ok: true, output: "Login failed: invalid_grant" }) });
  await expect(finishLogin(refused.exec, "Abcdefgh1234#Ijklmnop5678", fast)).rejects.toThrow("Claude did not take that code (Login failed: invalid_grant)");
  const silent = vm({ "tmux capture-pane": () => ({ ok: true, output: "Opening browser…" }) });
  await expect(startLogin(silent.exec, fast)).rejects.toThrow("printed no sign-in link");
});

test("renewal: Claude Code's own refresh login, the refresh token by stdin only, the new tokens saved before anything else, then whose", async () => {
  const renewed = { ...credentials, accessToken: "sk-ant-oat01-new", refreshToken: "sk-ant-ort01-new" };
  const { exec, calls } = vm({ "sh -c": () => ({ ok: true, output: "" }), "cat": () => ({ ok: true, output: credentialsFile(renewed) }), "claude auth status": () => ({ ok: true, output: status }) });
  const saved: ClaudeCredentials[] = [];
  expect(await renew(exec, credentials, async (fresh) => void saved.push(fresh))).toEqual(expect.objectContaining({ orgId: "org-1" }));
  expect(saved).toEqual([renewed]);
  // Claude not saying whose they are loses nothing: the tokens are saved already.
  const quiet = vm({ "sh -c": () => ({ ok: true, output: "" }), "cat": () => ({ ok: true, output: credentialsFile(renewed) }) });
  const kept: ClaudeCredentials[] = [];
  expect(await renew(quiet.exec, credentials, async (fresh) => void kept.push(fresh))).toBeUndefined();
  expect(kept).toEqual([renewed]);
  const run = calls[0]!;
  expect(run.stdin).toBe(`${credentials.refreshToken}\n${credentials.scopes.join(" ")}\n`);
  expect(run.command.join(" ")).toContain("CLAUDE_CODE_OAUTH_REFRESH_TOKEN=\"$token\"");
  expect(calls.some(({ command }) => command.join(" ").includes(credentials.refreshToken))).toBe(false);
  const refused = vm({ "sh -c": () => ({ ok: false, output: "" }) });
  await expect(renew(refused.exec, credentials, async () => {})).rejects.toThrow("sign in again");
});
