import { useState } from "react";
import { Check } from "lucide-react";
import { api, type ChannelFields, type ChannelKindView, type ChannelView, type WorkspaceView } from "../api";
import { Dialog } from "./dialog";
import { CheckList, SelectField, TextField } from "./fields";
import { channelLabel } from "./workspaces";

const STEPS = ["App", "Your account", "Bots"] as const;
const APPS = "https://api.slack.com/apps";
const GUIDE = "https://agents-household.dev/docs/channels/#slack";

/** A Slack bot DM's page in Slack's web client, from its `workspace:DM` chat. */
export const slackUrl = (chat: string) => `https://app.slack.com/client/${chat.replace(":", "/")}`;

/**
 * A Slack Bot DM's form. A new one in three steps: the app's two tokens, the owner's member ID (the admin finds the
 * bot DM from it), then its name and bots. Editing is one form, as every other channel's: tokens, its DM (read
 * only, with a way to it), name, bots and default, note.
 */
export function SlackSetup({ house, spec, channel, onClose, back, save }: {
  house: WorkspaceView; spec: ChannelKindView; channel?: ChannelView; onClose: () => void;
  back: () => void; save: (kind: string, fields: ChannelFields) => Promise<void>;
}) {
  const [step, setStep] = useState(channel ? 2 : 0);
  const [token, setToken] = useState(channel?.fields.token ?? "");
  const [appToken, setAppToken] = useState(channel?.fields.appToken ?? "");
  const [member, setMember] = useState("");
  const [destination, setDestination] = useState<{ chat: string; owner: string; url: string }>();
  const [pets, setBots] = useState(channel?.pets ?? []);
  const [first, setFirst] = useState(channel?.default ?? "");
  const [name, setName] = useState(channel?.ownName ?? "Slack");
  const [note, setNote] = useState(channel?.note ?? "");
  const available = house.pets.filter((pet) => !pet.sideworker);
  const chosen = available.filter((pet) => pets.includes(pet.name));
  const chat = channel?.chat ?? destination?.chat;
  const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-link">
      {text} ↗
    </a>
  );
  const tokens = (
    <>
      <TextField label="Bot token" type="password" mono placeholder="xoxb-…" value={token} onChange={setToken} hint="OAuth & Permissions → Bot User OAuth Token." />
      <TextField label="Socket Mode app token" type="password" mono placeholder="xapp-…" value={appToken} onChange={setAppToken} hint="Basic Information → App-Level Tokens, with connections:write." />
    </>
  );
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: channel ? `Edit ${channelLabel(channel)}` : "Connect Slack",
        step: `slack-${step}`,
        confirmLabel: step === 0 ? "Next" : step === 1 ? "Find my bot DM" : channel ? "Save" : "Connect Slack",
        busyLabel: step === 1 ? "Finding your DM…" : "Saving…",
        back: channel ? undefined : () => (step === 0 ? back() : setStep(step - 1)),
        onConfirm: async () => {
          if (step === 0) {
            if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(token.trim())) throw new Error("Paste the Bot User OAuth Token (xoxb-…).");
            if (!/^xapp-[A-Za-z0-9-]{20,}$/.test(appToken.trim())) throw new Error("Paste the app-level token (xapp-…).");
            setDestination(undefined);
            setStep(1);
            return "stay";
          }
          if (step === 1) {
            setDestination(await api.resolveSlack(house.name, token.trim(), appToken.trim(), member.trim()));
            setStep(2);
            return "stay";
          }
          if (pets.length > 1 && !pets.includes(first)) throw new Error("Choose the default bot: it replies in Messages.");
          await save(spec.kind, {
            ...(channel ? {} : { chat: destination!.chat, slackMember: member.trim() }),
            own: { token: token.trim(), appToken: appToken.trim() },
            name: name.trim() || null,
            note: note.trim() || null,
            pets,
            default: pets.length > 1 ? first : null,
          });
        },
        children: (
          <>
            {!channel && (
              <ol className="steps" aria-label="Steps">
                {STEPS.map((label, index) => (
                  <li key={label} className={index === step ? "current" : index < step ? "done" : undefined} aria-current={index === step ? "step" : undefined}>
                    {label}
                  </li>
                ))}
              </ol>
            )}
            {step === 0 && (
              <>
                <p className="dialog-text">Paste the two tokens of your installed Slack app, from its {link(APPS, "settings")}. They stay on this host; bots never get them.</p>
                {tokens}
                <p className="hint">No app yet? Create one from the Household manifest and install it in your workspace: {link(GUIDE, "installation guide")}.</p>
              </>
            )}
            {step === 1 && (
              <>
                <p className="dialog-text">The Slack account you talk to your bots from. Its DM with the bot is found for you; nothing is sent.</p>
                <TextField label="Your member ID" mono placeholder="U0123456789" value={member} onChange={setMember} hint="In Slack: your profile → More (⋯) → Copy member ID." />
                <p className="hint danger">This account becomes an owner of {house.name}: it can command its bots and approve their requests.</p>
              </>
            )}
            {step === 2 && (
              <>
                {destination && (
                  <p className="check-note" role="status">
                    <Check size={14} strokeWidth={2} aria-hidden />
                    <span>
                      Found your bot DM. Account <span className="mono">{destination.owner}</span> becomes an owner when you connect. {link(destination.url, "Open in Slack")}
                    </span>
                  </p>
                )}
                {channel && (
                  <>
                    {tokens}
                    <TextField label={spec.chat.label} mono readOnly value={chat ?? ""} onChange={() => {}} hint={<>Your DM with the bot. {link(slackUrl(channel.chat), "Open in Slack")}</>} />
                  </>
                )}
                <TextField label="Name" value={name} onChange={setName} placeholder={spec.label} />
                <CheckList
                  label="Bots"
                  options={available.map((pet) => ({
                    value: pet.name,
                    label: (
                      <>
                        {pet.display} <span className="id">{pet.name}</span>
                      </>
                    ),
                  }))}
                  checked={pets}
                  onToggle={(pet) => setBots(pets.includes(pet) ? pets.filter((other) => other !== pet) : [...pets, pet])}
                  empty="The workspace has no bots yet: add them to this channel later."
                />
                {chosen.length > 1 && (
                  <SelectField
                    label="Default"
                    hint="It replies in Messages. Others answer by alias, in threads."
                    value={pets.includes(first) ? first : ""}
                    onChange={setFirst}
                    options={[{ value: "", label: "Who replies in Messages…", disabled: true }, ...chosen.map((pet) => ({ value: pet.name, label: pet.display }))]}
                  />
                )}
                <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} placeholder="work Slack" />
              </>
            )}
          </>
        ),
      }}
    />
  );
}
