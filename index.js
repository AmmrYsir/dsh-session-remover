/**
 * Session remover — Host half.
 *
 * Owns the one destructive operation this bundle adds: deleting a stored
 * Session permanently instead of archiving it. Two callers reach the same
 * function: the browser's Session menu (through an exact `/api` Fetch route)
 * and the agent (through the `session_delete` Tool).
 *
 * Deletion order keeps a failure recoverable and never leaves the sidebar
 * pointing at a log that is already gone:
 *   1. validate ids and resolve the requested Sessions plus their subagent
 *      descendant Sessions from Session persistence;
 *   2. refuse anything live in this process, because an open Agent still owns
 *      its log;
 *   3. remove the session-owned log directories and the projection-cache
 *      records;
 *   4. drop the ids from Workspace accounting, the archive set, and the pin
 *      set, which is what makes the row disappear from the sidebar live
 *      (the workspace controller forwards `domain/changed` frames).
 *
 * Only Node built-ins are imported: a locally installed bundle resolves no
 * Harness package from the profile.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Exact shared-API route the browser half posts to. */
const DELETE_ROUTE = '/api/session-remover/delete'

/** Largest batch one request or Tool call may delete. */
const MAX_IDS = 200

/** Session ids become directory names, so only a plain path segment is accepted. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Filesystem failures that a Windows share usually clears on a later attempt. */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** A session-log root's per-project directory, which is removed once it is empty. */
const PROJECT_DIRECTORY_PATTERN = /^(--.+--|_no-cwd_)$/

/** Deferred deletions recorded for the next start, inside the Harness data root. */
const PENDING_FILE = path.join(dshHomeDirectory(), 'session-remover', 'pending.json')

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Failure with a stable code the browser and the Tool can report verbatim. */
class SessionRemoverError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - operator- and model-facing explanation.
   * @param details - optional structured detail for the route answer.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'SessionRemoverError'
    this.code = code
    this.details = details
  }
}

/**
 * Resolve the Harness data root the same way the shipped packages do: an
 * explicit `DSH_HOME`, else `~/.dsh`. Only used to reach the projection cache
 * when its domain is not open in this process.
 * @returns the absolute data root.
 */
function dshHomeDirectory() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured)
  return path.join(os.homedir(), '.dsh')
}

/**
 * @param value - candidate Session id from the wire, the Tool, or a caller.
 * @returns the same id once it is safe to use as one directory-name segment.
 * @throws {SessionRemoverError} `invalid-id` for anything else.
 */
