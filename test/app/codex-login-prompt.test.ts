import { expect, test } from "bun:test";
import { deviceLoginPrompt } from "../../src/app/codex-login";

test("the link and the one-time code are read from what Codex's device sign-in prints, colours and all", () => {
  const printed = "Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mFRZT-9KQ2M\u001b[0m\n";
  expect(deviceLoginPrompt(printed)).toEqual({ url: "https://auth.openai.com/codex/device", code: "FRZT-9KQ2M" });
  expect(deviceLoginPrompt(printed.slice(0, 120))).toBeUndefined(); // the code is not out yet
});
