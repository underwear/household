#!/usr/bin/python3 -I
"""The delegated folder and Git's main checkout, where Claude records project trust."""
import json
import os
import subprocess
import sys

workspace = sys.argv[1]
paths = [workspace, os.path.realpath(workspace)]


def git(*args):
    result = subprocess.run(
        ["git", "-C", workspace, *args],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False,
    )
    return os.fsdecode(result.stdout) if result.returncode == 0 else ""


try:
    top = git("rev-parse", "--show-toplevel").rstrip("\n")
    if top:
        paths.append(os.path.realpath(top))
        gitdir = git("rev-parse", "--absolute-git-dir").rstrip("\n")
        if os.path.isfile(os.path.join(gitdir, "commondir")):
            # Only linked worktrees map trust to the main checkout. A separate
            # git dir alone must not grant trust to an unrelated storage folder.
            # -z preserves spaces, quotes and non-ASCII paths.
            first = git("worktree", "list", "--porcelain", "-z").split("\0", 1)[0]
            if first.startswith("worktree "):
                paths.append(os.path.realpath(first[len("worktree "):]))
except (OSError, subprocess.TimeoutExpired):
    # A folder outside Git still needs its own trust record.
    pass

print(json.dumps(list(dict.fromkeys(paths))))
