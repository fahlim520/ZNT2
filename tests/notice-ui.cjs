// npm run build && npx electron tests/notice-ui.cjs
// Optional NOTICE_SMOKE_PACKAGE=release/win-unpacked exercises the actual ASAR.
const { app, BrowserWindow, dialog, Notification, screen } = require('electron');
require('electron').globalShortcut.register = () => true; require('electron').globalShortcut.unregister = () => {}; const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'work');
fs.mkdirSync(output, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(output, 'notice-smoke-'));
app.setName('NoticeReviewSmoke'); app.setPath('userData', profileDir);
process.env.TASK_DESK_TEST_DIR = profileDir;
const documentsDir = path.join(profileDir, 'documents');
fs.mkdirSync(documentsDir); app.setPath('documents', documentsDir);
app.setAppPath(root);
if (process.env.NOTICE_SMOKE_PACKAGE) {
  const packageRoot = path.resolve(process.env.NOTICE_SMOKE_PACKAGE);
  app.setAppPath(path.join(packageRoot, 'resources/app.asar'));
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.join(packageRoot, 'resources') });
}
app.getLoginItemSettings = () => ({ openAtLogin: false }); app.setLoginItemSettings = () => {};
Notification.isSupported = () => false;
dialog.showErrorBox = () => { console.error('Unexpected app error dialog'); app.exit(1); };
const oldText = '校创意赛报名截止为2099年11月10日21:00。';
const newText = '校创意赛报名截止由2099年11月10日21:00延期至2099年11月12日21:00。';
const otherText = '迎新晚会将于2099年11月13日19:00开始。';
const noticeFile = path.join(documentsDir, 'notice.txt');
fs.writeFileSync(noticeFile, oldText);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [noticeFile] });
const { saveTaskRecord } = require(path.join(app.getAppPath(), 'dist-electron/domain'));
const original = saveTaskRecord({ title: '校创意赛报名', sourceType: 'file', dueAt: '2099-11-10T21:00:00+08:00', sourceText: `【原通知.txt】\n${oldText}`, notes: '保留我的备注' }, undefined, 'existing');
const campusProfile = { version: 1, school: '', major: '', stage: '暂不填写', roles: '', interests: [], dateOnlyMode: 'hourly', dailyTime: '19:00', shareWithAI: false };
fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ setupDone: true, paused: true, reminderSoundEnabled: false, campusProfile, dockWidth: 360, dockHeight: 480 }));
fs.writeFileSync(path.join(profileDir, 'tasks.json'), JSON.stringify([original]));
global.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  const data = JSON.parse(payload.messages[1].content);
  assert.ok(data.existingNotices.every(item => !('notes' in item)));
  const doc = data.documents[0];
  const isUpdate = doc.text === newText;
  const isOther = doc.text === otherText;
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [{ documentId: doc.id, title: isOther ? '参加迎新晚会' : '校创意赛报名', evidence: doc.text, timeStatus: 'exact', dueAt: isOther ? '2099-11-13T19:00:00+08:00' : isUpdate ? '2099-11-12T21:00:00+08:00' : '2099-11-10T21:00:00+08:00', reminderMode: 'default', match: isUpdate ? { kind: 'update', taskId: 'existing', reason: '同一比赛的报名截止延期', evidence: doc.text } : null }] }) } }] }) };
};
let realShow, realShowInactive;
app.on('browser-window-created', (_event, win) => {
  realShow = win.show.bind(win); realShowInactive = win.showInactive.bind(win);
  win.show = () => {}; win.showInactive = () => {}; win.webContents.setAudioMuted(true); win.webContents.setBackgroundThrottling(false);
});
require(path.join(app.getAppPath(), 'dist-electron/main'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
setTimeout(() => { console.error('Notice smoke timed out'); app.exit(1); }, 55000).unref();
app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win && !win.webContents.isLoading()) break; await wait(100); }
  assert.ok(win);
  const js = source => win.webContents.executeJavaScript(source, true);
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await wait(100); }
    throw new Error(`UI did not reach expected state: ${expression}`);
  }
  const click = text => js(`(() => { const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw Error('Missing button'); button.click(); })()`);
  async function screenshot(name) { await win.webContents.capturePage(); await wait(250); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); }
  async function openNotice(text) {
    fs.writeFileSync(noticeFile, text); await click('导入文件');
    await until('document.querySelectorAll(".import-task").length === 1');
  }
  await until('!!document.querySelector(".composer")');
  assert.equal((await js('window.taskDesk.saveSettings({apiKey:"test-only"})')).ok, true);
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded;
  await until('!!document.querySelector(".composer")'); await wait(200);
  assert.equal(await js('!!document.querySelector(".edge-handle")'), false);
  await openNotice(oldText);
  assert.equal(await js('document.querySelector("[aria-label=选择第1条任务]").disabled'), true);
  assert.equal(await js('document.body.innerText.includes("已有这条提醒")'), true);
  assert.equal((await js('window.taskDesk.getTasks()')).value.length, 1);
  await js('document.querySelector("[aria-label=关闭文件导入]").click()');
  await openNotice(newText);
  assert.equal(await js('document.querySelector("[aria-label=选择第1条任务]").checked'), false);
  assert.equal(await js('document.querySelector(".import-modal").scrollWidth <= document.querySelector(".import-modal").clientWidth'), true);
  await js('document.querySelector(".notice-match").scrollIntoView()'); await screenshot('notice-update-small.png');
  // Manual edit after analysis must survive and invalidate the stale proposal.
  const edited = await js(`window.taskDesk.saveTask(${JSON.stringify({ ...original, notes: '我刚修改的备注' })})`); assert.equal(edited.ok, true);
  await js('document.querySelector("[aria-label=选择第1条任务]").click()'); await click('确认更新 1 条');
  await until('document.querySelector(".import-modal .form-message").textContent.includes("原任务已修改")');
  assert.equal((await js('window.taskDesk.getTasks()')).value[0].dueAt, original.dueAt);
  await click('结合补充重新整理'); await click('重新整理'); await until('!!document.querySelector(".notice-update") && !document.querySelector(".spinner")');
  await js('document.querySelector("[aria-label=选择第1条任务]").click()'); await click('确认更新 1 条');
  await until('!document.querySelector(".import-modal")');
  let tasks = (await js('window.taskDesk.getTasks()')).value;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].id, original.id);
  assert.equal(tasks[0].dueAt, '2099-11-12T13:00:00.000Z'); assert.equal(tasks[0].reminderAt, tasks[0].dueAt);
  assert.ok(tasks[0].notes.startsWith('我刚修改的备注'));
  assert.equal(await js('document.querySelectorAll(".task-card").length'), 1);
  await openNotice(oldText); assert.equal(await js('document.body.innerText.includes("旧通知已处理过")'), true);
  await js('document.querySelector("[aria-label=关闭文件导入]").click()');
  await openNotice(newText); assert.equal(await js('document.querySelector("[aria-label=选择第1条任务]").disabled'), true);
  await js('document.querySelector("[aria-label=关闭文件导入]").click()');
  await openNotice(otherText);
  assert.equal(await js('document.querySelector(".import-edit").open'), false);
  await click('加入 1 条待办'); await until('!document.querySelector(".import-modal")');
  tasks = (await js('window.taskDesk.getTasks()')).value;
  assert.equal(tasks.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profileDir, 'tasks.json'))).length, 2);
  console.log('PASS: duplicate preview, explicit update confirmation, stale-edit protection, old/new repeat import, compact preview, atomic persistence and task-list merge.');
  // Use the actual native window with a simulated cursor; never move the user's mouse.
  const display = screen.getPrimaryDisplay();
  const cursor = { x: display.workArea.x + 10, y: display.workArea.y + display.workArea.height - 20 };
  screen.getCursorScreenPoint = () => ({ ...cursor });
  win.show = realShow; win.showInactive = realShowInactive;
  await js('window.taskDesk.setKeepOpen(false); window.taskDesk.setPaused(false); window.taskDesk.hideWindow()');
  await wait(700); assert.equal(win.isVisible(), false);
  const bounds = win.getBounds();
  cursor.x = bounds.x + bounds.width / 2; cursor.y = display.bounds.y;
  await wait(500); assert.equal(win.isVisible(), true); assert.equal(win.getBounds().y, display.bounds.y);
  cursor.y = display.workArea.y + display.workArea.height - 20;
  await wait(600); assert.equal(win.isVisible(), false);
  await js('window.taskDesk.showWindow()'); await wait(250); assert.equal(win.isVisible(), true);
  await js('window.taskDesk.hideWindow()'); await wait(250); assert.equal(win.isVisible(), false);
  console.log('PASS: real Electron native hide leaves no visible window; virtual edge hover and explicit/tray show reopen it; outside pointer retracts quickly.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
