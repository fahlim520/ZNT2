export const CATEGORIES = ['工作', '生活', '学习', '其他'] as const;
export type Category = typeof CATEGORIES[number];
export const THEMES = ['orange', 'green', 'purple', 'pink'] as const;
export type Theme = typeof THEMES[number];
export const THEME_LABELS: Record<Theme, string> = { orange: '伊藤橙', green: '酷安绿', purple: '韵味紫', pink: '哔哩粉' };
export type ReminderMode = 'default' | 'custom' | 'none';
export interface Task {
  sourceType?: 'text' | 'file';
  id: string;
  title: string;
  dueAt?: string;
  reminderAt?: string;
  reminderMode: ReminderMode;
  category: Category;
  notes: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  sourceText: string;
  reminderShown: boolean;
  reminderTimes?: string[];
  awaitingResponse?: boolean;
  responseDueAt?: string;
}
export interface TaskInput {
  sourceType?: 'text' | 'file';
  id?: string;
  title: string;
  dueAt?: string | null;
  reminderAt?: string | null;
  reminderTimes?: string[] | null;
  reminderMode?: ReminderMode;
  category?: Category;
  notes?: string;
  sourceText?: string;
}
export interface Settings {
  hasApiKey: boolean;
  model: string;
  paused: boolean;
  startAtLogin: boolean;
  firstRun: boolean;
  reminderSoundEnabled: boolean;
  theme: Theme;
}
export interface SettingsInput { apiKey?: string; model?: string; startAtLogin?: boolean; reminderSoundEnabled?: boolean; theme?: Theme }
export interface ReminderSound { dataUrl: string; name: string; index: number; total: number }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopApi {
  chooseImportFiles(): Promise<Result<import('./import-domain').ImportedDocument[]>>;
  importDroppedFiles(files: File[]): Promise<Result<import('./import-domain').ImportedDocument[]>>;
  importClipboardImage(): Promise<Result<import('./import-domain').ImportedDocument[]>>;
  parseImportedDocuments(documents: import('./import-domain').ImportedDocument[]): Promise<Result<import('./import-domain').ImportCandidate[]>>;
  saveImportedTasks(tasks: TaskInput[]): Promise<Result<Task[]>>;
  cancelImport(): void;
  onImportProgress(handler: (progress: import('./import-domain').ImportProgress) => void): () => void;
  getTasks(): Promise<Result<Task[]>>;
  saveTask(task: TaskInput): Promise<Result<Task>>;
  deleteTask(id: string): Promise<Result<boolean>>;
  toggleTask(id: string, completed: boolean): Promise<Result<Task>>;
  respondReminder(id: string, response: string): Promise<Result<Task>>;
  parseTask(input: string): Promise<Result<TaskInput>>;
  getSettings(): Promise<Result<Settings>>;
  openReminderAudioFolder(): Promise<Result<boolean>>;
  saveSettings(input: SettingsInput): Promise<Result<Settings>>;
  testApiKey(input: { apiKey?: string; model: string }): Promise<Result<boolean>>;
  setPaused(paused: boolean): Promise<Result<boolean>>;
  setKeepOpen(keepOpen: boolean): void;
  startDragWindow(): void;
  moveDragWindow(): void;
  endDragWindow(): void;
  startResizeWindow(edge: ResizeEdge): void;
  moveResizeWindow(): void;
  endResizeWindow(): void;
  resetWindowSize(): Promise<Result<DockSize>>;
  hideWindow(): void;
  showWindow(): void;
  toggleWindow(): void;
  onSettings(handler: () => void): () => void;
  onPaused(handler: (paused: boolean) => void): () => void;
  onReminder(handler: (task: Task, sound?: ReminderSound) => void): () => void;
}

