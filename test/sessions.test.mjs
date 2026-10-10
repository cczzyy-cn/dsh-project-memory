/**
 * Tests for session recall shaping.
 *
 * The inputs are the shapes `ctx.sessionQuery` actually returns, read from the
 * shipped implementation: `listSessions()` yields `{ header, live, persisted }`
 * with `header.createdAt` as epoch milliseconds, and `readTitleSnapshots()`
 * yields `{ session, title? }` where the folded title is an object carrying
 * `.title`.
 */

import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import * as zlib from 'node:zlib'

import {
  defaultStamp,
  fillStoredTitles,
  labelFromSurface,
  outlineSession,
  readStoredTitle,
  renderRecentSessions,
  selectRecentSessions,
  sessionLine,
  sessionLogName,
  titleFailures,
  titleFromCacheText,
  titleTextOf,
  titlesFromLogHead,
  withinRepository,
} from '../lib/sessions.js'

/** A `listSessions()` record. */
function session(id, cwd, createdAt) {
  return { header: { id, cwd, createdAt, isSeeded: false, agentPreset: 'standard' }, live: false, persisted: true }
}

/** A `readTitleSnapshots()` entry. */
function snapshot(id, title) {
  const entry = { session: { id } }
  if (title !== undefined) {
    entry.title = { title, messageSeqs: [1], source: { kind: 'provider' }, eventSeq: 3, updatedAt: 1 }
  }
  return entry
}

const REPO = 'C:\\Users\\me\\repo'

describe('withinRepository', () => {
  it('accepts the repository root itself', () => {
    assert.equal(withinRepository(REPO, REPO), true)
    assert.equal(withinRepository(REPO, 'C:\\Users\\me\\repo\\'), true)
  })

  it('accepts a working directory below the root', () => {
    assert.equal(withinRepository(REPO, 'C:\\Users\\me\\repo\\packages\\app'), true)
  })

  it('is case-insensitive, because the platform is', () => {
    assert.equal(withinRepository(REPO, 'c:/users/me/REPO'), true)
  })

  it('rejects a sibling whose path merely shares the prefix', () => {
    // The trap: "repo-other" starts with "repo" but is a different repository.
    assert.equal(withinRepository(REPO, 'C:\\Users\\me\\repo-other'), false)
    assert.equal(withinRepository(REPO, 'C:\\Users\\me\\repo-other\\src'), false)
  })

  it('rejects a path outside, and a missing one', () => {
    assert.equal(withinRepository(REPO, 'C:\\Users\\me\\elsewhere'), false)
    assert.equal(withinRepository(REPO, 'C:\\Users\\me'), false)
    assert.equal(withinRepository(REPO, undefined), false)
    assert.equal(withinRepository(REPO, ''), false)
    assert.equal(withinRepository(REPO, '   '), false)
  })
})

describe('titleTextOf', () => {
  it('reads the string out of the folded snapshot', () => {
    assert.equal(titleTextOf(snapshot('s', 'Fix the parser')), 'Fix the parser')
  })

  it('accepts a plain string, since the snapshot type is not contractual', () => {
    assert.equal(titleTextOf({ session: { id: 's' }, title: 'plain' }), 'plain')
  })

  it('reports nothing for a missing, empty or blank title', () => {
    assert.equal(titleTextOf(snapshot('s')), undefined)
    assert.equal(titleTextOf({ title: { title: '   ' } }), undefined)
    assert.equal(titleTextOf({ title: '' }), undefined)
    assert.equal(titleTextOf(undefined), undefined)
  })
})

