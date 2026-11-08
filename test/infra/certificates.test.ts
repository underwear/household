import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureCertificates } from "../../src/infra/certificates";
import { tempDir } from "../helpers";

const openssl = (...args: string[]) => Bun.spawnSync(["openssl", ...args]).stdout.toString();
const read = (...paths: string[]) => paths.map((path) => readFileSync(path, "utf8"));

test("CA and leaf are created once, private, and the leaf chains to the CA for exactly the hosts", async () => {
  const dir = join(tempDir(), "tls");
  mkdirSync(dir, { mode: 0o755 }); // an existing, too open dir is tightened
  const { files, leafChanged } = await ensureCertificates(dir, ["api.anthropic.com"]);
  expect(leafChanged).toBe(true);
  for (const path of [dir, files.leafDir]) expect(statSync(path).mode & 0o777).toBe(0o700);
  for (const key of [files.caKey, files.leafKey]) expect(statSync(key).mode & 0o777).toBe(0o600);
  expect(openssl("verify", "-CAfile", files.caCert, files.leafCert).trim()).toEndWith(": OK");
  expect(openssl("x509", "-in", files.leafCert, "-noout", "-ext", "subjectAltName")).toContain("DNS:api.anthropic.com");

  const before = read(files.caCert, files.caKey, files.leafCert, files.leafKey);
  expect((await ensureCertificates(dir, ["api.anthropic.com"])).leafChanged).toBe(false);
  expect(read(files.caCert, files.caKey, files.leafCert, files.leafKey)).toEqual(before);
});

test("changed hosts or a leaf close to expiry renew the leaf but keep the CA; no hosts, no leaf", async () => {
  const dir = join(tempDir(), "tls");
  const { files } = await ensureCertificates(dir, ["api.anthropic.com"]);
  const [ca] = read(files.caCert);

  expect((await ensureCertificates(dir, ["api.anthropic.com", "api.openai.com"])).leafChanged).toBe(true);
  expect(openssl("x509", "-in", files.leafCert, "-noout", "-ext", "subjectAltName")).toContain("DNS:api.openai.com");

  // Re-sign the same leaf for one day only: within the renewal window.
  Bun.spawnSync(["openssl", "req", "-new", "-key", files.leafKey, "-subj", "/CN=x", "-out", join(dir, "short.csr")]);
  Bun.spawnSync([
    "openssl", "x509", "-req", "-in", join(dir, "short.csr"), "-CA", files.caCert, "-CAkey", files.caKey,
    "-CAcreateserial", "-days", "1", "-out", files.leafCert,
  ]);
  expect((await ensureCertificates(dir, ["api.anthropic.com", "api.openai.com"])).leafChanged).toBe(true);
  expect(openssl("x509", "-in", files.leafCert, "-noout", "-checkend", String(30 * 24 * 3600))).toContain("will not expire");
  expect(read(files.caCert)).toEqual([ca!]);
  expect(openssl("verify", "-CAfile", files.caCert, files.leafCert).trim()).toEndWith(": OK");

  expect((await ensureCertificates(dir, [])).leafChanged).toBe(true);
  expect(existsSync(files.leafCert)).toBe(false);
  expect(existsSync(files.caCert)).toBe(true); // pets always get the CA
});