function text(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`请输入${label}`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式不正确或超过 ${max} 字`);
  const clean = value.trim();
  if (required && !clean) throw new Error(`请输入${label}`);
  return clean;
}
export function isoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error(`${label}需要带时区的有效日期`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label}不是有效日期`);
  // Date.parse silently rolls dates such as February 30 into March.
  const calendarDay = value.slice(0, 10);
  if (new Date(`${calendarDay}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDay
    || Number(value.slice(11, 13)) > 23) throw new Error(`${label}不是有效日期`);
  return new Date(time).toISOString();
}
export function normalizeInput(value: unknown): Required<Pick<TaskInput, 'title' | 'category' | 'notes' | 'sourceText' | 'reminderMode'>> & Pick<TaskInput, 'id' | 'dueAt' | 'reminderAt' | 'reminderTimes' | 'sourceType'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务格式不正确');
  const raw = value as Record<string, unknown>;
  if (raw.sourceType !== undefined && !['text', 'file'].includes(raw.sourceType as string)) throw new Error('任务来源不正确');
  const title = text(raw.title, '任务名称', 500, true);
  const category = raw.category ?? '其他';
  if (!CATEGORIES.includes(category as Category)) throw new Error('请选择有效分类');
  const dueAt = isoDate(raw.dueAt, '截止时间');
  const mode = raw.reminderMode ?? 'default';
  if (!['default', 'custom', 'none'].includes(mode as string)) throw new Error('提醒方式不正确');
  const reminderTimes = mode !== 'none' && Array.isArray(raw.reminderTimes)
    ? [...new Set(raw.reminderTimes.map((item, index) => isoDate(item, `第 ${index + 1} 个提醒时间`)).filter((item): item is string => Boolean(item)))].sort((a, b) => Date.parse(a) - Date.parse(b))
    : undefined;
  let reminderAt: string | undefined;
  if (dueAt && mode !== 'none') {
    // A custom schedule may contain several reminders. The first one is kept
    // in reminderAt for compatibility with older saved tasks, while the
    // remaining times stay in reminderTimes as a queue.
    reminderAt = isoDate(raw.reminderAt, '提醒时间');
    if (!reminderAt && reminderTimes?.length) reminderAt = reminderTimes[0];
    if (!reminderAt && mode === 'default') reminderAt = new Date(Date.parse(dueAt) - 3_600_000).toISOString();
    if (!reminderAt) throw new Error('请填写提醒时间');
    if (Date.parse(reminderAt) > Date.parse(dueAt)) throw new Error('提醒时间不能晚于截止时间');
  }
  if (reminderTimes?.some(item => dueAt && Date.parse(item) > Date.parse(dueAt))) throw new Error('提醒时间不能晚于截止时间');
  return { id: raw.id ? text(raw.id, '任务编号', 100, true) : undefined, sourceType: raw.sourceType as TaskInput['sourceType'], title, category: category as Category, dueAt, reminderAt, reminderTimes, reminderMode: mode as ReminderMode, notes: text(raw.notes, '备注', 4000), sourceText: text(raw.sourceText, '原始输入', 4000) };
}
export function saveTaskRecord(input: unknown, existing: Task | undefined, id: string, now = new Date().toISOString()): Task {
  const clean = normalizeInput(input);
  const sameSchedule = existing && existing.reminderAt === clean.reminderAt && JSON.stringify(existing.reminderTimes || []) === JSON.stringify(clean.reminderTimes || []);
  return { ...clean, id: existing?.id ?? id, dueAt: clean.dueAt || undefined, reminderAt: clean.reminderAt || undefined, reminderTimes: clean.reminderTimes?.length ? clean.reminderTimes : undefined, completed: existing?.completed ?? false, createdAt: existing?.createdAt ?? now, updatedAt: now, reminderShown: sameSchedule ? existing.reminderShown : false, awaitingResponse: sameSchedule ? existing.awaitingResponse : false, responseDueAt: sameSchedule ? existing.responseDueAt : undefined };
}
export function toggleTaskRecord(task: Task, completed: boolean, now = new Date().toISOString()): Task {
  // Reopening a completed task re-arms its reminder, including missed reminders.
  return { ...task, completed, updatedAt: now, reminderShown: completed, awaitingResponse: false, responseDueAt: undefined };
}
export function isReminderDue(task: Task, now: number): boolean {
  return !task.completed && !task.reminderShown && !!task.reminderAt && Date.parse(task.reminderAt) <= now;
}

export function reminderSchedule(task: Pick<Task, 'reminderAt' | 'reminderTimes'>): string[] {
  return [...new Set([task.reminderAt, ...(task.reminderTimes || [])].filter((item): item is string => Boolean(item)))].sort((a, b) => Date.parse(a) - Date.parse(b));
}

export type ReminderResponse =
  | { type: 'complete' }
  | { type: 'snooze'; reminderAt: string }
  | { type: 'unclear'; message: string };

function chinaDateAt(base: Date, days: number, hour: number, minute = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(base);
  const year = Number(parts.find(item => item.type === 'year')?.value);
  const month = Number(parts.find(item => item.type === 'month')?.value);
  const day = Number(parts.find(item => item.type === 'day')?.value);
  return new Date(Date.UTC(year, month - 1, day + days, hour - 8, minute)).toISOString();
}

function durationMs(value: number, unit: string): number {
  if (unit.includes('小时') || unit === '时' || unit === 'h') return value * 3_600_000;
  if (unit.includes('天') || unit === 'd') return value * 86_400_000;
  return value * 60_000;
}

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  const parts = [...value].map(item => digits[item]);
  return parts.length && parts.every(item => item !== undefined) ? Number(parts.join('')) : undefined;
}

function localReminderResponse(value: string, now = Date.now()): ReminderResponse {
  const response = value.trim();
  const normalized = response.toLowerCase().replace(/[\s\u3000]+/g, '');
  // This is intentionally a fallback for when AI is unavailable. It accepts
  // natural acknowledgements rather than requiring one exact word.
  const wantsLater = /提醒|叫我|通知我|稍后|晚点|等会|一会|之后|以后|后再|later|snooze/i.test(normalized);
  const relative = response.match(/(半|\d{1,3}(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,4})\s*(分钟|分|小时|时|天|h|d)\s*(?:后)?/i);
  if (relative) {
    const amount = relative[1] === '半' ? 0.5 : /^\d/.test(relative[1]) ? Number(relative[1]) : chineseNumber(relative[1]);
    if (wantsLater && amount !== undefined && amount > 0) return { type: 'snooze', reminderAt: new Date(now + durationMs(amount, relative[2].toLowerCase())).toISOString() };
  }
  if (wantsLater && /(?:一|1)刻钟/.test(normalized)) return { type: 'snooze', reminderAt: new Date(now + 15 * 60_000).toISOString() };
  if (/(?:再提醒我|提醒我|叫我|通知我)/.test(response)) {
    const dayOffset = /大后天/.test(response) ? 3 : /后天/.test(response) ? 2 : /明天/.test(response) ? 1 : 0;
    const clock = response.match(/(上午|下午|晚上|早上|中午|凌晨|傍晚)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:点|时|[:：.．]\s*)(?:(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?/);
    if (clock) {
      let hour = chineseNumber(clock[2]) ?? -1;
      const minute = clock[3] ? chineseNumber(clock[3]) ?? -1 : 0;
      if (/(下午|晚上|傍晚)/.test(clock[1] || '') && hour < 12) hour += 12;
      if (clock[1] === '中午' && hour < 11) hour += 12;
      if (/(凌晨|上午|早上)/.test(clock[1] || '') && hour === 12) hour = 0;
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('提醒时间无效，请填写 0–23 点和 0–59 分');
      const reminderAt = chinaDateAt(new Date(now), dayOffset, hour, minute);
      if (Date.parse(reminderAt) > now) return { type: 'snooze', reminderAt };
      return { type: 'unclear', message: '这个时间已经过去，请说明下一次提醒的日期和时间。' };
    }
  }
  if (!wantsLater && !/不|没|未|别|等|但是|不过|\?|？|吗|么|吧|not|haven['’]?t|don['’]?t/i.test(normalized)) {
    const clauses = normalized.replace(/[，,。.!！;；]+$/g, '').split(/[，,。.!！;；]+/);
    const acknowledgement = /^(好(?:的)?(?:呀|啊|嘞|哦|哒|滴)?|行[的啊]?|可以[的]?|收到[了]?|知道了|明白了?|了解了?|没问题|ok(?:ay)?|hao(?:de)?|完成[了]?|已(?:经)?完成(?:了)?|(?:我)?(?:会|将)?(?:马上|现在就|现在)?(?:去)?(?:执行|处理|做|弄|搞定|安排)(?:了|的|好|上了?|这件事|这个任务)?|(?:我)?已经(?:处理|做|搞定|弄好|安排上)(?:了)?)$/i;
    if (clauses.every(clause => acknowledgement.test(clause))) return { type: 'complete' };
  }
  return { type: 'unclear', message: '我没能确定你的意思，请说“已经完成”，或说明“多久后 / 什么时候再提醒”。' };
}

export function parseReminderResponse(value: unknown, now = Date.now()): ReminderResponse {
  const response = text(value, '回复内容', 500, true);
  return localReminderResponse(response, now);
}
export function parseModelTask(content: string, sourceText: string, adjustSchedule: (input: TaskInput) => TaskInput = input => input): TaskInput {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); } catch { throw new Error('AI 返回的任务格式不正确，请手动确认'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('AI 返回的任务格式不正确');
  const input = { ...raw, sourceText, reminderMode: raw.reminderMode ?? 'default' };
  // Enforce the one-hour default locally, rather than trusting the model's arithmetic.
  return normalizeInput(adjustSchedule(input as unknown as TaskInput));
}

export function chinaDay(value: string | number = Date.now()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export function toChinaInput(value?: string): string {
  return value ? new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(0, 16) : '';
}
export function fromChinaInput(value: string): string | undefined {
  return value ? isoDate(`${value}:00+08:00`, '时间') : undefined;
}
export interface DockSize { width: number; height: number }
export type ResizeEdge = 'right' | 'bottom' | 'bottom-right';
export const DEFAULT_DOCK_SIZE: DockSize = { width: 460, height: 650 };
export const MIN_DOCK_SIZE: DockSize = { width: 360, height: 480 };
export interface DockGeometry extends DockSize { x: number; shownY: number; hiddenY: number }
export function dockGeometry(display: { bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number } }, size: Partial<DockSize> = {}): DockGeometry {
  const width = Math.min(display.workArea.width, Math.max(MIN_DOCK_SIZE.width, Number.isFinite(size.width) ? Math.round(size.width!) : DEFAULT_DOCK_SIZE.width));
  const height = Math.min(display.workArea.height, Math.max(MIN_DOCK_SIZE.height, Number.isFinite(size.height) ? Math.round(size.height!) : DEFAULT_DOCK_SIZE.height));
  const shownY = display.bounds.y;
  // Keep only a slim 8px edge visible while the panel is retracted.
  return { x: Math.round(display.workArea.x + (display.workArea.width - width) / 2), shownY, hiddenY: shownY - height + 8, width, height };
}
