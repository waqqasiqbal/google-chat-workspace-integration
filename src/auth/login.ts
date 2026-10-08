/**
 * One-time interactive login. Opens the Google consent screen, catches the
 * redirect on the loopback listener named by GOOGLE_REDIRECT_URI, and writes
 * the resulting refresh token to TOKEN_STORE_PATH.
 *
 * The listener binds to 127.0.0.1 only, and the callback must carry the
 * random `state` and match the PKCE verifier, so nobody else can finish the
 * login with their own account. On a remote machine, forward the port over
 * SSH (ssh -L <port>:127.0.0.1:<port> host) and open the URL locally.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import { CodeChallengeMethod } from "google-auth-library";
import { config } from "../config.js";
import { createOAuthClient, saveTokens } from "./client.js";

const redirect = new URL(config.redirectUri);
const port = Number(redirect.port || 80);

const client = createOAuthClient();
const state = randomBytes(24).toString("hex");
const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
const authUrl = client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: config.scopes,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: CodeChallengeMethod.S256,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }

  // A request without our state is not Google's redirect for this login:
  // ignore it and keep waiting rather than letting it end the login.
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid state.");
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
    const { tokens } = await client.getToken({ code, codeVerifier });
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Listening on ${config.redirectUri}`);
  console.log(`\nOpen this URL to authorize:\n\n${authUrl}\n`);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  // No browser here (e.g. over SSH): the URL above is enough.
  spawn(opener, [authUrl], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
});
