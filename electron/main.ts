import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, powerMonitor, screen, Tray, Menu, safeStorage, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockWindow } from './dock';
import { LocalStore } from './store';
import { DEFAULT_MODEL, applyDateOnlySchedule, repairOverriddenClockTask, parseTask, testConnection } from './ai';
import { normalizeInput, saveTaskRecord, toggleTaskRecord, isReminderDue, reminderSchedule, parseReminderResponse, type Result, type Settings, type SettingsInput, type Task, type TaskInput } from './domain';

app.setAppUserModelId('com.local.qqslidetask');
// Tests use a separate directory and never touch real tasks or credentials.
if (!app.isPackaged && process.env.TASK_DESK_TEST_DIR) app.setPath('userData', path.resolve(process.env.TASK_DESK_TEST_DIR));
let store: LocalStore;
let window: BrowserWindow;
let dock: DockWindow;
let tray: Tray;
let quitting = false;
let reminderTimer: NodeJS.Timeout;
let parseBusy = false;
let notificationErrorShown = false;
const activeNotifications = new Set<Notification>();

function readKey() {
  const encrypted = store.settings().encryptedApiKey;
  if (!encrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，请稍后重试');
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
  catch { throw new Error('保存的 Key 无法解密，请在设置中重新粘贴自己的 Key'); }
}
function hasKey() { try { return Boolean(readKey()); } catch { return false; } }
function settings(): Settings {
  const value = store.settings();
  return { hasApiKey: hasKey(), model: value.model || DEFAULT_MODEL, paused: dock?.paused ?? Boolean(value.paused), startAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false, firstRun: !value.setupDone };
}
function validateKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || !value.trim() || /\s/.test(value.trim())) throw new Error('请输入有效的 DeepSeek API Key');
  return value.trim();
}
function validateModel(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value)) throw new Error('模型名称格式不正确');
  return value;
}
function trusted(event: IpcMainInvokeEvent | IpcMainEvent) {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
}
function handle<T>(channel: string, action: (input: any) => T | Promise<T>) {
  ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
    if (!trusted(event)) return { ok: false, error: '请求来源不受信任' };
    try { return { ok: true, value: await action(input) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作失败，请重试' }; }
  });
}
function setPaused(value: boolean) {
  store.saveSettings({ ...store.settings(), paused: value });
  dock.setPaused(value);
  refreshTray();
  window.webContents.send('paused-changed', value);
  return value;
}
function openSettings() { dock.show(true); window.webContents.send('open-settings'); }
function refreshTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '展开任务窗口', click: () => dock.show(true) },
    { label: '设置', click: openSettings },
    { label: '暂停自动隐藏', type: 'checkbox', checked: dock.paused, click: item => { try { setPaused(item.checked); } catch (error) { dialog.showErrorBox('设置保存失败', String(error)); } } },
    { type: 'separator' },
    { label: '退出轻任务', click: () => { quitting = true; app.quit(); } },
  ]));
}

function repairLegacyDateOnlyTasks(): Task[] {
  const tasks = store.tasks();
  const now = Date.now();
  let changed = false;
  for (const task of tasks) {
    const clockRepair = repairOverriddenClockTask(task);
    if (clockRepair) {
      Object.assign(task, saveTaskRecord(clockRepair, task, task.id, new Date(now).toISOString()));
      changed = true;
    }
    if (task.completed || task.reminderAt || !task.sourceText) continue;
    const repaired = applyDateOnlySchedule({ ...task, reminderMode: task.reminderMode || 'none' }, task.sourceText, new Date(now));
    if (!repaired.reminderAt) continue;
    const updated = saveTaskRecord(repaired, task, task.id, new Date(now).toISOString());
    Object.assign(task, updated);
    changed = true;
  }
  if (changed) store.saveTasks(tasks);
  return tasks;
}

