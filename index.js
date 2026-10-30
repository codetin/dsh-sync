/**
 * Host half of `dsh-sync`.
 *
 * Responsibilities:
 * - own the git mirror engine (`lib/sync.js`);
 * - register the human `/sync` command;
 * - expose the same operations to the Settings page through a Remote service.
 *
 * The browser half only renders the settings page; every operation lives here
 * so the command line and the page cannot disagree.
 */
import os from 'node:os'
import path from 'node:path'
import { SessionGitSync, validateBranch } from './lib/sync.js'
import { registerRemoteService } from './lib/remote.js'

const SERVICE_KEY = 'dshSync'
const NAMESPACE = 'dsh-sync'

/** The command needs the registry; without it the plugin has nothing to do. */
export const inject = ['commands']

function formatTime(value) {
  if (!value) return '无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatStatus(status) {
  const lines = [
    'DSH 会话 Git 同步',
    `远程仓库: ${status.remote || '（未配置，在 设置 → 插件 → 会话 Git 同步 中填写）'}`,
    `分支: ${status.branch}`,
    `本地会话: ${status.local.sessions} 个会话 / ${status.local.files} 个文件`,
    `镜像仓库: ${status.mirror.initialized
      ? `${status.mirror.sessions} 个会话 / ${status.mirror.files} 个文件`
      : '尚未初始化（首次 /sync push 时创建）'}`,
  ]
  if (status.state.lastPushAt) {
    lines.push(`上次推送: ${formatTime(status.state.lastPushAt)} ${status.state.lastPushOk === false ? '失败' : '成功'}`)
  }
  if (status.state.lastPullAt) {
    lines.push(`上次拉取: ${formatTime(status.state.lastPullAt)} ${status.state.lastPullOk === false ? '失败' : '成功'}`)
  }
  if (status.state.lastError) lines.push(`最近错误: ${status.state.lastError}`)
  lines.push('用法: /sync | /sync pull | /sync push')
  return lines.join('\n')
}

function success(text) {
  return { kind: 'success', text }
}

function failure(text) {
  return { kind: 'error', text }
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sync = new SessionGitSync({
    home,
    logger: ctx.logger,
    flush: () => ctx.get('sessionPersistence')?.flush(),
  })

  ctx.effect(() => ctx.commands.register({
    name: 'sync',
    description: '在设备之间通过 Git 同步 DSH 会话：status / pull / push',
    input: { hint: 'status | pull | push' },
    async handler(invocation) {
      const argument = String(invocation.rawInput ?? '').trim().toLowerCase()
      try {
        if (argument === '' || argument === 'status') {
          return success(formatStatus(await sync.status()))
        }
        if (argument === 'help') {
          return success([
            '/sync          查看同步状态',
            '/sync pull     拉取远程会话到本地（不覆盖本地已有会话）',
            '/sync push     把本地会话推送到 Git 远程仓库',
            '/sync test     测试已保存的 Git 地址',
          ].join('\n'))
        }
        if (argument === 'pull') {
          const result = await sync.pull()
          if (result.ok === false) return failure(`拉取失败：${result.message}`)
          return success(
            `拉取完成：新增 ${result.addedSessions} 个会话（${result.addedFiles} 个文件），`
            + `跳过 ${result.skippedFiles} 个本地已存在的文件。`,
          )
        }
        if (argument === 'push') {
          const result = await sync.push()
          if (result.ok === false) return failure(`推送失败：${result.message}`)
          const text = result.pushed
            ? `推送完成：${result.sessions} 个会话（${result.files} 个文件）。`
            : '推送完成：远程已是最新，无需更新。'
          return success(result.warning ? `${text}\n注意：${result.warning}` : text)
        }
        if (argument === 'test') {
          const settings = await sync.readSettings()
          if (!settings.remote) return failure('尚未配置 Git 地址，请先在设置页面填写。')
          const result = await sync.test(settings.remote)
          if (result.ok === false) return failure(`连接失败：${result.message}`)
          return success(`连接成功：远程有 ${result.branches.length} 个分支。`)
        }
        return failure(`未知参数 “${argument}”。用法: /sync | /sync pull | /sync push`)
      } catch (error) {
        return failure(`同步失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }), 'dsh-sync: /sync command')

  const withStatus = async (result) => {
    let status
    try {
      status = await sync.status()
    } catch {
      status = undefined
    }
    return status === undefined ? result : { ...result, status }
  }

  const dispose = registerRemoteService({
    ctx,
    serviceKey: SERVICE_KEY,
    namespace: NAMESPACE,
    methods: [
      {
        method: 'status',
        implementation: function status() {
          return sync.status()
        },
      },
      {
        method: 'save',
        implementation: async function save(remote, branch) {
          const normalizedBranch = validateBranch(branch)
          const result = await sync.save(remote, normalizedBranch)
          return withStatus(result)
        },
      },
      {
        method: 'test',
        implementation: async function test(remote) {
          return sync.test(remote)
        },
      },
      {
        method: 'pull',
        implementation: async function pull() {
          return withStatus(await sync.pull())
        },
      },
      {
        method: 'push',
        implementation: async function push() {
          return withStatus(await sync.push())
        },
      },
    ],
  })
  ctx.effect(() => dispose, 'dsh-sync: remote service')

  ctx.logger?.info?.(`dsh-sync ready: sessions=${sync.sessionsRoot}`)
}
