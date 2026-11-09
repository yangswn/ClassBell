'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const MAX_TASKS = 2000;
const MAX_CANDIDATES = 200;
const NO_DEADLINE_ISO = '2099-12-31T23:59:00.000Z';

const CATEGORIES = new Set(['homework', 'exam', 'schedule', 'other']);
const PRIORITIES = new Set(['normal', 'important', 'urgent']);
const RECURRENCES = new Set(['none', 'daily', 'weekly', 'monthly']);

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

function cleanText(value, max = 200) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnlyKey(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultSettings() {
  return {
    autoLaunch: true,
    closeToTray: true,
    autoSync: true,
    autoSyncIntervalMin: 30,
    autoAddFromChaoxing: true,
    reminderOffsets: [1440, 60, 10],
    sound: true,
    quietHours: { enabled: false, start: '23:00', end: '07:00' },
    logMirrorDir: '',
    displayName: '',
    firstRun: true
  };
}

function defaultState() {
  const ts = nowIso();
  return {
    schema: SCHEMA,
    createdAt: ts,
    updatedAt: ts,
    tasks: [],
    candidates: [],
    settings: defaultSettings(),
    sync: {
      lastSyncAt: null,
      lastAttemptAt: null,
      lastResult: null,
      courses: 0,
      recognized: 0,
      added: 0,
      updated: 0,
      error: null,
      accountLabel: ''
    },
    metrics: {
      totalAdded: 0,
      totalCompleted: 0,
      totalSynced: 0,
      totalReminders: 0
    }
  };
}

function normalizeOffsets(input, fallback = [60, 10]) {
  const raw = Array.isArray(input) ? input : fallback;
  const values = [...new Set(raw.map((v) => safeInt(v, -1))
    .filter((v) => v >= 0 && v <= 10080))]
    .sort((a, b) => b - a);
  return values.length ? values : [...fallback];
}

function normalizeTask(input, existing = null) {
  const base = existing || {};
  const title = cleanText(input.title ?? base.title, 120);
  if (!title) throw new Error('TASK_TITLE_REQUIRED');

  const noDeadline = Boolean(input.noDeadline ?? base.noDeadline);
  const due = noDeadline ? new Date(NO_DEADLINE_ISO) : parseDate(input.dueAt ?? base.dueAt);
  if (!due || Number.isNaN(due.getTime())) throw new Error('TASK_DUE_INVALID');

  const category = CATEGORIES.has(input.category) ? input.category : (base.category || 'homework');
  const priority = PRIORITIES.has(input.priority) ? input.priority : (base.priority || 'normal');
  const recurrence = RECURRENCES.has(input.recurrence) ? input.recurrence : (base.recurrence || 'none');
  const status = ['done', 'pending', 'missed'].includes(input.status)
    ? input.status
    : (['done', 'missed'].includes(base.status) ? base.status : 'pending');
  const source = ['manual', 'chaoxing'].includes(input.source) ? input.source : (base.source || 'manual');
  const offsets = normalizeOffsets(input.reminderOffsets ?? base.reminderOffsets);

  const task = {
    id: base.id || uid('t_'),
    title,
    course: cleanText(input.course ?? base.course, 60),
    category,
    priority,
    dueAt: due.toISOString(),
    noDeadline,
    notes: cleanText(input.notes ?? base.notes, 2000),
    status,
    missedAt: status === 'missed' ? (base.missedAt || nowIso()) : null,
    completedAt: status === 'done'
      ? (base.completedAt || nowIso())
      : null,
    createdAt: base.createdAt || nowIso(),
    updatedAt: nowIso(),
    reminderOffsets: offsets,
    remindersSent: Array.isArray(input.remindersSent)
      ? input.remindersSent.map((v) => cleanText(v, 40)).filter(Boolean).slice(0, 30)
      : (Array.isArray(base.remindersSent) ? base.remindersSent : []),
    recurrence,
    seriesId: cleanText(input.seriesId ?? base.seriesId, 80) || '',
    source,
    sourceKey: cleanText(input.sourceKey ?? base.sourceKey, 160) || '',
    sourceUrl: cleanText(input.sourceUrl ?? base.sourceUrl, 600) || '',
    remoteStatus: safeInt(input.remoteStatus ?? base.remoteStatus, 0),
    lastSeenAt: cleanText(input.lastSeenAt ?? base.lastSeenAt, 40) || '',
    completedBy: cleanText(input.completedBy ?? base.completedBy, 20) || ''
  };

  if (task.dueAt !== base.dueAt) task.remindersSent = [];
  if (input.reminderOffsets) task.remindersSent = [];
  return task;
}

function nextOccurrence(task) {
  const d = new Date(task.dueAt);
  if (task.recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (task.recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (task.recurrence === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const max = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, max));
  } else {
    return null;
  }
  return {
    ...task,
    id: uid('t_'),
    dueAt: d.toISOString(),
    status: 'pending',
    completedAt: null,
    completedBy: '',
    remindersSent: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seriesId: task.seriesId || task.id
  };
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'data.json');
    this.backupFile = path.join(dataDir, 'data.backup.json');
    this.state = defaultState();
    this._writeTimer = null;
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const candidate of [this.file, this.backupFile]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) continue;
        this.state = this.migrate(raw);
        return;
      } catch (err) {
        // Try the backup, then fall back to defaults.
      }
    }
    this.state = defaultState();
    this.save();
  }

  migrate(raw) {
    const base = defaultState();
    const settings = { ...base.settings, ...(raw.settings || {}) };
    settings.reminderOffsets = normalizeOffsets(settings.reminderOffsets);
    settings.quietHours = { ...base.settings.quietHours, ...(settings.quietHours || {}) };
    settings.autoSyncIntervalMin = Math.max(5, Math.min(240, safeInt(settings.autoSyncIntervalMin, 30)));
    const tasks = [];
    for (const item of raw.tasks) {
      try {
        tasks.push(normalizeTask(item, item));
      } catch (_) {
        // Drop malformed rows rather than breaking the whole store.
      }
    }
    const candidates = Array.isArray(raw.candidates)
      ? raw.candidates.filter((c) => c && c.title).slice(0, MAX_CANDIDATES).map((c) => ({
        id: cleanText(c.id, 80) || uid('c_'),
        title: cleanText(c.title, 160),
        course: cleanText(c.course, 80),
        dueAt: c.dueAt && parseDate(c.dueAt) ? parseDate(c.dueAt).toISOString() : null,
        sourceKey: cleanText(c.sourceKey, 160),
        sourceUrl: cleanText(c.sourceUrl, 600),
        type: cleanText(c.type, 20) || 'work',
        reason: cleanText(c.reason, 40),
        discoveredAt: cleanText(c.discoveredAt, 40) || nowIso()
      }))
      : [];
    return {
      ...base,
      ...raw,
      schema: SCHEMA,
      settings,
      tasks,
      candidates,
      sync: { ...base.sync, ...(raw.sync || {}) },
      metrics: { ...base.metrics, ...(raw.metrics || {}) }
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  save() {
    this.state.updatedAt = nowIso();
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, `data.${process.pid}.${Date.now()}.tmp`);
    const json = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, this.backupFile);
        } catch (_) { /* best effort */ }
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Windows can transiently lock the target; retry with a direct write.
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      fs.writeFileSync(this.file, json, 'utf8');
    }
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = null;
  }

  scheduleSave() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      try { this.save(); } catch (err) { console.error('store save failed', err); }
    }, 180);
  }

  flush() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = null;
    this.save();
  }

  addTask(input) {
    if (this.state.tasks.length >= MAX_TASKS) {
      throw new Error('TASK_LIMIT_REACHED');
    }
    const task = normalizeTask({
      ...input,
      source: input.source === 'chaoxing' ? 'chaoxing' : 'manual'
    });
    if (task.sourceKey) {
      const existing = this.state.tasks.find((t) => t.sourceKey && t.sourceKey === task.sourceKey);
      if (existing) {
        return this.updateTask(existing.id, {
          ...task,
          id: existing.id,
          remindersSent: existing.remindersSent,
          status: existing.status
        });
      }
    }
    this.state.tasks.push(task);
    this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== task.sourceKey);
    this.state.metrics.totalAdded += 1;
    this.scheduleSave();
    return task;
  }

  updateTask(id, patch) {
    const idx = this.state.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error('TASK_NOT_FOUND');
    const existing = this.state.tasks[idx];
    const updated = normalizeTask({ ...existing, ...patch, id: existing.id }, existing);
    if (patch.status === 'done' && existing.status !== 'done') {
      updated.completedAt = nowIso();
      updated.completedBy = cleanText(patch.completedBy, 20) || 'user';
      this.state.metrics.totalCompleted += 1;
    }
    if (patch.status === 'pending') {
      updated.completedAt = null;
      updated.completedBy = '';
    }
    this.state.tasks[idx] = updated;
    this.scheduleSave();
    return updated;
  }

  deleteTask(id) {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    if (this.state.tasks.length === before) throw new Error('TASK_NOT_FOUND');
    this.scheduleSave();
    return true;
  }

  completeTask(id) {
    const existing = this.state.tasks.find((t) => t.id === id);
    if (!existing) throw new Error('TASK_NOT_FOUND');
    if (existing.status === 'done') return { task: existing, next: null };
    const done = this.updateTask(id, { status: 'done', completedBy: 'user' });
    let next = null;
    if (existing.recurrence !== 'none') {
      const draft = nextOccurrence(existing);
      if (draft) {
        next = normalizeTask(draft, draft);
        this.state.tasks.push(next);
      }
    }
    this.scheduleSave();
    return { task: done, next };
  }

  restoreTask(id) {
    return this.updateTask(id, { status: 'pending', completedAt: null });
  }

  updateSettings(patch) {
    const allowed = [
      'autoLaunch', 'closeToTray', 'autoSync', 'autoSyncIntervalMin',
      'autoAddFromChaoxing', 'sound', 'quietHours', 'logMirrorDir',
      'displayName', 'firstRun', 'reminderOffsets'
    ];
    const next = { ...this.state.settings };
    for (const key of allowed) {
      if (!(key in patch)) continue;
      if (key === 'autoSyncIntervalMin') {
        next[key] = Math.max(5, Math.min(240, safeInt(patch[key], 30)));
      } else if (key === 'quietHours') {
        const q = patch[key] || {};
        next.quietHours = {
          enabled: Boolean(q.enabled),
          start: /^\d{2}:\d{2}$/.test(q.start) ? q.start : '23:00',
          end: /^\d{2}:\d{2}$/.test(q.end) ? q.end : '07:00'
        };
      } else if (key === 'reminderOffsets') {
        next.reminderOffsets = normalizeOffsets(patch.reminderOffsets);
      } else if (key === 'logMirrorDir' || key === 'displayName') {
        next[key] = cleanText(patch[key], 500);
      } else {
        next[key] = Boolean(patch[key]);
      }
    }
    this.state.settings = next;
    this.scheduleSave();
    return next;
  }

  markRemindersSent(taskId, keys) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const set = new Set(task.remindersSent || []);
    for (const key of keys) set.add(key);
    task.remindersSent = [...set].slice(-30);
    task.updatedAt = nowIso();
    this.scheduleSave();
  }

  setSyncMeta(patch) {
    this.state.sync = { ...this.state.sync, ...patch };
    if (patch.lastResult === 'ok') this.state.metrics.totalSynced += 1;
    this.scheduleSave();
  }

  /**
   * Merge an array of normalized remote tasks.
   * Remote rows without a usable deadline are kept in candidates for review.
   */
  mergeRemote(remoteTasks, { autoAdd = true } = {}) {
    const stats = { added: 0, updated: 0, completed: 0, missed: 0, candidates: 0, skipped: 0 };
    const bySource = new Map();
    const byFingerprint = new Map();
    for (const task of this.state.tasks) {
      if (task.sourceKey) bySource.set(task.sourceKey, task);
      byFingerprint.set(`${task.title}::${task.dueAt}`, task);
    }

    for (const remote of remoteTasks) {
      const sourceKey = cleanText(remote.sourceKey, 160);
      if (!sourceKey || !remote.title) { stats.skipped += 1; continue; }
      const existing = bySource.get(sourceKey);
      const dueAt = remote.dueAt && parseDate(remote.dueAt) ? parseDate(remote.dueAt).toISOString() : null;

      if (existing) {
        const patch = {
          title: remote.title,
          course: remote.course || existing.course,
          sourceUrl: remote.sourceUrl || existing.sourceUrl,
          remoteStatus: safeInt(remote.remoteStatus, 0),
          lastSeenAt: nowIso()
        };
        let changed = false;
        if (remote.title && remote.title !== existing.title) changed = true;
        if (remote.course && remote.course !== existing.course) changed = true;
        if (dueAt && dueAt !== existing.dueAt) {
          patch.dueAt = dueAt;
          patch.noDeadline = false;
          changed = true;
        }
        if (remote.remoteStatus !== undefined && remote.remoteStatus !== 0 && existing.status === 'pending') {
          patch.status = 'done';
          patch.completedBy = 'chaoxing';
          stats.completed += 1;
          changed = true;
        } else if (remote.closed && existing.status === 'pending') {
          patch.status = 'missed';
          stats.missed += 1;
          changed = true;
        }
        if (changed) {
          this.updateTask(existing.id, patch);
          stats.updated += 1;
        }
        continue;
      }

      if (safeInt(remote.remoteStatus, 0) !== 0) {
        stats.skipped += 1;
        continue;
      }

      if (remote.closed) {
        const created = normalizeTask({
          title: remote.title,
          course: remote.course,
          category: remote.type === 'exam' ? 'exam' : 'homework',
          priority: remote.type === 'exam' ? 'important' : 'normal',
          dueAt: dueAt || nowIso(),
          status: 'missed',
          notes: remote.notes || '',
          source: 'chaoxing',
          sourceKey,
          sourceUrl: remote.sourceUrl,
          remoteStatus: 0,
          lastSeenAt: nowIso(),
          reminderOffsets: []
        });
        this.state.tasks.push(created);
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        bySource.set(sourceKey, created);
        this.state.metrics.totalAdded += 1;
        stats.missed += 1;
        continue;
      }

      const fingerprint = `${remote.title}::${dueAt || ''}`;
      const duplicate = dueAt ? byFingerprint.get(fingerprint) : null;
      if (duplicate) {
        if (!duplicate.sourceKey) {
          duplicate.sourceKey = sourceKey;
          duplicate.sourceUrl = remote.sourceUrl || duplicate.sourceUrl;
          stats.updated += 1;
        }
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        continue;
      }

      if (dueAt && autoAdd) {
        if (parseDate(dueAt).getTime() < Date.now() - 45 * 24 * 3600 * 1000) {
          stats.skipped += 1;
          continue;
        }
        const created = normalizeTask({
          title: remote.title,
          course: remote.course,
          category: remote.type === 'exam' ? 'exam' : 'homework',
          priority: remote.type === 'exam' ? 'important' : 'normal',
          dueAt,
          notes: remote.notes || '',
          source: 'chaoxing',
          sourceKey,
          sourceUrl: remote.sourceUrl,
          remoteStatus: safeInt(remote.remoteStatus, 0),
          lastSeenAt: nowIso(),
          reminderOffsets: this.state.settings.reminderOffsets
        });
        this.state.tasks.push(created);
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        bySource.set(sourceKey, created);
        byFingerprint.set(fingerprint, created);
        this.state.metrics.totalAdded += 1;
        stats.added += 1;
        continue;
      }

      // No deadline is a valid state on Chaoxing: the teacher simply did not set
      // one. Keep it as an open-ended task until the student marks it complete.
      if (!dueAt && autoAdd) {
        const created = normalizeTask({
          title: remote.title,
          course: remote.course,
          category: remote.type === 'exam' ? 'exam' : 'homework',
          priority: remote.type === 'exam' ? 'important' : 'normal',
          dueAt: NO_DEADLINE_ISO,
          noDeadline: true,
          notes: remote.notes || '',
          source: 'chaoxing',
          sourceKey,
          sourceUrl: remote.sourceUrl,
          remoteStatus: 0,
          lastSeenAt: nowIso(),
          reminderOffsets: []
        });
        this.state.tasks.push(created);
        this.state.candidates = this.state.candidates.filter((c) => c.sourceKey !== sourceKey);
        bySource.set(sourceKey, created);
        this.state.metrics.totalAdded += 1;
        stats.added += 1;
        continue;
      }

      const candidate = {
        id: uid('c_'),
        title: cleanText(remote.title, 160),
        course: cleanText(remote.course, 80),
        dueAt,
        sourceKey,
        sourceUrl: cleanText(remote.sourceUrl, 600),
        type: remote.type === 'exam' ? 'exam' : 'work',
        reason: dueAt ? 'auto_add_disabled' : 'no_deadline',
        discoveredAt: nowIso()
      };
      const old = this.state.candidates.find((c) => c.sourceKey === sourceKey);
      if (old) Object.assign(old, candidate, { id: old.id });
      else this.state.candidates.unshift(candidate);
      stats.candidates += 1;
    }

    this.state.candidates = this.state.candidates.slice(0, MAX_CANDIDATES);
    this.scheduleSave();
    return stats;
  }

  dismissCandidate(id) {
    this.state.candidates = this.state.candidates.filter((c) => c.id !== id);
    this.scheduleSave();
    return true;
  }

  exportData() {
    return JSON.stringify({
      app: 'ClassBell',
      schema: SCHEMA,
      exportedAt: nowIso(),
      tasks: this.state.tasks,
      settings: this.state.settings
    }, null, 2);
  }

  importData(payload) {
    let parsed;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (_) {
      throw new Error('IMPORT_INVALID_JSON');
    }
    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('IMPORT_INVALID_FORMAT');
    const valid = [];
    for (const item of parsed.tasks.slice(0, MAX_TASKS)) {
      try {
        valid.push(normalizeTask(item, item));
      } catch (_) { /* skip */ }
    }
    const existing = new Map(this.state.tasks.map((t) => [t.id, t]));
    for (const task of valid) {
      if (existing.has(task.id)) task.id = uid('t_');
      existing.set(task.id, task);
    }
    this.state.tasks = [...existing.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    this.scheduleSave();
    return { imported: valid.length, total: this.state.tasks.length };
  }

  stats() {
    const now = Date.now();
    const pending = this.state.tasks.filter((t) => t.status === 'pending');
    const today = dateOnlyKey(new Date());
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    return {
      pending: pending.length,
      overdue: pending.filter((t) => new Date(t.dueAt).getTime() < now).length,
      today: pending.filter((t) => dateOnlyKey(t.dueAt) === today).length,
      tomorrow: pending.filter((t) => dateOnlyKey(t.dueAt) === dateOnlyKey(tomorrow)).length,
      week: pending.filter((t) => {
        const d = new Date(t.dueAt).getTime();
        return d >= now && d <= weekEnd.getTime();
      }).length,
      done: this.state.tasks.filter((t) => t.status === 'done').length,
      missed: this.state.tasks.filter((t) => t.status === 'missed').length
    };
  }
}

module.exports = {
  Store,
  defaultState,
  normalizeTask,
  nextOccurrence,
  normalizeOffsets,
  NO_DEADLINE_ISO,
  dateOnlyKey,
  cleanText
};
