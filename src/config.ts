import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the folder holding package.json), independent of cwd. */
export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

// quiet: the banner would otherwise sit on stderr for every stdio session.
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} in .env — see README.md for how to obtain it.`
    );
  }
  return value;
}

export const config = {
  clientId: required("GOOGLE_CLIENT_ID"),
  clientSecret: required("GOOGLE_CLIENT_SECRET"),
  redirectUri:
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:8080/oauth2callback",
  tokenPath: path.resolve(
    projectRoot,
    process.env.TOKEN_STORE_PATH ?? "./.credentials/token.json"
  ),
  scopes: (
    process.env.GOOGLE_CHAT_SCOPES ??
    // Full read/write as the signed-in user. Admin (chat.admin.*) and
    // chat.delete (delete whole spaces) are deliberately left out.
    [
      "https://www.googleapis.com/auth/chat.spaces",
      "https://www.googleapis.com/auth/chat.memberships",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.messages.reactions",
      "https://www.googleapis.com/auth/chat.users.readstate",
      "https://www.googleapis.com/auth/chat.customemojis",
      "https://www.googleapis.com/auth/chat.spaces.pins",
      "https://www.googleapis.com/auth/chat.users.spacesettings",
      "https://www.googleapis.com/auth/chat.users.sections",
      "https://www.googleapis.com/auth/chat.users.availability",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
