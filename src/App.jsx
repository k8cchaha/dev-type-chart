import { useState } from 'react'
import { PieChart, Pie, Cell, Tooltip } from 'recharts'
const JIRA_EMAIL     = import.meta.env.VITE_JIRA_EMAIL
const JIRA_API_TOKEN = import.meta.env.VITE_JIRA_API_TOKEN

const OP_TYPES = new Set(['OP-Bug', 'OP-Task'])

const TYPE_COLORS = {
  'Dev':       '#2a78d6',
  'Pre-Spike': '#1baf7a',
  'Spike':     '#4a3aa7',
  'Bug':       '#e87ba4',
  'OP-Task':   '#eb6834',
  'OP-Bug':    '#eda100',
  'Unknown':   '#898781',
}

const PIE_COLORS = ['#eb6834', '#2a78d6']

// ── Jira API helpers ──────────────────────────────────────────────────────────

let cachedFieldId = null

function jiraAuth() {
  return 'Basic ' + btoa(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`)
}

async function jiraGet(path, params) {
  const qs = params ? '?' + new URLSearchParams(params) : ''
  const res = await fetch('/jira' + path + qs, {
    headers: { Authorization: jiraAuth(), Accept: 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Jira ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}


async function getDevTypeFieldId() {
  if (cachedFieldId) return cachedFieldId
  const fields = await jiraGet('/rest/api/3/field')
  const f = fields.find(f => f.name === 'Dev Type')
  if (!f) throw new Error('"Dev Type" 欄位不存在，請確認 Jira 設定')
  cachedFieldId = f.id
  return f.id
}

async function searchUsers(query) {
  const users = await jiraGet('/rest/api/3/user/search', { query, maxResults: 20 })
  const active = users.filter(u => u.accountType === 'atlassian')
  const exact = active.filter(u => u.displayName.toLowerCase() === query.toLowerCase())
  return exact.length > 0 ? exact : active
}

async function fetchTasksForUser({ accountId, displayName }, days) {
  const fieldId = await getDevTypeFieldId()

  const jql = `issueType = "DEV-Task" AND assignee = "${accountId}" AND status = Done AND resolutiondate >= -${days}d ORDER BY resolutiondate DESC`

  let allIssues = []
  let nextPageToken = undefined

  while (true) {
    const params = { jql, fields: fieldId, maxResults: 100 }
    if (nextPageToken) params.nextPageToken = nextPageToken

    const result = await jiraGet('/rest/api/3/search/jql', params)
    const issues = result.issues ?? []
    allIssues = allIssues.concat(issues)

    nextPageToken = result.nextPageToken
    if (!nextPageToken || issues.length === 0) break
  }

  const counts = {}
  for (const issue of allIssues) {
    const raw = issue.fields?.[fieldId]
    const label = !raw ? 'Unknown' : (raw.value ?? String(raw))
    counts[label] = (counts[label] ?? 0) + 1
  }

  const opCount = (counts['OP-Bug'] ?? 0) + (counts['OP-Task'] ?? 0)
  return { user: displayName, accountId, days, total: allIssues.length, opCount, counts }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const [username, setUsername] = useState('')
  const [daysInput, setDaysInput] = useState('30')
  const days = Math.max(1, parseInt(daysInput) || 30)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [candidates, setCandidates] = useState([])

  async function search() {
    if (!username.trim() || loading) return
    setLoading(true)
    setError(null)
    setData(null)
    setCandidates([])
    try {
      const found = await searchUsers(username.trim())
      if (found.length === 0) throw new Error('找不到用戶：' + username.trim())
      if (found.length > 1) {
        setCandidates(found)
        return
      }
      setData(await fetchTasksForUser(found[0], days))
    } catch (e) {
      setError(e.message ?? '查詢失敗，請稍後再試')
    } finally {
      setLoading(false)
    }
  }

  async function selectCandidate(user) {
    setUsername(user.displayName)
    setCandidates([])
    setLoading(true)
    setError(null)
    setData(null)
    try {
      setData(await fetchTasksForUser(user, days))
    } catch (e) {
      setError(e.message ?? '查詢失敗，請稍後再試')
    } finally {
      setLoading(false)
    }
  }

  const opPct = data && data.total > 0 ? Math.round(data.opCount / data.total * 100) : 0

  const jiraBase = 'https://kkvideo.atlassian.net'
  const allUrl = data ? `${jiraBase}/issues/?jql=${encodeURIComponent(
    `issueType = "DEV-Task" AND assignee = "${data.accountId}" AND status = Done AND resolutiondate >= -${data.days}d ORDER BY resolutiondate DESC`
  )}` : null
  const opUrl = data ? `${jiraBase}/issues/?jql=${encodeURIComponent(
    `issueType = "DEV-Task" AND assignee = "${data.accountId}" AND status = Done AND resolutiondate >= -${data.days}d AND "Dev Type" in ("OP-Bug", "OP-Task") ORDER BY resolutiondate DESC`
  )}` : null

  const pieData = data
    ? [
        { name: 'Operation',   value: data.opCount },
        { name: '非 Operation', value: data.total - data.opCount },
      ].filter(d => d.value > 0)
    : []

  const tableRows = data
    ? Object.entries(data.counts).sort((a, b) => b[1] - a[1])
    : []

  return (
    <div className="app">
      <header className="header">
        <h1>Dev Type 分析</h1>
        <p>查看成員近期完成 DEV-Task 的 Operation 比例</p>
      </header>

      <main className="main">
        <div className="search-card">
          <div className="search-label-row">
            <label className="search-label" htmlFor="username">Jira 顯示名稱</label>
            <span className="days-picker">
              近
              <input
                type="number"
                className="days-input"
                value={daysInput}
                min={1}
                onChange={e => setDaysInput(e.target.value)}
                onBlur={() => setDaysInput(String(Math.max(1, parseInt(daysInput) || 30)))}
              />
              天
            </span>
          </div>
          <div className="search-row">
            <input
              id="username"
              className="search-input"
              type="text"
              placeholder="例：王小明"
              value={username}
              onChange={e => { setUsername(e.target.value); setCandidates([]) }}
              onKeyDown={e => e.key === 'Enter' && search()}
              autoComplete="off"
            />
            <button
              className="search-btn"
              onClick={search}
              disabled={loading || !username.trim()}
            >
              {loading ? '查詢中…' : '查詢'}
            </button>
          </div>
          {candidates.length > 0 && (
            <div className="candidates">
              <span className="candidates-hint">找到多位用戶，請選擇：</span>
              <div className="candidates-list">
                {candidates.map(u => (
                  <button
                    key={u.accountId}
                    className="candidate-btn"
                    onClick={() => selectCandidate(u)}
                  >
                    {u.displayName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && <div className="error-card">{error}</div>}

        {data && (
          <div className="results">
            <div className="result-meta">
              <span className="result-user">{data.user}</span>
              <span className="result-range">近 {data.days} 天</span>
            </div>

            <div className="stat-row">
              <StatCard label="完成任務" value={data.total} href={allUrl} />
              <StatCard label="Operation" value={data.opCount} accent href={opUrl} />
              <StatCard label="Operation 比例" value={`${opPct}%`} accent large />
            </div>

            {data.total === 0 ? (
              <div className="empty-msg">近 30 天無完成的 DEV-Task</div>
            ) : (
              <div className="viz-root">
                <div className="chart-card">
                  <PieChart width={300} height={300}>
                    <Pie
                      data={pieData}
                      cx={150} cy={150}
                      innerRadius={82} outerRadius={126}
                      dataKey="value"
                      stroke="#fcfcfb" strokeWidth={2}
                      paddingAngle={pieData.length > 1 ? 2 : 0}
                    >
                      {pieData.map((entry, i) => (
                        <Cell key={entry.name} fill={PIE_COLORS[i]} />
                      ))}
                    </Pie>

                    <text x={150} y={143} textAnchor="middle" fontSize={30} fontWeight={700} fill="#0b0b0b">
                      {opPct}%
                    </text>
                    <text x={150} y={169} textAnchor="middle" fontSize={12} fill="#52514e">
                      Operation
                    </text>

                    <Tooltip
                      formatter={(v, n) => [`${v} 個（${data.total > 0 ? Math.round(v / data.total * 100) : 0}%）`, n]}
                      contentStyle={{
                        background: '#fcfcfb', border: '1px solid #e1e0d9',
                        borderRadius: '8px', fontSize: '13px',
                        boxShadow: '0 2px 8px rgba(11,11,11,.08)',
                      }}
                      itemStyle={{ color: '#0b0b0b' }}
                    />
                  </PieChart>

                  <div className="pie-legend">
                    {pieData.map((entry, i) => (
                      <div key={entry.name} className="legend-item">
                        <span className="legend-swatch" style={{ background: PIE_COLORS[i] }} />
                        <span className="legend-name">{entry.name}</span>
                        <span className="legend-count">{entry.value} 個</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="breakdown-card">
                  <h3>細項分布</h3>
                  <table className="breakdown-table">
                    <thead>
                      <tr><th>Dev Type</th><th>數量</th><th>比例</th></tr>
                    </thead>
                    <tbody>
                      {tableRows.map(([type, count]) => (
                        <tr key={type} className={OP_TYPES.has(type) ? 'op-row' : ''}>
                          <td>
                            <span className="type-dot" style={{ background: TYPE_COLORS[type] ?? '#898781' }} />
                            {type}
                            {OP_TYPES.has(type) && <span className="op-tag">OP</span>}
                          </td>
                          <td>{count}</td>
                          <td>{Math.round(count / data.total * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function StatCard({ label, value, accent, large, href }) {
  const cls = ['stat-card', accent && 'stat-accent', large && 'stat-large', href && 'stat-link'].filter(Boolean).join(' ')
  const inner = (
    <>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {href && <span className="stat-link-icon">↗</span>}
    </>
  )
  return href
    ? <a className={cls} href={href} target="_blank" rel="noreferrer">{inner}</a>
    : <div className={cls}>{inner}</div>
}
