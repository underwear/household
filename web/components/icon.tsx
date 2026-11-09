import type { PlatformView } from "../api";

/**
 * A platform's mark (its descriptor's SVG path), the size of a bot's avatar: drawn inline, nothing loaded (the CSP
 * allows no data: or other images). None for a platform the UI was not told of.
 */
export function PlatformIcon({ platforms, platform, small }: { platforms: PlatformView[]; platform: string; small?: boolean }) {
  const icon = platforms.find((each) => each.platform === platform)?.icon;
  if (!icon) return null;
  return (
    <span className={small ? "avatar icon small" : "avatar icon"} aria-hidden>
      <svg viewBox={icon.viewBox} focusable="false">
        <path d={icon.d} fill="currentColor" />
      </svg>
    </span>
  );
}
