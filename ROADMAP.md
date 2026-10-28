# Roadmap

Settled: record2context is an extension plus a small local helper (a Chrome native messaging host, installed by the user's own AI with `INSTALL-FOR-AI.md`). It keeps sessions in its own storage, the helper writes them to the recordings folder in its config (default `~/record2context-recordings/`), and it gives the user text to paste into their own AI. The Recordings extension page replays sessions from the extension's storage or the recordings folder. Do not plan work on uploading, a server, or AI-written steps.

## Deferred

### Post to GitLab

- **MR draft comment / draft reply.** `POST /projects/:id/merge_requests/:iid/draft_notes`; a reply adds `in_reply_to_discussion_id`. The tester reviews and submits the draft in GitLab.
- **Issue posts publish immediately.** Issues have no drafts: `POST /projects/:id/issues/:iid/notes`, or `.../discussions/:discussion_id/notes` for a reply. Show the final text and ask for confirmation every time.
- **Note id → discussion id.** A link anchor `#note_123` is a note id. Before replying, find the discussion that holds it.
- **Attachments.** Upload `<sessionId>.webm` and the screenshots with `POST /projects/:id/uploads`.

### GitLab token setup help

Each tester would need their own GitLab personal access token (drafts belong to the token owner; scope `api`, with an expiry date): a help page explaining why and how, where it is stored, how to test it, and a copyable prompt for the tester's own AI assistant.

### Event-exclude editor

Let the user drop events before sharing (e.g. a click on a private page, a request to an unrelated host), then rebuild `context.md` from the edited list. Needs a small editor in the popup or an extension page; `report.json` stays the raw record.