function checkReminders() {
  try {
    const before = store.tasks();
    const tasks = repairLegacyDateOnlyTasks();
    const now = Date.now();
    let changed = tasks.some((task, index) => JSON.stringify(task) !== JSON.stringify(before[index]));
    for (const task of tasks) {
      if (task.completed) continue;

      // A reminder waits for a reply for five minutes. If the user did not
      // reply, repeat it. When a queued future reminder has also become due,
      // advance to that time so date-only tasks can remind across days.
      if (task.awaitingResponse && task.responseDueAt && Date.parse(task.responseDueAt) <= now) {
        const currentAt = task.reminderAt ? Date.parse(task.reminderAt) : Number.POSITIVE_INFINITY;
        const next = reminderSchedule(task).find(item => Date.parse(item) > currentAt && Date.parse(item) <= now);
        if (next) {
          task.reminderAt = next;
          task.reminderTimes = reminderSchedule(task).filter(item => Date.parse(item) > Date.parse(next));
          if (!task.reminderTimes.length) task.reminderTimes = undefined;
        }
        task.reminderShown = false;
        task.awaitingResponse = false;
        task.responseDueAt = undefined;
        task.updatedAt = new Date(now).toISOString();
        changed = true;
      }

      if (!isReminderDue(task, now)) continue;
      task.reminderShown = true;
      task.awaitingResponse = true;
      task.responseDueAt = new Date(now + 5 * 60_000).toISOString();
      task.updatedAt = new Date(now).toISOString();
      changed = true;
      const snapshot = { ...task };
      dock.show(true);
      window.webContents.send('reminder', snapshot);

      if (Notification.isSupported()) {
        const notification = new Notification({ title: '轻任务 · 该行动啦', body: `${task.title}（请回复“好”或“再提醒我30分钟后”）`, silent: false });
        activeNotifications.add(notification);
        notification.on('click', () => { dock.show(true); window.webContents.send('reminder', snapshot); activeNotifications.delete(notification); });
        notification.on('close', () => activeNotifications.delete(notification));
        notification.on('failed', () => {
          activeNotifications.delete(notification);
          window.webContents.send('reminder', { ...snapshot, notes: 'Windows 未能显示通知，请检查系统通知设置。' });
        });
        notification.show();
      }
    }
    if (changed) store.saveTasks(tasks);
  } catch (error) {
    if (!notificationErrorShown) { notificationErrorShown = true; dialog.showErrorBox('提醒检查失败', error instanceof Error ? error.message : String(error)); }
  }
}

function registerIpc() {
  handle('tasks:list', () => repairLegacyDateOnlyTasks());
  handle('tasks:save', (input: TaskInput) => {
    const clean = normalizeInput(input);
    const tasks = store.tasks();
    const existing = clean.id ? tasks.find(item => item.id === clean.id) : undefined;
    if (clean.id && !existing) throw new Error('任务已不存在，请刷新后重试');
    const task = saveTaskRecord(clean, existing, randomUUID());
    store.saveTasks(existing ? tasks.map(item => item.id === task.id ? task : item) : [task, ...tasks]);
    setTimeout(checkReminders, 250);
    return task;
  });
  handle('tasks:delete', (id: unknown) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('任务编号不正确');
    store.saveTasks(store.tasks().filter(item => item.id !== id));
    return true;
  });
  handle('tasks:toggle', (input: { id: string; completed: boolean }) => {
    if (!input || typeof input.id !== 'string' || typeof input.completed !== 'boolean') throw new Error('任务状态不正确');
    const tasks = store.tasks();
    const task = tasks.find(item => item.id === input.id);
    if (!task) throw new Error('任务已不存在');
    const updated = toggleTaskRecord(task, input.completed);
    store.saveTasks(tasks.map(item => item.id === updated.id ? updated : item));
    setTimeout(checkReminders, 250);
    return updated;
  });
  handle('reminder:respond', (input: { id: string; response: string }) => {
    if (!input || typeof input.id !== 'string' || typeof input.response !== 'string') throw new Error('提醒回复格式不正确');
    const tasks = store.tasks();
    const task = tasks.find(item => item.id === input.id);
    if (!task) throw new Error('任务已不存在');
    const response = parseReminderResponse(input.response);
    let updated: Task;
    if (response.type === 'complete') {
      updated = toggleTaskRecord(task, true);
    } else {
      const now = Date.now();
      const future = reminderSchedule(task).filter(item => Date.parse(item) > now && item !== task.reminderAt);
      updated = {
        ...task,
        reminderAt: response.reminderAt,
        reminderMode: 'custom',
        reminderTimes: future.length ? future : undefined,
        reminderShown: false,
        awaitingResponse: false,
        responseDueAt: undefined,
        updatedAt: new Date(now).toISOString(),
      };
    }
    store.saveTasks(tasks.map(item => item.id === updated.id ? updated : item));
    setTimeout(checkReminders, 250);
    return updated;
  });
  handle('settings:get', settings);
  handle('settings:save', (input: SettingsInput) => {
    if (!input || typeof input !== 'object') throw new Error('设置格式不正确');
    const value = { ...store.settings(), setupDone: true };
    if (input.apiKey !== undefined) {
      if (input.apiKey === '') value.encryptedApiKey = undefined;
      else {
        const key = validateKey(input.apiKey);
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，Key 未保存');
        value.encryptedApiKey = safeStorage.encryptString(key).toString('base64');
      }
    }
    if (input.model !== undefined) value.model = validateModel(input.model);
    if (input.startAtLogin !== undefined) {
      if (typeof input.startAtLogin !== 'boolean') throw new Error('启动选项不正确');
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: input.startAtLogin, path: process.execPath, args: ['--startup'] });
      value.startAtLogin = input.startAtLogin;
    }
    store.saveSettings(value);
    return settings();
  });
  handle('ai:test-key', async (input: { apiKey?: string; model?: string }) => {
    if (!input || typeof input !== 'object') throw new Error('连接配置不正确');
    const key = input.apiKey ? validateKey(input.apiKey) : readKey();
    if (!key) throw new Error('请先粘贴 API Key');
    return testConnection(key, validateModel(input.model || store.settings().model || DEFAULT_MODEL));
  });
  handle('ai:parse-task', async (input: unknown) => {
    if (typeof input !== 'string' || !input.trim() || input.length > 4000) throw new Error('请输入 1–4000 字的任务描述');
    if (parseBusy) throw new Error('正在整理上一条任务，请稍候');
    const key = readKey();
    if (!key) throw new Error('尚未配置 DeepSeek，可先手动添加任务');
    parseBusy = true;
    try { return await parseTask(input.trim(), key, store.settings().model || DEFAULT_MODEL); }
    finally { parseBusy = false; }
  });
  handle('window:set-paused', (paused: unknown) => {
    if (typeof paused !== 'boolean') throw new Error('暂停状态不正确');
    return setPaused(paused);
  });
  handle('window:reset-size', () => dock.resetSize());
  ipcMain.on('window:show', event => { if (trusted(event)) dock.show(true); });
  ipcMain.on('window:hide', event => { if (trusted(event)) dock.hide(); });
  ipcMain.on('window:toggle', event => { if (trusted(event)) dock.toggle(); });
  ipcMain.on('window:set-keep-open', (event, value) => { if (trusted(event) && typeof value === 'boolean') dock.setKeepOpen(value); });
  ipcMain.on('window:drag-start', event => { if (trusted(event)) dock.startDrag(); });
  ipcMain.on('window:drag-move', event => { if (trusted(event)) dock.moveDrag(); });
  ipcMain.on('window:drag-end', event => { if (trusted(event)) dock.endDrag(); });
  ipcMain.on('window:resize-start', (event, edge: unknown) => {
    if (trusted(event) && (edge === 'right' || edge === 'bottom' || edge === 'bottom-right')) dock.startResize(edge);
  });
  ipcMain.on('window:resize-move', event => { if (trusted(event)) dock.moveResize(); });
  ipcMain.on('window:resize-end', event => { if (trusted(event)) dock.endResize(); });
}

