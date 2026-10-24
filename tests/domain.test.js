const assert = require('node:assert/strict');
const test = require('node:test');
const { dockGeometry, normalizeInput, saveTaskRecord, toggleTaskRecord, parseReminderResponse, reminderSchedule } = require('../dist-electron/domain');
const { applyDateOnlySchedule, applyTaskSchedule, parseTask, repairOverriddenClockTask } = require('../dist-electron/ai');

const baseNow = '2026-10-24T00:00:00.000Z';
test('default reminder is calculated one hour before due time', () => {
  const task = saveTaskRecord({ title: '提交报告', dueAt: '2026-10-25T09:00:00+08:00', reminderMode: 'default', category: '工作', sourceText: '明天上午9点提交报告' }, undefined, '1', baseNow);
  assert.equal(task.reminderAt, '2026-10-25T00:00:00.000Z');
});
test('custom and disabled reminders are preserved', () => {
  const custom = normalizeInput({ title: '开会', dueAt: '2026-10-25T09:00:00+08:00', reminderAt: '2026-10-25T08:30:00+08:00', reminderMode: 'custom' });
  assert.equal(custom.reminderAt, '2026-10-25T00:30:00.000Z');
  const none = normalizeInput({ title: '阅读', dueAt: '2026-10-25T09:00:00+08:00', reminderMode: 'none' });
  assert.equal(none.reminderAt, undefined);
});
test('reminder later than due time is rejected', () => {
  assert.throws(() => normalizeInput({ title: '开会', dueAt: '2026-10-25T09:00:00+08:00', reminderAt: '2026-10-25T09:01:00+08:00', reminderMode: 'custom' }), /不能晚于/);
});
test('completed tasks re-arm when reopened', () => {
  const task = saveTaskRecord({ title: '回访', dueAt: '2026-10-25T09:00:00+08:00', reminderMode: 'default' }, undefined, '1', baseNow);
  const completed = toggleTaskRecord(task, true, baseNow);
  assert.equal(completed.reminderShown, true);
  assert.equal(toggleTaskRecord(completed, false, baseNow).reminderShown, false);
});
test('dock geometry leaves a visible handle at the top edge', () => {
  const g = dockGeometry({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } });
  assert.equal(g.x, 730); assert.equal(g.shownY, 0); assert.equal(g.hiddenY, -642); assert.equal(g.height, 650);
});
test('custom dock sizes are constrained to usable screen dimensions', () => {
  const display = { bounds: { x: -1920, y: -100, width: 1920, height: 1080 }, workArea: { x: -1920, y: -100, width: 1920, height: 1040 } };
  const custom = dockGeometry(display, { width: 380, height: 510 });
  assert.equal(custom.width, 380);
  assert.equal(custom.height, 510);
  assert.equal(custom.hiddenY + custom.height, custom.shownY + 8);
  const small = dockGeometry(display, { width: 100, height: -10 });
  assert.equal(small.width, 360);
  assert.equal(small.height, 480);
  const big = dockGeometry(display, { width: 5000, height: 5000 });
  assert.equal(big.width, 1920);
  assert.equal(big.height, 1040);
  const invalid = dockGeometry(display, { width: NaN, height: Infinity });
  assert.equal(invalid.width, 460);
  assert.equal(invalid.height, 650);
});
test('task input validates title, category, and timezone', () => {
  assert.throws(() => normalizeInput({ title: '', category: '工作' }), /任务名称/);
  assert.throws(() => normalizeInput({ title: '测试', category: '财务' }), /有效分类/);
  const clean = normalizeInput({ title: '测试', dueAt: '2026-10-25T09:00:00+08:00' });
  assert.equal(clean.dueAt, '2026-10-25T01:00:00.000Z');
});
test('reminder replies complete or snooze a task', () => {
  assert.deepEqual(parseReminderResponse('好', Date.parse(baseNow)), { type: 'complete' });
  assert.deepEqual(parseReminderResponse('OK', Date.parse(baseNow)), { type: 'complete' });
  assert.equal(parseReminderResponse('我会执行的', Date.parse(baseNow)).type, 'complete');
  assert.equal(parseReminderResponse('再提醒我 30 分钟后', Date.parse(baseNow)).reminderAt, '2026-10-24T00:30:00.000Z');
  assert.equal(parseReminderResponse('明天上午9点再提醒我', Date.parse(baseNow)).reminderAt, '2026-10-25T01:00:00.000Z');
  assert.equal(parseReminderResponse('今天15.05再提醒我', Date.parse(baseNow)).reminderAt, '2026-10-24T07:05:00.000Z');
  assert.equal(parseReminderResponse('今天15：05再提醒我', Date.parse(baseNow)).reminderAt, '2026-10-24T07:05:00.000Z');
  assert.throws(() => parseReminderResponse('今天15.65再提醒我', Date.parse(baseNow)), /提醒时间无效/);
});
test('date-only AI input remains a task and gets a reminder schedule', () => {
  const task = applyDateOnlySchedule({ title: '整理电脑', category: '生活', notes: '', sourceText: '今天我要整理电脑', reminderMode: 'none' }, '今天我要整理电脑', new Date(baseNow));
  assert.equal(task.dueAt, '2026-10-24T15:59:00.000Z');
  assert.equal(task.reminderAt, '2026-10-24T01:00:00.000Z');
  assert.equal(task.reminderMode, 'custom');
  const future = applyDateOnlySchedule({ title: '整理电脑', category: '生活', notes: '', sourceText: '后天我要整理电脑', reminderMode: 'none' }, '后天我要整理电脑', new Date(baseNow));
  assert.ok((future.reminderTimes || []).length >= 1);
  assert.deepEqual(reminderSchedule({ reminderAt: future.reminderAt, reminderTimes: future.reminderTimes }).map(Date.parse), [Date.parse(future.reminderAt), ...(future.reminderTimes || []).map(Date.parse)]);
});
test('explicit clocks never enter the date-only one-hour fallback', () => {
  const now = new Date('2026-10-24T15:04:31.207+08:00');
  const precise = { title: '整理电脑', dueAt: '2026-10-24T07:05:00.000Z', reminderAt: '2026-10-24T07:05:00.000Z', reminderMode: 'custom' };
  for (const clock of ['15.05', '15:05', '15：05', '15．05', '15点05分', '下午3点05分', '下午三点零五分', '十五点零五分']) {
    const source = `今天${clock}提醒我整理电脑`;
    const actual = applyTaskSchedule(precise, source, now);
    assert.equal(actual.dueAt, precise.dueAt, source);
    assert.equal(actual.reminderAt, precise.reminderAt, source);
    assert.equal(actual.reminderTimes, undefined, source);
    assert.deepEqual(applyDateOnlySchedule(precise, source, now), precise, source);
  }
  const vague = applyTaskSchedule({ title: '整理电脑', reminderMode: 'none' }, '今天我要整理电脑', now);
  assert.equal(vague.reminderAt, '2026-10-24T08:04:31.207Z');
  assert.equal(vague.dueAt, '2026-10-24T15:59:00.000Z');
});
test('AI parsing preserves the source clock even when the model loses its time', async context => {
  let modelTask = { title: '整理电脑', dueAt: '2026-10-24T23:59:00+08:00', reminderMode: 'none' };
  context.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(modelTask) } }] }),
  }));
  const now = new Date('2026-10-24T15:04:31.207+08:00');
  for (const fields of [
    { dueAt: '2026-10-24T23:59:00+08:00', reminderMode: 'none' },
    { dueAt: null, reminderAt: null, reminderMode: 'custom' },
    { dueAt: '2026-10-24T23:59:00+08:00', reminderAt: null, reminderMode: 'custom' },
  ]) {
    modelTask = { title: '整理电脑', ...fields };
    const actual = await parseTask('今天15.05提醒我整理电脑', 'test-key', 'test-model', now);
    assert.equal(actual.reminderAt, '2026-10-24T07:05:00.000Z');
    assert.equal(actual.dueAt, actual.reminderAt);
    assert.equal(actual.reminderMode, 'custom');
    assert.equal(actual.sourceText, '今天15.05提醒我整理电脑');
  }
});
test('past explicit reminders keep their requested time so the scheduler can catch up', () => {
  const actual = applyTaskSchedule({ title: '整理电脑', reminderMode: 'none' }, '今天15.05提醒我整理电脑', new Date('2026-10-24T16:00:00+08:00'));
  assert.equal(actual.reminderAt, '2026-10-24T07:05:00.000Z');
});
test('future explicit reminders use their clock rather than the vague-day queue', () => {
  const actual = applyTaskSchedule({ title: '整理电脑', reminderMode: 'none' }, '后天15.05提醒我整理电脑', new Date(baseNow));
  assert.equal(actual.reminderAt, '2026-10-26T07:05:00.000Z');
  assert.equal(actual.reminderTimes, undefined);
});
test('advance reminders, multiple clocks, relative durations and opt-outs are preserved', () => {
  const now = new Date(baseNow);
  const advance = normalizeInput({ title: '开会', dueAt: '2026-10-24T15:00:00+08:00', reminderAt: '2026-10-24T14:50:00+08:00', reminderMode: 'custom' });
  for (const source of ['今天15.00开会，提前10分钟提醒', '今天15.00开会，14.50提醒我', '今天15.00开会，10分钟前提醒我']) {
    assert.deepEqual(applyTaskSchedule(advance, source, now), advance, source);
  }
  const relative = normalizeInput({ title: '整理电脑', dueAt: '2026-10-24T08:30:00+08:00', reminderAt: '2026-10-24T08:30:00+08:00', reminderMode: 'custom' });
  assert.deepEqual(applyTaskSchedule(relative, '今天30分钟后提醒我整理电脑', now), relative);
  const disabled = applyTaskSchedule(advance, '今天15.05整理电脑，不要提醒', now);
  assert.equal(disabled.reminderMode, 'none');
  assert.equal(disabled.reminderAt, undefined);
});
test('explicit deadlines without a reminder instruction retain the advance default', () => {
  const input = normalizeInput({ title: '整理电脑', dueAt: '2026-10-24T15:05:00+08:00', reminderMode: 'default' });
  assert.deepEqual(applyTaskSchedule(input, '今天15.05我要整理电脑', new Date(baseNow)), input);
  assert.equal(input.reminderAt, '2026-10-24T06:05:00.000Z');
});
test('only untouched tasks with the old override footprint are repaired', () => {
  const createdAt = '2026-10-24T07:04:32.405Z';
  const legacy = saveTaskRecord({ title: '整理电脑', dueAt: '2026-10-24T15:59:00.000Z', reminderAt: '2026-10-24T08:04:31.207Z', reminderMode: 'custom', sourceText: '今天15.05提醒我整理电脑' }, undefined, 'old', createdAt);
  assert.equal(repairOverriddenClockTask(legacy).reminderAt, '2026-10-24T07:05:00.000Z');
  assert.equal(repairOverriddenClockTask({ ...legacy, completed: true }), undefined);
  assert.equal(repairOverriddenClockTask({ ...legacy, reminderShown: true }), undefined);
  assert.equal(repairOverriddenClockTask({ ...legacy, updatedAt: '2026-10-24T07:06:00.000Z' }), undefined);
  assert.equal(repairOverriddenClockTask({ ...legacy, sourceText: '今天我要整理电脑' }), undefined);
});
test('toggling a task clears pending reminder response state', () => {
  const task = { ...saveTaskRecord({ title: '回访', dueAt: '2026-10-25T09:00:00+08:00', reminderMode: 'default' }, undefined, '1', baseNow), awaitingResponse: true, responseDueAt: '2026-10-24T00:05:00.000Z' };
  const completed = toggleTaskRecord(task, true, baseNow);
  assert.equal(completed.awaitingResponse, false);
  assert.equal(completed.responseDueAt, undefined);
});
