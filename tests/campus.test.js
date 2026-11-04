const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCampusProfile, readCampusProfile, campusAIContext } = require('../dist-electron/campus-profile');
const { dateOnlyImportSchedule, parseDocumentCandidates } = require('../dist-electron/import-domain');
const { parseTask, parseDocuments } = require('../dist-electron/ai');
const { LocalStore } = require('../dist-electron/store');

const profile = { version: 1, school: '示例大学', major: '软件工程', stage: '大二', roles: '', interests: ['竞赛科研'], dateOnlyMode: 'daily', dailyTime: '19:00', shareWithAI: true };
const now = new Date('2026-11-04T10:00:00+08:00');
const document = { id: 'notice', name: '通知.txt', text: '面向计算机学院本科生。请于2026年11月6日21:00提交竞赛报名。', warnings: [] };
const entry = { title: '提交竞赛报名', documentId: 'notice', evidence: document.text, timeStatus: 'exact', dueAt: '2026-11-06T21:00:00+08:00', reminderMode: 'default', category: '学习', assessment: { status: 'related', reason: '本科阶段与通知要求相符，专业所属学院需要确认。', audienceEvidence: '面向计算机学院本科生。', questions: [] } };

test('profile validates and allowlists fields; missing or damaged legacy profiles request setup', () => {
  assert.equal(readCampusProfile(undefined), undefined);
  assert.equal(readCampusProfile({ version: 2 }), undefined);
  assert.deepEqual(normalizeCampusProfile({ ...profile, school: ' 示例大学 ', interests: ['竞赛科研', '竞赛科研'], apiKey: 'not-a-real-key' }), profile);
  for (const patch of [{ stage: '' }, { interests: ['bogus'] }, { dailyTime: '24:00' }, { shareWithAI: 'yes' }, { major: 'a'.repeat(101) }, { dateOnlyMode: 'bogus' }]) assert.throws(() => normalizeCampusProfile({ ...profile, ...patch }));
  assert.equal(normalizeCampusProfile({ ...profile, stage: '暂不填写', school: '', major: '' }).stage, '暂不填写');
});

test('local profile persistence leaves existing tasks and encrypted credential untouched', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new LocalStore(dir);
  store.saveSettings({ encryptedApiKey: 'test-only', setupDone: true, theme: 'pink' });
  store.saveTasks([{ id: 'existing', title: '已有任务' }]);
  store.saveSettings({ ...store.settings(), campusProfile: normalizeCampusProfile(profile) });
  const reloaded = new LocalStore(dir);
  assert.deepEqual(reloaded.settings().campusProfile, profile);
  assert.equal(reloaded.settings().encryptedApiKey, 'test-only');
  assert.deepEqual(reloaded.tasks(), [{ id: 'existing', title: '已有任务' }]);
});

test('profile consent gates AI data; context excludes scheduler fields and credentials', () => {
  assert.equal(campusAIContext({ ...profile, shareWithAI: false }), undefined);
  const context = campusAIContext({ ...profile, apiKey: 'test-only', path: 'private' });
  assert.deepEqual(Object.keys(context).sort(), ['interests', 'major', 'roles', 'school', 'stage']);
  assert.equal(campusAIContext({ ...profile, stage: '暂不填写' }).stage, null);
});

test('daily preference plans each day and handles late today and past days without moving deadlines', () => {
  const scheduled = dateOnlyImportSchedule('2026-11-06', now.getTime(), profile);
  assert.equal(scheduled.reminderAt, '2026-11-04T11:00:00.000Z');
  assert.deepEqual(scheduled.reminderTimes, ['2026-11-05T11:00:00.000Z', '2026-11-06T11:00:00.000Z']);
  assert.equal(scheduled.dueAt, '2026-11-06T15:59:00.000Z');
  const late = dateOnlyImportSchedule('2026-11-04', Date.parse('2026-11-04T23:58:00+08:00'), profile);
  assert.equal(late.reminderAt, late.dueAt);
  assert.equal(dateOnlyImportSchedule('2026-11-03', now.getTime(), profile).reminderAt, undefined);
  const legacy = dateOnlyImportSchedule('2026-11-04', now.getTime());
  assert.equal(legacy.reminderAt, '2026-11-04T03:00:00.000Z');
  assert.deepEqual(legacy, dateOnlyImportSchedule('2026-11-04', now.getTime(), { ...profile, dateOnlyMode: 'hourly' }));
});

