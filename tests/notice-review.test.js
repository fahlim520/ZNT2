const test = require('node:test');
const assert = require('node:assert/strict');
const { saveTaskRecord } = require('../dist-electron/domain');
const { parseDocumentCandidates } = require('../dist-electron/import-domain');
const { noticeContext, noticeContextData, noticeRevision, prepareImportSave } = require('../dist-electron/notice-review');
const { parseDocuments } = require('../dist-electron/ai');
const now = new Date('2026-11-05T10:00:00+08:00');
const oldText = '校创意赛报名截止为2026年11月10日21:00。';
const newText = '校创意赛报名截止由2026年11月10日21:00延期至2026年11月12日21:00。';
const original = saveTaskRecord({ title: '校创意赛报名', sourceType: 'file', dueAt: '2026-11-10T21:00:00+08:00', category: '学习', notes: '我的个人备注', sourceText: `【通知.txt】\n${oldText}` }, undefined, 'original', now.toISOString());
const doc = { id: 'd', name: '补充通知.txt', text: newText, warnings: [] };
const entry = { documentId: 'd', title: '提交校创意赛报名', evidence: newText, timeStatus: 'exact', dueAt: '2026-11-12T21:00:00+08:00', reminderMode: 'default', match: { kind: 'update', taskId: 'original', reason: '同一竞赛报名截止延期', evidence: newText } };
const parse = (items, docs = [doc], tasks = [original]) => parseDocumentCandidates(JSON.stringify({ tasks: items }), docs, now.getTime(), undefined, '', tasks);
const save = (inputs, candidates, tasks = [original]) => prepareImportSave(inputs, candidates, tasks, now.toISOString());

test('same notification with renamed file is duplicate; completed tasks remain completed', () => {
  const repeated = { ...doc, name: '另一张截图.png', text: oldText };
  const candidate = parse([{ ...entry, title: original.title, evidence: oldText, dueAt: original.dueAt, match: null }], [repeated], [{ ...original, completed: true }])[0];
  assert.equal(candidate.match.kind, 'duplicate'); assert.equal(candidate.match.completed, true); assert.equal(candidate.needsReview, true);
  const result = save([{ task: candidate.task, candidateId: candidate.id, action: 'create' }], [candidate], [{ ...original, completed: true }]);
  assert.equal(result.result.skipped, 1); assert.equal(result.allTasks.length, 1); assert.equal(result.allTasks[0].completed, true);
});

test('verified update requires explicit action and retains ID, user notes, title, category and history', () => {
  const [candidate] = parse([entry]);
  assert.equal(candidate.match.kind, 'update'); assert.equal(candidate.needsReview, true);
  const result = save([{ task: candidate.task, candidateId: candidate.id, action: 'update' }], [candidate]);
  assert.equal(result.allTasks.length, 1); assert.equal(result.result.updated, 1);
  const task = result.result.tasks[0];
  assert.equal(task.id, original.id); assert.equal(task.createdAt, original.createdAt);
  assert.equal(task.title, original.title); assert.equal(task.category, original.category);
  assert.ok(task.notes.startsWith(original.notes)); assert.ok(task.notes.includes(newText));
  assert.equal(task.reminderAt, '2026-11-12T13:00:00.000Z'); assert.equal(task.reminderAt, task.dueAt);
  assert.equal(task.reminderShown, false); assert.equal(task.awaitingResponse, false);
  assert.equal(task.noticeHistory.length, 2);
  const [oldAgain] = parse([{ ...entry, title: original.title, evidence: oldText, dueAt: original.dueAt, match: null }], [{ ...doc, text: oldText }], [task]);
  assert.equal(oldAgain.match.kind, 'duplicate'); assert.match(oldAgain.match.reason, /旧通知/);
  const [newAgain] = parse([{ ...entry, match: null }], [doc], [task]);
  assert.equal(newAgain.match.kind, 'duplicate');
  assert.equal(noticeContextData([task])[0].sourceExcerpt, newText);
});

