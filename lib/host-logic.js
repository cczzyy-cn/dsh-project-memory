/**
 * Harness-free host logic for dsh-project-memory.
 *
 * `lib/index.js` wires these functions to Cordis services, but it also imports
 * harness packages that do not resolve outside DSH — so any logic left in there
 * is reachable only by booting a real profile. Everything that can be decided
 * without the harness lives here instead, where plain `node --test` can reach
 * it. The waterfall regression (a second pre-step listener that failed to call
 * `next()` and handed the loop an undefined decision) is exactly the class of
 * bug this split exists to catch.
 *
 * @module dsh-project-memory/host-logic
 */

import {
  DEFAULT_GLOBAL_INDEX_MAX_BYTES,
  DEFAULT_IDENTITY,
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_NOTE_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_BYTES,
  DEFAULT_SCOPE_MAX_BYTES,
  DEFAULT_SCOPE_NOTES_PER_STEP,
  MEMORY_IDENTITIES,
  MEMORY_TIERS,
  MAX_RECALL_LIMIT,
  noteDigest,
  relativeScopePath,
  selectScopedRecords,
} from './store.js'
import {
  DEFAULT_RECENT_SESSION_BYTES,
  DEFAULT_RECENT_SESSIONS,
} from './sessions.js'

/**
 * Fold user configuration into the runtime shape, validating what the schema
 * cannot express.
 *
 * @param config - user-facing plugin configuration.
 * @param dshHome - the resolved harness home, injected so this stays pure.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config, dshHome) {
  const storage = String(config?.storage ?? 'home').trim().toLowerCase()
  if (storage !== 'home' && storage !== 'repo') {
    throw new Error(`project-memory: storage must be "home" or "repo", got ${JSON.stringify(config?.storage)}`)
  }
  const identity = String(config?.identity ?? DEFAULT_IDENTITY).trim().toLowerCase()
  if (!MEMORY_IDENTITIES.includes(identity)) {
    throw new Error(`project-memory: identity must be "repository" or "directory", got ${JSON.stringify(config?.identity)}`)
  }
  const markers = (config?.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS])
    .map((marker) => String(marker).trim())
    .filter((marker) => marker.length > 0 && !/[\\/]/.test(marker))
  return {
    enabled: config?.enabled !== false,
    storage,
    identity,
    indexMaxBytes: config?.indexMaxBytes ?? DEFAULT_INDEX_MAX_BYTES,
    noteMaxBytes: config?.noteMaxBytes ?? DEFAULT_NOTE_MAX_BYTES,
    recallMaxBytes: config?.recallMaxBytes ?? DEFAULT_RECALL_MAX_BYTES,
    recallLimit: config?.recallLimit ?? DEFAULT_RECALL_LIMIT,
    scopeMaxBytes: config?.scopeMaxBytes ?? DEFAULT_SCOPE_MAX_BYTES,
    scopeNotesPerStep: config?.scopeNotesPerStep ?? DEFAULT_SCOPE_NOTES_PER_STEP,
    recentSessions: config?.recentSessions ?? DEFAULT_RECENT_SESSIONS,
    recentSessionBytes: config?.recentSessionBytes ?? DEFAULT_RECENT_SESSION_BYTES,
    globalEnabled: config?.globalEnabled !== false,
    globalIndexMaxBytes: config?.globalIndexMaxBytes ?? DEFAULT_GLOBAL_INDEX_MAX_BYTES,
    projectRootMarkers: markers.length > 0 ? markers : ['.git'],
    dshHome,
  }
}

/**
 * Expand a tool call's `target` argument into the memory tiers to address.
 *
 * Writes and archives default to `repo`: a repository detail must not leak into
 * agent-wide memory by accident, so going global is always something the caller
 * spelled out. Recall is the other way round — a question is usually "have I hit
 * this before, anywhere?" — so `all` is its default and an unusable value falls
 * back to it rather than silently narrowing the search.
 *
 * @param target - the raw argument, of unknown type.
 * @param options - whether `all` is allowed, and what an unusable value means.
 * @returns tiers to consult, most specific first.
 */
export function targetsOf(target, { allowAll = false, fallback = 'repo' } = {}) {
  const value = typeof target === 'string' ? target.trim().toLowerCase() : ''
  const fallbackTiers = fallback === 'all' && allowAll
    ? [...MEMORY_TIERS]
    : [MEMORY_TIERS.includes(fallback) ? fallback : 'repo']
  if (value === 'all') return allowAll ? [...MEMORY_TIERS] : fallbackTiers
  if (MEMORY_TIERS.includes(value)) return [value]
  return fallbackTiers
}

/**
 * Decide which working directory a browser panel request is about.
 *
 * The panel asks about *its own* session, and a session only enters `liveCwd`
 * after it has run a step in this process. So right after a restart — or in a
 * session that has not sent anything yet — the map missed, and the old fallback
 * chain slid all the way down to `process.cwd()`. In the desktop app that is the
 * profile directory, which is no repository at all: the panel then rendered that
 * empty memory root as if it were the repository on screen ("0 条 · ac75c602").
 *
 * `storedCwd` — the session store's own `header.cwd`, available for any session
 * that exists — closes that hole. `bound` reports whether the answer really is
 * about the requested session, so a caller can refuse to *mutate* a guess: the
 * archive route would otherwise be able to retire another repository's memory.
 *
 * @param facts - requested session id, the two cwds known for it, the last cwd this process saw, and the process cwd.
 * @returns the chosen cwd, whether it belongs to the requested session, and which source answered.
 */
