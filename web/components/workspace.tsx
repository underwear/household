import { WorkspaceResources } from "./workspace-resources";
import { WorkspaceConnectors } from "./workspace-connectors";
import { WorkspaceInboxesPage } from "./workspace-inboxes";
import { ScoutsPage } from "./scouts";
import { CapabilitiesPage } from "./capabilities";
import { houseFeatures } from "../../src/core/house-features";
import { Link } from "./link";
import { WorkspaceFeatureSettings, PreviewReachSettings } from "./workspace-features";
import { WorkspacePreviews } from "./bot-previews";
import { WorkspaceSideworkers } from "./bot-sideworkers";
import { SideworkerProfiles } from "./sideworker-profiles";
import { SideworkerSettings } from "./sideworker-settings";
import { SkillsPage } from "./skills";
import { NETWORK_PRESETS, type NetworkPreset } from "../../src/core/network-presets";
import { useEffect, useState } from "react";
import { api, type WorkspaceView, type KeyView, type MeView, type WriteView } from "../api";
import { workspacePath, navigate, type WorkspaceTab } from "../router";
import { ChannelsPage } from "./channels";
import { useDialog, type DialogSpec } from "./dialog";
import { SelectField, TextField } from "./fields";
import { Cluster, Page, Panel, Section, Stack } from "./layout";
import { BotsPage, type Capacity } from "./bots";
import { WorkspaceOverviewPage } from "./workspace-overview";
import { AddForm, ListSection, written, type SectionProps } from "./section";

export interface WorkspacePageProps {
  house: WorkspaceView;
  /** Which of its pages. */
  tab: WorkspaceTab;
  /** What this Household knows: the harnesses a bot may run, the kinds of channel and their platforms, how long a note may be. */
  known: Pick<MeView, "agents" | "channelKinds" | "platforms" | "noteMax">;
  /** The Household's keys (a bot runs on one). */
  keys: KeyView[];
  /** The host and every workspace's bots: what a new bot's CPU and RAM are weighed against. */
  capacity: Capacity;
  /** Refetches the workspaces after a write. */
  refresh: () => Promise<void>;
  /** A toast: what was done, or a warning. */
  notify: (text: string, warning?: boolean) => void;
}

/** A page of a workspace: its bots; its channels and owners; its network (the domains allowlist); its settings (deleting it). */
export function WorkspacePage({ house, tab, known, keys, capacity, refresh, notify }: WorkspacePageProps) {
  const dialog = useDialog();
  const save = async (write: Promise<WriteView>, done: string) => {
    try {
      const warning = await written(write);
      notify(warning ?? done, warning !== undefined);
    } finally {
      await refresh(); // a failed write may have raced another editor's: show what is there
    }
  };
  const props = { house, ask: dialog.open, save };
  return (
    <>
      {tab === "overview" && <WorkspaceOverviewPage house={house} />}
      {tab === "bots" && <BotsPage {...props} agents={known.agents} keys={keys} capacity={capacity} />}
      {tab === "channels" && <ChannelsPage {...props} kinds={known.channelKinds} platforms={known.platforms} noteMax={known.noteMax} />}
      {tab === "inboxes" && <WorkspaceInboxesPage key={house.name} house={house} notify={notify} />}
      {tab === "connectors" && <WorkspaceConnectors key={house.name} house={house} notify={notify} />}
      {tab === "skills" && <SkillsPage key={house.name} house={house.name} notify={notify} />}
      {tab === "scouts" && <ScoutsPage house={house} agents={known.agents} keys={keys} host={capacity.host} refresh={refresh} notify={notify} />}
      {tab === "capabilities" && <CapabilitiesPage house={house} refresh={refresh} notify={notify} />}
      {tab === "network" && (
        <Page title="Network">
          <AllowlistSection {...props} />
          <TemporaryNetworkSection {...props} />
        </Page>
      )}
      {tab === "sideworkers" && (
        <Page title="Sideworkers">
          {/* Off: only the line saying so; workers, profiles and limits come back with the switch. */}
          {houseFeatures(house).sideworkers ? (
            <>
              <WorkspaceSideworkers house={house} refresh={refresh} />
              <SideworkerProfiles house={house} agents={known.agents} keys={keys} refresh={refresh} notify={notify} />
              <SideworkerSettings key={JSON.stringify(house.sideworkerLimits)} house={house} host={capacity.host} refresh={refresh} notify={notify} />
            </>
          ) : (
            <FeatureOff house={house.name} text="Running sideworkers are paused, and bots cannot start new ones." />
          )}
        </Page>
      )}
      {tab === "previews" && (
        <Page title="Previews">
          {houseFeatures(house).preview ? (
            <>
              <WorkspacePreviews house={house} />
              <PreviewReachSettings key={JSON.stringify([house.name, house.preview])} house={house} refresh={refresh} notify={notify} />
            </>
          ) : (
            <FeatureOff house={house.name} text="Bots cannot show you web apps from their VMs." />
          )}
        </Page>
      )}
      {tab === "settings" && (
        <Page title="Settings">
          <WorkspaceResources key={house.name} house={house} host={capacity.host} refresh={refresh} notify={notify} />
          <WorkspaceFeatureSettings key={JSON.stringify([house.name, house.features, house.preview])} house={house} refresh={refresh} notify={notify} />
          <DeleteSection house={house} ask={dialog.open} refresh={refresh} notify={notify} />
        </Page>
      )}
      {dialog.element}
    </>
  );
}

