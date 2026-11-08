import { useState } from "react";
import { api, type ChannelView, type HouseView, type PlatformView } from "../api";
import { housePath } from "../router";
import { Dialog } from "./dialog";
import { TextField } from "./fields";
import { Cell, Chip, Cluster, List, ListRow, Page, Stack } from "./layout";
import { PlatformIcon } from "./icon";
import { ownPets, petState } from "./pet-state";
import { Link } from "./link";
import { written } from "./section";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A channel in a word or two: its own name if it has one, then its kind's label. */
export const channelLabel = (channel: ChannelView) => (channel.ownName ? `${channel.name} · ${channel.label}` : channel.label);

/** Every host the house reaches, saying how many come with its pets' agents. */
function allowSummary(house: HouseView): string {
  const byAgent = house.allow.filter((entry) => entry.byAgent).length;
  return plural(house.allow.length, "host") + (byAgent ? ` (${byAgent} by agent)` : "");
}

/** Household · Houses: every house, with its pets, allowlist and channels at a glance. */
export function HousesPage({ houses, platforms, onNewHouse }: { houses: HouseView[]; platforms: PlatformView[]; onNewHouse: () => void }) {
  return (
    <Page
      title="Houses"
      actions={
        <button className="btn primary" onClick={onNewHouse}>
          + New house
        </button>
      }
    >
      <HousesTable houses={houses} platforms={platforms} />
    </Page>
  );
}

export function HousesTable({ houses, platforms }: { houses: HouseView[]; platforms: PlatformView[] }) {
  return (
    <List columns="minmax(0, 1fr) auto minmax(0, 1fr) auto" head={["House", "Allowlist", "Channels", ""]} empty="No houses yet.">
      {houses.map((house) => (
        <ListRow
          key={house.name}
          actions={
            <Link href={housePath(house.name)} className="btn small">
              Open
            </Link>
          }
        >
          <Cell>
            <Stack gap={2}>
              <span className="strong ellipsis">{house.name}</span>
              {ownPets(house.pets).length === 0 ? (
                <span className="hint">no pets</span>
              ) : (
                <Cluster gap={2}>
                {ownPets(house.pets).map((pet) => {
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

/** Asks for a name and creates the house (as `house create`); the daemon's error, if any, shows in the dialog. */
export function NewHouseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, warning?: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: "New house",
        body: "Its own pets, channels and network access.",
        confirmLabel: "Create house",
        onConfirm: async () => {
          const created = name.trim();
          await onCreated(created, await written(api.createHouse(created)));
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
