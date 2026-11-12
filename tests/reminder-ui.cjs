// npm run build && npx electron tests/reminder-ui.cjs
// REMINDER_SMOKE_PACKAGE points to win-unpacked to test the shipped ASAR.
const electron = require('electron');
const { app, BrowserWindow, dialog, globalShortcut, powerMonitor } = electron;
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'work');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'reminder-smoke-'));
app.setName('ReminderQueueSmoke'); app.setPath('userData', profile);
process.env.TASK_DESK_TEST_DIR = profile;
fs.mkdirSync(path.join(profile, 'documents')); app.setPath('documents', path.join(profile, 'documents'));
app.setAppPath(root);
if (process.env.REMINDER_SMOKE_PACKAGE) {
  const folder = path.resolve(process.env.REMINDER_SMOKE_PACKAGE);
  app.setAppPath(path.join(folder, 'resources/app.asar'));
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.join(folder, 'resources') });
}
app.getLoginItemSettings = () => ({ openAtLogin: false }); app.setLoginItemSettings = () => {};
const keys = new Map();
globalShortcut.register = (key, callback) => { if (key === 'Ctrl+Alt+X') return false; keys.set(key, callback); return true; };
globalShortcut.unregister = key => keys.delete(key);
const notifications = [];
class TestNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; notifications.push(this); }
  show() {}
}
dialog.showErrorBox = () => { console.error('Unexpected application error'); app.exit(1); };
const { saveTaskRecord } = require(path.join(app.getAppPath(), 'dist-electron/domain'));
const realNow = Date.now; const origin = realNow(); let clock = origin; Date.now = () => clock + realNow() - origin;
const firstDue = clock + 60000;
const make = (id, when) => saveTaskRecord({ title: id, dueAt: new Date(when).toISOString() }, undefined, id);
fs.writeFileSync(path.join(profile, 'tasks.json'), JSON.stringify([make('提醒 A', firstDue), make('提醒 B', firstDue), make('提醒 C', firstDue + 60000)]));
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ setupDone: true, paused: true, dockWidth: 360, dockHeight: 480, campusProfile: { version: 1, school: '', major: '', stage: '暂不填写', roles: '', interests: [], dateOnlyMode: 'hourly', dailyTime: '19:00', shareWithAI: false } }));
global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: '提交测试报告', dueAt: '2099-11-12T21:00:00+08:00', reminderMode: 'default', category: '学习', notes: '' }) } }] }) });
const batches = []; let hideCalls = 0;
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}; win.showInactive = () => {};
  const hide = win.hide.bind(win); win.hide = () => { hideCalls++; hide(); };
  win.webContents.setAudioMuted(true); win.webContents.setBackgroundThrottling(false);
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => { if (channel === 'reminders') batches.push(args); return send(channel, ...args); };
});
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, ...args) { return request === 'electron' ? { ...electron, Notification: TestNotification } : originalLoad.call(this, request, ...args); };
require(path.join(app.getAppPath(), 'dist-electron/main'));
Module._load = originalLoad;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
setTimeout(() => { console.error('Reminder smoke timed out'); app.exit(1); }, 60000).unref();
app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win && !win.webContents.isLoading()) break; await wait(100); }
  const js = source => win.webContents.executeJavaScript(source, true);
  async function until(expression) { for (let i = 0; i < 100; i++) { if (await js(expression)) return; await wait(60); } throw Error('UI did not reach: ' + expression); }
  const click = label => js('(() => { const b = [...document.querySelectorAll("button")].find(el => el.textContent.trim() === ' + JSON.stringify(label) + '); if (!b) throw Error("Missing button"); b.click(); })()');
  const field = (selector, text) => js('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ' + JSON.stringify(text) + '); el.dispatchEvent(new Event("input", { bubbles: true })); })()');
  const escape = () => js('(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  const currentTitle = 'document.querySelector(".reminder-prompt strong")?.textContent';
  const replySelector = '[aria-label="该行动啦"] input';
  const replyValue = 'document.querySelector(' + JSON.stringify(replySelector) + ').value';
  await until('document.querySelectorAll(".task-card").length === 3');
  await js('window.audioPlays = 0; window.Audio = class { pause() {} play() { window.audioPlays++; return Promise.resolve(); } }; void 0;');
  clock = firstDue; powerMonitor.emit('resume');
  await until(currentTitle + ' === "提醒 A"');
  assert.equal(batches.length, 1); assert.equal(batches[0][0].length, 2); assert.ok(batches[0][1]);
  assert.equal(notifications.length, 1); assert.equal(await js('audioPlays'), 1);
  assert.equal(await js('document.body.innerText.includes("还有 1 条排队")'), true);
  await field(replySelector, '我正准备');
  clock += 60000; powerMonitor.emit('resume');
  await until('document.body.innerText.includes("还有 2 条排队")');
  assert.equal(await js(currentTitle), '提醒 A'); assert.equal(await js(replyValue), '我正准备');
  assert.equal(await js('audioPlays'), 2);
  notifications[0].emit('failed'); await wait(60); assert.equal(await js(replyValue), '我正准备');
  await field(replySelector, '已完成'); await click('确认回复');
  await until(currentTitle + ' === "提醒 B"');
  await field(replySelector, '保留这个草稿'); await click('暂不回复（5分钟后提醒）');
  await until(currentTitle + ' === "提醒 C"');
  await field(replySelector, '30分钟后再提醒我'); await click('确认回复');
  await until('!document.querySelector(".reminder-prompt")'); assert.equal(await js('audioPlays'), 2);
  clock = firstDue + 300000; powerMonitor.emit('resume');
  await until(currentTitle + ' === "提醒 B"'); assert.equal(await js(replyValue), '保留这个草稿');
  assert.equal((await js('window.taskDesk.getTasks()')).value.find(t => t.id === '提醒 A').completed, true);
  await field(replySelector, '已完成'); await click('确认回复'); await until('!document.querySelector(".reminder-prompt")');
  notifications[0].emit('click'); await wait(100); assert.equal(await js('!!document.querySelector(".reminder-prompt")'), false);
  console.log('PASS: batched delivery, one sound/notification per batch, head/draft preservation, retry, completion, snooze and stale notification click.');
  keys.get('Ctrl+Alt+Q')(); await wait(100);
  assert.equal(await js('document.activeElement.getAttribute("aria-label")'), '自然语言任务');
  await field('[aria-label="自然语言任务"]', '手动记录测试'); await click('手动添加');
  await until('!!document.querySelector("[aria-label=添加任务]")');
  keys.get('Ctrl+Alt+Q')(); await wait(60);
  assert.equal(await js('document.activeElement.closest("[role=dialog]") !== null'), true);
  await click('保存任务'); await until('!!document.querySelector(".added-feedback")');
  assert.equal(await js('document.querySelector(".added-feedback").innerText.includes("未设时间 · 不提醒")'), true);
  await click('撤销'); await until('!document.querySelector(".added-feedback")');
  assert.equal((await js('window.taskDesk.getTasks()')).value.length, 3);
  assert.equal(await js('document.querySelector("[aria-label=自然语言任务]").value'), '手动记录测试');
  await click('手动添加'); await click('保存任务'); await until('!!document.querySelector(".added-feedback")');
  await click('修改'); await until('!!document.querySelector("[aria-label=编辑任务]")');
  const added = (await js('window.taskDesk.getTasks()')).value.find(t => t.title === '手动记录测试');
  await field('.draft-form input', '修改后的测试'); await click('保存任务'); await until('!document.querySelector(".draft-form")');
  assert.equal((await js('window.taskDesk.undoAddedTask(' + JSON.stringify(added.id) + ')')).ok, false);
  assert.equal((await js('window.taskDesk.getTasks()')).value.find(t => t.id === added.id).title, '修改后的测试');
  assert.equal((await js('window.taskDesk.saveSettings({apiKey:"test-only"})')).ok, true);
  await field('[aria-label="自然语言任务"]', '2099年11月12日21点提交测试报告');
  await click('添加任务'); await until('!!document.querySelector(".added-feedback")');
  assert.equal(await js('document.querySelector(".added-feedback").innerText.includes("21:00 提醒")'), true);
  assert.equal(await js('!!document.querySelector("[role=dialog]")'), false);
  await win.webContents.capturePage(); await wait(250); fs.writeFileSync(path.join(output, 'reminder-feedback-small.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
  await click('撤销'); await until('!document.querySelector(".added-feedback")');
  await js('document.querySelector("[aria-label=设置]").click()');
  await field('[aria-label="快速呼出快捷键"]', 'Ctrl+Alt+X'); await click('保存设置');
  await until('document.body.innerText.includes("已被占用")');
  assert.equal((await js('window.taskDesk.getSettings()')).value.quickShortcut, 'Ctrl+Alt+Q'); assert.ok(keys.has('Ctrl+Alt+Q'));
  await field('[aria-label="快速呼出快捷键"]', 'Ctrl+Alt+J'); await click('保存设置'); await until('!document.querySelector("[role=dialog]")');
  assert.equal(keys.has('Ctrl+Alt+Q'), false); assert.ok(keys.has('Ctrl+Alt+J'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'))).quickShortcut, 'Ctrl+Alt+J');
  keys.get('Ctrl+Alt+J')(); await wait(60); assert.equal(await js('document.activeElement.getAttribute("aria-label")'), '自然语言任务');
  await js('document.querySelector("[aria-label=设置]").click()');
  await field('[aria-label="快速呼出快捷键"]', 'Ctrl+Alt+K'); await escape();
  assert.equal((await js('window.taskDesk.getSettings()')).value.quickShortcut, 'Ctrl+Alt+J'); await until('!document.querySelector("[role=dialog]")');
  const hidesBefore = hideCalls; await escape(); await wait(250); assert.ok(hideCalls > hidesBefore);
  assert.equal(await js('document.querySelector("[aria-label=自然语言任务]").value'), '2099年11月12日21点提交测试报告');
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded;
  await until('!!document.querySelector(".composer")'); assert.equal((await js('window.taskDesk.getSettings()')).value.quickShortcut, 'Ctrl+Alt+J');
  console.log('PASS: manual/AI time feedback, guarded undo, modify, compact layout, shortcut focus, conflict rollback, persistence and Escape.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
