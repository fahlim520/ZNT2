import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Task, Theme } from './domain';

export interface StoredSettings {
  encryptedApiKey?: string;
  model?: string;
  paused?: boolean;
  startAtLogin?: boolean;
  setupDone?: boolean;
  dockX?: number;
  dockWidth?: number;
  dockHeight?: number;
  reminderSoundEnabled?: boolean;
  reminderSoundIndex?: number;
  theme?: Theme;
}

// One writer (the main process), atomic replacement, and a previous good copy.
export class LocalStore {
  constructor(readonly directory: string) { fs.mkdirSync(directory, { recursive: true }); }
  exists(name: string) { return fs.existsSync(path.join(this.directory, name)); }
  private read<T>(name: string, fallback: T): T {
    const filename = path.join(this.directory, name);
    if (!fs.existsSync(filename)) {
      // Recover a completed write left behind when Windows rejected the final
      // rename. This keeps a user's settings/tasks instead of discarding them.
      const temp = `${filename}.tmp`;
      if (fs.existsSync(temp)) {
        try {
          const recovered = JSON.parse(fs.readFileSync(temp, 'utf8')) as T;
          fs.copyFileSync(temp, filename);
          fs.rmSync(temp, { force: true });
          return recovered;
        } catch { /* Fall through to the normal missing-file fallback. */ }
      }
      return fallback;
    }
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as T; }
    catch {
      // Never turn a damaged file silently into an empty task list.
      try { return JSON.parse(fs.readFileSync(`${filename}.bak`, 'utf8')) as T; }
      catch { throw new Error(`${name} 无法读取，数据已保留。请退出后检查本地数据目录。`); }
    }
  }
  private write(name: string, value: unknown) {
    const filename = path.join(this.directory, name);
    const temp = `${filename}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(filename)) {
      try { JSON.parse(fs.readFileSync(filename, 'utf8')); fs.copyFileSync(filename, `${filename}.bak`); } catch { /* Keep the existing good backup. */ }
    }
    try {
      fs.renameSync(temp, filename);
    } catch (error) {
      // Some Windows setups report EXDEV for a same-directory rename (often
      // because the profile folder is redirected or scanned by security
      // software). The data is small, so copy it into place as a fallback.
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(code)) throw error;
      fs.copyFileSync(temp, filename);
      fs.rmSync(temp, { force: true });
    }
  }
  tasks(): Task[] {
    const tasks = this.read<unknown>('tasks.json', []);
    if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task.id !== 'string' || typeof task.title !== 'string')) throw new Error('任务数据格式不正确，原文件已保留');
    return tasks as Task[];
  }
  saveTasks(tasks: Task[]) { this.write('tasks.json', tasks); }
  settings(): StoredSettings { return this.read('settings.json', {}); }
  saveSettings(settings: StoredSettings) { this.write('settings.json', settings); }
}
