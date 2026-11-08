import { Children, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Link } from "./link";

/*
 * Layout primitives. Screens lay themselves out with these (and the fields in ./fields): a component per pattern
 * keeps the variants few and typed, and the responsive rules in one place (styles/primitives.css). Text styles
 * (.strong, .muted, .id, .mono, .ellipsis…) stay plain classes.
 */

/** The shell's breakpoint of styles/tokens.css, for code that must know (CSS has its own copy there). */
export const NARROW_SHELL = "(width < 1024px)";

/** A space of the scale (tokens.css `--space-N`). */
export type Gap = 1 | 2 | 3 | 4 | 5 | 6;

/** Puts the focus on the page's title (after moving to another page, or when what had it is gone). */
export function focusPage(): void {
  (document.querySelector<HTMLElement>(".content h1") ?? document.querySelector<HTMLElement>(".content"))?.focus();
}

/**
 * A screen: its title (and buttons beside it, at the right edge), then its sections. Every page takes the window's
 * width, so moving between pages does not move the content; text and form fields keep their own widths.
 */
export function Page({ title, actions, back, children }: { title: ReactNode; actions?: ReactNode; /** The page one thing belongs to: a link above its title. */ back?: { href: string; label: string }; children?: ReactNode }) {
  const head = (
    <div className="page-head">
      <h1 className="h1" tabIndex={-1}>
        {title}
      </h1>
      {actions && <Cluster gap={3}>{actions}</Cluster>}
    </div>
  );
  return (
    <div className="page">
      {back ? (
        <div className="page-top">
          <Link href={back.href} className="page-back">← {back.label}</Link>
          {head}
        </div>
      ) : head}
      {children}
    </div>
  );
}

/**
 * A page's tabs, under its title: each a link to its own path (so Back and a copied link work), the current one
 * underlined; `count` beside a label says how many it holds.
 */
export function Tabs({ label, items }: { label: string; items: ({ label: string; href: string; current: boolean; count?: number; disabled?: false } | { label: string; disabled: true })[] }) {
  const nav = useRef<HTMLElement>(null);
  // On a narrow screen the tabs scroll sideways: keep the current one in view (the last ones are off it otherwise).
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>(".tab.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  return (
    <nav ref={nav} className="tabs" aria-label={label}>
      {items.map((item) => item.disabled ? (
        <button key={item.label} type="button" className="tab" disabled>
          {item.label}<span className="soon">soon</span>
        </button>
      ) : (
        <Link key={item.href} href={item.href} current={item.current} className={item.current ? "tab current" : "tab"}>
          {item.label}
          {item.count !== undefined && item.count > 0 && <span className="tab-count">{item.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** How wide a section may grow: a list of a few columns (the default), one column (`narrow`), or a workspace (`wide`). */
export type SectionWidth = "narrow" | "wide";

/**
 * A part of a page: a title with a one-line hint, buttons on the right (under it when there is no room). On a wide
 * screen it stops at a width its content reads well at (`width`); the page around it keeps the window's.
 */
export function Section({ title, hint, actions, width, children }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; width?: SectionWidth; children?: ReactNode }) {
  return (
    <section className={width ? `section ${width}` : "section"}>
      {(title || actions || hint) && (
        <div className="section-intro">
          <div className="section-head">
            {title && <h2 className="h2">{title}</h2>}
            {actions && <Cluster gap={3}>{actions}</Cluster>}
          </div>
          {hint && <p className="hint">{hint}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A bordered box. */
export function Panel({ children }: { children: ReactNode }) {
  return <div className="panel">{children}</div>;
}

/** Things one under another. */
export function Stack({ gap = 3, children }: { gap?: Gap; children: ReactNode }) {
  return <div className={`stack gap-${gap}`}>{children}</div>;
}

/**
 * Things side by side that wrap when there is no room. `between`: the first at the start, the rest at the end;
 * a child with the `grow` class takes the free space.
 */
export function Cluster({ gap = 3, justify, children }: { gap?: Gap; justify?: "between" | "end"; children: ReactNode }) {
  return <div className={`cluster gap-${gap}${justify ? ` ${justify}` : ""}`}>{children}</div>;
}

/** A small rounded label: a leading mark (emoji, icon, status dot), then text; `title` for what is cut. */
export function Chip({ lead, title, children }: { lead?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <span className="chip" title={title}>
      {lead}
      <span className="ellipsis">{children}</span>
    </span>
  );
}

/** Fields two to a row; one on a phone. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="form-grid">{children}</div>;
}

export interface ListProps {
  /**
   * The grid's columns (CSS grid-template-columns), the last for the actions; every row shares them (subgrid), so
   * `auto` fits the widest cell of the column. Default: the content, then the actions.
   */
  columns?: string;
  /** Column titles (read out, not shown on a phone, where each cell may show its own `label`). */
  head?: string[];
  /** What the list says when it has no rows. */
  empty?: ReactNode;
  children?: ReactNode;
}

/** A table of rows on shared columns. On a phone a row of several cells stacks them, its actions under them. */
export function List({ columns, head, empty, children }: ListProps) {
  const rows = Children.toArray(children);
  return (
    <div className="list" role="table" style={columns ? ({ "--cols": columns } as CSSProperties) : undefined}>
      {head && (
        <div className="list-row list-head" role="row">
          {head.map((title, index) => (
            <span key={index} role="columnheader">
              {title}
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 && empty && (
        <div className="list-empty" role="row">
          <span role="cell">{empty}</span>
        </div>
      )}
      {rows}
    </div>
  );
}

/** A row: its cells, then its buttons. */
export function ListRow({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  const reflow = Children.toArray(children).length > 1;
  return (
    <div className={`list-row${reflow ? " reflow" : ""}`} role="row">
      {children}
      {actions && (
        <span className="list-actions" role="cell">
          {actions}
        </span>
      )}
    </div>
  );
}

export interface CellProps {
  /** Its column's title, shown before it on a phone (where the list's head is not). */
  label?: string;
  /** Lines one under another instead of side by side. */
  lines?: boolean;
  /** Side by side, but what does not fit goes on the next line (instead of squeezing the first). */
  wrap?: boolean;
  /** Code-like: ids, hosts, agent and model. */
  mono?: boolean;
  children: ReactNode;
}

export function Cell({ label, lines, wrap, mono, children }: CellProps) {
  const classes = ["cell", lines && "lines", wrap && "wrap", mono && "mono"].filter(Boolean).join(" ");
  return (
    <div className={classes} role="cell" data-label={label}>
      {children}
    </div>
  );
}