test('AI text parsing sends consented context and preserves precise times and opt-outs', async t => {
  let body;
  let answer = { title: '提交竞赛报名', timeStatus: 'date-only', dueDate: '2026-11-04', dueAt: '2026-11-04T23:59:00+08:00', reminderMode: 'default' };
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }; });
  const parse = source => parseTask(source, 'test-key', 'test-model', now, profile);
  assert.equal((await parse('今天提交竞赛报名')).reminderAt, '2026-11-04T11:00:00.000Z');
  assert.equal(JSON.parse(body.messages[1].content).campusProfile.major, profile.major);
  for (const text of ['今天晚上9.提醒我提交竞赛报名', '今天21:00提交竞赛报名']) assert.equal((await parse(text)).reminderAt, '2026-11-04T13:00:00.000Z');
  assert.equal((await parse('今天提交竞赛报名，不要提醒')).reminderAt, undefined);
  answer = { ...answer, timeStatus: 'exact', dueAt: '2026-11-04T21:00:00+08:00', reminderMode: 'custom', reminderAt: '2026-11-04T20:50:00+08:00' };
  assert.equal((await parse('今天21点提交，提前10分钟提醒')).reminderAt, '2026-11-04T12:50:00.000Z');
  answer = { title: '了解竞赛', dueAt: null, reminderMode: 'none', timeStatus: 'unknown' };
  assert.equal((await parse('了解竞赛')).reminderAt, undefined);
  await parseTask('了解竞赛', 'test-key', 'test-model', now, { ...profile, shareWithAI: false });
  assert.ok(!JSON.stringify(body.messages).includes(profile.school));
  assert.equal(body.messages.length, 2);
});

test('semantic date-only output supports non-relative dates with local preference', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: '交作业', timeStatus: 'date-only', dueDate: '2026-11-30', dueAt: '2026-11-30T23:59:00+08:00', reminderMode: 'default' }) } }] }) }));
  const task = await parseTask('月底交作业', 'test-key', 'test-model', now, profile);
  assert.equal(task.dueAt, '2026-11-30T15:59:00.000Z');
  assert.equal(task.reminderAt, '2026-11-04T11:00:00.000Z');
});

test('document matching retains unrelated and uncertain candidates for human confirmation', () => {
  const tasks = ['related', 'uncertain', 'unrelated', 'general'].map((status, index) => ({ ...entry, title: `任务${index}`, assessment: { ...entry.assessment, status } }));
  const result = parseDocumentCandidates(JSON.stringify({ tasks }), [document], now.getTime(), profile);
  assert.equal(result.length, 4);
  assert.deepEqual(result.map(item => item.needsReview), [false, true, true, false]);
  for (const item of result) assert.equal(item.task.reminderAt, '2026-11-06T13:00:00.000Z');
  const questions = parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, assessment: { ...entry.assessment, questions: ['你的专业属于计算机学院吗？'] } }] }), [document], now.getTime(), profile);
  assert.equal(questions[0].assessment.status, 'uncertain');
  assert.equal(questions[0].needsReview, true);
});

test('unsupported audience evidence and absent assessments cannot silently select tasks', () => {
  for (const assessment of [undefined, { ...entry.assessment, audienceEvidence: '这是编造的条件' }, { status: 'related' }]) {
    const result = parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, assessment }] }), [document], now.getTime(), profile);
    assert.equal(result[0].needsReview, true);
    assert.equal(result[0].assessment.status, 'uncertain');
  }
  assert.equal(parseDocumentCandidates(JSON.stringify({ tasks: [entry] }), [document], now.getTime(), { ...profile, shareWithAI: false })[0].assessment, undefined);
});

test('document follow-up uses original evidence and user clarification without sending disabled profile', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [entry] }) } }] }) }; });
  const clarification = '我的专业属于计算机学院。';
  const result = await parseDocuments([document], 'test-key', 'test-model', undefined, now, { ...profile, shareWithAI: false }, clarification);
  const data = JSON.parse(body.messages[1].content);
  assert.equal(data.campusProfile, undefined);
  assert.equal(data.clarification, clarification);
  assert.equal(data.documents[0].text, document.text);
  assert.equal(result[0].assessment.status, 'related');
  assert.match(result[0].task.notes, /本次补充/);
  await parseDocuments([document], 'test-key', 'test-model', undefined, now, profile);
  assert.equal(JSON.parse(body.messages[1].content).campusProfile.school, profile.school);
  assert.match(body.messages[0].content, /不能把缺失资料当作不符合/);
});
