import { useEffect, useRef, useState } from "react";
import { api, type ClaudeSigninProgressView, type ClaudeSigninView, type SigninView } from "../api";
import { TextField } from "./fields";

/** What a sign-in's start is doing, in words: the first one downloads the VM's image, which takes minutes. */
export function signinPhaseText(progress: NonNullable<ClaudeSigninProgressView["progress"]>, now = Date.now()): string {
  const elapsed = Math.max(0, Math.round((now - progress.since) / 1000));
  const took = elapsed >= 5 ? ` (${elapsed >= 60 ? `${Math.floor(elapsed / 60)} min ${elapsed % 60} s` : `${elapsed} s`})` : "";
  switch (progress.phase) {
    case "image": return `Downloading the sign-in VM's image, about 1.4 GB: only the first time, it can take several minutes${took}.`;
    case "booting": return `Booting the sign-in VM${took}…`;
    case "login": return `Starting Claude Code's sign-in${took}…`;
  }
}

/**
 * A Claude sign-in for key `name`, step by step: get the link (Household boots a VM for Claude Code's own login),
 * then the code Claude's page shows. While the VM comes up, `status` says what it is doing. A sign-in left half-way
 * is cancelled when the screen goes, its VM too if it is still coming up.
 */
export function useClaudeSignin(name: string) {
  const [signin, setSignin] = useState<ClaudeSigninView>();
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<ClaudeSigninProgressView["progress"]>(null);
  const open = useRef<string | undefined>(undefined);
  const pendingName = useRef<string | undefined>(undefined);
  useEffect(() => () => {
    if (open.current) void api.cancelClaudeSignin(open.current).catch(() => undefined);
    else if (pendingName.current) void api.cancelClaudeSigninOf(pendingName.current).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!starting) return;
    let stopped = false;
    const poll = () => void api.claudeSigninProgress(name).then((state) => { if (!stopped) setProgress(state.progress); }, () => undefined);
    poll();
    const timer = setInterval(poll, 1500); // each answer is new: the elapsed time moves with it
    return () => { stopped = true; clearInterval(timer); setProgress(null); };
  }, [starting, name]);
  const start = async () => {
    setStarting(true);
    pendingName.current = name;
    try {
      const started = await api.startClaudeSignin(name);
      open.current = started.id;
      setSignin(started);
      setCode("");
    } finally {
      pendingName.current = undefined;
      setStarting(false);
    }
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
  const status = starting && (
    <p className="hint busy" role="status" aria-live="polite">{progress ? signinPhaseText(progress) : "Starting Claude's sign-in…"}</p>
  );
  return { signin, steps, status, start, finish };
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

