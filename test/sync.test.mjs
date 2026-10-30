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
  assert.deepEqual(saved.settings, { remote: '/tmp/repo', branch: 'sync/main' })
  assert.equal((await sync.status()).branch, 'sync/main')
  assert.equal(validateBranch(''), 'main')
  assert.throws(() => validateRemote(''), /URL/i)
})
