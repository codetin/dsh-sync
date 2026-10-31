/**
 * Periodic auto-push for `dsh-sync`.
 *
 * The host owns one scheduler; it re-reads settings before every run so the
 * checkbox and interval in the Settings page take effect without a restart.
 * Each run is a normal `push`, so it shares the engine's queue and state
 * recording with manual pushes.
 */
import { DEFAULT_AUTO_PUSH_INTERVAL_MINUTES } from './sync.js'

export class AutoPushScheduler {
  constructor({ sync, logger, setTimer, clearTimer } = {}) {
    if (!sync) throw new Error('AutoPushScheduler needs a sync engine.')
    this.sync = sync
    this.logger = logger
    this.setTimer = setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = clearTimer ?? ((id) => clearTimeout(id))
    this.stopped = true
    this.timer = undefined
    this.nextAt = null
    this.running = false
    // Incremented by every (re)arm and by stop, so an arm that was waiting on
    // settings can tell it has been superseded.
    this.generation = 0
  }

  /** Begin watching settings; the first run happens one interval from now. */
  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.arm()
  }

  stop() {
    this.stopped = true
    this.generation += 1
    this.cancel()
    this.nextAt = null
  }

  /** Re-arm after settings changed (enable/disable/interval). */
  refresh() {
    if (this.stopped) return Promise.resolve()
    return this.arm()
  }

  cancel() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  async arm() {
    const generation = this.generation + 1
    this.generation = generation
    this.cancel()
    this.nextAt = null
    if (this.stopped) return
    let settings
    try {
      settings = await this.sync.readSettings()
    } catch (error) {
      this.logger?.warn?.(`dsh-sync: cannot read settings for auto-sync: ${describeError(error)}`)
      return
    }
    // A newer arm (or stop) ran while settings were loading; it owns the timer.
    if (this.stopped || generation !== this.generation) return
    if (!settings.autoPush || settings.remote === '') return
    const minutes = settings.autoPushIntervalMinutes || DEFAULT_AUTO_PUSH_INTERVAL_MINUTES
    const delay = minutes * 60_000
    this.nextAt = Date.now() + delay
    this.timer = this.setTimer(() => {
      void this.tick()
    }, delay)
    // A pending auto-push must never keep the host process alive.
    this.timer?.unref?.()
  }

  async tick() {
    this.timer = undefined
    this.nextAt = null
    if (this.stopped) return
    if (this.running) {
      void this.arm()
      return
    }
    let settings
    try {
      settings = await this.sync.readSettings()
    } catch (error) {
      this.logger?.warn?.(`dsh-sync: cannot read settings for auto-sync: ${describeError(error)}`)
      void this.arm()
      return
    }
    if (!settings.autoPush || settings.remote === '') return

    this.running = true
    let outcome = { ok: false }
    try {
      const result = await this.sync.push()
      outcome = result
      if (result?.ok === false) {
        this.logger?.warn?.(`dsh-sync: auto push skipped: ${result.message ?? 'not configured'}`)
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-sync: auto push failed: ${describeError(error)}`)
    } finally {
      this.running = false
      if (!this.stopped) void this.arm()
    }
    try {
      await this.sync.recordAutoPush(outcome)
    } catch (error) {
      this.logger?.warn?.(`dsh-sync: cannot record auto push: ${describeError(error)}`)
    }
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}
