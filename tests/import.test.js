const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { textPdf, scanPdf, imageCanvas, docx } = require('./import-fixtures');
const { extractFiles } = require('../dist-electron/import-extract');
const { parseDocumentCandidates, dateOnlyImportSchedule } = require('../dist-electron/import-domain');
const { saveTaskRecord, normalizeInput } = require('../dist-electron/domain');
const { LocalStore } = require('../dist-electron/store');
const { parseDocuments } = require('../dist-electron/ai');
const resources = path.resolve(__dirname, '../electron/resources');
const now = Date.parse('2026-10-24T10:00:00+08:00');
const document = { id: 'doc-1', name: '校园通知.pdf', text: '[第 1 页]\n2026年10月26日15:05提醒我提交报名材料。\n2026年10月27日参加校园讲座。\n月底交作业。', warnings: [] };
const entry = { title: '提交报名材料', documentId: document.id, evidence: '2026年10月26日15:05提醒我提交报名材料。', category: '学习', timeStatus: 'exact', dueAt: '2026-10-26T15:05:00+08:00', reminderMode: 'custom', reminderAt: '2026-10-26T15:05:00+08:00' };

test('document events keep separate explicit clocks, date-only schedules, and uncertain dates', () => {
  const result = parseDocumentCandidates(JSON.stringify({ tasks: [entry, { ...entry, title: '参加校园讲座', evidence: '2026年10月27日参加校园讲座。', timeStatus: 'date-only', dueDate: '2026-10-27', reminderMode: 'default' }, { ...entry, title: '交作业', evidence: '月底交作业。', timeStatus: 'unknown' }] }), [document], now);
  assert.equal(result[0].task.reminderAt, '2026-10-26T07:05:00.000Z');
  assert.equal(result[0].task.sourceType, 'file');
  assert.match(result[0].task.notes, /校园通知.pdf/);
  assert.equal(result[1].task.dueAt, '2026-10-27T15:59:00.000Z');
  assert.equal(result[1].task.reminderAt, '2026-10-24T03:00:00.000Z');
  assert.ok(result[1].task.reminderTimes.includes('2026-10-25T01:00:00.000Z'));
  assert.ok(result[1].task.reminderTimes.includes('2026-10-27T02:00:00.000Z'));
  assert.equal(result[2].task.dueAt, undefined);
  assert.equal(result[2].task.reminderAt, undefined);
  assert.equal(result[2].needsReview, true);
});

test('unverifiable evidence, bad source, invented year, duplicates, and invalid dates need attention', () => {
  assert.throws(() => parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, evidence: 'invented evidence' }] }), [document], now), /无法核对/);
  assert.throws(() => parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, documentId: 'wrong' }] }), [document], now), /来源/);
  const short = { ...document, text: '今天15:05提醒我报名。' };
  const result = parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, evidence: short.text }] }), [short], now);
  assert.equal(result[0].needsReview, true); assert.equal(result[0].task.dueAt, undefined);
  const duplicate = parseDocumentCandidates(JSON.stringify({ tasks: [entry, entry] }), [document], now);
  assert.equal(duplicate[1].needsReview, true);
  const badDate = parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, timeStatus: 'date-only', dueDate: '2026-02-30' }] }), [document], now);
  assert.equal(badDate[0].task.dueAt, undefined); assert.equal(badDate[0].needsReview, true);
  const invalidClockDate = parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, dueAt: '2026-02-30T15:05:00+08:00', reminderAt: '2026-02-30T15:05:00+08:00' }] }), [document], now);
  assert.equal(invalidClockDate[0].task.dueAt, undefined); assert.equal(invalidClockDate[0].needsReview, true);
});

test('today-only files remind hourly and past dates never silently become today', () => {
  const schedule = dateOnlyImportSchedule('2026-10-24', now);
  assert.equal(schedule.reminderAt, '2026-10-24T03:00:00.000Z');
  assert.equal(schedule.reminderTimes[0], '2026-10-24T04:00:00.000Z');
  const past = parseDocumentCandidates(JSON.stringify({ tasks: [{ ...entry, dueAt: '2025-10-26T15:05:00+08:00', reminderAt: '2025-10-26T15:05:00+08:00' }] }), [document], now);
  assert.equal(past[0].needsReview, true); assert.match(past[0].warnings.join(''), /已经过去/);
});