describe('selectRecentSessions', () => {
  const sessions = [
    session('s-new', REPO, 3000),
    session('s-mid', 'C:\\Users\\me\\repo\\packages\\app', 2000),
    session('s-old', REPO, 1000),
    session('s-other', 'C:\\Users\\me\\other', 9000),
  ]
  const titles = [snapshot('s-new', 'Newest'), snapshot('s-mid', 'Middle'), snapshot('s-old', 'Oldest')]

  it('keeps only this repository, newest first', () => {
    const picked = selectRecentSessions({ sessions, titleSnapshots: titles, repositoryRoot: REPO })
    assert.deepEqual(picked.map((entry) => entry.id), ['s-new', 's-mid', 's-old'])
  })

  it('excludes the session asking the question', () => {
    const picked = selectRecentSessions({
      sessions, titleSnapshots: titles, repositoryRoot: REPO, excludeSessionId: 's-new',
    })
    assert.deepEqual(picked.map((entry) => entry.id), ['s-mid', 's-old'])
  })

  it('honours the limit', () => {
    const picked = selectRecentSessions({ sessions, titleSnapshots: titles, repositoryRoot: REPO, limit: 2 })
    assert.deepEqual(picked.map((entry) => entry.id), ['s-new', 's-mid'])
  })

  it('carries a title when one exists and nothing when it does not', () => {
    const picked = selectRecentSessions({
      sessions: [session('titled', REPO, 2), session('untitled', REPO, 1)],
      titleSnapshots: [snapshot('titled', 'Has a title')],
      repositoryRoot: REPO,
    })
    assert.equal(picked[0].title, 'Has a title')
    assert.equal(picked[1].title, undefined)
  })

  it('survives records it cannot use', () => {
    const picked = selectRecentSessions({
      sessions: [null, {}, { header: {} }, session('good', REPO, 1)],
      titleSnapshots: [undefined, {}, snapshot('good', 'Fine')],
      repositoryRoot: REPO,
    })
    assert.deepEqual(picked.map((entry) => entry.id), ['good'])
  })

  it('returns nothing when the repository has no sessions', () => {
    assert.deepEqual(selectRecentSessions({ sessions, titleSnapshots: titles, repositoryRoot: 'C:\\none' }), [])
    assert.deepEqual(selectRecentSessions({}), [])
  })
})

