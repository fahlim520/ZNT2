import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification, powerMonitor, screen, shell, Tray, Menu, safeStorage, utilityProcess, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DockWindow } from './dock';
import { LocalStore } from './store';
import { initializeReminderAudioFolder, readNextReminderSound } from './reminder-audio';
import { DEFAULT_MODEL, applyDateOnlySchedule, repairOverriddenClockTask, parseTask, parseDocuments, testConnection } from './ai';
import { IMPORT_EXTENSIONS, IMPORT_LIMITS, type ImportedDocument } from './import-domain';
import { normalizeInput, saveTaskRecord, toggleTaskRecord, isReminderDue, reminderSchedule, parseReminderResponse, THEMES, type ReminderSound, type Result, type Settings, type SettingsInput, type Task, type TaskInput, type Theme } from './domain';

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
let importBusy = false;
let importWorker: Electron.UtilityProcess | undefined;
let importController: AbortController | undefined;
let importedDocuments: ImportedDocument[] = [];
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
  const theme: Theme = value.theme && THEMES.includes(value.theme) ? value.theme : 'green';
  return { hasApiKey: hasKey(), model: value.model || DEFAULT_MODEL, paused: dock?.paused ?? Boolean(value.paused), startAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false, firstRun: !value.setupDone, reminderSoundEnabled: value.reminderSoundEnabled !== false, theme };
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

function reminderAudioDirectory() {
  return path.join(app.getPath('documents'), '轻任务', '提醒音频');
}
function reminderAudioSources() {
  return [
    path.join(app.getPath('documents'), 'QQ滑出任务管家', '提醒音频'),
    path.join(app.getPath('userData'), 'reminder-audio'),
    path.join(app.getAppPath(), 'assets', 'reminder-audio'),
  ];
}
function nextReminderSound(): ReminderSound | undefined {
  const saved = store.settings();
  const next = readNextReminderSound([reminderAudioDirectory(), ...reminderAudioSources()], saved.reminderSoundIndex);
  if (!next) return undefined;
  store.saveSettings({ ...saved, reminderSoundIndex: next.nextIndex });
  return next.sound;
}

