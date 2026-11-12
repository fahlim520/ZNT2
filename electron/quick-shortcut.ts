export const DEFAULT_QUICK_SHORTCUT = 'Ctrl+Alt+Q';
export function normalizeShortcut(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 60) throw new Error('快捷键格式不正确');
  const parts = value.split('+').map(part => part.trim());
  const key = parts.pop()?.toUpperCase();
  if (!key || !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key) || !parts.length
    || parts.some(part => !['Ctrl', 'Alt', 'Shift'].includes(part)) || new Set(parts).size !== parts.length
    || (!parts.includes('Ctrl') && !parts.includes('Alt'))) throw new Error('请使用 Ctrl / Alt 搭配字母、数字或 F1–F24，可附加 Shift');
  if ((!parts.includes('Ctrl') && parts.includes('Alt') && key === 'F4') || (parts.length === 1 && parts[0] === 'Ctrl' && ['C', 'V', 'X', 'Z', 'A', 'S', 'F', 'W', 'Q'].includes(key))) throw new Error('请避开常用系统快捷键，建议 Ctrl+Alt+字母');
  return [...['Ctrl', 'Alt', 'Shift'].filter(modifier => parts.includes(modifier)), key].join('+');
}

interface ShortcutHost { register(key: string, callback: () => void): boolean; unregister(key: string): void }
export class QuickShortcut {
  active = '';
  error = '';
  constructor(private host: ShortcutHost, private callback: () => void) {}
  change(value: unknown, persist: (key: string) => void) {
    const next = normalizeShortcut(value);
    if (next === this.active) { persist(next); this.error = ''; return; }
    let registered = false;
    try { registered = !next || this.host.register(next, this.callback); } catch { /* Report registration failure without releasing the old key. */ }
    if (!registered) throw new Error('这个快捷键已被占用或不可用，请换一个组合；原快捷键保持不变');
    try { persist(next); } catch (error) { if (next) this.host.unregister(next); throw error; }
    if (this.active) this.host.unregister(this.active);
    this.active = next; this.error = '';
  }
  start(value: unknown) {
    try { this.change(value, () => {}); } catch (error) { this.error = error instanceof Error ? error.message : '快捷键注册失败'; }
  }
  dispose() { if (this.active) this.host.unregister(this.active); this.active = ''; }
}
