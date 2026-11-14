#!/usr/bin/python3 -I
"""Launch Claude inside its tmux pane without sending large arguments through tmux IPC."""
import json
import os
import sys

path = sys.argv[1]
try:
    with open(path) as source:
        launch = json.load(source)
finally:
    os.unlink(path)

# Use the entrypoint's current configuration even if another command started tmux
# earlier. Keep the terminal identity that tmux assigned to this new pane.
env = launch["env"]
for name in ("TERM", "TMUX", "TMUX_PANE"):
    if name in os.environ:
        env[name] = os.environ[name]
os.execvpe(launch["argv"][0], launch["argv"], env)
