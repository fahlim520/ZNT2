import { CATEGORIES, chinaDay, normalizeInput, type TaskInput } from './domain';

export const IMPORT_EXTENSIONS = ['pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'txt', 'md', 'csv'];
export const IMPORT_LIMITS = { files: 8, fileBytes: 20 * 1024 * 1024, pages: 20, text: 50_000, tasks: 40 };
export interface ImportedDocument { id: string; name: string; text: string; warnings: string[]; error?: string }
export interface ImportCandidate { id: string; documentId: string; task: TaskInput; evidence: string; warnings: string[]; needsReview: boolean }
export interface ImportProgress { message: string }

function compact(value: string) { return value.replace(/\s+/g, ''); }
function string(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

// File dates need their own schedule. Never run typed-input clock overrides on
// a whole document: different paragraphs may describe different events.
export function dateOnlyImportSchedule(day: string, now = Date.now()): Pick<TaskInput, 'dueAt' | 'reminderAt' | 'reminderTimes' | 'reminderMode'> {
  const end = Date.parse(`${day}T23:59:00+08:00`);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(end) || chinaDay(end) !== day) throw new Error('日期无效');
  const reminders: string[] = [];
  if (end > now) {
    const today = chinaDay(now);
    if (day > today) {
      reminders.push(new Date(Math.min(now + 3_600_000, Date.parse(`${today}T23:59:00+08:00`))).toISOString());
      for (let at = Date.parse(`${today}T09:00:00+08:00`) + 86_400_000; chinaDay(at) < day && reminders.length < 365; at += 86_400_000) reminders.push(new Date(at).toISOString());
      for (let at = Date.parse(`${day}T09:00:00+08:00`); at <= end; at += 3_600_000) reminders.push(new Date(at).toISOString());
    } else {
      for (let at = Math.min(now + 3_600_000, end); at <= end; at += 3_600_000) reminders.push(new Date(at).toISOString());
    }
  }
  return { dueAt: new Date(end).toISOString(), reminderMode: reminders.length ? 'custom' : 'none', reminderAt: reminders[0], reminderTimes: reminders.slice(1) };
}

export function parseDocumentCandidates(content: string, documents: ImportedDocument[], now = Date.now()): ImportCandidate[] {
  let raw: any;
  try { raw = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); }
  catch { throw new Error('AI 返回的格式不正确，识别原文已保留，请重试或手动整理'); }
  if (!raw || !Array.isArray(raw.tasks) || raw.tasks.length > IMPORT_LIMITS.tasks) throw new Error(`AI 应返回任务列表，每次最多 ${IMPORT_LIMITS.tasks} 条`);
  const seen = new Set<string>();
  return raw.tasks.map((entry: any, index: number): ImportCandidate => {
    if (!entry || typeof entry !== 'object') throw new Error('AI 任务格式不正确，请重新整理');
    const document = documents.find(item => item.id === entry.documentId && !item.error);
    if (!document) throw new Error('AI 返回了无法核对的文件来源，请重新整理');
    const evidence = string(entry.evidence, 1600);
    if (!evidence || !compact(document.text).includes(compact(evidence))) throw new Error('AI 返回的原文摘录无法核对，请重新整理或手动添加');
    const title = string(entry.title, 500);
    if (!title) throw new Error('AI 返回了空任务名称，请重试');
    const warnings = [string(entry.warning, 500)].filter(Boolean);
    let schedule: Pick<TaskInput, 'dueAt' | 'reminderAt' | 'reminderTimes' | 'reminderMode'> = { reminderMode: 'none' };
    const ambiguous = (entry.timeStatus !== 'exact' && entry.timeStatus !== 'date-only') || !/(?:19|20)\d{2}(?:年|[-/.])/.test(compact(document.text));
    if (ambiguous) warnings.push('原文时间不明确，请确认日期和提醒时间；暂未自动安排提醒。');
    else {
      try {
        if (entry.timeStatus === 'date-only') {
          schedule = dateOnlyImportSchedule(entry.dueDate, now);
          if (entry.reminderMode === 'none') schedule = { dueAt: schedule.dueAt, reminderMode: 'none' };
          else warnings.push('原文只有日期：当天按小时提醒，提前的日期每天提醒一次；可在下方调整。');
        } else {
          if (typeof entry.dueAt !== 'string') throw new Error('缺少明确时刻');
          schedule = { dueAt: entry.dueAt, reminderAt: entry.reminderMode === 'custom' ? entry.reminderAt : undefined, reminderMode: ['custom', 'none'].includes(entry.reminderMode) ? entry.reminderMode : 'default' };
          normalizeInput({ title, ...schedule });
        }
      } catch { schedule = { reminderMode: 'none' }; warnings.push('识别的日期或提醒时间无效，请手动确认。'); }
    }
    if (schedule.dueAt && Date.parse(schedule.dueAt) < now) warnings.push('这个日期已经过去，请核对通知年份和截止时间。');
    const notes = [string(entry.notes, 1800), `来源：${document.name}`, `原文摘录：${evidence}`].filter(Boolean).join('\n').slice(0, 4000);
    const task = normalizeInput({ title, ...schedule, sourceType: 'file', category: CATEGORIES.includes(entry.category) ? entry.category : '其他', notes, sourceText: `【${document.name}】\n${evidence}`.slice(0, 4000) });
    const key = `${compact(task.title)}|${task.dueAt || ''}`;
    const duplicate = seen.has(key); seen.add(key);
    if (duplicate) warnings.push('本次导入中可能存在重复任务，请核对后再勾选。');
    return { id: `candidate-${index}`, documentId: document.id, task, evidence, warnings, needsReview: ambiguous || duplicate || warnings.some(item => /已经过去|无效/.test(item)) };
  });
}
