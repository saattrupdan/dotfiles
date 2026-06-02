# EMAIL_PLAN.md — Testing & bug-fix handoff for the `email` skill

This is a step-by-step task list for a **local AI agent** to test the `email` skill
end-to-end, find bugs, and fix them. Follow it literally, top to bottom. Run every
command, compare the output to "Expected", and when something doesn't match, go to
the matching fix section.

---

## 0. Permissions — READ THIS FIRST

- You are a **local / self-hosted model**, so you **ARE allowed** to run every `email`
  command and to access the real mailbox. The "do not use if you are a cloud model"
  banner in `SKILL.md` does **not** apply to you. Ignore it.
- The previous (cloud) agent could not test this skill, which is why this hand-off
  exists. Your job is to make the Microsoft 365 part actually work.
- **Email is private.** Do not paste real email contents, addresses, tokens, or the
  contents of `~/.email/` into any external service or website. Keep everything local.

---

## 1. What the skill is + file map

The `email` CLI reads and sends email. It has three "backends":

| Backend | Used for | How it talks to the server |
| --- | --- | --- |
| `imap` | Gmail / generic IMAP | Python stdlib `imaplib` + `smtplib`, app password |
| `graph` | Microsoft 365 (OAuth) | Microsoft Graph REST — **blocked** on alexandra.dk (admin consent), skip it |
| `owa` | Microsoft 365 (browser) | Drives Outlook-on-the-web via `agent-browser` — **THIS is the one to fix** |

Source files (all under `agentic/skills/email/`):

```
SKILL.md                      ← human/agent docs
pyproject.toml                ← package metadata, CLI entry point
email_cli/
  main.py                     ← entry point; loads .env, parses args, dispatches, prints errors
  cli_parser.py               ← argparse definitions (all flags live here)
  commands.py                 ← one handler per command (accounts/login/list/read/send)
  config.py                   ← ~/.email/accounts.json + .env loading
  display.py                  ← markdown tables + --raw JSON
  models.py                   ← the Message dataclass every backend returns
  browser.py                  ← thin agent-browser subprocess wrapper (used by owa)
  backends/
    base.py                   ← the Backend "protocol" (the 4 methods each backend has)
    imap_smtp.py              ← Gmail backend
    graph.py                  ← Graph backend (skip)
    owa.py                    ← Outlook-on-the-web backend ← YOU WILL EDIT THIS MOST
```

**The skill is installed "editable"**, which means **edits to these `.py` files take
effect immediately** — you do NOT need to reinstall after editing. (If `email` is not
found at all, see §2.1.)

---

## 2. One-time setup

### 2.1 Confirm the CLI and agent-browser are installed

```bash
which email
which agent-browser
```

- Expected: both print a path.
- If `email` is missing: `pipx install -e /Users/dansmart/gitsky/dotfiles/agentic/skills/email`
- If `agent-browser` is missing: install it (see the `agent-browser` skill). The `owa`
  backend cannot work without it.

### 2.2 Run the lint/format checks (do this after every code edit too)

```bash
cd /Users/dansmart/gitsky/dotfiles/agentic/skills
ruff check email && ruff format email
```

Expected: `All checks passed!` and "files left unchanged" (or it reformats — that's fine).

### 2.3 Configure the two accounts

```bash
# Personal Gmail (default). Replace the address with the real one.
email accounts add --name gmail --provider gmail --email YOUR_NAME@gmail.com --default

# Corporate Microsoft 365 → uses the owa (browser) backend automatically
email accounts add --name work --provider m365 --email dan.smart@alexandra.dk

email accounts list
```

Expected from `accounts list`:
```
gmail *	YOUR_NAME@gmail.com	imap
work	dan.smart@alexandra.dk	owa

(* = default)
```
The `work` line MUST say `owa`. If it says `graph`, remove it
(`email accounts remove --name work`) and re-add it exactly as above.

### 2.4 Gmail app password (for the Gmail tests only)

1. Create an app password at <https://myaccount.google.com/apppasswords> (needs 2-Step
   Verification on the Google account).
2. Put it in `~/.env` (create the file if needed):
   ```
   EMAIL_GMAIL_APP_PASSWORD=the sixteen char app password
   ```
