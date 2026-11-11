import { expect, test } from "bun:test";
import { Onboarding } from "../../src/app/onboarding";

const never = () => new Promise<never>(() => {});

test("a wait for a bot ends when its channel is added another way; a new sign-in for a key replaces one still running", async () => {
  const aborted: string[] = [];
  const cancelled: string[] = [];
  let logins = 0;
  const onboarding = new Onboarding({
    firstContact: (token, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted.push(token); resolve(undefined); })),
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
