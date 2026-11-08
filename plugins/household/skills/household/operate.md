# Running Household

Every command below edits the same config the web UI does and reloads the daemon. `house --help` has them all.

## Looking

```sh
house status                       # the daemon, each pet and its state
house ls                           # keys, secrets, houses, pets, channels (no values)
house show work                    # a house: pets, channels, owners, allowlist, temporary grants
house pet show work assistant      # what runs a pet, its allocation, what it uses now
```

## Pets

```sh
house pet set work assistant --model sonnet --cpus 4 --memory 2   # model, effort, mode restart its VM; cpus/memory apply at its next restart
house pet set work assistant --title Helper --emoji 🦉 --aliases helper,h
house pet restart work assistant   # a fresh session; it saves its work first (--now: at once)
house pet disable work assistant   # stop its VM; files and memory stay. enable starts it again
house pet attach work assistant    # its agent's terminal (Claude pets; detach: Ctrl-b d)
house pet send work assistant "text"            # a message into its queue
house pet instructions work assistant           # its instructions file; … instructions set work assistant <file>
house pet env work assistant                    # its setup / on-start scripts (packages for its VM)
house pet env set work assistant setup <file>   # then: house pet env run work assistant setup
house pet tasks work assistant                  # scheduled prompts; tasks add … --name N --cron '0 9 * * *' --text …
house pet memory work assistant --grep words    # its memory; memory get|set|rm …
house skills work                               # the house's shared skills; skills put work <path> <file>
```

A second channel or more pets in one: `house channel set work <chat> --pets a,b --default a`.
`house pet set … --agent` gives the pet a new VM (its home and memory stay): ask first.

## Network and secrets

```sh
house allow work api.example.com   # house disallow … removes it
house revoke work example.com      # end a temporary grant a pet got from the chat
pbpaste | house secret add github --host api.github.com --env GITHUB_TOKEN --houses work
```

A secret never enters the VM: pets get a placeholder in `$GITHUB_TOKEN`, and the gateway swaps in the value in the
`authorization` header (`--header` for another) of requests to those hosts only.

## Scouts and capabilities

```sh
house features work scouts=on      # the first time: capabilities browser, media, dev and the General scout
house capability ls work           # templates: house capability templates work
house capability add work ffmpeg --install install.sh --network any --description "ffmpeg and yt-dlp"
house capability test work ffmpeg  # its install in a fresh VM: the log's tail, exit 1 on failure
house capability set work ffmpeg --install install.sh   # every save is a revision; capability restore work ffmpeg <rev>
pbpaste | house capability key add work heroku heroku_api --via gateway --host api.heroku.com --env HEROKU_API_KEY
house capability drafts work       # what pets proposed; capability draft show|apply|discard work <id>
house scout add work media --description "Downloads and converts video" --capabilities ffmpeg
house scout settings work --max 2 --agent claude-code-tmux --key claude --model sonnet
house scout run work media --task "Download … as mp3" --wait   # no Run card: the owner's own run
house scout runs work              # then status | logs [-f] | screen | send | cancel  work <run>
```

`--network any` makes a tool; `--network host1,host2` an access capability: a scout that has it reaches only its
capabilities' hosts. List the hosts its install script downloads from too. `--via vm` puts a key's value inside
the scout's VM (needed by CLIs that read it themselves); `--via gateway` keeps it outside, like a house secret.

## Updates

Household is installed at a release tag. To move to the newest one, after reading its notes
(https://github.com/underwear/household/releases) with the user:

```sh
cd ~/household && git fetch --tags
house --version                                        # the release installed now: note it, to go back
git checkout "$(git tag --sort=-v:refname | head -1)"
bun run setup
house migrate                                          # what will migrate (changes nothing)
```

Then restart the daemon (the service, or Ctrl-C and `house start`). On start it copies the config and the
database to `~/.local/state/household/backups/pre-migrate-…` and migrates them; the pets' VMs move to the new release's images (pulled) by themselves.
Check with `house doctor` and `house status`.

To go back: stop the daemon, `git checkout <the previous tag>`, `bun run setup`,
`house migrate restore <backup>` (list: `house migrate backups`), start it. A newer config or database is refused
by an older Household, so the code and the backup go back together.

## Backups

`house export` writes the config (with keys), the database and the pets' homes into one `.tar.gz` (mode 600: treat
it like the keys). `house import <file>` restores it with the daemon stopped (`--force` over an existing setup).
