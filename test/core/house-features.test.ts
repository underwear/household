import { expect, test } from "bun:test";
import { houseFeatures, previewSettings, previewSettingsSchema } from "../../src/core/house-features";

test("feature defaults keep previews off", () => {
  expect(houseFeatures({})).toEqual({ preview: false, sideworkers: true, scouts: false });
  expect(previewSettings({})).toEqual({ bindAddress: "127.0.0.1", publicHost: "127.0.0.1" });
});

test("preview owner addresses cannot contain URLs, ports, credentials or paths", () => {
  for (const value of ["http://localhost", "localhost:8780", "user@localhost", "localhost/path", "localhost?x=y", ":::garbage", "0.0.0.0", "::"]) {
    expect(previewSettingsSchema.safeParse({ bindAddress: "127.0.0.1", publicHost: value }).success).toBe(false);
  }
  expect(previewSettingsSchema.safeParse({ bindAddress: "localhost", publicHost: "localhost" }).success).toBe(false);
  expect(previewSettingsSchema.safeParse({ bindAddress: "::", publicHost: "::1" }).success).toBe(true);
  expect(previewSettingsSchema.safeParse({ bindAddress: "0.0.0.0", publicHost: "preview.example.com" }).success).toBe(true);
});
