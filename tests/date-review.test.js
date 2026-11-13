const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dateOnlyImportSchedule, dateOnlyNotice, parseDocumentCandidates } = require('../dist-electron/import-domain');
const { parseTask, applyDateOnlySchedule } = require('../dist-electron/ai');
const { reminderSchedule, saveTaskRecord } = require('../dist-electron/domain');
const { deleteCompletedTasks } = require('../dist-electron/completed-tasks');
const now = new Date('2026-11-13T11:17:00+08:00');
const expected = ['2026-11-15T14:00:00.000Z', '2026-11-16T04:00:00.000Z'];
const profile = { version: 1, stage: '暂不填写', school: '', major: '', roles: '', interests: [], dateOnlyMode: 'daily', dailyTime: '19:00', shareWithAI: false };

test('future date-only reminder uses preceding 22:00 and requested noon for both input paths', () => {
  for (const p of [undefined, profile, { ...profile, dateOnlyMode: 'hourly' }]) {
    const task = dateOnlyImportSchedule('2026-11-16', now.getTime(), p);
    assert.deepEqual(reminderSchedule(task), expected);
    assert.equal(task.dueAt, '2026-11-16T15:59:00.000Z');
    const note = dateOnlyNotice('2026-11-16', task, now.getTime());
    assert.ok(note.includes('11/15 22:00') && note.includes('11/16 12:00'));
  }
  assert.deepEqual(reminderSchedule(applyDateOnlySchedule({ title: '交作业' }, '大后天提醒我交作业', now)), expected);
});

test('future schedule handles midnight, month/year rollover, leap days and elapsed preview slots', () => {
  for (const [created, day, times] of [
    ['2026-11-15T21:59:00+08:00', '2026-11-16', expected],
    ['2026-11-15T22:01:00+08:00', '2026-11-16', [expected[1]]],
    ['2026-12-31T12:00:00+08:00', '2027-01-01', ['2026-12-31T14:00:00.000Z', '2027-01-01T04:00:00.000Z']],
    ['2028-02-28T10:00:00+08:00', '2028-03-01', ['2028-02-29T14:00:00.000Z', '2028-03-01T04:00:00.000Z']],
  ]) assert.deepEqual(reminderSchedule(dateOnlyImportSchedule(day, Date.parse(created))), times);
  assert.equal(dateOnlyImportSchedule('2026-11-12', now.getTime()).reminderAt, undefined);
  assert.throws(() => dateOnlyImportSchedule('2026-02-30', now.getTime()), /日期无效/);
});

test('today retains existing hourly or chosen time policy and never exceeds end of day', () => {
  assert.equal(dateOnlyImportSchedule('2026-11-13', now.getTime()).reminderAt, '2026-11-13T04:17:00.000Z');
  assert.equal(dateOnlyImportSchedule('2026-11-13', now.getTime(), profile).reminderAt, '2026-11-13T11:00:00.000Z');
  const late = dateOnlyImportSchedule('2026-11-13', Date.parse('2026-11-13T23:58:00+08:00'));
  assert.equal(late.reminderAt, late.dueAt);
});

test('AI-created dates include optional precise plan notices without requiring a profile', async t => {
  let answer = { title: '交作业', timeStatus: 'date-only', dueDate: '2026-11-16', dueAt: null, reminderMode: 'default' };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }));
  for (const p of [undefined, profile]) {
    const task = await parseTask('大后天提醒我交作业', 'test', 'test', now, p);
    assert.deepEqual(reminderSchedule(task), expected);
    assert.match(task.reviewWarnings.join(''), /未说明具体时刻/);
    assert.deepEqual(saveTaskRecord(task, undefined, 'id').reviewWarnings, task.reviewWarnings);
  }
  answer = { ...answer, dueDate: '2026-11-30' };
  const month = await parseTask('月底提醒我交作业', 'test', 'test', now);
  assert.deepEqual(reminderSchedule(month), ['2026-11-29T14:00:00.000Z', '2026-11-30T04:00:00.000Z']);
});

test('explicit times, custom advances and opt-outs are never converted to vague schedules', async t => {
  let answer = { title: '交作业', timeStatus: 'exact', dueAt: '2026-11-16T21:00:00+08:00', reminderAt: '2026-11-16T20:50:00+08:00', reminderMode: 'custom' };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }));
  const precise = await parseTask('大后天晚上9.提醒我交作业', 'test', 'test', now);
  assert.deepEqual(reminderSchedule(precise), ['2026-11-16T13:00:00.000Z']);
  assert.deepEqual(precise.reviewWarnings, []);
  const advance = await parseTask('大后天21点交作业，提前10分钟提醒', 'test', 'test', now);
  assert.deepEqual(reminderSchedule(advance), ['2026-11-16T12:50:00.000Z']);
  answer = { ...answer, timeStatus: 'date-only', dueDate: '2026-11-16', reminderMode: 'none' };
  assert.equal((await parseTask('大后天交作业，不要提醒', 'test', 'test', now)).reminderAt, undefined);
  answer = { title: '交作业', timeStatus: 'unknown', dueAt: null, reminderMode: 'none', warning: '未说明哪一天。' };
  const unknown = await parseTask('找个时间交作业', 'test', 'test', now);
  assert.equal(unknown.reminderAt, undefined); assert.match(unknown.reviewWarnings.join(''), /未说明哪一天/);
});

test('ambiguous imports retain candidates and optional issues with no fabricated dates', () => {
  const document = { id: 'a', name: '通知.txt', text: '明天交作业，仅限已选课同学。', warnings: [] };
  const entry = { documentId: 'a', title: '交作业', evidence: document.text, timeStatus: 'unknown', reminderMode: 'none', warning: '缺少通知发布日期，无法确定明天。' };
  const [candidate] = parseDocumentCandidates(JSON.stringify({ tasks: [entry] }), [document], now.getTime());
  assert.equal(candidate.task.title, '交作业'); assert.equal(candidate.task.dueAt, undefined);
  assert.match(candidate.task.reviewWarnings.join(''), /发布日期/);
  assert.equal(saveTaskRecord(candidate.task, undefined, 'saved').reminderAt, undefined);
});

test('batch deletion only removes selected completed tasks and deduplicates IDs', () => {
  const make = (id, completed) => ({ ...saveTaskRecord({ title: id }, undefined, id), completed });
  const tasks = [make('done1', true), make('done2', true), make('pending', false), make('kept', true)];
  const deleted = deleteCompletedTasks(tasks, ['done2', 'done1', 'done1']);
  assert.deepEqual(deleted.deletedIds, ['done2', 'done1']);
  assert.deepEqual(deleted.tasks.map(task => task.id), ['pending', 'kept']);
  assert.equal(tasks.length, 4);
  for (const ids of [[], ['pending'], ['done1', 'pending'], ['done1', 'missing'], [null], 'done1', Array(5001).fill('done1')]) {
    assert.throws(() => deleteCompletedTasks(tasks, ids));
    assert.equal(tasks.length, 4);
  }
});
