import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUEST_DOCKER_PROXY_URL } from "../../src/infra/guest-docker-network";
import { GUEST_DOCKERD_FUNCTIONS, GUEST_SERVICES_SCRIPT, GUEST_SUPERVISION } from "../../src/infra/guest-services";
import { tempDir } from "../helpers";

// The supervisor's functions run on the host against a fake /proc and fake services; `sleep` is stubbed to record
// each delay (and to end the run), so no test waits.
function guest(script: string, env: Record<string, string> = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, "proc"));
  const header = `services_log=${dir}/log services_run=${dir} proc=${dir}/proc log_max_bytes=100 backoff_first=1 backoff_max=4\n`;
  const result = Bun.spawnSync(["sh", "-c", header + GUEST_SUPERVISION + GUEST_DOCKERD_FUNCTIONS + script], { env: { PATH: process.env.PATH!, DIR: dir, ...env } });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return { dir, code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), read };
}

test("a service that keeps failing is restarted with a doubling, capped delay, each exit logged", () => {
  const run = guest(`
sleep() { printf '%s\\n' "$1" >> "$DIR/sleeps"; [ "$(wc -l < "$DIR/sleeps")" -lt 5 ] || exit 0; }
flaky() { printf 'run\\n' >> "$DIR/runs"; return 3; }
supervise flaky 'flaky serve' flaky
`);
  expect(run.code).toBe(0);
  expect(run.read("sleeps").split("\n").filter(Boolean)).toEqual(["1", "2", "4", "4", "4"]);
  expect(run.read("runs").split("\n").filter(Boolean)).toHaveLength(5);
  expect(run.read("log")).toContain("flaky exited with status 3; restarting in 1s");
  expect(existsSync(join(run.dir, "flaky.pid"))).toBe(false);
});

test("an instance left by an earlier supervisor is waited out, not doubled; a stale or unparsable PID file is not one", () => {
  const run = guest(`
printf '4242\\n' > "$DIR/svc.pid"
mkdir -p "$DIR/proc/4242" && printf 'python3\\0svc\\0serve\\0' > "$DIR/proc/4242/cmdline"
sleep() { printf '%s\\n' "$1" >> "$DIR/sleeps"; rm -rf "$DIR/proc/4242"; [ "$(wc -l < "$DIR/sleeps")" -lt 2 ] || exit 0; }
svc() { printf 'run\\n' >> "$DIR/runs"; }
supervise svc 'svc serve' svc
`);
  expect(run.read("log")).toContain("svc: waiting for PID 4242, left by an earlier supervisor");
  expect(run.read("sleeps").split("\n").filter(Boolean)).toEqual(["5", "1"]);
  expect(run.read("runs").split("\n").filter(Boolean)).toHaveLength(1);
  const stale = guest(`
printf 'garbage' > "$DIR/a.pid"; live_pid "$DIR/a.pid" svc && echo live-a
printf '77\\n' > "$DIR/b.pid"; live_pid "$DIR/b.pid" svc && echo live-b
mkdir -p "$DIR/proc/77" && printf 'other\\0' > "$DIR/proc/77/cmdline"; live_pid "$DIR/b.pid" svc && echo live-reused
printf 'svc\\0' > "$DIR/proc/77/cmdline"; live_pid "$DIR/b.pid" svc
`);
  expect(stale.code).toBe(0);
  expect(stale.stdout).toBe("77\n"); // only a live process of that command line counts
});

test("dockerd starts past an unparsable or stale PID file, with the guest proxy only when it runs", () => {
  const bin = tempDir();
  writeFileSync(join(bin, "dockerd"), `#!/bin/sh\nprintf '%s\\n' "$*" > "$DIR/args"\nenv > "$DIR/env"\n`);
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho agent\n");
  for (const name of ["dockerd", "id"]) chmodSync(join(bin, name), 0o755);
  const start = (proxy: string) => guest(`
docker_run="$DIR/run" docker_proxy=${proxy}
mkdir -p "$docker_run/docker/containerd"
printf '12' > "$docker_run/docker.pid"
printf '999999\\n' > "$docker_run/docker/containerd/containerd.pid"
: > "$docker_run/docker/containerd/containerd.sock"
dockerd_serve
`, { PATH: `${bin}:${process.env.PATH}` });
  const proxied = start(GUEST_DOCKER_PROXY_URL);
  expect(proxied.code).toBe(0);
  expect(proxied.read("args").trim()).toBe(`--host unix:///var/run/docker.sock --pidfile ${proxied.dir}/run/docker.pid --group agent`);
  expect(existsSync(join(proxied.dir, "run/docker.pid"))).toBe(false); // half-written: dockerd would refuse it
  expect(existsSync(join(proxied.dir, "run/docker/containerd/containerd.sock"))).toBe(false);
  expect(proxied.read("env")).toContain(`HTTPS_PROXY=${GUEST_DOCKER_PROXY_URL}`);
  const direct = start("");
  expect(direct.read("env")).not.toContain("HTTPS_PROXY");
  expect(direct.read("env")).not.toContain("https_proxy");
});

test("the services log rotates past its size into one old file, its writers going on at the start", () => {
  const run = guest(`
printf '%0150d' 0 > "$DIR/big"; rotate_log "$DIR/big"
printf 'small' > "$DIR/small"; rotate_log "$DIR/small"
rotate_log "$DIR/none"
`);
  expect(run.code).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.read("big")).toBe("");
  expect(run.read("big.1")).toHaveLength(150);
  expect(run.read("small")).toBe("small");
  expect(existsSync(join(run.dir, "small.1"))).toBe(false);
});

test("one supervisor per VM owns both services; dockerd's proxy is the guest proxy only once that is set up", () => {
  expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(GUEST_SERVICES_SCRIPT) }).exitCode).toBe(0);
  expect(GUEST_SERVICES_SCRIPT).not.toContain("set -e");
  expect(GUEST_SERVICES_SCRIPT).toContain('if ! flock -n 9; then touch /run/household-guest-services.ready; exit 0; fi');
  const branch = GUEST_SERVICES_SCRIPT.slice(GUEST_SERVICES_SCRIPT.indexOf("elif proxy_setup"), GUEST_SERVICES_SCRIPT.indexOf("else\n  note"));
  expect(branch).toContain(`docker_proxy=${GUEST_DOCKER_PROXY_URL}`);
  expect(branch).toContain("supervise docker-proxy 'docker-proxy.py serve' proxy_serve");
  expect(GUEST_SERVICES_SCRIPT.match(/docker_proxy=http/g)).toHaveLength(1);
  expect(GUEST_SERVICES_SCRIPT).toContain("no guest proxy, so Docker cannot pull or build");
  expect(GUEST_SERVICES_SCRIPT).toContain("supervise dockerd 'dockerd --host' dockerd_serve >> \"$services_log\" 2>&1 &");
  // Appended, never truncated: a crash's evidence survives the restart.
  expect(GUEST_SERVICES_SCRIPT).not.toMatch(/>\s*\/var\/log\/household-docker\.log/);
});
