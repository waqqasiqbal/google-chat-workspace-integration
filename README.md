# Google Chat workspace integration

Read and send Google Chat as yourself from Claude Code, through the Google Chat
REST API (`googleapis` chat v1) with user OAuth. No Chat app or bot sends
anything: every message comes from your own account, and every call can only
see the spaces you belong to.

The main entry point is a JSON command-line tool, `dist/cli.js`, which the
project skills in `.claude/skills/` use. Google's hosted Chat MCP endpoint is
not used.

## Google Cloud setup

1. In the Google Cloud console, enable the **Google Chat API** for your project.
2. Configure the OAuth consent screen (Internal is fine for a Workspace domain).
3. Create an **OAuth client ID** of type *Web application* and add
   `http://localhost:8080/oauth2callback` as an authorized redirect URI.
4. Copy the client ID and secret into `.env` (see [Environment](#environment)).

## First run

```sh
npm install
npm run build
npm run login     # opens the consent screen, caches a refresh token
```

`npm run login` writes `.credentials/token.json` (gitignored, mode 0600). After
that, the access token refreshes from it with no browser involved.

The login listener only accepts connections from `127.0.0.1` and checks the
OAuth `state` and PKCE. On a remote machine, forward the port first and open the
printed URL in your local browser:

```sh
ssh -L 8080:127.0.0.1:8080 <host>
```

Adding a scope means running `npm run login` again, because the cached token
keeps the scopes it was issued with.

## Using it

Run commands from the project folder. The CLI refuses to run anywhere else
(exit code 2), so Claude sessions in other projects can't read or send Chat by
accident. Output is JSON.

```sh
node dist/cli.js <command> [args] [--flags]
```

### Reading

| Command | What it does |
| --- | --- |
| `me` | The signed-in user |
| `spaces [--type DIRECT_MESSAGE\|GROUP_CHAT\|SPACE] [--name x] [--active 7d]` | List chats |
| `messages <target> [--limit 10] [--since 2h] [--thread spaces/X/threads/Y]` | Recent messages in one chat |
| `unread [--days 7] [--per 5]` | Unread messages across chats |
| `mentions [--since 2d]` | Messages that tag you (including @all) |
| `search <words...> [--since 3d] [--in <target>]` | Keyword scan over recently active chats |
| `members <target>` | Members of a chat |
| `dm <email>` | Find the DM with someone |
| `contacts [name]` | Look someone up in the local contact cache |
| `aliases` | Saved space nicknames |
| `download <message> [--out dir]` | Save a message's uploaded attachments (default `downloads/`, never overwrites) |

### Writing

| Command | What it does |
| --- | --- |
| `send <target> --text "..." [--thread ...] [--attach a.pdf,b.png] [--mention-all]` | Post a message (or pipe the text in) |
| `edit <message> --text "..."` | Change a message you sent |
| `delete <message>` | Delete a message you sent |
| `react <message> 👍` | Add a reaction |
| `mark-read <target>` | Mark a chat read |
| `mark-meeting-chats-read [--dry-run]` | Mark every Meet meeting chat read |
| `import-contacts <file.json>` | Merge `[{"email","name"}]` into the contact cache |

A `<target>` can be `spaces/XXXX`, a saved nickname, an email (opens the DM), a
contact's name, or part of a space name. An ambiguous target returns the
candidates as an error instead of guessing.

### Tags and safety rails

- `@email`, `@Name` and `＠Name` (full-width) become real mentions when the
  name matches exactly one cached contact. `send` and `edit` refuse to post a
  tag they can't resolve, so a plain-text tag that notifies nobody never goes
  out. The result lists who was mentioned.
- `@all` is only sent as a mention with `--mention-all`.
- `--attach` refuses `.env*` files, anything in `.credentials/` and `~/.ssh`.
- `download` cleans up attachment names and never overwrites an existing file.

## Claude Code skills

| Skill | Use |
| --- | --- |
| `chat-read` | Read DMs, spaces, unread and mentions; look people up |
| `chat-send` | Send, reply, react, edit, delete, mark read. Every write is shown to the user for a yes first |
| `mark-meeting-chats-read` | User-invoked only: clear unread meeting chats |

The working rules (reply placement, tag fixing, what needs confirmation) are in
[CLAUDE.md](CLAUDE.md) and the skill files.

## Local data

All of this lives in `.credentials/` (gitignored, mode 0600):

- `token.json`: the OAuth refresh token
- `contacts.json`: the contact cache. The Chat API returns people only as
  `users/{id}`, so the CLI learns id → email and name and keeps it here.

## Environment

`.env` (gitignored):

| Variable | Required | Default |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | — |
| `GOOGLE_CLIENT_SECRET` | yes | — |
| `GOOGLE_REDIRECT_URI` | no | `http://localhost:8080/oauth2callback` |
| `TOKEN_STORE_PATH` | no | `./.credentials/token.json` |
| `GOOGLE_CHAT_SCOPES` | no | Chat spaces, memberships, messages, reactions, read state, custom emoji, pins, space settings, sections, availability, plus `userinfo.email` |
| `CHAT_TEST_SPACE` | no | Space used as the `playground` nickname for test sends |
| `CHAT_SPACE_<NAME>` | no | Space nicknames, e.g. `CHAT_SPACE_AI_TEAM=spaces/X` is `ai-team` |

## Optional: MCP server

`src/index.ts` and `src/tools.ts` also expose a few basic tools over stdio
(`list_spaces`, `get_space`, `list_messages`, `send_message`, `list_members`),
using the same login. The day-to-day workflow uses the CLI and skills instead.
To register the server anyway:

```sh
claude mcp add google-chat -- node "$PWD/dist/index.js"
```
