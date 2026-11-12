import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSignins, SigninState, SigninStore, signinReminder, startClaudeRefresh, type SigninVm } from "../../src/app/claude-signins";
import { credentialsFile, type ClaudeCredentials } from "../../src/agent-adapters/claude-code-tmux/signin";
import { petKeys } from "../../src/app/keys";
import { claudeCodeTmux } from "../../src/agent-adapters/claude-code-tmux";
import { decide } from "../../src/core/egress";
import { tempDir } from "../helpers";

const HOUR = 3_600_000;
const account = { email: "me@example.com", orgId: "org-1", orgName: "Home", subscriptionType: "max" };
const status = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", ...account });
const credentials = (access: string, expiresAt: number, endsAt = Date.now() + 20 * 24 * HOUR): ClaudeCredentials =>
  ({ accessToken: `sk-ant-oat01-${access}`, refreshToken: `sk-ant-ort01-${access}`, expiresAt, refreshTokenExpiresAt: endsAt, scopes: ["user:inference", "user:mcp_servers"] });

/** A sign-in VM that renews to `next` (or, with `org`, for another account); its uses are counted. */
function renewingVm(next: ClaudeCredentials, org = "org-1") {
  const used = { launched: 0, closed: 0 };
  const launch = async (): Promise<SigninVm> => {
    used.launched++;
    return {
      exec: async (command) => {
        const words = command.join(" ");
        if (words.startsWith("sh -c")) return { ok: true, output: "" };
        if (command[0] === "cat") return { ok: true, output: credentialsFile(next) };
        if (words.includes("claude auth status")) return { ok: true, output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", ...account, orgId: org }) };
        return { ok: false, output: "" };
      },
      close: async () => { used.closed++; },
    };
  };
  return { launch, used };
}

test("a sign-in is kept private (0700 folder, 0600 files), read back whole, and forgotten with its key", async () => {
  const root = join(tempDir(), "claude-auth");
  const store = new SigninStore(root);
  const saved = credentials("a", Date.now() + 8 * HOUR);
  await store.save("claude", saved, account, 123);
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "claude", "credentials.json")).mode & 0o777).toBe(0o600);
  expect(await store.credentials("claude")).toEqual(saved);
  expect(store.infoNow("claude")).toEqual({ ...account, renewedAt: 123, expiresAt: saved.expiresAt, endsAt: saved.refreshTokenExpiresAt });
  expect(() => store.folder("../x")).toThrow("invalid key name");
  await store.remove("claude");
  expect(store.infoNow("claude")).toBeUndefined();
  await expect(store.credentials("claude")).rejects.toThrow("sign in again");
});

test("a sign-in: its VM gives the link, the code saves the key as a reference to the account, and the VM goes either way", async () => {
  const store = new SigninStore(join(tempDir(), "claude-auth"));
  let typed = false;
  const closed: string[] = [];
  const saved: { name: string; value: string }[] = [];
  const signins = new ClaudeSignins({
    store,
    state: new SigninState(),
    launch: async () => ({
      exec: async (command) => {
        const words = command.join(" ");
        if (words.startsWith("tmux capture-pane")) return { ok: true, output: "visit: https://claude.com/cai/oauth/authorize?code=true&state=x" };
        if (words.startsWith("tmux send-keys")) { typed = true; return { ok: true, output: "" }; }
        if (command[0] === "cat") return typed ? { ok: true, output: credentialsFile(credentials("a", Date.now() + 8 * HOUR)) } : { ok: false, output: "" };
        if (words.includes("claude auth status")) return { ok: true, output: status };
        return { ok: false, output: "" };
      },
      close: async () => { closed.push("vm"); },
    }),
    saveKey: async (name, value) => { saved.push({ name, value }); },
  });
  const started = await signins.start("claude");
  expect(started.url).toStartWith("https://claude.com/cai/oauth/authorize");
  expect(await signins.finish(started.id, "Abcdefgh1234#Ijklmnop5678")).toEqual(account);
  expect(saved).toEqual([{ name: "claude", value: "claude-signin:org-1" }]);
  expect(store.infoNow("claude")?.email).toBe("me@example.com");
  expect(closed).toEqual(["vm"]);
  await expect(signins.finish(started.id, "Abcdefgh1234#Ijklmnop5678")).rejects.toThrow("start it again");
});