function repairLegacyDateOnlyTasks(): Task[] {
  const tasks = store.tasks();
  const now = Date.now();
  let changed = false;
  for (const task of tasks) {
    if (task.sourceType === 'file') continue;
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
      const sound = store.settings().reminderSoundEnabled === false ? undefined : nextReminderSound();
      dock.show(true);
      window.webContents.send('reminder', snapshot, sound);

      if (Notification.isSupported()) {
        const notification = new Notification({ title: '轻任务 · 该行动啦', body: `${task.title}（请回复“好”或“再提醒我30分钟后”）`, silent: true });
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
  const importProgress = (message: string) => { if (!window.isDestroyed()) window.webContents.send('import:progress', { message }); };
  const extract = async (paths: string[]) => {
    const resources = app.isPackaged ? path.join(process.resourcesPath, 'import-resources') : path.join(app.getAppPath(), 'electron', 'resources');
    const controller = new AbortController(); importController = controller;
    try {
      const documents = await new Promise<ImportedDocument[]>((resolve, reject) => {
        const worker = utilityProcess.fork(path.join(__dirname, 'import-worker.js'), [], { serviceName: '轻任务文件识别', stdio: 'ignore' });
        worker.once('spawn', () => worker.postMessage({ type: 'extract', paths, resources }));
        importWorker = worker;
        let done = false;
        const timer = setTimeout(() => { worker.postMessage('cancel'); reject(new Error('文件识别超时，请拆分文件后重试')); setTimeout(() => worker.kill(), 2000).unref(); }, 180_000);
        const cancel = () => { worker.postMessage('cancel'); setTimeout(() => worker.kill(), 2000).unref(); reject(new Error('已取消导入')); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', cancel); if (importWorker === worker) importWorker = undefined; };
        worker.on('message', (message: { progress?: string; documents?: ImportedDocument[]; error?: string }) => {
          if (message.progress && !controller.signal.aborted) importProgress(message.progress);
          if (message.documents) { done = true; cleanup(); resolve(message.documents); }
          if (message.error) { done = true; cleanup(); reject(new Error(message.error)); }
        });
        worker.once('error', () => { cleanup(); reject(new Error('文件识别进程发生错误，请重试或更换文件')); });
        worker.once('exit', () => { cleanup(); if (!done) reject(new Error(controller.signal.aborted ? '已取消导入' : '文件识别进程退出，请换用较小的文件')); });
      });
      if (controller.signal.aborted) throw new Error('已取消导入');
      importedDocuments = documents;
      return documents;
    } finally { if (importController === controller) importController = undefined; }
  };
  const runImport = async (action: () => Promise<ImportedDocument[]>) => {
    if (importBusy) throw new Error('正在识别文件，请稍候或取消');
    importBusy = true;
    try { return await action(); } finally { importBusy = false; }
  };
  handle('import:choose', () => runImport(async () => {
    const selection = await dialog.showOpenDialog(window, { title: '导入通知或截图', properties: ['openFile', 'multiSelections'], filters: [{ name: '支持的文档和图片', extensions: IMPORT_EXTENSIONS }, { name: '所有文件', extensions: ['*'] }] });
    if (selection.canceled || !selection.filePaths.length) return [];
    return extract(selection.filePaths);
  }));
  handle('import:drop', (paths: string[]) => runImport(() => extract(paths)));
  handle('import:clipboard', () => runImport(async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) throw new Error('剪贴板里没有图片，请先截图或复制图片');
    const size = image.getSize();
    if (size.width * size.height > 80_000_000) throw new Error('剪贴板图片过大，请裁剪后重试');
    const png = image.toPNG();
    if (png.length > IMPORT_LIMITS.fileBytes) throw new Error('截图超过 20 MB，请裁剪后重试');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qing-task-paste-'));
    const filename = path.join(directory, '粘贴截图.png');
    try { await fs.writeFile(filename, png); return await extract([filename]); }
    finally { await fs.rm(directory, { force: true, recursive: true }).catch(() => {}); }
  }));
  handle('import:parse', async (documents: ImportedDocument[]) => {
    if (parseBusy || importBusy) throw new Error('正在处理上一条请求，请稍候');
    if (!Array.isArray(documents) || !documents.length || documents.length > IMPORT_LIMITS.files) throw new Error('请先导入文件');
    let length = 0;
    const seen = new Set<string>();
    const checked = documents.map(item => {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || seen.has(item.id)) throw new Error('文件内容格式不正确');
      seen.add(item.id);
      const original = importedDocuments.find(original => original.id === item.id && !original.error);
      if (!original) throw new Error('导入会话已结束，请重新选择文件');
      length += item.text.length;
      if (length > IMPORT_LIMITS.text) throw new Error('文字合计不能超过 5 万字，请拆分导入');
      return { ...original, text: item.text.trim() };
    }).filter(item => item.text);
    if (!checked.length) throw new Error('识别原文为空，请先补充文字');
    const key = readKey();
    if (!key) throw new Error('尚未配置 DeepSeek，可以根据识别原文手动创建任务');
    parseBusy = true;
    const controller = new AbortController(); importController = controller;
    importProgress('正在把通知整理为待办，并核对时间…');
    try { return await parseDocuments(checked, key, store.settings().model || DEFAULT_MODEL, controller.signal); }
    finally { parseBusy = false; if (importController === controller) importController = undefined; }
  });
  handle('import:save', (inputs: TaskInput[]) => {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > IMPORT_LIMITS.tasks) throw new Error('请选择 1–40 条任务');
    // Validate the entire batch before writing so a bad final task cannot leave
    // a partly imported list. File candidates always create new task IDs.
    const now = new Date().toISOString();
    const tasks = inputs.map(input => {
      if (!input || input.id) throw new Error('导入任务格式不正确');
      return saveTaskRecord({ ...input, sourceType: 'file' }, undefined, randomUUID(), now);
    });
    store.saveTasks([...tasks, ...store.tasks()]);
    importedDocuments = [];
    setTimeout(checkReminders, 250);
    return tasks;
  });
  ipcMain.on('import:cancel', event => {
    if (!trusted(event)) return;
    importController?.abort(); importedDocuments = [];
  });
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
  handle('audio:open-folder', async () => {
    const directory = reminderAudioDirectory();
    initializeReminderAudioFolder(directory, reminderAudioSources());
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return true;
  });
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
    if (input.reminderSoundEnabled !== undefined) {
      if (typeof input.reminderSoundEnabled !== 'boolean') throw new Error('提示音开关格式不正确');
      value.reminderSoundEnabled = input.reminderSoundEnabled;
    }
    if (input.theme !== undefined) {
      if (typeof input.theme !== 'string' || !THEMES.includes(input.theme as Theme)) throw new Error('主题颜色不正确');
      value.theme = input.theme as Theme;
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
  try { initializeReminderAudioFolder(reminderAudioDirectory(), reminderAudioSources()); }
  catch { /* Folder access must not prevent startup or the bundled audio fallback. */ }
  const savedSettings = store.settings();
  const g = dockGeometryPrimary();
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  window = new BrowserWindow({
    ...g, x: g.x, y: g.hiddenY, title: '轻任务',
    icon: iconPath,
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
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }));
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
  app.on('before-quit', () => { quitting = true; importController?.abort(); importWorker?.kill(); clearInterval(reminderTimer); dock?.dispose(); tray?.destroy(); });
}
