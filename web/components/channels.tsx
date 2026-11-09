import { SlackSetup, slackUrl } from "./slack-setup";
import { useState } from "react";
import { api, type ChannelFields, type ChannelKindView, type ChannelView, type WorkspaceView, type PlatformView } from "../api";
import { Dialog } from "./dialog";
import { CheckList, ChoiceList, SelectField, TextField } from "./fields";
import { channelLabel } from "./workspaces";
import { PlatformIcon } from "./icon";
import { Cell, FormGrid, List, ListRow, Page, Section } from "./layout";
import { OwnersSection } from "./owners";
import { RowActions, type SectionProps } from "./section";

export interface ChannelsPageProps extends SectionProps {
  /** The kinds of channel, with their own fields. */
  kinds: ChannelKindView[];
  /** Their platforms (where owners are; their icons). */
  platforms: PlatformView[];
  /** How long a note may be. */
  noteMax?: number;
}

/**
 * A workspace's Channels page: its channels (each with its bots and default, and why it is not open if it is not;
 * add, edit, remove), then its owners.
 */
export function ChannelsPage({ house, ask, save, kinds, platforms, noteMax }: ChannelsPageProps) {
  /** The channel being edited, or "new". */
  const [editing, setEditing] = useState<ChannelView | "new">();
  const petsByName = new Map(house.pets.map((pet) => [pet.name, pet]));
  const remove = (channel: ChannelView) =>
    ask({
      title: `Remove ${channelLabel(channel)}?`,
      body: `${house.name} leaves this chat.`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => save(api.removeChannel(house.name, channel.chat), `Channel ${channel.name} removed`),
    });
  // Owners on the platforms some kind of channel is on.
  const used = platforms.filter((platform) => kinds.some((kind) => kind.platform === platform.platform));
  return (
    <Page
      title="Channels"
      actions={
        <button className="btn primary" onClick={() => setEditing("new")}>
          + Add channel
        </button>
      }
    >
      <Section hint="Chats this workspace is in.">
        <List columns="minmax(0, 1fr) fit-content(50%) auto" empty="No channels.">
          {house.channels.map((channel) => (
            <ListRow key={channel.chat} actions={<RowActions onEdit={() => setEditing(channel)} onRemove={() => remove(channel)} />}>
              <Cell>
                <PlatformIcon platforms={platforms} platform={channel.platform} />
                <span className="cell-lines">
                  <span className="strong ellipsis">{channelLabel(channel)}</span>
                  <span className="id ellipsis">
                    {/* A field that says what it is (a token: its bot) shows that, not the value. */}
                    {[...Object.entries(channel.fields).map(([key, value]) => (key in channel.shown ? (channel.shown[key] ?? "") : value)).filter(Boolean), ...(channel.kind === "slack-private" ? [] : [`chat ${channel.chat}`])].join(" · ")}
                    {/* A Slack DM's id says nothing to a person: a way to it instead. */}
                    {channel.kind === "slack-private" && (
                      <>
                        {" · "}
                        <a href={slackUrl(channel.chat)} target="_blank" rel="noreferrer" className="text-link">
                          Open in Slack ↗
                        </a>
                      </>
                    )}
                  </span>
                  {channel.note && <span className="hint">{channel.note}</span>}
                  {channel.problem && <span className="error">{channel.problem}</span>}
                </span>
              </Cell>
              <Cell label="Bots" wrap>
                {channel.pets.length === 0 ? (
                  <span className="faint">No bots</span>
                ) : (
                  <span className="channel-bots" aria-label={`Bots: ${channel.pets.map((name) => petsByName.get(name)?.display ?? name).join(", ")}`}>
                    {channel.pets.map((name) => {
                      const pet = petsByName.get(name);
                      const isDefault = channel.default === name && channel.pets.length > 1;
                      return (
                        <span key={name} className={isDefault ? "chip default" : "chip"} title={isDefault ? "Gets unaddressed messages" : undefined}>
                          <span aria-hidden>{pet?.emoji ?? "🤖"}</span>
                          <span className="ellipsis">{pet?.title ?? name}</span>
                          {isDefault && <span className="chip-note">default</span>}
                        </span>
                      );
                    })}
                  </span>
                )}
              </Cell>
            </ListRow>
          ))}
        </List>
      </Section>
      <OwnersSection house={house} ask={ask} save={save} platforms={used} noteMax={noteMax} />
      {editing && (
        <ChannelDialog
          house={house}
          kinds={kinds}
          platforms={platforms}
          noteMax={noteMax}
          channel={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          save={(kind, fields) =>
            editing === "new" ? save(api.addChannel(house.name, kind, fields), "Channel added") : save(api.updateChannel(house.name, editing.chat, fields), "Channel saved")
          }
        />
      )}
    </Page>
  );
}

interface ChannelDialogProps {
  house: WorkspaceView;
  kinds: ChannelKindView[];
  /** The kinds' platforms (their icons). */
  platforms?: PlatformView[];
  noteMax?: number;
  /** The channel to edit; none: a new one. */
  channel?: ChannelView;
  /** A new one's kind, chosen already: it starts at the fields (Back still goes to the kinds). */
  kind?: string;
  onClose: () => void;
  save: (kind: string, fields: ChannelFields) => Promise<void>;
}

/**
 * A channel's form, in two steps: its kind (each with a line on it; shown even when there is one), then that
 * kind's own fields and its chat as the kind describes them, and what every channel has (name, bots, default);
 * Back and on to the same kind keeps what was typed. Editing starts at the second step, its kind fixed, its chat
 * read only: another chat is another channel. A wide field (a bot token) is on a row of its own; the others go two
 * to a row with the chat. The config's errors show in it.
 */
export function ChannelDialog({ house, kinds, platforms = [], noteMax, channel, kind: chosenKind, onClose, save }: ChannelDialogProps) {
  /** The kind chosen at the first step; undefined: at the first step. */
  const [kind, setKind] = useState(channel?.kind ?? chosenKind);
  const [choice, setChoice] = useState(channel?.kind ?? chosenKind ?? kinds[0]?.kind ?? "");
  const [own, setOwn] = useState<Record<string, string>>(channel?.fields ?? {});
  const [chat, setChat] = useState(channel?.chat ?? "");
  /** The kind the fields were typed for: going back and on to the same kind keeps them. */
  const [typedFor, setTypedFor] = useState(channel?.kind ?? chosenKind);
  const [name, setName] = useState(channel?.ownName ?? "");
  const [note, setNote] = useState(channel?.note ?? "");
  const [pets, setBots] = useState(channel?.pets ?? []);
  const [first, setFirst] = useState(channel?.default ?? "");
  const toggle = (pet: string) => setBots(pets.includes(pet) ? pets.filter((other) => other !== pet) : [...pets, pet]);
  // The channel's own order (who was there first), new ones at the end.
  const chosen = pets.flatMap((name) => house.pets.filter((pet) => pet.name === name));
  const spec = kinds.find((candidate) => candidate.kind === kind);

  if (!spec) {
    return (
      <Dialog
        onClose={onClose}
        spec={{
          title: "Add channel",
          step: "kind",
          confirmLabel: "Next",
          onConfirm: async () => {
            if (choice !== typedFor) {
              setOwn({});
              setChat("");
              setTypedFor(choice);
            }
            setKind(choice);
            return "stay";
          },
          children: (
            <ChoiceList
              label="Kind"
              value={choice}
              onChange={setChoice}
              options={kinds.map((each) => ({ value: each.kind, label: each.label, description: each.description, icon: <PlatformIcon platforms={platforms} platform={each.platform} small /> }))}
            />
          ),
        }}
      />
    );
  }
  if (spec.kind === "slack-private") return <SlackSetup house={house} spec={spec} channel={channel} onClose={onClose} back={() => setKind(undefined)} save={save} />;
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: channel ? `Edit ${channelLabel(channel)}` : `Add ${spec.label}`,
        step: "fields",
        confirmLabel: channel ? "Save" : "Add channel",
        ...(channel ? {} : { back: () => setKind(undefined) }),
        onConfirm: () =>
          save(spec.kind, {
            // Its chat goes only with a new one: it names the channel.
            ...(channel ? {} : { chat: chat.trim() }),
            own: Object.fromEntries(spec.fields.map((field) => [field.key, (own[field.key] ?? "").trim()])),
            name: name.trim() || null,
            note: note.trim() || null,
            pets: chosen.map((pet) => pet.name),
            // Only with two bots or more: one is the default anyway.
            default: chosen.length > 1 && pets.includes(first) ? first : null,
          }),
        children: (
          <>
            {spec.fields
              .filter((field) => field.wide)
              .map((field) => (
                <TextField
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  help={field.help}
                  mono={field.mono}
                  placeholder={field.placeholder}
                  value={own[field.key] ?? ""}
                  onChange={(value) => setOwn({ ...own, [field.key]: value })}
                />
              ))}
            {(() => {
              const chatField = <TextField label={spec.chat.label} hint={spec.chat.hint} help={spec.chat.help} mono={spec.chat.mono} placeholder={spec.chat.placeholder} readOnly={channel !== undefined} value={chat} onChange={setChat} />;
              const narrow = spec.fields.filter((field) => !field.wide);
              // Two to a row with the kind's other fields; alone, its own row.
              if (narrow.length === 0) return chatField;
              return (
                <FormGrid>
                  {narrow.map((field) => (
                    <TextField
                      key={field.key}
                      label={field.label}
                      hint={field.hint}
                      help={field.help}
                      mono={field.mono}
                      placeholder={field.placeholder}
                      value={own[field.key] ?? ""}
                      onChange={(value) => setOwn({ ...own, [field.key]: value })}
                    />
                  ))}
                  {chatField}
                </FormGrid>
              );
            })()}
            <TextField label="Name" value={name} onChange={setName} placeholder={spec.label} />
            <CheckList
              label="Bots"
              options={house.pets.filter(pet => !pet.sideworker).map((pet) => ({
                value: pet.name,
                label: (
                  <>
                    {pet.display} <span className="id">{pet.name}</span>
                  </>
                ),
              }))}
              checked={pets}
              onToggle={toggle}
              empty="The workspace has no bots yet."
            />
            {chosen.length > 1 && (
              <SelectField
                label="Default"
                value={pets.includes(first) ? first : ""}
                onChange={setFirst}
                options={[{ value: "", label: "Who gets unaddressed messages…", disabled: true }, ...chosen.map((pet) => ({ value: pet.name, label: pet.display }))]}
              />
            )}
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} placeholder="test bot, delete later" maxLength={noteMax} />
          </>
        ),
      }}
    />
  );
}
