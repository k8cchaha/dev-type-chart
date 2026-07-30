// ─── Setup ───────────────────────────────────────────────────────────────────
//
// 1. 前往 https://script.google.com 建立新專案，貼入此檔案內容
// 2. 在「Project Settings > Script Properties」新增：
//      JIRA_EMAIL      = your-email@kkcompany.com
//      JIRA_API_TOKEN  = (從 https://id.atlassian.com/manage-profile/security/api-tokens 產生)
// 3. 部署 > 新增部署版本：
//      類型：Web App
//      執行身份：我（Me）
//      存取權限：Anyone
// 4. 複製 Web App URL，填入前端 src/config.js 的 GAS_URL
//
// ─────────────────────────────────────────────────────────────────────────────

var JIRA_BASE_URL = 'https://kkvideo.atlassian.net';

function _callJira(path, queryParams, postBody) {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('JIRA_EMAIL');
  var token = props.getProperty('JIRA_API_TOKEN');
  if (!email || !token) throw new Error('Script Properties 未設定：JIRA_EMAIL / JIRA_API_TOKEN');

  var auth = Utilities.base64Encode(email + ':' + token);
  var url = JIRA_BASE_URL + path;

  if (queryParams) {
    var pairs = Object.keys(queryParams).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(String(queryParams[k]));
    });
    url += '?' + pairs.join('&');
  }

  var options = {
    headers: {
      'Authorization': 'Basic ' + auth,
      'Accept': 'application/json',
    },
    muteHttpExceptions: true,
  };

  if (postBody) {
    options.method = 'post';
    options.payload = JSON.stringify(postBody);
    options.headers['Content-Type'] = 'application/json';
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var text = response.getContentText();

  if (code >= 400) {
    throw new Error('Jira API ' + code + ': ' + text.substring(0, 300));
  }

  return JSON.parse(text);
}

function _getDevTypeFieldId() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('DEV_TYPE_FIELD_ID');
  if (cached) return cached;

  var fields = _callJira('/rest/api/3/field');
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].name === 'Dev Type') {
      cache.put('DEV_TYPE_FIELD_ID', fields[i].id, 86400);
      return fields[i].id;
    }
  }
  throw new Error('"Dev Type" 欄位不存在（請確認 Jira 專案設定）');
}

function doGet(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    var username = e && e.parameter && e.parameter.username;
    if (!username) throw new Error('缺少 username 參數');

    // 1. 搜尋 Jira 用戶
    var searchResult = _callJira('/rest/api/3/user/search', {
      query: username.trim(),
      maxResults: 20,
      includeActive: 'true',
    });

    var users = Array.isArray(searchResult) ? searchResult : (searchResult.values || []);
    users = users.filter(function(u) { return u.accountType === 'atlassian'; });

    var exact = users.filter(function(u) {
      return u.displayName.toLowerCase() === username.trim().toLowerCase();
    });
    var candidates = exact.length > 0 ? exact : users;

    if (candidates.length === 0) throw new Error('找不到用戶：' + username);
    if (candidates.length > 1) {
      var names = candidates.slice(0, 5).map(function(u) { return u.displayName; }).join('、');
      throw new Error('找到 ' + candidates.length + ' 個用戶，請輸入更精確的名稱：' + names);
    }

    var accountId = candidates[0].accountId;
    var displayName = candidates[0].displayName;

    // 2. 取得 Dev Type 欄位 ID（帶快取）
    var devTypeFieldId = _getDevTypeFieldId();

    // 3. 撈近 30 天完成的 DEV-Task（分頁）
    var jql = 'issueType = "DEV-Task"'
            + ' AND assignee = "' + accountId + '"'
            + ' AND status = Done'
            + ' AND resolutiondate >= -30d'
            + ' ORDER BY resolutiondate DESC';

    var allIssues = [];
    var startAt = 0;
    var pageSize = 100;

    while (true) {
      var result = _callJira('/rest/api/3/search', {
        jql: jql,
        fields: devTypeFieldId,
        startAt: startAt,
        maxResults: pageSize,
        validateQuery: 'warn',
      });

      var issues = result.issues || [];
      allIssues = allIssues.concat(issues);

      if (allIssues.length >= result.total || issues.length === 0) break;
      startAt += issues.length;
    }

    // 4. 統計各 Dev Type 數量
    var counts = {};
    for (var j = 0; j < allIssues.length; j++) {
      var issue = allIssues[j];
      var raw = issue.fields && issue.fields[devTypeFieldId];
      var label;
      if (!raw) {
        label = 'Unknown';
      } else if (typeof raw === 'string') {
        label = raw;
      } else if (raw.value) {
        label = raw.value;
      } else {
        label = String(raw);
      }
      counts[label] = (counts[label] || 0) + 1;
    }

    var opCount = (counts['OP-Dev'] || 0) + (counts['OP-Bug'] || 0);

    output.setContent(JSON.stringify({
      user: displayName,
      total: allIssues.length,
      opCount: opCount,
      counts: counts,
    }));

  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }

  return output;
}
