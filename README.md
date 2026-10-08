# Google Chat MCP

An MCP (Model Context Protocol) server exposing Google Chat spaces, messages
and memberships as tools, over stdio.

## Google Cloud setup

1. In the Google Cloud console, enable the **Google Chat API** for your project.
2. Configure the OAuth consent screen (Internal is fine for a Workspace domain).
3. Create an **OAuth client ID** of type *Web application* and add
   `http://localhost:8080/oauth2callback` as an authorized redirect URI.
4. Put the client id and secret in `.env` (already done).

## First run

```sh
npm install
npm run build
npm run login     # opens the consent screen, caches a refresh token
```

`npm run login` writes `.credentials/token.json` (gitignored, mode 0600). Every
later run refreshes the access token from it with no browser involved.

## Registering with Claude Code

```sh
claude mcp add google-chat -- node "$PWD/dist/index.js"
```

Claude Desktop's `claude_desktop_config.json` equivalent:

```json
{
  "mcpServers": {
    "google-chat": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `list_spaces` | Spaces and DMs the authorized user belongs to |
| `get_space` | Details for one space |
| `list_messages` | Message history, newest first, filterable by time |
| `send_message` | Post a message, optionally as a thread reply |
| `list_members` | Members of a space |

Space arguments accept either `spaces/AAAA1234` or the bare `AAAA1234`.

## Environment

| Variable | Required | Default |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | — |
| `GOOGLE_CLIENT_SECRET` | yes | — |
| `GOOGLE_REDIRECT_URI` | no | `http://localhost:8080/oauth2callback` |
| `TOKEN_STORE_PATH` | no | `./.credentials/token.json` |
| `GOOGLE_CHAT_SCOPES` | no | spaces, messages, memberships.readonly, userinfo.email |
