import { useState, useRef, useEffect } from 'react'
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

const GROUPS = [
  { label: 'Web',     jiraName: 'ent-web' },
  { label: 'BE1',     jiraName: 'ent-be1' },
  { label: 'BE2',     jiraName: 'ent-be2' },
  { label: 'Android', jiraName: 'ent-android' },
  { label: 'Design',  jiraName: 'ent-design' },
  { label: 'EP',      jiraName: 'ent-ep' },
  { label: 'iOS',     jiraName: 'ent-ios' },
  { label: 'SDET',    jiraName: 'ent-sdet' },
  { label: 'SRE',     jiraName: 'ent-sre' },
  { label: 'Pride',   jiraName: 'ent-pride' },
  { label: 'QA',      jiraName: 'ent-qa' },
]

const PROJECTS = [
  { label: 'Saku',   key: 'sun' },
  { label: 'Telasa', key: 'tkk' },
  { label: 'Pride',  key: 'pride' },
]

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

async function fetchGroupMembers(jiraName) {
  let allMembers = [], startAt = 0
  while (true) {
    const result = await jiraGet('/rest/api/3/group/member', {
      groupname: jiraName, maxResults: 50, startAt,
    })
    const values = result.values ?? []
    allMembers = allMembers.concat(
      values
        .filter(u => u.accountType === 'atlassian')
        .map(u => ({ accountId: u.accountId, displayName: u.displayName }))
    )
    if (result.isLast || values.length === 0) break
    startAt += values.length
  }
  return allMembers
}

async function fetchTasksForUser({ accountId, displayName }, days, projectKeys = []) {
  const { devTypeId, spId, storyPointsId } = await getFieldIds()
  const fieldList = [devTypeId, spId, storyPointsId, 'summary', 'resolution', 'parent'].filter(Boolean).join(',')

  const projectClause = projectKeys.length > 0 ? ` AND project in (${projectKeys.join(',')})` : ''
  const jql = `issueType in ("DEV-Task", "QA-Task") AND assignee = "${accountId}" AND status = Done AND status CHANGED TO Done AFTER -${days}d${projectClause} ORDER BY updated DESC`

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
      assignee:   displayName,
    }))

  return {
    user: displayName, accountId, days,
    total: allIssues.length, opCount, counts,
    totalPoints, opPoints, points,
    hasPoints: spId !== null, missingSpIssues,
    fieldIds: { spId, storyPointsId },
  }
}