function assertSessionId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new SessionRemoverError('invalid-id', `not a usable Session id: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Remove one file-tree with a bounded retry for the transient Windows failures
 * an open directory handle causes. `force` makes a missing target a success.
 * @param target - absolute file or directory to remove.
 * @returns when the target is absent.
 */
async function removePath(target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (attempt >= 4 || !RETRYABLE_CODES.has(code)) throw error
      await delay(60 * (attempt + 1))
    }
  }
}

/**
 * A session-owned directory is only ever removed when its own name is the
 * Session id and it sits below a project directory — the persistence layout
 * (`<root>/<project>/<session-id>/<file>`) — so a surprising `location` can
 * never widen the deletion target.
 * @param directory - directory holding the Session log.
 * @param sessionId - Session the log belongs to.
 * @returns whether removing `directory` stays inside one Session.
 */
function isSessionOwnedDirectory(directory, sessionId) {
  const parent = path.dirname(directory)
  return path.basename(directory) === sessionId
    && parent !== directory
    && PROJECT_DIRECTORY_PATTERN.test(path.basename(parent))
}

/**
 * Drop a per-project directory once its last Session left. A directory that is
 * still used — or has a name this layout does not own — is left untouched.
 * @param directory - candidate project directory.
 */
async function removeEmptyProjectDirectory(directory) {
  if (!PROJECT_DIRECTORY_PATTERN.test(path.basename(directory))) return
  try {
    await fs.rmdir(directory)
  } catch {
    // Still populated or already gone: either way nothing is left to do.
  }
}

/**
 * Collect the requested Sessions and their subagent descendants. A child
 * Session belongs to its parent for as long as both exist, and deleting the
 * parent alone would strand it in the sidebar.
 * @param snapshots - every stored Session snapshot.
 * @param requested - ids the caller named.
 * @returns every id to delete, requested ids first.
 */
function expandTargets(snapshots, requested) {
  const targets = new Set()
  const queue = [...requested]
  while (queue.length > 0) {
    const id = queue.shift()
    if (targets.has(id)) continue
    targets.add(id)
    for (const snapshot of snapshots) {
      const header = snapshot.header
      if (header.origin === 'subagent' && header.parentSession !== undefined
        && String(header.parentSession) === id) {
        queue.push(String(header.id))
      }
    }
  }
  return targets
}

/**
 * Drop one deleted id from Workspace accounting and from the registry-global
 * archive and pin sets. Every step is independent so one failed bookkeeping
 * write is reported without undoing the others.
 * @param ctx - activation context of the plugin.
 * @param sessionId - deleted Session.
 * @param problems - failure messages appended to the operation report.
 */
async function forgetSession(ctx, sessionId, problems) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch (error) {
      problems.push(`could not read the Workspace registry: ${messageOf(error)}`)
    }
    for (const workspace of workspaces) {
      try {
        if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
      } catch (error) {
        problems.push(`could not detach the Session from Workspace '${workspace.title}': ${messageOf(error)}`)
      }
    }
    try {
      if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId)
      if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId)
    } catch (error) {
      problems.push(`could not clear the Session's archive or pin entry: ${messageOf(error)}`)
    }
  }

  const domainFacility = ctx.get('storageDomain')
  const cache = domainFacility === undefined ? undefined : domainFacility.get('session_projcache')
  try {
    if (cache !== undefined) {
      await cache.table('sessions').delete(sessionId)
    } else {
      await fs.rm(
        path.join(dshHomeDirectory(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`),
        { force: true },
      )
    }
  } catch (error) {
    problems.push(`could not drop the projection cache entry: ${messageOf(error)}`)
  }
}

/** @param error - any rejected value. @returns its message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Delete Sessions permanently: their stored logs, their subagent descendant
 * Sessions, their projection-cache entries, and every sidebar/archive/pin
 * reference. Ids that no longer exist are still forgotten, so a row whose log
 * is already gone can be cleaned up.
 * @param ctx - activation context of the plugin.
 * @param rawIds - ids from the wire or the Tool, not yet validated.
 * @param options - `defer` hides a loaded batch now and deletes it on the next start.
 * @returns what was deleted, what was already absent, and what was deferred.
 * @throws {SessionRemoverError} `invalid-request`, `invalid-id`, or `session-live`.
 */
async function deleteSessions(ctx, rawIds, options = {}) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new SessionRemoverError('invalid-request', 'sessionIds must be a non-empty array of Session ids')
  }
  if (rawIds.length > MAX_IDS) {
    throw new SessionRemoverError('invalid-request', `one call deletes at most ${MAX_IDS} Sessions`)
  }
  const requested = [...new Set(rawIds.map(assertSessionId))]

  const snapshots = await ctx.sessionPersistence.list()
  const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]))
  const targets = expandTargets(snapshots, requested)

  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const live = [...targets].filter((id) => agents?.get(id) !== undefined || sessions?.get(id) !== undefined)
  if (live.length > 0) {
    // A loaded Session still owns its log: the Agent keeps the write handle and
    // the in-memory event log, so pulling the file out from under it would let a
    // later flush or turn recreate it. Deferring moves the whole batch to the
    // next start, when nothing is loaded.
    if (options.defer !== true) {
      throw new SessionRemoverError(
        'session-live',
        `session loaded in the running app: ${live.join(', ')}. `
        + 'Restart DeepSeek Harness to delete it, or defer the deletion to the next start.',
        { live },
      )
    }
    return await deferSessions(ctx, requested, [...targets])
  }

  const deleted = []
  const absent = []
  const problems = []
  for (const id of targets) {
    const snapshot = byId.get(id)
    const location = snapshot === undefined ? undefined : snapshot.location
    const logPath = location === undefined ? undefined : location.path
    if (typeof logPath !== 'string') {
      absent.push(id)
      continue
    }
    const directory = path.dirname(logPath)
    if (!isSessionOwnedDirectory(directory, id)) {
      problems.push(`refused to remove an unexpected path for '${id}': ${directory}`)
      continue
    }
    try {
      await removePath(directory)
      deleted.push(id)
    } catch (error) {
      problems.push(`could not remove the log of '${id}': ${messageOf(error)}`)
      continue
    }
    await removeEmptyProjectDirectory(path.dirname(directory))
  }

  for (const id of targets) await forgetSession(ctx, id, problems)

  return {
    requested,
    deleted,
    absent,
    deferred: [],
    problems,
  }
}

/**
 * Hide Sessions now and delete them on the next start, when no Agent holds
 * them. The archive entry is the reversible "hidden" state the sidebar already
 * understands; unarchiving before the restart cancels the pending deletion.
 * @param ctx - activation context of the plugin.
 * @param requested - validated ids the caller named.
 * @param targets - those ids plus their subagent descendants.
 * @returns the operation report naming what was deferred.
 * @throws {SessionRemoverError} when the archive write itself fails.
 */
async function deferSessions(ctx, requested, targets) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    throw new SessionRemoverError('defer-unsupported', 'this profile has no Workspace registry to hide the Session in')
  }
  const problems = []
  const deferred = []
  for (const id of targets) {
    try {
      // stopActivity: the caller already confirmed deletion, so stopping the
      // Session's running work is the expected half of the operation.
      await registry.archiveSession(id, { stopActivity: true })
      deferred.push(id)
    } catch (error) {
      problems.push(`could not hide '${id}' until the next start: ${messageOf(error)}`)
    }
  }
  if (deferred.length > 0) await addPending(deferred)
  return {
    requested,
    deleted: [],
    absent: [],
    deferred,
    problems,
  }
}

/**
 * Read the ids a previous run asked to delete on the next start.
 * @returns the recorded Session ids, empty when none or unreadable.
 */
async function readPending() {
  let raw
  try {
    raw = await fs.readFile(PENDING_FILE, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.sessionIds)) return []
    return parsed.sessionIds.filter((id) => typeof id === 'string' && ID_PATTERN.test(id))
  } catch {
    return []
  }
}

/**
 * Replace the pending set durably (write, then rename over the live file).
 * @param sessionIds - every id still waiting for the next start.
 */
async function writePending(sessionIds) {
  if (sessionIds.length === 0) {
    await fs.rm(PENDING_FILE, { force: true })
    return
  }
  await fs.mkdir(path.dirname(PENDING_FILE), { recursive: true })
  const temporary = `${PENDING_FILE}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify({ version: 1, sessionIds }, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, PENDING_FILE)
}

/**
 * @param sessionIds - ids to record for the next start.
 */
async function addPending(sessionIds) {
  const current = await readPending()
  await writePending([...new Set([...current, ...sessionIds])])
}

/**
 * @param sessionIds - ids to stop waiting for.
 */
async function dropPending(sessionIds) {
  const current = await readPending()
  const next = current.filter((id) => !sessionIds.includes(id))
  if (next.length !== current.length) await writePending(next)
}

/**
 * Delete every Session a previous run deferred, before any Agent can resume
 * one. A Session that is still loaded (a client raced the boot) or that failed
 * to delete stays pending for the next start.
 * @param ctx - activation context of the plugin.
 */
async function processPendingDeletions(ctx) {
  const pending = await readPending()
  if (pending.length === 0) return
  const remaining = []
  const deleted = []
  const problems = []
  for (const id of pending) {
    try {
      const value = await deleteSessions(ctx, [id], { defer: false })
      deleted.push(...value.deleted, ...value.absent)
      problems.push(...value.problems)
    } catch {
      remaining.push(id)
    }
  }
  await writePending(remaining)
  if (deleted.length > 0) {
    ctx.logger.info(`session-remover: deleted ${deleted.length} deferred Session(s): ${deleted.join(', ')}`)
  }
  if (problems.length > 0) {
    ctx.logger.warn(`session-remover: deferred deletion reported problems: ${problems.join('; ')}`)
  }
}

/**
 * Drop ids from the pending set once they leave the archive set: unarchiving a
 * Session is how a user cancels a deferred deletion before the restart.
 * @param change - one domain change notification.
 */
function pendingCancelledBy(change) {
  if (change === null || typeof change !== 'object') return
  if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
  const value = change.value
  if (value === null || typeof value !== 'object' || !Array.isArray(value.archivedSessionIds)) return
  const archived = new Set(value.archivedSessionIds.filter((id) => typeof id === 'string'))
  void readPending().then((pending) => {
    const cancelled = pending.filter((id) => !archived.has(id))
    if (cancelled.length > 0) return dropPending(cancelled)
    return undefined
  }).catch(() => {})
}

/**
 * @param status - HTTP status.
 * @param body - JSON-serializable answer.
 * @returns the JSON response the browser half reads.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Build the exact Fetch route handler. Connection has already applied its
 * trust and authentication policy and only forwards owner Peers here.
 * @param ctx - activation context of the plugin.
 * @returns the handler registered on the shared API channel.
 */
function createDeleteRoute(ctx) {
  return async (request) => {
    let payload
    try {
      payload = await request.json()
    } catch {
      return jsonResponse(400, { ok: false, error: { code: 'invalid-json', message: 'the request body is not JSON' } })
    }
    const ids = payload !== null && typeof payload === 'object' ? payload.sessionIds : undefined
    const defer = payload !== null && typeof payload === 'object' && payload.defer === true
    try {
      const value = await deleteSessions(ctx, ids, { defer })
      if (value.problems.length > 0) {
        ctx.logger.warn(`session-remover: delete reported problems: ${value.problems.join('; ')}`)
      }
      return jsonResponse(200, { ok: true, value })
    } catch (error) {
      const code = error instanceof SessionRemoverError ? error.code : 'delete-failed'
      const message = messageOf(error)
      ctx.logger.warn(`session-remover: delete failed: ${message}`)
      return jsonResponse(200, {
        ok: false,
        error: { code, message, ...(error instanceof SessionRemoverError && error.details !== undefined ? { details: error.details } : {}) },
      })
    }
  }
}

/**
 * Summarize one deletion for the model.
 * @param value - the operation report.
 * @returns the model-facing line.
 */
function summarize(value) {
  const parts = []
  if (value.deferred.length > 0) {
    parts.push(`Deferred ${value.deferred.length} Session${value.deferred.length === 1 ? '' : 's'} to the next start: `
      + `${value.deferred.join(', ')}. They are hidden now and deleted when DeepSeek Harness restarts; `
      + 'unarchiving one before then cancels it.')
  }
  if (value.deleted.length + value.deferred.length === 0) {
    parts.push('Deleted no Session logs (nothing was stored on disk for the named ids).')
  } else if (value.deleted.length > 0) {
    parts.push(`Deleted ${value.deleted.length} Session${value.deleted.length === 1 ? '' : 's'} permanently: ${value.deleted.join(', ')}.`)
  }
  if (value.absent.length > 0) {
    parts.push(`Already absent from disk: ${value.absent.join(', ')}.`)
  }
  if (value.problems.length > 0) {
    parts.push(`Incomplete: ${value.problems.join('; ')}.`)
  }
  return parts.join(' ')
}

/**
 * Register the model-facing Tool on the activation scope.
 * @param ctx - activation context carrying `tools`.
 */
function registerTool(ctx) {
  ctx.tools.register({
    name: 'session_delete',
    description:
      'Permanently delete stored Sessions and their local logs, their subagent child Sessions, and every '
      + 'sidebar, archive, and pin reference to them. Use this only when the user wants a Session gone for '
      + 'good; to merely hide one, archive it instead. It cannot be undone. Pass exact Session ids: there is '
      + 'no wildcard or "all" form. A Session loaded in the running app cannot be deleted while it is loaded; '
      + 'set defer to hide it now and delete it on the next start, which the user cancels by unarchiving it.',
    parameters: {
      type: 'object',
      properties: {
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact Session ids to delete permanently, for example "session-0123abcd-...".',
        },
        defer: {
          type: 'boolean',
          description: 'When the Session is loaded in the running app, hide it now and delete it on the next start.',
        },
      },
      required: ['sessionIds'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'requested', 'deleted', 'absent', 'deferred', 'problems'],
        properties: {
          summary: { type: 'string' },
          requested: { type: 'array', items: { type: 'string' } },
          deleted: { type: 'array', items: { type: 'string' } },
          absent: { type: 'array', items: { type: 'string' } },
          deferred: { type: 'array', items: { type: 'string' } },
          problems: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Delete sessions permanently',
      kind: 'other',
      rawInput: args.sessionIds,
    }),
    async execute(args) {
      const request = args === null || typeof args !== 'object' ? {} : args
      const value = await deleteSessions(ctx, request.sessionIds, { defer: request.defer === true })
      return { summary: summarize(value), ...value }
    },
  })
}

/**
 * Activate the bundle: the Tool, and — in a profile that serves a browser —
 * the Fetch route the Session menu action calls. Deferred deletions from an
 * earlier run are applied first, while nothing is loaded.
 * @param ctx - plugin context of the inserted Loader row.
 */
export function apply(ctx) {
  ctx.inject(['tools', 'sessionPersistence'], (scope) => {
    registerTool(scope)
    scope.inject(['connection'], (connectionScope) => {
      connectionScope.effect(
        () => connectionScope.connection.fetch.register({
          path: DELETE_ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: createDeleteRoute(connectionScope),
        }),
        'session-remover: delete route',
      )
    })
    scope.inject(['workspaceRegistry'], (readyScope) => {
      readyScope.effect(() => {
        void processPendingDeletions(readyScope).catch((error) => {
          readyScope.logger.warn(`session-remover: deferred deletion failed: ${messageOf(error)}`)
        })
        const off = readyScope.on('domain/changed', pendingCancelledBy)
        return () => { off() }
      }, 'session-remover: deferred deletions')
    })
  })
}
