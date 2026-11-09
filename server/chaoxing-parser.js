'use strict';

const crypto = require('crypto');

function decodeEntities(input) {
  return String(input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32));
}

function stripTags(input) {
  return decodeEntities(String(input || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag || '');
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : null;
}

function innerTag(html, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html || '');
  return m ? stripTags(m[1]) : '';
}

function hashKey(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function makeLocalDate(year, month, day, hour, minute) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour || 0);
  const mi = Number(minute || 0);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * Extract a deadline from Chinese free text.
 * Supports: 2026-11-20 23:59, 2026/11/20, 11月20日 23:59, 今天/明天/后天, ISO.
 * Assumes the current year when the year is omitted; a date more than 180 days
 * in the past rolls to next year (covers December -> January hand-offs).
 */
function extractDeadline(input, now = new Date()) {
  if (!input) return null;
  const text = String(input)
    .replace(/(发布于|发布时间|创建时间|更新时间|开课时间)\s*[:：]?\s*20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?/g, ' ')
    .replace(/[（(]/g, ' ')
    .replace(/[）)]/g, ' ')
    .replace(/：/g, ':')
    .replace(/\s+/g, ' ');

  // Full ISO / datetime with explicit year.
  let m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?)?/.exec(text);
  if (m) {
    return makeLocalDate(m[1], m[2], m[3], m[4] || 23, m[5] || 59);
  }

  // Month/day with optional time.
  m = /(?:^|[^\d])(\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/.exec(text);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let date = makeLocalDate(now.getFullYear(), month, day, m[3] || 23, m[4] || 59);
      if (date && date.getTime() < now.getTime() - 180 * 24 * 3600 * 1000) {
        date = makeLocalDate(now.getFullYear() + 1, month, day, m[3] || 23, m[4] || 59);
      }
      return date;
    }
  }

  // Relative days.
  const rel = /(今天|明天|后天|今日|明日)(?:\s*(\d{1,2}):(\d{2}))?/.exec(text);
  if (rel) {
    const offset = rel[1].includes('后') ? 2 : (rel[1].includes('明') ? 1 : 0);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset,
      rel[2] === undefined ? 23 : Number(rel[2]), rel[3] === undefined ? 59 : Number(rel[3]), 0, 0);
    return d;
  }

  return null;
}

function parseTimeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  const asDate = new Date(text.replace(/\//g, '-'));
  if (!Number.isNaN(asDate.getTime()) && /\d{4}/.test(text)) return asDate;
  return extractDeadline(text);
}

function normalizeType(value) {
  const t = String(value || '').toLowerCase();
  if (t.includes('exam') || t.includes('考试') || t === '2') return 'exam';
  return 'work';
}

function isClosedStatus(value) {
  const text = String(value || '');
  return /不可提交|不能提交|已关闭|已结束|已过期|逾期不可|不可补交|不能补交|无法补交/.test(text)
    && !isCompletedStatus(text);
}

function isCompletedStatus(value) {
  if (typeof value === 'number') return value > 0;
  const text = String(value || '');
  if (/^[1-9]\d*$/.test(text)) return true;
  // "已过期/已结束" means the deadline has passed, not that the student
  // submitted it. Keep those rows so overdue-but-unfinished work is recorded.
  return /已完成|已提交|已批阅|已交|已通过/.test(text);
}

function parseTaskFeed(body) {
  const root = typeof body === 'string' ? JSON.parse(body) : body;
  if (!root || Number(root.result) !== 1 || !Array.isArray(root.data)) return [];
  const out = [];
  for (const raw of root.data) {
    if (!raw || typeof raw !== 'object') continue;
    const title = stripTags(raw.title || raw.workname || raw.name || '');
    if (!title) continue;
    const type = normalizeType(raw.type);
    const end = parseTimeValue(raw.taskendtime ?? raw.endtime ?? raw.endTime);
    const open = parseTimeValue(raw.taskopentime ?? raw.opentime);
    const status = Number.isFinite(Number(raw.status)) ? Number(raw.status) : 0;
    const id = String(raw.id || raw.taskrefid || '').trim();
    const unique = id || hashKey(`${type}|${title}|${end ? end.toISOString() : ''}`);
    out.push({
      id: unique,
      sourceKey: `cx:${type}:${unique}`,
      title,
      course: stripTags(raw.coursename || raw.courseName || ''),
      type,
      dueAt: end ? end.toISOString() : null,
      openAt: open ? open.toISOString() : null,
      remoteStatus: status,
      sourceUrl: String(raw.dotaskurl || raw.doTaskUrl || '').trim(),
      unfinished: status === 0
    });
  }
  return dedupe(out);
}

function parseBackClazz(body) {
  const root = typeof body === 'string' ? JSON.parse(body) : body;
  if (!root || Number(root.result) !== 1 || !Array.isArray(root.channelList)) return [];
  const courses = [];
  for (const channel of root.channelList) {
    if (!channel || typeof channel !== 'object') continue;
    let content = channel.content;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch (_) { continue; }
    }
    if (!content || typeof content !== 'object') continue;
    const courseData = content.course && content.course.data;
    if (Array.isArray(courseData) && courseData.length) {
      const classId = String(content.id || channel.key || '');
      for (const course of courseData) {
        if (!course || !course.id || !classId) continue;
        courses.push({
          courseId: String(course.id),
          classId,
          courseName: stripTags(course.name || ''),
          className: stripTags(content.name || ''),
          teacher: stripTags(course.teacherfactor || ''),
          imageUrl: String(course.imageurl || ''),
          cpi: String(content.cpi || channel.cpi || ''),
          personId: String(course.personid || content.cpi || channel.cpi || '')
        });
      }
      continue;
    }
    if (Array.isArray(content.clazz)) {
      const courseId = String(content.id || '');
      for (const clazz of content.clazz) {
        if (!clazz || !clazz.id || !courseId) continue;
        courses.push({
          courseId,
          classId: String(clazz.id),
          courseName: stripTags(content.name || ''),
          className: stripTags(clazz.name || ''),
          teacher: stripTags(content.teacherfactor || ''),
          imageUrl: String(content.imageurl || ''),
          cpi: String(clazz.cpi || content.cpi || ''),
          personId: String(content.personid || content.cpi || '')
        });
      }
    }
  }
  const seen = new Set();
  return courses.filter((c) => {
    const key = `${c.courseId}:${c.classId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function absoluteUrl(base, url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (!base) return value;
  return `${base.replace(/\/$/, '')}${value.startsWith('/') ? '' : '/'}${value}`;
}

function parseWorkListHtml(html, base = 'https://mooc1.chaoxing.com') {
  const out = [];
  const re = /<dt\b[^>]*>([\s\S]*?)<\/dt>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const inner = m[1];
    const data = attr(tag, 'data');
    if (!data) continue;
    const title = innerTag(inner, 'h3');
    if (!title) continue;
    const detail = innerTag(inner, 'p');
    const statusText = innerTag(inner, 'b');
    const due = /截止|结束|提交截止|有效期/.test(`${detail} ${statusText}`)
      ? extractDeadline(`${detail} ${statusText}`)
      : null;
    out.push({
      id: hashKey(`${data}|${title}`),
      sourceKey: `cx:work:${hashKey(`${data}|${title}`)}`,
      title,
      course: '',
      type: 'work',
      dueAt: due ? due.toISOString() : null,
      remoteStatus: isCompletedStatus(statusText) ? 1 : 0,
      closed: isClosedStatus(statusText),
      sourceUrl: absoluteUrl(base, data),
      statusText,
      detail
    });
  }
  return dedupe(out);
}

function parseExamListHtml(html, base = 'https://mooc1.chaoxing.com') {
  const out = [];
  const re = /<tr\b[^>]*\bdata\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const data = decodeEntities(m[1] ?? m[2] ?? '');
    if (!data) continue;
    const inner = m[3];
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(inner))) cells.push(stripTags(cm[1]));
    let title = attr(tag, 'title') || cells[0] || '';
    title = String(title).trim();
    if (!title) continue;
    const statusText = cells.length > 2 ? cells[2] : '';
    const due = extractDeadline(`${cells.join(' ')} ${statusText}`);
    out.push({
      id: hashKey(`${data}|${title}`),
      sourceKey: `cx:exam:${hashKey(`${data}|${title}`)}`,
      title,
      course: '',
      type: 'exam',
      dueAt: due ? due.toISOString() : null,
      remoteStatus: isCompletedStatus(statusText) ? 1 : 0,
      closed: isClosedStatus(statusText),
      sourceUrl: absoluteUrl(base, data),
      statusText,
      detail: cells.length > 1 ? cells[1] : ''
    });
  }
  return dedupe(out);
}

function genericTitle(value) {
  const t = stripTags(value || '');
  if (!t) return '';
  if (/^(作业|考试|任务|待办|待办事项|更多|查看全部|去完成|立即查看|学习通)$/.test(t)) return '';
  return t.slice(0, 160);
}

/**
 * Normalize raw rows produced by the in-page DOM scanner.
 * Each row: { title, href, text, course, dueText }
 */
function parsePageRows(rows, now = new Date()) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const title = genericTitle(row.title || row.text);
    if (!title || title.length < 3) continue;
    const due = extractDeadline(`${row.dueText || ''} ${row.text || ''}`, now);
    const href = String(row.href || '');
    const type = /exam|考试/.test(`${row.text || ''} ${href}`) ? 'exam' : 'work';
    const sourceUrl = /^https?:\/\//i.test(href) ? href : '';
    const unique = hashKey(`${title}|${sourceUrl}|${due ? due.toISOString() : ''}`);
    out.push({
      id: unique,
      sourceKey: `page:${type}:${unique}`,
      title,
      course: stripTags(row.course || '').slice(0, 60),
      type,
      dueAt: due ? due.toISOString() : null,
      remoteStatus: 0,
      closed: false,
      sourceUrl,
      statusText: '',
      detail: stripTags(row.text || '').slice(0, 180),
      fromPage: true
    });
  }
  return dedupe(out);
}

function dedupe(tasks) {
  const map = new Map();
  for (const task of tasks) {
    if (!task || !task.title) continue;
    const prev = map.get(task.sourceKey);
    if (!prev) {
      map.set(task.sourceKey, task);
      continue;
    }
    if (!prev.dueAt && task.dueAt) map.set(task.sourceKey, task);
    else if (task.dueAt && prev.dueAt && task.dueAt === prev.dueAt) {
      map.set(task.sourceKey, { ...prev, ...task });
    }
  }
  return [...map.values()];
}

function candidateReason(task) {
  if (!task.dueAt) return '未识别到截止时间';
  return '已识别';
}

module.exports = {
  extractDeadline,
  parseTimeValue,
  parseTaskFeed,
  parseBackClazz,
  parseWorkListHtml,
  parseExamListHtml,
  parsePageRows,
  dedupe,
  stripTags,
  decodeEntities,
  candidateReason,
  hashKey
};
