"""Read a regular outbox file through descriptors; never resolve guest links on the host."""
import os, sys, json, stat

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def read(q):
    parts = q['path'].split('/')
    if any(part in ('', '.', '..') or '\0' in part for part in parts):
        raise ValueError('Invalid outbox path')
    fd = os.open('/', DIR)
    try:
        for part in [p for p in q['home'].split('/') if p] + ['.household', 'outbox'] + parts[:-1]:
            if part in ('.', '..'): raise ValueError('Invalid outbox path')
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd); fd = child
        file = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(file)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError('Outbox file must be a regular file, not a link or special file')
            if before.st_size > q['maxBytes']:
                raise ValueError('Outbox file exceeds the size limit')
            with os.fdopen(file, 'rb', closefd=False) as source:
                data = source.read(q['maxBytes'] + 1)
            if len(data) > q['maxBytes']:
                raise ValueError('Outbox file exceeds the size limit')
            after = os.fstat(file)
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('Outbox file changed while reading; finish writing it before sending')
            return data
        finally: os.close(file)
    finally: os.close(fd)

try:
    sys.stdout.buffer.write(read(json.loads(sys.argv[1])))
except ValueError as error:
    print(str(error), file=sys.stderr); sys.exit(1)
except OSError:
    print('unsafe or unavailable outbox path', file=sys.stderr); sys.exit(1)
