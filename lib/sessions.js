/**
 * Harness-free logic for recalling what happened in a repository's past sessions.
 *
 * Session *content* is not this plugin's to own: DSH already mounts
 * `@deepseek-ai/dsh-session-query-sqlite`, so `ctx.sessionQuery` is the source for
 * the session list and for every conversation body. This module shapes what that
 * service returns.
 *
 * Titles are the exception, and deliberately so. `readTitleSnapshots` answers only
 * for sessions warm in the running app: a cold session's folded title — the one
 * the harness itself writes into `session/title` and the GUI shows — comes back
 * empty, which used to leave every cold session rendered as （无标题） while its
 * title sat on disk. So titles fall back to the disk, read-only, in this order:
 *
 * 1. the harness's own folded row, `<home>/storages/session_projcache/sessions/<id>.json`
 *    (`record.rows.title.val`) — one small JSON read, and the same string the GUI
 *    shows, because it is the same value;
 * 2. failing that, the `session/title` events at the head of
 *    `<home>/sessions/<project>/<id>/session.v<N>.jsonl.zstd` — a bounded read of
 *    the first frames, because the log is a concatenation of independent zstd
 *    frames appended per write and the title lands in the first few of them.
 *
 * Neither source ever supplies a conversation body, so the injection surface the
 * README worries about does not widen.
 *
 * The shapes below were read from the shipped implementation, not assumed:
 * - `listSessions()` yields `{ header, live, persisted }`, newest first by
 *   `header.createdAt` (epoch ms), with `header.cwd` and `header.id`.
 * - `readTitleSnapshots(ids)` yields `[{ session: <header>, title?: <snapshot> }]`
 *   where the folded snapshot is an object carrying `.title` as a string.
 * - the session cache is `{ version, record: { identity, rows } }`, and a row is
 *   `{ ver, seq, val }` — so the title lives at `record.rows.title.val`.
 *
 * @module dsh-project-memory/sessions
 */

import { open, readFile, readdir } from 'node:fs/promises'
import { join, normalize, resolve } from 'node:path'
import * as zlib from 'node:zlib'

/** How many past sessions the resident list carries by default. */
export const DEFAULT_RECENT_SESSIONS = 5

/** Byte budget for the resident list, framing excluded. */
export const DEFAULT_RECENT_SESSION_BYTES = 600

/** Compare paths the way the platform does: case-folded, forward slashes. */
function normalizeForCompare(path) {
  return normalize(resolve(String(path))).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether a session's working directory belongs to this project.
 *
 * Sessions are filtered by their `cwd`, which may be a subdirectory of the
 * repository, so containment is a prefix test rather than equality. That is
 * right for `identity: repository`. Under `identity: directory` the workspace
 * itself is the whole project, so callers pass `exact: true` and a child
 * directory is a different project, not part of this one.
 *
 * @param repositoryRoot - the agent's resolved project root.
 * @param candidate - a session header's cwd, possibly undefined.
 * @param options - `exact` to require the same directory rather than containment.
 * @returns whether the session belongs to this project.
 */
export function withinRepository(repositoryRoot, candidate, { exact = false } = {}) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return false
  const root = normalizeForCompare(repositoryRoot)
  const target = normalizeForCompare(candidate)
  if (target === root) return true
  return exact ? false : target.startsWith(`${root}/`)
}

/**
 * Extract the human title string from one `readTitleSnapshots` entry.
 *
 * The folded snapshot is an object, so the text lives at `.title.title`. A plain
 * string is accepted too: the snapshot's exact type is not part of the
 * documented contract, and reading a title should never be the thing that breaks.
 *
 * @param entry - one element of the `readTitleSnapshots` result.
 * @returns the title text, or undefined when the session has none.
 */
export function titleTextOf(entry) {
  const snapshot = entry?.title
  if (typeof snapshot === 'string' && snapshot.trim().length > 0) return snapshot.trim()
  if (typeof snapshot?.title === 'string' && snapshot.title.trim().length > 0) return snapshot.title.trim()
  return undefined
}

