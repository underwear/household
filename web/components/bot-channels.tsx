import { useState } from "react";
import { joining } from "../../src/core/channels";
import { api, type ChannelView, type WorkspaceView, type BotView, type PlatformView } from "../api";
import { written } from "./section";
import { channelLabel } from "./workspaces";
import { PlatformIcon } from "./icon";
import { Cell, List, ListRow, Section } from "./layout";
import { Link } from "./link";
import { workspacePath } from "../router";

/**
 * Where a channel's bots and default go when `bot` joins or leaves it (core's `joining`); one that leaves as the
 * default hands it to the first left (none when one or none are left: one bot is the default by being alone).
 */
export function placing(channel: Pick<ChannelView, "pets" | "default">, pet: string, join: boolean): { pets: string[]; default: string | null } {
  if (join) {
    const joined = joining(channel, pet);
    return { pets: joined.pets, default: joined.default ?? null };
  }
  const pets = channel.pets.filter((name) => name !== pet);
  const first = channel.default === pet ? (pets[0] ?? null) : channel.default;
  return { pets, default: pets.length > 1 ? first : null };
}

/**
 * A bot's channels: every channel of its workspace, with whether the bot is in it (a switch) and, where it shares it,
 * whether it gets what is addressed to no bot (its default). The channel's own settings stay on the workspace's
 * Channels page.
 */
export function BotChannels({ house, pet, platforms, refresh, notify }: { house: WorkspaceView; pet: BotView; platforms: PlatformView[]; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const [busy, setBusy] = useState<string>();
  const titles = new Map(house.pets.map((each) => [each.name, each]));
  const place = async (channel: ChannelView, pets: string[], first: string | null, done: string) => {
    setBusy(channel.chat);
    try {
      const configured = pets.filter(name => !house.pets.find(pet => pet.name === name)?.sideworker);
      const warning = await written(api.placeBots(house.name, channel.chat, configured, first));
      notify(warning ?? done, warning !== undefined);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      await refresh();
      setBusy(undefined);
    }
  };
  return (
    <Section
      hint={
        <>
          Where {pet.title} answers. The default bot gets unaddressed messages. Bots and owners: the workspace's{" "}
          <Link href={workspacePath(house.name, "channels")} className="text-link">
            Channels
          </Link>{" "}
          page.
        </>
      }
    >
      <List columns="minmax(0, 1fr) auto" empty={<>No channels in {house.name} yet: add one on the workspace's <Link href={workspacePath(house.name, "channels")} className="text-link">Channels</Link> page.</>}>
        {house.channels.map((channel) => {
          const inside = channel.pets.includes(pet.name);
          const others = channel.pets.filter((name) => name !== pet.name);
          const isDefault = inside && others.length > 0 && channel.default === pet.name;
          const label = channelLabel(channel);
          return (
            <ListRow
              key={channel.chat}
              actions={
                <>
                  {inside && others.length > 0 &&
                    (isDefault ? (
                      <span className="tag" title="Gets unaddressed messages">
                        default
                      </span>
                    ) : (
                      <button type="button" className="text-btn plain" disabled={busy !== undefined} onClick={() => void place(channel, channel.pets, pet.name, `${pet.title} is the default in ${label}`)}>
                        Make default
                      </button>
                    ))}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={inside}
                    aria-label={`${pet.title} in ${label}`}
                    className="switch"
                    disabled={busy !== undefined}
                    onClick={() => {
                      const next = placing(channel, pet.name, !inside);
                      void place(channel, next.pets, next.default, inside ? `${pet.title} left ${label}` : `${pet.title} joined ${label}`);
                    }}
                  >
                    <span className="switch-knob" />
                  </button>
                </>
              }
            >
              <Cell>
                <PlatformIcon platforms={platforms} platform={channel.platform} />
                <span className="cell-lines">
                  <span className="strong ellipsis">{label}</span>
                  <span className="channel-company">
                    {others.length === 0 ? (
                      <span className="faint">{inside ? "Only this bot" : "No bots yet"}</span>
                    ) : (
                      <>
                        <span className="faint">{inside ? "With" : "Has"}</span>
                        {others.map((name) => {
                          const other = titles.get(name);
                          return (
                            <span key={name} className="chip small">
                              <span aria-hidden>{other?.emoji ?? "🤖"}</span>
                              <span className="ellipsis">{other?.title ?? name}</span>
                              {channel.default === name && others.length + (inside ? 1 : 0) > 1 && <span className="chip-note">default</span>}
                            </span>
                          );
                        })}
                      </>
                    )}
                  </span>
                  {channel.problem && <span className="error">{channel.problem}</span>}
                </span>
              </Cell>
            </ListRow>
          );
        })}
      </List>
    </Section>
  );
}
