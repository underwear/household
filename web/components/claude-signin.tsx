import { useEffect, useRef, useState } from "react";
import { api, type ClaudeSigninView, type SigninView } from "../api";
import { TextField } from "./fields";

/**
 * A Claude sign-in for key `name`, step by step: get the link (Household boots a VM for Claude Code's own login),
 * then the code Claude's page shows. A sign-in left half-way is cancelled when the screen goes.
 */
export function useClaudeSignin(name: string) {
  const [signin, setSignin] = useState<ClaudeSigninView>();
  const [code, setCode] = useState("");
  const open = useRef<string | undefined>(undefined);
  useEffect(() => () => { if (open.current) void api.cancelClaudeSignin(open.current).catch(() => undefined); }, []);
  const start = async () => {
    const started = await api.startClaudeSignin(name);
    open.current = started.id;
    setSignin(started);
    setCode("");
  };
  const finish = async () => {
    if (!signin) throw new Error("Get the sign-in link first.");
    if (!code.trim()) throw new Error("Paste the code Claude's page shows.");
    try {
      return await api.finishClaudeSignin(signin.id, code.trim());
    } finally {
      // Claude takes a link once: whatever happened, the next try starts over.
      open.current = undefined;
      setSignin(undefined);
    }
  };
  const steps = signin && (
    <>
      <ol className="signin-steps">
        <li>
          <a className="text-link" href={signin.url} target="_blank" rel="noreferrer">Open Claude's sign-in page</a> on any device, your phone too, and sign in to the account your bots should use.
        </li>
        <li>Paste the code it shows you.</li>
      </ol>
      <TextField label="Code" mono value={code} onChange={setCode} placeholder="AbC123…#xYz789…" hint="The link works once, for 10 minutes." />
    </>
  );
  return { signin, steps, start, finish };
}

/** Whose a sign-in is: «igor@… · Zendrop · team». */
export function signinAccount(signin: SigninView): string {
  return [signin.email, signin.orgName, signin.subscriptionType].filter(Boolean).join(" · ") || "Claude account";
}

const DAY = 86_400_000;

/** A sign-in's line in the key list: renewed when, ends when (a warning in its last five days, an error once over). */
export function SigninLine({ signin, now = Date.now() }: { signin: SigninView; now?: number }) {
  const ends = signin.endsAt;
  const left = ends === null ? undefined : ends - now;
  const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (left !== undefined && left <= 0) return <span className="error">Sign-in ended {day(ends!)}: its bots get no answers. Sign in again.</span>;
  const renewed = signin.renewedAt ? `renewed ${ago(now - signin.renewedAt)}` : "kept fresh by Household";
  return (
    <span className={left !== undefined && left < 5 * DAY ? "warning" : "hint"}>
      {renewed}{ends !== null && ` · sign in again by ${day(ends)}`}
    </span>
  );
}

function ago(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (ms < DAY) return `${Math.round(ms / (60 * 60_000))}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

