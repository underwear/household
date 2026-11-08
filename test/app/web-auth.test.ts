import { expect, test } from "bun:test";
import { join } from "node:path";
import { cookieValue, sessionCookie, sessionCookieName, WEB_AUTH, WebAuth } from "../../src/app/web-auth";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { tempDir } from "../helpers";

function setup(path = ":memory:") {
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const store = new SqliteStore(path);
  return { store, clock, auth: new WebAuth(store, () => now), now: () => now };
}

test("a token works once, and only within its minute; failures never lock a good token out", () => {
  const { auth, clock } = setup();
  for (let i = 0; i < 50; i++) expect(auth.signIn(`wrong-${i}`)).toBeUndefined(); // a page or a pet guessing
  const token = auth.mintToken();
  expect(auth.signIn(token)).toEqual(expect.any(String));
  expect(auth.signIn(token)).toBeUndefined();

  const late = auth.mintToken();
  clock.advance(WEB_AUTH.tokenMs);
  expect(auth.signIn(late)).toBeUndefined();
  expect(auth.signIn("")).toBeUndefined();
});

test("a session ends after a week or on sign-out; only its hash is stored", () => {
  const { auth, clock, store } = setup();
  const session = auth.signIn(auth.mintToken())!;
  expect(auth.signedIn(session)).toBe(true);
  expect(auth.signedIn("guess")).toBe(false);
  expect(auth.signedIn(undefined)).toBe(false);
  expect(store.sessionExpiry(session)).toBeUndefined(); // not under the id itself

  clock.advance(WEB_AUTH.sessionMs);
  expect(auth.signedIn(session)).toBe(false);

  const second = auth.signIn(auth.mintToken())!;
  auth.signOut(second);
  expect(auth.signedIn(second)).toBe(false);
});

test("sessions survive a restart (a new store and WebAuth on the same database)", () => {
  const path = join(tempDir(), "household.db");
  const before = setup(path);
  const session = before.auth.signIn(before.auth.mintToken())!;
  before.store.close();
  expect(new WebAuth(new SqliteStore(path), before.now).signedIn(session)).toBe(true);
});

test("the cookie: named for the port, HttpOnly, SameSite=Strict, for the whole site, for a week", () => {
  const name = sessionCookieName("8780");
  expect(name).toBe("household_session_8780");
  expect(sessionCookie(name, "abc")).toBe("household_session_8780=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800");
  expect(cookieValue("household_session_1=a; household_session_8780=x=y; b=2", name)).toBe("x=y");
  expect(cookieValue(null, name)).toBeUndefined();
});
