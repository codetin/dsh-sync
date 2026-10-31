import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { SessionGitSync, validateBranch, validateRemote } from '../lib/sync.js'

const exec = promisify(execFile)

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function makeHome(root, name) {
  const home = path.join(root, name)
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true })
  return home
}

async function makeBareRemote(root) {
  const remote = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', remote])
  return remote
}

async function writeSession(home, project, session, bytes) {
  const dir = path.join(home, 'sessions', project, session)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  await fs.writeFile(file, bytes)
  return file
}

async function readSession(home, project, session) {
  return fs.readFile(path.join(home, 'sessions', project, session, 'session.v4.jsonl.zstd'), 'utf8')
}

test('push creates a branch and pull copies sessions to another device', async (t) => {
  const root = await makeRoot(t)
  const remote = await makeBareRemote(root)
  const homeA = await makeHome(root, 'device-a')
  const homeB = await makeHome(root, 'device-b')
  const project = '--Users-demo-project--'

  await writeSession(homeA, project, 'session-a', 'alpha-events')

  const a = new SessionGitSync({ home: homeA, logger: { warn() {} } })
  await a.save(remote, 'main')
  const firstPush = await a.push()
  assert.equal(firstPush.ok, true)
  assert.equal(firstPush.pushed, true)
  assert.equal(firstPush.sessions, 1)

  const b = new SessionGitSync({ home: homeB, logger: { warn() {} } })
  await b.save(remote, 'main')
  const firstPull = await b.pull()
  assert.equal(firstPull.ok, true)
  assert.equal(firstPull.addedSessions, 1)
  assert.equal(firstPull.addedFiles, 1)
  assert.equal(await readSession(homeB, project, 'session-a'), 'alpha-events')

  const noopPush = await b.push()
  assert.equal(noopPush.ok, true)
  assert.equal(noopPush.pushed, false)
  assert.equal(noopPush.files, 1)
})

test('two devices exchange new sessions and keep existing local logs', async (t) => {
  const root = await makeRoot(t)
  const remote = await makeBareRemote(root)
  const homeA = await makeHome(root, 'device-a')
  const homeB = await makeHome(root, 'device-b')
  const project = '--Users-demo-project--'

  await writeSession(homeA, project, 'session-a', 'a0')
  const a = new SessionGitSync({ home: homeA, logger: { warn() {} } })
  await a.save(remote, 'main')
  await a.push()

  const b = new SessionGitSync({ home: homeB, logger: { warn() {} } })
  await b.save(remote, 'main')
  await b.pull()

  await writeSession(homeB, project, 'session-b', 'b0')
  const pushedB = await b.push()
  assert.equal(pushedB.pushed, true)

  const pulledA = await a.pull()
  assert.equal(pulledA.ok, true)
  assert.equal(pulledA.addedSessions, 1)
  assert.equal(await readSession(homeA, project, 'session-b'), 'b0')

  // Local edits are never replaced by a pull.
  await writeSession(homeA, project, 'session-b', 'a-local-edit')
  const again = await a.pull()
  assert.equal(again.ok, true)
  assert.equal(again.addedFiles, 0)
  assert.equal(again.skippedFiles, 2)
  assert.equal(await readSession(homeA, project, 'session-b'), 'a-local-edit')
})

test('pull reports an empty remote before the first push', async (t) => {
  const root = await makeRoot(t)
  const remote = await makeBareRemote(root)
  const home = await makeHome(root, 'device')
  const sync = new SessionGitSync({ home, logger: { warn() {} } })
  await sync.save(remote, 'main')
  const result = await sync.pull()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'empty-remote')
})

test('save validates the git URL and branch', async (t) => {
  const root = await makeRoot(t)
  const home = await makeHome(root, 'device')
  const sync = new SessionGitSync({ home, logger: { warn() {} } })

  await assert.rejects(() => sync.save('not a url', 'main'), /git URL|whitespace/i)
  await assert.rejects(() => sync.save('/tmp/repo', 'bad branch'), /branch/i)

  const saved = await sync.save('/tmp/repo', 'sync/main')
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.settings, {
    remote: '/tmp/repo',
    branch: 'sync/main',
    autoPush: false,
    autoPushIntervalMinutes: 10,
  })
  assert.equal((await sync.status()).branch, 'sync/main')
  assert.equal(validateBranch(''), 'main')
  assert.throws(() => validateRemote(''), /URL/i)
})

test('status and test work before the home directory exists', async (t) => {
  const root = await makeRoot(t)
  const remote = await makeBareRemote(root)
  const home = path.join(root, 'missing-home')
  const sync = new SessionGitSync({ home, logger: { warn() {} } })

  const status = await sync.status()
  assert.equal(status.git.available, true)
  assert.equal(status.local.files, 0)

  const probe = await sync.test(remote)
  assert.equal(probe.ok, true)
  assert.deepEqual(probe.branches, [])
})

test('settings read from disk are revalidated', async (t) => {
  const root = await makeRoot(t)
  const home = await makeHome(root, 'device')
  const sync = new SessionGitSync({ home, logger: { warn() {} } })
  await fs.mkdir(sync.dataDir, { recursive: true })
  await fs.writeFile(
    sync.settingsPath,
    JSON.stringify({ remote: '--upload-pack=evil', branch: 'bad branch', autoPush: true }),
  )

  const settings = await sync.readSettings()
  assert.equal(settings.remote, '')
  assert.equal(settings.branch, 'main')
  assert.equal(settings.autoPush, true)
})

test('save creates the data directory with owner-only permissions', async (t) => {
  if (process.platform === 'win32') return
  const root = await makeRoot(t)
  const home = await makeHome(root, 'device')
  const sync = new SessionGitSync({ home, logger: { warn() {} } })
  await sync.save('/tmp/repo', 'main')
  const mode = (await fs.stat(sync.dataDir)).mode & 0o777
  assert.equal(mode, 0o700)
})

test('recordAutoPush merges into the shared state instead of replacing it', async (t) => {
  const root = await makeRoot(t)
  const home = await makeHome(root, 'device')
  const sync = new SessionGitSync({ home, logger: { warn() {} } })
  await sync.recordState({ lastPushAt: '2026-01-01T00:00:00.000Z', lastPushOk: true })
  await sync.recordAutoPush({ ok: false })
  const state = await sync.readState()
  assert.equal(state.lastPushAt, '2026-01-01T00:00:00.000Z')
  assert.equal(state.lastPushOk, true)
  assert.equal(state.lastAutoPushOk, false)
})