/**
 * Collect why `readTitleSnapshots` returned nothing for some sessions.
 *
 * The service isolates per-session failures instead of throwing: a failed entry
 * arrives as `{ sessionId, status: 'rejected', reason }` with no `session` and no
 * `title`. Skipping those silently renders every session as untitled with no
 * hint why, which is exactly what happened the first time this shipped.
 *
 * @param titleSnapshots - the `readTitleSnapshots` result.
 * @returns one human-readable line per rejected session.
 */
export function titleFailures(titleSnapshots) {
  const failures = []
  for (const entry of titleSnapshots ?? []) {
    if (entry?.status !== 'rejected') continue
    const reason = entry.reason?.message ?? entry.reason ?? 'rejected'
    failures.push(`${entry.sessionId ?? 'unknown'}: ${reason}`)
  }
  return failures
}

/**
 * Reduce the session corpus to this repository's most recent sessions.
 *
 * @param options - corpus records, title snapshots, repository root, exclusions and cap.
 * @returns entries newest first, each carrying a title only when one exists.
 */
export function selectRecentSessions({
  sessions = [],
  titleSnapshots = [],
  repositoryRoot,
  exact = false,
  excludeSessionId,
  limit = DEFAULT_RECENT_SESSIONS,
}) {
  const titleById = new Map()
  for (const entry of titleSnapshots) {
    const id = entry?.session?.id
    if (typeof id !== 'string') continue
    const text = titleTextOf(entry)
    if (text !== undefined) titleById.set(id, text)
  }

  const matching = []
  for (const record of sessions) {
    const header = record?.header
    if (header === undefined || typeof header.id !== 'string') continue
    if (excludeSessionId !== undefined && header.id === excludeSessionId) continue
    if (!withinRepository(repositoryRoot, header.cwd, { exact })) continue
    matching.push({
      id: header.id,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      title: titleById.get(header.id),
    })
  }
  matching.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  return matching.slice(0, Math.max(0, limit))
}

/** Default stamp: the viewer's local `MM-DD HH:mm`, which is what a human reads. */
export function defaultStamp(epochMs) {
  const date = new Date(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One rendered line per session. */
export function sessionLine(entry, formatStamp = defaultStamp, { withId = false } = {}) {
  const stamp = entry.createdAt > 0 ? `${formatStamp(entry.createdAt)} · ` : ''
  const title = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : '（无标题）'
  // The resident block omits ids to save budget: it exists so the agent knows a
  // session happened, while the tool lists the same sessions with ids to act on.
  const id = withId && typeof entry.id === 'string' ? `${entry.id} · ` : ''
  return `- ${id}${stamp}${title}`
}

/**
 * Render the resident recent-sessions block within a byte budget.
 *
 * @param entries - entries from {@link selectRecentSessions}.
 * @param options - budget and an injectable stamp formatter for tests.
 * @returns the block text, what fit, and how many were left out.
 */
export function renderRecentSessions(entries, { maxBytes = DEFAULT_RECENT_SESSION_BYTES, formatStamp } = {}) {
  const included = []
  const lines = []
  let used = 0
  for (const entry of entries) {
    const line = sessionLine(entry, formatStamp)
    const cost = Buffer.byteLength(`${line}\n`, 'utf8')
    if (used + cost > maxBytes && included.length > 0) break
    lines.push(line)
    included.push(entry)
    used += cost
  }
  const omitted = entries.length - included.length
  return { text: lines.join('\n'), included, omitted, bytes: used }
}

/**
 * Extract readable text from one raw event record.
 *
 * `listEvents` documents "lightweight raw-log event records" without pinning the
 * envelope, so both a bare event and a wrapped one are accepted.
 *
 * @param record - one element of the `listEvents` result.
 * @returns the event, or undefined when it cannot be recognised.
 */
function eventOf(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (typeof record.type === 'string') return record
  if (record.event !== null && typeof record.event === 'object' && typeof record.event.type === 'string') {
    return record.event
  }
  return undefined
}

/** Concatenate the text blocks of a message-shaped event's content. */
function textOf(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text.length > 0 ? text : undefined
}

/**
 * Turn one session's event records into a bounded outline of what happened.
 *
 * Only user and assistant text is surfaced: tool calls and their output are
 * where untrusted repository and web content lands, and an outline is meant to
 * be a map of the session, not a transcript of it.
 *
 * @param records - the `listEvents` result.
 * @param options - how many turns to keep and how many bytes to spend.
 * @returns the outline plus the counts it is derived from.
 */
export function outlineSession(input, { maxTurns = 12, maxBytes = 3000 } = {}) {
  // `readSurface` returns `{ session, events, … }`, not an array; a bare array is
  // accepted too so the shaping stays testable without the envelope.
  const records = Array.isArray(input) ? input : Array.isArray(input?.events) ? input.events : []
  const turns = []
  let total = 0
  for (const record of records) {
    const event = eventOf(record)
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    // Runtime context, skill catalogs and injected memory are not "what the user
    // asked"; including them would make every outline look the same.
    const kind = event.data?.source?.kind
    if (typeof kind === 'string' && kind !== 'user' && kind !== 'model') continue
    const text = textOf(event)
    if (text === undefined) continue
    total += 1
    turns.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text })
  }

  const kept = turns.slice(-maxTurns)
  const lines = []
  let used = 0
  let dropped = turns.length - kept.length
  for (const turn of kept) {
    const block = `${turn.role === 'user' ? '用户' : '助手'}: ${oneLine(turn.text)}`
    const cost = Buffer.byteLength(`${block}\n`, 'utf8')
    if (used + cost > maxBytes && lines.length > 0) {
      dropped += 1
      continue
    }
    lines.push(block)
    used += cost
  }
  return { text: lines.join('\n'), turns: kept.length, total, dropped }
}

