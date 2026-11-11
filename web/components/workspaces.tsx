import { useState } from "react";
import { api, type ChannelView, type WorkspaceView, type PlatformView } from "../api";
import { workspacePath } from "../router";
import { Dialog } from "./dialog";
import { TextField } from "./fields";
import { Cell, Chip, Cluster, List, ListRow, Page, Stack } from "./layout";
import { PlatformIcon } from "./icon";
import { ownBots, petState } from "./bot-state";
import { Link } from "./link";
import { written } from "./section";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A channel in a word or two: its own name if it has one, then its kind's label. */
export const channelLabel = (channel: ChannelView) => (channel.ownName ? `${channel.name} · ${channel.label}` : channel.label);

/** Every host the workspace reaches, saying how many come with its bots' harnesses. */
function allowSummary(house: WorkspaceView): string {
  const byAgent = house.allow.filter((entry) => entry.byAgent).length;
  return plural(house.allow.length, "host") + (byAgent ? ` (${byAgent} by harness)` : "");
}

/** Household · Workspaces: every workspace, with its bots, allowlist and channels at a glance. */
export function WorkspacesPage({ houses, platforms, onNewWorkspace }: { houses: WorkspaceView[]; platforms: PlatformView[]; onNewWorkspace: () => void }) {
  return (
    <Page
      title="Workspaces"
      actions={
        <Cluster gap={2}>
          <Link href="/setup" className="btn primary">
            Guided setup
          </Link>
          <button className="btn" onClick={onNewWorkspace}>
            + New workspace
          </button>
        </Cluster>
      }
    >
      <WorkspacesTable houses={houses} platforms={platforms} />
    </Page>
  );
}

export function WorkspacesTable({ houses, platforms }: { houses: WorkspaceView[]; platforms: PlatformView[] }) {
  return (
    <List columns="minmax(0, 1fr) auto minmax(0, 1fr) auto" head={["Workspace", "Allowlist", "Channels", ""]} empty="No workspaces yet.">
      {houses.map((house) => (
        <ListRow
          key={house.name}
          actions={
            <Link href={workspacePath(house.name)} className="btn small">
              Open
            </Link>
          }
        >
          <Cell>
            <Stack gap={2}>
              <span className="strong ellipsis">{house.name}</span>
              {ownBots(house.pets).length === 0 ? (
                <span className="hint">
                  no bots · <Link href={`/setup?workspace=${encodeURIComponent(house.name)}`} className="text-link">set up</Link>
                </span>
              ) : (
                <Cluster gap={2}>
                {ownBots(house.pets).map((pet) => {
                  const state = petState(pet.state);
                  return (
                    <Chip key={pet.name} title={`${pet.display} · ${state.label}`} lead={<span className={`dot ${state.tone}`} aria-label={state.label} />}>
                      {pet.display}
                    </Chip>
                  );
                  })}
                </Cluster>
              )}
            </Stack>
          </Cell>
          <Cell label="Allowlist">{allowSummary(house)}</Cell>
          <Cell label="Channels">
            {house.channels.length === 0 ? (
              <span className="hint">no channels</span>
            ) : (
              <Cluster gap={2}>
                {house.channels.map((channel) => (
                  <Chip key={channel.chat} title={channelLabel(channel)} lead={<PlatformIcon platforms={platforms} platform={channel.platform} small />}>
                    {channelLabel(channel)}
                  </Chip>
                ))}
              </Cluster>
            )}
          </Cell>
        </ListRow>
      ))}
    </List>
  );
}

/** Asks for a name and creates the workspace (as `workspace create`); the daemon's error, if any, shows in the dialog. */
export function NewWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, warning?: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: "New workspace",
        body: "Its own bots, channels and network access.",
        confirmLabel: "Create workspace",
        onConfirm: async () => {
          const created = name.trim();
          await onCreated(created, await written(api.createWorkspace(created)));
        },
        children: (
          <TextField
            label="Name"
            hint="Lowercase letters, digits and dashes."
            mono
            value={name}
            onChange={setName}
            placeholder="lab"
          />
        ),
      }}
    />
  );
}
