import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AutoPushScheduler } from '../lib/auto.js'
import { SessionGitSync } from '../lib/sync.js'

async function makeHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-auto-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true })
  return home
}

/** Deterministic stand-in for setTimeout/clearTimeout. */
function makeClock() {
  const timers = new Map()
  let nextId = 0
  return {
    setTimer(fn, ms) {
      nextId += 1
      timers.set(nextId, { fn, ms })
      return nextId
    },
    clearTimer(id) {
      timers.delete(id)
    },
    pending() {
      return [...timers.entries()].map(([id, timer]) => ({ id, ms: timer.ms }))
    },
    fire() {
      const due = [...timers.values()]
      timers.clear()
      for (const timer of due) timer.fn()
    },
  }
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

test('settings default to auto-sync off and a 10 minute interval', async (t) => {
  const home = await makeHome(t)
  const sync = new SessionGitSync({ home, logger: { warn() {} } })
  const settings = await sync.readSettings()
  assert.equal(settings.autoPush, false)
  assert.equal(settings.autoPushIntervalMinutes, 10)
})

test('save persists the auto-sync schedule and validates the interval', async (t) => {
  const home = await makeHome(t)
  const sync = new SessionGitSync({ home, logger: { warn() {} } })

  const saved = await sync.save('/tmp/repo', 'main', true, 15)
  assert.deepEqual(saved.settings, {
    remote: '/tmp/repo',
    branch: 'main',
    autoPush: true,
    autoPushIntervalMinutes: 15,
  })
  const reread = await sync.readSettings()
  assert.equal(reread.autoPush, true)
  assert.equal(reread.autoPushIntervalMinutes, 15)
  const status = await sync.status()
  assert.equal(status.autoPush, true)
  assert.equal(status.autoPushIntervalMinutes, 15)

  // An older client that only sends remote/branch keeps the stored schedule.
  const twoArg = await sync.save('/tmp/repo', 'main')
  assert.equal(twoArg.settings.autoPush, true)
  assert.equal(twoArg.settings.autoPushIntervalMinutes, 15)

  // A fresh settings file defaults to 10 minutes.
  const fresh = new SessionGitSync({ home: path.join(home, 'fresh'), logger: { warn() {} } })
  const defaulted = await fresh.save('/tmp/repo', 'main', true)
  assert.equal(defaulted.settings.autoPushIntervalMinutes, 10)

  await assert.rejects(() => sync.save('/tmp/repo', 'main', true, 0), /interval/i)
  await assert.rejects(() => sync.save('/tmp/repo', 'main', true, 1441), /interval/i)
  await assert.rejects(() => sync.save('/tmp/repo', 'main', true, 1.5), /interval/i)
  await assert.rejects(() => sync.save('/tmp/repo', 'main', true, 'soon'), /interval/i)
})

test('scheduler pushes once per interval and records the run', async (t) => {
  const home = await makeHome(t)
  const engine = new SessionGitSync({ home, logger: { warn() {} } })
  await engine.save('/tmp/repo', 'main', true, 5)

  const calls = []
  const sync = {
    settings: await engine.readSettings(),
    async readSettings() {
      return this.settings
    },
    async push() {
      calls.push('push')
      return { ok: true, pushed: true, sessions: 1, files: 1 }
    },
    async recordAutoPush(result) {
      calls.push(`record:${result.ok}`)
    },
  }
  const clock = makeClock()
  const scheduler = new AutoPushScheduler({
    sync,
    logger: { warn() {} },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  scheduler.start()
  await flush()
  assert.deepEqual(clock.pending().map((timer) => timer.ms), [5 * 60_000])
  assert.ok(scheduler.nextAt > Date.now())

  clock.fire()
  await flush()
  assert.deepEqual(calls, ['push', 'record:true'])
  // A finished run always arms the next one.
  assert.deepEqual(clock.pending().map((timer) => timer.ms), [5 * 60_000])

  scheduler.stop()
  assert.deepEqual(clock.pending(), [])
  assert.equal(scheduler.nextAt, null)
})

test('scheduler stays idle while disabled or without a remote', async (t) => {
  const home = await makeHome(t)
  const engine = new SessionGitSync({ home, logger: { warn() {} } })
  const clock = makeClock()
  const settings = {
    remote: '/tmp/repo',
    branch: 'main',
    autoPush: false,
    autoPushIntervalMinutes: 1,
  }
  const sync = {
    async readSettings() {
      return settings
    },
    async push() {
      throw new Error('must not push while disabled')
    },
    async recordAutoPush() {},
  }
  const scheduler = new AutoPushScheduler({
    sync,
    logger: { warn() {} },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })

  scheduler.start()
  await flush()
  assert.deepEqual(clock.pending(), [])

  settings.autoPush = true
  settings.remote = ''
  await scheduler.refresh()
  await flush()
  assert.deepEqual(clock.pending(), [])

  settings.remote = '/tmp/repo'
  await scheduler.refresh()
  await flush()
  assert.deepEqual(clock.pending().map((timer) => timer.ms), [60_000])

  scheduler.stop()
})
