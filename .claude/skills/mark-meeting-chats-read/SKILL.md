---
name: mark-meeting-chats-read
description: Marks every Google Meet meeting chat as read — the "<Event> - Sep 23" chats with a calendar icon that Chat creates for each calendar call. Only clears unread dots; never leaves, deletes or posts anything. Run manually with /mark-meeting-chats-read.
disable-model-invocation: true
allowed-tools: Bash(node dist/cli.js mark-meeting-chats-read*)
---

# Mark meeting chats read

Clears the unread state of Google Meet meeting chats: the spaces Chat creates
for each calendar event with a Meet call, named after the event plus a date
(e.g. "AI Daily Scrum - Sep 23"). Nothing else is touched — DMs, group chats
and normal spaces keep their unread state.

**API only.** Use the CLI below; don't open a browser.

## Steps

1. Run from the project root:

   ```
   node dist/cli.js mark-meeting-chats-read
   ```

   To preview without changing anything, add `--dry-run`. Use the preview only
   if the user asked for one — running the skill is the go-ahead.

2. Report in one short block: how many meeting chats were checked, how many
   were cleared, how many messages that was, and the cleared chat names
   (group repeats, e.g. "AI Daily Scrum ×3"). If `failed` is present, say how
   many and that they were left as they were.

3. If nothing needed clearing, say so in one line.

This skill only marks things read. If the user wants meeting chats removed
from their list instead, that is leaving the chats — a separate, hard-to-undo
step that needs its own explicit confirmation.
