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
import os from "node:os";
import path from "node:path";
import { google, chat_v1 } from "googleapis";
import { getAuthorizedClient } from "./auth/client.js";
import { chatApi } from "./chat.js";
import { gmailApi, attachmentParts } from "./gmail.js";
import { config, projectRoot } from "./config.js";

type Message = chat_v1.Schema$Message;
type Space = chat_v1.Schema$Space;

// ---------------------------------------------------------------- guard

/**
 * Read-only mode (CHAT_READONLY=1, set by bin/chat-read). Any session on this
 * machine may run it from any folder, but only the read commands in
 * READ_COMMANDS run; every write command is refused before any API call.
 */
const READONLY = process.env.CHAT_READONLY === "1";
const READ_COMMANDS = new Set([
  "me", "spaces", "dm", "members", "messages", "get", "unread", "mentions",
  "search", "download", "gmail-download", "aliases", "contacts",
]);

const cwd = path.resolve(process.cwd());
if (!READONLY && cwd !== projectRoot && !cwd.startsWith(projectRoot + path.sep)) {
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
    // --text always takes the next arg, so "--text '--- Summary ---'" works.
    if (next === undefined || (key !== "text" && next.startsWith("--"))) flags[key] = "true";
    else flags[key] = rest[++i];
  } else positional.push(a);
}
if (READONLY && !READ_COMMANDS.has(command ?? "")) {
  console.error(
    `chat-read is read-only. Commands: ${[...READ_COMMANDS].join(", ")}. ` +
      `To post, react, edit or mark read, SendMessage "Google Workspace Chat (${
        process.platform === "darwin" ? "Local" : "Linux"
      })".`
  );
  process.exit(command ? 3 : 1);
}

