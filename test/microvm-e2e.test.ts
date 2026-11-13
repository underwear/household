import { GUEST_METRICS } from "../src/infra/guest-metrics";
import { metricSnapshot } from "../src/core/metrics";
// E2E_MICROVM=1 bun test test/microvm-e2e.test.ts
// Real msb + daemon + host gateway; isolated names/ports/homes, fake Telegram and local HTTPS only.
// Requires msb 0.7.13, Docker for image building, openssl, and hardware virtualization.
// No real provider credentials or existing pets/configuration are read or modified.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCodeTmux } from "../src/agent-adapters/claude-code-tmux";
import { backupRuntime } from "../src/app/backup-runtime";
import { startDaemon, type DaemonDeps } from "../src/app/daemon";
import { exportHousehold } from "../src/app/export";
import { HostNetworkPlane } from "../src/app/host-network-plane";
import { importHousehold } from "../src/app/import";
import { instanceId, PetPlane, petContainer, petDockerDisk, petVolume } from "../src/app/pet-plane";
import { homesDirectory } from "../src/app/runtime-services";
import { openChannels } from "../src/app/channels";
import type { AgentAdapter } from "../src/core/agent";
import { ensureCertificates } from "../src/infra/certificates";
import { ConfigStore } from "../src/infra/config-store";
import { DockerCli } from "../src/infra/docker-cli";
import { EventLog } from "../src/infra/event-log";
import { MAIN_JOB_LABEL, MicrosandboxRuntime } from "../src/infra/microsandbox-runtime";
import { resolvePaths } from "../src/infra/paths";
import { PetTokenRegistry } from "../src/infra/pet-token-registry";
import { SqliteStore } from "../src/infra/sqlite-store";
import { fakeTelegram } from "./fake-telegram";
import { waitFor } from "./helpers";
import { callControl } from "../src/infra/control-socket";
import type { ApiAnswer } from "../src/app/daemon";

const enabled = process.env.E2E_MICROVM === "1";
const root = mkdtempSync(join(tmpdir(), "household-microvm-e2e-"));
const house = `vmtest${randomBytes(4).toString("hex")}`;
const pet = petContainer(house, "probe");
const imageName = `household-agent-${house}`;
const paths = resolvePaths({ HOUSEHOLD_CONFIG_DIR: join(root, "config"), HOUSEHOLD_STATE_DIR: join(root, "state") });
const BOT = `4242:${"A".repeat(35)}`;
const FAKE_KEY = "host-only-fixture-key-never-a-real-provider-key";
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let runtime: MicrosandboxRuntime | undefined;
let store: SqliteStore | undefined;
let telegram: ReturnType<typeof fakeTelegram> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let deps: () => DaemonDeps;
let requests: { key: string | null; capability: boolean }[] = [];