/** Collapse a message to one bounded line. */
function oneLine(text, maxChars = 400) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

/**
 * Derive a label for a session from its first user turn.
 *
 * `readTitleSnapshots` returns no title for persisted sessions in this build: the
 * folded title comes from a `session/title` event, and the corpus read evidently
 * does not carry those for cold sessions (a session whose log clearly holds a
 * title still folds to nothing). Deriving the label from the first user message
 * is what the harness's own fallback titler does — the observed fallback title
 * for a session equals its first prompt — and `readSurface` is verified to work.
 *
 * @param surface - a `readSurface` result, or a bare event array.
 * @param maxChars - bound for the derived label.
 * @returns the label, or undefined when the session has no readable first turn.
 */
export function labelFromSurface(surface, maxChars = 60) {
  const records = Array.isArray(surface) ? surface : Array.isArray(surface?.events) ? surface.events : []
  for (const record of records) {
    const event = eventOf(record)
    if (event?.type !== 'user/message') continue
    const kind = event.data?.source?.kind
    // Injected context arrives as a user-role message; a label must come from
    // what the person actually typed.
    if (typeof kind === 'string' && kind !== 'user') continue
    const text = textOf(event)
    if (text !== undefined) return oneLine(text, maxChars)
  }
  return undefined
}

/* ------------------------------------------------- on-disk session titles -- */

/**
 * Where the harness keeps one session's folded state, under `$DSH_HOME`.
 *
 * Documented by DSH itself: "the JSON backend stores each record at
 * `<root>/session_projcache/sessions/<id>.json`". The root here is the storages
 * root, which sits under the harness home.
 */
export const SESSION_CACHE_DIRS = ['storages', 'session_projcache', 'sessions']

/** The session store, one directory per working directory, one per session inside. */
export const SESSION_STORE_DIRNAME = 'sessions'

/** A session log, named for the generation of the versioned session format it holds. */
export const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl\.zstd$/

/** Read guard for one session cache; the biggest observed is well under 1 MB. */
export const DEFAULT_TITLE_CACHE_MAX_BYTES = 8 * 1024 * 1024

