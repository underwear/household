import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { KeyRound, AppWindow, Compass, BookOpen, Archive, ChevronDown, Globe, Building2, LayoutDashboard, LayoutList, LogOut, Menu, Plus, MessagesSquare, Moon, Bot, Settings, SlidersHorizontal, Sun, Pickaxe, X, type LucideIcon } from "lucide-react";
import type { WorkspaceView, MeView } from "../api";
import { houseFeatures } from "../../src/core/house-features";
import { workspacePath, isCurrent, botPath, type WorkspaceTab } from "../router";
import type { Theme } from "../theme";
import { focusables, useFocusTrap } from "./focus-trap";
import { petState, withWorkers } from "./bot-state";
import { focusPage, NARROW_SHELL } from "./layout";
import { Link } from "./link";

interface NavEntry {
  label: string;
  icon: LucideIcon;
  /** Where it goes; none yet: shown as "soon". */
  path?: string;
  /** Other pages it stands for (Scouts: its capabilities too). */
  also?: string[];
}

/**
 * The screens of a workspace and of Household; only the ones built so far go anywhere. A feature the workspace has off
 * (Settings → Features) has no entry: its page still answers its address, saying it is off.
 */
const houseNav = (house: string, view?: WorkspaceView): NavEntry[] => {
  const on = houseFeatures(view ?? {});
  return [
    { label: "Overview", icon: LayoutDashboard, path: workspacePath(house) },
    { label: "Bots", icon: Bot, path: workspacePath(house, "bots") },
    { label: "Channels", icon: MessagesSquare, path: workspacePath(house, "channels") },
    { label: "Inboxes", icon: Archive, path: workspacePath(house, "inboxes") },
    { label: "Connectors", icon: Globe, path: workspacePath(house, "connectors") },
    { label: "Shared Skills", icon: BookOpen, path: workspacePath(house, "skills") },
    ...(on.sideworkers ? [{ label: "Sideworkers", icon: Pickaxe, path: workspacePath(house, "sideworkers") }] : []),
    ...(on.scouts ? [{ label: "Scouts", icon: Compass, path: workspacePath(house, "scouts"), also: [workspacePath(house, "capabilities")] }] : []),
    ...(on.preview ? [{ label: "Previews", icon: AppWindow, path: workspacePath(house, "previews") }] : []),
    { label: "Network", icon: Globe, path: workspacePath(house, "network") },
    { label: "Secrets", icon: KeyRound, path: workspacePath(house, "secrets") },
    { label: "Settings", icon: Settings, path: workspacePath(house, "settings") },
  ];
};
const HOUSEHOLD_NAV: NavEntry[] = [
  { label: "Workspaces", icon: Building2, path: "/" },
  { label: "Settings", icon: SlidersHorizontal, path: "/settings" },
  { label: "Backup", icon: Archive },
];

export interface ShellProps {
  me: MeView;
  houses: WorkspaceView[];
  /** The workspace on screen; none: Household's own settings. */
  house?: string;
  /** The bot on screen, inside the selected workspace. */
  pet?: string;
  /** Which of the workspace’s pages is on screen. */
  tab?: WorkspaceTab;
  /** The path on screen, to mark its entry. */
  path: string;
  /** The daemon could not be reached, say: shown above the page. */
  problem?: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onNewWorkspace: () => void;
  children: ReactNode;
}

/**
 * From 1024px: the sidebar (the workspace switcher, a workspace's screens or Household's, Household's card) next to the
 * page. Narrower: a top bar with a menu button and the switcher; the menu opens the rest as a drawer (the focus
 * stays in it; Escape or a click outside closes it, back to the menu button; a link in it closes it, to the page).
 * A problem reaching the daemon shows above the page.
 */
