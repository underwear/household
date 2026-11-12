import { useEffect, useRef, useState } from "react";
import { api, type MicrosoftAuthorizationView, type MicrosoftConnectionView, type MicrosoftConnectorsView } from "../api";
import { Dialog } from "./dialog";
import { ChoiceList, FormGroup, SwitchList } from "./fields";

export const microsoftAccessWords = (c: Pick<MicrosoftConnectionView, "writable">) => c.writable ? "read and write" : "read only";
export function useMicrosoftConnections(house: string) {
  const [view, setView] = useState<MicrosoftConnectorsView>();
  const [error, setError] = useState("");
  const refresh = async () => { try { setView(await api.microsoftConnections(house)); setError(""); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { setView(undefined); void refresh(); }, [house]);
  return { ...view, error, refresh };
}

/** Device-code enrollment: only the user code reaches the browser; the host polls and holds the secret device code. */
export function MicrosoftSetup({ house, ready, existing, options, onClose, saved, back }: {
  house: string; ready: boolean; existing?: MicrosoftConnectionView;
  options: { value: string; label: string }[]; onClose: () => void; saved: () => Promise<void>; back?: () => void;
}) {
  const [pets, setPets] = useState(existing?.pets ?? []);
  const [access, setAccess] = useState<"read" | "write">(existing?.writable ? "write" : "read");
  const [authorization, setAuthorization] = useState<MicrosoftAuthorizationView>();
  const [error, setError] = useState("");
  const current = useRef<MicrosoftAuthorizationView | undefined>(undefined);
  const mounted = useRef(true);
  const callbacks = useRef({ saved, onClose }); callbacks.current = { saved, onClose };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; const id = current.current?.id; current.current = undefined; if (id) void api.cancelMicrosoft(house, id).catch(() => {}); };
  }, [house]);
  useEffect(() => {
    if (!authorization) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() >= Date.parse(authorization.expiresAt)) { setError("Microsoft sign-in expired. Start again."); return; }
      let result;
      try { result = await api.pollMicrosoft(house, authorization.id); }
      catch (e) { if (!stopped) setError((e as Error).message); return; }
      if (stopped) return;
      if (result.status === "connected") {
        current.current = undefined;
        try { await callbacks.current.saved(); }
        finally { if (!stopped) callbacks.current.onClose(); }
      } else timer = setTimeout(() => void poll(), Math.max(1, result.interval) * 1000);
    };
    timer = setTimeout(() => void poll(), authorization.interval * 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [authorization, house]);
  const reset = () => {
    const id = current.current?.id; current.current = undefined;
    setAuthorization(undefined); setError("");
    if (id) void api.cancelMicrosoft(house, id).catch(() => {});
  };
  return <Dialog onClose={onClose} spec={{
    title: existing ? `Reconnect ${existing.account}` : "Connect Microsoft To Do",
    step: authorization ? "microsoft-code" : "microsoft-access",
    confirmLabel: authorization ? "Start again" : "Prepare Microsoft sign-in",
    busyLabel: "Preparing sign-in…", back: authorization ? reset : back,
    onConfirm: async () => {
      if (authorization) { reset(); return "stay"; }
      if (!ready) throw new Error("Microsoft isn't set up on this host. Use an official release or configure its OAuth client ID.");
      const result = await api.authorizeMicrosoft(house, pets, access === "write");
      if (!mounted.current) { void api.cancelMicrosoft(house, result.id).catch(() => {}); return "stay"; }
      current.current = result; setAuthorization(result); setError(""); return "stay";
    },
    children: authorization ? <>
      <p className="dialog-text">Open Microsoft, enter this code and approve access. You can use a browser on another device. Keep this dialog open; it connects automatically after approval.</p>
      <FormGroup title="Your sign-in code"><p className="microsoft-signin-code">{authorization.userCode}</p>
        <button type="button" className="text-btn plain" onClick={() => void navigator.clipboard.writeText(authorization.userCode).catch(() => setError("Select the code and copy it manually."))}>Copy code</button>
      </FormGroup>
      <a className="btn primary" href={authorization.verificationUri} target="_blank" rel="noreferrer">Open Microsoft ↗</a>
      <p className="hint">Expires at {new Date(authorization.expiresAt).toLocaleTimeString()}. Only enter a code you just requested here.</p>
      {error ? <p className="error" role="alert">{error}</p> : <p className="hint" role="status">Waiting for Microsoft approval…</p>}
    </> : <>
      <p className="dialog-text">{existing ? "Sign in to this account again. These choices replace its bot access and permissions." : "Connect your Microsoft To Do lists, tasks and checklists. Each account has its own bot access."}</p>
      {!ready && <p className="error" role="alert">Microsoft isn't set up on this host.</p>}
      <ChoiceList label="Access" value={access} onChange={v => setAccess(v as "read" | "write")} options={[
        { value: "read", label: "Read only", description: "Bots can read your lists, tasks and checklists." },
        { value: "write", label: "Read and write", description: "Bots can also create, edit, complete and delete lists and tasks, as you." },
      ]} />
      <FormGroup title="Bot access"><SwitchList label="Bot access" options={options} on={pets} onToggle={id => setPets(values => values.includes(id) ? values.filter(v => v !== id) : [...values, id])} />
        <p className="hint">Optional: with none, the account stays private until you grant access.</p>
      </FormGroup>
      <p className="hint">Tokens stay on this host; what a bot reads goes to its AI provider and chat. Work accounts may require administrator approval.</p>
    </>,
  }} />;
}
