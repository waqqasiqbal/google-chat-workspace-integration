import { google, gmail_v1 } from "googleapis";
import { getAuthorizedClient } from "./auth/client.js";

let cached: gmail_v1.Gmail | undefined;

/**
 * Memoized Gmail client for the logged-in user. Needs the gmail.readonly
 * scope (see config.ts); a token minted before that scope was added will get
 * a 403 until `npm run login` is re-run.
 */
export async function gmailApi(): Promise<gmail_v1.Gmail> {
  if (!cached) {
    const auth = await getAuthorizedClient();
    cached = google.gmail({ version: "v1", auth });
  }
  return cached;
}

/** Walk a message payload tree and yield every part that is an attachment. */
export function attachmentParts(
  payload: gmail_v1.Schema$MessagePart | undefined
): gmail_v1.Schema$MessagePart[] {
  const out: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p?: gmail_v1.Schema$MessagePart) => {
    if (!p) return;
    if (p.body?.attachmentId && (p.filename ?? "") !== "") out.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}
