import { useEffect, useState } from "react";
import { api } from "../api";
import { SelectField } from "./fields";
import { Section } from "./layout";

/** The IANA zones this browser knows (the server checks the one chosen), and this browser's own. */
const ZONES: string[] = (() => {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
  } catch {
    return ["UTC"];
  }
})();
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** «UTC+01:00» for `zone` now. */
function offset(zone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date()).find(({ type }) => type === "timeZoneName")?.value;
    return name === "GMT" ? "UTC" : (name ?? "").replace("GMT", "UTC");
  } catch {
    return "";
  }
}

/** Household's one time zone, for every schedule; pets get it with each message. Saved as soon as it is chosen. */
export function TimezoneSettings() {
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api.timezone().then(
      (value) => active && setSaved(value.timezone),
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, []);
  const choose = async (zone: string) => {
    if (!zone || zone === saved) return;
    setBusy(true);
    setError("");
    try {
      setSaved((await api.setTimezone(zone)).timezone);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const zones = saved && !ZONES.includes(saved) ? [saved, ...ZONES] : ZONES;
  return (
    <Section title="Time zone" hint="For scheduled tasks; pets get it with every message.">
      <div className="timezone">
        <SelectField
          label="Household time zone"
          hideLabel
          value={saved ?? ""}
          onChange={(zone) => void choose(zone)}
          options={saved === undefined ? [{ value: "", label: "Loading…", disabled: true }] : zones.map((zone) => ({ value: zone, label: `${zone.replaceAll("_", " ")}  ·  ${offset(zone)}` }))}
        />
        {saved !== undefined && saved !== BROWSER_ZONE && ZONES.includes(BROWSER_ZONE) && (
          <button type="button" className="btn small" disabled={busy} onClick={() => void choose(BROWSER_ZONE)}>
            Use {BROWSER_ZONE.replaceAll("_", " ")}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
