/**
 * Immediate-deletion behaviour of the Host half: subagent expansion, reference
 * cleanup, safety guards, and the `/api` route contract.
 *
 * `DSH_HOME` points at a temporary root before the plugin module loads, so the
 * suite never touches a real Harness data directory.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHarness, exists, snapshotFor, writeLog } from './harness.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-remover-delete-'))
process.env.DSH_HOME = root
const { apply } = await import('../index.js')

const project = path.join(root, '--C-Users-test-project--')
const PARENT = 'session-11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const ORPHAN = 'session-33333333-3333-4333-8333-333333333333'
const UNSAFE = 'session-44444444-4444-4444-8444-444444444444'
const LIVE = 'session-55555555-5555-4555-8555-555555555555'
const LONELY = 'session-66666666-6666-4666-8666-666666666666'

function workspaceWith(ids) {
  return { title: 'test project', sessionIds: ids, detachSession: async () => {} }
}

/** @returns the four snapshots the deletion scenarios share. */
function standardSnapshots() {
  return [
    snapshotFor(PARENT, project),
    {
      ...snapshotFor(CHILD, project),
      header: { version: 4, id: CHILD, createdAt: 2, cwd: 'C:\\Users\\test\\project', isSeeded: false, origin: 'subagent', parentSession: PARENT, delegationDepth: 1 },
    },
    snapshotFor(UNSAFE, path.join(project, 'some-other-name')),
    snapshotFor(LIVE, project),
  ]
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('registers the tool and the exact POST route', async () => {
  const { ctx, seen } = createHarness({ snapshots: [snapshotFor(PARENT, project)] })
  apply(ctx)
  assert.equal(seen.tool.name, 'session_delete')
  assert.deepEqual(seen.route.methods, ['POST'])
  assert.equal(seen.route.path, '/api/session-remover/delete')
  assert.equal(seen.route.requestBody, 'buffered')
})

test('deletes a Session, its subagent child, and every reference', async () => {
  const snapshots = standardSnapshots()
  for (const entry of snapshots) await writeLog(entry.location.path)
  const detached = []
  const harness = createHarness({
    snapshots,
    workspaces: [{ ...workspaceWith([PARENT, CHILD, UNSAFE, LIVE]), detachSession: async (id) => { detached.push(id) } }],
    archivedSessionIds: [PARENT, CHILD],
    pinnedSessionIds: [PARENT],
  })
  apply(harness.ctx)

  const value = await harness.seen.tool.execute({ sessionIds: [PARENT] })

  assert.deepEqual(value.deleted.sort(), [CHILD, PARENT].sort())
  assert.deepEqual(value.absent, [])
  assert.deepEqual(value.deferred, [])
  assert.deepEqual(value.problems, [])
  assert.deepEqual(detached.sort(), [CHILD, PARENT].sort())
  assert.deepEqual(harness.seen.unarchived.sort(), [CHILD, PARENT].sort())
  assert.deepEqual(harness.seen.unpinned, [PARENT])
  assert.deepEqual(harness.seen.cacheDeleted.sort(), [CHILD, PARENT].sort())
  assert.equal(await exists(path.join(project, PARENT)), false, 'parent log directory is gone')
  assert.equal(await exists(path.join(project, CHILD)), false, 'child log directory is gone')
  assert.equal(await exists(path.join(project, LIVE)), true, 'an unrelated Session stays')
  assert.equal(await exists(path.join(project, 'some-other-name')), true, 'an unexpected path stays')
  assert.match(value.summary, /Deleted 2 Sessions permanently/)
})

test('removes a project directory emptied by the deletion', async () => {
  const lonelyProject = path.join(root, '--C-Users-lonely--')
  const snapshots = [snapshotFor(LONELY, lonelyProject)]
  await writeLog(snapshots[0].location.path)
  const harness = createHarness({ snapshots, workspaces: [workspaceWith([LONELY])] })
  apply(harness.ctx)

  const value = await harness.seen.tool.execute({ sessionIds: [LONELY] })

  assert.deepEqual(value.deleted, [LONELY])
  assert.equal(await exists(path.join(lonelyProject, LONELY)), false)
  assert.equal(await exists(lonelyProject), false, 'the emptied project directory is gone')
})

test('forgets an id with no stored log without touching the disk', async () => {
  const detached = []
  const harness = createHarness({
    snapshots: [],
    workspaces: [{ ...workspaceWith([ORPHAN]), detachSession: async (id) => { detached.push(id) } }],
    archivedSessionIds: [ORPHAN],
  })
  apply(harness.ctx)

  const value = await harness.seen.tool.execute({ sessionIds: [ORPHAN] })

  assert.deepEqual(value.deleted, [])
  assert.deepEqual(value.absent, [ORPHAN])
  assert.deepEqual(detached, [ORPHAN])
  assert.deepEqual(harness.seen.unarchived, [ORPHAN])
})

test('refuses a loaded Session before writing anything', async () => {
  const snapshots = [snapshotFor(PARENT, project)]
  await writeLog(snapshots[0].location.path)
  const harness = createHarness({ snapshots, live: [PARENT], workspaces: [workspaceWith([PARENT])] })
  apply(harness.ctx)

  await assert.rejects(() => harness.seen.tool.execute({ sessionIds: [PARENT] }), /loaded in the running app/)
  assert.equal(await exists(path.join(project, PARENT)), true)
  assert.deepEqual(harness.seen.archived, [])
  assert.deepEqual(harness.seen.detached, [])
})

test('never removes a log outside the session persistence layout', async () => {
  const snapshots = [snapshotFor(UNSAFE, path.join(project, 'some-other-name'))]
  await writeLog(snapshots[0].location.path)
  const harness = createHarness({ snapshots })
  apply(harness.ctx)

  const value = await harness.seen.tool.execute({ sessionIds: [UNSAFE] })

  assert.deepEqual(value.deleted, [])
  assert.equal(value.problems.length, 1)
  assert.match(value.problems[0], /refused to remove an unexpected path/)
})

test('rejects an unusable id and an empty batch', async () => {
  const harness = createHarness({ snapshots: [] })
  apply(harness.ctx)
  await assert.rejects(() => harness.seen.tool.execute({ sessionIds: ['../escape'] }), /not a usable Session id/)
  await assert.rejects(() => harness.seen.tool.execute({ sessionIds: [] }), /non-empty array/)
})

test('the route answers JSON success, refusal, and a bad body', async () => {
  const snapshots = [snapshotFor(PARENT, project)]
  await writeLog(snapshots[0].location.path)
  const harness = createHarness({ snapshots })
  apply(harness.ctx)
  const post = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

  const ok = await harness.seen.route.fetch(post({ sessionIds: [PARENT] }))
  assert.equal(ok.status, 200)
  const okBody = await ok.json()
  assert.equal(okBody.ok, true)
  assert.deepEqual(okBody.value.deleted, [PARENT])

  const badBody = await harness.seen.route.fetch(new Response('not json'))
  assert.equal(badBody.status, 400)
  assert.equal((await badBody.json()).error.code, 'invalid-json')

  const empty = await harness.seen.route.fetch(post({ sessionIds: [] }))
  assert.equal((await empty.json()).error.code, 'invalid-request')

  const liveSnapshots = [snapshotFor(LIVE, project)]
  const liveHarness = createHarness({ snapshots: liveSnapshots, live: [LIVE] })
  apply(liveHarness.ctx)
  const refusal = await liveHarness.seen.route.fetch(post({ sessionIds: [LIVE] }))
  assert.equal(refusal.status, 200)
  assert.equal((await refusal.json()).error.code, 'session-live')
})

test('drops the projection cache through its file when no domain is open', async () => {
  const cacheFile = path.join(root, 'storages', 'session_projcache', 'sessions', `${ORPHAN}.json`)
  await fs.mkdir(path.dirname(cacheFile), { recursive: true })
  await fs.writeFile(cacheFile, '{}')
  const harness = createHarness({ snapshots: [], storageDomain: false })
  apply(harness.ctx)

  await harness.seen.tool.execute({ sessionIds: [ORPHAN] })

  assert.equal(await exists(cacheFile), false, 'the cache document is gone')
})
