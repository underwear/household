import { useState } from "react";
import { DEFAULT_PREVIEW_SETTINGS, houseFeatures, previewSettings, houseFeatureSettingsSchema, type HouseFeatures as WorkspaceFeatures, type PreviewSettings } from "../../src/core/house-features";
import { api, type WorkspaceView } from "../api";
import { ChoiceList, SwitchList, TextField } from "./fields";
import { Cluster, FormGrid, Section } from "./layout";
import { Link } from "./link";
import { workspacePath, type WorkspaceTab } from "../router";
import { written } from "./section";

/** What each feature does, for the owner (the harnesses get their own words), and its own page, where it has one. */
const FEATURES: { value: keyof WorkspaceFeatures; label: string; description: string; page: WorkspaceTab; pageLabel: string }[] = [
  { value: "sideworkers", label: "Sideworkers", description: "A bot can start helper harnesses in VMs of their own. Off pauses the running ones.", page: "sideworkers", pageLabel: "Sideworker settings" },
  { value: "scouts", label: "Scouts", description: "Bots can call specialists with their own access. You review everything they pass back.", page: "scouts", pageLabel: "Scout settings" },
  { value: "preview", label: "HTTP previews", description: "A bot can show you a web app from its VM by a link, for 15 minutes, once you approve it. Off closes open links.", page: "previews", pageLabel: "Preview settings" },
];

type Notify = (text: string, warning?: boolean) => void;

/** Saves a workspace's features and preview settings together (one endpoint): what the form changed, the rest as saved. */
async function saveFeatures(house: WorkspaceView, next: { features?: WorkspaceFeatures; preview?: PreviewSettings }, refresh: () => Promise<void>, notify: Notify, done: string) {
  const warning = await written(api.setWorkspaceFeatures(house.name, { features: next.features ?? houseFeatures(house), preview: next.preview ?? previewSettings(house) }));
  await refresh();
  notify(warning ?? done, warning !== undefined);
}

/** A workspace's features, each on or off; one that is on (as saved) leads to its own page. */
export function WorkspaceFeatureSettings({ house, refresh, notify }: { house: WorkspaceView; refresh: () => Promise<void>; notify: Notify }) {
  const [features, setFeatures] = useState(houseFeatures(house));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saved = houseFeatures(house);
  const changed = JSON.stringify(features) !== JSON.stringify(saved);
  const save = async () => {
    setBusy(true); setError(undefined);
    try { await saveFeatures(house, { features }, refresh, notify, "Workspace features saved"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Section width="narrow" title="Features" hint="Bots are told which ones are on. One that is off leaves the sidebar.">
      <form className="stack gap-5" onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
        <SwitchList
          label="Features"
          options={FEATURES.map(({ value, label, description, page, pageLabel }) => ({
            value, label,
            description: saved[value]
              ? <>{description}<span className="switch-more"><Link href={workspacePath(house.name, page)} className="text-link">{pageLabel}</Link></span></>
              : description,
          }))}
          on={FEATURES.filter(({ value }) => features[value]).map(({ value }) => value)}
          onToggle={value => setFeatures({ ...features, [value]: !features[value as keyof WorkspaceFeatures] })}
          disabled={busy}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <Cluster gap={4} justify="end">
          <button type="submit" className="btn primary" disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</button>
        </Cluster>
      </form>
    </Section>
  );
}

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];
/** Preview links only this computer opens: the default, and what "This computer only" sets. */
const isLocal = (preview: PreviewSettings) => LOOPBACK.includes(preview.bindAddress) && LOOPBACK.includes(preview.publicHost);

/**
 * Who can open a workspace's preview links: this computer only, or an address the owner gives (the interface to listen
 * on, the host the links name). A field's own problem shows under it.
 */
export function PreviewReachSettings({ house, refresh, notify }: { house: WorkspaceView; refresh: () => Promise<void>; notify: Notify }) {
  const [preview, setPreview] = useState(previewSettings(house));
  const [custom, setCustom] = useState(!isLocal(previewSettings(house)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof PreviewSettings, string>>>({});
  const changed = JSON.stringify(preview) !== JSON.stringify(previewSettings(house));
  const save = async () => {
    const parsed = houseFeatureSettingsSchema.safeParse({ features: houseFeatures(house), preview });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      const field = (name: keyof PreviewSettings) => issues.find(issue => issue.path.at(-1) === name)?.message;
      setFieldErrors({ bindAddress: field("bindAddress"), publicHost: field("publicHost") });
      const rest = issues.filter(issue => !["bindAddress", "publicHost"].includes(String(issue.path.at(-1))));
      return setError(rest.length ? rest.map(issue => issue.message).join("; ") : undefined);
    }
    setBusy(true); setError(undefined); setFieldErrors({});
    try { await saveFeatures(house, { preview: parsed.data.preview }, refresh, notify, "Preview settings saved"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const reach = (value: string) => {
    setCustom(value === "custom");
    if (value === "local") setPreview(DEFAULT_PREVIEW_SETTINGS);
  };
  return (
    <Section width="narrow" title="Who can open the links" hint="A change closes the links open now.">
      <form className="stack gap-5" onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
        <ChoiceList
          label="Reach"
          value={custom ? "custom" : "local"}
          onChange={reach}
          options={[
            { value: "local", label: "This computer only", description: "Links on 127.0.0.1." },
            { value: "custom", label: "Another address", description: "Your network or a public host. Household opens no firewall or tunnel for it." },
          ]}
        />
        {custom && (
          <FormGrid>
            <TextField label="Listen on" mono value={preview.bindAddress} onChange={bindAddress => setPreview({ ...preview, bindAddress })} placeholder="0.0.0.0" hint="An IP address of this machine." error={fieldErrors.bindAddress} />
            <TextField label="Links use" mono value={preview.publicHost} onChange={publicHost => setPreview({ ...preview, publicHost })} placeholder="mac-mini.local" hint="The host people open, no scheme or port." error={fieldErrors.publicHost} />
          </FormGrid>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <Cluster gap={4} justify="end">
          <span className="hint grow">Links have no login: whoever reaches one sees the app.</span>
          <button type="submit" className="btn primary" disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</button>
        </Cluster>
      </form>
    </Section>
  );
}