export function resolvePanelCwd({ sessionId, liveCwd, storedCwd, recentCwd, processCwd }) {
  const id = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : undefined
  if (id !== undefined) {
    if (typeof liveCwd === 'string' && liveCwd.length > 0) return { cwd: liveCwd, bound: true, source: 'live' }
    if (typeof storedCwd === 'string' && storedCwd.length > 0) return { cwd: storedCwd, bound: true, source: 'store' }
  }
  // Unbound from here on: the request named no session this process can place, so
  // what follows is a guess about *some* repository, not about the one on screen.
  if (typeof recentCwd === 'string' && recentCwd.length > 0) return { cwd: recentCwd, bound: false, source: 'recent' }
  return { cwd: processCwd, bound: false, source: 'process' }
}

/**
 * The index budget one tier's writes are held to.
 *
 * The tiers have separate budgets, and the *write* path must honour the same one
 * the injection path truncates at. Otherwise a global index could grow to the
 * repository's budget while every session silently dropped its tail — the failure
 * would surface as "some entries are never in the index" instead of as a refused
 * write, which is exactly the wrong place to find out.
 *
 * @param facts - the tier being written, and both configured budgets.
 * @returns the byte budget for that tier's index.
 */
export function indexBudgetFor({ tier, indexMaxBytes, globalIndexMaxBytes }) {
  return tier === 'global' ? globalIndexMaxBytes : indexMaxBytes
}

/**
 * Whether this step is one the plugin may inject into.
 *
 * A rejected step opens no step, and a first step with nothing to run has no
 * message to attach to; injecting into either would append to a step that never
 * happens.
 *
 * @param facts - the decision kind, step number, claimed message count, agent presence.
 * @returns whether injection should proceed.
 */
export function isInjectionStep({ decisionKind, step, messageCount, hasAgent }) {
  if (decisionKind === 'reject') return false
  if (step === 1 && messageCount === 0) return false
  return hasAgent === true
}

/**
 * Create the mutable state used to attribute file touches to agents.
 *
 * Touches are carried on a token so a nested call (subagent, `run_code`) can
 * hand them to its parent execution: the nested record has no agent of its own,
 * so attributing there would attribute to nobody.
 *
 * @returns fresh touch state.
 */
export function createTouchState() {
  return { carried: new Map(), pending: new Map() }
}

/**
 * Fold one `tools/result` observation into the touch state.
 *
 * @param state - state from {@link createTouchState}.
 * @param event - token, parent token, agent, whether the call succeeded, and the touched path.
 */
export function applyToolResult(state, event) {
  const { token, parent, agent, succeeded, path } = event
  const carried = state.carried.get(token) ?? []
  state.carried.delete(token)

  if (succeeded === true && agent !== undefined && typeof path === 'string' && path.length > 0) {
    carried.push(path)
  }

  if (parent !== undefined) {
    if (carried.length > 0) {
      const inherited = state.carried.get(parent)
      if (inherited === undefined) state.carried.set(parent, carried)
      else inherited.push(...carried)
    }
    return
  }

  if (agent === undefined || carried.length === 0) return
  let pending = state.pending.get(agent)
  if (pending === undefined) {
    pending = new Set()
    state.pending.set(agent, pending)
  }
  for (const touched of carried) pending.add(touched)
}

/**
 * Take and clear one agent's pending touches.
 *
 * Consumption is deliberate: a touch informs exactly the next step, so a path
 * reached early in a turn cannot keep re-injecting memory for the rest of it.
 *
 * @param state - state from {@link createTouchState}.
 * @param agent - the agent whose touches to take.
 * @returns the touched paths, now removed from the state.
 */
export function takePendingTouches(state, agent) {
  const pending = state.pending.get(agent)
  if (pending === undefined) return []
  state.pending.delete(agent)
  return [...pending]
}

/**
 * Decide which scoped note bodies a set of touches should load.
 *
 * Global notes are excluded by design: they already appear in the always-injected
 * index, so re-sending their bodies on every file touch would spend the budget
 * on the least specific knowledge.
 *
 * @param options - records, touched paths, the session's already-injected map, and budgets.
 * @returns the repository-relative paths seen and the notes that still need loading.
 */
export function selectScopeCandidates({
  records,
  touchedPaths,
  injected,
  repositoryRoot,
  notesPerStep = DEFAULT_SCOPE_NOTES_PER_STEP,
}) {
  const paths = []
  for (const touchedPath of touchedPaths) {
    const relativePath = relativeScopePath(repositoryRoot, touchedPath)
    if (relativePath !== undefined && !paths.includes(relativePath)) paths.push(relativePath)
  }
  if (paths.length === 0) return { paths, candidates: [] }

  const candidates = selectScopedRecords(records, paths, notesPerStep * 3)
    .filter((entry) => injected.get(entry.record.id) !== noteDigest(entry.record))
  return { paths, candidates }
}