test("keeping sign-ins: the first look publishes what there is without a VM; a due token is renewed by a timer, the new one published", async () => {
  const store = new SigninStore(join(tempDir(), "claude-auth"));
  await store.save("claude", credentials("old", Date.now() + 30 * 60_000), account);
  const vm = renewingVm(credentials("new", Date.now() + 8 * HOUR));
  const published: (string | undefined)[] = [];
  const keeper = await startClaudeRefresh({ keys: [{ name: "claude", value: "claude-signin:org-1" }], onToken: (_, token) => void published.push(token) }, { store, state: new SigninState(), launch: vm.launch });
  // Inside a network reload a VM (which needs one of its own) would wait for it forever: none on the first look.
  expect(vm.used.launched).toBe(0);
  expect(published).toEqual(["sk-ant-oat01-old"]);
  await Bun.sleep(1300);
  expect(vm.used).toEqual({ launched: 1, closed: 1 });
  expect(published).toEqual(["sk-ant-oat01-old", "sk-ant-oat01-new"]);
  expect((await store.credentials("claude")).refreshToken).toBe("sk-ant-ort01-new");
  keeper.stop();
});

test("a renewal that comes back for another account is kept but never published, until signed in again", async () => {
  const store = new SigninStore(join(tempDir(), "claude-auth"));
  await store.save("claude", credentials("old", Date.now() + 30 * 60_000), account);
  const vm = renewingVm(credentials("theirs", Date.now() + 8 * HOUR), "org-2");
  const published: (string | undefined)[] = [];
  const logged: string[] = [];
  const keeper = await startClaudeRefresh({ keys: [{ name: "claude", value: "claude-signin:org-1" }], onToken: (_, token) => void published.push(token), log: (text) => logged.push(text) }, { store, state: new SigninState(), launch: vm.launch });
  await Bun.sleep(1300);
  keeper.stop();
  // The rotated tokens are kept (the old ones are dead), never published.
  expect(published).toEqual(["sk-ant-oat01-old", undefined]);
  expect((await store.credentials("claude")).refreshToken).toBe("sk-ant-ort01-theirs");
  expect(logged[0]).toContain("has no live token");
});

test("a sign-in without a token yet still places its bots, with an empty secret (Claude answers 401 until it has one)", () => {
  const use = claudeCodeTmux.useKey("anthropic", "claude-signin:org-1");
  if ("problem" in use) throw new Error(use.problem);
  const placed = [{ house: "work", pet: "sibling", agent: claudeCodeTmux, key: "claude", keyUse: use, model: "opus" }];
  const keys = [{ name: "claude", provider: "anthropic" as const, value: "claude-signin:org-1" }];
  expect(petKeys(placed, keys).secrets).toEqual({ "key.claude": "" });
  expect(petKeys(placed, keys, new Map([["claude", "sk-ant-oat01-live"]])).secrets).toEqual({ "key.claude": "sk-ant-oat01-live" });
});

test("Household's own sign-in VM is a subject of its own: its narrow allowlist, never a workspace's", () => {
  const rules = [
    { subject: { kind: "house" as const, name: "household-auth" }, policy: { kind: "allowlist" as const, allow: [{ host: "example.com", port: 443 }] }, intercept: [] },
    { subject: { kind: "household" as const, name: "household-auth", pet: "u-1" }, policy: { kind: "allowlist" as const, allow: [{ host: "platform.claude.com", port: 443 }] }, intercept: [] },
  ];
  expect(decide(rules, { house: "household-auth", pet: "u-1" }, { host: "platform.claude.com", port: 443 })).toMatchObject({ verdict: "allow", intercept: false });
  expect(decide(rules, { house: "household-auth", pet: "u-1" }, { host: "example.com", port: 443 })).toMatchObject({ verdict: "deny" });
});

