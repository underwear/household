"""Bounded filesystem editor. All traversal is descriptor-relative, never through guest symlinks."""
import os, sys, json, stat, hashlib, secrets

LIMIT = 512 * 1024
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def directory(path, create=False):
    fd = os.open('/', DIR)
    try:
        for part in path.split('/'):
            if not part: continue
            if part in ('.', '..'): raise ValueError('Invalid directory')
            if create:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except:
        os.close(fd); raise

def parts(path):
    items = path.split('/')
    if len(items) < 2 or len(items) > 16 or len(path) > 1024: raise ValueError('Use skill-name/file-name')
    if items[0].startswith('.') or any(not p or p in ('.', '..') or any(ord(c) < 32 or c in '\\' for c in p) for p in items):
        raise ValueError('Invalid skill file path')
    return items

def parent(root, path, create=False):
    items = parts(path)
    fd = os.dup(root)
    try:
        for p in items[:-1]:
            if create:
                try: os.mkdir(p, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(p, DIR, dir_fd=fd)
            os.close(fd); fd = child
        return fd, items[-1]
    except:
        os.close(fd); raise

def read(fd, name):
    f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(f)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError('Only ordinary files can be edited')
        if info.st_size > LIMIT: raise ValueError('File exceeds 512 KiB editor limit')
        data = bytearray()
        while len(data) <= LIMIT:
            chunk = os.read(f, min(65536, LIMIT + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        if len(data) > LIMIT: raise ValueError('File exceeds 512 KiB editor limit')
        return bytes(data), info.st_mode & 0o777
    finally: os.close(f)

def revision(data): return hashlib.sha256(data).hexdigest()

def listing(fd, prefix='', depth=0, result=None):
    if result is None: result = []
    if depth > 15: raise ValueError('Skill tree is too deep')
    names = []
    with os.scandir(fd) as entries:
        for entry in entries:
            if entry.name.startswith('.save-') or (depth == 0 and entry.name.startswith('.')): continue
            if len(names) + len(result) >= 2000: raise ValueError('Skill tree exceeds 2000 entries')
            names.append(entry.name)
    for name in sorted(names):
        if depth == 0 and name.startswith('.'): continue
        if len(result) >= 2000: raise ValueError('Skill tree exceeds 2000 entries')
        path = prefix + name
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 else 'unsupported'
        result.append(dict(path=path, kind=kind, size=info.st_size))
        if kind == 'directory':
            child = os.open(name, DIR, dir_fd=fd)
            try: listing(child, path+'/', depth+1, result)
            finally: os.close(child)
    return result

def run(q):
    root = directory(q['root'], True)
    try:
        if q['op'] == 'list': return listing(root)
        if q['op'] == 'ensure': return {}
        fd, name = parent(root, q['path'], q['op'] == 'write' and q.get('revision') is None)
        try:
            try: data, mode = read(fd, name)
            except FileNotFoundError: data, mode = None, 0o600
            if q['op'] == 'read':
                if data is None: raise FileNotFoundError()
                content = data.decode('utf-8')
                if '\x00' in content: raise ValueError('Binary files cannot be edited')
                return dict(path=q['path'], content=content, revision=revision(data))
            if (revision(data) if data is not None else None) != q.get('revision'):
                return dict(error='File changed since it was opened. Reload it before saving.', status=409)
            if q['op'] == 'delete':
                if data is None: raise FileNotFoundError()
                os.unlink(name, dir_fd=fd)
                # Remove empty parents, never following a link or removing nonempty sibling data.
                items = parts(q['path'])
                for count in range(len(items)-1, 0, -1):
                    owner = os.dup(root)
                    try:
                        for component in items[:count-1]:
                            child = os.open(component, DIR, dir_fd=owner)
                            os.close(owner); owner = child
                        try: os.rmdir(items[count-1], dir_fd=owner)
                        except OSError: break
                    finally: os.close(owner)
                return {}
            content = q['content'].encode('utf-8')
            if len(content) > LIMIT or b'\x00' in content: raise ValueError('Use UTF-8 text up to 512 KiB')
            temp = '.save-' + secrets.token_hex(12)
            f = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
            try:
                with os.fdopen(f, 'wb') as stream:
                    stream.write(content); stream.flush(); os.fsync(stream.fileno())
                os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            finally:
                try: os.unlink(temp, dir_fd=fd)
                except FileNotFoundError: pass
            return dict(path=q['path'], content=q['content'], revision=revision(content))
        finally: os.close(fd)
    finally: os.close(root)

try:
    print(json.dumps(run(json.load(sys.stdin))))
except FileNotFoundError: print(json.dumps(dict(error='Skill file not found', status=404)))
except (ValueError, UnicodeError) as e: print(json.dumps(dict(error=str(e), status=400)))
except OSError: print(json.dumps(dict(error='Unsafe or unavailable skill path', status=400)))
