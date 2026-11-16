# Session remover

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that
deletes a session permanently instead of only archiving it: the session's stored log
leaves the disk, its subagent child sessions go with it, and every sidebar, archive, and
pin reference to it is dropped.

## Install

This is a profile bundle. Install it through **Plugins → Add plugin**:

- from GitHub: paste `github:AmmrYsir/dsh-session-remover`; or
- from a checkout: pick the folder that contains `package.json`.

It activates immediately. Reload the page once so the browser half (the menu entry and
its dialog) loads. The agent tool needs nothing else.

## Use it from the sidebar

1. Open the **`...`** menu at the end of a session row in the sidebar.
2. Choose **Delete permanently…**. The action sits with the built-in actions, after
   **Archive**, and is drawn in the destructive style.
3. Confirm in the dialog. The row disappears as soon as the Host finishes.

### A session this run has loaded

DeepSeek Harness loads a session into the running app when you open it, and keeps that
Agent for the whole run — closing the tab does not unload it. A loaded session still
owns its log, so pulling the file out from under it could let a later flush or turn
write it back; that deletion is refused.

The dialog then offers the path that does work: **Hide now, delete at next start**. The
session is archived (hidden from the sidebar like any archived session), and this bundle
deletes it, its subagent children, its cache, and its list entries the next time DeepSeek
Harness starts — before any session is opened, so nothing is loaded then. Unarchiving the
session before that restart cancels the deletion.

## Use it from the agent

The same operation is a tool, so asking the agent to "delete session
`session-…`" reaches it:

| Tool | Parameters | Effect |
| --- | --- | --- |
| `session_delete` | `sessionIds`: array of exact Session ids; `defer`: optional | Permanently deletes those sessions and their subagent child sessions. For a loaded session, `defer` hides it and deletes it on the next start. |

There is no wildcard form on purpose.

## What is removed

- the per-session log directory under the session-persistence root
  (`$DSH_HOME/sessions/<project>/<session-id>/`, `~/.dsh/sessions/…` by default),
  including every historical format generation it holds;
- the sessions of subagents the session started, which belong to it;
- its cached title and projection checkpoints, so nothing can resurrect a stale
  title or fold;
- its entry in each workspace's ordered session list, its archive entry, and its pin
  entry — the removal is published live, which is what makes the row vanish.

A project directory left empty is removed too. Full-text search heals itself: the index
is derived and reconciles against session persistence on the next search.

## Files it writes

- **`$DSH_HOME/session-remover/pending.json`** (`~/.dsh/session-remover/pending.json` by
  default) holds the ids waiting for the next start. It is removed when it becomes empty,
  and it is the only state this bundle keeps.

If part of the deletion fails — a log file held open by another process is the usual
case on Windows — the dialog stays open and names what could not be removed instead of
claiming success. The session list entry is already gone at that point, so run the
deletion again once the file is free; a repeat is idempotent.

## Limitations

- **It cannot be undone.** Archiving is the reversible way to hide a session; the
  explicit **Delete permanently…** label and the confirmation dialog exist for that
  reason.
- **A loaded session is deleted on the next start, not immediately**, for the reason
  above. Archiving it is the immediate, visible half of that path.
- **Local only.** Attachment objects the session referenced stay in the
  content-addressed attachment store, because another session may share them, and any
  copy of the session log already exported or shared elsewhere is not recalled.
- **The menu needs the web GUI.** A profile without a web page still gets the
  `session_delete` tool.
- **A new page must be loaded.** The menu entry belongs to the browser half; refresh the
  page once after installing or enabling the bundle if the entry does not appear.

## Development

```sh
npm test        # or: node --test test/
```

Thirteen scenarios drive the real Host half against a fake Cordis context and a
temporary `DSH_HOME`: the deletion guards, reference cleanup, the `/api` route contract,
and the deferred-deletion flow. Nothing outside the temporary root is touched, and
`index.js` imports only Node built-ins — no Harness package is needed to run them.

Bundle layout:

| File | Role |
| --- | --- |
| `index.js` | Host half: the deletion operation, the `/api/session-remover/delete` route, the `session_delete` tool, and the next-start cleanup. |
| `client.js` | Browser half: the Session-menu action, its confirmation dialog, and the deferred-deletion state. |
| `cordis.patch.yml` | The bundle patch that inserts the plugin row. |
| `locale/*.json` | Plugin Manager title and description (English, Chinese). |
| `icon.svg` | Bundle icon drawn for the Plugin Manager tile. |

## License

[MIT](LICENSE)
