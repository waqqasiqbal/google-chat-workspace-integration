import { OAuth2Client } from "google-auth-library";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export function createOAuthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
}

export async function saveTokens(tokens: object): Promise<void> {
  await fs.mkdir(path.dirname(config.tokenPath), { recursive: true });
  await fs.writeFile(config.tokenPath, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

/**
 * Returns a client already carrying the cached refresh token. The googleapis
 * layer refreshes the access token on demand, and we persist the new one so a
 * restart does not force another browser round trip.
 */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  let raw: string;
  try {
    raw = await fs.readFile(config.tokenPath, "utf8");
  } catch {
    throw new Error(
      `Not authorized yet — no token at ${config.tokenPath}. Run: npm run login`
    );
  }

  const client = createOAuthClient();
  client.setCredentials(JSON.parse(raw));
  client.on("tokens", (tokens) => {
    const merged = { ...client.credentials, ...tokens };
    void saveTokens(merged);
  });
  return client;
}
