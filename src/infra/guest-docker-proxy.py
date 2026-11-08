"""Guest-only adapter: every outbound socket goes to Household's authenticated host proxy.
No target DNS lookup or direct fallback is permitted here. Policy and tunnel lifetime
remain the host proxy's responsibility. Nothing supplied by a client is an upstream credential.
"""
import asyncio
import base64
import json
import os
import pathlib
import sys
import tempfile
from urllib.parse import urlsplit, unquote

ENDPOINT = 'http://169.254.254.1:3128'
LIMIT = 32768

async def header(reader):
    data = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 20)
    if len(data) > LIMIT:
        raise ValueError('large header')
    return data


def request(data):
    lines = data.decode('iso-8859-1').split('\r\n')
    method, target, version = lines[0].split(' ')
    if version not in ('HTTP/1.0', 'HTTP/1.1'):
        raise ValueError('version')
    headers = []
    for line in lines[1:-2]:
        name, value = line.split(':', 1)
        if not name or any(c.isspace() for c in name):
            raise ValueError('header')
        headers.append((name, value.strip()))
    if method == 'CONNECT':
        parsed = urlsplit('http://' + target)
        if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password or not parsed.hostname or not parsed.port:
            raise ValueError('target')
        return target, None
    parsed = urlsplit(target)
    if parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('target')
    port = parsed.port or 80
    host = '[' + parsed.hostname + ']' if ':' in parsed.hostname else parsed.hostname
    authority = host + ':' + str(port)
    blocked = {'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'host'}
    for name, value in headers:
        if name.lower() == 'connection':
            blocked.update(part.strip().lower() for part in value.split(','))
    path = parsed.path or '/'
    if parsed.query:
        path += '?' + parsed.query
    outgoing = [f'{method} {path} {version}', f'Host: {authority}', 'Connection: close']
    outgoing += [name + ': ' + value for name, value in headers if name.lower() not in blocked]
    return authority, ('\r\n'.join(outgoing) + '\r\n\r\n').encode('iso-8859-1')


async def pump(reader, writer):
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            if writer.can_write_eof():
                writer.write_eof()
            return
        writer.write(chunk)
        await writer.drain()


async def handle(client, downstream, upstream_url):
    upstream = None
    sender = None
    established = False
    try:
        authority, plain = request(await header(client))
        upstream_reader, upstream = await asyncio.wait_for(asyncio.open_connection(upstream_url.hostname, upstream_url.port or 80, limit=LIMIT), 15)
        credentials = unquote(upstream_url.username or '') + ':' + unquote(upstream_url.password or '')
        authorization = base64.b64encode(credentials.encode()).decode()
        upstream.write(f'CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: Basic {authorization}\r\n\r\n'.encode())
        await upstream.drain()
        response = await header(upstream_reader)
        status = response.split(b'\r\n', 1)[0].split(b' ')
        if len(status) < 2 or status[1] != b'200':
            # Do not relay upstream diagnostics or proxy authentication challenges.
            code = b'403 Forbidden' if len(status) > 1 and status[1] == b'403' else b'502 Bad Gateway'
            downstream.write(b'HTTP/1.1 ' + code + b'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            await downstream.drain()
            return
        established = True
        if plain is None:
            downstream.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await downstream.drain()
        else:
            upstream.write(plain)
            await upstream.drain()
        async def send_client():
            try:
                await pump(client, upstream)
            except Exception:
                # A reset client must not retain an authenticated host tunnel.
                upstream.close()
        sender = asyncio.create_task(send_client())
        # Upstream EOF (including host TTL/revoke) always closes the client immediately.
        await pump(upstream_reader, downstream)
    except (Exception, asyncio.CancelledError):
        if not established:
            downstream.write(b'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    finally:
        if sender:
            sender.cancel()
        if upstream:
            upstream.close()
        downstream.close()


def configure(paths):
    for location in paths:
        path = pathlib.Path(location)
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('unsafe Docker client configuration')
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        document = json.loads(path.read_text()) if path.exists() else {}
        proxies = document.setdefault('proxies', {})
        settings = {'httpProxy': ENDPOINT, 'httpsProxy': ENDPOINT, 'noProxy': 'localhost,127.0.0.1,::1'}
        for daemon in ('default', 'unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
            proxies[daemon] = settings
        # Unique files permit recovery after an interrupted prior configuration write.
        descriptor, temporary_name = tempfile.mkstemp(prefix='.household-config-', dir=path.parent)
        temporary = pathlib.Path(temporary_name)
        try:
            with os.fdopen(descriptor, 'w') as stream:
                json.dump(document, stream)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


async def serve():
    proxy = urlsplit(os.environ['HOUSEHOLD_UPSTREAM_PROXY'])
    if proxy.scheme != 'http' or not proxy.hostname or not proxy.username or not proxy.password:
        raise ValueError('invalid upstream')
    server = await asyncio.start_server(lambda r, w: handle(r, w, proxy), '169.254.254.1', 3128, limit=LIMIT)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'configure':
            configure(sys.argv[2:])
        elif sys.argv[1] == 'serve':
            asyncio.run(serve())
        else:
            raise ValueError('command')
    except Exception:
        # Private proxy URLs and request content must never appear in diagnostics.
        sys.exit('Guest proxy initialization failed')
