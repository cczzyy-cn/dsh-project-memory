/**
 * Tests for the harness-free host logic.
 *
 * These cover what `lib/index.js` used to hold inline and could only be verified
 * by booting a real profile: config normalization, the pre-step gate, touch
 * attribution through nested calls, and scoped-note selection. The waterfall
 * regression — a listener that failed to call `next()` and handed the loop an
 * undefined decision — is the class of bug this file exists to catch.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyToolResult,
  createTouchState,
  isInjectionStep,
  resolveConfig,
  resolvePanelCwd,
  selectScopeCandidates,
  takePendingTouches,
} from '../lib/host-logic.js'
import { noteDigest } from '../lib/store.js'

/** A memory record shaped the way `store.js` produces them. */
function record(id, scope, body = 'body text', modified = '2026-10-10T00:00:00.000Z') {
  return {
    id,
    title: `Title ${id}`,
    kind: 'feedback',
    scope,
    tags: [],
    created: modified,
    modified,
    source: 'test',
    body,
    archived: false,
  }
}

describe('resolveConfig', () => {
  it('fills every default from an empty configuration', () => {
    const resolved = resolveConfig({}, '/home/dsh')
    assert.equal(resolved.enabled, true)
    assert.equal(resolved.storage, 'home')
    assert.equal(resolved.indexMaxBytes, 2048)
    assert.equal(resolved.noteMaxBytes, 4096)
    assert.equal(resolved.recallMaxBytes, 4096)
    assert.equal(resolved.recallLimit, 5)
    assert.equal(resolved.scopeMaxBytes, 8192)
    assert.equal(resolved.scopeNotesPerStep, 3)
    assert.deepEqual(resolved.projectRootMarkers, ['.git'])
    assert.equal(resolved.dshHome, '/home/dsh')
  })

  it('honours overrides and treats enabled:false as off', () => {
    const resolved = resolveConfig({ enabled: false, storage: 'repo', indexMaxBytes: 512 }, '/home/dsh')
    assert.equal(resolved.enabled, false)
    assert.equal(resolved.storage, 'repo')
    assert.equal(resolved.indexMaxBytes, 512)
  })

  it('rejects an unknown storage mode, naming the offending value', () => {
    assert.throws(
      () => resolveConfig({ storage: 'cloud' }, '/home/dsh'),
      /storage must be "home" or "repo", got "cloud"/,
    )
  })

  it('drops markers that could not be directory names', () => {
    const resolved = resolveConfig({ projectRootMarkers: ['.git', '', '  ', 'a/b', 'a\\b'] }, '/home/dsh')
    assert.deepEqual(resolved.projectRootMarkers, ['.git'])
  })

  it('falls back to .git when every marker is unusable', () => {
    const resolved = resolveConfig({ projectRootMarkers: ['', 'x/y'] }, '/home/dsh')
    assert.deepEqual(resolved.projectRootMarkers, ['.git'])
  })
})

describe('isInjectionStep', () => {
  it('refuses a rejected step, which opens no step at all', () => {
    assert.equal(isInjectionStep({ decisionKind: 'reject', step: 1, messageCount: 3, hasAgent: true }), false)
  })

  it('refuses the first step when it has nothing to run', () => {
    assert.equal(isInjectionStep({ decisionKind: 'enter', step: 1, messageCount: 0, hasAgent: true }), false)
  })

  it('accepts the first step once it carries a message', () => {
    assert.equal(isInjectionStep({ decisionKind: 'enter', step: 1, messageCount: 1, hasAgent: true }), true)
  })

  it('accepts a later step even with no claimed message', () => {
    assert.equal(isInjectionStep({ decisionKind: 'enter', step: 2, messageCount: 0, hasAgent: true }), true)
  })

  it('refuses when there is no agent to attach to', () => {
    assert.equal(isInjectionStep({ decisionKind: 'enter', step: 2, messageCount: 1, hasAgent: false }), false)
  })
})

