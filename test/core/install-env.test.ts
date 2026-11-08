import { expect, test } from "bun:test";
import { AGENT_TOOL_ENV, INSTALL_ENV } from "../../src/core/install-env";

test("installers' places are shared and readable; the agent gets only what it needs to find them", () => {
  for (const value of Object.values(INSTALL_ENV)) if (value.startsWith("/")) expect(value).toMatch(/^\/(opt\/household|usr\/local)(\/|$)/);
  expect(Object.keys(INSTALL_ENV)).not.toContain("HOME");
  expect(Object.keys(INSTALL_ENV).some(name => name.startsWith("XDG_"))).toBe(false);
  expect(AGENT_TOOL_ENV).toEqual({ PLAYWRIGHT_BROWSERS_PATH: "/opt/household/playwright", RUSTUP_HOME: "/opt/household/rustup" });
  for (const name of ["CARGO_HOME", "GOPATH", "PIPX_HOME"]) expect(AGENT_TOOL_ENV).not.toHaveProperty(name); // its own builds write to its home
});
