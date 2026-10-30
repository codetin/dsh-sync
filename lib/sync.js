/**
 * Git-backed mirror of the DeepSeek Harness session store.
 *
 * The mirror is a dedicated work tree under `$DSH_HOME/dsh-sync/repo`; the
 * Harness session directory itself (`$DSH_HOME/sessions`) never contains a
 * `.git` entry. Push copies local session logs into the mirror, commits, and
 * pushes. Pull fast-forwards the mirror from the remote and copies only
 * sessions that do not exist locally, so a device never loses a local log.
 *
 * Only append-only session log files (`session.*.jsonl.zstd`) are mirrored.
 * Write locks, `.DS_Store`, and any other bookkeeping files stay local.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SESSION_FILE_PATTERN = /^session\..+\.jsonl\.zstd$/
const GIT_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 45_000
const MAX_BUFFER = 16 * 1024 * 1024
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/

/** Auto-sync defaults and bounds, in minutes. */
export const DEFAULT_AUTO_PUSH_INTERVAL_MINUTES = 10
export const MIN_AUTO_PUSH_INTERVAL_MINUTES = 1
export const MAX_AUTO_PUSH_INTERVAL_MINUTES = 1440

/** A failed operation carrying the raw git result when one exists. */
export class SyncFailure extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'SyncFailure'
    this.details = details
  }
}

function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' }
  // Never let a missing/passphrase-protected key block the host process on an
  // interactive prompt; the failure is reported back to the caller instead.
  if (!env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=15'
  }
  return env
}

function gitMessage(result) {
  const text = (result.stderr || result.stdout || result.message || '').trim()
  return text || `git exited with code ${String(result.code)}`
}

/**
 * Run one git command.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, allowFailure?: boolean, timeout?: number }} [options]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code?: unknown, message?: string }>}
 */
async function runGit(args, options = {}) {
  const { cwd, allowFailure = false, timeout = GIT_TIMEOUT_MS } = options
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: gitEnvironment(),
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    })
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
  } catch (error) {
    const result = {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout.trimEnd() : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr.trimEnd() : '',
      code: error?.code,
      message: error?.message ?? String(error),
    }
    if (allowFailure) return result
    throw new SyncFailure(gitMessage(result), result)
  }
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function isRemoteRefMissing(result) {
  return /couldn't find remote ref|could not find remote ref|unknown revision/i.test(
    `${result.stderr}\n${result.stdout}`,
  )
}

/** Reject a URL that git would misread or that spans multiple arguments. */
export function validateRemote(remote) {
  if (typeof remote !== 'string' || remote.trim() === '') {
    throw new SyncFailure('Set a git repository URL first.')
  }
  const value = remote.trim()
  if (value.length > 2048) throw new SyncFailure('The git URL is too long.')
  if (/\s/.test(value)) throw new SyncFailure('The git URL must not contain whitespace.')
  if (value.startsWith('-')) throw new SyncFailure('The git URL must not start with "-".')
  const looksLikeUrl = /^(https?|ssh|git|file):\/\//i.test(value)
  const looksLikeScp = /^[^@/\s]+@[^:/\s]+:.+$/.test(value)
  const looksLikePath = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
  if (!looksLikeUrl && !looksLikeScp && !looksLikePath) {
    throw new SyncFailure('Use an https/ssh URL, user@host:path, or an absolute path.')
  }
  return value
}

/** Validate a branch name without relying on `git check-ref-format`. */
export function validateBranch(branch) {
  const value = typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : 'main'
  if (!BRANCH_PATTERN.test(value)
    || value.includes('..')
    || value.endsWith('/')
    || value.endsWith('.lock')
    || value.includes('//')) {
    throw new SyncFailure('Invalid branch name.')
  }
  return value
}