/** A feature's page while the workspace has it off (reached by its address: the sidebar leaves it out): that, and the way back on. */
export function FeatureOff({ house, text }: { house: string; text: string }) {
  return (
    <div className="bot-off" role="status">
      <span className="bot-state"><span className="dot off" /> Off</span>
      <span className="bot-off-text">{text}</span>
      <Link href={workspacePath(house, "settings")} className="btn small">Turn on in Settings</Link>
    </div>
  );
}

// `*`, `*:8080`, `*:*`: any public host (core's `isWholeInternet`).
const WHOLE_INTERNET = /^\*(?::(?:\d+|\*))?$/;

/**
 * The confirmation for adding `host`: a whole-internet entry gets a warning whose safe choice (Cancel) is the
 * primary, focused one; any other host the plain confirmation.
 */
export function allowDialog(house: string, host: string, onConfirm: () => Promise<void>): DialogSpec {
  if (!WHOLE_INTERNET.test(host)) {
    return { title: `Allow ${host}?`, body: `Bots in ${house} will be able to reach this host.`, confirmLabel: "Allow", onConfirm };
  }
  const port = host.split(":")[1];
  const where = port === "*" ? "on any port" : `on port ${port ?? 443}`;
  return {
    title: `Open the whole internet to bots in ${house}?`,
    body: `Bots can reach any public host ${where}; one tricked by a web page or a forwarded message can send what it read anywhere. Your local network and the machine Workspace runs on stay closed.`,
    confirmLabel: "I understand the risk",
    danger: true,
    safe: true,
    onConfirm,
  };
}

/** The preview is exactly the batch submitted; presets have no persistent identity or policy. */
export function presetDialog(house: string, preset: NetworkPreset, allow: WorkspaceView["allow"], onConfirm: () => Promise<void>): DialogSpec {
  return {
    title: `Allow ${preset.label}?`,
    body: `Bots in ${house} get full access to these hosts, uploads included. Port 443 unless shown.`,
    children: <Stack gap={3}>
      <ul>{preset.hosts.map((host) => <li key={host}><code>{host}</code>{allow.some((entry) => entry.host === host) ? " · already listed" : ""}</li>)}</ul>
      <p>{preset.note}</p>
    </Stack>,
    confirmLabel: "Add hosts", onConfirm,
  };
}

/** The hosts the workspace's bots may reach: its own, and those its bots' harnesses bring (not removable here). */
export function AllowlistSection({ house, ask, save }: SectionProps) {
  const [entry, setEntry] = useState("");
  return (
    <ListSection
      title="Domains allowlist"
      width="narrow"
      hint='Hosts bots in this workspace can reach. “By harness” ones are needed by the harness itself.'
      form={
        <Stack gap={3}>
          <div className="network-add">
            <AddForm
              addLabel="Add host"
              ready={entry.trim() !== ""}
              onAdd={() => {
                const host = entry.trim().toLowerCase();
                // A grant from chat may be listed on purpose: it then becomes the owner's own entry.
                if (house.allow.some((allowed) => !allowed.granted && allowed.host === host.replace(/:443$/, ""))) throw new Error(`${host} is already reachable`);
                ask(
                  allowDialog(house.name, host, async () => {
                    await save(api.allowHost(house.name, host), `${host} added to the allowlist`);
                    setEntry("");
                  }),
                );
              }}
            >
              <TextField label="Host" hideLabel mono value={entry} onChange={setEntry} placeholder="example.com" />
            </AddForm>
            {/* A preset opens its review at once: the hosts it adds, before anything is added. */}
            <SelectField
              label="Add from a preset"
              hideLabel
              value=""
              onChange={(id) => {
                const preset = NETWORK_PRESETS.find((each) => each.id === id);
                if (preset) ask(presetDialog(house.name, preset, house.allow, () => save(api.allowHosts(house.name, preset.hosts), `${preset.label} hosts added`)));
              }}
              options={[{ value: "", label: "Add from a preset…", disabled: true }, ...NETWORK_PRESETS.map(({ id, label }) => ({ value: id, label }))]}
            />
          </div>
          <details className="network-format">
            <summary>Domain formats</summary>
            <dl>
              <dt><code>example.com</code></dt><dd>one host on TCP port 443 (HTTPS) by default</dd>
              <dt><code>example.com:80</code></dt><dd>HTTP; <code>example.com:22</code> — SSH</dd>
              <dt><code>example.com:8443</code></dt><dd>another specific TCP port</dd>
              <dt><code>*.example.com</code></dt><dd>subdomains only</dd>
              <dt><code>*</code></dt><dd>any public host. Use only when unrestricted access is intended</dd>
            </dl>
          </details>
        </Stack>
      }
      empty="No hosts."
      items={house.allow.map(({ host, byAgent, bySecret, granted }) => ({
        key: host,
        label: host,
        mono: true,
        ...(granted ? { sub: "approved in chat · public addresses only" } : {}),
        ...(byAgent ? { tag: "by harness" } : bySecret ? { tag: `secret ${bySecret}` } : {}),
        ...(WHOLE_INTERNET.test(host) ? { warning: "whole internet" } : {}),
      }))}
      onRemove={(host) =>
        ask({
          title: `Remove ${host}?`,
          body: `Bots in ${house.name} will be denied this host.`,
          confirmLabel: "Remove",
          danger: true,
          onConfirm: () => save(api.disallowHost(house.name, host), `${host} removed`),
        })
      }
    />
  );
}

