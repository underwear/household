import { expect, test } from "bun:test";
import { Onboarding } from "../../src/app/onboarding";

const never = () => new Promise<never>(() => {});

test("a wait for a bot ends when its channel is added another way; a new sign-in for a key replaces one still running", async () => {
  const aborted: string[] = [];
  const cancelled: string[] = [];
  let logins = 0;
  const onboarding = new Onboarding({
    watch: (token, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted.push(token); resolve("timeout"); })),
    checkGroup: async (_token, chat) => ({ id: chat, title: "Home", problems: [] }),
    apply: async () => {},
    deviceLogin: async () => { const n = ++logins; return { url: "https://auth.example/device", code: `CODE-000${n}`, done: never(), cancel: () => cancelled.push(`login ${n}`) }; },
  });
  const id = onboarding.listen("4242:token", "home", "telegram-dm", "@bot");
  onboarding.release("4343:other");
  expect(onboarding.status(id).status).toBe("waiting");
  onboarding.release("4242:token");
  expect(aborted).toEqual(["4242:token"]);
  expect(() => onboarding.status(id)).toThrow("no such wait");

  const first = await onboarding.startLogin("chatgpt");
  await onboarding.startLogin("chatgpt");
  expect(cancelled).toEqual(["login 1"]);
  expect(() => onboarding.login(first.id)).toThrow("no such sign-in");
  onboarding.stopAll();
});

test("a group's watch: what is found comes along while it waits; Check again asks the group anew, and it is ready once it has all", async () => {
  let fixed = false;
  let found!: (group: { id: string; title: string; problems: string[] }) => void;
  let owner!: (contact: { id: string; name: string }) => void;
  const onboarding = new Onboarding({
    watch: (_token, { onContact, onGroup, signal }) => { owner = onContact; found = onGroup; return new Promise((resolve) => signal.addEventListener("abort", () => resolve("timeout"))); },
    checkGroup: async (_token, chat) => ({ id: chat, title: "Home", problems: fixed ? [] : ["turn on Topics in the group's settings"] }),
    apply: async () => {},
  });
  const id = onboarding.listen("4242:token", "home", "telegram-group", "@bot");
  expect(onboarding.status(id)).toMatchObject({ status: "waiting", needsGroup: true });
  owner({ id: "777", name: "Igor" });
  found({ id: "-1005", title: "Home", problems: ["turn on Topics in the group's settings"] });
  expect(onboarding.status(id)).toMatchObject({ status: "waiting", contact: { id: "777" }, group: { problems: ["turn on Topics in the group's settings"] } });
  await onboarding.recheck(id);
  expect(onboarding.status(id).status).toBe("waiting");
  fixed = true;
  await onboarding.recheck(id);
  expect(onboarding.status(id)).toMatchObject({ status: "ready", group: { id: "-1005", problems: [] } });
  expect(onboarding.bot(id).group).toEqual({ id: "-1005", title: "Home", problems: [] });
  onboarding.stopAll();
});