function boot() {
  store = new LocalStore(app.getPath('userData'));
  const savedSettings = store.settings();
  const g = dockGeometryPrimary();
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  window = new BrowserWindow({
    ...g, x: g.x, y: g.hiddenY, title: '轻任务 · QQ 滑出任务管家',
    // Avoid a fully transparent native surface on Windows. Some GPU/display
    // combinations create the BrowserWindow correctly but fail to composite
    // the renderer, leaving the app invisible even though it is running.
    // The panel already provides the visual styling, so an opaque native
    // background is safer and keeps the slide-out behavior unchanged.
    frame: false, thickFrame: false, transparent: false, backgroundColor: '#fbfcfb',
    resizable: false, fullscreenable: false, maximizable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  dock = new DockWindow(window, savedSettings.dockX, x => {
    try { store.saveSettings({ ...store.settings(), dockX: x }); } catch { /* Position persistence is best effort. */ }
  }, { width: savedSettings.dockWidth, height: savedSettings.dockHeight }, size => {
    try { store.saveSettings({ ...store.settings(), dockWidth: size.width, dockHeight: size.height }); }
    catch (error) { dialog.showErrorBox('窗口尺寸保存失败', error instanceof Error ? error.message : String(error)); }
  });
  dock.paused = Boolean(savedSettings.paused);
  window.removeMenu();
  window.setAlwaysOnTop(true, 'floating');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); dock.hide(); } });
  // Show the window briefly on every launch so users can confirm the app is
  // running; DockWindow returns it to the top edge automatically afterward.
  window.once('ready-to-show', () => dock.start(true));
  window.on('closed', () => { dock.dispose(); });
  window.on('blur', () => { dock.endResize(); dock.endDrag(); });
  tray = new Tray(nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="9" width="32" height="32" fill="#46a876"/><path d="m8 16 5 5L25 9" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>').toString('base64')}`));
  tray.setToolTip('轻任务 · 鼠标移到屏幕顶部即可展开');
  tray.on('click', () => dock.show(true));
  tray.on('double-click', () => dock.show(true));
  refreshTray();
  registerIpc();
  const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl); else void window.loadFile(path.join(__dirname, '../dist/index.html'));
  screen.on('display-metrics-changed', () => dock.reposition());
  screen.on('display-added', () => dock.reposition());
  screen.on('display-removed', () => dock.reposition());
  powerMonitor.on('resume', checkReminders);
  powerMonitor.on('unlock-screen', checkReminders);
  reminderTimer = setInterval(checkReminders, 10_000);
  setTimeout(checkReminders, 3000);
}
function dockGeometryPrimary() { return require('./domain').dockGeometry(screen.getPrimaryDisplay()) as ReturnType<typeof import('./domain').dockGeometry>; }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(boot).catch(error => { dialog.showErrorBox('轻任务启动失败', error instanceof Error ? error.message : String(error)); app.quit(); });
  app.on('second-instance', () => dock?.show(true));
  app.on('activate', () => dock?.show(true));
  app.on('window-all-closed', () => { /* Keep the tray app alive. */ });
  app.on('before-quit', () => { quitting = true; clearInterval(reminderTimer); dock?.dispose(); tray?.destroy(); });
}
