/**
 * Session remover — Client half.
 *
 * Adds one structured action to the sidebar's Session menu through the same
 * `ctx.contextMenus` capability the built-in actions use, so ordering, danger
 * styling, keyboard handling, and focus return stay the host's. The action
 * never writes anything itself: it opens a confirmation dialog and posts the
 * captured Session id to the Host's exact `/api` route, which owns the
 * deletion and answers with what happened.
 */

window.__ModuleLoader__.load({
  id: '@local/session-remover',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this plugin's own strings. */
    const NS = 'sessionRemover'

    /** Browser-relative form of the Host route (`document.baseURI` is the mount). */
    const DELETE_ROUTE = 'api/session-remover/delete'

    /** Menu position: after the built-in Archive action (600), which renders last today. */
    const MENU_ORDER = 700

    /** Key of this plugin's glyph in the shared `contextMenu.icon` seat. */
    const DELETE_ICON_KEY = 'sessionRemover.delete'

    /** How long the delete request may stay unanswered before the dialog recovers. */
    const REQUEST_TIMEOUT_MS = 20000

    const dictionaries = {
      en: {
        'menu.delete': 'Delete permanently…',
        'confirm.title': 'Delete this session permanently?',
        'confirm.desc': 'This deletes “{title}” from this computer: its stored messages, any subagent sessions it started, and its sidebar, archive, and pin entries. Attachment files it referenced are kept. This cannot be undone — archive the session instead to hide it reversibly.',
        'confirm.untitled': 'Untitled session',
        'confirm.cancel': 'Cancel',
        'confirm.close': 'Close',
        'confirm.action': 'Delete permanently',
        'confirm.busy': 'Deleting…',
        'notice.deleted': 'Deleted “{title}”',
        'notice.alreadyGone': '“{title}” was already gone',
        'notice.deferred': '“{title}” will be deleted the next time DeepSeek Harness starts',
        'live.title': 'This session is still in use',
        'live.desc': 'DeepSeek Harness has “{title}” loaded in the running app, so its data cannot be removed yet. It can be hidden now and deleted the next time the app starts; unarchiving it before then cancels that.',
        'live.action': 'Hide now, delete at next start',
        'error.failed': 'The session could not be deleted. Try again.',
        'error.storage': 'The session store did not answer in time. Try again.',
        'error.partial': 'The session was removed from its workspace, but some stored data could not be deleted:',
      },
      zh: {
        'menu.delete': '永久删除…',
        'confirm.title': '要永久删除此会话吗？',
        'confirm.desc': '这会从这台电脑上删除“{title}”的本地记录、它启动的子智能体会话，以及它在侧栏、归档和置顶中的记录；它引用过的附件文件会保留。此操作无法恢复——只想隐藏会话时请改用归档。',
        'confirm.untitled': '未命名会话',
        'confirm.cancel': '取消',
        'confirm.close': '关闭',
        'confirm.action': '永久删除',
        'confirm.busy': '正在删除…',
        'notice.deleted': '已删除“{title}”',
        'notice.alreadyGone': '“{title}”已不存在',
        'notice.deferred': '“{title}”将在下次启动 DeepSeek Harness 时删除',
        'live.title': '此会话仍在使用中',
        'live.desc': 'DeepSeek Harness 已在运行中加载了“{title}”，因此暂时无法删除它的数据。可以先隐藏该会话，并在下次启动应用时删除；在此之前取消归档即可撤销。',
        'live.action': '先隐藏，下次启动时删除',
        'error.failed': '无法删除该会话，请重试。',
        'error.storage': '会话存储未能及时响应，请重试。',
        'error.partial': '已把该会话从工作区中移除，但部分存储数据未能删除：',
      },
    }

    /**
     * Dialog geometry copied from the host's own Modal/Button rules, so the
     * surface reads as the same dialog family. Colors come only from
     * `--dsw-alias-*` theme tokens, each with a literal fallback so a renamed
     * token degrades rather than breaks.
     */
    const STYLES = `
.dsh-session-remover__stage{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top, 24px)) 24px}
.dsh-session-remover__mask{position:absolute;inset:var(--dsh-frame-chrome-top, 0px) 0 0;background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.4));backdrop-filter:var(--dsw-mask-blur, blur(2px))}
.dsh-session-remover__dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel, 12px);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay));box-shadow:var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,.32));color:var(--dsw-alias-label-primary);font:inherit}
.dsh-session-remover__dialog:focus{outline:none}
.dsh-session-remover__mask,.dsh-session-remover__dialog{animation:dsh-session-remover-enter var(--ds-transition-duration, .14s) var(--ds-ease-in-out, ease-out)}
@keyframes dsh-session-remover-enter{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsh-session-remover__mask,.dsh-session-remover__dialog{animation:none}}
.dsh-session-remover__content{display:flex;flex-direction:column;width:100%}
.dsh-session-remover__header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dsh-session-remover__title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-session-remover__close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm, 6px);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.dsh-session-remover__close:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dsh-session-remover__description,.dsh-session-remover__status,.dsh-session-remover__error{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400}
.dsh-session-remover__description{color:var(--dsw-alias-label-primary)}
.dsh-session-remover__status{margin-top:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-session-remover__error{margin-top:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.dsh-session-remover__footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dsh-session-remover__button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md, 8px);background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-session-remover__button:disabled{cursor:not-allowed;opacity:.4}
.dsh-session-remover__button--outline{box-shadow:inset 0 0 0 max(var(--dsh-hairline-width, .5px), .5px) var(--dsw-alias-border-l3, var(--dsw-alias-border-l2))}
.dsh-session-remover__button--danger{color:var(--dsw-alias-state-error-primary)}
@media (hover:hover){
  .dsh-session-remover__button--outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
  .dsh-session-remover__button--danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
}
`

    /**
     * The menu row's glyph: a 14 px outline trash can in the host's stroke
     * style, inheriting the item's icon color (and therefore its danger color).
     * @returns the glyph element.
     */
    function DeleteGlyph() {
      return h('svg', {
        viewBox: '0 0 14 14',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M5.1 2.4h3.8' }),
      h('path', { d: 'M2.5 4.2h9' }),
      h('path', { d: 'M3.9 4.7h6.2l-.7 6.7a1.2 1.2 0 0 1-1.2 1.1H5.8a1.2 1.2 0 0 1-1.2-1.1z' }),
      h('path', { d: 'M6 6.9v3.2M8 6.9v3.2' }))
    }

    /**
     * Post one deletion to the Host. The served page uses the same-origin
     * cookie the connection already minted; a shell that owns its Host in
     * another execution context installs `__DSH_TRANSPORT__.fetch`.
     * @param sessionIds - Session ids to delete permanently.
     * @param defer - hide a loaded Session now and delete it on the next start.
     * @returns the Host's operation report.
     * @throws {Error} with a `code` when the Host refused, or a transport failure.
     */
    async function requestDeletion(sessionIds, defer = false) {
      const url = new URL(DELETE_ROUTE, document.baseURI)
      const transport = globalThis.__DSH_TRANSPORT__
      const carry = transport === undefined || typeof transport.fetch !== 'function' ? undefined : transport.fetch
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(defer ? { sessionIds, defer: true } : { sessionIds }),
        signal: controller.signal,
      }
      let response
      try {
        response = carry === undefined ? await fetch(url.href, init) : await carry(url.href, init)
      } catch (failure) {
        const error = new Error(controller.signal.aborted ? 'the delete request timed out' : 'the delete request failed')
        error.code = controller.signal.aborted ? 'timeout' : 'transport'
        error.cause = failure
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        const error = new Error(`the Host refused the request (HTTP ${response.status})`)
        error.code = 'transport'
        throw error
      }
      let payload
      try {
        payload = await response.json()
      } catch (failure) {
        const error = new Error('the Host answered without a readable result')
        error.code = 'transport'
        error.cause = failure
        throw error
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
        const error = new Error(failure !== undefined && typeof failure.message === 'string'
          ? failure.message
          : 'the Host could not delete the session')
        if (failure !== undefined && typeof failure.code === 'string') error.code = failure.code
        throw error
      }
      return payload.value
    }

    /**
     * Pull the Client's Session list again so the deleted Session's summary
     * leaves the sidebar tree — the workspace tree renders a row only while the
     * list holds that Session. Best effort: the Host already deleted it, so a
     * failed pull only postpones the row's removal.
     * @param ctx - Client plugin context.
     */
    async function refreshSessionList(ctx) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.refresh !== 'function') return
      try {
        await sessions.refresh()
      } catch (failure) {
        console.warn('session-remover: session list refresh failed', failure)
      }
    }

    /**
     * Normalize the Host's operation report so a malformed field never breaks
     * the outcome handling.
     * @param value - the Host's report.
     * @returns the three id/failure lists.
     */
    function readReport(value) {
      const list = (field) => (value !== null && typeof value === 'object' && Array.isArray(value[field])
        ? value[field].filter((entry) => typeof entry === 'string')
        : [])
      return { deleted: list('deleted'), deferred: list('deferred'), problems: list('problems') }
    }

    return {
      inject: ['contextMenus', 'locale', 'slots'],

      /** @param ctx - Client plugin context. */
      apply(ctx) {
        const t = ctx.locale.bind(NS)

        // One pending confirmation at a time; the dialog reads it through a
        // subscription so the entry stays mounted while closed.
        let pending = null
        const subscribers = new Set()
        const publish = () => {
          for (const notify of [...subscribers]) notify()
        }
        const requestConfirmation = (target) => {
          pending = { sessionId: target.sessionId, displayTitle: target.displayTitle }
          publish()
        }
        const settleConfirmation = () => {
          pending = null
          publish()
        }
        const usePendingConfirmation = () => {
          const [, forceRender] = React.useState(0)
          React.useEffect(() => {
            const notify = () => { forceRender((count) => count + 1) }
            subscribers.add(notify)
            return () => { subscribers.delete(notify) }
          }, [])
          return pending
        }

        /**
         * The `shell.overlay` entry: nothing while no confirmation is pending,
         * otherwise the dialog for that Session.
         * @returns the dialog element, or null.
         */
        function DeleteConfirmationEntry() {
          const request = usePendingConfirmation()
          if (request === null) return null
          return h(DeleteConfirmation, { key: request.sessionId, request })
        }

        /**
         * One request's dialog; its busy, error, and partial-outcome state die
         * with the request.
         * @param props.request - the captured Session row.
         * @returns the modal.
         */
        function DeleteConfirmation({ request }) {
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [blocked, setBlocked] = React.useState(false)
          const cancelRef = React.useRef(null)
          const dialogRef = React.useRef(null)
          const restoreRef = React.useRef(null)
          const busyRef = React.useRef(false)
          const setWorking = (value) => {
            busyRef.current = value
            setBusy(value)
          }

          // Focus returns to whatever opened the dialog — the row's "…" button —
          // or to the session tree when the deleted row itself is gone.
          React.useEffect(() => {
            const active = document.activeElement
            restoreRef.current = active instanceof HTMLElement ? active : null
            return () => {
              const stored = restoreRef.current
              restoreRef.current = null
              const target = stored !== null && stored.isConnected
                ? stored
                : document.querySelector('[role="tree"] [role="treeitem"], [role="treeitem"]')
              if (target !== null && typeof target.focus === 'function') {
                try {
                  target.focus()
                } catch {
                  // A detached or inert target leaves focus where the browser put it.
                }
              }
            }
          }, [])

          // The safe choice owns the initial focus, and focus stays in the
          // dialog while it is open — including while both buttons are
          // disabled and only the dialog itself can hold it.
          React.useEffect(() => {
            const target = busy ? dialogRef.current : cancelRef.current
            if (target !== null && target !== undefined) target.focus()
          }, [busy])
          React.useEffect(() => {
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopImmediatePropagation()
                if (!busyRef.current) settleConfirmation()
                return
              }
              if (event.key !== 'Tab') return
              const dialog = dialogRef.current
              if (dialog === null) return
              const focusable = [...dialog.querySelectorAll('button:not(:disabled)')]
              if (focusable.length === 0) {
                event.preventDefault()
                dialog.focus()
                return
              }
              const first = focusable[0]
              const last = focusable[focusable.length - 1]
              const active = document.activeElement
              const outside = !dialog.contains(active)
              if (event.shiftKey && (active === first || outside)) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && (active === last || outside)) {
                event.preventDefault()
                first.focus()
              }
            }
            window.addEventListener('keydown', onKeyDown, true)
            return () => { window.removeEventListener('keydown', onKeyDown, true) }
          }, [])

          const close = () => {
            if (busyRef.current) return
            settleConfirmation()
          }
          const fail = (failure) => {
            setWorking(false)
            const code = failure !== null && typeof failure === 'object' ? failure.code : undefined
            if (code === 'session-live') {
              // The Host holds a live Agent for this Session, so its log cannot
              // be pulled away yet. Offer the one path that does work instead of
              // a dead end.
              setBlocked(true)
              setError(null)
              return
            }
            if (code === 'timeout') setError(t('error.storage'))
            else {
              setError(t('error.failed'))
              // The transport or Host detail stays available to a developer without
              // putting untranslated internals in the dialog.
              console.error('session-remover: session delete failed', failure)
            }
          }
          const settleWithNotice = async (title, deletedCount, deferredCount) => {
            // The sidebar's session list is a Client-side pull model: the Host
            // answers a fresh list from persistence, and only then does the row
            // leave the tree. Without this pull the changed Session survives as
            // a stale summary until the page reloads.
            await refreshSessionList(ctx)
            settleConfirmation()
            if (deferredCount > 0) {
              ctx.contextMenus.notify(t('notice.deferred', { title }), true)
              return
            }
            ctx.contextMenus.notify(
              deletedCount === 0 ? t('notice.alreadyGone', { title }) : t('notice.deleted', { title }),
              true,
            )
          }
          const confirm = async () => {
            if (busyRef.current) return
            setWorking(true)
            setError(null)
            let value
            try {
              if (blocked) {
                // Archive through the built-in Client command first: its reply
                // carries the complete archive set, so the row hides right away
                // instead of depending on how the Host change reaches the page.
                // The Host's own archive step then finds it already archived.
                const workspaces = ctx.get('workspaces')
                if (workspaces !== undefined && typeof workspaces.archiveSession === 'function') {
                  try {
                    await workspaces.archiveSession(request.sessionId, { stopActivity: true })
                  } catch (failure) {
                    console.warn('session-remover: archiving the session before deferring failed', failure)
                  }
                }
              }
              value = await requestDeletion([request.sessionId], blocked)
            } catch (failure) {
              fail(failure)
              return
            }
            const report = readReport(value)
            if (report.problems.length > 0) {
              // Part of the data survived (a busy file on Windows, a failed
              // bookkeeping write): never report a clean deletion here.
              setWorking(false)
              setError(`${t('error.partial')} ${report.problems.join(' ')}`)
              return
            }
            await settleWithNotice(titleOf(request), report.deleted.length, report.deferred.length)
          }

          return h('div', { className: 'dsh-session-remover__stage' },
            h('div', { className: 'dsh-session-remover__mask', onMouseDown: close }),
            h('style', null, STYLES),
            h('div', {
              ref: dialogRef,
              tabIndex: -1,
              className: 'dsh-session-remover__dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'dsh-session-remover-title',
              'aria-describedby': 'dsh-session-remover-description',
            },
            h('div', { className: 'dsh-session-remover__content' },
              h('div', { className: 'dsh-session-remover__header' },
                h('h2', { id: 'dsh-session-remover-title', className: 'dsh-session-remover__title' },
                  t(blocked ? 'live.title' : 'confirm.title')),
                h('button', {
                  type: 'button',
                  className: 'dsh-session-remover__close',
                  'aria-label': t('confirm.close'),
                  disabled: busy,
                  onClick: close,
                }, h('svg', {
                  viewBox: '0 0 14 14',
                  width: 14,
                  height: 14,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.3,
                  strokeLinecap: 'round',
                  'aria-hidden': true,
                }, h('path', { d: 'M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2' })))),
              h('p', { id: 'dsh-session-remover-description', className: 'dsh-session-remover__description' },
                blocked ? t('live.desc', { title: titleOf(request) }) : t('confirm.desc', { title: titleOf(request) })),
              busy ? h('p', { className: 'dsh-session-remover__status', role: 'status' }, t('confirm.busy')) : null,
              error === null ? null : h('p', { className: 'dsh-session-remover__error', role: 'alert' }, error)),
            h('div', { className: 'dsh-session-remover__footer' },
              h('button', {
                ref: cancelRef,
                type: 'button',
                className: 'dsh-session-remover__button dsh-session-remover__button--outline',
                disabled: busy,
                onClick: close,
              }, t('confirm.cancel')),
              h('button', {
                type: 'button',
                className: 'dsh-session-remover__button dsh-session-remover__button--danger',
                disabled: busy,
                onClick: () => { void confirm() },
              }, t(blocked ? 'live.action' : 'confirm.action')))),
          )
        }

        /**
         * @param request - the captured Session row.
         * @returns its display title, or a localized placeholder for an untitled row.
         */
        function titleOf(request) {
          const title = request.displayTitle
          return typeof title === 'string' && title.trim() !== '' ? title : t('confirm.untitled')
        }

        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'session-remover: dictionaries')

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: DELETE_ICON_KEY,
        }, DeleteGlyph))

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-remover.delete',
          target: 'session',
          order: MENU_ORDER,
          resolve: (target) => [{
            id: 'delete',
            label: t('menu.delete'),
            icon: { key: DELETE_ICON_KEY },
            danger: true,
            separatorBefore: true,
            afterContent: true,
            run: () => { requestConfirmation(target) },
          }],
        }), 'session-remover: Session menu action')

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-remover-delete-confirmation',
        }, DeleteConfirmationEntry))
      },
    }
  },
})