test('extract PDF text, DOCX paragraphs, UTF-16 text, and per-file failures without losing successes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-import-test-')); t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const files = { 'notice.pdf': textPdf(), 'notice.docx': await docx(), 'notice.txt': Buffer.concat([Buffer.from([255,254]), Buffer.from('明天整理电脑', 'utf16le')]), 'bad.pdf': Buffer.from('broken pdf'), 'unsupported.exe': Buffer.from('not executable'), 'broken.doc': Buffer.from('broken word') };
  await Promise.all(Object.entries(files).map(([name, contents]) => fs.writeFile(path.join(dir, name), contents)));
  const documents = await extractFiles(Object.keys(files).map(name => path.join(dir, name)), resources);
  assert.match(documents[0].text, /Campus deadline 2026-10-26 15:05/);
  assert.match(documents[0].text, /第 1 页/);
  assert.match(documents[1].text, /学生事务中心/);
  assert.equal(documents[2].text, '明天整理电脑');
  assert.match(documents[3].error, /损坏|有效/);
  assert.match(documents[4].error, /不支持/);
  assert.ok(documents[5].error);
  assert.equal(documents.length, 6);
});

test('bounds prevent large, empty, and excessive imports; long text has visible truncation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-import-limit-')); t.after(() => fs.rm(dir, { force: true, recursive: true }));
  await assert.rejects(extractFiles(Array(9).fill(path.join(dir, 'a.txt')), resources), /1–8/);
  const big = path.join(dir, 'big.txt'); await fs.writeFile(big, Buffer.alloc(20 * 1024 * 1024 + 1));
  const empty = path.join(dir, 'empty.txt'); await fs.writeFile(empty, '');
  const long = path.join(dir, 'long.txt'); await fs.writeFile(long, '学习'.repeat(30_000));
  const result = await extractFiles([big, empty, long], resources);
  assert.match(result[0].error, /20 MB/); assert.match(result[1].error, /为空/);
  assert.equal(result[2].text.length, 50_000); assert.match(result[2].warnings.join(''), /截断/);
});

test('Windows OCR reads a Chinese screenshot and scanned PDF locally', { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-import-ocr-')); t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const canvas = imageCanvas();
  const image = path.join(dir, 'screenshot.png'), scan = path.join(dir, 'scan.pdf');
  await fs.writeFile(image, canvas.toBuffer('image/png')); await fs.writeFile(scan, scanPdf(canvas));
  const docs = await extractFiles([image, scan], resources);
  for (const doc of docs) { assert.equal(doc.error, undefined); assert.match(doc.text.replace(/\s/g, ''), /2026年10月26日15[：:]05提交报名材料/); assert.match(doc.warnings.join(''), /OCR/); }
});

test('import persistence preserves provenance and rejects a bad batch before writing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-import-store-')); t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const store = new LocalStore(dir);
  const parsed = parseDocumentCandidates(JSON.stringify({ tasks: [entry] }), [document], now);
  const original = saveTaskRecord(parsed[0].task, undefined, 'import-1'); store.saveTasks([original]);
  assert.equal(new LocalStore(dir).tasks()[0].sourceType, 'file');
  assert.throws(() => { const candidates = [parsed[0].task, { title: '' }].map(input => normalizeInput(input)); store.saveTasks(candidates); }, /名称/);
  assert.equal(store.tasks().length, 1); assert.equal(store.tasks()[0].id, 'import-1');
});

test('document AI errors and cancellation preserve extracted text for manual recovery', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(parseDocuments([document], 'test-only', 'test-model'), /Key 无效/);
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not JSON' } }] }) });
  await assert.rejects(parseDocuments([document], 'test-only', 'test-model'), /原文已保留/);
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(new TypeError('aborted'));
    else options.signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true });
  });
  const controller = new AbortController();
  const pending = parseDocuments([document], 'test-only', 'test-model', controller.signal);
  controller.abort();
  await assert.rejects(pending, /已取消整理/);
  assert.match(document.text, /2026年10月26日15:05/);
});
