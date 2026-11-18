/**
 * dsh-atomcode 浏览器端：左侧边栏入口 + 主面板（登录状态 / 套餐 / 额度窗口 / 近 60 天用量）。
 *
 * 产物是 DSH 的「客户端半」：模块加载器在 boot 时按 `dsh.client` 声明把它当脚本执行，
 * 由 factory 交出 `{ name, inject, apply }`。这里不引入构建链，直接写
 * `React.createElement`，样式用内联 style + 宿主主题变量。
 *
 * @module dsh-atomcode/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-atomcode',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 侧边栏按钮 id，同时是 main 面板的 key —— 宿主靠这两个同名值配对。 */
    const PANEL_ID = 'dsh-atomcode'

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    // ---------------------------------------------------------------- format

    function fmtInt(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return n.toLocaleString('zh-CN')
    }

    function fmtCompact(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
      if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
      return String(n)
    }

    function fmtDuration(seconds) {
      const s = Number(seconds)
      if (!Number.isFinite(s) || s <= 0) return '已重置'
      const d = Math.floor(s / 86400)
      const hours = Math.floor((s % 86400) / 3600)
      const mins = Math.floor((s % 3600) / 60)
      if (d > 0) return `${d} 天 ${hours} 小时`
      if (hours > 0) return `${hours} 小时 ${mins} 分`
      return `${mins} 分`
    }

    function clampPercent(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return 0
      return Math.min(100, Math.max(0, n))
    }

    function percentColor(percent) {
      if (percent >= 95) return T.err
      if (percent >= 75) return T.warn
      return T.brand
    }

    // ------------------------------------------------------------------ api

    async function getJson(path) {
      const res = await fetch(path, { headers: { Accept: 'application/json' } })
      const text = await res.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${res.status}：响应不是 JSON`)
      }
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      return body
    }

    function postJson(path) {
      return fetch(path, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }).then(async res => {
        const text = await res.text()
        const body = text === '' ? {} : JSON.parse(text)
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
        return body
      })
    }

    /** 状态 + 用量一起取；60 秒轮询，页面切走时停。 */
    function useAtomCodeData() {
      const [data, setData] = React.useState({ loading: true, status: null, usage: null, error: null })
      const [tick, setTick] = React.useState(0)

      const load = React.useCallback(async () => {
        setData(prev => ({ ...prev, loading: true }))
        try {
          const [status, usage] = await Promise.all([
            getJson('/api/atomcode/status'),
            getJson('/api/atomcode/usage').catch(() => null),
          ])
          setData({ loading: false, status, usage, error: null })
        } catch (error) {
          setData(prev => ({ ...prev, loading: false, error: String(error?.message ?? error) }))
        }
      }, [])

      React.useEffect(() => {
        void load()
        const poll = setInterval(() => void load(), 60_000)
        const clock = setInterval(() => setTick(n => n + 1), 30_000)
        return () => {
          clearInterval(poll)
          clearInterval(clock)
        }
      }, [load])

      return { ...data, tick, reload: load }
    }

    // ------------------------------------------------------------ primitives

    function Card(props) {
      return h(
        'div',
        {
          style: {
            background: T.surface,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: '14px 16px',
            minWidth: 0,
          },
        },
        props.children,
      )
    }

    function SectionTitle(props) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, margin: '22px 0 10px' } },
        h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600, color: T.text } }, props.title),
        props.extra === undefined ? null : h('div', { style: { fontSize: 12, color: T.dim } }, props.extra),
      )
    }

    function Label(props) {
      return h('div', { style: { fontSize: 12, color: T.dim, marginBottom: 6 } }, props.children)
    }

    function Pill(props) {
      const color = props.color ?? T.dim
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            color,
            background: 'transparent',
            border: `1px solid ${color}`,
          },
        },
        h('span', { style: { width: 6, height: 6, borderRadius: 3, background: color } }),
        props.children,
      )
    }

    function ProgressBar(props) {
      const percent = clampPercent(props.percent)
      const color = props.color ?? percentColor(percent)
      return h(
        'div',
        {
          style: {
            position: 'relative',
            height: props.height ?? 8,
            borderRadius: 999,
            background: T.surface2,
            overflow: 'hidden',
          },
        },
        h('div', {
          style: {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${percent}%`,
            borderRadius: 999,
            background: color,
            transition: 'width 240ms ease',
          },
        }),
      )
    }

    function Stat(props) {
      return h(
        Card,
        null,
        h(Label, null, props.label),
        h('div', { style: { fontSize: 20, fontWeight: 600, color: T.text, lineHeight: '28px' } }, props.value),
        props.hint === undefined ? null : h('div', { style: { marginTop: 6, fontSize: 12, color: T.dim } }, props.hint),
        props.children,
      )
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: props.disabled === true,
          style: {
            appearance: 'none',
            border: `1px solid ${T.border}`,
            background: props.primary === true ? T.brand : 'transparent',
            color: props.primary === true ? '#fff' : T.text,
            borderRadius: 8,
            padding: '6px 12px',
            fontSize: 12,
            cursor: props.disabled === true ? 'default' : 'pointer',
            opacity: props.disabled === true ? 0.55 : 1,
          },
        },
        props.children,
      )
    }

    /** 60 天柱状图：每天一根，高度按最大值归一；悬停看明细。 */
    function UsageChart(props) {
      const rows = props.rows ?? []
      if (rows.length === 0) {
        return h('div', { style: { color: T.dim, fontSize: 12, padding: '18px 0' } }, '暂无用量数据')
      }
      const max = Math.max(1, ...rows.map(row => Number(row.total_tokens) || 0))
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 150, paddingTop: 8 } },
        rows.map(row => {
          const total = Number(row.total_tokens) || 0
          const ratio = total / max
          const height = total === 0 ? 2 : Math.max(3, Math.round(ratio * 140))
          return h('div', {
            key: row.date,
            title: `${row.date}\n${fmtInt(row.total_counts)} 次调用\n${fmtInt(total)} tokens`,
            style: {
              flex: '1 1 0',
              height,
              minWidth: 2,
              borderRadius: 2,
              background: total === 0 ? T.border : T.brand,
              opacity: total === 0 ? 1 : 0.35 + ratio * 0.65,
            },
          })
        }),
      )
    }

    function ModelTable(props) {
      const counts = props.counts ?? {}
      const tokens = props.tokens ?? {}
      const names = props.models ?? []
      if (names.length === 0) return null
      const rows = names.map(name => ({
        name,
        count: Number(counts[name]) || 0,
        token: Number(tokens[name]) || 0,
      }))
      const totalTokens = rows.reduce((sum, row) => sum + row.token, 0) || 1
      return h(
        'div',
        { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
        rows.map(row => {
          const share = (row.token / totalTokens) * 100
          return h(
            'div',
            { key: row.name, style: { display: 'grid', gridTemplateColumns: '160px 1fr 92px 92px', gap: 10, alignItems: 'center', fontSize: 12 } },
            h('div', { style: { color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name),
            h(ProgressBar, { percent: share, height: 6 }),
            h('div', { style: { color: T.dim, textAlign: 'right' } }, `${fmtInt(row.count)} 次`),
            h('div', { style: { color: T.dim, textAlign: 'right' } }, `${fmtCompact(row.token)} tok`),
          )
        }),
      )
    }

    /** 窗口额度行：调用次数 + 进度 + 重置倒计时。 */
    function WindowRow(props) {
      const win = props.window ?? {}
      const limit = Number(win.call_limit) || 0
      const used = Number(win.calls_used) || 0
      const percent = win.usage_percent !== undefined && win.usage_percent !== null
        ? Number(win.usage_percent)
        : limit > 0
          ? (used / limit) * 100
          : 0
      const color = win.quota_exhausted === true ? T.err : percentColor(percent)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 } },
          h('div', { style: { color: T.text } },
            h('span', { style: { fontWeight: 600 } }, `${used} / ${limit}`),
            h('span', { style: { color: T.dim } }, ` 次调用 · ${Number(win.window_hours) || 5} 小时窗口`)),
          h('div', { style: { color: color } },
            win.quota_exhausted === true
              ? '额度耗尽'
              : `${clampPercent(percent).toFixed(1)}% · ${fmtDuration(win.seconds_until_reset)}后重置`),
        ),
        h(ProgressBar, { percent, color }),
        win.reset_label === undefined
          ? null
          : h('div', { style: { fontSize: 11, color: T.dim } }, `${win.reset_label}${win.reset_at_display ? `（${win.reset_at_display}）` : ''}`),
      )
    }

    // ----------------------------------------------------------------- page

    function PanelPage() {
      const { loading, status, usage, error, reload } = useAtomCodeData()
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const user = status?.user
      const plan = status?.plan && status.plan.error === undefined ? status.plan : null
      const free = plan?.codingplan_free ?? null
      const current = plan?.current_usage ?? null
      const windows = Array.isArray(plan?.rate_limit_windows) ? plan.rate_limit_windows : []

      const act = async (kind, path) => {
        setBusy(kind)
        setNotice(null)
        try {
          const result = await postJson(path)
          setNotice({ kind: 'ok', text: result?.message ?? '完成' })
          await reload()
        } catch (error) {
          setNotice({ kind: 'err', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const openLogin = async () => {
        setBusy('login')
        setNotice(null)
        try {
          const result = await postJson('/api/atomcode/login')
          if (result?.url) {
            window.open(result.url, '_blank', 'noopener')
            setNotice({ kind: 'ok', text: '已打开登录页，完成后点「刷新」' })
          } else if (result?.status === 'error') {
            setNotice({ kind: 'err', text: result.error ?? '登录失败' })
          } else {
            setNotice({ kind: 'ok', text: '登录完成' })
          }
          await reload()
        } catch (error) {
          setNotice({ kind: 'err', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const remaining = free?.expires_at
        ? Math.max(0, Math.ceil((new Date(`${free.expires_at}T23:59:59`).getTime() - Date.now()) / 86_400_000))
        : null

      /** 窗口调用配额：优先用 rate_limit_windows（按次），tokens 走 current_usage。 */
      const windowCalls = windows.find(win => typeof win.calls_used === 'number') ?? null
      const callLimit = windowCalls?.call_limit ?? null
      const callsUsed = windowCalls?.calls_used ?? null
      const tokenLimit = current?.window_token_limit ?? null
      const tokensUsed = current?.window_tokens_used ?? null
      const windowResetAt = windowCalls?.seconds_until_reset ?? current?.seconds_until_reset

      const identity = user
        ? `${user.name ?? user.username ?? '已登录'}${user.username ? ` · @${user.username}` : ''}`
        : '未登录'

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            background: T.bg,
            color: T.text,
            padding: '20px 24px 40px',
            boxSizing: 'border-box',
            font: '13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          },
        },
        h(
          'div',
          { style: { maxWidth: 1080, margin: '0 auto' } },

          // header
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap' } },
            h(
              'div',
              null,
              h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 650 } }, 'AtomGit AtomCode'),
              h('div', { style: { marginTop: 4, fontSize: 12, color: T.dim } },
                'CodingPlan 登录态、套餐额度与近 60 天用量。数据来自 api.gitcode.com/api/v5。'),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h(Button, { onClick: reload, disabled: loading }, loading ? '刷新中…' : '刷新'),
              h(Button, { onClick: () => act('claim', '/api/atomcode/claim'), disabled: busy !== '' || status?.authenticated !== true }, busy === 'claim' ? '领取中…' : '领取套餐'),
              status?.authenticated === true
                ? h(Button, { onClick: () => act('logout', '/api/atomcode/logout'), disabled: busy !== '' }, '退出登录')
                : h(Button, { primary: true, onClick: openLogin, disabled: busy !== '' }, busy === 'login' ? '等待登录…' : '登录'),
            ),
          ),

          error === null ? null : h(
            'div',
            { style: { marginTop: 12, padding: '8px 12px', borderRadius: 8, border: `1px solid ${T.err}`, color: T.err, fontSize: 12 } },
            error,
          ),
          notice === null ? null : h(
            'div',
            {
              style: {
                marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: 12,
                border: `1px solid ${notice.kind === 'ok' ? T.ok : T.err}`,
                color: notice.kind === 'ok' ? T.ok : T.err,
              },
            },
            notice.text,
          ),

          // stat grid
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 16 } },
            h(
              Stat,
              {
                label: '账号',
                value: identity,
                hint: status?.authFile ?? '未读到本地登录态文件',
              },
              h('div', { style: { marginTop: 10 } },
                status?.authenticated === true
                  ? h(Pill, { color: T.ok }, '已登录')
                  : h(Pill, { color: T.idle }, '未登录')),
            ),
            h(
              Stat,
              {
                label: '套餐',
                value: free?.plan_name ?? '未领取',
                hint: free?.expires_at
                  ? `${free.claimed_at ?? '—'} → ${free.expires_at}${remaining === null ? '' : ` · 剩余 ${remaining} 天`}`
                  : '在 AtomGit 领取 CodingPlan Lite / Pro',
              },
              free === null ? null : h('div', { style: { marginTop: 10 } },
                h(Pill, { color: T.brand }, free.plan_type ?? status?.planType ?? '—')),
            ),
            h(
              Stat,
              {
                label: '本窗口调用',
                value: windowCalls === null ? '—' : `${fmtInt(callsUsed ?? 0)} / ${fmtInt(callLimit ?? 0)}`,
                hint: [
                  tokenLimit === null ? null : `tokens ${fmtInt(tokensUsed ?? 0)} / ${fmtInt(tokenLimit)}`,
                  windowResetAt === undefined ? null : `${fmtDuration(windowResetAt)}后重置`,
                ].filter(Boolean).join(' · ') || '额度窗口每 5 小时滚动',
              },
              windowCalls === null ? null : h('div', { style: { marginTop: 10 } },
                h(ProgressBar, { percent: windowCalls.usage_percent ?? 0 })),
            ),
            h(
              Stat,
              {
                label: '近 60 天用量',
                value: usage?.total_tokens === undefined ? '—' : `${fmtCompact(usage.total_tokens)} tokens`,
                hint: usage?.total_counts === undefined
                  ? '—'
                  : `${fmtInt(usage.total_counts)} 次调用 · ${usage.start_date ?? ''} → ${usage.end_date ?? ''}`,
              },
              h('div', { style: { marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                (usage?.models ?? []).map(name => h(Pill, { key: name, color: T.brand }, name))),
            ),
          ),

          // quota windows
          h(SectionTitle, {
            title: '额度窗口',
            extra: plan?.window_quota_hint ?? (plan?.audit_status === 1 ? '审核通过' : undefined),
          }),
          h(
            Card,
            null,
            windows.length === 0
              ? h('div', { style: { color: T.dim, fontSize: 12 } }, '没有可展示的限流窗口')
              : windows
                .filter(win => win.show_enable === 1 || win.show_enable === undefined)
                .map(win => h(WindowRow, { key: win.rule_index ?? win.window_size_seconds, window: win })),
          ),

          // usage
          h(SectionTitle, { title: '近 60 天用量', extra: '按天聚合，悬停看明细' }),
          h(
            Card,
            null,
            h(UsageChart, { rows: usage?.rows ?? [] }),
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: T.dim } },
              h('span', null, usage?.start_date ?? ''),
              h('span', null, usage?.end_date ?? ''),
            ),
            h(ModelTable, {
              models: usage?.models ?? [],
              counts: usage?.model_counts ?? {},
              tokens: usage?.model_tokens ?? {},
            }),
          ),

          // models + footer
          h(SectionTitle, { title: '可用模型', extra: status?.modelsSource === 'server' ? '服务端下发' : '本地种子' }),
          h(
            Card,
            null,
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr', gap: 8 } },
              (status?.models ?? []).map(model => h(
                'div',
                { key: model.id, style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
                h('div', { style: { minWidth: 150, fontWeight: 600, color: T.text } }, model.id),
                h('div', { style: { fontSize: 12, color: T.dim } },
                  `上下文 ${fmtCompact(model.contextWindow)} · 输出上限 ${fmtCompact(model.maxTokens)}`),
                model.supportsImages === true ? h(Pill, { color: T.dim }, '视觉') : null,
                (model.reasoningEfforts ?? []).map(level => h(Pill, { key: level, color: T.dim }, level)),
              )),
              (status?.models ?? []).length === 0
                ? h('div', { style: { color: T.dim, fontSize: 12 } }, '模型清单为空')
                : null,
            ),
          ),
          h(
            'div',
            { style: { marginTop: 14, fontSize: 11, color: T.dim, display: 'flex', gap: 14, flexWrap: 'wrap' } },
            h('span', null, `回环代理 ${status?.shim ?? '—'}`),
            h('span', null, `套餐档位 ${status?.planType ?? '—'}`),
            status?.expiresAt === undefined
              ? null
              : h('span', null, `登录态到期 ${new Date(status.expiresAt * 1000).toLocaleString('zh-CN')}`),
            status?.lastError === undefined ? null : h('span', { style: { color: T.warn } }, `目录刷新：${status.lastError}`),
          ),
        ),
      )
    }

    /** 侧边栏图标：一枚带缺口的六边形 + 中间一撇，表示「计量」。 */
    function PanelIcon(props) {
      const px = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { color: 'currentColor' },
        },
        h('path', {
          d: 'M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8L8 1.6Z',
          stroke: 'currentColor',
          strokeWidth: 1,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M5.6 8h4.8' , stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
        h('path', { d: 'M8 5.6v4.8', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', opacity: 0.55 }),
      )
    }

    /** 渲染兜底：数据形状意外（后端换字段、null）时不要把整页打成错误横幅。 */
    function CrashView({ error }) {
      return h('div', { style: { padding: '24px 4px', color: T.text } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '面板渲染出错'),
        h('div', { style: { fontSize: 12, color: T.dim, marginBottom: 12 } },
          '宿主接口返回的数据可能换了形状；点上方「刷新」重试，或看控制台里的堆栈。'),
        h('pre', {
          style: {
            margin: 0, padding: '10px 12px', borderRadius: 8, background: T.surface2,
            border: `1px solid ${T.border}`, color: T.err, fontSize: 11,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflow: 'auto',
          },
        }, String(error && error.stack ? error.stack : error)),
      )
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-atomcode] panel crashed:', error, info)
      }

      render() {
        if (this.state.error) return h(CrashView, { error: this.state.error })
        return this.props.children
      }
    }

    function SafePanel() {
      return h(PanelBoundary, null, h(PanelPage))
    }

    function apply(ctx) {
      try {
        ctx.slots.inject('sidebar.panellist', () => {
          try {
            return ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 60,
              label: 'AtomCode',
            }, PanelIcon)
          } catch (error) {
            console.error('[dsh-atomcode] sidebar entry failed:', error)
            return () => {}
          }
        })

        ctx.slots.inject('main', () => {
          try {
            return ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
            }, SafePanel)
          } catch (error) {
            console.error('[dsh-atomcode] main panel failed:', error)
            return () => {}
          }
        })

        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              id: PANEL_ID,
              order: 60,
              label: 'AtomCode',
            }, SafePanel)
          } catch (error) {
            console.error('[dsh-atomcode] settings section failed:', error)
            return () => {}
          }
        })
      } catch (error) {
        console.error('[dsh-atomcode] client half failed to load (host provider unaffected):', error)
      }
    }

    exports.name = 'dsh-atomcode-client'
    exports.inject = ['slots']
    exports.apply = apply
    /** 只给 test/smoke-client.mjs 用：加载器只读 name / inject / apply。 */
    exports.__internals = { PANEL_ID, PanelPage, PanelIcon, SafePanel, PanelBoundary, CrashView }
    return module.exports
  },
})