describe('touch attribution', () => {
  it('records a successful file touch for its agent', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 't1', parent: undefined, agent, succeeded: true, path: 'C:/r/a.ts' })
    assert.deepEqual(takePendingTouches(state, agent), ['C:/r/a.ts'])
  })

  it('records nothing for a failed call', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 't1', parent: undefined, agent, succeeded: false, path: 'C:/r/a.ts' })
    assert.deepEqual(takePendingTouches(state, agent), [])
  })

  it('records nothing for a call that is not a file tool', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 't1', parent: undefined, agent, succeeded: true, path: undefined })
    assert.deepEqual(takePendingTouches(state, agent), [])
  })

  it('deduplicates a path touched twice in one step', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 't1', parent: undefined, agent, succeeded: true, path: 'C:/r/a.ts' })
    applyToolResult(state, { token: 't2', parent: undefined, agent, succeeded: true, path: 'C:/r/a.ts' })
    assert.deepEqual(takePendingTouches(state, agent), ['C:/r/a.ts'])
  })

  it('consumes pending touches, so one touch informs exactly one step', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 't1', parent: undefined, agent, succeeded: true, path: 'C:/r/a.ts' })
    assert.deepEqual(takePendingTouches(state, agent), ['C:/r/a.ts'])
    assert.deepEqual(takePendingTouches(state, agent), [], 'a second take finds nothing left')
  })

  it('keeps agents separate', () => {
    const state = createTouchState()
    const first = {}
    const second = {}
    applyToolResult(state, { token: 't1', parent: undefined, agent: first, succeeded: true, path: 'C:/r/a.ts' })
    applyToolResult(state, { token: 't2', parent: undefined, agent: second, succeeded: true, path: 'C:/r/b.ts' })
    assert.deepEqual(takePendingTouches(state, first), ['C:/r/a.ts'])
    assert.deepEqual(takePendingTouches(state, second), ['C:/r/b.ts'])
  })

  it('bubbles a nested call\'s touch up to the outer execution', () => {
    const state = createTouchState()
    const agent = {}
    // A nested leaf: it has an agent but a parent, so it must hand its touch to
    // the parent rather than attributing to the parent's agent directly.
    applyToolResult(state, { token: 'child', parent: 'outer', agent, succeeded: true, path: 'C:/r/nested.ts' })
    assert.deepEqual(takePendingTouches(state, agent), [], 'nothing delivered while the parent is in flight')

    // The outer call has no path of its own; it delivers what it inherited.
    applyToolResult(state, { token: 'outer', parent: undefined, agent, succeeded: true, path: undefined })
    assert.deepEqual(takePendingTouches(state, agent), ['C:/r/nested.ts'])
  })

  it('merges touches from several nested calls under one parent', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 'c1', parent: 'outer', agent, succeeded: true, path: 'C:/r/one.ts' })
    applyToolResult(state, { token: 'c2', parent: 'outer', agent, succeeded: true, path: 'C:/r/two.ts' })
    applyToolResult(state, { token: 'outer', parent: undefined, agent, succeeded: true, path: 'C:/r/three.ts' })
    assert.deepEqual(takePendingTouches(state, agent).sort(), ['C:/r/one.ts', 'C:/r/three.ts', 'C:/r/two.ts'])
  })

  it('does not replay a carried entry that its own observation already consumed', () => {
    const state = createTouchState()
    const agent = {}
    applyToolResult(state, { token: 'c1', parent: 'outer', agent, succeeded: true, path: 'C:/r/one.ts' })
    applyToolResult(state, { token: 'outer', parent: undefined, agent, succeeded: true, path: undefined })
    assert.deepEqual(takePendingTouches(state, agent), ['C:/r/one.ts'])

    // Observing the same token again must start from empty rather than replaying
    // what the first observation already delivered.
    applyToolResult(state, { token: 'outer', parent: undefined, agent, succeeded: true, path: undefined })
    assert.deepEqual(takePendingTouches(state, agent), [])
  })
})

