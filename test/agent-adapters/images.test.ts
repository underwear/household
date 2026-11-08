import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeTmux } from "../../src/agent-adapters/claude-code-tmux";
import { codexAppServer } from "../../src/agent-adapters/codex-app-server";

// What every pet image is built from, read from its Dockerfile: no image is built here.
const adapters = [claudeCodeTmux, codexAppServer];
const file = (adapter: (typeof adapters)[number], name: string) => readFileSync(join(adapter.imageContext, name), "utf8");

test("each image starts from a base pinned by digest, named in one place", () => {
  for (const adapter of adapters) {
    const dockerfile = file(adapter, "Dockerfile");
    expect(dockerfile).toMatch(/^ARG BASE_IMAGE=[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/m);
    const froms = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) expect(from).toMatch(/^FROM \$\{BASE_IMAGE\}( AS \w+)?$/);
  }
});

test("Docker comes from Docker's repository at pinned versions, its key checked against Docker's fingerprint", () => {
  for (const adapter of adapters) {
    const dockerfile = file(adapter, "Dockerfile");
    expect(dockerfile).toContain("ARG DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88");
    expect(dockerfile).toContain('test "$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc');
    const install = dockerfile.slice(dockerfile.indexOf('"docker-ce='), dockerfile.indexOf("&& usermod -aG docker"));
    for (const name of ["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"]) {
      expect(install).toContain(`"${name}=`);
    }
    expect(install.match(/"[a-z.-]+=/g)).toHaveLength(5); // nothing of Docker's unpinned
  }
});

test("containers' logs rotate: each image ships the same daemon.json with json-file size limits", () => {
  const config = JSON.parse(file(claudeCodeTmux, "docker-daemon.json"));
  expect(config).toEqual({ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } });
  for (const adapter of adapters) {
    expect(JSON.parse(file(adapter, "docker-daemon.json"))).toEqual(config);
    expect(file(adapter, "Dockerfile")).toContain("COPY --chmod=644 docker-daemon.json /etc/docker/daemon.json");
  }
});

test("claude is the release binary of its pinned version, checked against that release's checksums", () => {
  const dockerfile = file(claudeCodeTmux, "Dockerfile");
  expect(dockerfile).not.toContain("install.sh");
  expect(dockerfile).toMatch(/^ARG CLAUDE_SHA256_ARM64=[0-9a-f]{64}$/m);
  expect(dockerfile).toMatch(/^ARG CLAUDE_SHA256_X64=[0-9a-f]{64}$/m);
  expect(dockerfile).toContain('echo "$checksum  /claude" | sha256sum -c -');
});

test("codex and everything it pulls in install from a committed lockfile", () => {
  const dockerfile = file(codexAppServer, "Dockerfile");
  expect(dockerfile).not.toContain("bun add --cwd"); // an install that resolves versions at build time
  expect(dockerfile).toContain("COPY codex/package.json codex/bun.lock /opt/codex/");
  expect(dockerfile).toContain("bun install --cwd /opt/codex --frozen-lockfile --production");
  const version = JSON.parse(file(codexAppServer, "codex/package.json")).dependencies["@openai/codex"];
  expect(version).toMatch(/^\d+\.\d+\.\d+$/); // exact, not a range
  const lock = file(codexAppServer, "codex/bun.lock");
  expect(lock).toContain(`"@openai/codex": ["@openai/codex@${version}"`);
  for (const platform of ["linux-arm64", "linux-x64"]) expect(lock).toMatch(new RegExp(`"@openai/codex-${platform}": \\["@openai/codex@${version}-${platform}", "", \\{[^}]*\\}, "sha512-`));
});