async function shell(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { out, code };
}
const exec = async (command: string[], input?: string) => {
  const result = await runtime!.exec(pet, command, input);
  expect(result.ok).toBe(true);
  return result.output;
};
const mcp = async (name: string, args: object) => JSON.parse(await exec(["sh", "-c",
  'curl --silent --show-error --fail --max-time 4 -H "x-household-token: $HOUSEHOLD_PET_TOKEN" -H content-type:application/json --data-binary @- "$HOUSEHOLD_MCP_URL"',
], JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } })));

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(dirname(paths.configFile), { recursive: true });
  const tls = await ensureCertificates(join(root, "upstream-tls"), ["localhost"]);
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { cert: readFileSync(tls.files.leafCert, "utf8"), key: readFileSync(tls.files.leafKey, "utf8") },
    fetch(request) {
      requests.push({ key: request.headers.get("authorization"), capability: request.headers.has("x-household-token") || request.headers.has("proxy-authorization") });
      return Response.json({ injected: request.headers.get("authorization") === `Bearer ${FAKE_KEY}` });
    },
  });
  const ports = [Bun.serve({ port: 0, fetch: () => new Response() }), Bun.serve({ port: 0, fetch: () => new Response() })];
  const [proxyPort, relayPort] = ports.map(({ port }) => port!);
  await Promise.all(ports.map((server) => server.stop(true)));
  const context = join(root, "image");
  mkdirSync(context);
  const baseImage = process.env.HOUSEHOLD_QA_BASE_IMAGE ?? "household-agent-claude-code-tmux";
  if (!process.env.HOUSEHOLD_QA_BASE_IMAGE) await new DockerCli().buildImage(baseImage, claudeCodeTmux.imageContext);
  const workload = `printf '%s\\n' '${house}' > /tmp/ready; echo $$ > /tmp/main.pid; exec sleep infinity`;
  writeFileSync(join(context, "Dockerfile"), `FROM ${baseImage}\nENTRYPOINT ${JSON.stringify(["sh", "-c", workload])}\n`);
  runtime = new MicrosandboxRuntime({ builder: new DockerCli(), homesDir: homesDirectory(paths), proxyPort: proxyPort!, relayPort: relayPort! });
  const target = { host: "localhost", port: upstream.port! };
  const agent: AgentAdapter = {
    ...claudeCodeTmux, name: house, imageContext: context, models: ["fixture"], defaultModel: "fixture", dialogs: undefined,
    env: ({ eventsUrl, mcpUrl }) => ({ HOUSEHOLD_EVENTS_URL: eventsUrl, HOUSEHOLD_MCP_URL: mcpUrl, FIXTURE_ENTRYPOINT_ID: house }),
    credentialHeaders: [{ target, headers: ["authorization", "x-api-key"] }],
    useKey: () => ({ kind: "fixture", env: { FIXTURE_API_KEY: "placeholder" }, wire: [{ target, header: "authorization", prefix: "Bearer " }] }),
    isReady: async (run) => ({ ready: (await run(["sh", "-c", 'test "$(cat /tmp/ready)" = "$FIXTURE_ENTRYPOINT_ID" && kill -0 "$(cat /tmp/main.pid)"'])).ok }),
    dialogVisible: async () => false,
    send: async (run, text) => (await run(["sh", "-c", 'kill -0 "$(cat /tmp/main.pid)" && mkdir -p "$HOME/memory" && cat >> "$HOME/memory/inbox"'], text)).ok ? { status: "sent" } : { status: "refused", reason: "fixture workload is not running" },
  };
  writeFileSync(paths.configFile, `daemon: {agentPort: 0, webPort: 0}\nkeys:\n  fixture: {provider: anthropic, value: ${FAKE_KEY}}\nhouses:\n  ${house}:\n    network: {allow: []}\n    pets:\n      probe: {agent: ${house}, key: fixture}\n    people: {owners: {telegram: [42]}}\n    channels:\n      - {kind: telegram-private, token: "${BOT}", chat: "42", pets: [probe]}\n`, { mode: 0o600 });
  telegram = fakeTelegram(BOT);
  store = new SqliteStore(paths.database);
  const tokens = new PetTokenRegistry(join(paths.stateDir, "pet-tokens.json"));
  deps = () => ({
    paths, config: new ConfigStore(paths.configFile), agents: new Map([[house, agent]]),
    network: new HostNetworkPlane({ tlsDir: paths.tlsDir, gatewaySecretsDir: paths.gatewaySecretsDir, tokens, proxyPort: proxyPort!, relayPort: relayPort!, upstreamCa: readFileSync(tls.files.caCert, "utf8") }),
    pets: new PetPlane(runtime!, join(paths.tlsDir, "ca.crt"), instanceId(paths.stateDir), 30_000, { host: runtime!.host, proxyPort: proxyPort!, relayPort: relayPort!, tokenFor: (identity) => tokens.tokenFor(identity) }),
    events: new EventLog(paths.eventLog, () => {}), messages: store!, records: store!, sessions: store!,
    history: { search: async () => ({ records: [], more: false }) },
    openChannels: openChannels({ state: store!, events: new EventLog(paths.eventLog, () => {}), telegramApi: telegram!.url }),
    channelChecks: new Map(), webAssets: async () => new Map(),
  });
  daemon = await startDaemon(deps());
  // startDaemon may report running with an unready pet: explicitly prove the OCI workload actually ran.
  expect(await exec(["cat", "/tmp/ready"])).toBe(`${house}\n`);
  expect((await runtime.exec(pet, ["sh", "-c", 'kill -0 "$(cat /tmp/main.pid)"'])).ok).toBe(true);
  expect((await runtime.container(pet))!.labels[MAIN_JOB_LABEL]).toMatch(/^job_[a-f0-9]{32}$/);
}, 900_000);