/** Short grants keep their deadline visible and are revoked independently of permanent domains. */
export function TemporaryNetworkSection({ house, ask, save }: SectionProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const grants = (house.temporary ?? []).filter(({ expiresAt }) => expiresAt > now);
  const petName = (pet: string) => house.pets.find(({ name }) => name === pet)?.display ?? pet;
  return <ListSection
    title="Temporary access"
    width="narrow"
    hint="Granted in chat: one host and port, for one bot, at the addresses shown, for 15 minutes."
    empty="No temporary grants."
    removeLabel="Revoke"
    items={grants.map(({ domain, port = 443, pet, addresses = [], reason, expiresAt }) => ({
      key: `${pet}/${domain}:${port}`, label: `${domain}:${port}`, mono: true,
      sub: `${petName(pet)} · ${Math.max(0, Math.ceil((expiresAt - now) / 60_000))} min left · until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${addresses.length ? ` · ${addresses.join(", ")}` : ""}`,
      note: reason,
    }))}
    onRemove={(key) => {
      const grant = grants.find(({ pet, domain, port = 443 }) => `${pet}/${domain}:${port}` === key);
      if (grant) ask(revokeTemporaryDialog(house.name, grant.pet, petName(grant.pet), grant.domain, grant.port ?? 443, save));
    }}
  />;
}

/** Revoke only the grant the owner selected: one bot's, to one host and TCP port. */
export function revokeTemporaryDialog(house: string, pet: string, shown: string, domain: string, port: number, save: SectionProps["save"]): DialogSpec {
  const endpoint = `${domain}:${port}`;
  return {
    title: `Revoke ${endpoint}?`, body: `${shown} in ${house} loses access to ${endpoint} now.`,
    confirmLabel: "Revoke", danger: true,
    onConfirm: () => save(api.revokeTemporary(house, pet, domain, port), `Temporary access to ${endpoint} revoked`),
  };
}

interface DeleteProps extends Omit<WorkspacePageProps, "tab" | "known" | "keys" | "capacity"> {
  ask: (spec: DialogSpec) => void;
}

function DeleteSection({ house, ask, refresh, notify }: DeleteProps) {
  const evicted = house.pets.map((pet) => pet.display);
  const remove = () =>
    ask({
      title: `Delete workspace ${house.name}?`,
      body: `${evicted.length > 0 ? `Evicts ${evicted.join(", ")}. ` : ""}Their VMs go; their files stay on disk.`,
      confirmLabel: "Delete workspace",
      danger: true,
      onConfirm: async () => {
        const warning = await written(api.deleteWorkspace(house.name));
        navigate("/");
        await refresh();
        notify(warning ?? `Workspace ${house.name} deleted`, warning !== undefined);
      },
    });
  return (
    <Section>
      <Panel>
        <Cluster gap={4} justify="between">
          <div className="grow">
            <Stack gap={1}>
              <span className="strong">Delete workspace</span>
              <span className="hint">Removes its bots' VMs. Their files stay on disk.</span>
            </Stack>
          </div>
          <button className="btn danger small" onClick={remove}>
            Delete
          </button>
        </Cluster>
      </Panel>
    </Section>
  );
}
