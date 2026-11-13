// Run after npm run build: electron tests/campus-ui.cjs
// Set CAMPUS_SMOKE_PACKAGE to a win-unpacked directory to test the actual archive.
const { app, BrowserWindow, dialog, Notification } = require('electron');
require('electron').globalShortcut.register = () => true; require('electron').globalShortcut.unregister = () => {}; const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'work');
fs.mkdirSync(output, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(output, 'campus-smoke-'));
app.setName('CampusProfileSmoke');
app.setPath('userData', profileDir);
process.env.TASK_DESK_TEST_DIR = profileDir;
const documentsDir = path.join(profileDir, 'documents');
fs.mkdirSync(documentsDir); app.setPath('documents', documentsDir);
app.setAppPath(root);
if (process.env.CAMPUS_SMOKE_PACKAGE) {
  const packageRoot = path.resolve(process.env.CAMPUS_SMOKE_PACKAGE);
  app.setAppPath(path.join(packageRoot, 'resources/app.asar'));
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.join(packageRoot, 'resources') });
}
app.getLoginItemSettings = () => ({ openAtLogin: false });
app.setLoginItemSettings = () => {};
Notification.isSupported = () => false;
dialog.showErrorBox = () => { console.error('Unexpected app error dialog'); app.exit(1); };
const notice = path.join(documentsDir, 'notice.txt');
fs.writeFileSync(notice, '面向计算机学院本科生。请于2099年11月6日21:00提交报名。');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [notice] });
let calls = 0;
global.fetch = async (_url, options) => {
  calls++;
  const payload = JSON.parse(options.body);
  const data = JSON.parse(payload.messages[1].content);
  assert.equal(data.campusProfile.stage, '大二');
  const doc = data.documents[0];
  const clarified = !!data.clarification;
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [{ documentId: doc.id, title: '提交报名', evidence: doc.text, timeStatus: 'exact', dueAt: '2099-11-06T21:00:00+08:00', reminderMode: 'default', assessment: { status: clarified ? 'related' : 'uncertain', reason: clarified ? '补充确认了学院和本科身份。' : '还需要确认你的学院。', audienceEvidence: '面向计算机学院本科生。', questions: clarified ? [] : ['你属于计算机学院吗？'] } }] }) } }] }) };
};
fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ paused: true, reminderSoundEnabled: false, dockWidth: 360, dockHeight: 480 }));
fs.writeFileSync(path.join(profileDir, 'tasks.json'), '[]');
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}; win.showInactive = () => {}; win.webContents.setAudioMuted(true);
  win.webContents.setBackgroundThrottling(false);
});
require(path.join(app.getAppPath(), 'dist-electron/main'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
setTimeout(() => { console.error('Campus smoke timed out'); app.exit(1); }, 55000).unref();
app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win && !win.webContents.isLoading()) break; await wait(100); }
  assert.ok(win);
  const js = source => win.webContents.executeJavaScript(source, true);
  async function screenshot(name) {
    // Warm up hidden-window painting before taking the frame to inspect.
    await win.webContents.capturePage(); await wait(250);
    fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await wait(100); }
    throw new Error(`UI did not reach expected state: ${expression}`);
  }
  const click = text => js(`(() => { const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw Error('Missing button: ' + ${JSON.stringify(text)}); button.click(); })()`);
  async function field(label, value) {
    await js(`(() => { const el = document.querySelector('[aria-label=${JSON.stringify(label)}]'); const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
  }
  async function reload() { const done = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await done; await until('!!document.querySelector(".composer")'); await wait(200); }
  await until('!!document.querySelector(".campus-modal")');
  win.webContents.on('console-message', (_event, _level, message) => console.log('Renderer:', message));
  assert.equal(await js('!!document.querySelector("[aria-label=关闭校园资料]")'), false);
  win.setSize(360, 480);
  await field('学习阶段', '大二'); await field('专业或学院', '软件工程');
  await click('下一步');
  await until('!!document.querySelector("[aria-label=模糊日期提醒方式]")');
  await field('模糊日期提醒方式', 'daily'); await field('每日提醒时间', '19:30');
  await js('document.querySelector("[aria-label=允许AI使用校园资料]").click()');
  await wait(150);
  assert.equal(await js('innerWidth'), 360);
  assert.equal(await js('innerHeight'), 480);
  assert.equal(await js('document.querySelector(".campus-modal").scrollWidth <= document.querySelector(".campus-modal").clientWidth'), true);
  await screenshot('campus-onboarding-small.png');
  await click('保存并继续');
  await until('!document.querySelector(".campus-modal") && !!document.querySelector(".campus-settings-card")');
  let settings = (await js('window.taskDesk.getSettings()')).value;
  assert.equal(settings.firstRun, true); assert.equal(settings.needsCampusSetup, false);
  assert.equal(settings.campusProfile.dailyTime, '19:30'); assert.equal(settings.campusProfile.shareWithAI, true);
  await click('开始使用');
  await until('!document.querySelector(".modal")');
  await reload(); assert.equal(await js('!!document.querySelector(".modal")'), false);
  console.log('Onboarding and reload passed.');
  await js('document.querySelector("[aria-label=设置]").click()'); await click('修改资料');
  await until('!!document.querySelector(".campus-modal")');
  assert.equal(await js('document.querySelector("[aria-label=专业或学院]").value'), '软件工程');
  await js('document.querySelector("[aria-label=关闭校园资料]").click()');
  await js('document.querySelector("[aria-label=关闭对话框]").click()');
  // Manual usage without a key remains available.
  await click('手动添加');
  await until('!!document.querySelector(".draft-form")');
  await js(`(() => { const el=document.querySelector('.draft-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'离线任务'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('保存任务'); await until('!document.querySelector(".draft-form")');
  assert.equal((await js('window.taskDesk.getTasks()')).value.length, 1);
  assert.equal(calls, 0);
  console.log('Profile editing and offline task creation passed.');
  // Synthetic key + mocked API: no real network request, user key, or user data.
  assert.equal((await js('window.taskDesk.saveSettings({apiKey:"test-only"})')).ok, true);
  await reload(); await click('导入文件');
  await until('document.querySelectorAll(".import-task").length === 1');
  assert.equal(await js('document.querySelector("[aria-label=选择第1条任务]").checked'), true);
  assert.equal(await js('document.body.innerText.includes("你属于计算机学院吗？")'), true);
  await field('本次补充', '我是计算机学院的本科生。');
  await click('结合补充重新整理'); await click('重新整理');
  await until('!!document.querySelector(".assessment-related")');
  assert.equal(await js('document.querySelector("[aria-label=选择第1条任务]").checked'), true);
  assert.equal(await js('document.querySelector(".import-modal").scrollWidth <= document.querySelector(".import-modal").clientWidth'), true);
  await js('document.querySelector(".import-task").scrollIntoView()');
  await screenshot('campus-import-small.png');
  await click('加入 1 条待办'); await until('!document.querySelector(".import-modal")');
  const tasks = (await js('window.taskDesk.getTasks()')).value;
  assert.equal(tasks.length, 2); assert.equal(tasks.find(task => task.sourceType === 'file').reminderAt, '2099-11-06T13:00:00.000Z');
  const before = JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'))).encryptedApiKey;
  // Legacy users must see onboarding once while keeping their data/key.
  await js('window.taskDesk.saveSettings({campusProfile:null})'); await reload();
  await until('!!document.querySelector(".campus-modal")');
  await field('学习阶段', '暂不填写'); await click('下一步'); await click('保存并继续');
  await until('!document.querySelector(".campus-modal")'); await reload();
  assert.equal(await js('!!document.querySelector(".campus-modal")'), false);
  const after = JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'))).encryptedApiKey;
  assert.ok(before === after); assert.equal((await js('window.taskDesk.getTasks()')).value.length, 2);
  console.log('PASS: first-run and legacy onboarding, no-key manual tasks, editing/reload, encrypted credential preservation, 360x480 layout, original file extraction, AI follow-up preview (mocked), selection and exact-time persistence.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
