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

test('mergeRemote keeps tasks without deadlines as candidates', () => {
  const { store } = tempStore();
  const result = store.mergeRemote([{
    title: '章节测验', course: '线性代数', type: 'work',
    dueAt: null, sourceKey: 'cx:work:no-due'
  }], { autoAdd: true });
  assert.equal(result.added, 0);
  assert.equal(result.candidates, 1);
  assert.equal(store.snapshot().candidates[0].reason, 'no_deadline');
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

