import { useEffect, useState, type ReactNode } from "react";
import { guidePieces, type KeyMethod } from "../../src/core/onboarding";
import { api, type DeviceLoginView } from "../api";
import { useClaudeSignin } from "./claude-signin";
import { TextField } from "./fields";

/*
 * How a key gets in, the same in the guided setup and under Keys: the method's guide, then what it takes — a pasted
 * token, Claude's sign-in (a link, then the code it shows), or ChatGPT's (a link and a code to enter there).
 */

/** What to do, in order: the catalog's lines, their `code`, **bold** and links drawn. */
export function Guide({ steps }: { steps: string[] }) {
  const line = (text: string) => guidePieces(text).map((piece, index) =>
    piece.kind === "code" ? <code key={index}>{piece.text}</code>
    : piece.kind === "bold" ? <b key={index}>{piece.text}</b>
    : piece.kind === "link" ? <a key={index} className="text-link" href={piece.href} target="_blank" rel="noreferrer">{piece.text}</a>
    : piece.text);
  return <ol className="setup-steps">{steps.map((step, index) => <li key={index}><span>{line(step)}</span></li>)}</ol>;
}

/** What the primary action did: a token to save, a sign-in done (its key saved by Household), or a next step shown. */
export type ConnectResult = { pasted: string } | "signed-in" | "stay";

/**
 * Key `name` by `method`, step by step. `body` is what to show, `label` the primary button's words; `submit` does the
 * step. A ChatGPT sign-in ends on its own (asked about every two seconds): `onSignedIn` then, or `error` says why not.
 * Leaving cancels a sign-in still under way.
 */
export function useKeyConnect(method: KeyMethod, name: string, onSignedIn: () => void) {
  const [value, setValue] = useState("");
  const [login, setLogin] = useState<DeviceLoginView>();
  const [error, setError] = useState<string>();
  const claude = useClaudeSignin(name);
  const { input } = method;

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let over = false;
    const end = () => { over = true; clearInterval(timer); setLogin(undefined); };
    const timer = setInterval(() => {
      void api.chatgptLogin(login.id).then((state) => {
        if (stopped || state.status === "waiting") return;
        end();
        if (state.status === "failed") setError(state.error);
        else onSignedIn();
      }, (failure) => {
        if (stopped || !(failure instanceof Error) || !failure.message.startsWith("no such")) return;
        end();
        setError(failure.message);
      });
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (!over) void api.cancelChatgptLogin(login.id).catch(() => undefined);
    };
  }, [login]); // eslint-disable-line react-hooks/exhaustive-deps -- one poll per sign-in

  const submit = async (): Promise<ConnectResult> => {
    setError(undefined);
    if (input.kind === "claude-signin") {
      if (!claude.signin) { await claude.start(); return "stay"; }
      await claude.finish();
      return "signed-in";
    }
    if (input.kind === "device") { setLogin(await api.startChatgptLogin(name)); return "stay"; }
    const token = value.trim();
    if (!token.startsWith(input.prefix)) throw new Error(input.wrong);
    return { pasted: token };
  };

  const label = input.kind === "device" ? "Sign in with ChatGPT" : input.kind === "claude-signin" ? (claude.signin ? "Connect" : "Get sign-in link") : "Add key";
  const busyLabel = input.kind === "claude-signin" && !claude.signin ? "Starting Claude's sign-in…" : input.kind === "device" ? "Starting the sign-in…" : "Connecting…";
  const body: ReactNode = (
    <>
      {input.kind === "claude-signin" && claude.steps ? claude.steps : <Guide steps={method.steps} />}
      {input.kind === "paste" && <TextField label={input.label} type="password" mono value={value} onChange={setValue} placeholder={input.placeholder} />}
      {login && (
        <div className="setup-code">
          <span>Open <a className="text-link" href={login.url} target="_blank" rel="noreferrer">{login.url}</a> and enter</span>
          <code className="setup-code-value">{login.code}</code>
          <span className="hint">Waiting for you to finish…</span>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
  return {
    body, label, busyLabel, submit,
    /** A step under way that the primary button cannot finish (ChatGPT's page does): offer Cancel instead. */
    waiting: !!login,
    cancel: () => setLogin(undefined),
    /** Started: the key's name is fixed now. */
    started: !!login || !!claude.signin,
    empty: input.kind === "paste" && !value.trim(),
  };
}