/**
 * Validate the auto-sync interval (whole minutes).
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeAutoPushInterval(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_AUTO_PUSH_INTERVAL_MINUTES
  }
  const number = Number(value)
  if (!Number.isInteger(number)
    || number < MIN_AUTO_PUSH_INTERVAL_MINUTES
    || number > MAX_AUTO_PUSH_INTERVAL_MINUTES) {
    throw new SyncFailure(
      `Auto-sync interval must be a whole number between ${MIN_AUTO_PUSH_INTERVAL_MINUTES} and ${MAX_AUTO_PUSH_INTERVAL_MINUTES} minutes.`,
    )
  }
  return number
}

/** Interval for an already persisted settings file; bad values fall back. */
function storedAutoPushInterval(value) {
  const number = Number(value)
  return Number.isInteger(number)
    && number >= MIN_AUTO_PUSH_INTERVAL_MINUTES
    && number <= MAX_AUTO_PUSH_INTERVAL_MINUTES
    ? number
    : DEFAULT_AUTO_PUSH_INTERVAL_MINUTES
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

function summarize(files) {
  let bytes = 0
  const sessions = new Set()
  for (const file of files) {
    sessions.add(`${file.project}/${file.session}`)
    bytes += file.bytes ?? 0
  }
  return { sessions: sessions.size, files: files.length, bytes }
}

/**
 * One settings + mirror owner shared by the `/sync` command and the settings
 * page. Mutating operations are serialized so two clicks cannot race on the
 * same work tree.
 */
export class SessionGitSync {
  constructor({ home, logger, flush } = {}) {
    this.home = home ?? (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
    this.sessionsRoot = path.join(this.home, 'sessions')
    this.dataDir = path.join(this.home, 'dsh-sync')
    this.repoDir = path.join(this.dataDir, 'repo')
    this.settingsPath = path.join(this.dataDir, 'settings.json')
    this.statePath = path.join(this.dataDir, 'state.json')
    this.logger = logger ?? console
    this.flush = typeof flush === 'function' ? flush : async () => {}
    this.queue = Promise.resolve()
    this.gitVersionPromise = undefined
  }

  /** Serialize mutating operations; reads stay independent. */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async readSettings() {
    const stored = await readJson(this.settingsPath)
    return {
      remote: typeof stored?.remote === 'string' ? stored.remote : '',
      branch: typeof stored?.branch === 'string' && stored.branch ? stored.branch : 'main',
      autoPush: stored?.autoPush === true,
      autoPushIntervalMinutes: storedAutoPushInterval(stored?.autoPushIntervalMinutes),
    }
  }

  async readState() {
    const stored = await readJson(this.statePath)
    return {
      lastPushAt: typeof stored?.lastPushAt === 'string' ? stored.lastPushAt : null,
      lastPushOk: typeof stored?.lastPushOk === 'boolean' ? stored.lastPushOk : null,
      lastPushSummary: typeof stored?.lastPushSummary === 'string' ? stored.lastPushSummary : null,
      lastPullAt: typeof stored?.lastPullAt === 'string' ? stored.lastPullAt : null,
      lastPullOk: typeof stored?.lastPullOk === 'boolean' ? stored.lastPullOk : null,
      lastPullSummary: typeof stored?.lastPullSummary === 'string' ? stored.lastPullSummary : null,
      lastAutoPushAt: typeof stored?.lastAutoPushAt === 'string' ? stored.lastAutoPushAt : null,
      lastAutoPushOk: typeof stored?.lastAutoPushOk === 'boolean' ? stored.lastAutoPushOk : null,
      lastError: typeof stored?.lastError === 'string' ? stored.lastError : null,
    }
  }

  async recordState(patch) {
    const next = { ...(await this.readState()), ...patch }
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeJsonAtomic(this.statePath, next)
  }

  /** Mark the outcome of one scheduled auto-sync run. */
  async recordAutoPush(result) {
    await this.recordState({
      lastAutoPushAt: new Date().toISOString(),
      lastAutoPushOk: result?.ok !== false,
    })
  }

  async gitVersion() {
    if (this.gitVersionPromise === undefined) {
      this.gitVersionPromise = (async () => {
        const result = await runGit(['--version'], { cwd: this.home, allowFailure: true, timeout: 10_000 })
        if (!result.ok) return { available: false, version: null }
        return { available: true, version: result.stdout.replace(/^git version\s*/i, '') || result.stdout }
      })()
    }
    return this.gitVersionPromise
  }

  /** Session log files under one root, sorted for deterministic commits. */
  async collectSessionFiles(root) {
    const files = []
    let projectEntries
    try {
      projectEntries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return files
    }
    for (const projectEntry of projectEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!projectEntry.isDirectory() || projectEntry.name.startsWith('.')) continue
      const projectDir = path.join(root, projectEntry.name)
      let sessionEntries
      try {
        sessionEntries = await fs.readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sessionEntry of sessionEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!sessionEntry.isDirectory() || sessionEntry.name.startsWith('.')) continue
        const sessionDir = path.join(projectDir, sessionEntry.name)
        let fileEntries
        try {
          fileEntries = await fs.readdir(sessionDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const fileEntry of fileEntries) {
          if (!fileEntry.isFile() || !SESSION_FILE_PATTERN.test(fileEntry.name)) continue
          const abs = path.join(sessionDir, fileEntry.name)
          let bytes = 0
          try {
            bytes = (await fs.stat(abs)).size
          } catch {
            continue
          }
          files.push({ project: projectEntry.name, session: sessionEntry.name, file: fileEntry.name, abs, bytes })
        }
      }
    }
    return files
  }

  async status() {
    const [settings, state, localFiles, mirrorFiles, git] = await Promise.all([
      this.readSettings(),
      this.readState(),
      this.collectSessionFiles(this.sessionsRoot),
      this.collectSessionFiles(path.join(this.repoDir, 'sessions')),
      this.gitVersion(),
    ])
    const initialized = await pathExists(path.join(this.repoDir, '.git'))
    let lastCommit = null
    if (initialized) {
      const log = await runGit(['log', '-1', '--format=%cI'], { cwd: this.repoDir, allowFailure: true })
      lastCommit = log.ok && log.stdout !== '' ? log.stdout : null
    }
    return {
      configured: settings.remote !== '',
      remote: settings.remote,
      branch: settings.branch,
      autoPush: settings.autoPush,
      autoPushIntervalMinutes: settings.autoPushIntervalMinutes,
      repoDir: this.repoDir,
      sessionsRoot: this.sessionsRoot,
      local: summarize(localFiles),
      mirror: { initialized, ...summarize(mirrorFiles), lastCommit },
      state,
      git,
    }
  }

  async save(remote, branch, autoPush, autoPushIntervalMinutes) {
    const normalizedRemote = typeof remote === 'string' ? remote.trim() : ''
    const normalizedBranch = validateBranch(branch)
    // Omitted auto-sync fields keep their stored values, so an older client
    // that only sends remote/branch cannot silently disable a running schedule.
    const current = await this.readSettings()
    const normalizedAutoPush = autoPush === undefined ? current.autoPush : autoPush === true
    const normalizedInterval = autoPushIntervalMinutes === undefined
      ? current.autoPushIntervalMinutes
      : normalizeAutoPushInterval(autoPushIntervalMinutes)
    if (normalizedRemote !== '') validateRemote(normalizedRemote)
    return this.enqueue(async () => {
      await fs.mkdir(this.dataDir, { recursive: true })
      await writeJsonAtomic(this.settingsPath, {
        remote: normalizedRemote,
        branch: normalizedBranch,
        autoPush: normalizedAutoPush,
        autoPushIntervalMinutes: normalizedInterval,
      })
      return {
        ok: true,
        settings: {
          remote: normalizedRemote,
          branch: normalizedBranch,
          autoPush: normalizedAutoPush,
          autoPushIntervalMinutes: normalizedInterval,
        },
      }
    })
  }

  async ensureRepository(settings) {
    await fs.mkdir(this.repoDir, { recursive: true })
    const initialized = await pathExists(path.join(this.repoDir, '.git'))
    if (!initialized) {
      await runGit(['init'], { cwd: this.repoDir })
      // Keep the unborn branch aligned with the configured branch so the first
      // commit lands on the right name.
      await runGit(['symbolic-ref', 'HEAD', `refs/heads/${settings.branch}`], {
        cwd: this.repoDir,
        allowFailure: true,
      })
    }
    await runGit(['config', 'user.name', 'DSH Session Sync'], { cwd: this.repoDir, allowFailure: true })
    await runGit(['config', 'user.email', 'dsh-sync@localhost'], { cwd: this.repoDir, allowFailure: true })

    const existing = await runGit(['remote', 'get-url', 'origin'], { cwd: this.repoDir, allowFailure: true })
    if (!existing.ok) {
      await runGit(['remote', 'add', 'origin', settings.remote], { cwd: this.repoDir })
    } else if (existing.stdout.trim() !== settings.remote) {
      await runGit(['remote', 'set-url', 'origin', settings.remote], { cwd: this.repoDir })
    }
  }

  /**
   * Fetch the configured branch.
   *
   * @returns {Promise<{ remoteHasBranch: boolean }>}
   */
  async fetchRemoteBranch(settings) {
    const fetched = await runGit(['fetch', '--prune', 'origin', settings.branch], {
      cwd: this.repoDir,
      allowFailure: true,
    })
    if (!fetched.ok) {
      if (isRemoteRefMissing(fetched)) return { remoteHasBranch: false }
      throw new SyncFailure(gitMessage(fetched), fetched)
    }
    const ref = await runGit(['rev-parse', '--verify', `refs/remotes/origin/${settings.branch}`], {
      cwd: this.repoDir,
      allowFailure: true,
    })
    return { remoteHasBranch: ref.ok }
  }

  async writeMirrorFiles(files) {
    for (const file of files) {
      const destination = path.join(this.repoDir, 'sessions', file.project, file.session, file.file)
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await fs.copyFile(file.abs, destination)
      await fs.chmod(destination, 0o600).catch(() => {})
    }
  }

  async writeMirrorDocs() {
    const readme = path.join(this.repoDir, 'README.md')
    if (!(await pathExists(readme))) {
      await fs.writeFile(
        readme,
        [
          '# DSH session mirror',
          '',
          'This repository is written by the `dsh-sync` plugin for DeepSeek Harness.',
          'It mirrors `$DSH_HOME/sessions` so sessions can move between devices.',
          '',
          '- `sync push` copies local session logs here and pushes the branch.',
          '- `sync pull` fast-forwards this mirror and copies sessions that are not',
          '  present on the local device (existing local sessions are never replaced).',
          '',
        ].join('\n'),
        'utf8',
      )
    }
    const ignore = path.join(this.repoDir, '.gitignore')
    if (!(await pathExists(ignore))) {
      await fs.writeFile(ignore, '*.lock\n.DS_Store\n', 'utf8')
    }
  }

  async flushSessions() {
    try {
      await this.flush()
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`dsh-sync: session flush before push failed: ${message}`)
      return message
    }
  }

  /**
   * Copy local session logs into the mirror, commit, and push.
   *
   * A rejected non-fast-forward push is retried once against a freshly fetched
   * remote; local files win for session logs that exist on both sides.
   */
  async push() {
    return this.enqueue(async () => {
      const settings = await this.readSettings()
      if (settings.remote === '') {
        return { ok: false, code: 'not-configured', message: 'Set a git repository URL first.' }
      }
      const flushWarning = await this.flushSessions()
      await this.ensureRepository(settings)
      const localFiles = await this.collectSessionFiles(this.sessionsRoot)
      const local = summarize(localFiles)
      const stamp = new Date().toISOString()

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { remoteHasBranch } = await this.fetchRemoteBranch(settings)

        await runGit(['reset', '--hard'], { cwd: this.repoDir, allowFailure: true })
        await runGit(['clean', '-fd'], { cwd: this.repoDir })
        if (remoteHasBranch) {
          await runGit(['checkout', '-B', settings.branch, `origin/${settings.branch}`], { cwd: this.repoDir })
        } else {
          await runGit(['checkout', '-B', settings.branch], { cwd: this.repoDir })
        }

        await this.writeMirrorFiles(localFiles)
        await this.writeMirrorDocs()
        await runGit(['add', '-A'], { cwd: this.repoDir })

        const porcelain = await runGit(['status', '--porcelain'], { cwd: this.repoDir })
        let changed = porcelain.stdout.trim() !== ''
        if (changed) {
          await runGit(
            ['commit', '-m', `sync: ${os.hostname()} ${stamp}`],
            { cwd: this.repoDir },
          )
        } else if (!remoteHasBranch) {
          // An empty session store still needs one commit so the branch exists.
          await runGit(
            ['commit', '--allow-empty', '-m', `init: ${os.hostname()} ${stamp}`],
            { cwd: this.repoDir },
          )
          changed = true
        }

        if (remoteHasBranch && !changed) {
          const summary = `already up to date (${local.sessions} sessions)`
          await this.recordState({
            lastPushAt: new Date().toISOString(),
            lastPushOk: true,
            lastPushSummary: summary,
            lastError: null,
          })
          return {
            ok: true,
            pushed: false,
            changed: false,
            sessions: local.sessions,
            files: local.files,
            warning: flushWarning,
          }
        }

        const pushed = await runGit(['push', 'origin', `HEAD:${settings.branch}`], {
          cwd: this.repoDir,
          allowFailure: true,
        })
        if (pushed.ok) {
          const summary = `pushed ${local.sessions} sessions (${local.files} files)`
          await this.recordState({
            lastPushAt: new Date().toISOString(),
            lastPushOk: true,
            lastPushSummary: summary,
            lastError: null,
          })
          return {
            ok: true,
            pushed: true,
            changed,
            sessions: local.sessions,
            files: local.files,
            warning: flushWarning,
          }
        }

        const race = /non-fast-forward|fetch first|\[rejected\]|remote rejected/i.test(
          `${pushed.stderr}\n${pushed.stdout}`,
        )
        if (attempt === 0 && race) continue
        const message = gitMessage(pushed)
        await this.recordState({
          lastPushAt: new Date().toISOString(),
          lastPushOk: false,
          lastPushSummary: null,
          lastError: message,
        })
        throw new SyncFailure(message, pushed)
      }

      throw new SyncFailure('git push failed after retrying.')
    })
  }

  /**
   * Fast-forward the mirror and copy sessions that do not exist locally.
   * Existing local logs always win; the skipped count is reported so the user
   * knows a manual merge may be needed.
   */
  async pull() {
    return this.enqueue(async () => {
      const settings = await this.readSettings()
      if (settings.remote === '') {
        return { ok: false, code: 'not-configured', message: 'Set a git repository URL first.' }
      }
      await this.ensureRepository(settings)
      const { remoteHasBranch } = await this.fetchRemoteBranch(settings)
      if (!remoteHasBranch) {
        return {
          ok: false,
          code: 'empty-remote',
          message: 'The remote repository has no session branch yet. Run push on a device first.',
        }
      }

      await runGit(['reset', '--hard'], { cwd: this.repoDir, allowFailure: true })
      await runGit(['clean', '-fd'], { cwd: this.repoDir })
      await runGit(['checkout', '-B', settings.branch, `origin/${settings.branch}`], { cwd: this.repoDir })
      await runGit(['reset', '--hard', `origin/${settings.branch}`], { cwd: this.repoDir })

      const mirrorFiles = await this.collectSessionFiles(path.join(this.repoDir, 'sessions'))
      const addedSessions = new Set()
      let addedFiles = 0
      let skippedFiles = 0

      for (const file of mirrorFiles) {
        const destination = path.join(this.sessionsRoot, file.project, file.session, file.file)
        if (await pathExists(destination)) {
          skippedFiles += 1
          continue
        }
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
        await fs.copyFile(file.abs, destination)
        await fs.chmod(destination, 0o600).catch(() => {})
        addedFiles += 1
        addedSessions.add(`${file.project}/${file.session}`)
      }

      const summary = `pulled ${addedSessions.size} sessions (${addedFiles} files), skipped ${skippedFiles} existing`
      await this.recordState({
        lastPullAt: new Date().toISOString(),
        lastPullOk: true,
        lastPullSummary: summary,
        lastError: null,
      })
      return {
        ok: true,
        addedSessions: addedSessions.size,
        addedFiles,
        skippedFiles,
      }
    })
  }

  /** Probe a remote without saving it. */
  async test(remote) {
    let normalized
    try {
      normalized = validateRemote(remote)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const result = await runGit(['ls-remote', '--heads', normalized], {
      cwd: this.home,
      allowFailure: true,
      timeout: TEST_TIMEOUT_MS,
    })
    if (!result.ok) return { ok: false, message: gitMessage(result) }
    const branches = result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((ref) => typeof ref === 'string' && ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .filter((name) => name !== '')
    return { ok: true, branches }
  }
}