3. Make sure IMAP is enabled in Gmail → Settings → Forwarding and POP/IMAP.

---

## 3. How the code works (so you know where bugs live)

- Every command flows: `main.py` → `commands.py:do_*` → `get_backend()` →
  `backends/<x>.py`. The backend returns `Message` objects (`models.py`), which
  `display.py` renders.
- The `owa` backend (`backends/owa.py`) does NOT scrape the web page. Instead it runs a
  JavaScript `fetch()` **inside the logged-in Outlook page** (via `agent-browser eval`)
  that POSTs to Outlook's internal API `https://outlook.office.com/owa/service.svc`.
  This is called "EWS-JSON". The request bodies are big nested JSON objects.
- **The bug risk is entirely in those EWS-JSON request/response shapes.** They were
  written from memory by an agent that could not test them. They may have wrong field
  names, wrong `__type` strings, a wrong endpoint, or missing headers. §6 shows you how
  to discover the correct shapes from the real Outlook UI.

---

## 4. TEST PLAN — Gmail (imap backend)

Run these in order.

### 4.1 Login (validates the app password)
```bash
email login --account gmail
```
- Expected: `IMAP login OK for YOUR_NAME@gmail.com.`
- If `No app password found …` → fix §2.4 step 2 (the env var name must be
  `EMAIL_GMAIL_APP_PASSWORD`).
- If `IMAP login failed …` → wrong app password, or IMAP not enabled (§2.4 step 3).

### 4.2 List inbox
```bash
email list --account gmail --limit 5
```
- Expected: a markdown table with columns `# | (unread) | Date | From | Subject | Id`.
- `email list --account gmail --limit 5 --raw` should print valid JSON (pipe to
  `python3 -m json.tool` to confirm).

### 4.3 List filters
```bash
email list --account gmail --unread --limit 5
email list --account gmail --query "subject:test" --limit 5
email list --account gmail --folder sent --limit 5
```
- Expected: each returns a table (possibly empty → `_No messages._`).

### 4.4 Read one message
Take an `Id` value from §4.2 output, then:
```bash
email read --account gmail --id THAT_ID
```
- Expected: headers (`From/To/Date/Subject`), then the plaintext body.
- `--raw` should print JSON; `--html` should prefer the HTML body.

### 4.5 Send (use YOUR OWN address as recipient for the test)
```bash
email send --account gmail --to YOUR_NAME@gmail.com --subject "email skill test" --body "hello from the email skill"
```
- It prints a draft and asks `Send this message? [y/N]`. Type `y`.
- Expected: `Sent to YOUR_NAME@gmail.com.` then the mail arrives in your inbox.
- Then verify it arrived: `email list --account gmail --limit 3`.

If all of §4 passes, the Gmail backend is good. **Most of your work will be §5–§7.**

---

## 5. TEST PLAN — Microsoft 365 (owa backend)

### 5.1 Login (interactive — needs a real terminal + the browser window)
```bash
email login --account work
```
What happens:
1. A Chrome/Chromium window opens at Outlook.
2. Sign in with the Microsoft account + approve MFA. **Wait until you can see the
   actual inbox** (message list visible).
3. Come back to the terminal and press **Enter**.

- Expected: `Signed in to Outlook on the web as dan.smart@alexandra.dk (session saved).`
  and a file `~/.email/work.owa-state.json` is created.
- If it says "Sign-in does not look complete" → you pressed Enter too early or the page
  was still on the login screen. Re-run and wait longer before pressing Enter.

Check the session file exists:
```bash
ls -l ~/.email/work.owa-state.json
```

### 5.2 List inbox — THE FIRST LIKELY FAILURE POINT
```bash
email list --account work --limit 5
```
- **If it prints a table:** great, listing works. Go to §5.3.
- **If it errors** with `OWA FindItem failed …`, `Unexpected OWA FindItem response
  shape …`, or `Not signed in …` — this is expected; the EWS payload is probably wrong.
  **Go to §6 to discover the correct request, then §7 to fix it.** Re-run this command
  after each fix until it returns a table.

Also try the raw form to see structured output / more detail:
```bash
email list --account work --limit 5 --raw
```

