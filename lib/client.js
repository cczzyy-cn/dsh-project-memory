/**
 * dsh-project-memory 客户端半边（浏览器）：输入框工具栏的「记忆」按钮与浏览面板。
 *
 * bundle 形态：DSH 的客户端模块系统把本包 `exports["./client"]` 当**经典脚本**
 * 直接送进浏览器，脚本必须调用 `window.__ModuleLoader__.load({ id, factory })`
 * 注册工厂；`id` 必须等于包名（`dsh-project-memory`）。factory 里只能用模块表
 * 提供的 `require`（此处仅 `react`），因此这里手写 `react.createElement`，
 * 不引入 JSX 与打包器。
 *
 * 数据来自**本插件自己的宿主半边**注册的路由（见 lib/index.js）：
 *   GET  /project-memory/list?sessionId=…            → { memories: [...] }
 *   GET  /project-memory/entry?sessionId=…&id=…      → { memory: {...} }
 *   POST /project-memory/forget?sessionId=…&id=…     → { message }
 *
 * 组合里没有 web 服务器（headless / Electron 的 file://）时，宿主半边不会注册
 * 这些路由；面板会显示明确的不可用提示，而不是静默空白。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const NS = 'pmem'
    const cls = (name) => `${NS}-${name}`

    const LIST_PATH = '/project-memory/list'
    const ENTRY_PATH = '/project-memory/entry'
    const FORGET_PATH = '/project-memory/forget'

    const KIND_LABEL = {
      user: '用户',
      feedback: '纠正',
      project: '项目',
      reference: '参考',
    }

    /* ------------------------------------------------------------- styles -- */

    // Colours are stated explicitly for both themes rather than inherited from
    // the host: the app's tokens are not a published contract, and inheriting
    // `color` onto a self-chosen background is how this panel first rendered as
    // dark text on a dark surface.
    const CSS = `
.${cls('wrap')} { position: relative; display: inline-flex; z-index: 9999; }
.${cls('button')} {
  box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 28px; padding: 0 10px;
  border: none; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: var(--pmem-fg);
  cursor: pointer; font-size: 12px; line-height: 18px;
}
.${cls('button')}:hover:not(:disabled) { background: var(--pmem-hover); }
.${cls('button')}:active:not(:disabled) { background: var(--pmem-active); }
.${cls('button')}[data-open="true"] { background: var(--pmem-active); }
.${cls('count')} {
  min-width: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--pmem-active); font-size: 10px; text-align: center;
}
/* The panel is dressed as an official popover: same surface fill, same blur,
   same border token, same radius scale and item metrics as the app's own menus.
   Official values are written as fallbacks because a classic script cannot read
   the theme layer. */
.${cls('panel')} {
  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 10000;
  width: 380px; max-height: 60vh; overflow: auto;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l3, var(--pmem-border));
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-menu-surface-fill, var(--pmem-bg));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  box-shadow: 0 6px 24px rgba(0,0,0,.12);
  color: var(--pmem-fg);
  font-size: 13px; text-align: left;
}
/* Theme variables belong on the WRAPPER, not the panel. The button is the
   panel's sibling, so declaring them on the panel left every var() in the
   button unresolved — and an unresolved var() invalidates the whole
   declaration. That is why the hover fill never appeared: not a missing rule,
   a dead one. Values are the app's own tokens, with the official resolved
   values as fallbacks because a classic script cannot read the theme layer. */
.${cls('wrap')}[data-theme="light"] {
  --pmem-fg: var(--dsw-alias-label-primary, #0f1115);
  --pmem-hover: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06));
  --pmem-active: var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.10));
  --pmem-bg: rgba(248,249,250,.92); --pmem-border: rgba(0,0,0,.12);
  --pmem-muted: rgba(31,32,36,.62);
}
.${cls('wrap')}[data-theme="dark"] {
  --pmem-fg: var(--dsw-alias-label-primary, #f9fafb);
  --pmem-hover: var(--dsw-alias-interactive-bg-hover, rgba(236,238,242,.08));
  --pmem-active: var(--dsw-alias-interactive-bg-active, rgba(236,238,242,.14));
  --pmem-bg: rgba(31,32,36,.92); --pmem-border: rgba(236,238,242,.16);
  --pmem-muted: rgba(236,238,242,.62);
}
.${cls('head')} {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; padding: 6px 8px;
}
.${cls('title')} { font-weight: 600; }
.${cls('meta')} { color: var(--pmem-muted); font-size: 11px; }
.${cls('empty')} { color: var(--pmem-muted); padding: 10px 8px; }
.${cls('error')} { color: #c0392b; padding: 8px; white-space: pre-wrap; }
/* Same metrics as an official menu item. */
.${cls('row')} {
  display: block; width: 100%; text-align: left; cursor: pointer;
  border: 0; background: transparent; color: var(--pmem-fg);
  padding: 6px 8px; border-radius: var(--dsw-radius-md, 8px);
  font-size: 13px;
}
.${cls('row')}:hover { background: var(--pmem-hover); }
.${cls('rowTitle')} { display: block; }
.${cls('rowMeta')} { display: block; color: var(--pmem-muted); font-size: 11px; margin-top: 2px; }
.${cls('badge')} {
  display: inline-block; padding: 0 4px; margin-right: 4px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--pmem-active); font-size: 10px;
}
.${cls('detail')} {
  margin-top: 4px; padding: 8px; border-top: 1px solid var(--pmem-border);
}
.${cls('body')} {
  white-space: pre-wrap; word-break: break-word; margin: 6px 0 8px;
  max-height: 220px; overflow: auto;
}
.${cls('danger')} {
  border: 1px solid rgba(200,60,60,.55); background: transparent; color: #c0392b;
  border-radius: var(--dsw-radius-sm, 6px); padding: 3px 8px; cursor: pointer; font-size: 11px;
}
.${cls('danger')}:disabled { opacity: .5; cursor: default; }
.${cls('back')} {
  border: 0; background: transparent; color: var(--pmem-muted); cursor: pointer;
  font-size: 11px; padding: 0;
}
`

    /**
     * Decide which of the two palettes to paint the panel with.
     *
     * The host theme is read from the document rather than assumed: DSH does not
     * publish its colour tokens, so matching on a theme attribute or on the
     * measured page background is the only honest way to stay legible in both.
     */
    function detectTheme() {
      if (typeof document === 'undefined') return 'light'
      const root = document.documentElement
      const declared = `${root.getAttribute('data-theme') ?? ''} ${root.className ?? ''} ${document.body?.getAttribute('data-theme') ?? ''} ${document.body?.className ?? ''}`
      if (/dark/i.test(declared)) return 'dark'
      if (/light/i.test(declared)) return 'light'
      const background = getComputedStyle(document.body ?? root).backgroundColor
      const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(background)
      if (parts !== null) {
        const [r, g, b] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
        return (r + g + b) / 3 < 128 ? 'dark' : 'light'
      }
      return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true ? 'dark' : 'light'
    }


    let stylesInjected = false
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-plugin', 'dsh-project-memory')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* --------------------------------------------------------------- data -- */

    async function getJson(path, params) {
      const query = params === undefined ? '' : `?${new URLSearchParams(params).toString()}`
      const response = await fetch(`${path}${query}`, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.message ?? `${path} failed with ${response.status}`)
      return payload
    }

    async function postJson(path, params) {
      const query = new URLSearchParams(params).toString()
      const response = await fetch(`${path}?${query}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.message ?? `${path} failed with ${response.status}`)
      return payload
    }

    /* ---------------------------------------------------------- components -- */

    /**
     * Input-toolbar button plus its drop-up panel.
     * @param props - slot injection face, carrying the owning session id.
     */
    function MemoryButton(props) {
      // `sessionId` may be a reserved prop of the slot framework, in which case
      // injecting under that same name gets clobbered and arrives undefined —
      // which is how this panel first asked the host about the wrong repository.
      // Read the namespaced copy first and keep the plain name as a fallback.
      const sessionId = props?.memorySessionId ?? props?.sessionId
      const [open, setOpen] = react.useState(false)
      const [list, setList] = react.useState(null)
      const [detail, setDetail] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)

      react.useEffect(() => {
        injectStyles()
      }, [])

      // Dismiss like every other popover in the app: a press outside the widget,
      // or Escape, closes it. Listened on the capture phase so a press that the
      // page would otherwise swallow still counts, and removed on close so a
      // closed panel never keeps intercepting input.
      const wrapRef = react.useRef(null)
      react.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const node = wrapRef.current
          if (node !== null && !node.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const load = react.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          setList(await getJson(LIST_PATH, sessionId ? { sessionId } : undefined))
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          setList(null)
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      // Refetch on every open so the panel never shows a stale index.
      react.useEffect(() => {
        if (!open) return
        setDetail(null)
        load()
      }, [open, load])

      const openEntry = react.useCallback(async (id) => {
        setBusy(true)
        setError(null)
        try {
          const payload = await getJson(ENTRY_PATH, { id, ...(sessionId ? { sessionId } : {}) })
          setDetail(payload.memory)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      const forget = react.useCallback(async (id) => {
        setBusy(true)
        setError(null)
        try {
          await postJson(FORGET_PATH, {
            id,
            reason: 'archived from the memory panel',
            ...(sessionId ? { sessionId } : {}),
          })
          setDetail(null)
          await load()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }, [sessionId, load])

      const memories = list?.memories ?? []
      const button = h(
        'button',
        {
          type: 'button',
          className: cls('button'),
          'data-open': String(open),
          title: '项目记忆：浏览本仓库已保存的记忆',
          onClick: () => setOpen((value) => !value),
        },
        '记忆',
        list !== null ? h('span', { className: cls('count') }, String(memories.length)) : null,
      )

      if (!open) {
        return h('span', { className: cls('wrap'), 'data-theme': detectTheme(), ref: wrapRef }, button)
      }

      const head = h(
        'div',
        { className: cls('head') },
        h('span', { className: cls('title') }, detail === null ? '项目记忆' : detail.id),
        h(
          'span',
          { className: cls('meta') },
          detail === null
            ? (list === null
                ? ''
                : `${memories.length} 条 · ${String(list.projectKey ?? '').slice(0, 8)}${sessionId ? '' : ' · 无会话'}`)
            : h('button', { type: 'button', className: cls('back'), onClick: () => setDetail(null) }, '← 返回列表'),
        ),
      )

      let body
      if (error !== null) {
        body = h('div', { className: cls('error') }, error)
      } else if (detail !== null) {
        body = h(
          'div',
          { className: cls('detail') },
          h(
            'div',
            { className: cls('meta') },
            `${KIND_LABEL[detail.kind] ?? detail.kind}`,
            detail.scope ? ` · scope ${detail.scope}` : ' · 全局',
            detail.tags?.length ? ` · ${detail.tags.join(' ')}` : '',
          ),
          h('div', { className: cls('body') }, detail.body),
          h(
            'button',
            {
              type: 'button',
              className: cls('danger'),
              disabled: busy,
              onClick: () => forget(detail.id),
            },
            busy ? '处理中…' : '归档这条记忆',
          ),
        )
      } else if (list === null) {
        body = h('div', { className: cls('empty') }, busy ? '加载中…' : '暂无数据')
      } else if (memories.length === 0) {
        body = h(
          'div',
          { className: cls('empty') },
          '这个仓库还没有记忆。让 agent 记住一件事，或直接对它说「记住…」。',
        )
      } else {
        body = memories.map((memory) => h(
          'button',
          {
            key: memory.id,
            type: 'button',
            className: cls('row'),
            onClick: () => openEntry(memory.id),
          },
          h('span', { className: cls('rowTitle') }, memory.title),
          h(
            'span',
            { className: cls('rowMeta') },
            h('span', { className: cls('badge') }, KIND_LABEL[memory.kind] ?? memory.kind),
            memory.id,
            memory.scope ? ` · ${memory.scope}` : '',
            memory.modified ? ` · ${String(memory.modified).slice(0, 10)}` : '',
          ),
        ))
      }

      return h(
        'span',
        { className: cls('wrap'), 'data-theme': detectTheme(), ref: wrapRef },
        button,
        h(
          'div',
          {
            className: cls('panel'),
            role: 'dialog',
            'aria-label': '项目记忆',
          },
          head,
          body,
        ),
      )
    }

    /* ---------------------------------------------------------- lifecycle -- */

    /**
     * 客户端插件体：把「记忆」按钮挂到输入框右侧。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      console.log('[project-memory] 记忆浏览面板客户端半边已就绪')
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: 'project-memory-browser',
          order: 20,
          inject: (sessionId) => ({ memorySessionId: sessionId }),
        },
        MemoryButton,
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