test('stale, missing and forged update targets cannot overwrite newer user edits', () => {
  const [candidate] = parse([entry]);
  const input = { task: candidate.task, candidateId: candidate.id, action: 'update' };
  for (const tasks of [[], [{ ...original, notes: '新的备注' }], [{ ...original, completed: true }]]) assert.throws(() => save([input], [candidate], tasks), /修改或删除/);
  assert.throws(() => save([input], []), /预览已失效/);
  const unchanged = { ...original, updatedAt: new Date().toISOString(), reminderShown: true, awaitingResponse: true };
  assert.equal(noticeRevision(unchanged), noticeRevision(original));
  assert.equal(save([input], [candidate], [unchanged]).result.updated, 1);
});

test('duplicate model suggestions cannot hide changed dates or unverifiable claims', () => {
  const variants = [
    { ...entry.match, kind: 'duplicate' },
    { ...entry.match, taskId: 'invented-id' },
    { ...entry.match, evidence: '编造的延期' },
  ];
  for (const match of variants) { const [candidate] = parse([{ ...entry, match }]); assert.equal(candidate.match, undefined); assert.equal(candidate.needsReview, true); }
  const [unknown] = parse([{ ...entry, timeStatus: 'unknown', dueAt: null }]);
  assert.equal(unknown.match, undefined); assert.equal(unknown.task.reminderAt, undefined);
});

test('same short title across different events is not locally merged; uncertain links create nothing automatically', () => {
  const [candidate] = parse([{ ...entry, title: original.title, dueAt: original.dueAt, evidence: '另一个比赛报名截止为2026年11月10日21:00。', match: null }], [{ ...doc, text: '另一个比赛报名截止为2026年11月10日21:00。' }]);
  assert.equal(candidate.match, undefined);
  assert.equal(save([{ task: candidate.task, action: 'create' }], [candidate]).allTasks.length, 2);
});

test('save is atomic, skips repeated manual/file inputs, and permits deliberate separate tasks', () => {
  const input = { task: { ...original, id: undefined }, action: 'create' };
  const result = save([input, input], []);
  assert.equal(result.allTasks.length, 1); assert.equal(result.result.skipped, 2);
  assert.throws(() => save([input, { task: { title: '' }, action: 'create' }], []), /名称/);
  assert.equal(original.notes, '我的个人备注');
  assert.equal(save([{ ...input, forceCreate: true }], []).allTasks.length, 2);
});

test('completed updates stay completed and long user notes are never truncated', () => {
  const existing = { ...original, notes: '文'.repeat(4000), completed: true };
  const [candidate] = parse([entry], [doc], [existing]);
  const task = save([{ task: candidate.task, candidateId: candidate.id, action: 'update' }], [candidate], [existing]).result.tasks[0];
  assert.equal(task.completed, true); assert.equal(task.reminderShown, true);
  assert.equal(task.notes, existing.notes); assert.equal(task.noticeHistory.length, 2);
});

test('AI context is bounded, excludes manual tasks, settings, reminder responses and personal notes', async t => {
  const existing = Array.from({ length: 100 }, (_, i) => ({ ...original, id: `f-${i}`, title: `活动${i}` }));
  existing.push({ ...original, id: 'manual', sourceType: 'text', title: '私事' });
  const context = noticeContext(existing, [doc]); assert.equal(context.length, 60);
  const fields = noticeContextData(context);
  assert.deepEqual(Object.keys(fields[0]).sort(), ['completed', 'dueAt', 'id', 'sourceExcerpt', 'title']);
  assert.ok(!JSON.stringify(fields).includes(original.notes)); assert.ok(!fields.some(item => item.id === 'manual'));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    const data = JSON.parse(body.messages[1].content);
    assert.equal(data.existingNotices.length, 60);
    assert.ok(!JSON.stringify(data).includes(original.notes));
    assert.match(body.messages[0].content, /不能因为导入得晚就判定通知更新/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"tasks":[]}' } }] }) };
  });
  assert.deepEqual(await parseDocuments([doc], 'test-only', 'test-model', undefined, now, undefined, '', existing), []);
});