afterAll(async () => {
  await daemon?.stop();
  if (enabled && runtime) {
    await runtime.removeContainer(pet).catch(() => {});
    await runtime.removeDisk(petDockerDisk(house, "probe")).catch(() => {}); // a pet's Docker disk outlives its VM
  }
  store?.close();
  telegram?.stop();
  await upstream?.stop(true);
  if (enabled) {
    await shell(["msb", "image", "remove", imageName]);
    await shell(["docker", "image", "rm", imageName]);
  }
  if (enabled && existsSync(paths.eventLog)) writeFileSync("/tmp/household-qa-microvm-events.jsonl", readFileSync(paths.eventLog));
  if (enabled && telegram) writeFileSync("/tmp/household-qa-microvm-telegram.json", JSON.stringify(telegram.calls));
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(!enabled)("the actual daemon delivers fake Telegram and MCP through a token-authenticated VM; only the host sees the fake API key", async () => {
  telegram!.push({ message: { message_id: 500, message_thread_id: 100, is_topic_message: true, chat: { id: 42 }, from: { id: 42, first_name: "Owner" }, text: "microVM message" } });
  const inbox = join(homesDirectory(paths), petVolume(house, "probe"), "memory", "inbox");
  await waitFor(() => existsSync(inbox) && readFileSync(inbox, "utf8").includes("microVM message"), 15_000);
  const response = await mcp("reply", { text: "reply from the isolated VM" });
  expect(response.result.isError).not.toBe(true);
  await waitFor(() => telegram!.sent("sendMessage").some(({ text }) => text === "reply from the isolated VM"), 5000);
  const approved = await exec(["sh", "-c", `curl --proxy-anyauth --silent --show-error --fail --max-time 4 -H 'authorization: Bearer placeholder' https://localhost:${upstream!.port}/fixture`]);
  expect(JSON.parse(approved)).toEqual({ injected: true });
  expect(requests).toEqual([{ key: `Bearer ${FAKE_KEY}`, capability: false }]);
  expect((await exec(["env"])).includes(FAKE_KEY)).toBe(false);
  expect(readFileSync(paths.eventLog, "utf8").includes(FAKE_KEY)).toBe(false);
}, 30_000);

test.skipIf(!enabled)("the actual VM cannot bypass the host proxy or reach arbitrary host ports", async () => {
  for (const target of ["https://1.1.1.1/", `http://${runtime!.host}:${upstream!.port}/private`]) {
    expect((await runtime!.exec(pet, ["curl", "--silent", "--fail", "--max-time", "2", "--noproxy", "*", target])).ok).toBe(false);
  }
  expect((await runtime!.exec(pet, ["sh", "-c", "curl --silent --fail --max-time 2 https://unlisted.invalid/"])).ok).toBe(false);
  expect(requests).toHaveLength(1);
});

test.skipIf(!enabled)("restarting the actual daemon adopts the same VM/session and preserves its host home", async () => {
  const boot = await exec(["cat", "/proc/sys/kernel/random/boot_id"]);
  const workload = await exec(["cat", "/tmp/main.pid"]);
  const mainJob = (await runtime!.container(pet))!.labels[MAIN_JOB_LABEL];
  await exec(["sh", "-c", "echo session-proof > /tmp/session-proof"]);
  await daemon!.stop();
  daemon = await startDaemon(deps());
  expect(await exec(["cat", "/proc/sys/kernel/random/boot_id"])).toBe(boot);
  expect(await exec(["cat", "/tmp/main.pid"])).toBe(workload);
  expect((await runtime!.exec(pet, ["sh", "-c", 'kill -0 "$(cat /tmp/main.pid)"'])).ok).toBe(true);
  expect((await runtime!.container(pet))!.labels[MAIN_JOB_LABEL]).toBe(mainJob);
  expect(await exec(["cat", "/tmp/session-proof"])).toBe("session-proof\n");
  expect(await exec(["cat", "/home/agent/memory/inbox"])).toContain("microVM message");
});

test.skipIf(!enabled)("setup survives boot, failures require explicit retry, and onStart runs on each boot", async () => {
  // All mutations below target only this disposable fixture VM.
  await exec(["sh", "-c", "sudo rm -f /etc/household/environment-setup.state /etc/household/environment-setup.sh"]);
  const install = 'echo install >> "$HOME/setup-count"';
  const start = 'echo boot >> "$HOME/start-count"';
  runtime!.configureEnvironmentSetup(pet, install, start);
  await runtime!.stopContainer(pet);
  await runtime!.startContainer(pet);
  expect(await exec(["cat", "/home/agent/setup-count"])).toBe("install\n");
  expect(await exec(["cat", "/home/agent/start-count"])).toBe("boot\n");
  await runtime!.stopContainer(pet);
  await runtime!.startContainer(pet);
  expect(await exec(["cat", "/home/agent/setup-count"])).toBe("install\n");
  expect(await exec(["cat", "/home/agent/start-count"])).toBe("boot\nboot\n");
  expect(runtime!.environmentSetupResult(pet)).toMatchObject({ status: "complete", attempted: false });
  expect((await runtime!.runEnvironmentSetup(pet, 'echo failed >> "$HOME/setup-count"; exit 7')).status).toBe("failed");
  await runtime!.stopContainer(pet);
  await runtime!.startContainer(pet);
  expect(await exec(["cat", "/home/agent/setup-count"])).toBe("install\nfailed\n");
  expect(runtime!.environmentSetupResult(pet)).toMatchObject({ status: "failed", attempted: false });
  expect((await runtime!.runEnvironmentSetup(pet, 'echo repaired >> "$HOME/setup-count"')).status).toBe("complete");
  expect(await exec(["cat", "/home/agent/setup-count"])).toBe("install\nfailed\nrepaired\n");
  // Interrupted/corrupted state must keep the VM bootable without retrying installation.
  await exec(["sudo", "sh", "-c", ": > /etc/household/environment-setup.state"]);
  await runtime!.stopContainer(pet);
  await runtime!.startContainer(pet);
  expect(runtime!.environmentSetupResult(pet)).toMatchObject({ status: "failed", attempted: false });
  expect(await exec(["cat", "/home/agent/setup-count"])).toBe("install\nfailed\nrepaired\n");
  // A legacy VM without a new marker is adopted without repeating its prior setup.
  await exec(["sudo", "rm", "/etc/household/environment-setup.state"]);
  await runtime!.stopContainer(pet);
  await runtime!.startContainer(pet);
  expect(await exec(["cat", "/home/agent/setup-count"])).toBe("install\nfailed\nrepaired\n");
  expect(runtime!.environmentSetupResult(pet)).toMatchObject({ status: "complete", attempted: false });
}, 180_000);

test.skipIf(!enabled)("guest telemetry reports actual CPU, available memory and separate VM disks", async () => {
  const sample = metricSnapshot.parse(JSON.parse(await exec(["python3", "-c", GUEST_METRICS])));
  expect(sample.cpus.map(cpu => cpu.id)).toEqual(["cpu", "cpu0", "cpu1"]);
  expect(sample.memory.total).toBeGreaterThan(1_000_000_000);
  expect(sample.memory.available).toBeLessThanOrEqual(sample.memory.total);
  for (const disk of Object.values(sample.disks)) {
    expect(disk).not.toBeNull();
    expect(disk!.total).toBeGreaterThan(disk!.used);
  }
}, 10_000);

test.skipIf(!enabled)("CPU and RAM resize on next boot without discarding VM system data", async () => {
  await exec(["sh", "-c", "echo kept > /tmp/resource-proof"]);
  const boot = await exec(["cat", "/proc/sys/kernel/random/boot_id"]);
  await runtime!.configureResources(pet, {cpus: 3, memoryMiB: 3072});
  expect(await exec(["cat", "/proc/sys/kernel/random/boot_id"])).toBe(boot);
  expect(JSON.parse(await exec(["python3", "-c", GUEST_METRICS])).cpus).toHaveLength(3);
  await runtime!.stopContainer(pet); await runtime!.startContainer(pet);
  const larger = metricSnapshot.parse(JSON.parse(await exec(["python3", "-c", GUEST_METRICS])));
  expect(larger.cpus).toHaveLength(4);
  expect(larger.memory.total).toBeGreaterThan(2.5 * 1024 ** 3);
  expect(await exec(["cat", "/tmp/resource-proof"])).toBe("kept\n");
  await runtime!.configureResources(pet, {cpus: 2, memoryMiB: 2048});
  await runtime!.stopContainer(pet); await runtime!.startContainer(pet);
  const smaller = metricSnapshot.parse(JSON.parse(await exec(["python3", "-c", GUEST_METRICS])));
  expect(smaller.cpus).toHaveLength(3);
  expect(smaller.memory.total).toBeLessThan(2.1 * 1024 ** 3);
  expect(await exec(["cat", "/tmp/resource-proof"])).toBe("kept\n");
}, 120_000);

test.skipIf(!enabled)("a shared folder is mounted at /volumes/<name>, read-only then read-write, and unmounted with its files kept", async () => {
  const folder = join(root, "shared");
  mkdirSync(folder);
  writeFileSync(join(folder, "hello.txt"), "from host\n");
  const api = async (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => (await callControl<ApiAnswer>(paths.socket, "/api", { method, path, ...(body === undefined ? {} : { body }) }))!;
  const at = `/api/houses/${house}/volumes`;
  /** Polls a command in the VM (it is recreated meanwhile) until it prints what is wanted. */
  const until = async (command: string, wanted: (output: string, ok: boolean) => boolean, ms = 120_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const result = await runtime!.exec(pet, ["sh", "-c", command]).catch(() => ({ ok: false, output: "" }));
      if (wanted(result.output, result.ok)) return result.output;
      if (Date.now() > deadline) throw new Error(`timed out: ${command} → ${result.output}`);
      await Bun.sleep(1000);
    }
  };
  expect((await api("POST", `${at}/check`, { path: folder })).body).toMatchObject({ exists: true, files: 1, capped: false });
  expect((await api("POST", `${at}/check`, { path: paths.stateDir })).status).toBe(400);
  expect((await api("POST", at, { name: "shared", path: folder, access: "read", bots: ["probe"] })).status).toBeLessThan(300);
  expect(await until("cat /volumes/shared/hello.txt", (out) => out === "from host\n")).toBe("from host\n");
  expect((await runtime!.exec(pet, ["sh", "-c", "echo vm > /volumes/shared/vm.txt"])).ok).toBe(false);
  expect((await api("PUT", `${at}/shared`, { path: folder, access: "write", bots: ["probe"] })).status).toBeLessThan(300);
  await until("echo vm > /volumes/shared/vm.txt && echo ok", (out) => out === "ok\n");
  expect(readFileSync(join(folder, "vm.txt"), "utf8")).toBe("vm\n");
  const view = (await api("GET", at)).body as { volumes: { name: string; present: boolean }[]; homes: { bot: string; hostPath: string }[] };
  expect(view.volumes).toEqual([expect.objectContaining({ name: "shared", present: true })]);
  expect(view.homes).toEqual([expect.objectContaining({ bot: "probe", hostPath: join(homesDirectory(paths), petVolume(house, "probe")) })]);
  // A bot cannot ask for Household's own folders: refused before any card.
  expect(JSON.parse((await mcp("volume_request", { name: "state", path: paths.stateDir, reason: "test" })).result.content[0].text)).toMatchObject({ status: "refused" });
  expect((await api("DELETE", `${at}/shared`)).status).toBeLessThan(300);
  await until("test -e /volumes/shared && echo there || echo gone", (out) => out === "gone\n");
  expect(readFileSync(join(folder, "hello.txt"), "utf8")).toBe("from host\n");
  expect(readFileSync(join(folder, "vm.txt"), "utf8")).toBe("vm\n");
}, 600_000);

test.skipIf(!enabled)("recreating a VM restores configured system dependencies even when HOME says setup was complete", async () => {
  const setup = 'set -eu\nsudo sh -c \'printf "#!/bin/sh\\nprintf restored\\n" > /usr/local/bin/qa-restored; chmod 755 /usr/local/bin/qa-restored\'\necho installed >> "$HOME/restoration-count"\n';
  await new ConfigStore(paths.configFile).updatePetEnvironment(house, "probe", { setup });
  await runtime!.removeContainer(pet);
  await callControl(paths.socket, "/reload");
  expect(await exec(["/usr/local/bin/qa-restored"])).toBe("restored");
  expect(await exec(["sh", "-c", "ssh -V 2>&1"])).toContain("OpenSSH");
  expect(await exec(["cat", "/home/agent/restoration-count"])).toBe("installed\n");
  expect(runtime!.environmentSetupResult(pet)?.status).toBe("complete");
  // Simulates replacing the root filesystem with a new image, retaining the persistent home.
  await runtime!.removeContainer(pet);
  await callControl(paths.socket, "/reload");
  expect(await exec(["/usr/local/bin/qa-restored"])).toBe("restored");
  expect(await exec(["cat", "/home/agent/restoration-count"])).toBe("installed\ninstalled\n");
  await runtime!.stopContainer(pet); await runtime!.startContainer(pet);
  expect(await exec(["cat", "/home/agent/restoration-count"])).toBe("installed\ninstalled\n");
  expect(runtime!.environmentSetupResult(pet)).toMatchObject({ status: "complete", attempted: false });
}, 120_000);

test.skipIf(!enabled)("production host backup pauses/resumes a real VM and restores its home and CA into another state directory", async () => {
  await exec(["sh", "-c", 'mkdir -p "$HOME/memory"; printf "portable mémoire\\n" > "$HOME/memory/portable"; chmod 600 "$HOME/memory/portable"']);
  const ca = readFileSync(join(paths.tlsDir, "ca.key"));
  const archive = join(root, "portable.tar.gz");
  await exportHousehold({ paths, runtime: backupRuntime(paths), log: () => {} }, archive);
  expect((await runtime!.container(pet))!.state).toBe("running");
  await daemon!.stop(); daemon = undefined;
  await runtime!.removeContainer(pet);
  const restored = resolvePaths({ HOUSEHOLD_CONFIG_DIR: join(root, "restored-config"), HOUSEHOLD_STATE_DIR: join(root, "restored-state") });
  await importHousehold({ paths: restored, runtime: backupRuntime(restored), log: () => {} }, archive);
  const file = join(homesDirectory(restored), petVolume(house, "probe"), "memory", "portable");
  expect(readFileSync(file, "utf8")).toBe("portable mémoire\n");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(restored.tlsDir, "ca.key")).equals(ca)).toBe(true);
  expect(readFileSync(restored.configFile, "utf8")).toContain(house);
}, 60_000);
