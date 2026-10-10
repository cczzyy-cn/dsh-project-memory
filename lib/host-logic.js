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
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_NOTE_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_BYTES,
  DEFAULT_SCOPE_MAX_BYTES,
  DEFAULT_SCOPE_NOTES_PER_STEP,
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
  const markers = (config?.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS])
    .map((marker) => String(marker).trim())
    .filter((marker) => marker.length > 0 && !/[\\/]/.test(marker))
  return {
    enabled: config?.enabled !== false,
    storage,
    indexMaxBytes: config?.indexMaxBytes ?? DEFAULT_INDEX_MAX_BYTES,
    noteMaxBytes: config?.noteMaxBytes ?? DEFAULT_NOTE_MAX_BYTES,
    recallMaxBytes: config?.recallMaxBytes ?? DEFAULT_RECALL_MAX_BYTES,
    recallLimit: config?.recallLimit ?? DEFAULT_RECALL_LIMIT,
    scopeMaxBytes: config?.scopeMaxBytes ?? DEFAULT_SCOPE_MAX_BYTES,
    scopeNotesPerStep: config?.scopeNotesPerStep ?? DEFAULT_SCOPE_NOTES_PER_STEP,
    recentSessions: config?.recentSessions ?? DEFAULT_RECENT_SESSIONS,
    recentSessionBytes: config?.recentSessionBytes ?? DEFAULT_RECENT_SESSION_BYTES,
    projectRootMarkers: markers.length > 0 ? markers : ['.git'],
    dshHome,
  }
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