### 5.3 Read a message
Take an `Id` from §5.2 (these are long strings — **always wrap them in quotes**):
```bash
email read --account work --id "PASTE_THE_LONG_ID_HERE"
```
- If it errors → §6/§7, this time for the `GetItem` action.

### 5.4 Mark-as-read
```bash
email read --account work --id "PASTE_THE_LONG_ID_HERE" --mark-read
```
- Then `email list --account work --unread` should no longer show that message.
- If it errors on `UpdateItem` → §6/§7 for the `UpdateItem` action.

### 5.5 Send (recipient = the work address itself, so you don't email a stranger)
```bash
email send --account work --to dan.smart@alexandra.dk --subject "owa test" --body "hello via owa"
```
- Confirm with `y`. Expected: `Sent to dan.smart@alexandra.dk.` and it arrives.
- If it errors on `CreateItem` → §6/§7 for the `CreateItem` action.

---

## 6. HOW TO DISCOVER THE CORRECT OWA REQUESTS (the key technique)

The skill guesses how to call Outlook's internal API. To get the **real** shape, you
watch what the actual Outlook web UI sends, then copy it. Do this with the **same
agent-browser session the skill uses**, which is named `email-work` (pattern:
`email-<account-name>`).

### 6.1 Open Outlook in a visible browser, in the skill's session
```bash
agent-browser --headed --session-name email-work open "https://outlook.office.com/mail/"
```
If you are not logged in, log in again (then it reuses §5.1's session).

### 6.2 Install a "fetch recorder" into the page
Create a file `/tmp/hook.js` with EXACTLY this content:
```javascript
(() => {
  window.__owa = [];
  const orig = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = (typeof input === "string") ? input : (input && input.url) || "";
      if (url.indexOf("service.svc") !== -1) {
        let action = null;
        const h = init && init.headers;
        if (h) action = (typeof h.get === "function") ? h.get("Action") : (h.Action || h.action);
        window.__owa.push({ url: url, action: action, body: (init && init.body) || null });
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  return "fetch hooked";
})()
```
Run it:
```bash
cat /tmp/hook.js | agent-browser --session-name email-work eval --stdin
```
Expected output: `fetch hooked`

### 6.3 Trigger the real requests in the UI
In the Outlook browser window:
- Click on the **Inbox** folder and let the message list load → triggers the real
  **FindItem** request.
- Click on a single message to open it → triggers the real **GetItem** request.
- (For send) click **New mail**, type a to/subject/body, click **Send** → triggers the
  real **CreateItem** request.

### 6.4 Dump what was captured
```bash
echo 'JSON.stringify(window.__owa, null, 2)' | agent-browser --session-name email-work eval --stdin
```
This prints the **exact** URLs, `Action` header values, and request bodies that real
Outlook used. This is the ground truth. Note for each operation:
- the exact **URL** (is it `/owa/service.svc?action=...`? a different path? a different host?),
- the exact **Action** value (e.g. `FindItem`, `GetItem`, `FindConversation`, …),
- the exact **request body** JSON (field names and every `"__type": "...:#Exchange"`).

> Tip: modern Outlook sometimes uses `FindConversation`/`GetConversationItems` instead
> of `FindItem`/`GetItem`. If you see different action names, that's important — the
> skill must use whatever the real UI uses.

### 6.5 (Optional) Test a request body by hand before editing Python
Create `/tmp/try.js` to POST a body yourself and see the FULL (untruncated) response:
```javascript
(async () => {
  const m = document.cookie.match(/(?:^|;\s*)X-OWA-CANARY=([^;]+)/);
  const canary = m ? decodeURIComponent(m[1]) : "";
  const ACTION = "FindItem";                      // ← change to the real action
  const BODY = { /* paste the real body JSON here */ };
  const r = await fetch("/owa/service.svc?action=" + ACTION + "&app=Mail", {
    method: "POST", credentials: "include",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "application/json",
      "Action": ACTION,
      "X-OWA-CANARY": canary,
      "X-Req-Source": "Mail"
    },
    body: JSON.stringify(BODY)
  });
  const t = await r.text();
  return JSON.stringify({ status: r.status, body: t.slice(0, 4000) });
})()
```
```bash
cat /tmp/try.js | agent-browser --session-name email-work eval --stdin
```
Iterate here (cheap) until you get `status: 200` and a sensible body, THEN move the
working body/action into `backends/owa.py`.

---

## 7. HOW TO FIX `backends/owa.py`

Open `agentic/skills/email/email_cli/backends/owa.py`. The pieces you may need to change:

1. **The endpoint / headers** — in the `_FETCH_JS` string near the top. If §6 showed a
   different URL path, a different host, or extra required headers (e.g.
   `X-OWA-ActionName`, `X-OWA-ActionId`), edit them here. Keep the `__ACTION__` and
   `__BODY__` placeholders — Python fills those in (`_request`).

2. **The request bodies** — one per operation:
   - `list_messages()` builds the `FindItem` body.
   - `get_message()` builds the `GetItem` body.
   - `_mark_read()` builds the `UpdateItem` body.
   - `send_message()` builds the `CreateItem` body.
   Replace these with the real shapes you captured in §6. Keep using the
   `_HEADER` constant for the `"Header"` part if the real request has the same header;
   otherwise update `_HEADER` too.
   - If the real action name differs (e.g. `FindConversation`), change BOTH the string
     passed to `self._request("FindItem", body)` AND the body's `__type`, AND update
     `_response_messages()`/`_to_message()` to read the new response shape.

3. **The response parsers** — these read the JSON the server returns:
   - `_response_messages(data, action)` expects
     `data["Body"]["ResponseMessages"]["Items"]`. If the real response nests things
     differently, fix the path here.
   - `_to_message(item)` maps one server item → a `Message`. Fix the field names
     (`ItemId.Id`, `Subject`, `From.Mailbox.{Name,EmailAddress}`, `DateTimeReceived`,
     `IsRead`, `ToRecipients`) to match the real response keys.
   - `get_message()` reads `item["Body"]["Value"]` and `item["Attachments"]`. Fix if
     the real keys differ.

4. **After editing:** run §2.2 (ruff), then re-run the failing test from §5. No
   reinstall needed (editable install).

### Seeing the raw response from inside the skill while debugging
The skill already includes the raw server response in its error message on failure
(look for `Response:` in the error). If you need to see the response on a *successful*
HTTP call that just parses wrong, temporarily add this line inside `_request()` in
`owa.py`, right after `env = self._browser.eval_json(js)`:
```python
import sys, json as _json; print(_json.dumps(env)[:3000], file=sys.stderr)
```
Run the command, read the dump on stderr, then **remove that line** when done.

---

## 8. Reference — the request shapes currently in the code (guesses)

These are what the code sends today. Treat them as a starting point; §6 is the source
of truth. Endpoint today: `POST https://outlook.office.com/owa/service.svc?action=<Action>&app=Mail`
with headers `Content-Type: application/json; charset=utf-8`, `Action: <Action>`,
`X-OWA-CANARY: <value of the X-OWA-CANARY cookie>`, `X-Req-Source: Mail`.

- **FindItem** (list): `ItemShape` BaseShape `IdOnly` + properties `item:Subject`,
  `message:From`, `item:DateTimeReceived`, `message:IsRead`; `ParentFolderIds` =
  distinguished folder id (`inbox`/`sentitems`/`drafts`/`junkemail`/`deleteditems`);
  `IndexedPageView` with `MaxEntriesReturned`; sort by `item:DateTimeReceived`
  descending; optional `QueryString` (free text) and `Restriction` (unread).
- **GetItem** (read): `ItemShape` with `BodyType: Text` + `item:Body`,
  `item:Attachments`, `item:HasAttachments`, recipients; `ItemIds` = `[{ItemId Id}]`.
- **UpdateItem** (mark read): set `message:IsRead = true` on the `ItemId` (+ `ChangeKey`).
- **CreateItem** (send): `MessageDisposition: SendAndSaveCopy`, one `Message:#Exchange`
  item with `Subject`, `Body` (Text), `ToRecipients`/`CcRecipients`/`BccRecipients`
  where each recipient is `{ "Mailbox": { "EmailAddress": "a@b.com" } }`.

Response parsing currently assumes:
`data.Body.ResponseMessages.Items[0]` → for FindItem `.RootFolder.Items[]`, for GetItem
`.Items[]`. Each item: `ItemId.Id`, `Subject`, `From.Mailbox.{Name,EmailAddress}`,
`DateTimeReceived`, `IsRead`, `ToRecipients[].Mailbox.*`, `Body.Value`,
`Attachments[].Name`. Errors come back with `ResponseClass: "Error"` and `MessageText`.

---

## 9. Common errors → meaning → what to do

| Message | Meaning | Action |
| --- | --- | --- |
| `agent-browser is not installed …` | the CLI isn't on PATH | install agent-browser (§2.1) |
| `OWA login is interactive …` | you ran `login` piped / no terminal | run it in a real terminal |
| `Sign-in does not look complete …` | pressed Enter before inbox loaded, or still on login page | re-run `email login --account work`, wait longer |
| `Not signed in for 'work' (OWA returned 401/440) …` | session expired or never saved | re-run `email login --account work` |
| `OWA <Action> failed (HTTP 4xx/5xx). Response: …` | wrong endpoint/headers/body | §6 to capture real request, §7 to fix |
| `Unexpected OWA <Action> response shape: …` | request worked but parser is wrong | fix `_response_messages`/`_to_message` (§7.3) |
| `OWA <Action> error: <text>` | the server rejected the request | read `<text>`; usually a bad field in the body (§7.2) |
| `Could not parse agent-browser eval output as JSON …` | the eval returned non-JSON (often an agent-browser problem) | re-run; check the session is alive: `agent-browser --session-name email-work get url` |
| list returns `_No messages._` but inbox has mail | wrong folder id or wrong response path | §6/§7 |

Reset tricks:
- Force a fresh login: `rm ~/.email/work.owa-state.json` then `email login --account work`.
- Restart the browser session: `agent-browser close --all` then re-run.
- See what page the session is on: `agent-browser --session-name email-work get url`.

---

## 10. Safety rules

- When testing **send**, always use **your own address** as the recipient. Never send
  test mail to anyone else.
- The `send` command asks for `y/N` confirmation — that's intentional. Don't add
  `--confirm` to skip it during testing.
- Don't mark-read or delete real important mail while testing. Prefer sending yourself a
  throwaway message and operating on that.
- Keep `~/.email/` private; never commit it or paste its contents anywhere.

---

## 11. Definition of done (checklist)

Tick every box. For each, paste the command and its output into your final report.

Gmail (imap):
- [ ] `email login --account gmail` succeeds
- [ ] `email list --account gmail --limit 5` shows a table
- [ ] `email list --account gmail --raw` is valid JSON
- [ ] `email read --account gmail --id <id>` shows headers + body
- [ ] `email send --account gmail --to <self> …` sends and arrives

Microsoft 365 (owa):
- [ ] `email login --account work` succeeds and writes `~/.email/work.owa-state.json`
- [ ] `email list --account work --limit 5` shows a table of real inbox messages
- [ ] `email list --account work --unread` and `--folder sent` work
- [ ] `email read --account work --id "<id>"` shows headers + body
- [ ] `email read --account work --id "<id>" --mark-read` marks it read
- [ ] `email send --account work --to dan.smart@alexandra.dk …` sends and arrives
- [ ] `ruff check email` passes and `ruff format email` leaves files unchanged

Report:
- [ ] List every change you made to `backends/owa.py` (or any file) and why.
- [ ] Paste the final working EWS request shapes you discovered (so they're recorded).
- [ ] Note anything still broken or skipped.

---

## 12. Committing your work

This repo's convention is to commit AND push when done (no need to ask).

```bash
cd /Users/dansmart/gitsky/dotfiles
ruff check agentic/skills/email && ruff format agentic/skills/email
git add -A agentic/skills/email
git commit -m "fix(email): make OWA backend work against live mailbox

<describe what you changed and the real EWS shapes you found>

Co-Authored-By: <your model name> <noreply@local>"
git push origin main
```

Do NOT commit anything under `~/.email/` (it's outside the repo anyway) or any file
containing passwords/tokens.
