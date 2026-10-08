/**
 * Command-line access to Google Chat as the logged-in user. Used by the
 * project-scoped skills in .claude/skills/. Prints JSON to stdout.
 *
 *   node dist/cli.js <command> [args] [--flag value]
 *
 * Refuses to run unless the working directory is inside this project, so a
 * session started elsewhere cannot use it by accident.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { google, chat_v1 } from "googleapis";
import { getAuthorizedClient } from "./auth/client.js";
import { chatApi } from "./chat.js";
import { config, projectRoot } from "./config.js";

type Message = chat_v1.Schema$Message;
type Space = chat_v1.Schema$Space;

// ---------------------------------------------------------------- guard

const cwd = path.resolve(process.cwd());
if (cwd !== projectRoot && !cwd.startsWith(projectRoot + path.sep)) {
  console.error(
    `Refusing to run: Google Chat access is limited to ${projectRoot}.`
  );
  process.exit(2);
}

// ---------------------------------------------------------------- args

const [command, ...rest] = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = "true";
    else flags[key] = rest[++i];
  } else positional.push(a);
}
const num = (k: string, d: number) => (flags[k] ? Number(flags[k]) : d);

/** "30m", "2h", "3d" or an ISO timestamp -> ISO timestamp. */
function since(input: string | undefined, fallback: string): string {
  const v = input ?? fallback;
  const m = /^(\d+)([mhd])$/.exec(v);
  if (!m) return new Date(v).toISOString();
  const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "m" | "h" | "d"];
  return new Date(Date.now() - Number(m[1]) * unit).toISOString();
}

// ---------------------------------------------------------------- contacts
// The Chat API returns people as users/{id} with no name or email. We learn
// id -> email whenever we resolve someone by email, and keep it locally.

const contactsPath = path.join(path.dirname(config.tokenPath), "contacts.json");
type Person = { name?: string; id?: string };
type Contacts = {
  self?: { id: string; email: string };
  byId: Record<string, string>; // users/{id} -> email
  people: Record<string, Person>; // email -> name, id
  names: Record<string, string>; // users/{id} -> display name seen in @mentions
};
let contacts: Contacts = { byId: {}, people: {}, names: {} };
try {
  contacts = { ...contacts, ...JSON.parse(await fs.readFile(contactsPath, "utf8")) };
} catch {}
let contactsDirty = false;
// Older caches only had byId; make sure each of those has a people entry.
for (const [id, email] of Object.entries(contacts.byId)) {
  if (!contacts.people[email]) {
    contacts.people[email] = { id };
    contactsDirty = true;
  }
}
const saveContacts = () =>
  fs.writeFile(contactsPath, JSON.stringify(contacts, null, 2), { mode: 0o600 });

const chat = await chatApi();

async function self(): Promise<{ id: string; email: string }> {
  if (contacts.self) return contacts.self;
  const auth = await getAuthorizedClient();
  const { data } = await google.oauth2({ version: "v2", auth }).userinfo.get();
  const email = data.email!;
  const dm = await anyMembershipSpace();
  const m = await chat.spaces.members.get({ name: `${dm}/members/${email}` });
  contacts.self = { id: m.data.member!.name!, email };
  contacts.byId[contacts.self.id] = email;
  await saveContacts();
  return contacts.self;
}

async function anyMembershipSpace(): Promise<string> {
  const r = await chat.spaces.list({ pageSize: 1 });
  return r.data.spaces![0].name!;
}

function who(id: string | null | undefined): string {
  if (!id) return "unknown";
  if (contacts.self?.id === id) return "me";
  const email = contacts.byId[id];
  const name = (email && contacts.people[email]?.name) || contacts.names[id];
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? id;
}

function learnId(id: string, email: string) {
  if (contacts.byId[id] === email && contacts.people[email]?.id === id) return;
  contacts.byId[id] = email;
  contacts.people[email] = { ...contacts.people[email], id };
  contactsDirty = true;
}

