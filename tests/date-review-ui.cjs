// npm run build && npx electron tests/reminder-ui.cjs
// DATE_REVIEW_SMOKE_PACKAGE points to win-unpacked to test the shipped ASAR.
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
app.setName('DateReviewSmoke'); app.setPath('userData', profile);
process.env.TASK_DESK_TEST_DIR = profile;
fs.mkdirSync(path.join(profile, 'documents')); app.setPath('documents', path.join(profile, 'documents'));
app.setAppPath(root);
if (process.env.DATE_REVIEW_SMOKE_PACKAGE) {
  const folder = path.resolve(process.env.DATE_REVIEW_SMOKE_PACKAGE);
  app.setAppPath(path.join(folder, 'resources/app.asar'));
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: path.join(folder, 'resources') });
}
app.getLoginItemSettings = () => ({ openAtLogin: false }); app.setLoginItemSettings = () => {};
const keys = new Map();
globalShortcut.register = (key, callback) => { if (key === 'Ctrl+Alt+X') return false; keys.set(key, callback); return true; };
globalShortcut.unregister = key => keys.delete(key);
const notifications = []; let failNotice = false;
class TestNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; notifications.push(this); }
  show() { if (failNotice) throw Error('simulated native notification failure'); }
}
dialog.showErrorBox = () => { console.error('Unexpected application error'); app.exit(1); };
const { saveTaskRecord } = require(path.join(app.getAppPath(), 'dist-electron/domain'));
const realNow = Date.now; const origin = realNow(); let clock = origin; Date.now = () => clock + realNow() - origin;
const firstDue = clock + 60000;
const make = (id, when) => saveTaskRecord({ title: id, dueAt: new Date(when).toISOString() }, undefined, id);
fs.writeFileSync(path.join(profile, 'tasks.json'), JSON.stringify(['已完成甲','已完成乙','已完成丙'].map(id => ({...saveTaskRecord({title:id}, undefined, id), completed:true})).concat([saveTaskRecord({title:'保留待办'},undefined,'保留待办')])));
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ setupDone: true, paused: true, dockWidth: 360, dockHeight: 480, campusProfile: { version: 1, school: '', major: '', stage: '暂不填写', roles: '', interests: [], dateOnlyMode: 'hourly', dailyTime: '19:00', shareWithAI: false } }));
const noticeFile = path.join(profile, '通知.txt'); fs.writeFileSync(noticeFile, '明天交作业，仅限已选课同学。');
dialog.showOpenDialog = async () => ({canceled:false,filePaths:[noticeFile]});
global.fetch = async (_url, init) => {
  const messages=JSON.parse(init.body).messages;
  let answer;
  if(messages[0].content.includes('通知转待办')) {
    const doc=JSON.parse(messages[1].content).documents[0];
    answer={tasks:[{documentId:doc.id,title:'通知里的作业',evidence:doc.text,timeStatus:'unknown',dueAt:null,reminderMode:'none',warning:'缺少通知发布日期，无法确定明天是哪一天。'}]};
  } else answer={title:'大后天交作业',dueDate:'2099-01-01',timeStatus:'date-only',dueAt:null,reminderMode:'default'};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(answer)}}]})};
};
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
  const state=async()=>(await js('window.taskDesk.getTasks()')).value;
  const reload=async()=>{const ready=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await ready;await until('!!document.querySelector(".composer")');await wait(150);};
  await until('!!document.querySelector(".composer")');
  assert.equal((await js('window.taskDesk.saveSettings({apiKey:"test-only"})')).ok,true);await reload();
  await field('[aria-label="自然语言任务"]','大后天提醒我交作业');await click('添加任务');await until('!!document.querySelector(".added-feedback")');
  let task=(await state()).find(t=>t.title==='大后天交作业');
  const time=at=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));
  assert.equal(time(task.reminderAt),'22:00');assert.equal(task.reminderTimes.length,1);assert.equal(time(task.reminderTimes[0]),'12:00');
  assert.equal(notifications.length,1);assert.match(notifications[0].options.body,/未说明具体时刻/);
  assert.ok(notifications[0].options.body.includes('22:00')&&notifications[0].options.body.includes('12:00'));
  assert.equal(await js('!!document.querySelector("[role=dialog]")'),false);
  notifications[0].emit('click');await wait(60);assert.equal(await js('!!document.querySelector("[role=dialog]")'),false);
  failNotice=true;await field('[aria-label="自然语言任务"]','大后天提醒我交作业');await click('添加任务');await until('document.querySelectorAll(".task-review-note").length===2');failNotice=false;
  console.log('PASS: evening/noon reminders, optional native notification and failure fallback.');
  await click('导入文件');await until('document.querySelectorAll(".import-task").length===1');
  assert.equal(await js('document.querySelector("[aria-label=选择第1条任务]").checked'),true);
  assert.equal(await js('document.querySelector(".import-clarification").open'),false);
  assert.match(notifications.at(-1).options.body,/发布日期/);
  await click('加入 1 条待办');await until('!document.querySelector(".import-modal")');
  task=(await state()).find(t=>t.title==='通知里的作业');assert.ok(task);assert.equal(task.reminderAt,undefined);assert.match(task.reviewWarnings.join(''),/发布日期/);
  console.log('PASS: ambiguous import saves without mandatory answers.');
  await js('[...document.querySelectorAll(".filter-tabs button")].find(b=>b.textContent.startsWith("已完成")).click()');await until('document.querySelectorAll(".task-card").length===3');
  await click('批量删除');await js('document.querySelector("[aria-label=全选当前列表]").click()');await wait(60);
  assert.equal(await js('document.querySelectorAll(".bulk-task-check:checked").length'),3);
  await field('[aria-label="搜索任务"]','已完成甲');await wait(100);assert.equal(await js('document.querySelectorAll(".bulk-task-check").length'),0);
  await click('批量删除');await js('document.querySelector("[aria-label=全选当前列表]").click()');await wait(60);await click('删除所选');
  await until('!!document.querySelector("[aria-label=删除所选已完成任务？]")');assert.equal(await js('document.querySelector(".bulk-delete-preview").children.length'),1);
  await click('取消');assert.equal((await state()).length,7);
  await field('[aria-label="搜索任务"]','');await wait(100);await click('批量删除');await js('document.querySelector("[aria-label=全选当前列表]").click()');await wait(60);
  await js('document.querySelector("[aria-label=选择删除：已完成丙]").click()');await wait(60);assert.equal(await js('document.querySelectorAll(".bulk-task-check:checked").length'),2);
  assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
  fs.writeFileSync(path.join(output,'completed-bulk-small.png'),(await win.webContents.capturePage()).toPNG());
  await click('删除所选');await until('!!document.querySelector("[aria-label=删除所选已完成任务？]")');await click('确认批量删除');await until('!document.querySelector("[role=dialog]")');
  assert.deepEqual((await state()).filter(t=>t.completed).map(t=>t.id),['已完成丙']);assert.ok((await state()).some(t=>t.id==='保留待办'));
  await click('批量删除');await js('document.querySelector("[aria-label=全选当前列表]").click()');await wait(60);await click('删除所选');await until('!!document.querySelector("[aria-label=删除所选已完成任务？]")');
  await js('window.taskDesk.toggleTask("已完成丙",false)');await click('确认批量删除');await until('document.body.innerText.includes("本次未删除任何任务")');
  assert.ok((await state()).some(t=>t.id==='已完成丙'));await click('取消');await reload();assert.equal((await state()).length,5);
  console.log('PASS: bulk selection, filtering, cancellation, deletion persistence and pending-task protection at compact size.');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
