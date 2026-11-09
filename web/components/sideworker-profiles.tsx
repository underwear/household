import { useState } from "react";
import { NAME_PATTERN } from "../../src/core/names";
import type { SideworkerProfile } from "../../src/core/household";
import { api, type HarnessView, type WorkspaceView, type KeyView } from "../api";
import { Dialog, useDialog } from "./dialog";
import { TextField } from "./fields";
import { keysFor, modeLabel, useHarnessForm } from "./bots";
import { ListSection, written } from "./section";

/** What a bot may start a sideworker on: its own settings (always), or one of the workspace's profiles the owner added. */
export function SideworkerProfiles({ house, agents, keys, refresh, notify }: {
  house: WorkspaceView; agents: HarnessView[]; keys: KeyView[]; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void;
}) {
  const profiles = house.sideworkerProfiles ?? [];
  const [editing, setEditing] = useState<SideworkerProfile | "new">();
  const dialog = useDialog();
  const save = async (next: SideworkerProfile[]) => {
    const warning = await written(api.setSideworkerProfiles(house.name, next));
    await refresh();
    notify(warning ?? "Sideworker profiles saved", warning !== undefined);
  };
  return <>
    <ListSection
      title="Profiles"
      width="narrow"
      hint="A sideworker runs on its bot's own harness and model, unless the bot asks for one of these."
      actions={<button type="button" className="btn small" onClick={() => setEditing("new")}>+ Add profile</button>}
      empty="None yet: every sideworker runs on its bot's settings."
      items={[
        ...profiles.map((profile) => ({
          key: profile.name,
          label: profile.name,
          sub: `${profile.agent} · ${profile.model ?? "default model"} · key ${profile.key}`,
          note: `${profile.reasoningEffort ? `Reasoning ${profile.reasoningEffort}` : "Default reasoning"} · ${profile.mode ? modeLabel(agents, profile.agent, profile.mode) : "default permissions"}`,
        })),
      ]}
      onEdit={name => setEditing(profiles.find(profile => profile.name === name))}
      onRemove={name => dialog.open({ title: `Remove profile ${name}?`, body: "Running sideworkers keep it.", confirmLabel: "Remove profile", danger: true, onConfirm: () => save(profiles.filter(profile => profile.name !== name)) })}
    />
    {editing && <SideworkerProfileDialog profile={editing === "new" ? undefined : editing} agents={agents} keys={keysFor(keys, house.name)} taken={profiles.map(profile => profile.name)} onClose={() => setEditing(undefined)} save={profile => save(editing === "new" ? [...profiles, profile] : profiles.map(current => current.name === editing.name ? profile : current))} />}
    {dialog.element}
  </>;
}

export function SideworkerProfileDialog({ profile, agents, keys, taken, onClose, save }: {
  profile?: SideworkerProfile; agents: HarnessView[]; keys: KeyView[]; taken: string[]; onClose: () => void; save: (profile: SideworkerProfile) => Promise<void>;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const adapter = agents.find(agent => agent.name === profile?.agent);
  const form = useHarnessForm(agents, keys, profile ? {
    agent: profile.agent, key: profile.key, model: profile.model ?? adapter?.defaultModel ?? "",
    mode: profile.mode ?? adapter?.defaultMode ?? null, reasoningEffort: profile.reasoningEffort ?? null,
  } : undefined);
  const trimmed = name.trim();
  const nameError = trimmed && !NAME_PATTERN.test(trimmed) ? "Lowercase letters, digits and hyphens; start with a letter, up to 31 characters."
    : trimmed !== profile?.name && taken.includes(trimmed) ? "A profile already uses this name." : undefined;
  return <Dialog onClose={onClose} spec={{
    title: profile ? `Edit ${profile.name}` : "New sideworker profile",
    confirmLabel: profile ? "Save profile" : "Add profile",
    onConfirm: async () => {
      if (!trimmed) throw new Error("Name the profile.");
      if (nameError) throw new Error(nameError);
      if (form.error) throw new Error(form.error);
      const { agent, key, model, mode, reasoningEffort } = form.value;
      await save({ name: trimmed, agent: agent!, key: key!, ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
    },
    children: <><TextField label="Profile name" value={name} onChange={setName} maxLength={31} mono placeholder="code-review" hint="What a bot asks for." error={nameError} />{form.fields}</>,
  }} />;
}