/** People whose name or email local part contains every word of the query. */
function findPeople(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries(contacts.people)
    .filter(([email, p]) => {
      if (email === contacts.self?.email) return false;
      const hay = `${p.name ?? ""} ${email.split("@")[0].replace(/[._-]/g, " ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map(([email]) => email);
}

/**
 * "@someone@company.com" -> a real mention. Chat accepts users/{email}
 * directly, and fills in the person's display name itself.
 */
/**
 * "@Muhammad Asim" / "＠Muhammad Asim" (full-width) -> real mention when the
 * name matches exactly one cached contact. Tries 3, then 2, then 1 words.
 */
function nameMentions(text: string): string {
  return text.replace(
    /(^|[\s(])[@＠]((?:[A-Z][\w'’-]*)(?: [A-Z][\w'’-]*){0,2})/g,
    (whole, pre: string, names: string) => {
      const words = names.split(" ");
      for (let n = words.length; n >= 1; n--) {
        const cand = words.slice(0, n).join(" ").toLowerCase();
        const hits = Object.entries(contacts.people).filter(
          ([, p]) => (p.name ?? "").toLowerCase() === cand
        );
        if (hits.length === 1) {
          const rest = words.slice(n).join(" ");
          return `${pre}<users/${hits[0][0]}>${rest ? " " + rest : ""}`;
        }
      }
      return whole.replace("＠", "@");
    }
  );
}

function withMentions(text: string): string {
  return nameMentions(text.replace(/(^|[\s(])＠(?=[\w.+-]+@)/g, "$1@"))
    .replace(
      /(^|[\s(])@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g,
      (_, pre, email) => `${pre}<users/${email}>`
    )
    .replace(/(^|[\s(])@all\b/g, (_, pre) => `${pre}<users/all>`);
}

/** Upload a local file to the space; returns the attachment for messages.create. */
async function upload(space: string, file: string) {
  const { createReadStream } = await import("node:fs");
  const ext = path.extname(file).toLowerCase();
  const mimeType =
    { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" }[ext] ??
    "application/octet-stream";
  const r = await chat.media.upload({
    parent: space,
    requestBody: { filename: path.basename(file) },
    media: { mimeType, body: createReadStream(file) },
  });
  return { attachmentDataRef: r.data.attachmentDataRef };
}

// ---------------------------------------------------------------- lookups

let allSpaces: Space[] | undefined;
async function listAllSpaces(): Promise<Space[]> {
  if (allSpaces) return allSpaces;
  const out: Space[] = [];
  let pageToken: string | undefined;
  do {
    const r = await chat.spaces.list({ pageSize: 1000, pageToken });
    out.push(...(r.data.spaces ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return (allSpaces = out);
}

/**
 * Space nicknames from .env: CHAT_SPACE_AI_TEAM=spaces/X is "ai-team" (and
 * "ai_team"). CHAT_TEST_SPACE is "playground".
 */
function aliases(): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.CHAT_TEST_SPACE) out.playground = process.env.CHAT_TEST_SPACE;
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^CHAT_SPACE_(.+)$/.exec(k);
    if (!m || !v) continue;
    const key = m[1].toLowerCase();
    out[key] = v;
    out[key.replace(/_/g, "-")] = v;
  }
  return out;
}

/**
 * The DM with this person. With create, starts one if none exists yet;
 * otherwise a missing DM is an error (reads never create spaces).
 */
async function dmFor(email: string, create = false): Promise<string> {
  let space: string;
  try {
    const r = await chat.spaces.findDirectMessage({ name: `users/${email}` });
    space = r.data.name!;
  } catch (err: any) {
    if (err?.code !== 404) throw err;
    if (!create) throw new Error(`No DM with ${email} yet.`);
    const r = await chat.spaces.setup({
      requestBody: {
        space: { spaceType: "DIRECT_MESSAGE" },
        memberships: [{ member: { name: `users/${email}`, type: "HUMAN" } }],
      },
    });
    space = r.data.name!;
  }
  const me = await self();
  const members = await chat.spaces.members.list({ parent: space });
  // DMs can also hold a bot someone added — only the human is this person.
  for (const m of members.data.memberships ?? []) {
    const id = m.member?.name;
    if (id && id !== me.id && m.member?.type === "HUMAN") learnId(id, email);
  }
  return space;
}

/**
 * Accepts spaces/XXX, an email (-> DM), a known contact name fragment
 * (-> DM), or part of a space's display name.
 */
async function resolve(target: string | undefined, create = false): Promise<string> {
  if (!target) throw new Error("Missing target (space, email, or name).");
  if (target.startsWith("spaces/")) return target;
  const alias = aliases()[target.toLowerCase()];
  if (alias) return alias;
  if (target.includes("@")) return dmFor(target, create);

  const t = target.toLowerCase();
  const emails = findPeople(target);
  if (emails.length === 1) return dmFor(emails[0], create);

  const spaces = (await listAllSpaces()).filter((s) =>
    (s.displayName ?? "").toLowerCase().includes(t)
  );
  const exact = spaces.filter((s) => s.displayName!.toLowerCase() === t);
  const pick = exact.length === 1 ? exact : spaces;
  if (pick.length === 1) return pick[0].name!;

  throw new Error(
    JSON.stringify({
      ambiguous: target,
      contacts: emails.slice(0, 15).map((e) => `${contacts.people[e]?.name ?? ""} <${e}>`),
      spaces: pick.slice(0, 15).map((s) => ({ name: s.name, displayName: s.displayName })),
      hint:
        emails.length + pick.length === 0
          ? "No match. Pass the person's email to open their DM."
          : "Pass one of these exactly.",
    })
  );
}

function shape(m: Message) {
  // Mentions carry the display name in the text ("@Zainab Noor") — the only
  // place the API exposes names, so remember them.
  for (const a of m.annotations ?? []) {
    const id = a.userMention?.user?.name;
    if (a.type !== "USER_MENTION" || !id || a.startIndex == null || !a.length) continue;
    const name = (m.text ?? "").substr(a.startIndex, a.length).replace(/^@/, "");
    if (name && name !== "all" && contacts.names[id] !== name) {
      contacts.names[id] = name;
      contactsDirty = true;
    }
  }
  return {
    name: m.name,
    time: m.createTime,
    sender: who(m.sender?.name),
    text: m.text ?? "",
    thread: m.thread?.name,
    ...(m.attachment?.length
      ? { attachments: m.attachment.map((a) => a.contentName) }
      : {}),
    ...(m.lastUpdateTime ? { edited: true } : {}),
  };
}

async function messagesSince(space: string, sinceIso: string, cap = 200) {
  const out: Message[] = [];
  let pageToken: string | undefined;
  do {
    const r = await chat.spaces.messages.list({
      parent: space,
      pageSize: Math.min(100, cap - out.length),
      filter: `createTime > "${sinceIso}"`,
      pageToken,
    });
    out.push(...(r.data.messages ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < cap);
  return out;
}

/** Run fn over items with bounded concurrency. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function activeSpaces(sinceIso: string, limit: number) {
  return (await listAllSpaces())
    .filter((s) => (s.lastActiveTime ?? "") > sinceIso)
    .sort((a, b) => (b.lastActiveTime ?? "").localeCompare(a.lastActiveTime ?? ""))
    .slice(0, limit);
}

const label = (s: Space) => s.displayName || s.spaceType || s.name;

/**
 * Chat makes one space per calendar meeting that has a Meet call, named
 * "<Event title> - Sep 23". They are the only unthreaded spaces whose name
 * ends in a date.
 */
const MEETING_NAME =
  / - (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(, \d{4})?$/;
const isMeetingChat = (s: Space) =>
  s.spaceType === "SPACE" &&
  s.spaceThreadingState === "UNTHREADED_MESSAGES" &&
  MEETING_NAME.test(s.displayName ?? "");

// ---------------------------------------------------------------- commands

const commands: Record<string, () => Promise<unknown>> = {
  async me() {
    return self();
  },

  async spaces() {
    await self();
    let list = await listAllSpaces();
    if (flags.type) list = list.filter((s) => s.spaceType === flags.type.toUpperCase());
    if (flags.name) {
      const t = flags.name.toLowerCase();
      list = list.filter((s) => (s.displayName ?? "").toLowerCase().includes(t));
    }
    if (flags.active) {
      const iso = since(flags.active, "7d");
      list = list.filter((s) => (s.lastActiveTime ?? "") > iso);
    }
    list = [...list].sort((a, b) =>
      (b.lastActiveTime ?? "").localeCompare(a.lastActiveTime ?? "")
    );
    return list.slice(0, num("limit", 50)).map((s) => ({
      name: s.name,
      displayName: s.displayName,
      type: s.spaceType,
      lastActive: s.lastActiveTime,
    }));
  },

  async dm() {
    return { space: await resolve(positional[0]) };
  },

  async members() {
    await self();
    const space = await resolve(positional[0]);
    const r = await chat.spaces.members.list({ parent: space, pageSize: 1000 });
    return (r.data.memberships ?? []).map((m) => ({
      member: who(m.member?.name),
      role: m.role,
      ...(m.member?.type && m.member.type !== "HUMAN" ? { type: m.member.type } : {}),
    }));
  },

  async messages() {
    await self();
    const space = await resolve(positional[0]);
    const filters: string[] = [];
    if (flags.since) filters.push(`createTime > "${since(flags.since, "1d")}"`);
    if (flags.thread) filters.push(`thread.name = "${flags.thread}"`);
    const r = await chat.spaces.messages.list({
      parent: space,
      pageSize: num("limit", 10),
      orderBy: "createTime desc",
      filter: filters.join(" AND ") || undefined,
    });
    const read = await chat.users.spaces.getSpaceReadState({
      name: `users/me/${space}/spaceReadState`,
    });
    return {
      space,
      lastReadTime: read.data.lastReadTime,
      messages: (r.data.messages ?? []).reverse().map(shape),
    };
  },

  async unread() {
    const me = await self();
    const window = since(flags.days ? `${flags.days}d` : undefined, "7d");
    const spaces = await activeSpaces(window, num("spaces", 150));
    const found = await pool(spaces, 10, async (s) => {
      const rs = await chat.users.spaces.getSpaceReadState({
        name: `users/me/${s.name}/spaceReadState`,
      });
      const last = rs.data.lastReadTime ?? window;
      if ((s.lastActiveTime ?? "") <= last) return null;
      const msgs = (await messagesSince(s.name!, last, 50)).filter(
        (m) => m.sender?.name !== me.id
      );
      if (!msgs.length) return null;
      return {
        space: s.name,
        displayName: label(s),
        type: s.spaceType,
        unread: msgs.length,
        messages: msgs.slice(-num("per", 5)).map(shape),
      };
    });
    return found.filter(Boolean);
  },

  async mentions() {
    const me = await self();
    const window = since(flags.since, "2d");
    const spaces = await activeSpaces(window, num("spaces", 150));
    const hits = await pool(spaces, 10, async (s) => {
      const msgs = await messagesSince(s.name!, window);
      return msgs
        .filter((m) => m.sender?.name !== me.id)
        .filter((m) =>
          (m.annotations ?? []).some(
            (a) =>
              a.type === "USER_MENTION" &&
              (a.userMention?.user?.name === me.id || a.userMention?.type === "MENTION_ALL")
          )
        )
        .map((m) => ({ displayName: label(s), space: s.name, ...shape(m) }));
    });
    return hits.flat().sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  },

  async search() {
    await self();
    const words = positional.map((w) => w.toLowerCase());
    if (!words.length) throw new Error("Give one or more keywords.");
    const window = since(flags.since, "3d");
    const spaces = flags.in
      ? [{ name: await resolve(flags.in) } as Space]
      : await activeSpaces(window, num("spaces", 100));
    const hits = await pool(spaces, 10, async (s) =>
      (await messagesSince(s.name!, window, 500))
        .filter((m) => words.every((w) => (m.text ?? "").toLowerCase().includes(w)))
        .map((m) => ({ displayName: label(s), space: s.name, ...shape(m) }))
    );
    return {
      searched: { spaces: spaces.length, since: window },
      results: hits.flat().sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")),
    };
  },

  async send() {
    await self();
    const space = await resolve(positional[0], true);
    const text = flags.text ?? (await readStdin());
    if (!text?.trim()) throw new Error("Nothing to send: pass --text or pipe text in.");
    const attachment = flags.attach
      ? await Promise.all(flags.attach.split(",").map((f) => upload(space, f.trim())))
      : undefined;
    const r = await chat.spaces.messages.create({
      parent: space,
      requestBody: {
        text: withMentions(text),
        ...(attachment ? { attachment } : {}),
        ...(flags.thread ? { thread: { name: flags.thread } } : {}),
      },
      ...(flags.thread
        ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" }
        : {}),
    });
    return { sent: shape(r.data) };
  },

  async edit() {
    const name = positional[0];
    const text = flags.text ?? (await readStdin());
    const r = await chat.spaces.messages.patch({
      name,
      updateMask: "text",
      requestBody: { text: withMentions(text) },
    });
    return { edited: shape(r.data) };
  },

  async delete() {
    await chat.spaces.messages.delete({ name: positional[0] });
    return { deleted: positional[0] };
  },

  /**
   * Save a message's uploaded attachments to --out (default: current dir).
   * Drive files are only listed: this login has no Drive scope.
   */
  async download() {
    const out = flags.out ?? ".";
    await fs.mkdir(out, { recursive: true });
    const m = (await chat.spaces.messages.get({ name: positional[0] })).data;
    const saved: string[] = [];
    const skipped: { name?: string | null; reason: string }[] = [];
    for (const a of m.attachment ?? []) {
      const ref = a.attachmentDataRef?.resourceName;
      if (!ref) {
        skipped.push({ name: a.contentName, reason: a.driveDataRef ? "Drive file" : "no data ref" });
        continue;
      }
      const r = await chat.media.download(
        { resourceName: ref, alt: "media" },
        { responseType: "arraybuffer" }
      );
      const file = path.join(out, path.basename(a.contentName ?? "attachment"));
      await fs.writeFile(file, Buffer.from(r.data as ArrayBuffer));
      saved.push(file);
    }
    return { message: m.name, saved, ...(skipped.length ? { skipped } : {}) };
  },

  async react() {
    const [name, emoji] = positional;
    const r = await chat.spaces.messages.reactions.create({
      parent: name,
      requestBody: { emoji: { unicode: emoji } },
    });
    return { reacted: r.data.name };
  },

  async "mark-read"() {
    const space = await resolve(positional[0]);
    const r = await chat.users.spaces.updateSpaceReadState({
      name: `users/me/${space}/spaceReadState`,
      updateMask: "lastReadTime",
      requestBody: { lastReadTime: new Date().toISOString() },
    });
    return { space, lastReadTime: r.data.lastReadTime };
  },

  /**
   * Mark every Google Meet meeting chat ("<Event> - Sep 23" spaces Chat
   * creates for calendar calls) as read. Only moves read markers forward;
   * never leaves, deletes or posts. --dry-run lists what it would clear.
   */
  async "mark-meeting-chats-read"() {
    const dry = flags["dry-run"] === "true";
    const meetings = (await listAllSpaces()).filter(isMeetingChat);
    const cleared: { name: string; unread: number }[] = [];
    let skipped = 0;
    await pool(meetings, 10, async (s) => {
      const rs = `users/me/${s.name}/spaceReadState`;
      const last = (await chat.users.spaces.getSpaceReadState({ name: rs })).data.lastReadTime ?? "";
      if ((s.lastActiveTime ?? "") <= last) return;
      const unread = last ? (await messagesSince(s.name!, last, 500)).length : 1;
      if (!unread) return;
      if (!dry) {
        try {
          await chat.users.spaces.updateSpaceReadState({
            name: rs,
            updateMask: "lastReadTime",
            requestBody: { lastReadTime: new Date().toISOString() },
          });
        } catch {
          skipped++;
          return;
        }
      }
      cleared.push({ name: s.displayName!, unread });
    });
    cleared.sort((a, b) => a.name.localeCompare(b.name));
    return {
      dryRun: dry,
      meetingChats: meetings.length,
      [dry ? "wouldClear" : "cleared"]: cleared.length,
      messages: cleared.reduce((n, c) => n + c.unread, 0),
      ...(skipped ? { failed: skipped } : {}),
      chats: cleared,
    };
  },

  async aliases() {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(aliases())) if (!k.includes("_")) out[k] = v;
    return out;
  },

  async contacts() {
    const q = positional.join(" ");
    const emails = q
      ? findPeople(q)
      : Object.keys(contacts.people).filter((e) => e !== contacts.self?.email);
    return {
      total: Object.keys(contacts.people).length,
      matches: emails.slice(0, num("limit", 25)).map((email) => ({
        email,
        name: contacts.people[email]?.name,
        chatId: contacts.people[email]?.id ?? null,
      })),
    };
  },

  /**
   * Merge [{email, name}] from a JSON file into the cache, then look up the
   * Chat id of everyone we already have a DM with. Never creates a DM.
   */
  async "import-contacts"() {
    const me = await self();
    const list: { email: string; name?: string }[] = JSON.parse(
      await fs.readFile(positional[0], "utf8")
    );
    let added = 0;
    for (const { email, name } of list) {
      const key = email.toLowerCase();
      if (key === me.email) continue;
      if (!contacts.people[key]) added++;
      contacts.people[key] = { ...contacts.people[key], name: contacts.people[key]?.name ?? name };
    }
    contactsDirty = true;
    const todo = Object.keys(contacts.people).filter(
      (e) => !contacts.people[e].id && e !== me.email
    );
    let linked = 0;
    await pool(todo, 5, async (email) => {
      try {
        await dmFor(email);
        linked++;
      } catch {}
    });
    return {
      added,
      total: Object.keys(contacts.people).length,
      newlyLinkedToChat: linked,
      withChatId: Object.values(contacts.people).filter((p) => p.id).length,
    };
  },
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
}

// ---------------------------------------------------------------- main

const run = commands[command ?? ""];
if (!run) {
  console.error(
    `Usage: node dist/cli.js <${Object.keys(commands).join("|")}> [args] [--flags]`
  );
  process.exit(1);
}
try {
  console.log(JSON.stringify(await run(), null, 2));
} catch (err: any) {
  const msg = err?.errors?.[0]?.message ?? err?.message ?? String(err);
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
} finally {
  if (contactsDirty) await saveContacts();
}
