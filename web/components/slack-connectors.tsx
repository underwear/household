import { CONNECTOR_ACCESS_OPTIONS, connectorAccessWords, connectorWritePolicy, type ConnectorWritePolicy } from "../../src/core/connector-write-policy";
import { useEffect, useState } from "react";
import { api, type SlackConnectionView, type WorkspaceView } from "../api";
import { SLACK_READ_SCOPES, SLACK_WRITE_SCOPES } from "../../src/core/slack-connectors";
import { Dialog } from "./dialog";
import { ChoiceList, FormGroup, SwitchList, TextField } from "./fields";

/** A workspace's Slack connections, loaded apart from Google's (either may fail alone), and how to reload them. */
export function useSlackConnections(house: string) {
  const [connections, setConnections] = useState<SlackConnectionView[]>();
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      setConnections((await api.slackConnections(house)).connections);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setConnections(undefined);
    void refresh();
  }, [house]);
  return { connections, error, refresh };
}

/** «read only», «read and write». */
export const slackAccessWords = (c: Pick<SlackConnectionView, "allowWrite" | "writePolicy">) => connectorAccessWords(c.allowWrite ? connectorWritePolicy(c.writePolicy, true) : "disabled");

/** How far bots may go with a Slack user: read what it can, or post as it too. */
const ACCESS = CONNECTOR_ACCESS_OPTIONS;

/** Where Slack sends the owner back: a static page that shows the result to paste (no server of ours sees the tokens). */
const CALLBACK = "https://agents-household.dev/slack/callback/";
const PRIVACY = "https://agents-household.dev/privacy/";
const STEPS = ["Access", "Sign in"] as const;

/** Why a pasted connection result is not one (before the daemon checks its state); undefined when it looks right. */
export function resultProblem(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    const url = new URL(text.trim());
    if (`${url.origin}${url.pathname}` !== CALLBACK || !url.searchParams.get("code") || !url.searchParams.get("state")) return "Paste the whole result from the Household page, starting with https://agents-household.dev/slack/callback/.";
    return undefined;
  } catch {
    return "Paste the whole result from the Household page, starting with https://agents-household.dev/slack/callback/.";
  }
}

type Options = { value: string; label: string }[];
const toggle = (values: string[], value: string) => (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);

/**
 * Connecting a Slack user, in steps: access and bots; then Slack's sign-in in another tab, whose result (shown on our
 * static callback page) the owner pastes back. Works when Household runs elsewhere, on a VPS. Instead of signing in,
 * an existing user token can be imported. Reconnecting starts with that connection's choices.
 */
export function SlackSetup({ house, existing, options, back, onClose, saved }: {
  house: string; existing?: SlackConnectionView; options: Options; /** Back to the choice of connector (a new one). */ back?: () => void;
  onClose: () => void; saved: () => Promise<void>;
}) {
  const [step, setStep] = useState<"access" | "sign-in" | "token">("access");
  const [access, setAccess] = useState<ConnectorWritePolicy>(connectorWritePolicy(existing?.writePolicy, existing?.allowWrite === true));
  const [pets, setPets] = useState(existing?.pets ?? []);
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [result, setResult] = useState("");
  const [token, setToken] = useState("");
  const problem = resultProblem(result);
  const tokenProblem = token.trim() && !/^xoxp-[A-Za-z0-9-]+$/.test(token.trim()) ? "A user token starts with xoxp-." : undefined;
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: existing ? `Reconnect ${existing.team}` : "Connect Slack",
        step: `slack-${step}`,
        confirmLabel: step === "access" ? "Continue to Slack" : "Connect",
        busyLabel: step === "access" ? "Preparing…" : "Connecting…",
        back: step !== "access" ? () => setStep("access") : back,
        onConfirm: async () => {
          if (step === "access") {
            const { url } = await api.authorizeSlack(house, pets, access !== "disabled", access);
            setAuthorizeUrl(url);
            setResult("");
            setStep("sign-in");
            return "stay";
          }
          if (step === "sign-in") {
            if (!result.trim()) throw new Error("Paste the connection result from the Household page.");
            if (problem) throw new Error(problem);
            await api.completeSlack(house, result.trim());
          } else {
            if (!token.trim() || tokenProblem) throw new Error("Paste a Slack user token (xoxp-…).");
            await api.connectSlack(house, token.trim(), pets, access !== "disabled", access);
          }
          await saved();
        },
        children: (
          <>
            {step !== "token" && (
              <ol className="steps" aria-label="Steps">
                {STEPS.map((label, index) => {
                  const at = step === "access" ? 0 : 1;
                  return (
                    <li key={label} className={index === at ? "current" : index < at ? "done" : undefined} aria-current={index === at ? "step" : undefined}>
                      {label}
                    </li>
                  );
                })}
              </ol>
            )}
            {step === "access" && (
              <>
                <p className="dialog-text">
                  {existing
                    ? "Sign in as this Slack user again. Your choices here replace its access."
                    : "Your bots search and read Slack as you, when they need context. This is not a chat channel: nobody messages your bots here."}
                </p>
                <ChoiceList label="Access" value={access} onChange={(value) => setAccess(value as ConnectorWritePolicy)} options={[...ACCESS]} />
                <FormGroup title="Bot access">
                  <SwitchList label="Bot access" options={options} on={pets} onToggle={(name) => setPets(toggle(pets, name))} />
                  <p className="hint">Optional: with none, the connection stays private until you grant access. Sideworkers get their parent’s; scouts never have any.</p>
                </FormGroup>
                <p className="hint">
                  Tokens stay on this host; what a bot reads goes to its AI provider and chat.{" "}
                  <a className="text-link" href={PRIVACY} target="_blank" rel="noreferrer">Privacy Policy ↗</a>
                  {" · "}
                  <button type="button" className="text-btn plain text-link" onClick={() => setStep("token")}>Use a user token instead</button>
                </p>
              </>
            )}
            {step === "sign-in" && (
              <>
                <ol className="setup-steps">
                  <li>
                    <span>Approve access in Slack, as the user your bots will read as.</span>
                    <a className="btn small" href={authorizeUrl} target="_blank" rel="noreferrer">Open Slack ↗</a>
                  </li>
                  <li><span>Slack sends you to a Household page. Copy the connection result there.</span></li>
                  <li><span>Paste it here, within ten minutes.</span></li>
                </ol>
                <TextField label="Connection result" mono value={result} onChange={setResult} placeholder={`${CALLBACK}?code=…`} error={problem}
                  hint="It holds a one-time code, useless without the key this host kept. Household exchanges it with Slack itself, so this works on a VPS too." />
              </>
            )}
            {step === "token" && (
              <>
                <p className="dialog-text">Import a user token of your own Slack app instead of signing in through ours. Access and bots are as you chose.</p>
                <TextField label="User OAuth token" type="password" mono value={token} onChange={setToken} placeholder="xoxp-…" error={tokenProblem} hint="Stored on this host, never given to your bots." />
                <details className="field-help">
                  <summary>Get a user token</summary>
                  <ol>
                    <li>Open <a className="text-link" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Slack apps ↗</a> and pick your app in the workspace to read.</li>
                    <li>Under OAuth &amp; Permissions → User Token Scopes, add the scopes below. Leave Bot Token Scopes empty.</li>
                    <li>Install the app, approve it as your Slack user, and copy the User OAuth Token. Keep token rotation off.</li>
                  </ol>
                  <p className="hint mono">{[...SLACK_READ_SCOPES, ...(access !== "disabled" ? SLACK_WRITE_SCOPES : [])].join(" ")}</p>
                </details>
              </>
            )}
          </>
        ),
      }}
    />
  );
}
