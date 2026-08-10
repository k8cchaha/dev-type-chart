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

let cachedFields = null

function jiraAuth() {
  return 'Basic ' + btoa(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`)
}

async function jiraPut(path, body) {
  const res = await fetch('/jira' + path, {
    method: 'PUT',
    headers: { Authorization: jiraAuth(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Jira ${res.status}: ${text.slice(0, 200)}`)
  }
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


async function getFieldIds() {
  if (cachedFields) return cachedFields
  const fields = await jiraGet('/rest/api/3/field')
  const devType = fields.find(f => f.name === 'Dev Type')
  if (!devType) throw new Error('"Dev Type" 欄位不存在，請確認 Jira 設定')
  cachedFields = {
    devTypeId:     devType.id,
    storyPointsId: 'customfield_10005',  // Story Points
    spId:          'customfield_13736',   // Actual Story Points
  }
  return cachedFields
}

async function searchUsers(query) {
  const users = await jiraGet('/rest/api/3/user/search', { query, maxResults: 20 })
  const active = users.filter(u => u.accountType === 'atlassian')
  const exact = active.filter(u => u.displayName.toLowerCase() === query.toLowerCase())
  return exact.length > 0 ? exact : active
}

async function fetchTasksForUser({ accountId, displayName }, days) {
  const { devTypeId, spId, storyPointsId } = await getFieldIds()
  const fieldList = [devTypeId, spId, storyPointsId, 'summary', 'resolution', 'parent'].filter(Boolean).join(',')

  const jql = `issueType in ("DEV-Task", "QA-Task") AND assignee = "${accountId}" AND status = Done AND status CHANGED TO Done AFTER -${days}d ORDER BY updated DESC`

  let allIssues = []
  let nextPageToken = undefined

  while (true) {
    const params = { jql, fields: fieldList, maxResults: 100 }
    if (nextPageToken) params.nextPageToken = nextPageToken

    const result = await jiraGet('/rest/api/3/search/jql', params)
    const issues = result.issues ?? []
    allIssues = allIssues.concat(issues)

    nextPageToken = result.nextPageToken
    if (!nextPageToken || issues.length === 0) break
  }

  const counts = {}, points = {}
  for (const issue of allIssues) {
    const raw = issue.fields?.[devTypeId]
    const label = !raw ? 'Unknown' : (raw.value ?? String(raw))
    counts[label] = (counts[label] ?? 0) + 1
    const sp = spId ? (issue.fields?.[spId] ?? 0) : 0
    points[label] = (points[label] ?? 0) + sp
  }

  const opCount = (counts['OP-Bug'] ?? 0) + (counts['OP-Task'] ?? 0)
  const totalPoints = Object.values(points).reduce((a, b) => a + b, 0)
  const opPoints = (points['OP-Bug'] ?? 0) + (points['OP-Task'] ?? 0)

  const SUN_TKK = new Set(['SUN', 'TKK'])
  const VALID_RESOLUTIONS = new Set(['Fixed', 'Done'])
  const missingSpIssues = allIssues
    .filter(issue => {
      const actualSp     = spId           ? (issue.fields?.[spId]           ?? 0) : 0
      const sp           = storyPointsId  ? (issue.fields?.[storyPointsId]  ?? 0) : 0
      if (actualSp > 0 && sp > 0) return false
      const projectKey   = issue.key.split('-')[0]
      if (SUN_TKK.has(projectKey)) {
        const resolution = issue.fields?.resolution?.name
        if (!VALID_RESOLUTIONS.has(resolution)) return false
      }
      return true
    })
    .map(issue => ({
      key:        issue.key,
      summary:    issue.fields?.summary ?? '',
      sp:         storyPointsId ? (issue.fields?.[storyPointsId] ?? null) : null,
      actualSp:   spId          ? (issue.fields?.[spId]          ?? null) : null,
      parentType: issue.fields?.parent?.fields?.issuetype?.name ?? null,
    }))

  return { user: displayName, accountId, days, total: allIssues.length, opCount, counts, totalPoints, opPoints, points, hasPoints: spId !== null, missingSpIssues, fieldIds: { spId, storyPointsId } }
}

