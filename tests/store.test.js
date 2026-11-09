'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-store-'));
  return { dir, store: new Store(dir) };
}

function due(offsetDays = 1) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setSeconds(0, 0);
  return d.toISOString();
}

test('add, complete and restore a task', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '测试任务', course: '软件工程', dueAt: due(1) });
  assert.equal(store.stats().pending, 1);
  const done = store.completeTask(task.id);
  assert.equal(done.task.status, 'done');
  assert.equal(store.stats().done, 1);
  const restored = store.restoreTask(task.id);
  assert.equal(restored.status, 'pending');
  assert.equal(store.stats().pending, 1);
});

test('weekly recurrence creates the next occurrence', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '每周复盘', dueAt: due(1), recurrence: 'weekly' });
  const result = store.completeTask(task.id);
  assert.ok(result.next);
  assert.equal(result.next.status, 'pending');
  const delta = new Date(result.next.dueAt) - new Date(task.dueAt);
  assert.equal(delta, 7 * 86400000);
});

test('editing the due date clears sent reminders', () => {
  const { store } = tempStore();
  const task = store.addTask({ title: '提醒重置', dueAt: due(1), reminderOffsets: [60, 10] });
  store.markRemindersSent(task.id, [`o60@${task.dueAt}`]);
  assert.equal(store.snapshot().tasks[0].remindersSent.length, 1);
  const updated = store.updateTask(task.id, { dueAt: due(2) });
  assert.equal(updated.remindersSent.length, 0);
});

test('mergeRemote deduplicates by source key and adds due tasks', () => {
  const { store } = tempStore();
  const remote = {
    title: '课程设计报告', course: '软件工程', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:123', sourceUrl: 'https://mooc1.chaoxing.com/1'
  };
  const first = store.mergeRemote([remote], { autoAdd: true });
  assert.equal(first.added, 1);
  const second = store.mergeRemote([remote], { autoAdd: true });
  assert.equal(second.added, 0);
  assert.equal(store.stats().pending, 1);
});

test('mergeRemote keeps tasks without deadlines as open-ended tasks', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '章节测验', course: '线性代数', type: 'work',
    dueAt: null, sourceKey: 'cx:work:no-due'
  }], { autoAdd: true });
  assert.equal(result.added, 1);
  assert.equal(result.candidates, 0);
  const task = store.snapshot().tasks[0];
  assert.equal(task.noDeadline, true);
  assert.equal(task.dueAt, '2099-12-31T23:59:00.000Z');
  assert.equal(task.status, 'pending');
  assert.equal(store.stats().pending, 1);
});

test('mergeRemote does not add a completed task without a deadline', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '已完成的章节测验', course: '线性代数', type: 'work',
    dueAt: null, sourceKey: 'cx:work:no-due-done', remoteStatus: 1
  }], { autoAdd: true });
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.snapshot().tasks.length, 0);
});

test('completed remote task is not added; closed unfinished work becomes a warning record', () => {
  const { store } = tempStore();
  const done = store.mergeRemote([{
    title: '已完成作业', course: '大学英语', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:done-only', remoteStatus: 1
  }], { autoAdd: true });
  assert.equal(done.added, 0);
  assert.equal(store.stats().done, 0);

  const closed = store.mergeRemote([{
    title: '已过期作业', course: '大学英语', type: 'work',
    dueAt: due(-2), sourceKey: 'cx:work:closed', remoteStatus: 0, closed: true
  }], { autoAdd: true });
  assert.equal(closed.missed, 1);
  assert.equal(store.stats().missed, 1);
  assert.equal(store.stats().pending, 0);
  assert.equal(store.snapshot().tasks[0].status, 'missed');
});


test('remote completion is reflected locally', () => {
  const { store } = tempStore();
  const remote = {
    title: '已批阅作业', course: '大学英语', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:done', remoteStatus: 0
  };
  store.mergeRemote([remote], { autoAdd: true });
  const result = store.mergeRemote([{ ...remote, remoteStatus: 1 }], { autoAdd: true });
  assert.equal(result.completed, 1);
  assert.equal(store.stats().done, 1);
});

test('does not add an already completed remote task', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '已提交作业', course: '大学英语', type: 'work',
    dueAt: due(2), sourceKey: 'cx:work:already-done', remoteStatus: 1
  }], { autoAdd: true });
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.stats().pending, 0);
});


/* ---------------------------------------------- notices / gear / mistakes */

test('notices dedupe by sourceKey and track unread counts', () => {
  const { store } = tempStore();
  const first = store.addNotice({ title: '作业三已发布', sourceKey: 'cx:notice:1', source: 'chaoxing' });
  assert.equal(first.created, true);
  const again = store.addNotice({ title: '作业三已发布', sourceKey: 'cx:notice:1', source: 'chaoxing' });
  assert.equal(again.created, false);
  assert.equal(store.snapshot().notices.length, 1);
  assert.equal(store.stats().noticesUnread, 1);
  store.markAllNoticesRead();
  assert.equal(store.stats().noticesUnread, 0);
});

test('gear tracks borrow, overdue and return states', () => {
  const { store } = tempStore();
  const item = store.addGear({ name: '数字示波器', borrower: '张三', dueAt: due(-2) });
  assert.equal(item.status, 'out');
  assert.equal(store.gearSummary().out, 1);
  assert.equal(store.gearSummary().overdue, 1);
  const returned = store.returnGear(item.id, { condition: '正常' });
  assert.equal(returned.status, 'returned');
  assert.equal(store.gearSummary().out, 0);
  assert.equal(store.stats().gearOverdue, 0);
});

test('mistakes dedupe by sourceKey and summarize by course', () => {
  const { store } = tempStore();
  const payload = {
    course: '工程数学', question: '下列哪个是质数', myAnswer: 'A', correctAnswer: 'C',
    source: 'chaoxing', sourceKey: 'cx:mistake:1:0'
  };
  assert.equal(store.addMistake(payload).created, true);
  assert.equal(store.addMistake(payload).created, false);
  store.addMistake({ course: '大学英语', question: 'Unit 2 选词填空', source: 'manual' });
  const summary = store.mistakeSummary();
  assert.equal(summary.total, 2);
  assert.equal(summary.courses.length, 2);
  assert.equal(store.stats().mistakes, 2);
});
