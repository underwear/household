/**
 * Fixed read-only probe, no installed daemon and no model turn. Never reads processes/env/credentials. A guest
 * service's health is whether its socket takes a connection (none is sent anything); null where the image has none.
 */
export const GUEST_METRICS = `import json, os, shutil, socket
from pathlib import Path
cpus = []
for line in Path('/proc/stat').read_text().splitlines():
    parts = line.split()
    if parts and (parts[0] == 'cpu' or parts[0][3:].isdigit() and parts[0].startswith('cpu')):
        values = list(map(int, parts[1:9]))
        cpus.append(dict(id=parts[0], total=sum(values), idle=values[3]+values[4]))
memory = {}
for line in Path('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    if key in ('MemTotal', 'MemAvailable'):
        memory[key] = int(value.split()[0])*1024
mounts = {line.split()[4] for line in Path('/proc/self/mountinfo').read_text().splitlines()}
def disk(path):
    if path not in mounts: return None
    try:
        value = os.statvfs(path)
        return dict(total=value.f_blocks*value.f_frsize, used=(value.f_blocks-value.f_bfree)*value.f_frsize, available=value.f_bavail*value.f_frsize)
    except OSError: return None
def health(family, address):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.settimeout(.5)
            probe.connect(address)
        return 'up'
    except OSError: return 'down'
docker = shutil.which('dockerd') is not None
print(json.dumps(dict(boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip(), cpus=cpus,
    memory=dict(total=memory['MemTotal'], available=memory['MemAvailable']),
    load=list(map(float, Path('/proc/loadavg').read_text().split()[:3])),
    disks=dict(system=disk('/'), docker=disk('/var/lib/docker')),
    services=dict(docker=health(socket.AF_UNIX, '/var/run/docker.sock') if docker else None,
        proxy=health(socket.AF_INET, ('169.254.254.1', 3128)) if docker else None))))
`;