describe('renderRecentSessions', () => {
  const stamp = () => '01-02 03:04'
  const entries = [
    { id: 'a', createdAt: 1, title: 'First session' },
    { id: 'b', createdAt: 2, title: 'Second session' },
    { id: 'c', createdAt: 3, title: undefined },
  ]

  it('renders one line per session', () => {
    const rendered = renderRecentSessions(entries, { formatStamp: stamp })
    assert.equal(rendered.included.length, 3)
    assert.match(rendered.text, /- 01-02 03:04 · First session/)
    assert.match(rendered.text, /- 01-02 03:04 · （无标题）/, 'an untitled session is still listed')
  })

  it('keeps the newest and reports how many it left out', () => {
    const rendered = renderRecentSessions(entries, { maxBytes: 25, formatStamp: stamp })
    assert.equal(rendered.included.length, 1, 'only one line fits in 25 bytes')
    assert.equal(rendered.omitted, 2, 'the rest are counted, not silently dropped')
  })

  it('always emits at least one line so the block is never empty', () => {
    const rendered = renderRecentSessions(entries, { maxBytes: 1, formatStamp: stamp })
    assert.equal(rendered.included.length, 1)
    assert.ok(rendered.text.length > 0)
  })

  it('formats a local stamp by default', () => {
    assert.match(defaultStamp(Date.UTC(2026, 9, 10, 1, 38)), /^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('omits the stamp when the session has no creation time', () => {
    assert.equal(sessionLine({ id: 'x', createdAt: 0, title: 'No clock' }, stamp), '- No clock')
  })

  it('carries the id only when asked, because the resident block pays for it', () => {
    const entry = { id: 'session-abc', createdAt: 1, title: 'Named' }
    assert.equal(sessionLine(entry, stamp), '- 01-02 03:04 · Named')
    assert.equal(sessionLine(entry, stamp, { withId: true }), '- session-abc · 01-02 03:04 · Named')
  })
  it('reports rejected title reads instead of quietly rendering everything untitled', () => {
    const failures = titleFailures([
      snapshot('fine', 'Has one'),
      { sessionId: 'bad', status: 'rejected', reason: new Error('boom') },
      { sessionId: 'worse', status: 'rejected', reason: 'plain reason' },
    ])
    assert.equal(failures.length, 2, 'the rejects are surfaced, not skipped')
    assert.match(failures[0], /^bad: boom$/)
    assert.match(failures[1], /^worse: plain reason$/)
    assert.deepEqual(titleFailures([snapshot('fine', 'Has one')]), [])
    assert.deepEqual(titleFailures(undefined), [])
  })
})

describe('outlineSession', () => {
  const user = (text) => ({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const assistant = (text) => ({ type: 'assistant/message', seq: 2, data: { source: { kind: 'model' }, content: [{ type: 'text', text }] } })
  const injected = (kind, text) => ({ type: 'user/message', seq: 3, data: { source: { kind }, content: [{ type: 'text', text }] } })

  it('reads the envelope readSurface actually returns, not a bare array', () => {
    const outline = outlineSession({ session: { id: 's' }, inheritedEventCount: 0, capturedThroughSeq: 9, events: [user('from the envelope')] })
    assert.match(outline.text, /from the envelope/)
    assert.equal(outlineSession({ session: { id: 's' } }).total, 0, 'a missing events array reads as empty')
    assert.equal(outlineSession(undefined).total, 0)
  })

  it('keeps the conversation and flattens each turn to one line', () => {
    const outline = outlineSession([user('do\n  the   thing'), assistant('done that')])
    assert.match(outline.text, /用户: do the thing/)
    assert.match(outline.text, /助手: done that/)
    assert.equal(outline.total, 2)
    assert.equal(outline.dropped, 0)
  })

  it('leaves injected context out, so every outline does not look alike', () => {
    const outline = outlineSession([
      user('real question'),
      injected('runtime-context', 'Current runtime context: ...'),
      injected('project-memory', 'Project memory index: ...'),
      injected('agent-instructions', 'Workspace instructions: ...'),
      injected('skill-catalog', 'Available skills: ...'),
      assistant('answer'),
    ])
    assert.equal(outline.total, 2)
    assert.ok(!outline.text.includes('runtime context'))
    assert.ok(!outline.text.includes('Project memory index'))
  })

  it('keeps only the last turns when the session is long', () => {    const records = Array.from({ length: 30 }, (_, index) => user(`turn ${index}`))
    const outline = outlineSession(records, { maxTurns: 5 })
    assert.equal(outline.turns, 5)
    assert.equal(outline.total, 30)
    assert.equal(outline.dropped, 25, 'what was left behind is counted')
    assert.match(outline.text, /turn 29/)
    assert.ok(!outline.text.includes('turn 20'))
  })

  it('accepts a wrapped event envelope as well as a bare one', () => {
    const outline = outlineSession([{ event: user('wrapped') }])
    assert.match(outline.text, /wrapped/)
  })

  it('ignores records it cannot read, and events with no text', () => {
    const outline = outlineSession([
      null, 'nonsense', { type: 'step/start' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } },
    ])
    assert.equal(outline.total, 0)
    assert.equal(outline.text, '')
  })

  it('bounds a long message to one readable line', () => {
    const outline = outlineSession([user('x'.repeat(2000))])
    assert.ok(outline.text.length < 500, `one line stayed bounded, got ${outline.text.length}`)
    assert.match(outline.text, /…$/)
  })
})

describe('labelFromSurface', () => {
  const user = (text) => ({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const assistant = (text) => ({ type: 'assistant/message', seq: 2, data: { source: { kind: 'model' }, content: [{ type: 'text', text }] } })
  const injected = (kind, text) => ({ type: 'user/message', seq: 3, data: { source: { kind }, content: [{ type: 'text', text }] } })

  it('names a session after the first thing the user actually typed', () => {
    const surface = {
      session: { id: 's' },
      events: [injected('runtime-context', 'Current runtime context: ...'), user('fix the parser bug'), assistant('done')],
    }
    assert.equal(labelFromSurface(surface), 'fix the parser bug')
  })

  it('is why the fallback exists: injected context is not a label', () => {
    assert.equal(labelFromSurface({ events: [injected('project-memory', 'Project memory index: ...')] }), undefined)
  })

  it('reports nothing when only the agent spoke', () => {
    assert.equal(labelFromSurface({ events: [assistant('only the agent spoke')] }), undefined)
    assert.equal(labelFromSurface({ session: { id: 's' } }), undefined)
    assert.equal(labelFromSurface(undefined), undefined)
  })

  it('bounds the derived label', () => {
    const label = labelFromSurface({ events: [user('y'.repeat(500))] })
    assert.ok(label.length <= 60, `label stayed bounded, got ${label.length}`)
    assert.match(label, /…$/)
  })

  it('accepts a bare event array too', () => {
    assert.equal(labelFromSurface([user('bare array')]), 'bare array')
  })
})

/* ------------------------------------------------------- on-disk titles -- */

/**
 * Everything below covers the second title source.
 *
 * `readTitleSnapshots` answers for sessions warm in the running app and stays
 * empty for cold ones (README "三个坑" #2), so a cold session's title has to come
 * off the disk: the harness cache row at
 * `<home>/storages/session_projcache/sessions/<id>.json`, and failing that the
 * `session/title` events at the head of `<home>/sessions/<project>/<id>/session.v<N>.jsonl.zstd`.
 */

/** Session logs are concatenated independent zstd frames, one write per frame. */
const canCompress = typeof zlib.zstdCompressSync === 'function'

/** One frame holding one JSONL record, the way the session log is written. */
function frame(event) {
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))
}

const LOG_HEADER = { type: 'session', version: 4, id: 'session-abc', cwd: 'C:\\repo', createdAt: 1 }
const titleEvent = (title, kind = 'provider') => ({
  type: 'session/title', seq: 17, time: 1, data: { title, messageSeqs: [8], source: { kind } },
})

describe('titleFromCacheText', () => {
  const cache = (title) => JSON.stringify({
    version: 7,
    record: { identity: { cwd: 'C:\\repo' }, rows: { title: { ver: 1, seq: 3841, val: title } } },
  })

  it('reads the folded title row the GUI also shows', () => {
    assert.equal(titleFromCacheText(cache('你能上网吗')), '你能上网吗')
  })

  it('reads a title whatever the cache format version says', () => {
    const other = JSON.stringify({ version: 99, record: { rows: { title: { ver: 4, seq: 1, val: '来自未来' } } } })
    assert.equal(titleFromCacheText(other), '来自未来')
  })

  it('reports nothing for missing, blank or malformed content', () => {
    assert.equal(titleFromCacheText(undefined), undefined)
    assert.equal(titleFromCacheText(''), undefined)
    assert.equal(titleFromCacheText('not json'), undefined)
    assert.equal(titleFromCacheText('{}'), undefined)
    assert.equal(titleFromCacheText(cache('   ')), undefined)
    assert.equal(titleFromCacheText(JSON.stringify({ record: { rows: { title: { val: 42 } } } })), undefined)
  })

  it('refuses a cache larger than the read guard', () => {
    assert.equal(titleFromCacheText(cache('huge'), { maxBytes: 10 }), undefined)
    assert.equal(titleFromCacheText(cache('fits'), { maxBytes: 4096 }), 'fits')
  })
})

describe('sessionLogName', () => {
  it('picks the newest session-format generation, so a v5 log still reads', () => {
    assert.equal(sessionLogName(['session.v4.jsonl.zstd']), 'session.v4.jsonl.zstd')
    assert.equal(sessionLogName(['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd']), 'session.v5.jsonl.zstd')
    assert.equal(sessionLogName(['session.v10.jsonl.zstd', 'session.v9.jsonl.zstd']), 'session.v10.jsonl.zstd')
  })

  it('ignores anything that is not a session log', () => {
    assert.equal(sessionLogName(['session.json', 'notes.md', 'session.v4.jsonl']), undefined)
    assert.equal(sessionLogName([]), undefined)
    assert.equal(sessionLogName(undefined), undefined)
  })
})

describe('titlesFromLogHead', () => {
  it('reads the title event out of concatenated zstd frames', { skip: !canCompress }, () => {
    const head = Buffer.concat([frame(LOG_HEADER), frame(titleEvent('第一个标题'))])
    assert.equal(titlesFromLogHead(head), '第一个标题')
  })

  it('keeps the last title, which is the one that folded', { skip: !canCompress }, () => {
    const head = Buffer.concat([
      frame(LOG_HEADER),
      frame(titleEvent('你能上网吗', 'fallback')),
      frame({ type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [] } }),
      frame(titleEvent('项目记忆与会话回忆')),
    ])
    assert.equal(titlesFromLogHead(head), '项目记忆与会话回忆')
  })

  it('skips a stretch it cannot decode and keeps looking', { skip: !canCompress }, () => {
    // A magic number inside compressed payload is not a frame boundary; the slice
    // between two of them is garbage, and one bad slice must not cost the title.
    const bogus = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd])
    const head = Buffer.concat([frame(titleEvent('标题在坏帧之前')), bogus, frame(LOG_HEADER)])
    assert.equal(titlesFromLogHead(head), '标题在坏帧之前')
  })

  it('honours the byte budget, so a title past it is not written down', { skip: !canCompress }, () => {
    const first = frame(titleEvent('预算内的标题'))
    const head = Buffer.concat([first, frame(titleEvent('预算外的标题'))])
    assert.equal(titlesFromLogHead(head, { maxBytes: head.length }), '预算外的标题')
    assert.equal(titlesFromLogHead(head, { maxBytes: first.length }), '预算内的标题')
  })

  it('reports nothing when no decoder is available', { skip: !canCompress }, () => {
    // Node before 22.15 has no zstd in `node:zlib`; the cache path must carry on alone.
    const head = Buffer.concat([frame(titleEvent('没人能解'))])
    assert.equal(titlesFromLogHead(head, { decode: null }), undefined)
  })

  it('reports nothing for a head with no title, or nothing usable at all', { skip: !canCompress }, () => {
    assert.equal(titlesFromLogHead(Buffer.concat([frame(LOG_HEADER)])), undefined)
    assert.equal(titlesFromLogHead(Buffer.from('not a session log')), undefined)
    assert.equal(titlesFromLogHead(undefined), undefined)
    assert.equal(titlesFromLogHead('nonsense'), undefined)
  })

  it('accepts a wrapped record envelope as well as a bare one', { skip: !canCompress }, () => {
    const head = frame({ event: titleEvent('被包起来的标题') })
    assert.equal(titlesFromLogHead(head), '被包起来的标题')
  })
})

describe('readStoredTitle', () => {
  const HOME = join('C:', 'Users', 'me', '.dsh')
  const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions', 'session-abc.json')
  const SESSIONS = join(HOME, 'sessions')
  const PROJECT = join(SESSIONS, '--C-repo--')
  const SESSION_DIR = join(PROJECT, 'session-abc')
  const LOG = join(SESSION_DIR, 'session.v4.jsonl.zstd')
  const cacheText = (title) => JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } })

  /** The three io calls the reader makes, so no test has to touch a real disk. */
  function fakeIo({ texts = {}, bytes = {}, dirs = {} } = {}) {
    return {
      async readText(path) { return texts[path] },
      async readBytes(path, maxBytes) {
        const value = bytes[path]
        if (value === undefined) return undefined
        return maxBytes === undefined ? value : value.subarray(0, maxBytes)
      },
      async listNames(directory) { return dirs[directory] ?? [] },
    }
  }

  const logWith = (title) => Buffer.concat([frame(LOG_HEADER), frame(titleEvent(title))])
  const dirsFor = (names) => ({ [SESSIONS]: [basename(PROJECT)], [PROJECT]: ['session-abc'], [SESSION_DIR]: names })

  it('prefers the harness cache row, which is the folded truth', { skip: !canCompress }, async () => {
    const io = fakeIo({
      texts: { [CACHE]: cacheText('缓存里的标题') },
      bytes: { [LOG]: logWith('日志里的标题') },
      dirs: dirsFor(['session.v4.jsonl.zstd']),
    })
    assert.equal(await readStoredTitle('session-abc', { dshHome: HOME, io }), '缓存里的标题')
  })

  it('falls back to the log when the cache has no row', { skip: !canCompress }, async () => {
    const io = fakeIo({ bytes: { [LOG]: logWith('日志里的标题') }, dirs: dirsFor(['session.v4.jsonl.zstd']) })
    assert.equal(await readStoredTitle('session-abc', { dshHome: HOME, io }), '日志里的标题')
  })

  it('finds the session under whichever project directory owns it', { skip: !canCompress }, async () => {
    const other = join(SESSIONS, '--somewhere-else--')
    const io = fakeIo({
      bytes: { [LOG]: logWith('在第二个项目目录里') },
      dirs: { [SESSIONS]: ['--somewhere-else--', basename(PROJECT)], [other]: [], [PROJECT]: ['session-abc'], [SESSION_DIR]: ['session.v4.jsonl.zstd'] },
    })
    assert.equal(await readStoredTitle('session-abc', { dshHome: HOME, io }), '在第二个项目目录里')
  })

  it('reads a future session-format generation', { skip: !canCompress }, async () => {
    const future = join(SESSION_DIR, 'session.v5.jsonl.zstd')
    const io = fakeIo({ bytes: { [future]: logWith('v5 里的标题') }, dirs: dirsFor(['session.v5.jsonl.zstd']) })
    assert.equal(await readStoredTitle('session-abc', { dshHome: HOME, io }), 'v5 里的标题')
  })

  it('reports nothing when neither source exists', async () => {
    assert.equal(await readStoredTitle('session-abc', { dshHome: HOME, io: fakeIo() }), undefined)
    assert.equal(await readStoredTitle('session-abc', { dshHome: undefined, io: fakeIo() }), undefined)
    assert.equal(await readStoredTitle('', { dshHome: HOME, io: fakeIo() }), undefined)
  })

  it('never throws when the disk refuses', async () => {
    const hostile = {
      async readText() { throw new Error('EACCES') },
      async readBytes() { throw new Error('EACCES') },
      async listNames() { throw new Error('EACCES') },
    }
    assert.equal(await readStoredTitle('session-abc', { dshHome: HOME, io: hostile }), undefined)
  })
})

