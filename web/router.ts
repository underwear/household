import { useEffect, useState } from "react";

/** A workspace's pages, in navigation order; capabilities sit beside scouts (a tab of the Scouts page). */
export const WORKSPACE_TABS = ["overview", "bots", "channels", "inboxes", "connectors", "skills", "sideworkers", "scouts", "capabilities", "previews", "network", "resources", "secrets", "settings"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
/** A bot's pages (tabs on its page), in order. */
export const BOT_TABS = ["overview", "harness", "instructions", "lifecycle", "channels", "inboxes", "tasks", "skills", "environment", "memory", "resources"] as const;
export type BotTab = (typeof BOT_TABS)[number];
/** A scout's pages (tabs on its page), in order. */
export const SCOUT_TABS = ["overview", "instructions", "access", "runs"] as const;
export type ScoutTab = (typeof SCOUT_TABS)[number];


/** The screens so far: the workspaces, Household settings (keys, …), a page of one workspace, or a path that stands for another. */
export type Route = { page: "workspaces" } | { page: "settings" } | { page: "workspace"; name: string; tab: WorkspaceTab } | { page: "bot"; workspace: string; bot: string; tab: BotTab } | { page: "scout"; workspace: string; scout: string; tab: ScoutTab } | { page: "capability"; workspace: string; capability: string } | { page: "redirect"; to: string } | { page: "missing" };

/**
 * The pages by path pattern, first match wins; `:name` is one path segment (URI-decoded). A new screen is a line
 * here (`/workspaces/:workspace/bots/:bot`, `/workspaces/:workspace/gateway`, …) and a case in the app.
 */
type RouteEntry = [pattern: string, route: (params: Record<string, string>) => Route];
const ROUTES: RouteEntry[] = [
  ["/", () => ({ page: "workspaces" })],
  ["/settings", () => ({ page: "settings" })],
  ["/logs", () => ({ page: "redirect", to: "/" })],
  ["/keys", () => ({ page: "redirect", to: "/settings" })],
  ["/workspaces/:workspace/logs", ({ workspace }) => ({ page: "redirect", to: workspacePath(workspace!, "bots") })],
  ["/workspaces/:workspace", ({ workspace }) => ({ page: "workspace", name: workspace!, tab: "overview" })],
  ["/workspaces/:workspace/bots/:bot", ({ workspace, bot }) => ({ page: "bot", workspace: workspace!, bot: bot!, tab: "overview" })],
  // A bot's logs are a panel from its header now.
  ["/workspaces/:workspace/bots/:bot/logs", ({ workspace, bot }) => ({ page: "redirect", to: botPath(workspace!, bot!) })],
  // A bot's sideworkers are on its workspace's Sideworkers page, under its name.
  ["/workspaces/:workspace/bots/:bot/sideworkers", ({ workspace }) => ({ page: "redirect", to: workspacePath(workspace!, "sideworkers") })],
  // Monitoring became part of Resources.
  ["/workspaces/:workspace/bots/:bot/monitoring", ({ workspace, bot }) => ({ page: "redirect", to: botPath(workspace!, bot!, "resources") })],
  ["/workspaces/:workspace/scouts/:scout", ({ workspace, scout }) => ({ page: "scout", workspace: workspace!, scout: scout!, tab: "overview" })],
  ...SCOUT_TABS.filter((tab) => tab !== "overview").map((tab): RouteEntry => [`/workspaces/:workspace/scouts/:scout/${tab}`, ({ workspace, scout }) => ({ page: "scout", workspace: workspace!, scout: scout!, tab })]),
  // Default and special scouts became one list of scouts; its limit, harness and resources a dialog on it.
  ["/workspaces/:workspace/special-scouts/:scout", ({ workspace, scout }) => ({ page: "redirect", to: scoutPath(workspace!, scout!) })],
  ...["special-scouts", "scout-default", "scout-resources"].map((old): RouteEntry => [`/workspaces/:workspace/${old}`, ({ workspace }) => ({ page: "redirect", to: workspacePath(workspace!, "scouts") })]),
  ["/workspaces/:workspace/capabilities/:capability", ({ workspace, capability }) => ({ page: "capability", workspace: workspace!, capability: capability! })],
  ...BOT_TABS.filter((tab) => tab !== "overview").map((tab): RouteEntry => [`/workspaces/:workspace/bots/:bot/${tab}`, ({ workspace, bot }) => ({ page: "bot", workspace: workspace!, bot: bot!, tab })]),
  ...WORKSPACE_TABS.map((tab): RouteEntry => [`/workspaces/:workspace/${tab}`, ({ workspace }) => ({ page: "workspace", name: workspace!, tab })]),
];

/** The params of `path` if it fits `pattern`, else undefined. */
function match(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    const segment = have[index]!;
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
    } else if (part !== segment) return undefined;
  }
  return params;
}

/** The page at `path`; an unknown path is a missing page (said so, not passed over). */
export function routeOf(path: string): Route {
  // Keep bookmarks from the former terminology, changing structural segments only.
  const parts = path.split("/");
  if (parts[1] === "houses" || parts[1] === "workspaces") {
    parts[1] = "workspaces";
    if (parts[3] === "pets") parts[3] = "bots";
    if (parts[3] === "bots" && parts[5] === "agent") parts[5] = "harness";
    const canonical = parts.join("/");
    if (canonical !== path) {
      const found = routeOf(canonical);
      return found.page === "missing" ? found : { page: "redirect", to: found.page === "redirect" ? found.to : canonical };
    }
  }
  for (const [pattern, route] of ROUTES) {
    const params = match(pattern, path);
    if (params) return route(params);
  }
  return { page: "missing" };
}

/** Whether a link to `target` is the current one: `/` only on itself, anything else on itself and below it. */
export function isCurrent(target: string, path: string): boolean {
  if (target === "/") return path === "/";
  return path === target || path.startsWith(`${target.replace(/\/$/, "")}/`);
}

/** A page of a workspace: its overview unless another is named. */
export const workspacePath = (name: string, tab: WorkspaceTab = "overview") => `/workspaces/${encodeURIComponent(name)}${tab === "overview" ? "" : `/${tab}`}`;

/** A bot's own page in its workspace. */
/** A page of a bot: its overview unless another is named. */
export const botPath = (workspace: string, bot: string, tab: BotTab = "overview") => `${workspacePath(workspace, "bots")}/${encodeURIComponent(bot)}${tab === "overview" ? "" : `/${tab}`}`;

/** Goes to `path` in the browser's history (the server answers every page path with the app). */
export function navigate(path: string): void {
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo(0, 0);
}

/** Stands `path` in for the one on screen (no new history entry): for a path that is another's. */
export function redirect(path: string): void {
  history.replaceState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** The path on screen, following the history. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const changed = () => setPath(location.pathname);
    addEventListener("popstate", changed);
    return () => removeEventListener("popstate", changed);
  }, []);
  return path;
}

/** A page of a scout: its overview unless another is named. */
export const scoutPath = (workspace: string, scout: string, tab: ScoutTab = "overview") => `${workspacePath(workspace, "scouts")}/${encodeURIComponent(scout)}${tab === "overview" ? "" : `/${tab}`}`;

export const capabilityPath = (workspace: string, capability: string) => `${workspacePath(workspace, "capabilities")}/${encodeURIComponent(capability)}`;