export function Shell({ me, houses, house, pet, path, problem, theme, onToggleTheme, onSignOut, onNewWorkspace, children }: ShellProps) {
  const nav = house ? houseNav(house, houses.find((each) => each.name === house)) : HOUSEHOLD_NAV;
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  /** The drawer closed because a link in it was followed: the focus goes to the page. */
  const toPage = useRef(false);
  const close = useCallback(() => {
    setOpen(false);
    menuButton.current?.focus();
  }, []);
  const followed = () => {
    if (!open) return;
    toPage.current = true;
    setOpen(false);
  };
  useFocusTrap(drawer, open, close);
  useEffect(() => setOpen(false), [path, house]);
  useEffect(() => {
    if (open || !toPage.current) return;
    toPage.current = false;
    focusPage();
  }, [open, path]);
  useEffect(() => {
    if (!open) return;
    focusables(drawer.current!)[0]?.focus();
    // Wide again: the drawer is the sidebar, nothing to close or trap.
    const wide = matchMedia(NARROW_SHELL);
    const changed = () => wide.matches || setOpen(false);
    wide.addEventListener("change", changed);
    return () => wide.removeEventListener("change", changed);
  }, [open]);
  return (
    <div className="shell">
      <header className="side">
        <div className="side-bar">
          <button ref={menuButton} className="icon-btn menu-button" aria-label="Menu" aria-expanded={open} aria-controls="drawer" onClick={() => setOpen(true)}>
            <Menu size={18} strokeWidth={1.75} aria-hidden />
          </button>
          <WorkspaceSwitcher houses={houses} house={house} pet={pet} path={path} onNewWorkspace={onNewWorkspace} />
        </div>
        {open && <div className="drawer-scrim" onClick={close} />}
        <div ref={drawer} id="drawer" className={`drawer${open ? " open" : ""}`} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label="Navigation">
          <div className="drawer-head">
            <span className="section-label">{house ?? "Household"}</span>
            <button className="icon-btn" aria-label="Close menu" onClick={close}>
              <X size={18} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <nav className="nav">
            {nav.map((entry) =>
              entry.path ? (
                <Link
                  key={entry.label}
                  href={entry.path}
                  current={entry.label === "Overview" ? path === entry.path : isCurrent(entry.path, path) || (entry.also ?? []).some(other => isCurrent(other, path))}
                  className={`nav-item${(entry.label === "Overview" ? path === entry.path : isCurrent(entry.path, path) || (entry.also ?? []).some(other => isCurrent(other, path))) ? " active" : ""}`}
                  onClick={followed}
                >
                  <entry.icon className="icon" size={16} strokeWidth={1.75} aria-hidden />
                  <span className="label">{entry.label}</span>
                </Link>
              ) : (
                <button key={entry.label} className="nav-item" disabled>
                  <entry.icon className="icon" size={16} strokeWidth={1.75} aria-hidden />
                  <span className="label">{entry.label}</span>
                  <span className="soon">soon</span>
                </button>
              ),
            )}
          </nav>
          <div className="spacer" />
          <div className="side-foot">
            <Link href="/" current={path === "/"} className={`household-card${house ? "" : " active"}`} onClick={followed}>
              <div className="logo small">H</div>
              <div>
                <div className="name">Household</div>
                <div className="status">
                  <span className={`dot ${me.state === "running" ? "idle" : "busy"}`} />v{me.version} · {me.state}
                </div>
              </div>
            </Link>
            <div className="foot-buttons">
              <button onClick={onToggleTheme}>
                {theme === "dark" ? <Sun size={14} aria-hidden /> : <Moon size={14} aria-hidden />}
                {theme === "dark" ? "Light theme" : "Dark theme"}
              </button>
              <button
                onClick={() => {
                  // The drawer goes first, so the dialog's focus comes back to the menu button.
                  if (open) close();
                  onSignOut();
                }}
              >
                <LogOut size={14} aria-hidden />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="content" tabIndex={-1}>
        {problem && (
          <div className="shell-notice">
            <div className="banner danger" role="alert">
              {problem}
            </div>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

/** A disclosure of workspace overview links and their bots, available in every context. */
function WorkspaceSwitcher({ houses, house, pet, path, onNewWorkspace }: { houses: WorkspaceView[]; house?: string; pet?: string; path: string; onNewWorkspace: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const toPage = useRef(false);
  const selectedBot = houses.find(({ name }) => name === house)?.pets.find(({ name }) => name === pet);
  const primary = pet ? selectedBot?.title ?? pet : house ?? "Household";
  const secondary = pet ? house : house ? "Workspace" : "Workspaces and bots";
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (open || !toPage.current) return;
    toPage.current = false;
    focusPage();
  }, [open, path]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    addEventListener("pointerdown", outside);
    addEventListener("keydown", escape);
    return () => {
      removeEventListener("pointerdown", outside);
      removeEventListener("keydown", escape);
    };
  }, [open]);
  const shut = () => {
    toPage.current = true;
    setOpen(false);
  };
  return (
    <div className="context-switcher" ref={root}>
      <button
        ref={button}
        className={`switcher${open ? " open" : ""}`}
        aria-label={`Switch workspace or bot: ${pet ? `${primary} in ${house}` : primary}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {pet ? <span className="context-emoji" aria-hidden>{selectedBot?.emoji ?? "🤖"}</span> : <Building2 className="context-icon" size={18} aria-hidden />}
        <span className="context-label">
          <span className="context-primary">{primary}</span>
          <span className="context-secondary">{secondary}</span>
        </span>
        <ChevronDown className="context-chevron faint" size={14} aria-hidden />
      </button>
      {open && (
        <nav id={id} className="menu context-menu" aria-label="Workspaces and bots">
          <div className="section-label">Workspaces</div>
          <ul className="context-list">
            {houses.map(({ name, pets }) => {
              const selectedWorkspace = name === house && !pet;
              return (
                <li key={name} className="context-group">
                  <Link href={workspacePath(name)} current={selectedWorkspace} className={`menu-item context-workspace${selectedWorkspace ? " current" : ""}`} onClick={shut}>
                    <Building2 className="context-mark" size={15} strokeWidth={1.75} aria-hidden />
                    <span className="context-item-label">{name}</span>
                  </Link>
                  {pets.length > 0 && (
                    <ul className="context-bots">
                      {withWorkers(pets).map((entry) => {
                        const selected = name === house && entry.name === pet;
                        return (
                          <li key={entry.name}>
                            <Link href={botPath(name, entry.name)} current={selected} className={`menu-item context-bot${entry.sideworker ? " worker" : ""}${selected ? " current" : ""}`} onClick={shut}>
                              <span className="context-mark context-emoji" aria-hidden>{entry.emoji}</span>
                              <span className="context-item-label">{entry.title}</span>
                              <span className={`dot ${petState(entry.state).tone}`} title={petState(entry.state).label} />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
            {houses.length === 0 && <li className="context-empty">No workspaces yet.</li>}
          </ul>
          <div className="menu-sep" />
          <button
            className="menu-item context-action"
            onClick={() => {
              setOpen(false);
              button.current?.focus();
              onNewWorkspace();
            }}
          >
            <Plus className="context-mark" size={15} strokeWidth={1.75} aria-hidden />
            New workspace
          </button>
          <Link href="/" className="menu-item context-action" onClick={shut}>
            <LayoutList className="context-mark" size={15} strokeWidth={1.75} aria-hidden />
            Manage workspaces
          </Link>
        </nav>
      )}
    </div>
  );
}
