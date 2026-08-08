---
name: jotta-cli
description: >
  Procedural skill for the Jottacloud CLI (`jotta-cli`). Use when managing
  Jotta Cloud backups, Archive uploads, Sync folders, downloads, remote file
  browsing, shares, trash, webhooks, logs/status triage, `jottad` pause/resume,
  ignore rules, or multi-instance host config. Triggers include any request to
  back up files to Jottacloud, upload to Archive, sync a local folder with
  Jottacloud, download from Jottacloud remotely, list or browse cloud paths,
  share files via public links, manage the remote trash, configure scan
  intervals or rate limits, set up webhooks, tail logs, diagnose backup/sync
  problems, or install/update `jotta-cli` itself. Also use for configuring a
  remote machine's `jottad` over SSH by setting `--host`/`--port`. Prefer
  `jotta-cli` over the web UI for scripted or repeatable operations.
tagline: Jottacloud CLI — backups, archive, sync, downloads, shares, trash
last-updated: 2026-08-08
---

# jotta-cli

Command-line client for [Jottacloud](https://www.jottacloud.com) — manages the
local `jottad` daemon and its remote namespaces (Backup, Archive, Sync, Photos,
Trash). Install: `brew install jotta-cli`.

## Prerequisites

- `jotta-cli` installed (on Dan's Mac: `/opt/homebrew/bin/jotta-cli`, observed
  version **0.17.159692**).
- `jottad` running on the target host (default `--host=127.0.0.1 --port=14443`).
- Logged in via a one-time Personal Login Token from Jottacloud account
  settings → Security tab.
- Appdata + logfile under `~/.jottad/` (e.g.
  `/Users/dansmart/.jottad/jottabackup.log`).

## Mental model

```
you → CLI → jotta-cli ⇄ gRPC ⇄ jottad ⇄ HTTPS ⇄ Jottacloud cloud
                          │                       │
                     host/port              remote namespaces
                          └───────────────────┘
```

- `jotta-cli` is a thin client; **`jottad` does the real work** (scanning,
  uploading, downloading). Commands that touch the network run asynchronously —
  use `observe`, `list uploads/downloads`, or `tail` to watch progress.
- Remote namespace roots (visible at `jotta-cli ls` with no args):

  | Root      | Purpose                                                        |
  | --------- | -------------------------------------------------------------- |
  | `Backup`  | Continuous, versioned backup of added local folders            |
  | `Archive` | One-shot uploads (`jotta-cli archive`) — manual, on-demand     |
  | `Sync`    | Bidirectional folder sync (setup → start)                      |
  | `Photos`  | Photo vault                                                    |
  | `Trash`   | Remote trashcan — deleted items retained ~30 days before purge |

- **Backup** = periodic scan of added folders, incremental upload, versioned.
- **Archive** = explicit one-shot upload to `Archive/<device>/<path>`.
- **Sync** = bidirectional mirror of a local root ↔ remote Sync folder.

## Safe discovery commands

Run these first to orient yourself — none are destructive:

```bash
jotta-cli --help                         # top-level help
jotta-cli version                        # daemon + client versions
jotta-cli status                         # account, device, usage summary
jotta-cli status --json                  # machine-readable status
jotta-cli logfile                        # path to the jottad log file
jotta-cli ls                             # list remote namespace roots
jotta-cli ls --json                      # JSON output of root listing
jotta-cli ls -l Backup                   # one-line detail for a path
jotta-cli list downloads                 # queued / ongoing / finished
jotta-cli list downloads --json          # structured download info
jotta-cli list uploads                   # queued / ongoing / finished
jotta-cli share --list                   # currently shared files
jotta-cli webhook list                   # configured webhooks
```

## Common workflows

### Login

1. Go to Jottacloud account → Security tab → generate a **Personal Login
   Token** (single-use, short-lived).
2. `jotta-cli login` — paste the token when prompted, then name the device.

### Status & log triage

```bash
jotta-cli status                          # quick human summary
jotta-cli status --json | jq .User.Email  # scripted checks
jotta-cli logfile                         # where the log lives
jotta-cli tail                            # stream log until Ctrl-C
jotta-cli observe                         # watch uploads + downloads live
jotta-cli observe --downloads             # downloads only
jotta-cli observe --sync                  # sync folder activity
```

### Browse remote paths

```bash
jotta-cli ls                              # top-level namespaces
jotta-cli ls Backup                       # contents of Backup/
jotta-cli ls -l Backup/DeviceName         # one-line detail view
jotta-cli ls --json Backup/Sync           # machine-readable listing
```

> At root, `jotta-cli ls` lists the five namespace roots (Archive, Backup,
> Photos, Sync, Trash). Deeper paths require the full `Namespace/Device/Folder`
> form, e.g. `Backup/Dans-M4-laptop.local/Documents`.

### Add / remove continuous backups

```bash
jotta-cli add /path/to/folder             # start backing up a folder
jotta-cli add /path/to/folder --name MyName  # override remote name
jotta-cli rem /path/to/folder             # stop backing up (NOT delete remote)
jotta-cli scan                            # trigger scan of all backup folders
jotta-cli scan FolderName                 # best-effort match on folder name
```

> `rem` stops _future_ backup uploads but **does not** delete the remote copy.
> Remote backups are managed via the Jottacloud web UI. Deleted backup files go
> to Jottacloud Trash for ~30 days before permanent removal.

### Ignore rules

```bash
jotta-cli ignores add --pattern "*.log" --backup /path/to/backup
jotta-cli ignores add --pattern "**/.DS_Store"   # applies to all backups
jotta-cli ignores list --backup /path/to/backup
jotta-cli ignores rem  --pattern "*.log" --backup /path/to/backup
jotta-cli ignores test --pattern "*.log" --path "some/file.log"
```

Patterns are relative to the backup root; leading `/` is ignored. Hardcoded
patterns (`**.DS_Store`, `**.Thumbs.db`, `**.desktop.ini`) cannot be removed.
Use quotes around glob patterns to avoid shell expansion.

### Archive / upload (one-shot)

```bash
jotta-cli archive file                    # upload to Archive/<device>/file
jotta-cli archive folder --remote=my/folder  # put under Archive/my/folder
jotta-cli archive file --nogui            # suppress GUI dialog
jotta-cli archive file --share --clipboard  # upload + share + copy link
cat file | jotta-cli archive -I --remote=remote/path  # stdin upload
jotta-cli archive --abort=<uploadid>      # cancel an in-flight folder upload
jotta-cli archive --clear=all             # clear upload history (irreversible)
```

Folder uploads run in the background and appear in `list uploads`.

### Download

```bash
jotta-cli download Archive/something ~/Downloads/
jotta-cli download Backup/Device/folder /existing/folder --merge
jotta-cli download -O Archive/file        # write file to stdout
jotta-cli download --abort=<dlid>         # abort ongoing download
jotta-cli download --retry=<dlid>         # retry failed files from a download
jotta-cli download --clear=all            # clear download history (irreversible)
jotta-cli list downloaderrors --downloadid=<dlid>  # error details
```

The download ID is printed after metadata gathering completes, or via
`jotta-cli list downloads`.

### Sync (bidirectional folder sync)

> **Gotcha:** On Dan's observed account `sync` was not set up — `status`
> reports "Sync is not enabled". If setup fails silently, verify with
> `jotta-cli status` and `jotta-cli sync log`.

```bash
jotta-cli sync setup --root /local/path  # local root must already exist
jotta-cli sync start                     # begin automatic syncing
jotta-cli sync stop                      # pause syncing
jotta-cli sync trigger                   # one-shot sync in triggered mode
jotta-cli sync selective add FolderName  # exclude a top-level folder
jotta-cli sync selective remove FolderName
jotta-cli sync log -n 20                 # last 20 changes
jotta-cli sync log --watch               # stream changes until Ctrl-C
jotta-cli sync configure --help          # tune sync settings
jotta-cli sync reset                     # erase sync state (requires re-setup)
```

### Pause / resume

```bash
jotta-cli pause 1h                       # pause jottad for 1 hour
jotta-cli pause 6h30m                    # pause for 6 h 30 min
jotta-cli pause --backup /path/to/backup # pause one backup indefinitely
jotta-cli resume                         # resume jottad
jotta-cli resume --backup /path/to/backup
```

Alternatively via config: `jotta-cli config backuppaused true|false`,
`jotta-cli config syncpaused true|false`.

### Config tuning

```bash
jotta-cli config                         # dump all settings
jotta-cli config scaninterval 30m        # scan every 30 min (default 1h)
jotta-cli config uploadrate 50m          # cap uploads at 50 MB/s
jotta-cli config downloadrate 0          # unlimited downloads
jotta-cli config maxdownloads 6          # concurrent downloads (default 6)
jotta-cli config maxuploads 6            # concurrent uploads (default 6)
jotta-cli config logtransfers true       # log uploads/downloads to logfile
jotta-cli config proxy user:pass@host:port
```

Units: rates use `k/KB/kb` = 1000 bytes, `m/MB/mb` = 1000 KB; time uses `10m`,
`5h30m`.

### Webhooks

```bash
jotta-cli webhook add http://host:port/hook
jotta-cli webhook list
jotta-cli webhook rem http://host:port/hook
jotta-cli config set webhookstatusinterval 6h
```

Event notifications fire on jottad start/stop and critical errors; the status
interval posts a full status dump at the configured cadence.

### Trash

```bash
jotta-cli trash list                     # contents of remote trashcan
jotta-cli trash restore /Trash/path      # restore one item
jotta-cli trash purge /Trash/path        # permanently delete one item
jotta-cli trash purge --force            # Nuke the entire trashcan (⚠️)
```

### Remote host management

Set `--host` and `--port` to control a `jottad` on another machine (e.g. via SSH
tunnel):

```bash
ssh -L 14443:127.0.0.1:14443 remote-host
jotta-cli --host 127.0.0.1 --port 14443 status
```

Multiple instances on one host use different ports (configure in the `jottad`
INI file).

## macOS install / update

```bash
brew install jotta-cli                   # first install
brew upgrade jotta-cli                   # update
/opt/homebrew/opt/jotta-cli/bin/jottad   # daemon path
# Restart daemon after upgrade if needed:
killall jottad 2>/dev/null; sleep 1; /opt/homebrew/opt/jotta-cli/bin/jottad &
```

## Safety — confirm before running

Do **not** run these without explicit user confirmation:

- `jotta-cli logout` — Resets credentials; must re-add all backups after.
- `jotta-cli rem /path` — Stops future backup (doesn't delete remote).
- `jotta-cli trash purge --force` — Permanently destroys the entire
  remote trashcan.
- `jotta-cli sync reset` — Erases local sync state; requires full re-setup.
- `jotta-cli download --clear=all` — Clears download history (doesn't delete
  downloaded files, but is lossy).
- `jotta-cli archive --clear=all` — Clears upload history.
- `jotta-cli share --disable` — Revokes a previously generated public share
  link.
- `jotta-cli webhook rem <url>` — Removes a configured webhook endpoint.

Note: removing a backup folder with `rem` does **not** delete the remote copy.
Remote backup deletion happens on the Jottacloud website. Deleted items from
Backup go to Jottacloud Trash for ~30 days before permanent purge.

## Long-running commands

The following stream until interrupted — expect Ctrl-C to stop them:

- `jotta-cli observe` / `jotta-cli tail` — live streams
- `jotta-cli sync log --watch` — watch sync changes as they occur
- Uploading/downloading folders runs in the background via `jottad`; use
  `list uploads` / `list downloads` to check progress after launching.

## Gotchas & quirks

- **Installed help is source of truth.** Official docs sometimes mention
  commands that don't exist on the installed version (e.g. `list
downloadinformation` / `list downloadinfo`). The installed CLI exposes
  `list downloaderrors` and `list uploaderrors` instead — always prefer
  `jotta-cli <cmd> --help` output over web docs for flag names.
- **`jotta-cli ls` at root lists namespaces only.** To browse deeper you need
  the full path: `Backup/Dans-M4-laptop.local/SomeFolder`.
- **Sync may not be set up.** On Dan's observed account, `status` reported
  "Sync is not enabled" — verify before assuming sync commands will work.
- **Login token is single-use.** If login fails, generate a fresh token from
  the Jottacloud website; the old one is already consumed.
- **Folder uploads are asynchronous.** After `jotta-cli archive folder`, use
  `list uploads` or `observe` to track progress — the CLI returns immediately.
- **Patterns ignore leading `/`.** All ignore patterns are relative to the
  backup root regardless of whether you prefix with `/`.

## Official docs

- [Jottacloud Command Line Tool](https://docs.jottacloud.com/en/articles/1436834-jottacloud-command-line-tool)
- [CLI Collection](https://docs.jottacloud.com/en/collections/178055-our-command-line-tool)
- [Login & Basic Use](https://docs.jottacloud.com/en/articles/1437248-login-and-basic-use-with-jottacloud-cli)
- [Adding/Removing Folders](https://docs.jottacloud.com/en/articles/1437232-adding-and-removing-folders-from-backup-with-jottacloud-cli)
- [Archiving Files & Folders](https://docs.jottacloud.com/en/articles/1437238-archiving-files-and-folders-with-jottacloud-cli)
- [Downloading](https://docs.jottacloud.com/en/articles/2750360-downloading-using-jottacloud-cli)
- [Sync Folder](https://docs.jottacloud.com/en/articles/5859533-using-the-sync-folder-with-jottacloud-cli)
- [Status & Logs](https://docs.jottacloud.com/en/articles/1456057-how-to-view-the-status-and-logs-of-jottacloud-cli)
- [Ignoring Files](https://docs.jottacloud.com/en/articles/1437235-ignoring-files-and-folders-from-backup-with-jottacloud-cli)
- [Multiple Instances](https://docs.jottacloud.com/en/articles/1456078-managing-multiple-instances-using-the-command-line-interface)
- [Configuration](https://docs.jottacloud.com/en/articles/2750154-jottacloud-cli-configuration)
- [Webhooks](https://docs.jottacloud.com/en/articles/1459570-how-to-configure-the-command-line-client-to-send-webhooks)
- [Pause CLI](https://docs.jottacloud.com/en/articles/254735-how-to-pause-jottacloud-cli)
- [macOS Install](https://docs.jottacloud.com/en/articles/1436854-jottacloud-cli-for-macos)
