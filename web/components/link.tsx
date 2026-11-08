import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../router";

export interface LinkProps {
  href: string;
  /** It is the page on screen (`aria-current="page"`). */
  current?: boolean;
  className?: string;
  /** Also on a click (after navigating), e.g. to close the menu it is in. */
  onClick?: () => void;
  children: ReactNode;
}

/** A real link (open in a new tab, copy it) that moves inside the app on a plain left click. */
export function Link({ href, current, className, onClick, children }: LinkProps) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
    onClick?.();
  };
  return (
    <a href={href} className={className} aria-current={current ? "page" : undefined} onClick={click}>
      {children}
    </a>
  );
}
