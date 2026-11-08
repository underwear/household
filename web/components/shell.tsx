import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppWindow, Compass, BookOpen, Archive, ChevronDown, Globe, House, LayoutDashboard, LayoutList, LogOut, Menu, Plus, MessagesSquare, Moon, PawPrint, Settings, SlidersHorizontal, Sun, Pickaxe, X, type LucideIcon } from "lucide-react";
import type { HouseView, MeView } from "../api";
import { houseFeatures } from "../../src/core/house-features";
import { housePath, isCurrent, petPath, type HouseTab } from "../router";
import type { Theme } from "../theme";
import { focusables, useFocusTrap } from "./focus-trap";
import { petState, withWorkers } from "./pet-state";
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
 * The screens of a house and of Household; only the ones built so far go anywhere. A feature the house has off
 * (Settings → Features) has no entry: its page still answers its address, saying it is off.
 */
const houseNav = (house: string, view?: HouseView): NavEntry[] => {
  const on = houseFeatures(view ?? {});
  return [
    { label: "Overview", icon: LayoutDashboard, path: housePath(house) },
    { label: "Pets", icon: PawPrint, path: housePath(house, "pets") },
    { label: "Channels", icon: MessagesSquare, path: housePath(house, "channels") },
    { label: "Inboxes", icon: Archive, path: housePath(house, "inboxes") },
    { label: "Shared Skills", icon: BookOpen, path: housePath(house, "skills") },
    ...(on.sideworkers ? [{ label: "Sideworkers", icon: Pickaxe, path: housePath(house, "sideworkers") }] : []),
    ...(on.scouts ? [{ label: "Scouts", icon: Compass, path: housePath(house, "scouts"), also: [housePath(house, "capabilities")] }] : []),
    ...(on.preview ? [{ label: "Previews", icon: AppWindow, path: housePath(house, "previews") }] : []),
    { label: "Network", icon: Globe, path: housePath(house, "network") },
    { label: "Settings", icon: Settings, path: housePath(house, "settings") },
  ];
};
const HOUSEHOLD_NAV: NavEntry[] = [
  { label: "Houses", icon: House, path: "/" },
  { label: "Settings", icon: SlidersHorizontal, path: "/settings" },
  { label: "Backup", icon: Archive },
];

export interface ShellProps {
  me: MeView;
  houses: HouseView[];
  /** The house on screen; none: Household's own settings. */
  house?: string;
  /** The pet on screen, inside the selected house. */
  pet?: string;
  /** Which of the house’s pages is on screen. */
  tab?: HouseTab;
  /** The path on screen, to mark its entry. */
  path: string;
  /** The daemon could not be reached, say: shown above the page. */
  problem?: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onNewHouse: () => void;
  children: ReactNode;
}

/**
 * From 1024px: the sidebar (the house switcher, a house's screens or Household's, Household's card) next to the
 * page. Narrower: a top bar with a menu button and the switcher; the menu opens the rest as a drawer (the focus
 * stays in it; Escape or a click outside closes it, back to the menu button; a link in it closes it, to the page).
 * A problem reaching the daemon shows above the page.
 */
export function Shell({ me, houses, house, pet, path, problem, theme, onToggleTheme, onSignOut, onNewHouse, children }: ShellProps) {
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
          <HouseSwitcher houses={houses} house={house} pet={pet} path={path} onNewHouse={onNewHouse} />
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

/** A disclosure of house overview links and their pets, available in every context. */
function HouseSwitcher({ houses, house, pet, path, onNewHouse }: { houses: HouseView[]; house?: string; pet?: string; path: string; onNewHouse: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const toPage = useRef(false);
  const selectedPet = houses.find(({ name }) => name === house)?.pets.find(({ name }) => name === pet);
  const primary = pet ? selectedPet?.title ?? pet : house ?? "Household";
  const secondary = pet ? house : house ? "House" : "Houses and pets";
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
        aria-label={`Switch house or pet: ${pet ? `${primary} in ${house}` : primary}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {pet ? <span className="context-emoji" aria-hidden>{selectedPet?.emoji ?? "🐾"}</span> : <House className="context-icon" size={18} aria-hidden />}
        <span className="context-label">
          <span className="context-primary">{primary}</span>
          <span className="context-secondary">{secondary}</span>
        </span>
        <ChevronDown className="context-chevron faint" size={14} aria-hidden />
      </button>
      {open && (
        <nav id={id} className="menu context-menu" aria-label="Houses and pets">
          <div className="section-label">Houses</div>
          <ul className="context-list">
            {houses.map(({ name, pets }) => {
              const selectedHouse = name === house && !pet;
              return (
                <li key={name} className="context-group">
                  <Link href={housePath(name)} current={selectedHouse} className={`menu-item context-house${selectedHouse ? " current" : ""}`} onClick={shut}>
                    <House className="context-mark" size={15} strokeWidth={1.75} aria-hidden />
                    <span className="context-item-label">{name}</span>
                  </Link>
                  {pets.length > 0 && (
                    <ul className="context-pets">
                      {withWorkers(pets).map((entry) => {
                        const selected = name === house && entry.name === pet;
                        return (
                          <li key={entry.name}>
                            <Link href={petPath(name, entry.name)} current={selected} className={`menu-item context-pet${entry.sideworker ? " worker" : ""}${selected ? " current" : ""}`} onClick={shut}>
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
            {houses.length === 0 && <li className="context-empty">No houses yet.</li>}
          </ul>
          <div className="menu-sep" />
          <button
            className="menu-item context-action"
            onClick={() => {
              setOpen(false);
              button.current?.focus();
              onNewHouse();
            }}
          >
            <Plus className="context-mark" size={15} strokeWidth={1.75} aria-hidden />
            New house
          </button>
          <Link href="/" className="menu-item context-action" onClick={shut}>
            <LayoutList className="context-mark" size={15} strokeWidth={1.75} aria-hidden />
            Manage houses
          </Link>
        </nav>
      )}
    </div>
  );
}
