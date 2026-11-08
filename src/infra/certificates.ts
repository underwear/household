import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TlsFiles {
  caCert: string;
  caKey: string;
  /** Holds only the leaf certificate and key: the one thing the gateway may see. */
  leafDir: string;
  leafCert: string;
  leafKey: string;
}

export function tlsFiles(dir: string): TlsFiles {
  const leafDir = join(dir, "leaf");
  return {
    caCert: join(dir, "ca.crt"),
    caKey: join(dir, "ca.key"),
    leafDir,
    leafCert: join(leafDir, "leaf.crt"),
    leafKey: join(leafDir, "leaf.key"),
  };
}

const RENEW_BEFORE_SECONDS = 30 * 24 * 3600;

/** openssl with umask 077, so keys are private from birth (LibreSSL would write them 0644). */
async function openssl(dir: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["sh", "-c", 'umask 077 && exec openssl "$@"', "sh", ...args], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, stderr: stderr.trim() };
}

async function opensslOrThrow(dir: string, args: string[]): Promise<void> {
  const result = await openssl(dir, args);
  if (!result.ok) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
}

/**
 * Household's CA plus a leaf (EC P-256) whose SANs are exactly `hosts` (none: no leaf). Idempotent: the CA is
 * made once; the leaf again when the hosts change or it is within 30 days of expiry. Works with macOS LibreSSL
 * and OpenSSL alike. Resolves to whether the leaf changed, so a gateway using it can be restarted.
 */
export async function ensureCertificates(dir: string, hosts: string[]): Promise<{ files: TlsFiles; leafChanged: boolean }> {
  const files = tlsFiles(dir);
  for (const path of [dir, files.leafDir]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
  const newCa = !existsSync(files.caKey) || !existsSync(files.caCert);
  if (newCa) {
    await opensslOrThrow(dir, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
    await opensslOrThrow(dir, [
      "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "3650", "-subj", "/CN=Household CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-out", "ca.crt",
    ]);
  }

  const hostsFile = join(dir, "leaf.hosts");
  const wanted = [...hosts].sort().join("\n");
  const haveLeaf = existsSync(files.leafCert) && existsSync(files.leafKey);
  if (hosts.length === 0) {
    rmSync(files.leafCert, { force: true });
    rmSync(files.leafKey, { force: true });
    rmSync(hostsFile, { force: true });
    return { files, leafChanged: haveLeaf };
  }
  const fresh =
    !newCa &&
    haveLeaf &&
    existsSync(hostsFile) &&
    readFileSync(hostsFile, "utf8") === wanted &&
    (await openssl(dir, ["x509", "-checkend", String(RENEW_BEFORE_SECONDS), "-noout", "-in", files.leafCert])).ok;
  if (fresh) return { files, leafChanged: false };

  const san = hosts.map((host) => `DNS:${host}`).join(",");
  writeFileSync(
    join(dir, "leaf.ext"),
    `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
  );
  await opensslOrThrow(dir, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf/leaf.key"]);
  await opensslOrThrow(dir, ["req", "-new", "-key", "leaf/leaf.key", "-subj", `/CN=${hosts[0]}`, "-out", "leaf.csr"]);
  await opensslOrThrow(dir, [
    "x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
    "-days", "825", "-sha256", "-extfile", "leaf.ext", "-out", "leaf/leaf.crt",
  ]);
  for (const temp of ["leaf.ext", "leaf.csr", "ca.srl"]) rmSync(join(dir, temp), { force: true });
  writeFileSync(hostsFile, wanted);
  return { files, leafChanged: true };
}
