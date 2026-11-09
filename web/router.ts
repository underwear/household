import { useEffect, useState } from "react";

/** A house's pages, in navigation order; capabilities sit beside scouts (a tab of the Scouts page). */
export const HOUSE_TABS = ["overview", "pets", "channels", "inboxes", "skills", "sideworkers", "scouts", "capabilities", "previews", "network", "settings"] as const;
export type HouseTab = (typeof HOUSE_TABS)[number];
/** A pet's pages (tabs on its page), in order. */
export const PET_TABS = ["overview", "agent", "instructions", "lifecycle", "channels", "inboxes", "tasks", "skills", "environment", "memory", "resources"] as const;
export type PetTab = (typeof PET_TABS)[number];
/** A scout's pages (tabs on its page), in order. */
export const SCOUT_TABS = ["overview", "instructions", "access", "runs"] as const;
export type ScoutTab = (typeof SCOUT_TABS)[number];


/** The screens so far: the houses, Household settings (keys, …), a page of one house, or a path that stands for another. */
export type Route = { page: "houses" } | { page: "settings" } | { page: "house"; name: string; tab: HouseTab } | { page: "pet"; house: string; pet: string; tab: PetTab } | { page: "scout"; house: string; scout: string; tab: ScoutTab } | { page: "capability"; house: string; capability: string } | { page: "redirect"; to: string } | { page: "missing" };

/**
 * The pages by path pattern, first match wins; `:name` is one path segment (URI-decoded). A new screen is a line
 * here (`/houses/:house/pets/:pet`, `/houses/:house/gateway`, …) and a case in the app.
 */
type RouteEntry = [pattern: string, route: (params: Record<string, string>) => Route];
const ROUTES: RouteEntry[] = [
  ["/", () => ({ page: "houses" })],
  ["/settings", () => ({ page: "settings" })],
  ["/logs", () => ({ page: "redirect", to: "/" })],
  ["/keys", () => ({ page: "redirect", to: "/settings" })],
  ["/houses/:house/logs", ({ house }) => ({ page: "redirect", to: housePath(house!, "pets") })],
  ["/houses/:house", ({ house }) => ({ page: "house", name: house!, tab: "overview" })],
  ["/houses/:house/pets/:pet", ({ house, pet }) => ({ page: "pet", house: house!, pet: pet!, tab: "overview" })],
  // A pet's logs are a panel from its header now.
  ["/houses/:house/pets/:pet/logs", ({ house, pet }) => ({ page: "redirect", to: petPath(house!, pet!) })],
  // A pet's sideworkers are on its house's Sideworkers page, under its name.
  ["/houses/:house/pets/:pet/sideworkers", ({ house }) => ({ page: "redirect", to: housePath(house!, "sideworkers") })],
  // Monitoring became part of Resources.
  ["/houses/:house/pets/:pet/monitoring", ({ house, pet }) => ({ page: "redirect", to: petPath(house!, pet!, "resources") })],
  ["/houses/:house/scouts/:scout", ({ house, scout }) => ({ page: "scout", house: house!, scout: scout!, tab: "overview" })],
  ...SCOUT_TABS.filter((tab) => tab !== "overview").map((tab): RouteEntry => [`/houses/:house/scouts/:scout/${tab}`, ({ house, scout }) => ({ page: "scout", house: house!, scout: scout!, tab })]),
  // Default and special scouts became one list of scouts; its limit, agent and resources a dialog on it.
  ["/houses/:house/special-scouts/:scout", ({ house, scout }) => ({ page: "redirect", to: scoutPath(house!, scout!) })],
  ...["special-scouts", "scout-default", "scout-resources"].map((old): RouteEntry => [`/houses/:house/${old}`, ({ house }) => ({ page: "redirect", to: housePath(house!, "scouts") })]),
  ["/houses/:house/capabilities/:capability", ({ house, capability }) => ({ page: "capability", house: house!, capability: capability! })],
  ...PET_TABS.filter((tab) => tab !== "overview").map((tab): RouteEntry => [`/houses/:house/pets/:pet/${tab}`, ({ house, pet }) => ({ page: "pet", house: house!, pet: pet!, tab })]),
  ...HOUSE_TABS.map((tab): RouteEntry => [`/houses/:house/${tab}`, ({ house }) => ({ page: "house", name: house!, tab })]),
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

/** A page of a house: its overview unless another is named. */
export const housePath = (name: string, tab: HouseTab = "overview") => `/houses/${encodeURIComponent(name)}${tab === "overview" ? "" : `/${tab}`}`;

/** A pet's own page in its house. */
/** A page of a pet: its overview unless another is named. */
export const petPath = (house: string, pet: string, tab: PetTab = "overview") => `${housePath(house, "pets")}/${encodeURIComponent(pet)}${tab === "overview" ? "" : `/${tab}`}`;

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
export const scoutPath = (house: string, scout: string, tab: ScoutTab = "overview") => `${housePath(house, "scouts")}/${encodeURIComponent(scout)}${tab === "overview" ? "" : `/${tab}`}`;

export const capabilityPath = (house: string, capability: string) => `${housePath(house, "capabilities")}/${encodeURIComponent(capability)}`;