describe('selectScopeCandidates', () => {
  const repositoryRoot = 'C:/repo'

  it('converts an absolute touch into a repository-relative path and matches', () => {
    const { paths, candidates } = selectScopeCandidates({
      records: [record('api-style', 'src/api/**')],
      touchedPaths: ['C:\\repo\\src\\api\\route.ts'],
      injected: new Map(),
      repositoryRoot,
    })
    assert.deepEqual(paths, ['src/api/route.ts'])
    assert.deepEqual(candidates.map((entry) => entry.record.id), ['api-style'])
  })

  it('ignores touches outside the repository', () => {
    const { paths, candidates } = selectScopeCandidates({
      records: [record('api-style', 'src/api/**')],
      touchedPaths: ['C:/elsewhere/file.ts'],
      injected: new Map(),
      repositoryRoot,
    })
    assert.deepEqual(paths, [])
    assert.deepEqual(candidates, [])
  })

  it('never auto-loads a global note: it is already in the index', () => {
    const { candidates } = selectScopeCandidates({
      records: [record('global-note', ''), record('api-style', 'src/api/**')],
      touchedPaths: ['C:/repo/src/api/route.ts'],
      injected: new Map(),
      repositoryRoot,
    })
    assert.deepEqual(candidates.map((entry) => entry.record.id), ['api-style'])
  })

  it('skips a note whose body was already delivered', () => {
    const already = record('api-style', 'src/api/**')
    const { candidates } = selectScopeCandidates({
      records: [already],
      touchedPaths: ['C:/repo/src/api/route.ts'],
      injected: new Map([[already.id, noteDigest(already)]]),
      repositoryRoot,
    })
    assert.deepEqual(candidates, [])
  })

  it('re-delivers a note whose body changed since it was delivered', () => {
    const before = record('api-style', 'src/api/**', 'old body')
    const after = record('api-style', 'src/api/**', 'new body')
    const { candidates } = selectScopeCandidates({
      records: [after],
      touchedPaths: ['C:/repo/src/api/route.ts'],
      injected: new Map([[after.id, noteDigest(before)]]),
      repositoryRoot,
    })
    assert.deepEqual(candidates.map((entry) => entry.record.id), ['api-style'])
  })

  it('does not match a note scoped to an unrelated directory', () => {
    const { candidates } = selectScopeCandidates({
      records: [record('ui-style', 'src/ui/**')],
      touchedPaths: ['C:/repo/src/api/route.ts'],
      injected: new Map(),
      repositoryRoot,
    })
    assert.deepEqual(candidates, [])
  })

  it('caps candidates at three times the per-step note budget', () => {
    const records = Array.from({ length: 20 }, (_, index) => record(`note-${index}`, 'src/**'))
    const { candidates } = selectScopeCandidates({
      records,
      touchedPaths: ['C:/repo/src/a.ts'],
      injected: new Map(),
      repositoryRoot,
      notesPerStep: 2,
    })
    assert.equal(candidates.length, 6, '2 notes per step leaves room to pick the best 2 of 6')
  })
})

describe('resolvePanelCwd', () => {
  const REPO = 'C:\\Users\\me\\repo'
  const PROFILE = 'C:\\Users\\me\\.dsh\\profiles\\desktop'

  it('prefers the cwd of a session this process has seen run', () => {
    const choice = resolvePanelCwd({
      sessionId: 's1', liveCwd: REPO, storedCwd: 'C:\\stale', recentCwd: 'C:\\other', processCwd: PROFILE,
    })
    assert.deepEqual(choice, { cwd: REPO, bound: true, source: 'live' })
  })

  it('asks the session store for a session that has not run a step yet', () => {
    // The regression: after a restart the live map is empty, so the panel used to
    // slide past this session entirely and land on the app's profile directory.
    const choice = resolvePanelCwd({
      sessionId: 's1', liveCwd: undefined, storedCwd: REPO, recentCwd: 'C:\\other', processCwd: PROFILE,
    })
    assert.deepEqual(choice, { cwd: REPO, bound: true, source: 'store' })
  })

  it('marks a guess as unbound rather than calling it this repository', () => {
    const recent = resolvePanelCwd({ sessionId: 'unknown', liveCwd: undefined, storedCwd: undefined, recentCwd: REPO, processCwd: PROFILE })
    assert.deepEqual(recent, { cwd: REPO, bound: false, source: 'recent' })
    const none = resolvePanelCwd({ sessionId: 'unknown', liveCwd: undefined, storedCwd: undefined, recentCwd: undefined, processCwd: PROFILE })
    assert.deepEqual(none, { cwd: PROFILE, bound: false, source: 'process' })
  })

  it('treats a missing, blank or non-string session id as no session at all', () => {
    for (const sessionId of [undefined, null, '', '   ', 42, { id: 's1' }]) {
      const choice = resolvePanelCwd({ sessionId, liveCwd: REPO, storedCwd: REPO, recentCwd: undefined, processCwd: PROFILE })
      assert.equal(choice.bound, false, `sessionId ${JSON.stringify(sessionId)} must not bind`)
      assert.equal(choice.cwd, PROFILE)
    }
  })

  it('ignores an empty cwd from either source, since it resolves nowhere', () => {
    const choice = resolvePanelCwd({ sessionId: 's1', liveCwd: '', storedCwd: '', recentCwd: REPO, processCwd: PROFILE })
    assert.deepEqual(choice, { cwd: REPO, bound: false, source: 'recent' })
  })
})
