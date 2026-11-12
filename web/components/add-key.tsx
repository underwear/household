import { useState } from "react";
import { KEY_METHODS, PROVIDERS, type KeyMethod, type Provider } from "../../src/core/onboarding";
import { api, type KeyView, type MeView } from "../api";
import { signinAccount } from "./claude-signin";
import { Dialog } from "./dialog";
import { ChoiceList, TextField } from "./fields";
import { useKeyConnect } from "./key-connect";
import { written } from "./section";

const freeName = (taken: string[], base: string) => {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
};

/** The sign-in a signed-in key is made by again: Claude's or ChatGPT's. */
const signinMethod = (provider: string) => KEY_METHODS.find((method) => method.provider === provider && method.input.kind !== "paste")!;

/**
 * Keys · Add key, the way the guided setup asks: the provider, then how to sign in (the recommended way first, each
 * with what it means), then what that takes. `again`: a signed-in key signed in anew, straight to its sign-in.
 */
export function AddKeyDialog({ keys, providers, again, onClose, onDone }: {
  keys: KeyView[];
  providers: MeView["providers"];
  again?: KeyView;
  onClose: () => void;
  /** The key is saved (`name`): what to tell. */
  onDone: (name: string, warning?: string) => Promise<void>;
}) {
  const offered = PROVIDERS.filter((each) => providers.includes(each.id));
  const [step, setStep] = useState<"provider" | "method" | "connect">(again ? "connect" : offered.length === 1 ? "method" : "provider");
  const [provider, setProvider] = useState<Provider>((again?.provider as Provider | undefined) ?? offered[0]?.id ?? "anthropic");
  const methods = KEY_METHODS.filter((method) => method.provider === provider);
  const [methodId, setMethodId] = useState<string>();
  const method: KeyMethod = again ? signinMethod(again.provider) : methods.find((each) => each.id === methodId) ?? methods[0]!;
  const [name, setName] = useState(() => again?.name ?? freeName(keys.map((key) => key.name), method.name));
  const connect = useKeyConnect(method, name.trim(), () => void onDone(name.trim()));
  const taken = !again && keys.some((key) => key.name === name.trim());

  if (step === "provider") {
    return (
      <Dialog onClose={onClose} spec={{
        title: "Add key", step, confirmLabel: "Next",
        onConfirm: async () => { setMethodId(undefined); setStep("method"); return "stay"; },
        children: <ChoiceList label="Provider" value={provider} onChange={(chosen) => setProvider(chosen as Provider)}
          options={offered.map((each) => ({ value: each.id, label: each.label, description: each.description }))} />,
      }} />
    );
  }
  if (step === "method") {
    return (
      <Dialog onClose={onClose} spec={{
        title: `How will ${provider === "openai" ? "Codex" : "Claude Code"} sign in?`, step, confirmLabel: "Next",
        back: offered.length > 1 ? () => setStep("provider") : undefined,
        onConfirm: async () => { setName(freeName(keys.map((key) => key.name), method.name)); setStep("connect"); return "stay"; },
        children: <ChoiceList label="Sign-in" value={method.id} onChange={setMethodId} options={methods.map((each) => ({
          value: each.id,
          label: <span className="setup-option">{each.label}{each.recommended && <span className="soon">Recommended</span>}</span>,
          description: each.description,
        }))} />,
      }} />
    );
  }
  return (
    <Dialog onClose={onClose} spec={{
      title: again ? `Sign in again: ${again.name}` : method.label,
      step: connect.waiting ? "waiting" : connect.started ? "code" : "connect",
      wide: true,
      back: again || connect.started ? undefined : () => setStep("method"),
      confirmLabel: connect.waiting ? "Waiting for ChatGPT…" : connect.label,
      busyLabel: connect.busyLabel,
      onConfirm: async () => {
        if (connect.waiting) return "stay"; // ChatGPT's page finishes it
        if (taken) throw new Error(`Key ${name.trim()} exists already.`);
        if (connect.empty) throw new Error("Paste it first.");
        const result = await connect.submit();
        if (result === "stay") return "stay";
        if (result === "signed-in") return onDone(name.trim());
        const warning = await written(api.addKey(name.trim(), { provider: method.provider, value: result.pasted, note: method.label, houses: null, allowOverage: false }));
        return onDone(name.trim(), warning);
      },
      children: (
        <>
          {!again && !connect.started && (
            <TextField label="Key name" mono value={name} onChange={setName} placeholder={method.name}
              error={taken ? `${name.trim()} exists already.` : undefined} hint="Workspaces and overage: Edit, once it's added." />
          )}
          {again?.signin && <p className="hint">Now: {signinAccount(again.signin)}. Another account moves its bots there.</p>}
          {connect.body}
        </>
      ),
    }} />
  );
}
