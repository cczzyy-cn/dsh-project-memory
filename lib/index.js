/**
 * Project memory for DeepSeek Harness.
 *
 * DSH already carries human-written project rules into every session
 * (`dsh-agent-instructions` renders the AGENTS.md / CLAUDE.md chain). This plugin
 * supplies the other half: durable memory the agent writes itself, scoped to the
 * repository and recalled on demand.
 *
 * Division of labour, deliberately strict:
 * - it never reads or re-injects AGENTS.md / CLAUDE.md content;
 * - it injects only an index, so the per-request fixed cost stays a couple of KB;
 * - full entries arrive through `memory_recall` or, later, path-scoped loading.
 *
 * @module dsh-project-memory
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import * as hostLogic from './host-logic.js'
import * as sessions from './sessions.js'
import * as store from './store.js'

/** Source kind that marks every message this plugin owns. */
const SOURCE_KIND = 'project-memory'

/** Display name shown by `dsh --dump-config` and the plugin inventory. */
export const name = 'ProjectMemory'

/** The tool registry is the only service this plugin requires. */
export const inject = ['tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  storage: z.string().default('home'),
  indexMaxBytes: z.number().step(1).min(256).default(store.DEFAULT_INDEX_MAX_BYTES),
  noteMaxBytes: z.number().step(1).min(256).default(store.DEFAULT_NOTE_MAX_BYTES),
  recallMaxBytes: z.number().step(1).min(256).default(store.DEFAULT_RECALL_MAX_BYTES),
  recallLimit: z.number().step(1).min(1).max(store.MAX_RECALL_LIMIT).default(store.DEFAULT_RECALL_LIMIT),
  scopeMaxBytes: z.number().step(1).min(256).default(store.DEFAULT_SCOPE_MAX_BYTES),
  scopeNotesPerStep: z.number().step(1).min(1).max(10).default(store.DEFAULT_SCOPE_NOTES_PER_STEP),
  recentSessions: z.number().step(1).min(0).max(20).default(sessions.DEFAULT_RECENT_SESSIONS),
  recentSessionBytes: z.number().step(1).min(120).default(sessions.DEFAULT_RECENT_SESSION_BYTES),
  globalEnabled: z.boolean().default(true),
  globalIndexMaxBytes: z.number().step(1).min(128).default(store.DEFAULT_GLOBAL_INDEX_MAX_BYTES),
  projectRootMarkers: z.array(z.string()).default([...store.DEFAULT_PROJECT_ROOT_MARKERS]),
  dshHome: z.string(),
})


/**
 * Find the memory message already visible to this agent, if any.
 *
 * Mirrors the lookup `dsh-agent-instructions` uses for its baseline: the claimed
 * batch first, then the durable session surface. Finding one is what makes
 * injection idempotent instead of additive.
 *
 * @param agent - the running agent.
 * @param claimed - messages handed to this pre-step invocation.
 * @returns the source object of the visible message, or undefined.
 */
function visibleMemorySource(agent, claimed) {
  const pending = [...(claimed ?? [])].reverse()
  for (const message of pending) {
    if (store.matchesIndexSource(message?.source, SOURCE_KIND)) return message.source
  }
  const nodes = agent?.session?.surface?.nodes
  if (nodes === undefined) return undefined
  for (const sequence of [...nodes].reverse()) {
    const event = agent.session.eventAt(sequence)
    if (event?.type === 'user/message' && store.matchesIndexSource(event.data?.source, SOURCE_KIND)) {
      return event.data.source
    }
  }
  return undefined
}

