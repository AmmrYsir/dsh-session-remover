/**
 * Deferred-deletion behaviour of the Host half: a Session loaded in the running
 * app is hidden now and deleted on the next start, and unarchiving it cancels
 * that.
 *
 * `DSH_HOME` points at a temporary root before the plugin module loads, so the
 * suite never touches a real Harness data directory.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHarness, exists, sleep, snapshotFor, writeLog } from './harness.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-remover-deferred-'))
process.env.DSH_HOME = root
const { apply } = await import('../index.js')

const pendingFile = path.join(root, 'session-remover', 'pending.json')
const project = path.join(root, '--C-Users-test-project--')
const sessionId = (digit) => `session-${String(digit).repeat(8)}-0000-4000-8000-${String(digit).repeat(12)}`

/** @param ids - ids the pending record should hold. */
async function writePending(ids) {
  await fs.mkdir(path.dirname(pendingFile), { recursive: true })
  await fs.writeFile(pendingFile, JSON.stringify({ version: 1, sessionIds: ids }))
}

/** @returns the ids the pending record holds, or an empty array. */
async function readPending() {
  try {
    return JSON.parse(await fs.readFile(pendingFile, 'utf8')).sessionIds
  } catch {
    return []
  }
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('defers a loaded Session: archive it, keep the log, record it', async () => {
  const id = sessionId(1)
  const snapshots = [snapshotFor(id, project)]
  await writeLog(snapshots[0].location.path)
  const harness = createHarness({ snapshots, live: [id] })
  apply(harness.ctx)

  const value = await harness.seen.tool.execute({ sessionIds: [id], defer: true })

  assert.deepEqual(value.deferred, [id])
  assert.deepEqual(value.deleted, [])
  assert.deepEqual(harness.seen.archived, [{ id, stopActivity: true }])
  assert.equal(await exists(snapshots[0].location.path), true, 'the log stays until the next start')
  assert.deepEqual(await readPending(), [id])
})

test('deletes a deferred Session on the next start and clears the record', async () => {
  const id = sessionId(2)
  const snapshots = [snapshotFor(id, project)]
  await writeLog(snapshots[0].location.path)
  await writePending([id])
  const harness = createHarness({ snapshots })
  apply(harness.ctx)

  await sleep(200)

  assert.equal(await exists(path.join(project, id)), false, 'the deferred log is gone')
  assert.equal(await exists(pendingFile), false, 'the pending record is cleared')
  assert.equal(harness.seen.infos.length, 1, 'the deletion is reported in the Host log')
})

test('keeps a deferred Session pending when it is loaded again before the start', async () => {
  const id = sessionId(3)
  const snapshots = [snapshotFor(id, project)]
  await writeLog(snapshots[0].location.path)
  await writePending([id])
  const harness = createHarness({ snapshots, live: [id] })
  apply(harness.ctx)

  await sleep(200)

  assert.equal(await exists(path.join(project, id)), true, 'a loaded log is kept')
  assert.deepEqual(await readPending(), [id])
})

test('unarchiving cancels the deferred deletion', async () => {
  const id = sessionId(4)
  await fs.rm(pendingFile, { force: true })
  const harness = createHarness({ snapshots: [snapshotFor(id, project)], live: [id] })
  apply(harness.ctx)
  await harness.seen.tool.execute({ sessionIds: [id], defer: true })
  assert.deepEqual(await readPending(), [id])

  // The user unarchives it: the registry-global archive set no longer names it.
  harness.ctx.emit('domain/changed', {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
  })
  await sleep(80)

  assert.equal(await exists(pendingFile), false, 'the pending record is cancelled')
})
