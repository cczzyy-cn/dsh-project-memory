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
import { describe, it } from 'node:test'

import {
  defaultStamp,
  labelFromSurface,
  outlineSession,
  renderRecentSessions,
  selectRecentSessions,
  sessionLine,
  titleFailures,
  titleTextOf,
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
