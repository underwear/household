/**
 * Runs as the guest user before setup and the harness, at every VM start. One place per level holds the files and
 * every harness Household knows reads it through a link, so a pet keeps its skills when its agent changes:
 *
 * - shared: each harness's user skills directory (`HOUSEHOLD_SKILLS_LINKS`, `~/.claude/skills`, `~/.agents/skills`)
 *   is a link to the house's shared skills;
 * - personal (a pet's own, not a sideworker's): `~/work/.agents/skills` (`HOUSEHOLD_WORKSPACE_SKILLS`) holds them,
 *   and each other harness's project skills directory there (`HOUSEHOLD_WORKSPACE_SKILLS_LINKS`) is a link to it.
 *   A real directory found in a link's place gives its skills to the real one, then moves aside;
 * - built-in: Household's own (read-only, `/opt/household/builtin-skills`) are linked into the shared ones as
 *   `household-<name>`. Anything else under a `household-` name there is moved aside.
 *
 * What stood in the way is never deleted: it moves next to where it was, renamed `….before-household-<time>`, or,
 * inside a skills directory (where a renamed skill would still load), into its hidden `.household-aside/`. Only the
 * shared link is required; a failure with the others is reported and the VM starts anyway.
 */
export const GUEST_SKILLS_SETUP = String.raw`
import os, pathlib, sys, time
primary = os.environ.get('HOUSEHOLD_SKILLS_DIRECTORY')
if not primary:
    raise SystemExit(0)
home = pathlib.Path.home()
shared = pathlib.Path('/opt/household/skills')
builtin = pathlib.Path('/opt/household/builtin-skills')
if not shared.is_dir():
    raise RuntimeError('House skills mount is missing')
def stamp():
    return '.before-household-' + str(time.time_ns())
def aside(path, into=None):
    try:
        if into is None:
            path.rename(path.with_name(path.name + stamp()))
        else:
            into.mkdir(exist_ok=True)
            path.rename(into / (path.name + stamp()))
    except FileNotFoundError:
        pass  # gone already: another VM of the house moved it at the same moment
def link(path, target, into=None):
    try:
        if path.is_symlink() and os.readlink(path) == str(target):
            return
    except FileNotFoundError:
        pass
    if path.is_symlink() or path.exists():
        aside(path, into)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.symlink_to(target, target_is_directory=True)
    except FileExistsError:
        pass  # another VM of the house linked it at the same moment
def dirs(name):
    return [item for item in os.environ.get(name, '').split(':') if item]
def report(what, error):
    print('household skills: ' + what + ': ' + str(error), file=sys.stderr)

# Shared: required.
for directory in dict.fromkeys([primary, *dirs('HOUSEHOLD_SKILLS_LINKS')]):
    link(home / directory, shared)

# Personal: a pet's own folder, which every harness reads.
workspace = os.environ.get('HOUSEHOLD_WORKSPACE_SKILLS')
if workspace:
    try:
        own = home / workspace
        own.mkdir(parents=True, exist_ok=True)
        for directory in dirs('HOUSEHOLD_WORKSPACE_SKILLS_LINKS'):
            path = home / directory
            if path.is_dir() and not path.is_symlink():
                for skill in list(path.iterdir()):
                    if not (own / skill.name).exists() and not (own / skill.name).is_symlink():
                        skill.rename(own / skill.name)
            link(path, os.path.relpath(own, path.parent))
    except OSError as error:
        report('personal skills', error)

# Built-in: Household's own, and nothing else under their prefix.
try:
    if builtin.is_dir():
        names = {item.name for item in builtin.iterdir() if item.name.startswith('household-') and (item / 'SKILL.md').is_file()}
        for name in sorted(names):
            link(shared / name, builtin / name, shared / '.household-aside')
        for item in list(shared.iterdir()):
            if item.name.startswith('household-') and item.name not in names:
                if item.is_symlink() and os.readlink(item).startswith(str(builtin) + '/'):
                    item.unlink(missing_ok=True)
                else:
                    aside(item, shared / '.household-aside')
except OSError as error:
    report('built-in skills', error)
`;
