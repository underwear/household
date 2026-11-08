"""Household's inbox in mounted pet homes: files saved and swept descriptor-relative, never through guest links."""
import os, sys, json, stat, re, secrets

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
INBOX = ('.household', 'inbox')
DAY = re.compile(r'\d{4}-\d{2}-\d{2}')
# Directories a pet made inside a day's are swept this deep, no deeper.
DEPTH = 8

def directory(path):
    """An existing host directory, by its real path, opened one component at a time."""
    fd = os.open('/', DIR)
    try:
        for part in path.split('/'):
            if not part: continue
            if part in ('.', '..'): raise ValueError('Invalid directory')
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except:
        os.close(fd); raise

def descend(fd, names, create):
    current = os.dup(fd)
    try:
        for name in names:
            if create:
                try: os.mkdir(name, 0o700, dir_fd=current)
                except FileExistsError: pass
            child = os.open(name, DIR, dir_fd=current)
            os.close(current); current = child
        return current
    except:
        os.close(current); raise

def save(q, data):
    """Written to a private temporary file, then linked under its name (never over another file's), atomically."""
    name, day = q['name'], q['day']
    if not DAY.fullmatch(day): raise ValueError('Invalid day')
    if not name or name.startswith('.') or '/' in name or '\0' in name or len(name.encode()) > 200: raise ValueError('Invalid file name')
    home = directory(q['home'])
    try: fd = descend(home, (*INBOX, day), True)
    finally: os.close(home)
    try:
        temp = '.part-' + secrets.token_hex(12)
        f = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(f, 'wb') as out: out.write(data); out.flush(); os.fsync(out.fileno())
            stem, dot, extension = name.rpartition('.')
            for n in range(1, 100):
                final = name if n == 1 else f'{stem}-{n}.{extension}' if dot else f'{name}-{n}'
                try: os.link(temp, final, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError: continue
                return dict(path='/'.join((*INBOX, day, final)))
            raise ValueError('Too many files of that name')
        finally: os.unlink(temp, dir_fd=fd)
    finally: os.close(fd)

def clear(fd, before, depth):
    """Removes files and links older than `before`; a directory too, once empty, if it was untouched since then."""
    removed = 0
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            if info.st_mtime < before:
                os.unlink(name, dir_fd=fd); removed += 1
            continue
        if depth >= DEPTH: continue
        # Its time before it is cleared: removing files makes it new. Today's directory is never stale.
        stale = info.st_mtime < before
        try: inner = os.open(name, DIR, dir_fd=fd)
        except OSError: continue
        try: removed += clear(inner, before, depth + 1)
        finally: os.close(inner)
        if stale:
            try: os.rmdir(name, dir_fd=fd)
            except OSError: pass
    return removed

def sweep(q):
    removed = 0
    for path in q['homes']:
        try: home = directory(path)
        except OSError: continue
        try:
            try: inbox = descend(home, INBOX, False)
            except OSError: continue
        finally: os.close(home)
        try: removed += clear(inbox, q['before'], 0)
        finally: os.close(inbox)
    return dict(removed=removed)

try:
    q = json.loads(sys.argv[1])
    print(json.dumps(save(q, sys.stdin.buffer.read()) if q['op'] == 'save' else sweep(q)))
except ValueError as error: print(json.dumps(dict(error=str(error))))
except OSError: print(json.dumps(dict(error='unsafe or unavailable inbox path')))
