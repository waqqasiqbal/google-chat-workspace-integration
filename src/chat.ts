import { google, chat_v1 } from "googleapis";
import { getAuthorizedClient } from "./auth/client.js";

let cached: chat_v1.Chat | undefined;

export async function chatApi(): Promise<chat_v1.Chat> {
  if (!cached) {
    const auth = await getAuthorizedClient();
    cached = google.chat({ version: "v1", auth });
  }
  return cached;
}

/**
 * Space names come back as "spaces/AAAA...". Accept either that or the bare id
 * so callers can paste whichever form they have.
 */
export function spaceName(input: string): string {
  return input.startsWith("spaces/") ? input : `spaces/${input}`;
}