/**
 * How much of a session log is scanned for its title.
 *
 * The title is written within the first few frames — seq 13 to 17 in every log
 * examined — while a log can be megabytes (one was 3.3 MB over 2419 frames). The
 * head is cheap and the bound is what keeps a listing of 15 sessions from reading
 * 15 full logs; the cost is that a later re-title beyond the head is not seen.
 */
export const DEFAULT_TITLE_SCAN_BYTES = 64 * 1024

/** zstd decompression, or undefined on a Node old enough to lack it (below 22.15). */
const zstdDecompress = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : undefined

/** A zstd frame starts with this magic number. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Await an operation that is allowed to fail; a title is never worth a throw. */
async function attempt(operation) {
  try {
    return await operation()
  } catch {
    return undefined
  }
}

/**
 * Read the harness's folded title out of a session cache document.
 *
 * This is `record.rows.title.val`: the same folded value the GUI puts in its
 * session list, which is why a title read this way matches what the human sees
 * rather than a label derived from the first prompt.
 *
 * @param text - the cache document, or nothing when the read failed.
 * @param options - read guard for the document.
 * @returns the title, or undefined when the cache has none.
 */
export function titleFromCacheText(text, { maxBytes = DEFAULT_TITLE_CACHE_MAX_BYTES } = {}) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const value = parsed?.record?.rows?.title?.val
  if (typeof value !== 'string') return undefined
  // One line, so a title cannot forge extra entries in a rendered list.
  const flat = oneLine(value, 200)
  return flat.length > 0 ? flat : undefined
}

/**
 * Pick the session log out of one session directory's names.
 *
 * The filename is version-stamped (`session.v4.jsonl.zstd` today), so this reads
 * the generation rather than hardcoding one: a future `v5` log is found by the
 * same code. The highest generation wins when several are present.
 *
 * @param names - directory entries of one session directory.
 * @returns the log's filename, or undefined when there is none.
 */
export function sessionLogName(names) {
  if (!Array.isArray(names)) return undefined
  let found
  let foundVersion = -1
  for (const name of names) {
    if (typeof name !== 'string') continue
    const match = SESSION_LOG_PATTERN.exec(name)
    if (match === null) continue
    const version = Number(match[1])
    if (version > foundVersion) {
      foundVersion = version
      found = name
    }
  }
  return found
}

/** The last `session/title` value across one decompressed stretch of JSONL. */
function lastTitleInText(text) {
  let title
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = eventOf(parsed)
    if (event?.type !== 'session/title') continue
    const value = event.data?.title
    if (typeof value !== 'string') continue
    const flat = oneLine(value, 200)
    if (flat.length > 0) title = flat
  }
  return title
}

/**
 * Read the last title out of the head of a session log.
 *
 * The log is a concatenation of independent zstd frames, one per write, so
 * `zstdDecompressSync` on the whole buffer stops after the first frame and the
 * frames have to be walked one by one. Frame boundaries are found by the magic
 * number, which can also occur inside compressed payload: a slice that does not
 * decompress is skipped rather than fatal, and the last title seen still wins,
 * matching how the harness folds the event stream.
 *
 * @param head - the bytes read from the start of the log.
 * @param options - decoder (injectable) and scan bound.
 * @returns the title, or undefined when the head carries none.
 */
export function titlesFromLogHead(head, { decode = zstdDecompress, maxBytes = DEFAULT_TITLE_SCAN_BYTES } = {}) {
  if (typeof decode !== 'function') return undefined
  if (!Buffer.isBuffer(head) || head.length === 0) return undefined
  const window = head.length > maxBytes ? head.subarray(0, maxBytes) : head
  let title
  let at = window.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    const next = window.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
    const end = next === -1 ? window.length : next
    try {
      const found = lastTitleInText(decode(window.subarray(at, end)).toString('utf8'))
      if (found !== undefined) title = found
    } catch {
      // A false frame boundary; the next magic number resumes the walk.
    }
    at = next
  }
  return title
}