// ── Component ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'devtype_remember_name'

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem(STORAGE_KEY) ?? '')
  const [daysInput, setDaysInput] = useState('30')
  const days = Math.max(1, parseInt(daysInput) || 30)
  const [rememberMe, setRememberMe] = useState(() => !!localStorage.getItem(STORAGE_KEY))
  const [viewMode, setViewMode] = useState('count')
  const [showMissingModal, setShowMissingModal] = useState(false)
  const [showRefreshOverlay, setShowRefreshOverlay] = useState(false)
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
      const result = await fetchTasksForUser(found[0], days)
      setData(result)
      if (rememberMe) localStorage.setItem(STORAGE_KEY, result.user)
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
      const result = await fetchTasksForUser(user, days)
      setData(result)
      if (rememberMe) localStorage.setItem(STORAGE_KEY, result.user)
    } catch (e) {
      setError(e.message ?? '查詢失敗，請稍後再試')
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdated() {
    setShowMissingModal(false)
    setShowRefreshOverlay(true)
    await new Promise(r => setTimeout(r, 2000))
    try {
      const result = await fetchTasksForUser({ accountId: data.accountId, displayName: data.user }, days)
      setData(result)
      if (rememberMe) localStorage.setItem(STORAGE_KEY, result.user)
    } catch (e) {
      setError(e.message)
    } finally {
      setShowRefreshOverlay(false)
    }
  }

  const isPoints = viewMode === 'points'
  const displayTotal = data ? (isPoints ? data.totalPoints : data.total) : 0
  const displayOp    = data ? (isPoints ? data.opPoints   : data.opCount) : 0
  const displayMap   = data ? (isPoints ? data.points     : data.counts)  : {}
  const opPct = displayTotal > 0 ? Math.round(displayOp / displayTotal * 100) : 0
  const fmt = v => isPoints ? `${Math.round(v)} SP` : v

  const jiraBase = 'https://kkvideo.atlassian.net'
  const allUrl = data ? `${jiraBase}/issues/?jql=${encodeURIComponent(
    `issueType in ("DEV-Task", "QA-Task") AND assignee = "${data.accountId}" AND status = Done AND status CHANGED TO Done AFTER -${data.days}d ORDER BY updated DESC`
  )}` : null
  const opUrl = data ? `${jiraBase}/issues/?jql=${encodeURIComponent(
    `issueType in ("DEV-Task", "QA-Task") AND assignee = "${data.accountId}" AND status = Done AND status CHANGED TO Done AFTER -${data.days}d AND "Dev Type" in ("OP-Bug", "OP-Task") ORDER BY updated DESC`
  )}` : null

  const pieData = data
    ? [
        { name: 'Operation',   value: displayOp },
        { name: '非 Operation', value: displayTotal - displayOp },
      ].filter(d => d.value > 0)
    : []

  const tableRows = data
    ? Object.entries(displayMap).sort((a, b) => b[1] - a[1])
    : []

  return (
    <div className="app">
      <header className="header">
        <h1>Dev Type 分析</h1>
        <p>查看成員近期完成 DEV-Task / QA-Task 的 Operation 比例</p>
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
              placeholder="e.g. Tony Stark"
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
          <div className="remember-row">
            <input
              type="checkbox"
              id="remember-me"
              checked={rememberMe}
              onChange={e => {
                setRememberMe(e.target.checked)
                if (!e.target.checked) localStorage.removeItem(STORAGE_KEY)
              }}
            />
            <label htmlFor="remember-me">記住我</label>
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

            <div className="viz-toolbar">
              <div className="view-toggle">
                <button className={`toggle-btn${!isPoints ? ' active' : ''}`} onClick={() => setViewMode('count')}>任務數量</button>
                <button
                  className={`toggle-btn${isPoints ? ' active' : ''}`}
                  onClick={() => setViewMode('points')}
                  disabled={!data.hasPoints}
                  title={!data.hasPoints ? '"Actual Story Points" 欄位不存在' : undefined}
                >
                  Actual Story Points
                </button>
              </div>
              {data.missingSpIssues.length > 0 && (
                <button className="warn-btn" onClick={() => setShowMissingModal(true)}>
                  ⚠ {data.missingSpIssues.length} 筆缺 SP
                </button>
              )}
            </div>

            <div className="stat-row">
              <StatCard label="完成任務" value={fmt(displayTotal)} href={allUrl} />
              <StatCard label="Operation" value={fmt(displayOp)} accent href={opUrl} />
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
                      formatter={(v, n) => [`${fmt(v)}（${displayTotal > 0 ? Math.round(v / displayTotal * 100) : 0}%）`, n]}
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
                        <span className="legend-count">{fmt(entry.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="breakdown-card">
                  <h3>細項分布</h3>
                  <table className="breakdown-table">
                    <thead>
                      <tr><th>Dev Type</th><th>{isPoints ? 'Actual SP' : '數量'}</th><th>比例</th></tr>
                    </thead>
                    <tbody>
                      {tableRows.map(([type, count]) => (
                        <tr key={type} className={OP_TYPES.has(type) ? 'op-row' : ''}>
                          <td>
                            <span className="type-dot" style={{ background: TYPE_COLORS[type] ?? '#898781' }} />
                            {type}
                            {OP_TYPES.has(type) && <span className="op-tag">OP</span>}
                          </td>
                          <td>{fmt(count)}</td>
                          <td>{displayTotal > 0 ? Math.round(count / displayTotal * 100) : 0}%</td>
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

      {showRefreshOverlay && (
        <div className="refresh-overlay">
          <div className="refresh-msg">資料更新中…</div>
        </div>
      )}

      {showMissingModal && data && (
        <MissingSpModal issues={data.missingSpIssues} fieldIds={data.fieldIds} onClose={() => setShowMissingModal(false)} onUpdated={handleUpdated} />
      )}
    </div>
  )
}

function MissingSpModal({ issues, fieldIds, onClose, onUpdated }) {
  const jiraBase = 'https://kkvideo.atlassian.net'
  const { spId, storyPointsId } = fieldIds
  const [edits, setEdits] = useState({})
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState(null)

  const hasValidEdit = Object.values(edits).some(edit => {
    const sp  = parseFloat(edit.sp)
    const asp = parseFloat(edit.actualSp)
    return (!isNaN(sp) && sp > 0) || (!isNaN(asp) && asp > 0)
  })

  function setEdit(key, field, value) {
    setEdits(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }))
  }

  function inputVal(key, field) { return edits[key]?.[field] ?? '' }

  async function handleUpdate() {
    setUpdating(true)
    setUpdateError(null)
    try {
      const errors = []
      for (const issue of issues) {
        const edit = edits[issue.key] ?? {}
        const sp  = parseFloat(edit.sp)
        const asp = parseFloat(edit.actualSp)
        const fields = {}
        if (storyPointsId && !isNaN(sp)  && sp  > 0) fields[storyPointsId] = sp
        if (spId          && !isNaN(asp) && asp > 0) fields[spId]          = asp
        if (Object.keys(fields).length > 0) {
          try {
            await jiraPut(`/rest/api/3/issue/${issue.key}?notifyUsers=false`, { fields })
          } catch (e) {
            errors.push(`${issue.key}: ${e.message}`)
          }
        }
      }
      if (errors.length > 0) {
        setUpdateError(errors.join('\n'))
        return
      }
      onUpdated()
    } catch (e) {
      setUpdateError(e.message)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h2>缺 SP 任務 <span className="modal-count">{issues.length}</span></h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {updateError && <div className="modal-error">{updateError}</div>}
          <table className="missing-table">
            <thead>
              <tr><th></th><th>Ticket</th><th>Summary</th><th>SP</th><th>Actual SP</th></tr>
            </thead>
            <tbody>
              {issues.map(issue => (
                <tr key={issue.key}>
                  <td className="icon-cell">
                    <IssueTypeIcon type={issue.parentType} />
                  </td>
                  <td>
                    <a href={`${jiraBase}/browse/${issue.key}`} target="_blank" rel="noreferrer" className="ticket-link">
                      {issue.key}
                    </a>
                  </td>
                  <td className="summary-cell">{issue.summary}</td>
                  <td>
                    {!storyPointsId
                      ? <span className="sp-na">—</span>
                      : (issue.sp > 0)
                        ? <span className="sp-filled">{issue.sp}</span>
                        : <SpInput value={inputVal(issue.key, 'sp')} onChange={v => setEdit(issue.key, 'sp', v)} />}
                  </td>
                  <td>
                    {!spId
                      ? <span className="sp-na">—</span>
                      : (issue.actualSp > 0)
                        ? <span className="sp-filled">{issue.actualSp}</span>
                        : <SpInput value={inputVal(issue.key, 'actualSp')} onChange={v => setEdit(issue.key, 'actualSp', v)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-footer">
          <button className="footer-cancel-btn" onClick={onClose}>取消</button>
          <button className="footer-update-btn" onClick={handleUpdate} disabled={updating || !hasValidEdit}>
            {updating ? '更新中…' : '確認更新'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SpInput({ value, onChange }) {
  const parsed = parseFloat(value)
  const isValid = !isNaN(parsed) && parsed > 0
  return (
    <input
      type="number"
      className={`sp-input ${isValid ? 'sp-valid' : 'sp-empty'}`}
      value={value}
      min={0}
      step={0.5}
      placeholder="—"
      onChange={e => onChange(e.target.value)}
    />
  )
}

function IssueTypeIcon({ type }) {
  const t = (type ?? '').toLowerCase()
  if (t.includes('bug'))   return <BugIcon   title={type ?? 'Unknown'} />
  if (t.includes('story')) return <StoryIcon title={type} />
  if (t.includes('task'))  return <TaskIcon  title={type} />
  return <OtherIcon title={type ?? 'Unknown'} />
}

function BugIcon({ title }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label={title}>
      <ellipse cx="8" cy="10" rx="3.5" ry="4.5" fill="#e05252"/>
      <circle cx="8" cy="4.5" r="2" fill="#e05252"/>
      <line x1="4.5" y1="7.5" x2="1.5" y2="5.5" stroke="#e05252" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="4.5" y1="10" x2="1.5" y2="10"   stroke="#e05252" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="4.5" y1="12.5" x2="1.5" y2="14" stroke="#e05252" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="11.5" y1="7.5" x2="14.5" y2="5.5" stroke="#e05252" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="11.5" y1="10"  x2="14.5" y2="10"  stroke="#e05252" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="11.5" y1="12.5" x2="14.5" y2="14" stroke="#e05252" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}

function StoryIcon({ title }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label={title}>
      <path d="M3 2h10v12.5l-5-3-5 3V2z" fill="#27a665" rx="1"/>
    </svg>
  )
}

function OtherIcon({ title }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label={title}>
      <path d="M3 2h10v12.5l-5-3-5 3V2z" fill="#e6a817"/>
    </svg>
  )
}

function TaskIcon({ title }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label={title}>
      <rect x="2" y="2" width="12" height="12" rx="2.5" fill="#2a78d6"/>
      <path d="M5 8l2.2 2.5L11 5.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
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
