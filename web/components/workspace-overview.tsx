import { Gauge, Globe, MessagesSquare, Bot, Pickaxe, type LucideIcon } from "lucide-react";
import { gib } from "../../src/core/resources";
import { overBudget } from "./workspace-resources";
import { houseFeatures } from "../../src/core/house-features";
import type { ReactNode } from "react";
import type { WorkspaceView } from "../api";
import { workspacePath, botPath } from "../router";
import { Cell, List, ListRow, Page, Section } from "./layout";
import { Link } from "./link";
import { ownBots, petState, withWorkers } from "./bot-state";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A workspace's entry page: what it has at a glance (each a way to its page), then its bots, each with its sideworkers under it. */
export function WorkspaceOverviewPage({ house }: { house: WorkspaceView }) {
  const pets = ownBots(house.pets);
  const running = pets.filter((pet) => pet.state === "running").length;
  const workers = house.pets.length - pets.length;
  const closed = house.channels.filter((channel) => channel.problem).length;
  const temporary = house.temporary?.filter(({ expiresAt }) => expiresAt > Date.now()).length ?? 0;
  return (
    <Page title={house.name}>
      <div className="stats">
        <Stat href={workspacePath(house.name, "bots")} icon={Bot} label="Bots" value={pets.length} sub={pets.length === 0 ? "none yet" : `${running} running`} />
        <Stat href={workspacePath(house.name, "channels")} icon={MessagesSquare} label="Channels" value={house.channels.length} sub={closed ? `${closed} not open` : count(house.owners.length, "owner")} warn={closed > 0} />
        <Stat href={workspacePath(house.name, "sideworkers")} icon={Pickaxe} label="Sideworkers" value={workers} sub={!houseFeatures(house).sideworkers ? "off in this workspace" : workers ? "running now" : "none running"} />
        {house.resources && (
          <Stat href={workspacePath(house.name, "resources")} icon={Gauge} label="Free resources" value={`${house.resources.available.cpus} vCPU`}
            sub={overBudget(house.resources) ? "over capacity" : `${gib(house.resources.available.memoryMiB)} RAM`} warn={overBudget(house.resources)} />
        )}
        <Stat href={workspacePath(house.name, "network")} icon={Globe} label="Hosts allowed" value={house.allow.length} sub={temporary ? `${temporary} temporary` : "no temporary access"} />
      </div>
      <Section
        title="Bots"
        actions={
          <Link href={workspacePath(house.name, "bots")} className="btn small">
            Manage
          </Link>
        }
      >
        <List columns="minmax(0, 1fr) minmax(0, 1fr) auto" empty="No bots yet. Add one on the Bots page.">
          {withWorkers(house.pets).map((pet) => {
            const { tone, label } = petState(pet.state);
            return (
              <ListRow key={pet.name}>
                <Cell>
                  {pet.sideworker && <span className="sideworker-branch" aria-hidden>↳</span>}
                  <span className="avatar" aria-hidden>
                    {pet.emoji}
                  </span>
                  <Link href={botPath(house.name, pet.name)} className="strong ellipsis row-link">
                    {pet.title}
                  </Link>
                  {pet.title !== pet.name && <span className="id">{pet.name}</span>}
                </Cell>
                <Cell mono>
                  <span className="muted ellipsis">
                    {pet.agent} · {pet.model}
                  </span>
                </Cell>
                <Cell>
                  <span className={`dot ${tone}`} />
                  {label}
                </Cell>
              </ListRow>
            );
          })}
        </List>
      </Section>
    </Page>
  );
}

/** A tile: what it counts, the number, a line on it (or what `children` shows instead); a way to the page that has it. */
export function Stat({ href, icon: Icon, label, value, sub, warn, children }: { href: string; icon: LucideIcon; label: string; value?: string | number; sub?: ReactNode; warn?: boolean; children?: ReactNode }) {
  return (
    <Link href={href} className="stat">
      <span className="stat-label">
        <Icon size={14} strokeWidth={1.75} aria-hidden />
        {label}
      </span>
      {value !== undefined && <span className="stat-value">{value}</span>}
      {sub !== undefined && <span className={warn ? "stat-sub error" : "stat-sub"}>{sub}</span>}
      {children}
    </Link>
  );
}
