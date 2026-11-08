import { useState } from "react";
import { api, type ChannelFields, type ChannelKindView, type ChannelView, type HouseView } from "../api";
import { Dialog } from "./dialog";
import { CheckList, SelectField, TextField } from "./fields";

export function SlackSetup({ house, spec, channel, onClose, back, save }: {
  house: HouseView; spec: ChannelKindView; channel?: ChannelView; onClose: () => void;
  back: () => void; save: (kind: string, fields: ChannelFields) => Promise<void>;
}) {
  const [step, setStep] = useState(channel ? 2 : 0);
  const [token, setToken] = useState(channel?.fields.token ?? "");
  const [appToken, setAppToken] = useState(channel?.fields.appToken ?? "");
  const [member, setMember] = useState("");
  const [destination, setDestination] = useState<{ chat: string; owner: string; url: string }>();
  const [pets, setPets] = useState(channel?.pets ?? []);
  const [first, setFirst] = useState(channel?.default ?? "");
  const [name, setName] = useState(channel?.ownName ?? "Slack");
  const [note, setNote] = useState(channel?.note ?? "");
  const available = house.pets.filter(pet => !pet.sideworker);
  const tokens = <>
    <TextField label="Bot token" type="password" mono placeholder="xoxb-…" value={token} onChange={setToken}
      hint="OAuth & Permissions → Bot User OAuth Token." />
    <TextField label="App token" type="password" mono placeholder="xapp-…" value={appToken} onChange={setAppToken}
      hint="Basic Information → App-Level Tokens. Enable connections:write and Socket Mode." />
    <p className="hint">Tokens stay on this host. Pets and their VMs never receive them.</p>
  </>;
  const chat = channel?.chat ?? destination?.chat;
  const url = chat ? `https://app.slack.com/client/${chat.replace(":", "/")}` : undefined;
  return <Dialog onClose={onClose} spec={{
    title: channel ? "Slack connection" : "Connect Slack",
    step: `slack-${step}`,
    confirmLabel: step === 0 ? "Continue" : step === 1 ? "Find my bot DM" : channel ? "Save changes" : "Connect Slack",
    busyLabel: step === 1 ? "Finding your DM…" : "Saving…",
    back: channel ? undefined : () => step === 0 ? back() : setStep(step - 1),
    onConfirm: async () => {
      if (step === 0) {
        if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(token.trim())) throw new Error("Paste the Bot User OAuth Token (xoxb-…).");
        if (!/^xapp-[A-Za-z0-9-]{20,}$/.test(appToken.trim())) throw new Error("Paste the app-level token (xapp-…).");
        setDestination(undefined); setStep(1); return "stay";
      }
      if (step === 1) {
        setDestination(await api.resolveSlack(house.name, token.trim(), appToken.trim(), member.trim()));
        setStep(2); return "stay";
      }
      if (pets.length > 1 && !pets.includes(first)) throw new Error("Choose which pet replies in Messages.");
      await save(spec.kind, {
        ...(channel ? {} : { chat: destination!.chat, slackMember: member.trim() }),
        own: { token: token.trim(), appToken: appToken.trim() },
        name: name.trim() || null, note: note.trim() || null, pets,
        default: pets.length > 1 ? first : null,
      });
    },
    children: <>
      {!channel && <ol className="slack-steps" aria-label="Connection steps">
        {["App", "Your account", "Pets"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index < step ? "✓" : index + 1}</span>{label}</li>)}
      </ol>}
      {step === 0 && <>
        <p className="dialog-text">Connect your installed Slack app. Copy these two tokens from <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Slack app settings ↗</a>.</p>
        {tokens}
        <details><summary>Need to create an app first?</summary><p className="hint">Create an app using the Household manifest, install it in your workspace, then return with its tokens. <a href="https://github.com/underwear/household/blob/main/docs/slack.md#install" target="_blank" rel="noreferrer">Installation guide ↗</a></p></details>
      </>}
      {step === 1 && <>
        <p className="dialog-text">Choose the Slack account you’ll use to talk to your pets. We’ll find its private conversation with the bot automatically.</p>
        <TextField label="Your Slack member ID" mono placeholder="U0123456789" value={member} onChange={setMember}
          hint="In Slack: open your profile → More (⋯) → Copy member ID." />
        <p className="hint">Connecting grants this account owner access to this house: it can control pets and approve their requests. No message is sent during setup.</p>
      </>}
      {step === 2 && <>
        <div className="slack-destination">
          <strong>{channel ? "Connected to your bot DM" : "Your bot DM is ready"}</strong>
          <p className="hint">{channel ? "Messages go directly to the selected default pet." : `Owner account: ${destination?.owner}. Access is granted when you connect.`}</p>
          <a href={url} target="_blank" rel="noreferrer">Open in Slack ↗</a>
        </div>
        <CheckList label="Pets in this conversation" options={available.map(pet => ({ value: pet.name, label: pet.display }))}
          checked={pets} onToggle={pet => setPets(pets.includes(pet) ? pets.filter(name => name !== pet) : [...pets, pet])}
          empty="Create a pet in this house after connecting." />
        {pets.length > 1 && <SelectField label="Who replies in Messages?" value={pets.includes(first) ? first : ""} onChange={setFirst}
          options={[{ value: "", label: "Choose a default pet…", disabled: true }, ...available.filter(pet => pets.includes(pet.name)).map(pet => ({ value: pet.name, label: pet.display }))]} />}
        <p className="hint">{pets.length === 0 ? "You can add pets later by editing this connection." : "The default pet replies in the main conversation. Address another pet by its alias; helpers work in separate threads."}</p>
        <details><summary>Connection settings</summary><div className="slack-settings">
          <TextField label="Connection name" value={name} onChange={setName} />
          {channel && tokens}
          <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} />
          <p className="hint">Conversation address: <code>{chat}</code></p>
        </div></details>
      </>}
    </>,
  }} />;
}
