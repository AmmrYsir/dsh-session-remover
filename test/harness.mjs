/**
 * Fake Cordis context for the Host half of the bundle.
 *
 * The plugin imports no Harness package, so the suite runs on a plain Node
 * runtime: this helper reproduces exactly the service surface `apply()` reads
 * (injection scopes, effects, events, the tool registry, the `/api` route
 * registry, and the Session/Workspace services) and records what the plugin did.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** @param ms - delay in milliseconds. @returns a promise resolving after it. */
export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Build one stored-Session snapshot as the persistence backend reports it.
 * @param id - Session id.
 * @param projectDirectory - the project directory that owns the Session.
 * @returns a snapshot with a real on-disk location.
 */
export function snapshotFor(id, projectDirectory) {
  return {
    header: { version: 4, id, createdAt: 1, cwd: 'C:\\Users\\test\\project', isSeeded: false },
    revision: 'revision-1',
    location: { kind: 'jsonl', path: path.join(projectDirectory, id, 'session.v4.jsonl.zstd') },
  }
}

/**
 * @param file - log file path to create.
 */
export async function writeLog(file) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'x')
}

/**
 * @param target - path to test.
 * @returns whether the path exists.
 */
export async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Build a fake plugin context.
 * @param {{ snapshots?: object[], live?: string[], workspaces?: object[], storageDomain?: boolean }} options
 *   stored Sessions, the ids the Host still holds loaded, Workspace entities, and whether the domain facility is open.
 * @returns the context plus every observation the plugin produced.
 */
export function createHarness(options = {}) {
  const seen = {
    tool: undefined,
    route: undefined,
    archived: [],
    detached: [],
    unarchived: [],
    pinned: [],
    unpinned: [],
    cacheDeleted: [],
    warnings: [],
    infos: [],
    listeners: new Set(),
  }
  const snapshots = options.snapshots ?? []
  const workspaces = options.workspaces ?? []
  const live = new Set(options.live ?? [])
  const archiveSet = options.archivedSessionIds ?? []
  const pinSet = options.pinnedSessionIds ?? []

  const registry = {
    list: () => workspaces,
    get archivedSessionIds() { return archiveSet },
    get pinnedSessionIds() { return pinSet },
    archiveSession: async (id, archiveOptions) => { seen.archived.push({ id, ...archiveOptions }) },
    unarchiveSession: async (id) => { seen.unarchived.push(id) },
    pinSession: async (id) => { seen.pinned.push(id) },
    unpinSession: async (id) => { seen.unpinned.push(id) },
  }

  const cacheTable = {
    delete: async (id) => { seen.cacheDeleted.push(id); return true },
  }

  const ctx = {
    logger: {
      warn: (message) => { seen.warnings.push(String(message)) },
      info: (message) => { seen.infos.push(String(message)) },
    },
    // Both scopes this plugin opens resolve immediately in the fake.
    inject: (deps, callback) => { callback(ctx); return () => {} },
    effect: (callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (name, listener) => {
      const entry = { name, listener }
      seen.listeners.add(entry)
      return () => { seen.listeners.delete(entry) }
    },
    emit: (name, payload) => {
      for (const entry of [...seen.listeners]) if (entry.name === name) entry.listener(payload)
    },
    get: (name) => {
      if (name === 'workspaceRegistry') return registry
      if (name === 'storageDomain') {
        return options.storageDomain === false
          ? undefined
          : { get: (domainName) => (domainName === 'session_projcache' ? { table: () => cacheTable } : undefined) }
      }
      if (name === 'agents') return { get: (id) => (live.has(id) ? {} : undefined) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    sessionPersistence: { list: async () => snapshots },
    tools: { register: (definition) => { seen.tool = definition; return () => {} } },
    connection: { fetch: { register: (route) => { seen.route = route; return () => {} } } },
  }

  return { ctx, seen, registry, snapshots }
}
