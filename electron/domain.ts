export const CATEGORIES = ['工作', '生活', '学习', '其他'] as const;
export type Category = typeof CATEGORIES[number];
export type ReminderMode = 'default' | 'custom' | 'none';
export interface Task {
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
}
export interface SettingsInput { apiKey?: string; model?: string; startAtLogin?: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopApi {
  getTasks(): Promise<Result<Task[]>>;
  saveTask(task: TaskInput): Promise<Result<Task>>;
  deleteTask(id: string): Promise<Result<boolean>>;
  toggleTask(id: string, completed: boolean): Promise<Result<Task>>;
  respondReminder(id: string, response: string): Promise<Result<Task>>;
  parseTask(input: string): Promise<Result<TaskInput>>;
  getSettings(): Promise<Result<Settings>>;
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
  onReminder(handler: (task: Task) => void): () => void;
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
  return new Date(time).toISOString();
}
export function normalizeInput(value: unknown): Required<Pick<TaskInput, 'title' | 'category' | 'notes' | 'sourceText' | 'reminderMode'>> & Pick<TaskInput, 'id' | 'dueAt' | 'reminderAt' | 'reminderTimes'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务格式不正确');
  const raw = value as Record<string, unknown>;
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
  return { id: raw.id ? text(raw.id, '任务编号', 100, true) : undefined, title, category: category as Category, dueAt, reminderAt, reminderTimes, reminderMode: mode as ReminderMode, notes: text(raw.notes, '备注', 4000), sourceText: text(raw.sourceText, '原始输入', 4000) };
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

export type ReminderResponse = { type: 'complete' } | { type: 'snooze'; reminderAt: string };

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

export function parseReminderResponse(value: unknown, now = Date.now()): ReminderResponse {
  const response = text(value, '回复内容', 500, true);
  if (/^(好|好的|ok|okay|收到|知道了|明白了?|会执行|我会执行|完成|已完成|行|可以|马上处理|马上做|我去做)[。！!，, ]*$/i.test(response)
    || /^(好的?，?|ok[，, ]?)?(我会|我将|马上|现在就)(执行|处理|去做)/i.test(response)) return { type: 'complete' };
  const relative = response.match(/(?:再提醒我|提醒我|过|在)\s*(\d{1,3})\s*(分钟|分|小时|时|天|h|d)\s*(?:后)?/i);
  if (relative) return { type: 'snooze', reminderAt: new Date(now + durationMs(Number(relative[1]), relative[2].toLowerCase())).toISOString() };
  if (/(?:再提醒我|提醒我).*(今天|明天|后天)|(?:今天|明天|后天).*(?:再提醒我|提醒我)/.test(response)) {
    const dayOffset = response.includes('后天') ? 2 : response.includes('明天') ? 1 : 0;
    const clock = response.match(/(上午|下午|晚上|早上|中午)?\s*(\d{1,2})(?:点|[:：.．]\s*)(\d{1,2})?/);
    let hour = clock ? Number(clock[2]) : 9;
    const minute = clock?.[3] ? Number(clock[3]) : 0;
    if (clock?.[1] && /下午|晚上/.test(clock[1]) && hour < 12) hour += 12;
    if (hour > 23 || minute > 59) throw new Error('提醒时间无效，请填写 0–23 点和 0–59 分');
    return { type: 'snooze', reminderAt: chinaDateAt(new Date(now), dayOffset, hour, minute) };
  }
  if (/(?:再提醒我|提醒我)/.test(response)) throw new Error('请写清楚再次提醒时间，例如“再提醒我 30 分钟后”');
  throw new Error('请输入“好”完成任务，或输入“再提醒我 30 分钟后”');
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
