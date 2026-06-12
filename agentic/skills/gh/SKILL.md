---
name: gh
description: GitHub CLI (gh) — the official command-line interface to GitHub. Use when the user needs to create or manage pull requests, issues, repositories, GitHub Actions, gists, API calls, authentication, or any other GitHub workflow from the terminal. Also use for scripting GitHub automation, querying the GraphQL/REST API, managing forks/clones, and viewing workflow run logs. Prefer gh over web browsing or the raw REST API.
allowed-tools: Bash(gh:*)
tagline: Official GitHub CLI for PRs, issues, repos, Actions, API, and more
triggers:
  - pattern: "(create|make|open|submit|push|get|prepare)\\s+(a|an|the\\s+)?(pr|pull\\s*request|pull-request)"
    description: "PR creation/opening requests"
  - pattern: "(pr|pull\\s*request|pull-request)\\s+(create|make|open|submit|push)"
    description: "PR creation/opening requests (reverse order)"
  - pattern: "gh\\s+(pr|pull-request|pull\\s*request)"
    description: "gh pr commands"
  - pattern: "(assign|reviewer|merge|checkout|review|approve|comment|list|show)\\s+(pr|pull\\s*request)"
    description: "PR workflow actions"
  - pattern: "(pr|pull\\s*request)\\s+(assign|reviewer|merge|checkout|review|approve|comment|list|show|diff|rebase|close)"
    description: "PR workflow actions (reverse order)"
  - pattern: "(issue|pr)\\s+(comment|label|transfer|lock|pin|reopen|close|lock)"
    description: "Issue/PR management actions"
---

# GitHub CLI (`gh`)

Official CLI to GitHub. Install from https://cli.github.com/

## Auth

```bash
gh auth login                     # Interactive OAuth (default: github.com)
gh auth login --hostname HOST     # GitHub Enterprise
gh auth login --with-token        # Pipe PAT via stdin
gh auth status / token / logout / refresh -s SCOPE
```

Headless: `GH_TOKEN`/`GITHUB_TOKEN`. Enterprise: `GH_ENTERPRISE_TOKEN` + `GH_HOST`.

## Key env vars

| Variable | Purpose |
|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | Auth token (overrides stored creds) |
| `GH_HOST` | Default hostname |
| `GH_REPO` | Default `OWNER/REPO` |
| `GH_EDITOR` / `GIT_EDITOR` | Text editor |
| `GH_BROWSER` / `GH_PAGER` | Browser / pager |
| `GH_DEBUG` / `DEBUG` | Verbose; `api` for HTTP traffic |
| `GH_PROMPT_DISABLED` | Disable prompts |

## Universal flags

- `-R, --repo [HOST/]OWNER/REPO` — override target repo
- `-w, --web` — open in browser
- `--json FIELDS` — machine-readable output

## Pull Requests

```bash
gh pr create --title T --body B --reviewer alice --label bug --draft
gh pr create --fill                # Fill from commits
gh pr create --base dev --head fork:branch
gh pr create --project "Roadmap"

gh pr view 123 --web
gh pr diff 123
gh pr edit 123 --add-label wip --remove-label draft
gh pr checkout 123 [--branch name] [--detach]

gh pr merge 123 --squash --delete-branch [--auto|--rebase|--merge]
gh pr merge 123 --admin            # Bypass required checks

gh pr review 123 --approve -b "LGTM"
gh pr review 123 -r -b "Needs work"
gh pr list --state open --author me
gh pr status                       # Current branch

gh pr close 123 / reopen 123 / lock 123 / ready 123 / revert 123
gh pr edit 123 --body-file body.md  # Update body from file
```

### PR description style

Write PR descriptions that a human (or agent) can skim — focus on **what** the PR does, **why**, and **how to use it**. Avoid file-level diffs.

Recommended structure:

1. **What** — one paragraph on the core change or new capability
2. **Key features** — bullet list of the most user-facing changes
3. **Examples** — concrete CLI examples or API calls showing how it works
4. **Why it helps** (optional) — one short paragraph on the motivation or
   benefit

Less emphasis on technical internals — agents should know *what* the PR
delivers, not *which files changed*. (The diffs page covers that.)

### Reviewers and assignment

Always assign yourself (`@me`) to the PR as the author.

Before adding reviewers, read the project's `AGENTS.md` file. It may list
maintainers or designated reviewers — assign those people rather than guessing.
Never assign the author as a reviewer.

Auto-close: `Fixes #N`, `Closes #N`, `Resolves #N` in body.
Aliases: `gh pr new` = `create`, `gh pr co` = `checkout`.

### Review cycle

When a PR gets a Copilot review, Copilot usually ticks in about **5 minutes** after
pushing changes. To check for pending reviews:

```bash
gh pr status
gh pr view <N> --json reviewDecision,reviews  # reviewDecision empty = not yet reviewed
```

A `COMMENTED` review decision means Copilot has left inline comments (not approval).
Always inspect and address them.

**Workflow for each review comment:**

