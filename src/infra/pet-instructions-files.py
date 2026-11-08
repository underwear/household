"""One instruction document per mounted pet home; never traverse guest-controlled links."""
import os, sys, json, stat, hashlib, secrets, fcntl, posixpath
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
LIMIT = 32768

def directory(path):
    fd = os.open('/', DIR)
    try:
        for part in path.split('/'):
            if not part: continue
            if part in ('.', '..'): raise ValueError('Invalid directory')
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except:
        os.close(fd); raise

def parent(root, path):
    parts = path.split('/')
    if len(parts) > 8 or any(not p or p in ('.', '..') or '\\' in p for p in parts): raise ValueError('Invalid instruction path')
    fd = os.dup(root)
    try:
        for p in parts[:-1]:
            try: os.mkdir(p, 0o700, dir_fd=fd)
            except FileExistsError: pass
            child = os.open(p, DIR, dir_fd=fd)
            os.close(fd); fd = child
        return fd, parts[-1]
    except:
        os.close(fd); raise

def read(fd, name):
    try: f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError: return None
    try:
        info = os.fstat(f)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: raise ValueError('Instructions must be an ordinary file')
        data = os.read(f, LIMIT + 1)
        if info.st_size > LIMIT or len(data) > LIMIT or b'\0' in data: raise ValueError('Use UTF-8 text up to 32 KiB')
        data.decode('utf-8')
        return data
    finally: os.close(f)

def write(fd, name, data):
    temp = '.save-' + secrets.token_hex(12)
    try:
        f = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(f, 'wb') as out: out.write(data); out.flush(); os.fsync(out.fileno())
        os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try: os.unlink(temp, dir_fd=fd)
        except FileNotFoundError: pass

def revision(data): return hashlib.sha256(data).hexdigest()

def run(q):
    root = directory(q['home'])
    canonical, name = parent(root, '.household/AGENTS.md')
    lock = os.open('.instructions.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=canonical)
    try:
        if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_nlink != 1: raise ValueError('Unsafe instruction lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        for override in q.get('overrides', []):
            fd, leaf = parent(root, override)
            try:
                try: os.stat(leaf, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError: continue
                raise ValueError('An instruction override exists; remove it before using the editor')
            finally: os.close(fd)
        native, leaf = parent(root, q['target'])
        try:
            target = posixpath.relpath('.household/AGENTS.md', posixpath.dirname(q['target']) or '.')
            try: info = os.stat(leaf, dir_fd=native, follow_symlinks=False)
            except FileNotFoundError: info = None
            linked = info and stat.S_ISLNK(info.st_mode)
            if linked and os.readlink(leaf, dir_fd=native) != target: raise ValueError('Existing instruction link needs manual migration')
            old = read(native, leaf) if info and not linked else None
            data = read(canonical, name)
            if data is None:
                data = old if old is not None else q['default'].encode('utf-8')
                write(canonical, name, data)
            elif old is not None and old != data:
                raise ValueError('Existing native instructions differ; original files were retained')
            if not linked:
                if old is not None:
                    os.rename(leaf, leaf + '.before-household-' + secrets.token_hex(8), src_dir_fd=native, dst_dir_fd=native)
                os.symlink(target, leaf, dir_fd=native)
            if q['op'] == 'write':
                if q['revision'] != revision(data): return dict(error='File changed since it was opened. Reload before saving.', status=409)
                data = q['content'].encode('utf-8')
                if len(data) > LIMIT or b'\0' in data: raise ValueError('Use UTF-8 text up to 32 KiB')
                write(canonical, name, data)
            return dict(content=data.decode('utf-8'), revision=revision(data), path=q['target'])
        finally: os.close(native)
    finally: os.close(lock); os.close(canonical); os.close(root)

try: print(json.dumps(run(json.load(sys.stdin))))
except (ValueError, UnicodeError) as error: print(json.dumps(dict(error=str(error), status=400)))
except OSError: print(json.dumps(dict(error='Unsafe or unavailable instruction path', status=400)))
