'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { Store } = require('./store');
const { Telemetry } = require('./telemetry');
const { ReminderScheduler } = require('./scheduler');
const { ChaoxingService, LOGIN_URL, HOME_URL, cleanError } = require('./chaoxing');

function argValue(name, fallback = '') {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

const appRoot = path.join(__dirname, '..');
const rendererDir = path.join(appRoot, 'src', 'renderer');
const assetsDir = path.join(appRoot, 'src', 'assets');
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const port = Number(argValue('--port', '48765'));
const dataDirArg = argValue('--data-dir', '');
const dataDir = path.resolve(dataDirArg || path.join(process.env.APPDATA || process.cwd(), 'ClassBell'));
fs.mkdirSync(dataDir, { recursive: true });

const store = new Store(dataDir);
const telemetry = new Telemetry({
  dataDir,
  mirrorDir: process.env.CAMPUSPULSE_LOG_MIRROR || store.state.settings.logMirrorDir,
  appVersion: packageJson.version
});
const chaoxing = new ChaoxingService({ telemetry });
const clients = new Set();
let syncPromise = null;
let reminderQueue = [];
let snoozes = [];
let autoSyncTimer = null;

function log(event, options) { telemetry.log(event, options); }

function friendlyError(error) {
  const code = (error && error.code) || 'UNKNOWN';
  const map = {
    AUTH_REQUIRED: '尚未登录学习通，请先打开登录窗口完成登录。',
    UID_MISSING: '未读取到学习通用户标识，请重新登录。',
    WAF_HTML: '学习通返回了验证页面，请稍后重试。',
    INVALID_JSON: '学习通接口返回格式变化，请稍后重试。',
    HTTP_403: '学习通拒绝了本次请求，请重新登录后重试。',
    FETCH_FAILED: '网络连接失败，请检查网络后重试。'
  };
  return map[code] || String((error && error.message) || '同步失败，请稍后重试。').slice(0, 180);
}

function stats() { return store.stats(); }

function statePayload() {
  return {
    state: store.snapshot(),
    stats: stats(),
    meta: {
      version: packageJson.version,
      packaged: true,
      host: 'webview2',
      dataDir,
      platform: process.platform,
      arch: process.arch,
      loginUrl: LOGIN_URL,
      homeUrl: HOME_URL
    }
  };
}

function broadcastState() {
  const payload = `event: state\ndata: ${JSON.stringify(statePayload())}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let urlPath = decodeURIComponent(parsed.pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const base = urlPath.startsWith('/assets/') ? assetsDir : rendererDir;
  const relative = urlPath.startsWith('/assets/') ? urlPath.slice('/assets/'.length) : urlPath.replace(/^\//, '');
  const file = path.resolve(base, relative);
  if (!file.startsWith(path.resolve(base))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ sync */

function syncMetaFor(auth, result, merge, error) {
  return {
    lastSyncAt: result && result.ok ? new Date().toISOString() : store.state.sync.lastSyncAt,
    lastAttemptAt: new Date().toISOString(),
    lastResult: result && result.ok ? 'ok' : 'error',
    courses: result && Array.isArray(result.courses) ? result.courses.length : store.state.sync.courses,
    recognized: result && Array.isArray(result.tasks) ? result.tasks.length : 0,
    added: merge ? merge.added : 0,
    updated: merge ? merge.updated : 0,
    missed: merge ? (merge.missed || 0) : 0,
    error: error ? friendlyError(error) : '',
    accountLabel: auth && auth.loggedIn ? '学习通账号' : ''
  };
}

function runSync({ auto = false } = {}) {
  if (syncPromise) return syncPromise;
  const started = Date.now();
  log('sync_start', { meta: { trigger: auto ? 'auto' : 'manual' } });
  syncPromise = (async () => {
    let result = null;
    let merge = null;
    try {
      result = await chaoxing.sync();
      if (!result.ok) {
        const err = new Error(result.message || '尚未登录学习通');
        err.code = result.code || 'AUTH_REQUIRED';
        throw err;
      }
      merge = store.mergeRemote(result.tasks || [], {
        autoAdd: Boolean(store.state.settings.autoAddFromChaoxing)
      });
      store.setSyncMeta(syncMetaFor(result.auth, result, merge, null));
      log('sync_merge', {
        durationMs: Date.now() - started,
        meta: {
          added: merge.added, updated: merge.updated, completed: merge.completed,
          missed: merge.missed || 0,
          candidates: merge.candidates, source: result.source
        }
      });
      broadcastState();
      return { ok: true, result, merge, message: `识别 ${result.tasks.length} 项，新增 ${merge.added} 项${merge.missed ? `，错过 ${merge.missed} 项` : ''}` };
    } catch (error) {
      const auth = result ? result.auth : null;
      store.setSyncMeta(syncMetaFor(auth, null, null, error));
      log('sync_failed', { ok: false, error, durationMs: Date.now() - started, meta: { trigger: auto ? 'auto' : 'manual' } });
      broadcastState();
      return { ok: false, code: error.code || 'SYNC_FAILED', message: friendlyError(error) };
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

async function maybeAutoSync() {
  if (syncPromise) return;
  if (!store.state.settings.autoSync) return;
  const last = store.state.sync.lastAttemptAt || store.state.sync.lastSyncAt;
  const interval = Math.max(5, Number(store.state.settings.autoSyncIntervalMin) || 30) * 60000;
  if (last && Date.now() - Date.parse(last) < interval) return;
  const auth = await chaoxing.getAuthStatus();
  if (!auth.loggedIn) return;
  await runSync({ auto: true });
}

/* ------------------------------------------------------------------ reminders */

const scheduler = new ReminderScheduler({
  store,
  telemetry,
  onFire: (payload) => {
    reminderQueue.push({ ...payload, queuedAt: Date.now() });
    if (reminderQueue.length > 20) reminderQueue.shift();
  }
});

function processSnoozes() {
  const now = Date.now();
  const due = snoozes.filter((s) => s.at <= now);
  snoozes = snoozes.filter((s) => s.at > now);
  for (const item of due) {
    const task = store.state.tasks.find((t) => t.id === item.payload.taskId);
    if (!task || task.status !== 'pending') continue;
    reminderQueue.push({ ...item.payload, snoozed: true });
  }
}

/* ------------------------------------------------------------------ routes */

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (p === '/api/health' && method === 'GET') return json(res, 200, { ok: true, version: packageJson.version });
  if (p === '/api/shutdown' && method === 'POST') {
    setTimeout(shutdown, 120);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/bootstrap' && method === 'GET') {
    return json(res, 200, {
      ...statePayload(),
      auth: await chaoxing.getAuthStatus(),
      logs: telemetry.summary()
    });
  }
  if (p === '/api/state' && method === 'GET') return json(res, 200, statePayload());
  if (p === '/api/logs' && method === 'GET') {
    return json(res, 200, { ...telemetry.summary(), recent: telemetry.recentEvents(80) });
  }
  if (p === '/api/logs/export' && method === 'GET') {
    const dir = telemetry.logDir;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    let out = '';
    for (const file of files) out += fs.readFileSync(path.join(dir, file), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename=ClassBell-process_logs.jsonl'
    });
    return res.end(out);
  }
  if (p === '/api/data/export' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename=ClassBell-backup.json'
    });
    return res.end(store.exportData());
  }
  if (p === '/api/data/import' && method === 'POST') {
    const text = await readBody(req, 4 * 1024 * 1024);
    const result = store.importData(text);
    log('data_imported', { meta: { imported: result.imported } });
    broadcastState();
    return json(res, 200, result);
  }

  if (p === '/api/tasks' && method === 'POST') {
    const body = await readJson(req);
    const task = store.addTask(body);
    log('task_added', {
      meta: {
        category: task.category, priority: task.priority, source: task.source,
        has_due: Boolean(task.dueAt), recurring: task.recurrence !== 'none'
      }
    });
    broadcastState();
    scheduler.check();
    return json(res, 200, task);
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(complete|restore))?$/.exec(p);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      const task = store.updateTask(id, await readJson(req));
      log('task_updated', { meta: { category: task.category, status: task.status } });
      broadcastState();
      scheduler.check();
      return json(res, 200, task);
    }
    if (method === 'DELETE') {
      store.deleteTask(id);
      log('task_deleted');
      broadcastState();
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && taskMatch[2] === 'complete') {
      const result = store.completeTask(id);
      log('task_completed', { meta: { recurring: Boolean(result.next) } });
      broadcastState();
      return json(res, 200, result);
    }
    if (method === 'POST' && taskMatch[2] === 'restore') {
      const task = store.restoreTask(id);
      log('task_restored');
      broadcastState();
      return json(res, 200, task);
    }
  }

  if (p === '/api/settings' && method === 'POST') {
    const patch = await readJson(req);
    const settings = store.updateSettings(patch);
    log('settings_updated', { meta: { keys: Object.keys(patch) } });
    if ('logMirrorDir' in patch) telemetry.setMirrorDir(settings.logMirrorDir);
    broadcastState();
    return json(res, 200, settings);
  }

  if (p === '/api/log/page' && method === 'POST') {
    const body = await readJson(req);
    log('page_view', { meta: { page: String(body.page || '').slice(0, 30) } });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/first-run' && method === 'POST') {
    store.updateSettings({ firstRun: false });
    broadcastState();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/cx/status' && method === 'GET') {
    return json(res, 200, { ...(await chaoxing.getAuthStatus()), loginUrl: LOGIN_URL, homeUrl: HOME_URL });
  }
  if (p === '/api/cx/cookies' && method === 'POST') {
    const body = await readJson(req);
    chaoxing.setCookies(body.cookies || []);
    const auth = await chaoxing.getAuthStatus();
    broadcastState();
    return json(res, 200, auth);
  }
  if (p === '/api/cx/sync' && method === 'POST') {
    return json(res, 200, await runSync({ auto: false }));
  }
  if (p === '/api/cx/scan' && method === 'POST') {
    return json(res, 200, {
      rows: [],
      merged: { added: 0, updated: 0, candidates: 0 },
      message: '当前版本使用学习通接口同步，无需扫描页面。'
    });
  }
  if (p === '/api/candidates/dismiss' && method === 'POST') {
    const body = await readJson(req);
    store.dismissCandidate(String(body.id || ''));
    broadcastState();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/reminders/pending' && method === 'GET') {
    scheduler.check();
    processSnoozes();
    const items = reminderQueue.splice(0, reminderQueue.length);
    return json(res, 200, { items });
  }
  if (p === '/api/reminders/action' && method === 'POST') {
    const body = await readJson(req);
    const { action, taskId, minutes } = body;
    const task = taskId ? store.state.tasks.find((t) => t.id === taskId) : null;
    let latency = 0;
    if (body.firedAt) {
      const fired = Date.parse(body.firedAt);
      if (Number.isFinite(fired) && fired <= Date.now()) latency = Date.now() - fired;
    }
    log('reminder_action', {
      meta: { action: String(action || '').slice(0, 20), latency_ms: latency }
    });
    if (action === 'done' && task) {
      store.completeTask(taskId);
      log('reminder_done', { meta: { action: 'done' } });
      broadcastState();
    } else if (action === 'snooze' && task) {
      const delay = Math.max(1, Math.min(120, Number(minutes) || 10));
      snoozes.push({
        at: Date.now() + delay * 60000,
        payload: {
          taskId, title: task.title, course: task.course, category: task.category,
          priority: task.priority, dueAt: task.dueAt, offset: -1, lateMinutes: 0, silent: false
        }
      });
      log('reminder_snoozed', { meta: { minutes: delay } });
    } else if (action === 'close' && task) {
      scheduler.dismiss(taskId);
      log('reminder_dismissed');
    } else if (action === 'open' && task) {
      log('reminder_open_task');
    }
    return json(res, 200, { ok: true, openTask: action === 'open' ? taskId : null });
  }

  if (p === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  return json(res, 404, { error: 'NOT_FOUND', message: '接口不存在' });
}

/* ------------------------------------------------------------------ start */

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/events') {
    handleApi(req, res).catch((error) => {
      const code = (error && error.code) || 'SERVER_ERROR';
      log('api_error', { ok: false, error, meta: { path: req.url.split('?')[0] } });
      if (!res.headersSent) json(res, 400, { error: code, message: String((error && error.message) || error).slice(0, 200) });
      else res.end();
    });
    return;
  }
  serveStatic(req, res);
});

server.listen(port, '127.0.0.1', () => {
  telemetry.log('app_start', {
    meta: { host: 'webview2', port, packaged: true, node: process.versions.node }
  });
  telemetry.writeIndex();
  scheduler.start();
  autoSyncTimer = setInterval(() => maybeAutoSync(), 60000);
  setTimeout(() => maybeAutoSync(), 15000);
  setInterval(() => {
    telemetry.log('heartbeat', {
      meta: { uptime_min: Math.round(process.uptime() / 60), pending: store.stats().pending }
    });
  }, Number(process.env.CAMPUSPULSE_HEARTBEAT_MS) || 5 * 60000);
  console.log(`ClassBell server listening on 127.0.0.1:${port}`);
});

function shutdown() {
  try { scheduler.stop(); } catch (_) {}
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  try { store.flush(); } catch (_) {}
  try { telemetry.flush(); } catch (_) {}
  try { telemetry.writeIndex(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => log('uncaught_exception', { ok: false, error }));
process.on('unhandledRejection', (error) => log('unhandled_rejection', { ok: false, error }));
