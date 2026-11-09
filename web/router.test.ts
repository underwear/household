import { expect, test } from "bun:test";
import { botPath, routeOf, workspacePath } from "./router";

test("workspace and bot bookmarks redirect to the renamed paths without rewriting names", () => {
  const paths = [
    ["/houses/work", "/workspaces/work"],
    ["/houses/work/pets", "/workspaces/work/bots"],
    ["/houses/work/pets/owl", "/workspaces/work/bots/owl"],
    ["/houses/work/pets/owl/agent", "/workspaces/work/bots/owl/harness"],
    ["/workspaces/work/pets/owl/agent", "/workspaces/work/bots/owl/harness"],
    ["/workspaces/work/bots/owl/agent", "/workspaces/work/bots/owl/harness"],
    ["/houses/work/pets/owl/monitoring", "/workspaces/work/bots/owl/resources"],
    ["/houses/work/pets/owl/sideworkers", "/workspaces/work/sideworkers"],
    ["/houses/work/scouts/owl/access", "/workspaces/work/scouts/owl/access"],
    ["/houses/work/capabilities/deploy", "/workspaces/work/capabilities/deploy"],
    ["/houses/house%2Fpets/pets/agent/agent", "/workspaces/house%2Fpets/bots/agent/harness"],
    ["/houses/work/scout-default", "/workspaces/work/scouts"],
  ] as const;
  for (const [old, to] of paths) expect(routeOf(old!)).toEqual({ page: "redirect", to });
  expect(workspacePath("house/pets")).toBe("/workspaces/house%2Fpets");
  expect(routeOf(botPath("house/pets", "agent", "harness"))).toEqual({ page: "bot", workspace: "house/pets", bot: "agent", tab: "harness" });
  expect(routeOf("/houses/work/pets/owl/not-a-tab")).toEqual({ page: "missing" });
});


test("Secrets has a dedicated workspace route", () => {
  expect(workspacePath("work", "secrets")).toBe("/workspaces/work/secrets");
  expect(routeOf("/workspaces/work/secrets")).toEqual({ page: "workspace", name: "work", tab: "secrets" });
});
