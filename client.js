/**
 * Browser half of `dsh-sync`.
 *
 * Adds one page under Settings → 会话 Git 同步 (Settings → Session Git Sync).
 * The page writes the repository URL and branch, and triggers pull/push through
 * the host Remote service registered by `index.js`. All session bytes and git
 * work stay on the host; this module only renders state and calls endpoints.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-sync'

    const ZH = {
      nav: '会话 Git 同步',
      title: '会话 Git 同步',
      subtitle: '把本机的 DSH 会话镜像到一个 Git 仓库，在多个设备之间共享。拉取只新增本地不存在的会话，不会覆盖本地已有会话。',
      remoteLabel: 'Git 仓库地址',
      remotePlaceholder: 'https://example.com/user/dsh-sessions.git',
      branchLabel: '分支',
      branchPlaceholder: 'main',
      save: '保存',
      test: '测试连接',
      pull: '从远程拉取',
      push: '推送到远程',
      refresh: '刷新状态',
      unsaved: '有未保存的修改；拉取或推送前会自动保存。',
      saved: '已保存 Git 地址。',
      statusTitle: '同步状态',
      commandsTitle: '命令',
      cmdStatus: '查看同步状态',
      cmdPull: '拉取远程会话到本地',
      cmdPush: '把本地会话推送到远程',
      cmdTest: '测试连接',
      remoteStatus: '远程仓库',
      branchStatus: '分支',
      localStatus: '本地会话 / 文件',
      mirrorStatus: '镜像仓库',
      lastPush: '上次推送',
      lastPull: '上次拉取',
      dataDir: '本地会话目录',
      repoDir: '镜像仓库目录',
      notConfigured: '未配置',
      mirrorMissing: '尚未初始化（首次推送时创建）',
      never: '从未',
      refreshed: '状态已刷新。',
      loading: '正在读取同步状态…',
      failed: '操作失败。',
      pullDone: '拉取完成：新增 {sessions} 个会话（{files} 个文件），跳过 {skipped} 个本地已存在的文件。',
      pushDone: '推送完成：{sessions} 个会话（{files} 个文件）。',
      pushNoChanges: '推送完成：远程已是最新，无需更新。',
      testOk: '连接成功：远程有 {branches} 个分支。',
      testBranchMissing: '连接成功，但远程还没有分支 “{branch}”；第一次推送会创建它。',
      noRpc: '浏览器连接服务不可用，设置页面无法调用宿主。',
      loadFailed: '无法读取同步状态',
    }

    const EN = {
      nav: 'Session Git Sync',
      title: 'Session Git Sync',
      subtitle: 'Mirror this device’s DSH sessions into a git repository and share them across devices. Pull only adds sessions missing locally; it never overwrites an existing local session.',
      remoteLabel: 'Git repository URL',
      remotePlaceholder: 'https://example.com/user/dsh-sessions.git',
      branchLabel: 'Branch',
      branchPlaceholder: 'main',
      save: 'Save',
      test: 'Test connection',
      pull: 'Pull from remote',
      push: 'Push to remote',
      refresh: 'Refresh status',
      unsaved: 'Unsaved changes; pull or push saves them first.',
      saved: 'Git URL saved.',
      statusTitle: 'Sync status',
      commandsTitle: 'Commands',
      cmdStatus: 'show sync status',
      cmdPull: 'copy remote sessions to this device',
      cmdPush: 'push local sessions to the remote',
      cmdTest: 'test the connection',
      remoteStatus: 'Remote',
      branchStatus: 'Branch',
      localStatus: 'Local sessions / files',
      mirrorStatus: 'Mirror',
      lastPush: 'Last push',
      lastPull: 'Last pull',
      dataDir: 'Local session directory',
      repoDir: 'Mirror directory',
      notConfigured: 'Not configured',
      mirrorMissing: 'Not initialized (created by the first push)',
      never: 'Never',
      refreshed: 'Status refreshed.',
      loading: 'Reading sync status…',
      failed: 'The operation failed.',
      pullDone: 'Pulled {sessions} new sessions ({files} files); skipped {skipped} files that already exist locally.',
      pushDone: 'Pushed {sessions} sessions ({files} files).',
      pushNoChanges: 'Push complete: the remote is already up to date.',
      testOk: 'Connected: the remote has {branches} branches.',
      testBranchMissing: 'Connected, but the remote has no branch “{branch}” yet; the first push creates it.',
      noRpc: 'The browser connection service is unavailable, so this page cannot reach the host.',
      loadFailed: 'Could not read sync status',
    }

    const CSS = `
.dshsync { display: flex; flex-direction: column; gap: 16px; max-width: 760px; padding: 4px 0 24px; }
.dshsync-header { display: flex; flex-direction: column; gap: 6px; }
.dshsync-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshsync-subtitle { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dshsync-card { display: flex; flex-direction: column; gap: 14px; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dshsync-field { display: flex; flex-direction: column; gap: 6px; }
.dshsync-row { display: flex; gap: 10px; }
.dshsync-grow { flex: 1 1 auto; min-width: 0; }
.dshsync-branch { width: 170px; flex: 0 0 auto; }
.dshsync-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dshsync-input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; }
.dshsync-input::placeholder { color: var(--dsw-alias-state-idle-primary); }
.dshsync-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dshsync-input:disabled { opacity: 0.6; }
.dshsync-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dshsync-btn { height: 32px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1; cursor: pointer; }
.dshsync-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dshsync-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshsync-btn:disabled { opacity: 0.45; cursor: default; }
.dshsync-btn-primary { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.dshsync-btn-ghost { color: var(--dsw-alias-label-secondary); border-color: transparent; }
.dshsync-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
.dshsync-notice { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.dshsync-notice-ok { color: var(--dsw-alias-state-success-primary); }
.dshsync-notice-error { color: var(--dsw-alias-state-error-primary); }
.dshsync-notice-info { color: var(--dsw-alias-label-secondary); }
.dshsync-section-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshsync-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: 13px; }
.dshsync-k { margin: 0; color: var(--dsw-alias-label-secondary); }
.dshsync-v { margin: 0; color: var(--dsw-alias-label-primary); word-break: break-all; }
.dshsync-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshsync-commands { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshsync-commands li { display: flex; gap: 8px; align-items: baseline; }
.dshsync-commands code { padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dshsync-empty { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
`

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    function errorText(error) {
      if (error instanceof Error && error.message) return error.message
      return String(error)
    }

    function timeText(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    function useLocaleTick(locale) {
      const [, setVersion] = React.useState(0)
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setVersion((value) => value + 1))
      }, [locale])
    }

    function createRpc(connection) {
      const rpc = connection && connection.rpc
      const call = async (method, args) => {
        if (!rpc || typeof rpc.call !== 'function') {
          throw new Error('Browser connection.rpc is unavailable.')
        }
        const response = await rpc.call('/api', `dsh-sync/${method}`, { args: args || {} })
        if (!response || response.ok !== true) {
          const detail = response && response.error
          const message = typeof detail === 'string'
            ? detail
            : (detail && detail.message) || 'The host did not answer.'
          throw new Error(message)
        }
        return response.value
      }
      return {
        status: () => call('status'),
        save: (remote, branch) => call('save', { remote, branch }),
        test: (remote) => call('test', { remote }),
        pull: () => call('pull'),
        push: () => call('push'),
      }
    }

    function Section(props) {
      const { t, rpc, locale } = props
      const [snapshot, setSnapshot] = React.useState(null)
      const [remote, setRemote] = React.useState('')
      const [branch, setBranch] = React.useState('main')
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      useLocaleTick(locale)

      React.useEffect(() => {
        let alive = true
        setBusy('load')
        Promise.resolve()
          .then(() => rpc.status())
          .then((value) => {
            if (!alive) return
            setSnapshot(value)
            setRemote(value.remote || '')
            setBranch(value.branch || 'main')
          })
          .catch((error) => {
            if (alive) setNotice({ kind: 'error', text: `${t('loadFailed')}: ${errorText(error)}` })
          })
          .finally(() => {
            if (alive) setBusy('')
          })
        return () => { alive = false }
      }, [rpc])

      const perform = async (name, task) => {
        setBusy(name)
        setNotice(null)
        try {
          const result = await task()
          if (result && result.status) setSnapshot(result.status)
          if (result && result.ok === false) {
            setNotice({ kind: 'error', text: result.message || t('failed') })
            return result
          }
          return result
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error) })
          return undefined
        } finally {
          setBusy('')
        }
      }

      const saveFirst = async () => {
        if (!dirty) return true
        setBusy('save')
        try {
          const saved = await rpc.save(remote.trim(), branch.trim())
          if (saved && saved.status) setSnapshot(saved.status)
          if (saved && saved.ok === false) {
            setNotice({ kind: 'error', text: saved.message || t('failed') })
            return false
          }
          setDirty(false)
          setRemote(saved && saved.settings ? saved.settings.remote : remote.trim())
          setBranch(saved && saved.settings ? saved.settings.branch : branch.trim())
          return true
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error) })
          return false
        } finally {
          setBusy('')
        }
      }

      const onSave = async () => {
        const result = await perform('save', () => rpc.save(remote.trim(), branch.trim()))
        if (!result || result.ok === false) return
        setDirty(false)
        if (result.settings) {
          setRemote(result.settings.remote)
          setBranch(result.settings.branch)
        }
        setNotice({ kind: 'ok', text: t('saved') })
      }

      const onTest = async () => {
        const result = await perform('test', () => rpc.test(remote.trim()))
        if (!result || result.ok === false) return
        const wanted = branch.trim() || 'main'
        const branches = Array.isArray(result.branches) ? result.branches : []
        setNotice({
          kind: branches.includes(wanted) ? 'ok' : 'info',
          text: branches.includes(wanted)
            ? format(t('testOk'), { branches: branches.length })
            : format(t('testBranchMissing'), { branch: wanted }),
        })
      }

      const onPull = async () => {
        const saved = await saveFirst()
        if (!saved) return
        const result = await perform('pull', () => rpc.pull())
        if (!result || result.ok === false) return
        setNotice({
          kind: 'ok',
          text: format(t('pullDone'), {
            sessions: result.addedSessions || 0,
            files: result.addedFiles || 0,
            skipped: result.skippedFiles || 0,
          }),
        })
      }

      const onPush = async () => {
        const saved = await saveFirst()
        if (!saved) return
        const result = await perform('push', () => rpc.push())
        if (!result || result.ok === false) return
        const base = result.pushed
          ? format(t('pushDone'), { sessions: result.sessions || 0, files: result.files || 0 })
          : t('pushNoChanges')
        setNotice({ kind: 'ok', text: result.warning ? `${base}\n${result.warning}` : base })
      }

      const onRefresh = async () => {
        setBusy('refresh')
        try {
          const value = await rpc.status()
          setSnapshot(value)
          if (!dirty) {
            setRemote(value.remote || '')
            setBranch(value.branch || 'main')
          }
          setNotice({ kind: 'info', text: t('refreshed') })
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error) })
        } finally {
          setBusy('')
        }
      }

      const disabled = busy !== ''
      const state = snapshot && snapshot.state ? snapshot.state : {}
      const local = snapshot && snapshot.local ? snapshot.local : { sessions: 0, files: 0 }
      const mirror = snapshot && snapshot.mirror ? snapshot.mirror : { initialized: false, sessions: 0, files: 0 }

      const row = (key, label, value, mono) => [
        h('dt', { className: 'dshsync-k', key: `${key}-k` }, label),
        h('dd', { className: `dshsync-v${mono ? ' dshsync-mono' : ''}`, key: `${key}-v` }, value),
      ]

      return h('div', { className: 'dshsync' },
        h('style', { key: 'style' }, CSS),
        h('header', { className: 'dshsync-header', key: 'header' },
          h('h2', { className: 'dshsync-title' }, t('title')),
          h('p', { className: 'dshsync-subtitle' }, t('subtitle')),
        ),
        h('section', { className: 'dshsync-card', key: 'config' },
          h('div', { className: 'dshsync-row' },
            h('div', { className: 'dshsync-field dshsync-grow' },
              h('label', { className: 'dshsync-label', htmlFor: 'dshsync-remote' }, t('remoteLabel')),
              h('input', {
                id: 'dshsync-remote',
                className: 'dshsync-input',
                type: 'text',
                value: remote,
                placeholder: t('remotePlaceholder'),
                spellCheck: false,
                autoCapitalize: 'off',
                autoCorrect: 'off',
                disabled: busy === 'save',
                onChange: (event) => {
                  setRemote(event.target.value)
                  setDirty(true)
                },
              }),
            ),
            h('div', { className: 'dshsync-field dshsync-branch' },
              h('label', { className: 'dshsync-label', htmlFor: 'dshsync-branch' }, t('branchLabel')),
              h('input', {
                id: 'dshsync-branch',
                className: 'dshsync-input',
                type: 'text',
                value: branch,
                placeholder: t('branchPlaceholder'),
                spellCheck: false,
                autoCapitalize: 'off',
                autoCorrect: 'off',
                disabled: busy === 'save',
                onChange: (event) => {
                  setBranch(event.target.value)
                  setDirty(true)
                },
              }),
            ),
          ),
          h('div', { className: 'dshsync-actions' },
            h('button', { type: 'button', className: 'dshsync-btn dshsync-btn-primary', onClick: onSave, disabled }, t('save')),
            h('button', { type: 'button', className: 'dshsync-btn', onClick: onTest, disabled }, t('test')),
            h('button', { type: 'button', className: 'dshsync-btn', onClick: onPull, disabled }, t('pull')),
            h('button', { type: 'button', className: 'dshsync-btn', onClick: onPush, disabled }, t('push')),
            h('button', { type: 'button', className: 'dshsync-btn dshsync-btn-ghost', onClick: onRefresh, disabled }, t('refresh')),
          ),
          dirty ? h('p', { className: 'dshsync-hint' }, t('unsaved')) : null,
          notice ? h('p', {
            className: `dshsync-notice dshsync-notice-${notice.kind}`,
            role: 'status',
            'aria-live': 'polite',
          }, notice.text) : null,
        ),
        h('section', { className: 'dshsync-card', key: 'status' },
          h('h3', { className: 'dshsync-section-title' }, t('statusTitle')),
          snapshot === null
            ? h('p', { className: 'dshsync-empty' }, t('loading'))
            : h('dl', { className: 'dshsync-grid' },
              row('remote', t('remoteStatus'), snapshot.remote || t('notConfigured')),
              row('branch', t('branchStatus'), snapshot.branch),
              row('local', t('localStatus'), `${local.sessions} / ${local.files}`),
              row('mirror', t('mirrorStatus'), mirror.initialized
                ? `${mirror.sessions} / ${mirror.files}`
                : t('mirrorMissing')),
              row('push', t('lastPush'), state.lastPushAt
                ? `${timeText(state.lastPushAt)}${state.lastPushOk === false ? ' ✕' : ''}`
                : t('never')),
              row('pull', t('lastPull'), state.lastPullAt
                ? `${timeText(state.lastPullAt)}${state.lastPullOk === false ? ' ✕' : ''}`
                : t('never')),
              row('sessionsRoot', t('dataDir'), snapshot.sessionsRoot, true),
              row('repoDir', t('repoDir'), snapshot.repoDir, true),
            ),
        ),
        h('section', { className: 'dshsync-card', key: 'commands' },
          h('h3', { className: 'dshsync-section-title' }, t('commandsTitle')),
          h('ul', { className: 'dshsync-commands' },
            h('li', { key: 'status' }, h('code', null, '/sync'), h('span', null, t('cmdStatus'))),
            h('li', { key: 'pull' }, h('code', null, '/sync pull'), h('span', null, t('cmdPull'))),
            h('li', { key: 'push' }, h('code', null, '/sync push'), h('span', null, t('cmdPush'))),
            h('li', { key: 'test' }, h('code', null, '/sync test'), h('span', null, t('cmdTest'))),
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh: ZH, en: EN }),
        `${NS}: locale dictionaries`,
      )
      const t = ctx.locale.bind(NS)
      const connection = ctx.get('connection')
      const rpc = createRpc(connection)
      if (!connection || !connection.rpc) {
        ctx.logger?.warn?.(`${NS}: connection.rpc is unavailable; the settings page cannot call the host`)
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 55,
        label: () => t('nav'),
      }, function SyncSettingsPage(ownerProps) {
        return h(Section, { ...ownerProps, t, rpc, locale: ctx.locale })
      }))
    }

    return { inject: ['slots', 'locale', 'connection'], apply }
  },
})