test("reminders: none until the last five days, then one a day, and one once the sign-in has ended", () => {
  const now = Date.UTC(2026, 11, 1, 12);
  const info = (days: number) => ({ email: "me@example.com", endsAt: now + days * 24 * HOUR });
  expect(signinReminder("claude", info(10), now, undefined)).toBeUndefined();
  const soon = signinReminder("claude", info(3), now, undefined)!;
  expect(soon.day).toBe("2026-12-01");
  expect(soon.text).toContain("ends in 3 days");
  expect(soon.text).toContain("house key claude claude");
  expect(signinReminder("claude", info(3), now, "2026-12-01")).toBeUndefined(); // said today already
  expect(signinReminder("claude", info(0.5), now, "2026-11-30")!.text).toContain("ends tomorrow");
  expect(signinReminder("claude", info(-1), now, "2026-11-30")!.text).toContain("has ended");
  expect(signinReminder("claude", { email: "me@example.com" }, now, undefined)).toBeUndefined();
});

test("a failing renewal is tried again in 5 minutes whatever reloads come (each makes a keeper of its own); an ended sign-in boots no VM", async () => {
  const store = new SigninStore(join(tempDir(), "claude-auth"));
  const state = new SigninState();
  await store.save("claude", credentials("old", Date.now() + 30 * 60_000), account);
  let launched = 0;
  const failing = async (): Promise<SigninVm> => { launched++; return { exec: async () => ({ ok: false, output: "" }), close: async () => {} }; };
  const keys = [{ name: "claude", value: "claude-signin:org-1" }];
  const first = await startClaudeRefresh({ keys, onToken: () => {} }, { store, state, launch: failing });
  await Bun.sleep(1300);
  expect(launched).toBe(1);
  first.stop();
  // Reloads now and then: each new keeper waits for the retry time instead of renewing at once.
  for (let i = 0; i < 3; i++) (await startClaudeRefresh({ keys, onToken: () => {} }, { store, state, launch: failing })).stop();
  const again = await startClaudeRefresh({ keys, onToken: () => {} }, { store, state, launch: failing });
  await Bun.sleep(1300);
  again.stop();
  expect(launched).toBe(1);
  // Ended: its refresh token is past its end; nothing to renew with.
  const ended = new SigninStore(join(tempDir(), "claude-auth"));
  await ended.save("claude", credentials("old", Date.now() + 30 * 60_000, Date.now() - 1000), account);
  let booted = 0;
  const published: (string | undefined)[] = [];
  const keeper = await startClaudeRefresh({ keys, onToken: (_, token) => void published.push(token) }, { store: ended, state: new SigninState(), launch: async () => { booted++; return failing(); } });
  await Bun.sleep(1300);
  keeper.stop();
  expect(booted).toBe(0);
  expect(published).toEqual(["sk-ant-oat01-old"]); // its last token still holds until it runs out
});

test("a sign-in replaces only a sign-in: another kind of key of that name is refused before a VM boots, and a mistyped code keeps the link", async () => {
  let launched = 0;
  const signins = new ClaudeSignins({
    store: new SigninStore(join(tempDir(), "claude-auth")), state: new SigninState(),
    launch: async () => { launched++; return { exec: async (command) => command[1] === "capture-pane" ? { ok: true, output: "visit: https://claude.com/cai/oauth/authorize?state=x" } : { ok: false, output: "" }, close: async () => {} }; },
    refuse: async (name) => (name === "codex" ? "key 'codex' exists and is not a Claude sign-in: choose another name" : undefined),
    saveKey: async () => {},
  });
  await expect(signins.start("codex")).rejects.toThrow("is not a Claude sign-in");
  expect(launched).toBe(0);
  const started = await signins.start("claude");
  await expect(signins.finish(started.id, "a b")).rejects.toThrow("not the code");
  expect(signins.waitingFor("claude")?.id).toBe(started.id);
  await signins.stop();
});