describe('fillStoredTitles', () => {
  const HOME = join('C:', 'Users', 'me', '.dsh')
  const cachePath = (id) => join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  const cacheText = (title) => JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } })

  it('names every row, however far down the list it sits', async () => {
    // The regression: derived labels cost a whole-log read and were capped at ten
    // rows, so row 14 of 15 rendered as （无标题） even though its title was on disk.
    const entries = Array.from({ length: 15 }, (_, index) => ({ id: `session-${index}`, createdAt: index, title: undefined }))
    const texts = {}
    for (const entry of entries) texts[cachePath(entry.id)] = cacheText(`标题 ${entry.id}`)
    const filled = await fillStoredTitles(entries, { dshHome: HOME, io: { async readText(path) { return texts[path] }, async readBytes() { return undefined }, async listNames() { return [] } } })
    assert.equal(filled.filter((entry) => typeof entry.title === 'string').length, 15)
    assert.equal(filled[14].title, '标题 session-14')
    assert.deepEqual(filled.map((entry) => entry.id), entries.map((entry) => entry.id), 'order is preserved')
  })

  it('never overwrites a title the snapshot already supplied', async () => {
    const entries = [{ id: 'warm', createdAt: 2, title: '快照里的标题' }, { id: 'cold', createdAt: 1, title: undefined }]
    let reads = 0
    const io = {
      async readText(path) { reads += 1; return path.includes('cold') ? cacheText('磁盘上的标题') : cacheText('不该被读到') },
      async readBytes() { return undefined },
      async listNames() { return [] },
    }
    const filled = await fillStoredTitles(entries, { dshHome: HOME, io })
    assert.equal(filled[0].title, '快照里的标题')
    assert.equal(filled[1].title, '磁盘上的标题')
    assert.equal(reads, 1, 'a titled row costs no read at all')
  })

  it('marks the rows no source could name as untitled instead of dropping them', async () => {
    const entries = [{ id: 'has-one', createdAt: 2, title: undefined }, { id: 'has-none', createdAt: 1, title: undefined }]
    const io = {
      async readText(path) { return path.includes('has-one') ? cacheText('有标题') : undefined },
      async readBytes() { return undefined },
      async listNames() { return [] },
    }
    const filled = await fillStoredTitles(entries, { dshHome: HOME, io })
    assert.equal(filled.length, 2)
    assert.equal(filled[0].title, '有标题')
    assert.equal(filled[1].title, undefined)
  })

  it('survives an io that fails, and does no work when nothing is missing', async () => {
    const hostile = {
      async readText() { throw new Error('EACCES') },
      async readBytes() { throw new Error('EACCES') },
      async listNames() { throw new Error('EACCES') },
    }
    const missing = [{ id: 'a', createdAt: 1, title: undefined }]
    assert.equal((await fillStoredTitles(missing, { dshHome: HOME, io: hostile }))[0].title, undefined)

    let calls = 0
    const counting = { async readText() { calls += 1 }, async readBytes() { calls += 1 }, async listNames() { calls += 1 } }
    const titled = [{ id: 'a', createdAt: 1, title: '已经有了' }]
    assert.deepEqual(await fillStoredTitles(titled, { dshHome: HOME, io: counting }), titled)
    assert.equal(calls, 0)
    assert.deepEqual(await fillStoredTitles(undefined, { dshHome: HOME, io: counting }), [])
  })
})
