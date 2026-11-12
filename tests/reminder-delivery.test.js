const test = require('node:test');
const assert = require('node:assert/strict');
const { saveTaskRecord } = require('../dist-electron/domain');
const { collectDueReminders, reminderQueueReducer: reduce, emptyReminderQueue: empty } = require('../dist-electron/reminder-delivery');
const { taskFeedback, readableTime, undoableTaskVersion } = require('../dist-electron/task-feedback');
const now = Date.parse('2026-11-12T12:00:00+08:00');
const task = (id, at = '2026-11-12T11:00:00+08:00') => saveTaskRecord({ title: id, dueAt: at }, undefined, id, new Date(now - 86400000).toISOString());
test('due tasks form one sorted batch, persist waiting state, and skip completed/future tasks', () => {
  const source = [task('b'), task('a'), { ...task('done'), completed: true }, task('future', '2026-11-13T12:00:00+08:00')];
  const result = collectDueReminders(source, now);
  assert.deepEqual(result.due.map(t => t.id), ['a', 'b']);
  assert.ok(result.changed);
  assert.ok(result.due.every(t => t.awaitingResponse && t.reminderShown && Date.parse(t.responseDueAt) === now + 300000));
  assert.equal(source[0].reminderShown, false);
  assert.equal(collectDueReminders(result.tasks, now + 299999).due.length, 0);
  assert.equal(collectDueReminders(result.tasks, now + 300000).due.length, 2);
});
test('retry advances queued dates without losing the next future time', () => {
  const t = { ...task('repeat'), awaitingResponse: true, reminderShown: true, responseDueAt: new Date(now).toISOString(), reminderTimes: ['2026-11-12T12:00:00+08:00', '2026-11-12T13:00:00+08:00'] };
  const result = collectDueReminders([t], now);
  assert.equal(Date.parse(result.due[0].reminderAt), now);
  assert.equal(result.due[0].reminderTimes.length, 1);
});
test('arriving batches and retries preserve queue head, draft and order without duplicates', () => {
  const [a, b, c] = collectDueReminders(['a', 'b', 'c'].map(id => task(id)), now).due;
  let q = reduce(empty, { type: 'receive', tasks: [a, b] });
  q = reduce(q, { type: 'reply', id: 'a', text: '我想半小时后' });
  q = reduce(q, { type: 'receive', tasks: [c, { ...a, updatedAt: 'later' }] });
  assert.deepEqual(q.tasks.map(t => t.id), ['a', 'b', 'c']);
  assert.equal(q.replies.a, '我想半小时后');
  q = reduce(q, { type: 'dismiss', id: 'a' });
  assert.equal(q.tasks[0].id, 'b');
  q = reduce(q, { type: 'receive', tasks: [a] });
  assert.deepEqual(q.tasks.map(t => t.id), ['b', 'c', 'a']);
  assert.equal(q.replies.a, '我想半小时后');
  q = reduce(q, { type: 'resolve', id: 'a' });
  assert.equal(q.replies.a, undefined);
  q = reduce(q, { type: 'sync', task: { ...b, completed: true } });
  assert.deepEqual(q.tasks.map(t => t.id), ['c']);
  q = reduce(q, { type: 'sync', task: { ...c, awaitingResponse: false } });
  assert.equal(q.tasks.length, 0);
});
test('feedback uses actual Shanghai times and separates no-time, hourly and custom schedules', () => {
  assert.equal(readableTime('2026-11-12T16:00:00Z', now), '明天 00:00');
  assert.equal(taskFeedback(task('x', '2026-11-12T21:00:00+08:00'), now), '今天 21:00 提醒');
  assert.equal(taskFeedback(saveTaskRecord({ title: 'x' }, undefined, 'x'), now), '未设时间 · 不提醒');
  assert.match(taskFeedback({ ...task('x'), reminderMode: 'none' }, now), /不提醒$/);
  assert.match(taskFeedback({ ...task('x'), reminderTimes: ['2026-11-12T12:00:00+08:00', '2026-11-12T13:00:00+08:00'] }, now), /每小时一次/);
  assert.match(taskFeedback({ ...task('x'), reminderTimes: ['2026-11-13T11:00:00+08:00'] }, now), /每天一次/);
  assert.match(taskFeedback({ ...task('x'), reminderTimes: ['2026-11-12T13:30:00+08:00'] }, now), /共 2 次/);
  assert.match(taskFeedback(task('x'), now), /时间已到/);
});
test('undo signature ignores delivery but rejects content, completion and schedule changes', () => {
  const t = task('x');
  assert.equal(undoableTaskVersion(t), undoableTaskVersion(collectDueReminders([t], now).tasks[0]));
  for (const change of [{ title: 'edited' }, { completed: true }, { notes: 'edited' }, { reminderAt: '2099-01-01T00:00:00Z' }]) assert.notEqual(undoableTaskVersion(t), undoableTaskVersion({ ...t, ...change }));
});
