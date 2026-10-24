import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReminderSound } from './domain';

const EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav', '.webm']);
const MIME: Record<string, string> = {
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
};

export function reminderAudioFiles(directories: readonly string[]): string[] {
  for (const directory of directories) {
    try {
      const files = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map(entry => path.join(directory, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true }));
      if (files.length) return files;
    } catch { /* An unavailable custom folder must not prevent bundled sounds. */ }
  }
  return [];
}

export function initializeReminderAudioFolder(directory: string, sources: readonly string[]): void {
  fs.mkdirSync(directory, { recursive: true });
  // Existing custom sounds take priority; never mix defaults into a user's list.
  if (reminderAudioFiles([directory]).length) return;
  for (const source of reminderAudioFiles(sources)) {
    // Reading first also works when the bundled file lives inside app.asar.
    fs.writeFileSync(path.join(directory, path.basename(source)), fs.readFileSync(source), { flag: 'wx' });
  }
}

export function readNextReminderSound(directories: readonly string[], savedIndex: unknown): { sound: ReminderSound; nextIndex: number } | undefined {
  for (const directory of directories) {
    const files = reminderAudioFiles([directory]);
    if (!files.length) continue;
    const start = typeof savedIndex === 'number' && Number.isInteger(savedIndex) && savedIndex >= 0 ? savedIndex % files.length : 0;
    for (let offset = 0; offset < files.length; offset++) {
      const index = (start + offset) % files.length;
      const filename = files[index];
      try {
        const bytes = fs.readFileSync(filename);
        if (!bytes.length) continue;
        const extension = path.extname(filename).toLowerCase();
        return {
          sound: { dataUrl: `data:${MIME[extension]};base64,${bytes.toString('base64')}`, name: path.basename(filename), index, total: files.length },
          nextIndex: (index + 1) % files.length,
        };
      } catch { /* A removed or locked file should not block every later sound. */ }
    }
  }
  return undefined;
}
