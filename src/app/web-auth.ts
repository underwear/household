import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionStore } from "../infra/sqlite-store";

export const WEB_AUTH = {
  /** How long a sign-in link works (once). */
  tokenMs: 60_000,
  /** How long a session lasts from its sign-in. */
  sessionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

const digest = (value: string) => createHash("sha256").update(value).digest();
const randomSecret = () => randomBytes(32).toString("base64url");
const sessionHash = (session: string) => digest(session).toString("hex");

/**
 * The session cookie's name, one per port: cookies do not tell ports apart, so another server on 127.0.0.1 (a second
 * Household, a test daemon) would otherwise overwrite this one's.
 */
export const sessionCookieName = (port: string) => `household_session_${port}`;

/** Not `Secure` (and so no `__Host-` prefix): the UI is plain http on the loopback. The server checks Origin on writes. */
export const sessionCookie = (name: string, session: string) => `${name}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${WEB_AUTH.sessionMs / 1000}`;
export const clearedCookie = (name: string) => `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/** The value of cookie `name` in a Cookie header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/**
 * Who may use the web UI: whoever can reach the daemon's control socket (`house dashboard` asks it for a sign-in
 * link). A link's token (256 random bits) works once, for a minute, and is kept only in memory; it is exchanged for a
 * session id, kept in the browser's cookie and, as a hash only, in SQLite, so sessions survive a restart. No limit
 * on failed sign-ins: guessing a token is hopeless, and a limit would let any web page or pet lock the owner out.
 */
export class WebAuth {
  private tokens: { digest: Buffer; expires: number }[] = [];

  constructor(
    private readonly sessions: SessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new sign-in token. */
  mintToken(): string {
    const token = randomSecret();
    this.tokens.push({ digest: digest(token), expires: this.now() + WEB_AUTH.tokenMs });
    return token;
  }

  /** Exchanges a token (once) for a new session id; undefined for a token unknown, used or expired. */
  signIn(token: string): string | undefined {
    const now = this.now();
    this.tokens = this.tokens.filter((entry) => entry.expires > now);
    // Digests have equal length, so each comparison takes the same time whatever the guess; all are compared.
    const given = digest(token);
    let match: (typeof this.tokens)[number] | undefined;
    for (const entry of this.tokens) if (timingSafeEqual(entry.digest, given)) match = entry;
    if (!match) return undefined;
    this.tokens = this.tokens.filter((entry) => entry !== match);
    const session = randomSecret();
    this.sessions.pruneSessions(now);
    this.sessions.addSession(sessionHash(session), now + WEB_AUTH.sessionMs);
    return session;
  }

  /** Whether `session` (a cookie's value) is a live session. */
  signedIn(session: string | undefined): boolean {
    if (!session) return false;
    const expires = this.sessions.sessionExpiry(sessionHash(session));
    return expires !== undefined && expires > this.now();
  }

  signOut(session: string | undefined): void {
    if (session) this.sessions.removeSession(sessionHash(session));
  }
}
