import { z } from "zod";

/** House-owned capabilities. Skills stay discoverable even when their capability is disabled. */
export const HOUSE_FEATURES = {
  scouts: { label: "Scouts", description: "Call house specialists with their own access; messages back to pets require owner approval.", default: false },
  preview: { label: "HTTP previews", description: "Publish an application from your VM for up to 15 minutes, with owner approval for every publication.", default: false },
  sideworkers: { label: "Sideworkers", description: "Delegate work to additional agent VMs within the house's resource limits.", default: true },
} as const;
export type HouseFeatures = { -readonly [K in keyof typeof HOUSE_FEATURES]: boolean };
export interface PreviewSettings { bindAddress: string; publicHost: string }
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = { bindAddress: "127.0.0.1", publicHost: "127.0.0.1" };
export const houseFeatures = (house: { features?: Partial<HouseFeatures> }): HouseFeatures => ({
  scouts: house.features?.scouts ?? HOUSE_FEATURES.scouts.default,
  preview: house.features?.preview ?? HOUSE_FEATURES.preview.default,
  sideworkers: house.features?.sideworkers ?? HOUSE_FEATURES.sideworkers.default,
});
export const previewSettings = (house: { preview?: PreviewSettings }): PreviewSettings => ({ ...DEFAULT_PREVIEW_SETTINGS, ...house.preview });
export const houseFeaturesSchema = z.strictObject({ scouts: z.boolean().optional(), preview: z.boolean().optional(), sideworkers: z.boolean().optional() });
// Owner-selected hostname or IP only: no scheme, path, credentials or port. IPv6 is entered without brackets.
const host = z.string().trim().min(1).max(253).refine(value => {
  if (value.includes(":")) {
    try { return new URL(`http://[${value}]`).hostname.startsWith("["); } catch { return false; }
  }
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(value);
}, "Use a hostname or IP address, without a scheme, port or path");
export const previewSettingsSchema = z.strictObject({ bindAddress: z.union([z.ipv4(), z.ipv6()], { error: "Use an IPv4 or IPv6 listening address" }), publicHost: host.refine(value => !["0.0.0.0", "::"].includes(value), "Use a reachable hostname or IP for preview links") });
export const houseFeatureSettingsSchema = z.strictObject({ features: houseFeaturesSchema, preview: previewSettingsSchema });
