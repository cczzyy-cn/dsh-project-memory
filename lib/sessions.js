/**
 * Harness-free logic for recalling what happened in a repository's past sessions.
 *
 * Session data is not this plugin's to own: DSH already mounts
 * `@deepseek-ai/dsh-session-query-sqlite`, so `ctx.sessionQuery` is the source.
 * Parsing the `.zstd` logs here would duplicate an owned responsibility and rot
 * with the versioned session format (`session-format-v0` … `v4`). This module
 * only shapes what that service returns.
 *
 * The shapes below were read from the shipped implementation, not assumed:
 * - `listSessions()` yields `{ header, live, persisted }`, newest first by
 *   `header.createdAt` (epoch ms), with `header.cwd` and `header.id`.
 * - `readTitleSnapshots(ids)` yields `[{ session: <header>, title?: <snapshot> }]`
 *   where the folded snapshot is an object carrying `.title` as a string.
 *
 * @module dsh-project-memory/sessions
 */

import { normalize, resolve } from 'node:path'

/** How many past sessions the resident list carries by default. */
export const DEFAULT_RECENT_SESSIONS = 5

/** Byte budget for the resident list, framing excluded. */
export const DEFAULT_RECENT_SESSION_BYTES = 600

/** Compare paths the way the platform does: case-folded, forward slashes. */
function normalizeForCompare(path) {
  return normalize(resolve(String(path))).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether a session's working directory belongs to this repository.
 *
 * Sessions are filtered by their `cwd`, which may be a subdirectory of the
 * repository, so containment is a prefix test rather than equality. Session
 * query filters match `cwd` exactly, which is why this runs here instead.
 *
 * @param repositoryRoot - the agent's resolved repository root.
 * @param candidate - a session header's cwd, possibly undefined.
 * @returns whether the session belongs to this repository.
 */
export function withinRepository(repositoryRoot, candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return false
  const root = normalizeForCompare(repositoryRoot)
  const target = normalizeForCompare(candidate)
  if (target === root) return true
  return target.startsWith(`${root}/`)
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
    if (!withinRepository(repositoryRoot, header.cwd)) continue
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