1. **Fetch all inline comments:**
   ```bash
   gh api repos/<org>/<repo>/pulls/<N>/reviews --jq '.[] | select(.author.login == "copilot-pull-request-reviewer") | .id'
   gh api repos/<org>/<repo>/pulls/<N>/reviews/<ID>/comments --jq '.[] | {path: .path, line: .line, body: .body, id: .id}'
   ```
2. **Read the relevant code** and judge whether the comment makes sense.
3. **Fix the code** if the comment is valid (or improve it even if the suggestion isn't perfect).
4. **Address ambiguous comments** — if a comment contains a question or you don't understand it, write a reply comment on that specific review comment:
   ```bash
   gh api repos/<org>/<repo>/pulls/comments/<COMMENT_ID> -X POST -f body="Your clarification question here"
   ```
5. **Post a summary comment** on the PR listing what you fixed and why, tagged with `@copilot` so it sees it:
   ```bash
   gh pr comment <N> -b "Addressed all comments. Fixes: <list> @copilot"
   ```

   **Gotcha:** Literal `\n` in bash strings are *not* rendered as newlines by GitHub. For multi-line comments, use actual newlines via `$'...'` syntax:
   ```bash
   gh pr comment <N> -b $'Line 1\nLine 2\nLine 3'
   ```
   Or use a heredoc / body file: `gh pr comment <N> --body-file comment.md`
6. **Resolve all review threads** (Copilot review comments cannot be resolved via the REST API — use GraphQL):
   ```bash
   # Find thread IDs for a given review
   gh api graphql --method POST -f 'query=query { repository(owner: "<org>", name: "<repo>") { pullRequest(number: <N>) { reviewThreads(first: 20) { edges { node { id isResolved } } } } } }'
   # Resolve each unresolved thread (IDs start with PRRT_)
   gh api graphql --method POST -f 'query=mutation { resolveReviewThread(input: {threadId: "PRRT_xxx"}) { clientMutationId } }'
   ```
7. **Repeat** — after ~5 minutes Copilot may post new changes, a new review, or a new comment. Run through the cycle again until no substantive comments remain (only nits are acceptable).

Note: You cannot submit a review (`gh pr review`) on your own PR — only post comments and resolve threads.

## Issues

```bash
gh issue create --title T --body B --label bug --assignee alice,@me,@copilot
gh issue create --template "Bug Report" --web

gh issue view 42 --web
gh issue edit 42 --add-label priority
gh issue comment 42 -b "Update"

gh issue close 42 / reopen 42 / lock 42 / pin 42 / transfer 42 owner/repo
gh issue list --state open --author me
gh issue status                    # Assigned to you
```

Aliases: `gh issue new` = `create`.

## Repositories

```bash
gh repo create NAME --public [--clone] [--description "desc"] [--template tpl]
gh repo clone owner/repo [-- --depth 1]
gh repo fork owner/repo

gh repo edit NAME --add-topic mytopic
gh repo rename NAME new-name
gh repo sync / archive / delete / view --web
gh repo list --limit 50

gh repo gitignore list / view Go
gh repo license list / view MIT
```

## GitHub Actions

```bash
gh run list [--workflow ci.yml]
gh run view 123 --log / watch 123 / cancel 123 / delete 123 / download 123 / rerun 123 --failed
gh workflow list / enable NAME / disable NAME / run NAME.yml
gh run watch --fail-fast
```

## Gists

```bash
gh gist create script.py -d "desc"
gh gist list / view abc / edit abc --desc "new desc" --add newfile.py / rename abc new / delete abc / clone abc
```

## API

```bash
gh api repos/{owner}/{repo}/issues                          # REST GET
gh api repos/{owner}/{repo}/issues -X POST -f title=New    # REST POST
gh api graphql -f query='query { viewer { login } }'       # GraphQL

gh api ... --jq '.[].name' --paginate --slurp              # Filter / paginate
gh api ... --template '{{range .}}{{.name}}{{end}}'         # Go template
gh api ... -F 'files[n][content]=@file.txt'                # Read from file
gh api ... -H 'Accept: ...' --preview=baptista --cache 3600s
```

Placeholders `{owner}`, `{repo}`, `{branch}` resolve from current repo or `GH_REPO`.

## Aliases

```bash
gh alias set co 'pr checkout'
gh alias set si '! gh issue create --title "$@"'
gh alias list / delete co / import ./aliases.yaml
```

## Config

```bash
gh config set git_protocol ssh / editor vim / color_labels enabled
gh config list / get git_protocol / clear-cache
```

Keys: `git_protocol`, `editor`, `prompt`, `pager`, `browser`, `color_labels`, `telemetry`, `spinner`.

## Search

```bash
gh search repos --topic rust / code --repo o/r "TODO" / issues --state open / prs --state merged
```

## Completion

```bash
gh completion -s bash | zsh | fish | powershell
```

## Notes

- **Repo resolution:** current dir git remotes → `GH_REPO` → explicit `--repo`.
- `--web` opens the GitHub page in browser.
- Project board membership needs `project` scope (`gh auth refresh -s project`).
- Draft PRs show `[WIP]` in listings.
- **Copilot reviews:** `state: COMMENTED` means *changes requested*, not approval. See the "Review cycle" section for the full workflow.
