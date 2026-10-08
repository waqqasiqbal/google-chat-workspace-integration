# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run build              # tsc -> dist/
npm run dev                # tsc --watch
npm run login              # one-time OAuth; writes .credentials/token.json
npm start                  # run the MCP server over stdio
```

Smoke-test the server without an MCP client by piping JSON-RPC into it:

```sh
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"s","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

There is no test suite yet.

## Architecture

Four layers, each depending only on the one below it:

- `src/index.ts` — builds the `McpServer` and attaches `StdioServerTransport`.
- `src/tools.ts` — every tool definition. Zod input schemas, and each handler
  returns JSON stringified into a single text content block via the local
  `text()` helper.
- `src/chat.ts` — memoizes one `chat_v1.Chat` client; `spaceName()` normalizes
  `spaces/XXXX` vs. bare ids so tool callers can pass either.
- `src/auth/` + `src/config.ts` — credentials. `config.ts` throws on a missing
  required var at import time, so a misconfigured `.env` fails loudly at
  startup rather than on first tool call.

## Chat CLI and skills

`src/cli.ts` (`node dist/cli.js <command>`) is a JSON command-line front end
over the same auth, used by the project skills `.claude/skills/chat-read` and
`.claude/skills/chat-send`. It exits with code 2 when run from outside this
folder — that guard is intentional so sessions elsewhere can't read or send.
The Chat API returns people as `users/{id}`; the CLI learns id → email when a
DM is opened by email and caches it in `.credentials/contacts.json`.
Space nicknames are `.env` lines `CHAT_SPACE_<NAME>=spaces/X` (plus
`CHAT_TEST_SPACE` = `playground`); `node dist/cli.js aliases` lists them.
`.claude/skills/mark-meeting-chats-read` is user-invoked only
(`disable-model-invocation`); it wraps `cli.js mark-meeting-chats-read`, which
marks Meet meeting chats ("<Event> - Mon DD" unthreaded spaces) read and
nothing else.

**Reply placement (user's rule).** In DMs and group chats, reply in the main
conversation (no thread) and tag the person being answered with
`@email`. In spaces, reply inside the thread of the message being answered.
Details in `.claude/skills/chat-send`.

**Fix tags automatically (user's rule).** Any tag in text to be sent must
become a real mention — never post a fake one. Other sessions often write
"＠Name" (full-width ＠) or "@Name" as plain text; `cli.js send/edit` converts
these to `<users/{email}>` when the name matches exactly one cached contact
(`nameMentions()` in `src/cli.ts`), and "＠email" to a normal "@email". If a
name matches nobody or several people, look it up with `contacts <name>` and
use `@email` — don't send it unresolved, and don't ask the user about it.

**Handing work to other sessions.** When passing a task to another Claude
session, tell it to SendMessage its result back to this session. If nothing
arrives, read its transcript (`list_events`) instead of waiting.

**Relaying to the user's own sessions (user's rule).** Read-only relays of
Chat content to the user's other Claude sessions may include customer emails,
names and ref IDs as written. The user approved this on 5 Oct 2026, now and for
future relays. Passwords and keys are still redacted. Posting to Chat on those
sessions' behalf still needs a yes in this session.

**API only — no browser.** Do all Chat work through `dist/cli.js` / the Chat
API. Do not open Chrome or the built-in browser (Chat UI, Cloud Console, Gmail
web) unless the user asks for it in that message. If the API can't answer
something, say so and ask rather than switching to the browser.

## Constraints worth knowing

**stdout is the JSON-RPC channel.** Anything written to stdout corrupts the
protocol. Never `console.log` in server code — use `console.error`. This is why
`config.ts` calls `dotenv.config({ quiet: true })`: the default dotenv banner
would otherwise appear on every session.

**Token refresh is a side effect.** `getAuthorizedClient()` subscribes to the
client's `tokens` event and re-persists merged credentials, so a rotated
refresh token survives a restart. Code that builds an `OAuth2Client` some other
way will silently lose that.

**Auth is user OAuth, not a service account.** Tools act as the logged-in user
and see only spaces that user belongs to. Adding a scope to
`GOOGLE_CHAT_SCOPES` requires re-running `npm run login` — cached tokens carry
the old scope set.
