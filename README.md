# Todoist Daily Archive

An Obsidian plugin that archives your completed Todoist tasks into the daily
note matching each task's completion date.

## Features

- Uses Todoist's current unified API (`api.todoist.com/api/v1`), specifically
  `GET /tasks/completed/by_completion_date`. Does not rely on the legacy Sync
  API (`sync/v9`).
- Detects the date from the filename of the active note, using the format
  configured in the core "Daily notes" plugin or the "Periodic Notes"
  community plugin (with a manual override available in settings).
- Fetches all tasks completed on that calendar day (local timezone) and
  inserts them under a configurable heading.
- Heading level (`#` to `######`) and heading text are configured separately.
  If a heading with exactly this text already exists **at exactly this
  level**, new tasks are appended at the end of that section - i.e. up to the
  next heading of equal or higher rank (fewer or equal `#`), not just the next
  heading in general. A heading with the same text but a different level is
  deliberately ignored, so the plugin never rewrites structure it doesn't
  recognize. If the heading doesn't exist yet, it's created at the end of the
  file.
- Works even when the heading lives inside a callout (e.g. `> [!done]+
  Todoist` followed by `> ## Completed (Todoist)`). New lines automatically
  get the same `>` prefix so they stay visually inside the callout. The
  section additionally ends wherever the blockquote itself ends (the first
  line without a leading `>`), not only at the next heading outside it.
- A blank line is always ensured directly under the heading (inserted once if
  missing, left alone if already present - no accumulation on repeated runs).
  Inside a callout, that blank line is itself a callout line (`>` with no
  content), so the callout isn't cut short.
- Each line links to the corresponding task in Todoist via the `{url}`
  placeholder, using the `url` field Todoist returns per task (falling back to
  `https://app.todoist.com/app/task/<id>` if that field is ever missing).
- Each inserted line carries a hidden HTML comment marker
  (`<!--todoist-id:12345-->`) so re-running the command never creates
  duplicates.

## Requirements

Requires Obsidian **>= 1.11.4** (desktop and mobile), because the plugin
stores the API token via Obsidian's native keychain feature (`SecretStorage` /
`SecretComponent`), which was only introduced in that version. On older
versions the plugin intentionally does not fall back to a plaintext input
field; it will tell you to update instead.

## Installation

Manual installation (not distributed via the Community Plugins browser):

1. In your vault: create `.obsidian/plugins/todoist-daily-archive/`.
2. Copy `main.js` and `manifest.json` from this repository into that folder.
3. Reload Obsidian (Ctrl/Cmd+R) or reopen the vault.
4. Settings -> Community plugins -> enable "Todoist Daily Archive".
   (You may need to turn off restricted mode first, since this plugin isn't
   listed in the store.)

## Setup

1. In Todoist: Settings -> Integrations -> Developer -> copy your API token.
2. In Obsidian: Settings -> Todoist Daily Archive -> under "Todoist API
   token", create a new secret via the picker and paste the token in.
3. Optionally adjust the heading, line template, and project filter.

**On security, plainly stated:**
- The plugin settings (`data.json`) only ever contain the *name* of the
  secret, never the token value.
- The actual value lives in Obsidian's keychain, which uses Chromium/Electron
  `safeStorage` (macOS Keychain, Windows Credential Manager, Linux Secret
  Service depending on distro) and is stored per-vault locally - it is not
  synced via Obsidian Sync/iCloud/Git.
- This keychain API is fairly new (introduced in Obsidian 1.11.4, early 2026).
  An early community bug report suggested secrets were, at least for a while,
  not fully encrypted at rest but kept in local storage instead. Whether
  that's been fixed since could not be conclusively verified here - it's a
  clear improvement over plaintext in `data.json` either way, but not a
  substitute for a dedicated secrets manager if that matters to you.
- Older installations with a plaintext token in `data.json` are automatically
  migrated into the keychain on first load (once Obsidian is >= 1.11.4); the
  plaintext value is then deleted from `data.json`.

## Usage

- Command **"Archive completed Todoist tasks into current daily note"**:
  archives every task completed on the date of the currently active note,
  into that same note.
- Command **"Archive yesterday's completed Todoist tasks into yesterday's
  daily note"**: useful for a morning review; looks up yesterday's daily note
  in the vault even if it isn't currently open.
- Command **"Diagnose: show detected daily note format"**: shows which source
  was detected (core plugin / Periodic Notes / override / none), the
  resulting date format and folder, the active file's name, and whether it
  matches.

All commands are available via the command palette (Ctrl/Cmd+P), and can be
bound to hotkeys through Obsidian's normal hotkey settings.

## Known limitations

- Todoist's API returns completed tasks for a maximum lookback of about 3
  months per query (a limit of the endpoint itself) - irrelevant for daily
  use.
- There's no automatic execution on note-open (deliberately, to avoid
  unexpected background writes/API calls). Both archiving commands must be
  triggered manually, via a hotkey, or through automation plugins like
  Commander or Templater.
- Recurring tasks: Todoist reports a separate completed entry (with its own
  `completed_at`) per completion event; deduplication is based on that
  completion entry's task ID, not the recurring task's base ID.

## License

MIT, see [LICENSE](LICENSE).
