import { expect, test } from "bun:test";
import { scoutSubjects, type PlacedPet } from "../../src/app/agents";

test("a scout's install hosts are in its policy only while its install scripts run", () => {
  const scout = {
    house: "work", pet: "scout-1", keyUse: { wire: [] },
    scout: { definition: "naturgy", parent: "sibling", homePath: "/runs/scout-1/home", instructions: "", network: { kind: "allowlist", allow: [{ host: "omega.naturgy.es", port: 443 }] }, setupNetwork: [{ host: "deb.debian.org", port: 443, reach: "public" }] },
  } as unknown as PlacedPet;
  const hosts = (settingUp: boolean) => scoutSubjects([scout], () => settingUp)[0]!.policy.allow.map(entry => entry.host);
  expect(hosts(true)).toEqual(["omega.naturgy.es", "deb.debian.org"]);
  expect(hosts(false)).toEqual(["omega.naturgy.es"]);
  expect(scoutSubjects([scout])[0]!.policy.allow.map(entry => entry.host)).toEqual(["omega.naturgy.es"]); // closed unless said otherwise
});
