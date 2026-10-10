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

  const limitsFor = (agent) => ({
    indexMaxBytes: resolved.indexMaxBytes,
    noteMaxBytes: resolved.noteMaxBytes,
    recallMaxBytes: resolved.recallMaxBytes,
    recallLimit: resolved.recallLimit,
    source: sessionLabel(agent),
  })

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
      'Save one durable project memory for this repository, available in future sessions.',
      'Use it ONLY for knowledge that cannot be recovered by searching the code:',
      'corrections the user gave you, approaches they confirmed, decisions together with their rationale,',
      'ongoing work and deadlines, and pointers to information living outside the repository.',
      'Do NOT save: architecture, file layout, function signatures (all derivable by searching),',
      'anything already stated in AGENTS.md or CLAUDE.md, or one-off debugging steps.',
      'Keep one memory to one fact, and prefer reusing an existing id over creating a near-duplicate.',
      'The index visible to you lists the ids that already exist.',
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
        description: 'One line shown in the index. Keep it under ~80 characters.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The memory itself. Explain WHY, not just WHAT. One fact per memory.',
      },
      kind: {
        type: 'string',
        required: true,
        description: 'One of: user (who the user is / how they work) | feedback (a correction or a confirmed approach) | project (work, decisions, deadlines not derivable from code) | reference (where external information lives).',
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
          'is genuinely about that file.',
        ].join(' '),
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional lowercase retrieval tags, at most 8.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const memory = await memoryFor(exec.agent)
      return store.writeMemory(memory, args, limitsFor(exec.agent), ioFor(memory))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: [
      'Read full project-memory entries for this repository.',
      'The index injected into your context shows which memories exist; call this to read their bodies.',
      'Search matches ids, titles, tags, and body text by substring — identifiers and exact words work best.',
      'Omit every argument to list the whole index again.',
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        description: 'Substring to match against id, title, tags, and body.',
      },
      kind: {
        type: 'string',
        description: 'Restrict to one kind: user | feedback | project | reference.',
      },
      scope: {
        type: 'string',
        description: 'Restrict to memories whose scope covers this repository-relative path.',
      },
      limit: {
        type: 'number',
        description: `Maximum entries to return (default ${store.DEFAULT_RECALL_LIMIT}, hard cap ${store.MAX_RECALL_LIMIT}).`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const memory = await memoryFor(exec.agent)
      return store.recallMemory(memory, args ?? {}, limitsFor(exec.agent), ioFor(memory))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: [
      'Remove a project memory that turned out to be wrong, outdated, or no longer applicable.',
      'The entry is archived rather than destroyed, so it can be recovered by hand.',
      'Use this when the index is at its budget and you need to make room, or when the user says a memory is wrong.',
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
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const memory = await memoryFor(exec.agent)
      return store.forgetMemory(memory, args, limitsFor(exec.agent), ioFor(memory))
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

      const inject = []

      // L0 — the always-on index, re-sent only when it actually changed.
      if (records.length > 0) {
        const rendered = store.renderIndex(records, resolved.indexMaxBytes)
        try {
          // Re-derived inside from `notes/`, so a view that went stale while
          // this step was assembling cannot clobber a concurrent retirement.
          await store.syncIndex(memory.root, io, resolved.indexMaxBytes)
        } catch (error) {
          // A read-only session cannot reconcile the derived index file; the
          // injected content is still correct because it comes from notes/.
          ctx.logger?.debug?.('project-memory: index sync skipped: %o', error)
        }
        const digest = store.indexDigest(rendered)
        const visible = visibleMemorySource(agent, messages)
        const unchanged = visible?.digest === digest && visible?.baselineIdentity === memory.identity
        if (!unchanged) {
          inject.push(createUserMessage({
            content: [{
              type: 'text',
              text: store.renderInjection(rendered, {
                update: visible !== undefined,
                budget: resolved.indexMaxBytes,
              }),
            }],
            source: {
              kind: SOURCE_KIND,
              form: 'index',
              digest,
              baselineIdentity: memory.identity,
              entries: rendered.included,
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

  /** Resolve the memory root a browser request is about. */
  const memoryForSession = async (sessionId) => {
    const cwd = (typeof sessionId === 'string' ? cwdBySession.get(sessionId) : undefined)
      ?? mostRecentCwd
      ?? process.cwd()
    return memoryFor({ session: { header: { cwd } } })
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
          const memory = await memoryForSession(url.searchParams.get('sessionId'))
          const io = ioFor(memory)
          const { records, skipped } = await store.loadRecordsDetailed(memory.root, io)
          ctx.logger?.debug?.('project-memory: browser listed %d memories for %s', records.length, memory.root)
          sendJson(res, 200, {
            storage: memory.storage,
            projectKey: memory.projectKey,
            repositoryRoot: memory.root,
            skipped,
            memories: records.map((record) => ({
              id: record.id,
              title: record.title,
              kind: record.kind,
              scope: record.scope,
              tags: record.tags,
              modified: record.modified,
            })),
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
          const memory = await memoryForSession(url.searchParams.get('sessionId'))
          const io = ioFor(memory)
          const { records } = await store.loadRecordsDetailed(memory.root, io)
          const record = records.find((entry) => entry.id === id)
          if (record === undefined) {
            sendJson(res, 404, { message: `no memory named "${id}"` })
            return
          }
          sendJson(res, 200, { memory: { ...record } })
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
          const memory = await memoryForSession(sessionId)
          const io = ioFor(memory)
          const message = await store.forgetMemory(
            memory,
            { id, reason },
            { ...limitsFor(undefined), indexMaxBytes: resolved.indexMaxBytes, source: `panel:${sessionId ?? 'unknown'}` },
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
