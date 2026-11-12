import { SecretRequests, type SecretDecision } from "../src/app/secret-requests";
import type { OwnerCard } from "../src/app/chat";

/** Actual production approval templates, exercised through each channel renderer. */
export async function secretCard(action: "create" | "update" | "delete"): Promise<OwnerCard<SecretDecision>> {
  let card!: OwnerCard<SecretDecision>;
  const requests = new SecretRequests({
    house: () => ({ name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "pet" }], channels: [], people: { owners: [] } }),
    secrets: () => action === "create" ? [] : [{ name: "weather", value: "SYNTHETIC_PRIVATE_VALUE", env: "WEATHER_TOKEN", hosts: [{ host: "api.example.com", port: 443 }], header: "authorization" }],
    save: async () => {}, update: async () => {}, remove: async () => {},
    notice: async () => {}, notify() {}, log() {},
    choose: async (_house, _pet, shown) => { card = shown; return undefined; },
  });
  await requests.request("work", "pet", { action, name: "weather", reason: "Read A & B <safely>", ...(action === "delete" ? {} : { header: "x-api-key", ...(action === "create" ? { env: "WEATHER_TOKEN", domains: ["api.example.com"] } : {}) }) });
  await requests.stop();
  return card;
}
