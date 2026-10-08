/**
 * One-time interactive login. Opens the Google consent screen, catches the
 * redirect on the loopback listener named by GOOGLE_REDIRECT_URI, and writes
 * the resulting refresh token to TOKEN_STORE_PATH.
 */
import http from "node:http";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { createOAuthClient, saveTokens } from "./client.js";

const redirect = new URL(config.redirectUri);
const port = Number(redirect.port || 80);

const client = createOAuthClient();
const authUrl = client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: config.scopes,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Authorization failed: ${error ?? "no code returned"}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const { tokens } = await client.getToken(code);
    await saveTokens(tokens);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Authorized. You can close this tab and return to the terminal.");
    console.log(`\nSaved credentials to ${config.tokenPath}`);
    if (!tokens.refresh_token) {
      console.warn(
        "Warning: no refresh_token returned. Revoke the app at " +
          "https://myaccount.google.com/permissions and log in again."
      );
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Token exchange failed. See terminal.");
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, () => {
  console.log(`Listening on ${config.redirectUri}`);
  console.log(`\nOpen this URL to authorize:\n\n${authUrl}\n`);
  spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();
});