async function fetchAndAggregate(members, days, projectKeys = []) {
  const results = await Promise.all(members.map(m => fetchTasksForUser(m, days, projectKeys)))
  const counts = {}, points = {}
  let total = 0, opCount = 0, totalPoints = 0, opPoints = 0, hasPoints = false
  let fieldIds = { spId: null, storyPointsId: null }
  const missingSpIssues = []
  for (const r of results) {
    total       += r.total
    opCount     += r.opCount
    totalPoints += r.totalPoints
    opPoints    += r.opPoints
    hasPoints    = hasPoints || r.hasPoints
    fieldIds     = r.fieldIds
    for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v
    for (const [k, v] of Object.entries(r.points)) points[k] = (points[k] ?? 0) + v
    missingSpIssues.push(...r.missingSpIssues)
  }
  return {
    mode: 'team', membersList: members, days, projectKeys,
    total, opCount, counts,
    totalPoints, opPoints, points,
    hasPoints, missingSpIssues, fieldIds,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'devtype_remember_name'

export default function App() {
  // Shared
  const [mode, setMode]           = useState(() => localStorage.getItem('devChart_mode') || 'individual')
  const [daysInput, setDaysInput] = useState('30')
  const days = Math.max(1, parseInt(daysInput) || 30)
  const [viewMode, setViewMode]   = useState('count')
  const [loading, setLoading]     = useState(false)
  const [data, setData]           = useState(null)
  const [error, setError]         = useState(null)
  const [showMissingModal, setShowMissingModal]     = useState(false)
  const [showRefreshOverlay, setShowRefreshOverlay] = useState(false)

  // Individual mode
  const [username, setUsername]     = useState(() => localStorage.getItem(STORAGE_KEY) ?? '')
  const [rememberMe, setRememberMe] = useState(() => !!localStorage.getItem(STORAGE_KEY))
  const [candidates, setCandidates] = useState([])

  // Team mode
  const [selectedGroups, setSelectedGroups]       = useState(() => {
    try { const s = localStorage.getItem('devChart_selectedGroups'); return s ? new Set(JSON.parse(s)) : new Set() }
    catch { return new Set() }
  })
  const [expandedGroups, setExpandedGroups]       = useState(new Set())
  const [groupMembers, setGroupMembers]           = useState({})
  const [deselectedMembers, setDeselectedMembers] = useState(() => {
    try {
      const s = localStorage.getItem('devChart_deselectedMembers')
      if (!s) return {}
      return Object.fromEntries(Object.entries(JSON.parse(s)).map(([k, v]) => [k, new Set(v)]))
    } catch { return {} }
  })
  const [loadingGroups, setLoadingGroups]         = useState(new Set())
  const [dropdownOpen, setDropdownOpen]           = useState(false)
  const dropdownRef = useRef()
  const [selectedProjects, setSelectedProjects]   = useState(() => {
    try { const s = localStorage.getItem('devChart_selectedProjects'); return s ? new Set(JSON.parse(s)) : new Set() }
    catch { return new Set() }
  })
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  const projectDropdownRef = useRef()

  // ── Team helpers ──────────────────────────────────────────────────────────

  function getAllSelectedMembers() {
    const members = [], seen = new Set()
    for (const jiraName of selectedGroups) {
      const deselected = deselectedMembers[jiraName] ?? new Set()
      for (const m of (groupMembers[jiraName] ?? [])) {
        if (!deselected.has(m.accountId) && !seen.has(m.accountId)) {
          members.push(m)
          seen.add(m.accountId)
        }
      }
    }
    return members
  }

  async function loadGroupMembers(jiraName) {
    if (groupMembers[jiraName] !== undefined || loadingGroups.has(jiraName)) return
    setLoadingGroups(prev => new Set([...prev, jiraName]))
    try {
      const members = await fetchGroupMembers(jiraName)
      setGroupMembers(prev => ({ ...prev, [jiraName]: members }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingGroups(prev => { const s = new Set(prev); s.delete(jiraName); return s })
    }
  }

  function toggleGroupSelected(jiraName) {
    if (selectedGroups.has(jiraName)) {
      setSelectedGroups(prev => { const s = new Set(prev); s.delete(jiraName); return s })
    } else {
      setSelectedGroups(prev => new Set([...prev, jiraName]))
      setDeselectedMembers(prev => { const n = { ...prev }; delete n[jiraName]; return n })
      loadGroupMembers(jiraName)
    }
  }

  function toggleGroupExpanded(jiraName) {
    setExpandedGroups(prev => {
      const s = new Set(prev)
      s.has(jiraName) ? s.delete(jiraName) : s.add(jiraName)
      return s
    })
    loadGroupMembers(jiraName)
  }

  useEffect(() => {
    if (!dropdownOpen) return
    function onMouseDown(e) {
      if (!dropdownRef.current?.contains(e.target)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [dropdownOpen])

  useEffect(() => {
    if (!projectDropdownOpen) return
    function onMouseDown(e) {
      if (!projectDropdownRef.current?.contains(e.target)) setProjectDropdownOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [projectDropdownOpen])

  useEffect(() => { localStorage.setItem('devChart_mode', mode) }, [mode])
  useEffect(() => {
    localStorage.setItem('devChart_selectedGroups', JSON.stringify([...selectedGroups]))
  }, [selectedGroups])
  useEffect(() => {
    const obj = Object.fromEntries(Object.entries(deselectedMembers).map(([k, v]) => [k, [...v]]))
    localStorage.setItem('devChart_deselectedMembers', JSON.stringify(obj))
  }, [deselectedMembers])
  useEffect(() => {
    localStorage.setItem('devChart_selectedProjects', JSON.stringify([...selectedProjects]))
  }, [selectedProjects])

  // Auto-load members for groups restored from localStorage
  useEffect(() => {
    selectedGroups.forEach(jiraName => loadGroupMembers(jiraName))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleMember(jiraName, accountId) {
    const members = groupMembers[jiraName] ?? []
    if (!selectedGroups.has(jiraName)) {
      // Group not selected: select it with only this member checked
      setSelectedGroups(prev => new Set([...prev, jiraName]))
      const allOthers = new Set(members.filter(m => m.accountId !== accountId).map(m => m.accountId))
      setDeselectedMembers(prev => ({ ...prev, [jiraName]: allOthers }))
      return
    }
    const prevDeselected = deselectedMembers[jiraName] ?? new Set()
    if (prevDeselected.has(accountId)) {
      const next = new Set(prevDeselected)
      next.delete(accountId)
      setDeselectedMembers(prev => ({ ...prev, [jiraName]: next }))
    } else {
      const next = new Set(prevDeselected)
      next.add(accountId)
      if (next.size >= members.length) {
        setSelectedGroups(prev => { const s = new Set(prev); s.delete(jiraName); return s })
        setDeselectedMembers(prev => { const n = { ...prev }; delete n[jiraName]; return n })
      } else {
        setDeselectedMembers(prev => ({ ...prev, [jiraName]: next }))
      }
    }
  }

  // ── Search handlers ───────────────────────────────────────────────────────

  async function search() {
    if (!username.trim() || loading) return
    setLoading(true); setError(null); setData(null); setCandidates([])
    try {
      const found = await searchUsers(username.trim())
      if (found.length === 0) throw new Error('找不到用戶：' + username.trim())
      if (found.length > 1) { setCandidates(found); return }
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
    setUsername(user.displayName); setCandidates([])
    setLoading(true); setError(null); setData(null)
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

  async function searchTeam() {
    const members = getAllSelectedMembers()
    if (members.length === 0 || loading) return
    setLoading(true); setError(null); setData(null)
    try {
      const groupLabels = GROUPS.filter(g => selectedGroups.has(g.jiraName)).map(g => g.label)
      const projectKeys = [...selectedProjects]
      const projectLabels = PROJECTS.filter(p => selectedProjects.has(p.key)).map(p => p.label)
      const result = await fetchAndAggregate(members, days, projectKeys)
      setData({ ...result, groupLabels, projectLabels })
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
      let result
      if (data.mode === 'team') {
        const r = await fetchAndAggregate(data.membersList, data.days, data.projectKeys ?? [])
        result = { ...r, groupLabels: data.groupLabels, projectLabels: data.projectLabels }
      } else {
        result = await fetchTasksForUser({ accountId: data.accountId, displayName: data.user }, data.days)
        if (rememberMe) localStorage.setItem(STORAGE_KEY, result.user)
      }
      setData(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setShowRefreshOverlay(false)
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const isPoints     = viewMode === 'points'
  const displayTotal = data ? (isPoints ? data.totalPoints : data.total)   : 0
  const displayOp    = data ? (isPoints ? data.opPoints    : data.opCount) : 0
  const displayMap   = data ? (isPoints ? data.points      : data.counts)  : {}
  const opPct = displayTotal > 0 ? Math.round(displayOp / displayTotal * 100) : 0
  const fmt = v => isPoints ? `${Math.round(v)} SP` : v

  const jiraBase = 'https://kkvideo.atlassian.net'
  const assigneeClause = data?.mode === 'team'
    ? `assignee in (${data.membersList.map(m => `"${m.accountId}"`).join(',')})`
    : data ? `assignee = "${data.accountId}"` : ''
  const projectClause = data?.projectKeys?.length > 0
    ? ` AND project in (${data.projectKeys.join(',')})`
    : ''
  const allUrl = data ? `${jiraBase}/issues/?jql=${encodeURIComponent(
    `issueType in ("DEV-Task", "QA-Task") AND ${assigneeClause}${projectClause} AND status = Done AND status CHANGED TO Done AFTER -${data.days}d ORDER BY updated DESC`
  )}` : null
  const opUrl = data ? `${jiraBase}/issues/?jql=${encodeURIComponent(
    `issueType in ("DEV-Task", "QA-Task") AND ${assigneeClause}${projectClause} AND status = Done AND status CHANGED TO Done AFTER -${data.days}d AND "Dev Type" in ("OP-Bug", "OP-Task") ORDER BY updated DESC`
  )}` : null

  const pieData = data
    ? [
        { name: 'Operation',   value: displayOp },
        { name: '非 Operation', value: displayTotal - displayOp },
      ].filter(d => d.value > 0)
    : []
  const tableRows = data ? Object.entries(displayMap).sort((a, b) => b[1] - a[1]) : []

  const allSelectedMembers = getAllSelectedMembers()
  const teamQueryable = selectedGroups.size > 0 &&
    ![...selectedGroups].some(g => loadingGroups.has(g)) &&
    allSelectedMembers.length > 0

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header className="header">
        <h1>Dev Type 分析</h1>
        <p>查看成員近期完成 DEV-Task / QA-Task 的 Operation 比例</p>
      </header>

      <main className="main">
        <div className="search-card">
          <div className="mode-tabs">
            <button
              className={`mode-tab${mode === 'individual' ? ' active' : ''}`}
              onClick={() => { setMode('individual'); setData(null); setError(null) }}
            >個人</button>
            <button
              className={`mode-tab${mode === 'team' ? ' active' : ''}`}
              onClick={() => { setMode('team'); setData(null); setError(null); setCandidates([]) }}
            >專案/團隊</button>
          </div>

          <div className="search-label-row">
            <label className="search-label">
              {mode === 'individual' ? 'Jira 顯示名稱' : '選擇群組 ／ 專案'}
            </label>
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

          {mode === 'individual' ? (
            <>
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
                      <button key={u.accountId} className="candidate-btn" onClick={() => selectCandidate(u)}>
                        {u.displayName}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="team-filters-row">
                {(() => {
                  const selectedLabels = GROUPS.filter(g => selectedGroups.has(g.jiraName)).map(g => g.label)
                  const triggerLabel = selectedLabels.length === 0
                    ? '選擇群組…'
                    : selectedLabels.length <= 3
                      ? selectedLabels.join(' · ')
                      : `${selectedLabels.length} 個群組`
                  return (
                    <div className="multiselect" ref={dropdownRef}>
                      <button
                        className={`multiselect-trigger${dropdownOpen ? ' open' : ''}`}
                        onClick={() => setDropdownOpen(v => !v)}
                      >
                        <span className={selectedLabels.length === 0 ? 'trigger-placeholder' : ''}>
                          {triggerLabel}
                        </span>
                        <span className="trigger-arrow">▾</span>
                      </button>

                      {dropdownOpen && (
                        <div className="multiselect-dropdown">
                          {GROUPS.map(({ label, jiraName }) => {
                            const isSelected    = selectedGroups.has(jiraName)
                            const isExpanded    = expandedGroups.has(jiraName)
                            const isLoadingMbr  = loadingGroups.has(jiraName)
                            const members       = groupMembers[jiraName] ?? []
                            const deselected    = deselectedMembers[jiraName] ?? new Set()
                            const someDeselected = isSelected && deselected.size > 0
                            const selectedCount  = isSelected ? members.length - deselected.size : 0
                            return (
                              <div key={jiraName}>
                                <div className="dd-group-row">
                                  <button
                                    className={`dd-expand-btn${isExpanded ? ' open' : ''}`}
                                    onClick={() => toggleGroupExpanded(jiraName)}
                                    aria-label={isExpanded ? '收合' : '展開成員'}
                                  >
                                    {isExpanded && isLoadingMbr ? '…' : isExpanded ? '▾' : '▸'}
                                  </button>
                                  <GroupCheckbox
                                    id={`group-dd-${jiraName}`}
                                    checked={isSelected}
                                    indeterminate={someDeselected}
                                    onChange={() => toggleGroupSelected(jiraName)}
                                  />
                                  <label className="dd-group-label" htmlFor={`group-dd-${jiraName}`}>
                                    {label}
                                  </label>
                                  {isSelected && members.length > 0 && (
                                    <span className="dd-group-count">{selectedCount}</span>
                                  )}
                                </div>

                                {isExpanded && (
                                  isLoadingMbr ? (
                                    <div className="dd-loading">載入中…</div>
                                  ) : members.map(m => {
                                    const isChecked = isSelected && !deselected.has(m.accountId)
                                    return (
                                      <label
                                        key={m.accountId}
                                        className="dd-member-row"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isChecked}
                                          onChange={() => toggleMember(jiraName, m.accountId)}
                                        />
                                        <span>{m.displayName}</span>
                                      </label>
                                    )
                                  })
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {(() => {
                  const selectedLabels = PROJECTS.filter(p => selectedProjects.has(p.key)).map(p => p.label)
                  const triggerLabel = selectedLabels.length === 0
                    ? '選擇專案…'
                    : selectedLabels.join(' · ')
                  return (
                    <div className="multiselect" ref={projectDropdownRef}>
                      <button
                        className={`multiselect-trigger${projectDropdownOpen ? ' open' : ''}`}
                        onClick={() => setProjectDropdownOpen(v => !v)}
                      >
                        <span className={selectedLabels.length === 0 ? 'trigger-placeholder' : ''}>
                          {triggerLabel}
                        </span>
                        <span className="trigger-arrow">▾</span>
                      </button>

                      {projectDropdownOpen && (
                        <div className="multiselect-dropdown">
                          {PROJECTS.map(({ label, key }) => (
                            <label key={key} className="dd-member-row">
                              <input
                                type="checkbox"
                                checked={selectedProjects.has(key)}
                                onChange={() => setSelectedProjects(prev => {
                                  const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s
                                })}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>

              <div className="team-search-row">
                <button
                  className="search-btn"
                  onClick={searchTeam}
                  disabled={loading || !teamQueryable}
                >
                  {loading ? '查詢中…' : '查詢'}
                </button>
              </div>
            </>
          )}
        </div>

        {error && <div className="error-card">{error}</div>}

        {data && (
          <div className="results">
            <div className="result-meta">
              {data.mode === 'team' ? (
                <>
                  <span className="result-user">{data.groupLabels?.join(' · ')}</span>
                  {data.projectLabels?.length > 0 && (
                    <span className="result-range">{data.projectLabels.join(' · ')}</span>
                  )}
                  <span className="result-range">近 {data.days} 天</span>
                  <span
                    className="result-range result-member-count"
                    data-tooltip={data.membersList.map(m => m.displayName).join(', ')}
                  >{data.membersList.length} 人</span>
                </>
              ) : (
                <>
                  <span className="result-user">{data.user}</span>
                  <span className="result-range">近 {data.days} 天</span>
                </>
              )}
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
              {data.missingSpIssues.length > 0
                ? <button className="warn-btn" onClick={() => setShowMissingModal(true)}>⚠ {data.missingSpIssues.length} 筆缺 SP</button>
                : <span className="sp-complete">✓ 資料完整，太棒了！</span>
              }
            </div>

            <div className="stat-row">
              <StatCard label="完成任務" value={fmt(displayTotal)} href={allUrl} />
              <StatCard label="Operation" value={fmt(displayOp)} accent href={opUrl} />
              <StatCard label="Operation 比例" value={`${opPct}%`} accent large />
            </div>

            {data.total === 0 ? (
              <div className="empty-msg">近 {data.days} 天無完成的 DEV-Task / QA-Task</div>
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
        <MissingSpModal issues={data.missingSpIssues} fieldIds={data.fieldIds} isTeam={data.mode === 'team'} onClose={() => setShowMissingModal(false)} onUpdated={handleUpdated} />
      )}
    </div>
  )
}

function GroupCheckbox({ id, checked, indeterminate, onChange }) {
  const ref = useRef()
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input type="checkbox" id={id} ref={ref} checked={checked} onChange={onChange} />
}

function MissingSpModal({ issues, fieldIds, isTeam, onClose, onUpdated }) {
  const jiraBase = 'https://kkvideo.atlassian.net'
  const { spId, storyPointsId } = fieldIds
  const [edits, setEdits]             = useState({})
  const [updating, setUpdating]       = useState(false)
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
      if (errors.length > 0) { setUpdateError(errors.join('\n')); return }
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
              <tr>
                <th></th>
                <th>Ticket</th>
                {isTeam && <th>Assignee</th>}
                <th>Summary</th>
                <th>SP</th>
                <th>Actual SP</th>
              </tr>
            </thead>
            <tbody>
              {issues.map(issue => (
                <tr key={issue.key}>
                  <td className="icon-cell"><IssueTypeIcon type={issue.parentType} /></td>
                  <td>
                    <a href={`${jiraBase}/browse/${issue.key}`} target="_blank" rel="noreferrer" className="ticket-link">
                      {issue.key}
                    </a>
                  </td>
                  {isTeam && <td className="assignee-cell">{issue.assignee}</td>}
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