/**
 * Host-filesystem io for the two on-disk title sources.
 *
 * Host filesystem on purpose, exactly like the `home` memory store: these paths
 * are harness application state outside the workspace, the model cannot name
 * them, and nothing is ever written here.
 */
export const sessionTitleIo = {
  async readText(path) {
    return readFile(path, 'utf8').catch(() => undefined)
  },
  async readBytes(path, maxBytes = DEFAULT_TITLE_SCAN_BYTES) {
    let handle
    try {
      handle = await open(path, 'r')
      const info = await handle.stat()
      const size = Math.min(Number(info.size) || 0, maxBytes)
      if (size <= 0) return undefined
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, 0)
      return buffer.subarray(0, bytesRead)
    } catch {
      return undefined
    } finally {
      if (handle !== undefined) await handle.close().catch(() => {})
    }
  },
  async listNames(directory) {
    return readdir(directory).catch(() => [])
  },
}

/**
 * Read one session's title off the disk.
 *
 * The cache is tried first because it is one small read and carries the folded
 * value; the log is the fallback for a session the harness has not cached (an old
 * session, or one whose cache was pruned). Every failure path is swallowed: a
 * session whose title cannot be read is listed untitled, not dropped.
 *
 * @param sessionId - the session directory name, which is the session id.
 * @param options - harness home, io, and the two read bounds.
 * @returns the title, or undefined when the disk has none.
 */
export async function readStoredTitle(sessionId, { dshHome, io = sessionTitleIo, maxBytes, cacheMaxBytes } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof dshHome !== 'string' || dshHome.length === 0) return undefined
  const scanBytes = maxBytes ?? DEFAULT_TITLE_SCAN_BYTES

  const cachePath = join(dshHome, ...SESSION_CACHE_DIRS, `${sessionId}.json`)
  const cached = titleFromCacheText(await attempt(() => io.readText(cachePath)), { maxBytes: cacheMaxBytes ?? DEFAULT_TITLE_CACHE_MAX_BYTES })
  if (cached !== undefined) return cached

  // The session store groups by working directory, whose directory name is an
  // encoding of that path; the encoding is not this plugin's to reproduce, so the
  // session id is looked up by name instead.
  const store = join(dshHome, SESSION_STORE_DIRNAME)
  const projects = await attempt(() => io.listNames(store))
  for (const project of Array.isArray(projects) ? projects : []) {
    if (typeof project !== 'string') continue
    const directory = join(store, project, sessionId)
    const log = sessionLogName(await attempt(() => io.listNames(directory)))
    if (log === undefined) continue
    const head = await attempt(() => io.readBytes(join(directory, log), scanBytes))
    const title = titlesFromLogHead(head, { maxBytes: scanBytes })
    if (title !== undefined) return title
  }
  return undefined
}

/**
 * Fill in the titles of the rows that have none, from the disk.
 *
 * Deliberately not capped the way the derived-label path is: that path pays for a
 * whole-log read per session, which is why it covers only the rows the caller
 * asked to see, while a cache read is small. Leaving it uncapped is what names
 * row 14 of 15 instead of rendering it as （无标题）.
 *
 * @param entries - rows from {@link selectRecentSessions}, newest first.
 * @param options - harness home, io, and the read bounds; see {@link readStoredTitle}.
 * @returns the same rows in the same order, with any readable title filled in.
 */
export async function fillStoredTitles(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const need = list.filter((entry) => (
    entry !== null
    && typeof entry === 'object'
    && typeof entry.id === 'string'
    && typeof entry.title !== 'string'
  ))
  if (need.length === 0) return list

  const found = new Map()
  await Promise.all(need.map(async (entry) => {
    const title = await readStoredTitle(entry.id, options)
    if (title !== undefined) found.set(entry.id, title)
  }))
  return list.map((entry) => {
    if (entry === null || typeof entry !== 'object') return entry
    if (typeof entry.title === 'string') return entry
    return { ...entry, title: found.get(entry.id) }
  })
}
