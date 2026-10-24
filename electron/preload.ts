import { contextBridge, ipcRenderer } from 'electron';

const invoke = <T>(channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload) as Promise<T>;
contextBridge.exposeInMainWorld('taskDesk', {
  getTasks: () => invoke('tasks:list'),
  saveTask: (task: unknown) => invoke('tasks:save', task),
  deleteTask: (id: string) => invoke('tasks:delete', id),
  toggleTask: (id: string, completed: boolean) => invoke('tasks:toggle', { id, completed }),
  respondReminder: (id: string, response: string) => invoke('reminder:respond', { id, response }),
  parseTask: (input: string) => invoke('ai:parse-task', input),
  getSettings: () => invoke('settings:get'),
  saveSettings: (settings: unknown) => invoke('settings:save', settings),
  testApiKey: (input: unknown) => invoke('ai:test-key', input),
  setPaused: (paused: boolean) => invoke('window:set-paused', paused),
  setKeepOpen: (keepOpen: boolean) => ipcRenderer.send('window:set-keep-open', keepOpen),
  startDragWindow: () => ipcRenderer.send('window:drag-start'),
  moveDragWindow: () => ipcRenderer.send('window:drag-move'),
  endDragWindow: () => ipcRenderer.send('window:drag-end'),
  startResizeWindow: (edge: string) => ipcRenderer.send('window:resize-start', edge),
  moveResizeWindow: () => ipcRenderer.send('window:resize-move'),
  endResizeWindow: () => ipcRenderer.send('window:resize-end'),
  resetWindowSize: () => invoke('window:reset-size'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  showWindow: () => ipcRenderer.send('window:show'),
  toggleWindow: () => ipcRenderer.send('window:toggle'),
  onReminder: (handler: (task: unknown) => void) => subscribe('reminder', handler),
  onSettings: (handler: () => void) => subscribe('open-settings', handler),
  onPaused: (handler: (paused: boolean) => void) => subscribe('paused-changed', handler),
});
function subscribe(channel: string, handler: (...args: any[]) => void) {
  const listener = (_event: Electron.IpcRendererEvent, ...args: any[]) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