/** Best-effort provenance label for a session, without depending on one exact field. */
function sessionLabel(agent) {
  const header = agent?.session?.header
  const candidates = [header?.sessionId, header?.id, agent?.session?.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return 'unknown-session'
}

/**
 * First-party file tools whose successful calls reveal which paths the agent is
 * working on. Same set `dsh-agent-instructions` tracks, so the two plugins agree
 * on what counts as reaching a file.
 */
const TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

/**
 * Extract the touched path from one execution, when it is a file tool call.
 * @param exec - tool execution record.
 * @returns the raw path argument, or undefined.
 */
function filePathFromExecution(exec) {
  if (!TOUCH_TOOL_NAMES.has(exec?.name)) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const raw = args.file_path
  if (typeof raw !== 'string') return undefined
  const path = raw.trim()
  return path.length > 0 ? path : undefined
}

/**
 * Mount the plugin.
 * @param ctx - cordis context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = hostLogic.resolveConfig(config, resolveDshHome(config.dshHome))

  /** Sessions whose unusable note files have already been reported, so the log stays quiet. */
  const reportedSkipped = new WeakSet()

  /**
   * Tell the human once per session about note files the plugin cannot address.
   * Silence would be worse: a memory the user believes is active would never load.
   */
  const reportSkipped = (context, agent, memory, skipped) => {
    if (reportedSkipped.has(agent)) return
    reportedSkipped.add(agent)
    context.logger?.warn?.(
      'project-memory: ignoring %d unusable note file(s) in %s — names must be kebab-case ids and end in .md: %s',
      skipped.length,
      memory.root,
      skipped.join(', '),
    )
  }

  /** Resolve this agent's memory root on demand; cwd is per session, not per plugin. */
  const memoryFor = (agent) => store.resolveMemoryRoot({
    dshHome: resolved.dshHome,
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
    markers: resolved.projectRootMarkers,
    storage: resolved.storage,
  })

  /**
   * Budgets and provenance for one write, whose tier is worth recording: a global
   * note's journal line should say it came from this session, not imply the session
   * was in the repository the fact is about.
   *
   * @param agent - the running agent.
   * @param memory - the resolved tier being written, when one is known.
   * @returns the limits object store.js expects.
   */
  const limitsFor = (agent, memory) => ({
    // Each tier has its own index budget, and a write must be held to the same one
    // the injected block truncates at -- otherwise entries quietly stop appearing
    // in the index instead of the write being refused.
    indexMaxBytes: hostLogic.indexBudgetFor({
      tier: memory?.tier,
      indexMaxBytes: resolved.indexMaxBytes,
      globalIndexMaxBytes: resolved.globalIndexMaxBytes,
    }),
    noteMaxBytes: resolved.noteMaxBytes,
    recallMaxBytes: resolved.recallMaxBytes,
    recallLimit: resolved.recallLimit,
    source: `${sessionLabel(agent)}${memory?.tier === 'global' ? ':global' : ''}`,
  })

  /** The agent-wide memory root, resolved per call because it depends only on the home. */
  const globalMemoryFor = () => store.resolveGlobalMemoryRoot({ dshHome: resolved.dshHome })

  /** The current session's id, however this build spells it. */
  const sessionIdOf = (agent) => {
    const header = agent?.session?.header
    const id = header?.sessionId ?? header?.id
    return typeof id === 'string' ? id : undefined
  }

  /**
   * Name the sessions the title service could not name.
   *
   * Bounded to the rows about to be shown, and only for rows with no title, so
   * the extra session reads happen only where the cheap path came up empty.
   *
   * @param sessionQuery - the mounted session query service.
   * @param entries - selected sessions, newest first.
   * @param cap - how many leading entries may pay for a derived label.
   * @returns entries with any derivable title filled in.
   */
  const fillLabels = async (sessionQuery, entries, cap) => {
    const need = entries.slice(0, Math.max(0, cap)).filter((entry) => typeof entry.title !== 'string')
    if (need.length === 0) return entries
    const derived = new Map()
    await Promise.all(need.map(async (entry) => {
      try {
        derived.set(entry.id, sessions.labelFromSurface(await sessionQuery.readSurface(entry.id)))
      } catch (error) {
        ctx.logger?.debug?.('project-memory: derived label for %s failed: %o', entry.id, error)
      }
    }))
    return entries.map((entry) => (
      typeof entry.title === 'string' ? entry : { ...entry, title: derived.get(entry.id) }
    ))
  }

  /** Per-agent cache of the rendered recent-sessions block. */
  const recentSessionsCache = new WeakMap()

  /**
   * Render this repository's recent sessions, once per agent.
   *
   * `ctx.sessionQuery` is mounted by the base composition's SQLite provider, so
   * the corpus is DSH's to own. When the service is absent the feature switches
   * itself off and everything else keeps working — the same contract the browser
   * routes follow. Caching is per agent because the corpus does not change
   * meaningfully inside one session and the call reads the session store.
   *
   * @param agent - the running agent.
   * @param memory - resolved memory root, supplying the repository root to match on.
   * @returns the block, or undefined when there is nothing to say.
   */
  const recentSessionsFor = async (agent, memory) => {
    if (recentSessionsCache.has(agent)) return recentSessionsCache.get(agent)
    let text
    try {
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined) {
        ctx.logger?.debug?.('project-memory: ctx.sessionQuery is not mounted; session recall stays off')
      } else {
        const corpus = await sessionQuery.listSessions()
        const excludeSessionId = sessionIdOf(agent)
        const select = (titleSnapshots) => sessions.selectRecentSessions({
          sessions: corpus,
          titleSnapshots,
          repositoryRoot: memory.repositoryRoot,
          excludeSessionId,
          limit: resolved.recentSessions,
        })
        const candidates = select([])
        if (candidates.length > 0) {
          // Titles are a second read, and a failure there must not cost the list:
          // an untitled session is still worth naming by its date.
          let titleSnapshots = []
          try {
            titleSnapshots = await sessionQuery.readTitleSnapshots(candidates.map((entry) => entry.id))
          } catch (error) {
            ctx.logger?.debug?.('project-memory: session titles unavailable: %o', error)
          }
          // Two title sources, cheapest first: the folded snapshot answers for the
          // sessions warm in this app run, and the disk names the cold ones it
          // cannot (see sessions.js). Deriving a label from the first user message
          // stays the last resort, because it costs a whole-log read.
          const named = await sessions.fillStoredTitles(select(titleSnapshots), { dshHome: resolved.dshHome })
          const labelled = await fillLabels(sessionQuery, named, resolved.recentSessions)
          const rendered = sessions.renderRecentSessions(labelled, {
            maxBytes: resolved.recentSessionBytes,
          })
          if (rendered.text.length > 0) text = rendered.text
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('project-memory: session recall failed: %o', error)
    }
    recentSessionsCache.set(agent, text)
    return text
  }

  let warnedMissingFs = false

  /**
   * Storage medium for a memory root.
   *
   * The two stores sit on opposite sides of the sandbox boundary, so they must
   * not share a medium:
   *
   * - `home` lives under `$DSH_HOME` plus a repository hash. The model cannot
   *   name that path, and it is outside the workspace, where `ctx.fs` would
   *   (correctly) refuse a `workspace-write` mutation. It uses the host
   *   filesystem, the same position as session persistence.
   * - `repo` lives inside the workspace. Those paths are model-visible in every
   *   sense that matters, so they go through `ctx.fs` and inherit the session
   *   sandbox: a `read-only` session cannot write memory.
   */
  const ioFor = (memory) => {
    if (memory.storage !== 'repo') return store.nodeIo
    const fileSystem = ctx.get('fs')
    if (fileSystem !== undefined) return store.createFsIo(fileSystem, resolved.noteMaxBytes * 4)
    if (!warnedMissingFs) {
      warnedMissingFs = true
      ctx.logger?.warn?.(
        'project-memory: storage "repo" has no ctx.fs provider mounted; writes are refused rather than '
        + 'silently bypassing the session sandbox',
      )
    }
    // Reads stay available so recall and injection keep working; only mutation
    // is refused, because that is the half the sandbox governs.
    return {
      readText: (path) => store.nodeIo.readText(path),
      listNames: (directory) => store.nodeIo.listNames(directory),
      async writeText() {
        throw new Error(
          'project-memory: storage "repo" requires a mounted ctx.fs provider; refusing to write project '
          + 'memory outside the session sandbox. Mount a filesystem backend or switch storage to "home".',
        )
      },
      async appendText() {
        /* the journal is diagnostic, and no mutation of any kind is performed here */
      },
    }
  }

  if (!resolved.enabled) {
    ctx.logger?.info?.('project-memory: disabled by configuration')
    return
  }

  /* ------------------------------------------------------------- tools -- */

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: [
      'Save one durable memory, available in future sessions.',
      'Use it ONLY for knowledge that cannot be recovered by searching the code:',
      'corrections the user gave you, approaches they confirmed, decisions together with their rationale,',
      'ongoing work and deadlines, and pointers to information living outside the repository.',
      'Do NOT save: architecture, file layout, function signatures (all derivable by searching),',
      'anything already stated in AGENTS.md or CLAUDE.md, or one-off debugging steps.',
      'Keep one memory to one fact, and prefer reusing an existing id over creating a near-duplicate.',
      'The index visible to you lists the ids that already exist.',
      'Use `kind: "pitfall"` with `target: "global"` for a problem that cost real time and the method',
      'that solved it — a hang, a permission trap, a wrong default — so the next repository inherits it.',
    ].join(' '),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Stable kebab-case slug, e.g. "build-uses-pnpm". Reuse it to update that memory.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'One line shown in the index. Keep it under ~80 characters. For a pitfall, state the problem.',
      },
      body: {
        type: 'string',
        required: true,
        description: [
          'The memory itself. Explain WHY, not just WHAT. One fact per memory.',
          'For kind "pitfall", write it as three short parts — 现象 (what you saw), 方法 (what fixed it),',
          '验证 (how you confirmed) — or the same three in English (symptom / method / verified).',
        ].join(' '),
      },
      kind: {
        type: 'string',
        required: true,
        description: 'One of: user (who the user is / how they work) | feedback (a correction or a confirmed approach) | project (work, decisions, deadlines not derivable from code) | reference (where external information lives) | pitfall (a problem hit for real, and the method that solved it).',
      },
      scope: {
        type: 'string',
        description: [
          'Optional repository-relative glob restricting where this memory applies, e.g. "src/api/**" for',
          'a fact about the API layer, or "src/ui/**" for one about frontend components.',
          'Set it when the fact is about PART of the tree: that directory\'s or layer\'s conventions,',
          'structure, or gotchas. Omit it when the fact holds anywhere in the repository — the package',
          'manager, the CI platform, commit or review conventions, team preferences, ongoing work.',
          'When in doubt, omit: an unscoped memory is always in the index, whereas a wrongly narrowed',
          'one is invisible exactly where it was needed. Do not scope to a single file unless the fact',
          'is genuinely about that file. Scopes are read against repository paths only, so they mean',
          'nothing for a global memory.',
        ].join(' '),
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional lowercase retrieval tags, at most 8.',
      },
      target: {
        type: 'string',
        description: 'Where to save: "repo" (default) for this repository, or "global" for knowledge true in every repository.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const target = hostLogic.targetsOf(args?.target)[0]
      const memory = target === 'global' ? globalMemoryFor() : await memoryFor(exec.agent)
      return store.writeMemory(memory, args, limitsFor(exec.agent, memory), ioFor(memory))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: [
      'Read full project-memory entries for this repository.',
      'The index injected into your context is the complete list of what exists; call this to read their bodies.',
      'A query is split into words and scored by how many of them match, so multi-word queries work in any order;',
      'Chinese is matched by overlapping two-character windows, so it does not need spaces.',
      'Pass `id` to read one known entry exactly. Pass `preview: true` for short snippets when triaging',
      'several candidates before reading a full body.',
      `Called with no arguments it returns the first ${store.DEFAULT_RECALL_LIMIT} entries, not the whole index:`,
      `the injected index is the full list, and \`limit\` (hard cap ${store.MAX_RECALL_LIMIT}) or a narrower query is how you read past the first page.`,
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        description: 'Words to match against id, title, tags, and body. All words are considered; more matched ranks higher.',
      },
      id: {
        type: 'string',
        description: 'Exact memory id. Returns that entry without ranking; takes precedence over query.',
      },
      preview: {
        type: 'boolean',
        description: 'Return short snippets around the first match instead of full bodies, for cheap triage before reading an entry.',
      },
      kind: {
        type: 'string',
        description: 'Restrict to one kind: user | feedback | project | reference | pitfall.',
      },
      scope: {
        type: 'string',
        description: 'Restrict to memories whose scope covers this repository-relative path.',
      },
      limit: {
        type: 'number',
        description: `Maximum entries to return (default ${store.DEFAULT_RECALL_LIMIT}, hard cap ${store.MAX_RECALL_LIMIT}).`,
      },
      target: {
        type: 'string',
        description: 'Which tiers to search: "all" (default) for this repository and global memory, or "repo" / "global" to narrow it.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const targets = hostLogic.targetsOf(args?.target, { allowAll: true, fallback: 'all' })
      const tiers = []
      for (const tier of targets) {
        const memory = tier === 'global' ? globalMemoryFor() : await memoryFor(exec.agent)
        tiers.push({ tier, memory, io: ioFor(memory) })
      }
      return store.recallAcrossTiers({
        tiers,
        args: args ?? {},
        limits: { ...limitsFor(exec.agent, tiers[0].memory), source: tiers.map((entry) => entry.memory.tier).join('+') },
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: [
      'Remove a memory that turned out to be wrong, outdated, or no longer applicable.',
      'The entry is archived rather than destroyed, so it can be recovered by hand.',
      'Use this when the index is at its budget and you need to make room, or when the user says a memory is wrong.',
      'A global memory is only ever archived when `target: "global"` says so: the two tiers can hold the same id.',
    ].join(' '),
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Id of the memory to archive, as shown in the index.',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'Why it no longer applies. Recorded in the journal.',
      },
      target: {
        type: 'string',
        description: 'Which tier holds it: "repo" (default) or "global".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const target = hostLogic.targetsOf(args?.target)[0]
      const memory = target === 'global' ? globalMemoryFor() : await memoryFor(exec.agent)
      try {
        return await store.forgetMemory(memory, args, limitsFor(exec.agent, memory), ioFor(memory))
      } catch (error) {
        // An id can live in the other tier; saying which one saves a round trip.
        const other = target === 'global' ? await memoryFor(exec.agent) : globalMemoryFor()
        const elsewhere = await store.loadRecords(other.root, ioFor(other))
        const found = elsewhere.some((record) => record.id === store.normalizeId(args?.id))
        if (!found) throw error
        return `${error.message} It does exist in the ${other.tier} tier — retry with target: "${other.tier}".`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_recall',
    description: [
      'Look up what happened in this repository\'s previous sessions.',
      'With no arguments it lists the recent ones with id, date and title.',
      'Pass an `id` from that list to read an outline of that session: what the user asked and what the',
      'agent answered, turn by turn. Reach for this when the user refers to earlier work that is not in',
      'the current conversation.',
      'Read-only: it stores nothing and changes nothing. To record something for future sessions, use',
      'memory_write instead.',
    ].join(' '),
    parameters: {
      id: {
        type: 'string',
        description: 'Session id from the list, to read an outline of what happened in that session.',
      },
      query: {
        type: 'string',
        description: 'Only list sessions whose title contains this text (case-insensitive).',
      },
      limit: {
        type: 'number',
        description: 'How many sessions to list (default 10, hard cap 20).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined) {
        return 'Session history is not available in this composition: no session-query provider is mounted.'
      }
      const memory = await memoryFor(exec.agent)
      const excludeSessionId = sessionIdOf(exec.agent)
      const corpus = await sessionQuery.listSessions()

      const requestedId = typeof args?.id === 'string' ? args.id.trim() : ''
      if (requestedId.length > 0) {
        const record = corpus.find((entry) => entry.header?.id === requestedId)
        if (record === undefined) return `No session with id "${requestedId}" exists.`
        // `listEvents` returns a lightweight log index -- `{ sessionId, seq, type,
        // time, surface }` with no event body -- so an outline can never come from
        // it. `readSurface` returns the current model surface as full events.
        const records = await sessionQuery.readSurface(requestedId)
        const outline = sessions.outlineSession(records)
        if (outline.total === 0) {
          const keys = Array.isArray(records) && records[0] !== undefined ? Object.keys(records[0]).join(',') : 'none'
          return `Session ${requestedId} has no readable conversation turns (readSurface returned ${Array.isArray(records) ? records.length : 0} events; first record keys: ${keys}).`
        }
        const stamp = typeof record.header?.createdAt === 'number'
          ? ` (${sessions.defaultStamp(record.header.createdAt)})`
          : ''
        const scope = outline.dropped > 0
          ? `${outline.total} turns, showing the last ${outline.turns}`
          : `${outline.total} turns`
        return [
          `Session ${requestedId}${stamp} — ${scope}:`,
          '',
          store.escapeFraming(outline.text),
        ].join('\n')
      }

      const candidates = sessions.selectRecentSessions({
        sessions: corpus,
        repositoryRoot: memory.repositoryRoot,
        excludeSessionId,
        limit: 20,
      })
      let titleSnapshots = []
      let titleFailure
      try {
        titleSnapshots = await sessionQuery.readTitleSnapshots(candidates.map((entry) => entry.id))
      } catch (error) {
        // Staying silent here once cost a whole debugging round: every session
        // rendered as untitled with no hint why.
        titleFailure = String(error?.message ?? error)
        ctx.logger?.warn?.('project-memory: session titles unavailable: %s', titleFailure)
      }
      let entries = sessions.selectRecentSessions({
        sessions: corpus,
        titleSnapshots,
        repositoryRoot: memory.repositoryRoot,
        excludeSessionId,
        limit: 20,
      })
      // The snapshot names only the sessions warm in this app run; everything older
      // folds to nothing, which used to render row 11 onward as （无标题） even
      // though the disk holds a title for it. Fill from the disk before filtering,
      // so `query` can match a title that only the disk knows.
      entries = await sessions.fillStoredTitles(entries, { dshHome: resolved.dshHome })
      const needle = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      if (needle.length > 0) {
        entries = entries.filter((entry) => typeof entry.title === 'string' && entry.title.toLowerCase().includes(needle))
      }
      if (entries.length === 0) {
        if (needle.length > 0) {
          return `No previous session in this repository has a title containing "${args.query}".`
        }
        // Say why the list is empty: an unexplained empty result is the hardest
        // kind of failure to act on.
        const cwds = corpus.slice(0, 3).map((entry) => entry.header?.cwd ?? '(none)').join(' / ')
        return [
          'No previous sessions are recorded for this repository yet.',
          `(corpus: ${corpus.length} session(s); repository root: ${memory.repositoryRoot};`,
          `sample session cwds: ${cwds.length > 0 ? cwds : 'none'})`,
        ].join(' ')
      }
      const requestedLimit = Number(args?.limit)
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 20)
        : 10
      // Last resort, and therefore still capped: deriving a label reads the whole
      // session log, where a snapshot entry or a cache row above cost a fraction of
      // that. Only rows both of those could not name still need this.
      entries = await fillLabels(sessionQuery, entries, Math.min(limit, 10))
      const titled = entries.filter((entry) => typeof entry.title === 'string').length
      const lines = [
        `Previous sessions in this repository (${entries.length} matching${titled < entries.length ? `, ${titled} titled` : ''}):`,
        '',
        ...entries.slice(0, limit).map((entry) => sessions.sessionLine(entry, undefined, { withId: true })),
        '',
        'Call `session_recall` with one of those ids to read what happened in it.',
      ]
      if (titleFailure !== undefined) lines.push('', `[titles unavailable: ${titleFailure}]`)
      const rejected = sessions.titleFailures(titleSnapshots)
      if (rejected.length > 0) {
        lines.push('', `[title read rejected for ${rejected.length} session(s): ${rejected.slice(0, 3).join(' | ')}]`)
      }
      return lines.join('\n')
    },
  }))

  /* ------------------------------------------------------ touch tracking -- */

  /**
   * Per-agent record of what has already been delivered.
   *
   * `injected` maps a note id to the digest of the body already sent, so an
   * unchanged note is never delivered twice in one session while an edited note
   * is delivered again. Pending touches live in the shared touch state.
   */
  const sessionState = new WeakMap()
  const stateOf = (agent) => {
    let state = sessionState.get(agent)
    if (state === undefined) {
      state = { injected: new Map() }
      sessionState.set(agent, state)
    }
    return state
  }

  /** Touch attribution state; see `host-logic` for the rules it encodes. */
  const touchState = hostLogic.createTouchState()

  ctx.on('tools/result', (exec, result) => {
    hostLogic.applyToolResult(touchState, {
      token: exec.token,
      parent: exec.parent,
      agent: exec.agent,
      succeeded: result?.isError !== true && exec.agent !== undefined && exec.signal?.aborted !== true,
      path: filePathFromExecution(exec),
    })
  })

  /**
   * Turn this agent's pending touches into one scope message, consuming them.
   *
   * @param agent - the running agent.
   * @param memory - resolved memory root.
   * @param records - records loaded for this step.
   * @returns the message to inject, or undefined when nothing new applies.
   */
  const takeScopedNotes = (agent, memory, records) => {
    const state = stateOf(agent)
    const touched = hostLogic.takePendingTouches(touchState, agent)
    if (touched.length === 0 || records.length === 0) return undefined

    const { candidates } = hostLogic.selectScopeCandidates({
      records,
      touchedPaths: touched,
      injected: state.injected,
      repositoryRoot: memory.repositoryRoot,
      notesPerStep: resolved.scopeNotesPerStep,
    })
    if (candidates.length === 0) return undefined

    const budgeted = store.renderScopeInjectionBudgeted(candidates, resolved.scopeMaxBytes)
    if (budgeted.included.length === 0) return undefined
    for (const entry of budgeted.included) {
      state.injected.set(entry.record.id, store.noteDigest(entry.record))
    }

    return createUserMessage({
      content: [{ type: 'text', text: budgeted.text }],
      source: {
        kind: SOURCE_KIND,
        form: 'scope',
        notes: budgeted.included.map((entry) => entry.record.id),
        omitted: budgeted.omitted,
        paths,
        projectKey: memory.projectKey,
      },
    })
  }

  /**
   * Remember each session's working directory.
   *
   * The browser half knows its session id but not the directory that decides
   * which repository's memory it is looking at. Sampling the fact inside the
   * pre-step handler — rather than in a second listener — keeps a single owner
   * of that waterfall: a listener that forgets to call `next()` swallows the
   * chain and hands the loop an undefined decision.
   */
  const cwdBySession = new Map()

  /**
   * Working directory of the most recently active session.
   *
   * The fallback for a browser request that cannot name its session. Vastly
   * better than `process.cwd()`, which for the desktop app is an install
   * location no repository ever resolves to — that mismatch is why this panel
   * first reported zero memories for a repository that had one.
   */
  let mostRecentCwd

  /* --------------------------------------------------------- injection -- */

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    // A listener upstream that forgot to call `next()` yields undefined here, and
    // proceeding would throw on `decision.messages` — refuse instead of crashing.
    if (decision === undefined) return decision
    if (!hostLogic.isInjectionStep({
      decisionKind: decision.kind,
      step,
      messageCount: decision.messages.length,
      hasAgent: agent !== undefined,
    })) return decision

    const header = agent.session?.header
    const sessionId = header?.sessionId ?? header?.id
    if (typeof sessionId === 'string' && typeof header?.cwd === 'string') cwdBySession.set(sessionId, header.cwd)
    if (typeof header?.cwd === 'string') mostRecentCwd = header.cwd

    try {
      const memory = await memoryFor(agent)
      const io = ioFor(memory)
      const { records, skipped } = await store.loadRecordsDetailed(memory.root, io)
      if (skipped.length > 0) reportSkipped(ctx, agent, memory, skipped)

      // Global memory rides along in the same message. It is the one block that is
      // identical in every repository, which is exactly why it must stay small: an
      // unscoped budget here would be paid by every session in every project.
      const globalMemory = resolved.globalEnabled ? globalMemoryFor() : undefined
      const globalIo = globalMemory === undefined ? undefined : ioFor(globalMemory)
      const globalRecords = globalMemory === undefined
        ? []
        : (await store.loadRecordsDetailed(globalMemory.root, globalIo)).records

      const inject = []

      // Recent sessions ride along with the index so the agent knows what it was
      // doing last time without having to think to ask. Computed once per agent:
      // the corpus does not change meaningfully inside one session, and the call
      // touches the session store.
      const recentSessions = resolved.recentSessions > 0
        ? await recentSessionsFor(agent, memory)
        : undefined

      // L0 — the always-on block, re-sent only when it actually changed. Emitted
      // when any part has something: a repository with past sessions but no memory
      // yet still deserves to know what happened.
      if (records.length > 0 || recentSessions !== undefined || globalRecords.length > 0) {
        const rendered = records.length > 0
          ? store.renderIndex(records, resolved.indexMaxBytes)
          : { text: '', included: [], omitted: [], bytes: 0 }
        const globalRendered = globalRecords.length > 0
          ? store.renderIndex(globalRecords, resolved.globalIndexMaxBytes)
          : { text: '', included: [], omitted: [], bytes: 0 }
        if (records.length > 0) {
          try {
            // The records just loaded above are the snapshot this step renders
            // from, so syncIndex can reuse them instead of scanning notes/ a
            // second time on every step. A hand edit that lands mid-step shows
            // up on the next one; notes/ stays authoritative either way.
            await store.syncIndex(memory.root, io, resolved.indexMaxBytes, records)
          } catch (error) {
            // A read-only session cannot reconcile the derived index file; the
            // injected content is still correct because it comes from notes/.
            ctx.logger?.debug?.('project-memory: index sync skipped: %o', error)
          }
        }
        if (globalRecords.length > 0) {
          try {
            // The global tier gets the same reconciliation. Without it a hand-edited
            // global note never reached the file, and the file kept whatever format
            // the version that last wrote it used — visible as an index still full
            // of markdown links a release after links were dropped.
            await store.syncIndex(globalMemory.root, globalIo, resolved.globalIndexMaxBytes, globalRecords)
          } catch (error) {
            ctx.logger?.debug?.('project-memory: global index sync skipped: %o', error)
          }
        }
        const digest = store.contextDigest(rendered.text, recentSessions, globalRendered.text)
        const visible = visibleMemorySource(agent, messages)
        const unchanged = visible?.digest === digest && visible?.baselineIdentity === memory.identity
        if (!unchanged) {
          inject.push(createUserMessage({
            content: [{
              type: 'text',
              text: store.renderInjection(rendered, {
                update: visible !== undefined,
                budget: resolved.indexMaxBytes,
                recentSessions,
                globalIndex: globalRendered,
                globalBudget: resolved.globalIndexMaxBytes,
              }),
            }],
            source: {
              kind: SOURCE_KIND,
              form: 'index',
              digest,
              baselineIdentity: memory.identity,
              entries: [...rendered.included, ...globalRendered.included.map((entry) => `global:${entry}`)],
              projectKey: memory.projectKey,
            },
          }))
        }
      }

      // L1 — bodies of scoped notes covering files reached since the last step.
      const scoped = takeScopedNotes(agent, memory, records)
      if (scoped !== undefined) inject.push(scoped)

      if (inject.length === 0) return decision
      signal?.throwIfAborted?.()
      const lastClaimed = decision.messages.findLastIndex((entry) => messages.includes(entry))
      return {
        ...decision,
        messages: decision.messages.toSpliced(lastClaimed + 1, 0, ...inject),
      }
    } catch (error) {
      ctx.logger?.warn?.('project-memory: context injection failed: %o', error)
      return decision
    }
  })

  /* -------------------------------------------------- browser routes -- */

  /**
   * The working directory the session store recorded for one session.
   *
   * The live map only knows sessions that have already run a step in *this*
   * process, which is exactly what a freshly restarted app does not have. The
   * store knows every session on disk, so it answers where the panel would
   * otherwise have guessed.
   *
   * @param sessionId - the session the panel named.
   * @returns its recorded cwd, or undefined when the store cannot place it.
   */
  const storedCwdOf = async (sessionId) => {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined) return undefined
    try {
      const corpus = await sessionQuery.listSessions()
      const record = corpus.find((entry) => entry.header?.id === sessionId)
      return typeof record?.header?.cwd === 'string' ? record.header.cwd : undefined
    } catch (error) {
      ctx.logger?.debug?.('project-memory: session cwd lookup failed: %o', error)
      return undefined
    }
  }

  /**
   * Resolve the memory root a browser request is about, and whether it is really
   * about the session that asked.
   *
   * @param sessionId - the `sessionId` query parameter, if any.
   * @returns the memory root plus whether it belongs to that session.
   */
  const memoryForSession = async (sessionId) => {
    const id = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : undefined
    const liveCwd = id === undefined ? undefined : cwdBySession.get(id)
    const storedCwd = id === undefined || liveCwd !== undefined ? undefined : await storedCwdOf(id)
    const choice = hostLogic.resolvePanelCwd({
      sessionId: id,
      liveCwd,
      storedCwd,
      recentCwd: mostRecentCwd,
      processCwd: process.cwd(),
    })
    const memory = await memoryFor({ session: { header: { cwd: choice.cwd } } })
    return { memory, bound: choice.bound, source: choice.source }
  }

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /** Same-origin gate for the mutating route, mirroring the harness convention. */
  const isSameOrigin = (req) => {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0) return true
    const host = req.headers.host
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  /**
   * The tiers one panel request is about.
   *
   * `all` is the panel's default because the buttons that matter — read an entry,
   * archive it — act on a row the panel already has, and a row carries its tier.
   */
  const panelTargets = (target) => hostLogic.targetsOf(target, { allowAll: true, fallback: 'all' })

  /** Read one tier's index rows, with the tier stamped on each. */
  const panelRows = async (tier, memory, io) => {
    const { records, skipped } = await store.loadRecordsDetailed(memory.root, io)
    return {
      tier,
      skipped,
      records,
      rows: records.map((record) => ({
        tier,
        id: record.id,
        title: record.title,
        kind: record.kind,
        scope: record.scope,
        tags: record.tags,
        modified: record.modified,
      })),
    }
  }

  const LIST_PATH = '/project-memory/list'
  const ENTRY_PATH = '/project-memory/entry'
  const FORGET_PATH = '/project-memory/forget'

  // Registration is conditional: a composition with no web server (headless,
  // Electron) simply gets no browser routes, and every model-facing tool keeps
  // working exactly as before.
  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: LIST_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const targets = panelTargets(url.searchParams.get('target'))
          const repo = targets.includes('repo')
            ? await memoryForSession(url.searchParams.get('sessionId'))
            : undefined
          const globalMemory = targets.includes('global') ? globalMemoryFor() : undefined
          const tiers = []
          // Repository rows first: they are the more specific knowledge, and the
          // panel renders the list in the order it arrives.
          if (repo !== undefined) tiers.push(await panelRows('repo', repo.memory, ioFor(repo.memory)))
          if (globalMemory !== undefined) tiers.push(await panelRows('global', globalMemory, ioFor(globalMemory)))
          const skipped = tiers.flatMap((entry) => entry.skipped ?? [])
          ctx.logger?.debug?.(
            'project-memory: browser listed %d rows for %s (%s)',
            tiers.reduce((total, entry) => total + entry.rows.length, 0),
            tiers.map((entry) => `${entry.tier}=${entry.records.length}`).join(' '),
            repo === undefined ? 'no repo tier' : `bound=${repo.bound}`,
          )
          const primary = repo?.memory ?? globalMemory
          sendJson(res, 200, {
            storage: primary.storage,
            projectKey: primary.projectKey,
            // The panel keys nothing off either path; they are here so the answer
            // is inspectable. `repositoryRoot` used to carry the memory root.
            repositoryRoot: primary.repositoryRoot,
            memoryRoot: primary.root,
            // False means "the repository answer is a guess": the request named no
            // session this process can place. Global rows are unaffected by it,
            // because they belong to no repository in the first place.
            resolved: repo === undefined ? true : repo.bound,
            hasRepo: repo !== undefined,
            tiers: Object.fromEntries(tiers.map((entry) => [entry.tier, entry.rows.length])),
            skipped,
            memories: tiers.flatMap((entry) => entry.rows),
          })
        } catch (error) {
          sendJson(res, 500, { message: String(error?.message ?? error) })
        }
      },
    }), 'project-memory: list route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: ENTRY_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = url.searchParams.get('id') ?? ''
          const tier = hostLogic.targetsOf(url.searchParams.get('target'))[0]
          const memory = tier === 'global' ? globalMemoryFor() : (await memoryForSession(url.searchParams.get('sessionId'))).memory
          const io = ioFor(memory)
          const { records } = await store.loadRecordsDetailed(memory.root, io)
          const record = records.find((entry) => entry.id === id)
          if (record === undefined) {
            sendJson(res, 404, { message: `no memory named "${id}" in the ${tier} tier` })
            return
          }
          sendJson(res, 200, { memory: { ...record, tier } })
        } catch (error) {
          sendJson(res, 500, { message: String(error?.message ?? error) })
        }
      },
    }), 'project-memory: entry route')

    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: FORGET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { message: 'memory archive requires POST' })
          return
        }
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { message: 'cross-origin memory archive refused' })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = url.searchParams.get('id') ?? ''
          const reason = url.searchParams.get('reason') ?? 'archived from the memory panel'
          const sessionId = url.searchParams.get('sessionId')
          const tier = hostLogic.targetsOf(url.searchParams.get('target'))[0]
          // A global row belongs to no repository, so archiving it needs no session
          // binding at all; the binding gate exists only to keep a *repository*
          // mutation from landing on a guess.
          const repo = tier === 'global' ? undefined : await memoryForSession(sessionId)
          if (repo !== undefined && !repo.bound) {
            // A mutation on a guess could retire another repository's memory: the
            // panel can only be trusted to archive what it is actually bound to.
            sendJson(res, 409, {
              message: '记忆面板没有绑定到本会话，无法确定是哪个仓库；在本会话里发一条消息后重开面板再试。',
              resolved: false,
              source: repo.source,
            })
            return
          }
          const memory = repo === undefined ? globalMemoryFor() : repo.memory
          const io = ioFor(memory)
          const message = await store.forgetMemory(
            memory,
            { id, reason },
            {
              ...limitsFor(undefined, memory),
              indexMaxBytes: hostLogic.indexBudgetFor({
                tier,
                indexMaxBytes: resolved.indexMaxBytes,
                globalIndexMaxBytes: resolved.globalIndexMaxBytes,
              }),
              source: `panel:${sessionId ?? 'unknown'}${tier === 'global' ? ':global' : ''}`,
            },
            io,
          )
          sendJson(res, 200, { message })
        } catch (error) {
          sendJson(res, 400, { message: String(error?.message ?? error) })
        }
      },
    }), 'project-memory: forget route')
  })
}
