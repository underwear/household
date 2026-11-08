import { test, expect } from "bun:test";
import { GUEST_DOCKER_PROXY_FUNCTIONS, GUEST_DOCKER_PROXY_URL } from "../../src/infra/guest-docker-network";

// Exercise the shipped Python server with real sockets, including upstream-enforced closure.
test("guest Docker proxy forwards only through authenticated upstream and preserves policy targets", async () => {
  const code = String.raw`
import asyncio, base64, importlib.util, json, pathlib, tempfile
from urllib.parse import urlsplit
spec = importlib.util.spec_from_file_location('bridge', 'src/infra/guest-docker-proxy.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

async def main():
    requests = []
    async def upstream(reader, writer):
        data = await bridge.header(reader)
        requests.append(data)
        assert b'Proxy-Authorization: Basic ' + base64.b64encode(b'household:private-test-capability') in data
        assert b'client-auth' not in data
        if b'denied.test' in data:
            writer.write(b'HTTP/1.1 403 Forbidden\r\nPrivate: private-test-capability\r\n\r\n')
        else:
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await writer.drain()
            if b'plain.test:80' in data:
                forwarded = await bridge.header(reader)
                assert forwarded.startswith(b'GET /path?q=yes HTTP/1.1\r\n')
                assert b'Host: plain.test:80\r\n' in forwarded
                assert b'Proxy-Authorization' not in forwarded
                assert b'X-Discard' not in forwarded
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')
            else:
                data = await reader.readexactly(4)
                writer.write(data)
                await writer.drain()
                # Simulate host revocation/TTL without waiting for the client to close.
        await writer.drain()
        writer.close()
    host = await asyncio.start_server(upstream, '127.0.0.1', 0)
    upstream_url = urlsplit('http://household:private-test-capability@127.0.0.1:' + str(host.sockets[0].getsockname()[1]))
    server = await asyncio.start_server(lambda r,w: bridge.handle(r,w,upstream_url), '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    writer.write(b'CONNECT allowed.test:443 HTTP/1.1\r\nProxy-Authorization: client-auth\r\n\r\nPING')
    await writer.drain()
    assert b'200' in await bridge.header(reader)
    assert await reader.readexactly(4) == b'PING'
    assert await asyncio.wait_for(reader.read(), 1) == b''
    writer.close()
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    writer.write(b'GET http://plain.test/path?q=yes HTTP/1.1\r\nHost: wrong.test\r\nProxy-Authorization: client-auth\r\nConnection: X-Discard\r\nX-Discard: unsafe\r\n\r\n')
    await writer.drain()
    assert (await asyncio.wait_for(reader.read(), 1)).endswith(b'OK')
    writer.close()
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    writer.write(b'CONNECT denied.test:443 HTTP/1.1\r\n\r\n')
    await writer.drain()
    response = await asyncio.wait_for(reader.read(), 1)
    assert b'403 Forbidden' in response
    assert b'private-test-capability' not in response
    writer.close()
    assert requests[0].startswith(b'CONNECT allowed.test:443 ')
    assert requests[1].startswith(b'CONNECT plain.test:80 ')
    server.close(); host.close()
    await server.wait_closed(); await host.wait_closed()

asyncio.run(main())
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / '.docker' / 'config.json'
    path.parent.mkdir()
    path.write_text(json.dumps({'auths': {'registry.test': {'auth': 'keep-me'}}, 'credsStore': 'keep-helper', 'proxies': {'unix:///var/run/docker.sock': {'httpsProxy': 'http://private-test-capability@old.invalid'}}}))
    bridge.configure([str(path)])
    document = json.loads(path.read_text())
    assert document['auths']['registry.test']['auth'] == 'keep-me'
    assert document['credsStore'] == 'keep-helper'
    assert document['proxies']['default']['httpsProxy'] == bridge.ENDPOINT
    assert document['proxies']['unix:///var/run/docker.sock']['httpsProxy'] == bridge.ENDPOINT
    assert 'private-test-capability' not in path.read_text()
    path.write_text('malformed-json-preserved')
    try:
        bridge.configure([str(path)])
        raise AssertionError('malformed JSON accepted')
    except ValueError:
        pass
    assert path.read_text() == 'malformed-json-preserved'
    path.unlink(); path.symlink_to(path.parent / 'victim')
    try:
        bridge.configure([str(path)])
        raise AssertionError('symlink accepted')
    except ValueError:
        pass
`;
  const result = Bun.spawnSync(["python3", "-B", "-c", code], { cwd: process.cwd() });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("guest Docker proxy startup keeps the upstream credential out of client configuration and argv", () => {
  expect(GUEST_DOCKER_PROXY_URL).toBe("http://169.254.254.1:3128");
  expect(GUEST_DOCKER_PROXY_FUNCTIONS).toContain('HOUSEHOLD_UPSTREAM_PROXY="$upstream" exec python3 /etc/household/docker-proxy.py serve');
  expect(GUEST_DOCKER_PROXY_FUNCTIONS).toContain("ip address add 169.254.254.1/32 dev lo");
  expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(GUEST_DOCKER_PROXY_FUNCTIONS) }).exitCode).toBe(0);
});

test("the Docker client proxy goes in the agent's own home: a sideworker's, not its parent's shared one", () => {
  const setup = GUEST_DOCKER_PROXY_FUNCTIONS.slice(GUEST_DOCKER_PROXY_FUNCTIONS.indexOf("proxy_setup()"), GUEST_DOCKER_PROXY_FUNCTIONS.indexOf("proxy_serve()"));
  expect(setup).toContain("[ -d /home/worker ] && user_home=/home/worker");
  expect(setup).toContain('configure "$user_home/.docker/config.json"');
  expect(setup).not.toContain("/home/agent/.docker/config.json"); // the parent's is left to the parent
});