const num = (k: string, d: number) => {
  if (!flags[k]) return d;
  const n = Number(flags[k]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number.`);
  return n;
};

/** "30m", "2h", "3d" or an ISO timestamp -> ISO timestamp. */
function since(input: string | undefined, fallback: string): string {
  const v = input ?? fallback;
  const m = /^(\d+)([mhd])$/.exec(v);
  if (!m) {
    const d = new Date(v);
    if (isNaN(d.getTime())) throw new Error(`Bad time "${v}": use 30m, 2h, 3d or an ISO date.`);
    return d.toISOString();
  }
  const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "m" | "h" | "d"];
  return new Date(Date.now() - Number(m[1]) * unit).toISOString();
}

// ---------------------------------------------------------------- contacts
// The Chat API returns people as users/{id} with no name or email. We learn
// id -> email whenever we resolve someone by email, and keep it locally.

const contactsPath =
  process.env.CONTACTS_PATH ?? path.join(path.dirname(config.tokenPath), "contacts.json");
type Person = { name?: string; id?: string };
type Contacts = {
  self?: { id: string; email: string };
  byId: Record<string, string>; // users/{id} -> email
  people: Record<string, Person>; // email -> name, id
  names: Record<string, string>; // users/{id} -> display name seen in @mentions
};
let contacts: Contacts = { byId: {}, people: {}, names: {} };
try {
  const disk = JSON.parse(await fs.readFile(contactsPath, "utf8"));
  // Ignore a cache of the wrong shape; saveContacts sets it aside.
  if (disk && typeof disk === "object" && !Array.isArray(disk))
    contacts = {
      ...contacts,
      ...disk,
      byId: { ...(disk.byId ?? {}) },
      people: { ...(disk.people ?? {}) },
      names: { ...(disk.names ?? {}) },
    };
} catch {}
let contactsDirty = false;
// Older caches only had byId; make sure each of those has a people entry.
for (const [id, email] of Object.entries(contacts.byId)) {
  if (!contacts.people[email]) {
    contacts.people[email] = { id };
    contactsDirty = true;
  }
}
// Several sessions may run chat-read at once: merge what others saved since
// we loaded (our entries win), then write a temp file and rename it so a
// reader never sees a half-written cache.
const saveContacts = async () => {
  let disk: Partial<Contacts> = {};
  try {
    disk = JSON.parse(await fs.readFile(contactsPath, "utf8"));
    if (!disk || typeof disk !== "object" || Array.isArray(disk))
      throw new SyntaxError("contacts cache is not an object");
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      disk = {};
      // Writes are atomic, so this is real corruption: keep a copy, start fresh.
      await fs.rename(contactsPath, `${contactsPath}.corrupt-${Date.now()}`).catch(() => {});
    } else if (err?.code !== "ENOENT") {
      // Unreadable (permissions...): don't overwrite what others saved.
      console.error(`Warning: contacts cache not saved (${err?.message ?? err}).`);
      return;
    }
  }
  contacts = {
    ...disk,
    ...contacts,
    byId: { ...disk.byId, ...contacts.byId },
    people: { ...disk.people, ...contacts.people },
    names: { ...disk.names, ...contacts.names },
  };
  const tmp = `${contactsPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(contacts, null, 2), { mode: 0o600 });
    await fs.rename(tmp, contactsPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

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
 * "@Muhammad Asim" / "＠Muhammad Asim" (full-width) -> real mention when the
 * name matches exactly one cached contact. Tries 3, then 2, then 1 words.
 * Names that match nobody or several people are collected in `unresolved`.
 */
function nameMentions(text: string, unresolved: string[]): string {
  return text.replace(
    // Not followed by ".x" or "@": "@John.Smith@corp.com" is an email, not a name.
    /(^|[\s(])[@＠]((?:[A-Z][\w'’-]*)(?: [A-Z][\w'’-]*){0,2})(?![\w'’-]|[.@]\w)/g,
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
      if (names.toLowerCase() !== "all") unresolved.push(names);
      return whole.replace("＠", "@");
    }
  );
}

/**
 * Turn every tag into a real mention and return who gets notified.
 * "@someone@company.com" works directly (Chat fills in the display name).
 * "@all" only becomes a mention with --mention-all, so quoted text can't
 * notify a whole space. Throws rather than posting a fake tag.
 */
function withMentions(text: string): { text: string; mentions: string[] } {
  const unresolved: string[] = [];
  let out = nameMentions(text.replace(/(^|[\s(])＠(?=[\w.+-]+@)/g, "$1@"), unresolved).replace(
    /(^|[\s(])@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g,
    (_, pre, email) => `${pre}<users/${email.toLowerCase()}>`
  );
  // "@all" alone, not "@all-hands" or "@all.x".
  const allTag = /(^|[\s(])[@＠]all(?![\w-]|\.\w)/gi;
  if (flags["mention-all"] === "true") out = out.replace(allTag, (_, pre) => `${pre}<users/all>`);
  else if (allTag.test(out))
    throw new Error("Text contains @all. Pass --mention-all to notify everyone, or reword it.");
  if (unresolved.length)
    throw new Error(
      `Unresolved tag(s): ${unresolved.map((n) => "@" + n).join(", ")}. ` +
        "Look the person up with `contacts <name>` and use @email."
    );
  const mentions = [...out.matchAll(/<users\/([^>]+)>/g)].map((m) => m[1]);
  return { text: out, mentions: [...new Set(mentions)] };
}

/** Refuse to upload credentials, env files or SSH keys. */
async function checkAttachable(file: string): Promise<string> {
  const real = await fs.realpath(file);
  const base = path.basename(real);
  const home = process.env.HOME;
  const under = (dir: string) => real.startsWith(dir + path.sep);
  if (
    under(path.dirname(config.tokenPath)) ||
    base.startsWith(".env") ||
    (home && under(path.join(home, ".ssh")))
  )
    throw new Error(`Refusing to attach ${file}: it holds credentials.`);
  return real;
}

/** Upload a local file to the space; returns the attachment for messages.create. */
async function upload(space: string, file: string) {
  const { createReadStream } = await import("node:fs");
  file = await checkAttachable(file);
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

/**
 * Where downloads go. The relay keeps its old default (downloads/ here). In
 * read-only mode --out is required, is read relative to the caller's folder,
 * and must sit inside ~/Claude Code Projects (symlinks resolved), outside
 * this project and outside any dot-folder (.git, .claude, .credentials...).
 */
async function outDir(): Promise<string> {
  if (!READONLY) {
    const out = path.resolve(flags.out ?? path.join(projectRoot, "downloads"));
    await fs.mkdir(out, { recursive: true });
    return out;
  }
  if (!flags.out || flags.out === "true")
    throw new Error("Pass --out <folder inside your project> for downloads.");
  const root = await fs.realpath(path.join(os.homedir(), "Claude Code Projects"));
  const out = path.resolve(cwd, flags.out);
  // Check the nearest existing parent before creating anything.
  let probe = out;
  while (true) {
    try {
      probe = await fs.realpath(probe);
      break;
    } catch {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  const relay = await fs.realpath(projectRoot);
  // A project (or one of its .claude/worktrees/<name> checkouts) and then at
  // least one plain subfolder: never a project's top folder, where agent
  // config lives, and never a dot-folder.
  const inside = (real: string, existingParent = false) => {
    if (!real.startsWith(root + path.sep)) return false;
    for (const r of [relay, `${relay}-worktrees`])
      if (real === r || real.startsWith(r + path.sep)) return false;
    const segs = path.relative(root, real).split(path.sep);
    // Worktree checkouts count as projects: <p>/.claude/worktrees/<name> and
    // the sibling layout <p>-worktrees/<name>.
    const base =
      segs[1] === ".claude" && segs[2] === "worktrees" && segs[3]
        ? 4
        : segs[0].endsWith("-worktrees")
          ? 2
          : 1;
    // The project (or worktree) itself must exist as named: no dot-folders
    // besides the literal .claude of .claude/worktrees.
    if (segs.length < base) return false;
    if (segs.slice(0, base).some((seg, i) => seg.startsWith(".") && !(base === 4 && i === 1)))
      return false;
    const below = segs.slice(base);
    // The nearest existing parent of a new folder may be the project itself.
    return (existingParent || below.length > 0) && !below.some((seg) => seg.startsWith("."));
  };
  const why =
    `--out must be a subfolder of a project in ${root} (e.g. local/files), ` +
    "not a project's top folder, a dot-folder or this relay's project.";
  if (!inside(path.resolve(out)) || !inside(probe, true)) throw new Error(why);
  await fs.mkdir(out, { recursive: true });
  const real = await fs.realpath(out);
  if (!inside(real)) throw new Error(why);
  return real;
}

/**
 * Attachment name -> safe file name. Keeps letters, digits, spaces and
 * . _ ( ) -, no leading dot. In read-only mode only common document, media
 * and data files keep their name; anything else (dotfiles, scripts, config
 * formats, names with no extension) and names agents or tools load as
 * config (CLAUDE.md, settings.json...) get an "attachment-" prefix, so a Chat
 * file can never become one.
 */
const SAFE_EXT =
  /\.(pdf|docx?|xlsx?|xlsm|csv|tsv|pptx?|odt|ods|odp|rtf|txt|md|eml|msg|png|jpe?g|gif|webp|heic|bmp|tiff?|mp4|mov|webm|mp3|wav|m4a|ogg|zip)$/i;
// Instruction files agents pick up: CLAUDE.md, AGENTS.override.md, SKILL (1).md,
// copilot-instructions.md... Judged on the stem before the first dot, space
// or bracket: all-caps stems and known names.
const KNOWN_INSTRUCTION = /^(claude|agents?|gemini|qwen|skill|readme|conventions|copilot-instructions)$/i;
function instructionLike(name: string): boolean {
  if (!/\.md$/i.test(name)) return false;
  const stem = name.split(/[ .(]/)[0];
  return (/^[A-Z0-9_-]+$/.test(stem) && /[A-Z]/.test(stem)) || KNOWN_INSTRUCTION.test(stem);
}
function safeName(raw: string | null | undefined): string {
  const base = path.basename(raw ?? "");
  const clean =
    base.replace(/[^\w .()-]/g, "_").replace(/^\.+/, "").replace(/[. ]+$/, "") || "attachment";
  if (!READONLY || clean === "attachment") return clean;
  const risky = base.startsWith(".") || !SAFE_EXT.test(clean) || instructionLike(clean);
  return risky ? `attachment-${clean}` : clean;
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
  if (target.includes("@")) return dmFor(target.toLowerCase(), create);

  const t = target.toLowerCase();
  const emails = findPeople(target);
  if (emails.length === 1) return dmFor(emails[0], create);
  // Several people match: don't fall through to a space with a similar name.
  if (emails.length > 1)
    throw new Error(
      JSON.stringify({
        ambiguous: target,
        contacts: emails.slice(0, 15).map((e) => `${contacts.people[e]?.name ?? ""} <${e}>`),
        hint: "Pass one of these emails exactly.",
      })
    );

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

/**
 * The newest `cap` messages since sinceIso, returned oldest-first. Fetches
 * newest-first so a busy space never hides its latest messages behind the cap.
 */
async function messagesSince(space: string, sinceIso: string, cap = 200) {
  const out: Message[] = [];
  let pageToken: string | undefined;
  do {
    const r = await chat.spaces.messages.list({
      parent: space,
      pageSize: Math.min(100, cap - out.length),
      filter: `createTime > "${sinceIso}"`,
      orderBy: "createTime desc",
      pageToken,
    });
    out.push(...(r.data.messages ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < cap);
  return Object.assign(out.reverse(), { capped: !!pageToken });
}

/**
 * Run fn over items with bounded concurrency. One failing item (a space we
 * lost access to, a rate limit) becomes undefined instead of failing all.
 */
let poolFailures = 0;
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: (R | undefined)[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx]);
        } catch {
          poolFailures++;
        }
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

  /**
   * One message in full: text, sender, thread, attachment details and the
   * message it quotes. For replies use `messages <space> --thread <thread>`.
   */
  async get() {
    await self();
    const name = positional[0];
    if (!name?.startsWith("spaces/")) throw new Error("Usage: get spaces/<id>/messages/<id>");
    let m: Message;
    try {
      m = (await chat.spaces.messages.get({ name })).data;
    } catch (err: any) {
      // A thread's first message is named X.X; accept the short form X too.
      const short = /^spaces\/[^/]+\/messages\/([^/.]+)$/.exec(name);
      const status = Number(err?.status ?? err?.response?.status ?? err?.code);
      const notFound = status === 404 || status === 400 || err?.code === "NOT_FOUND";
      if (!short || !notFound) throw err;
      m = (await chat.spaces.messages.get({ name: `${name}.${short[1]}` })).data;
    }
    return {
      ...shape(m),
      ...(m.attachment?.length
        ? {
            attachments: m.attachment.map((a) => ({
              name: a.contentName,
              type: a.contentType,
              source: a.driveDataRef ? "drive" : "upload",
              ...(a.driveDataRef?.driveFileId ? { driveFileId: a.driveDataRef.driveFileId } : {}),
            })),
          }
        : {}),
      ...(m.quotedMessageMetadata?.name ? { quotes: m.quotedMessageMetadata.name } : {}),
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
      const fetched = await messagesSince(s.name!, last, 50);
      const msgs = fetched.filter((m) => m.sender?.name !== me.id);
      if (!msgs.length) return null;
      return {
        space: s.name,
        displayName: label(s),
        type: s.spaceType,
        unread: fetched.capped ? `${msgs.length}+` : msgs.length,
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
    return hits
      .flat()
      .filter((h) => h !== undefined)
      .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
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
      results: hits
        .flat()
        .filter((h) => h !== undefined)
        .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")),
    };
  },

  async send() {
    await self();
    const space = await resolve(positional[0], true);
    const text = flags.text ?? (await readStdin());
    if (!text?.trim()) throw new Error("Nothing to send: pass --text or pipe text in.");
    const tagged = withMentions(text);
    const attachment = flags.attach
      ? await Promise.all(flags.attach.split(",").map((f) => upload(space, f.trim())))
      : undefined;
    const r = await chat.spaces.messages.create({
      parent: space,
      requestBody: {
        text: tagged.text,
        ...(attachment ? { attachment } : {}),
        ...(flags.thread ? { thread: { name: flags.thread } } : {}),
      },
      ...(flags.thread
        ? { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" }
        : {}),
    });
    return { sent: shape(r.data), mentioned: tagged.mentions };
  },

  async edit() {
    await self();
    const name = positional[0];
    if (!name) throw new Error("Missing message name.");
    const text = flags.text ?? (await readStdin());
    if (!text?.trim()) throw new Error("Nothing to change: pass --text or pipe text in.");
    const tagged = withMentions(text);
    const r = await chat.spaces.messages.patch({
      name,
      updateMask: "text",
      requestBody: { text: tagged.text },
    });
    return { edited: shape(r.data), mentioned: tagged.mentions };
  },

  async delete() {
    await chat.spaces.messages.delete({ name: positional[0] });
    return { deleted: positional[0] };
  },

  /**
   * Save a message's uploaded attachments to --out (default: downloads/ in
   * this project). The sender picks the file names, so names are sanitised
   * and existing files are never overwritten. Drive files are only listed:
   * this login has no Drive scope.
   */
  async download() {
    if (!positional[0]) throw new Error("Usage: download <message name> --out <dir>");
    const out = await outDir();
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
      const clean = safeName(a.contentName);
      const { name: stem, ext } = path.parse(clean);
      for (let n = 0; ; n++) {
        const file = path.join(out, n ? `${stem} (${n})${ext}` : clean);
        try {
          await fs.writeFile(file, Buffer.from(r.data as ArrayBuffer), { flag: "wx" });
          saved.push(file);
          break;
        } catch (err: any) {
          if (err?.code !== "EEXIST") throw err;
        }
      }
    }
    return { message: m.name, saved, ...(skipped.length ? { skipped } : {}) };
  },

  /**
   * Save a Gmail message's attachments to --out (default: downloads/ in this
   * project). Mirrors `download` for Chat but goes through the Gmail API,
   * which the Gmail connector other sessions use cannot do. Read-only:
   * needs the gmail.readonly scope. Pass a message id as the first argument
   * (the id from the Gmail connector's get_message, or a Gmail URL's
   * /.../<id> hex id). --attachment <id> fetches just that one part;
   * otherwise every attachment on the message is saved.
   */
  async "gmail-download"() {
    const id = positional[0];
    if (!id) throw new Error("Usage: gmail-download <messageId> [--attachment <id>] [--out <dir>]");
    const out = await outDir();
    const gmail = await gmailApi();
    const msg = (
      await gmail.users.messages.get({ userId: "me", id, format: "full" })
    ).data;
    let parts = attachmentParts(msg.payload);
    if (flags.attachment) parts = parts.filter((p) => p.body?.attachmentId === flags.attachment);
    const saved: string[] = [];
    const skipped: { name?: string | null; reason: string }[] = [];
    for (const p of parts) {
      const attachmentId = p.body?.attachmentId;
      if (!attachmentId) {
        skipped.push({ name: p.filename, reason: "no attachment id" });
        continue;
      }
      const a = (
        await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: id,
          id: attachmentId,
        })
      ).data;
      if (!a.data) {
        skipped.push({ name: p.filename, reason: "no data" });
        continue;
      }
      // Gmail returns base64url (RFC 4648 §5): - _ instead of + /.
      const buf = Buffer.from(a.data, "base64url");
      const clean = safeName(p.filename);
      const { name: stem, ext } = path.parse(clean);
      for (let n = 0; ; n++) {
        const file = path.join(out, n ? `${stem} (${n})${ext}` : clean);
        try {
          await fs.writeFile(file, buf, { flag: "wx" });
          saved.push(file);
          break;
        } catch (err: any) {
          if (err?.code !== "EEXIST") throw err;
        }
      }
    }
    return { message: id, saved, ...(skipped.length ? { skipped } : {}) };
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
if (READONLY) {
  // Audit trail: which folder ran which read. No message content, and no
  // free-text queries (search words, contact names) are logged.
  const log = path.join(projectRoot, ".credentials", "logs", "chat-read.log");
  const target = ["search", "contacts"].includes(command) ? undefined : positional[0];
  const line = JSON.stringify({ t: new Date().toISOString(), cwd, command, target });
  await fs.mkdir(path.dirname(log), { recursive: true }).catch(() => {});
  await fs.appendFile(log, line + "\n", { mode: 0o600 }).catch(() => {});
}
try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
  if (poolFailures) console.error(`Warning: ${poolFailures} chat(s) could not be read and were skipped.`);
} catch (err: any) {
  const msg = err?.errors?.[0]?.message ?? err?.message ?? String(err);
  console.error(`Error: ${msg}`);
  process.exitCode = 1;
} finally {
  if (contactsDirty)
    await saveContacts().catch((err) =>
      console.error(`Warning: contacts cache not saved (${err?.message ?? err}).`)
    );
}
