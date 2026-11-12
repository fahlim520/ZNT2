import { normalizeInput, saveTaskRecord, type Task, type TaskInput } from './domain';
import type { ImportCandidate, ImportedDocument } from './import-domain';

export interface NoticeMatch {
  kind: 'duplicate' | 'update';
  taskId: string;
  title: string;
  dueAt?: string;
  reminderAt?: string;
  completed: boolean;
  revision: string;
  reason: string;
  evidence: string;
}
export interface ImportSaveInput { task: TaskInput; candidateId?: string; action: 'create' | 'update'; forceCreate?: boolean }
export interface ImportSaveResult { tasks: Task[]; created: number; updated: number; skipped: number }

const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const excerpt = (task: TaskInput) => (task.sourceText || '').replace(/^【[^\r\n]*】\s*/, '').replace(/\[第\s*\d+\s*页\]/g, '').trim();

export function noticeRevision(task: Task): string {
  // Reminder delivery changes updatedAt. Only user-visible content/schedule or
  // completion changes invalidate a pending confirmation.
  return JSON.stringify([task.title, task.dueAt, task.reminderAt, task.reminderTimes, task.reminderMode, task.category, task.notes, task.sourceText, task.completed]);
}

export function exactNoticeMatch(input: TaskInput, tasks: Task[]): Task | undefined {
  const source = compact(excerpt(input));
  if (!source) return undefined;
  return tasks.find(task => task.sourceType === 'file' && [task, ...(task.noticeHistory || [])].some(version => compact(version.title) === compact(input.title)
    && (version.dueAt || '') === (input.dueAt || '') && compact(excerpt(version)) === source));
}

// Bound model context without exporting unrelated manual tasks, notes, settings,
// or paths. Similarity only ranks context; the model judges semantic identity.
export function noticeContext(tasks: Task[], documents: ImportedDocument[]): Task[] {
  const text = compact(documents.map(item => item.text).join('\n'));
  const score = (task: Task) => {
    const title = compact(task.title);
    let hits = 0;
    for (let i = 0; i < title.length - 1; i++) if (text.includes(title.slice(i, i + 2))) hits++;
    return hits / Math.max(1, title.length - 1);
  };
  return tasks.filter(task => task.sourceType === 'file').map(task => ({ task, score: score(task) }))
    .sort((a, b) => b.score - a.score || Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt)).slice(0, 60).map(item => item.task);
}

export function noticeContextData(tasks: Task[]) {
  return tasks.map(task => ({ id: task.id, title: task.title, dueAt: task.dueAt || null, completed: task.completed, sourceExcerpt: excerpt(task.noticeHistory?.[task.noticeHistory.length - 1] || task).slice(0, 600) }));
}

export function resolveNoticeMatch(input: TaskInput, raw: unknown, tasks: Task[], document: ImportedDocument): NoticeMatch | undefined {
  const snapshot = (task: Task, kind: NoticeMatch['kind'], reason: string, evidence: string): NoticeMatch => ({ kind, taskId: task.id, title: task.title, dueAt: task.dueAt, reminderAt: task.reminderAt, completed: task.completed, revision: noticeRevision(task), reason, evidence });
  const exact = exactNoticeMatch(input, tasks);
  if (exact) return snapshot(exact, 'duplicate', exact.dueAt === input.dueAt ? '这条通知已整理过，保留已有提醒。' : '这条旧通知已处理过，保留现有较新的时间安排。', '');
  if (!raw || typeof raw !== 'object') return undefined;
  const match = raw as Record<string, unknown>;
  const existing = tasks.find(task => task.sourceType === 'file' && task.id === match.taskId);
  if (!existing || !['duplicate', 'update'].includes(match.kind as string)) return undefined;
  const reason = typeof match.reason === 'string' ? match.reason.trim().slice(0, 400) : '';
  const evidence = typeof match.evidence === 'string' ? match.evidence.trim().slice(0, 1600) : '';
  if (!reason || !evidence || !compact(document.text).includes(compact(evidence))) return undefined;
  if (match.kind === 'duplicate') {
    // An alleged duplicate with a different date must never hide an update.
    if ((existing.dueAt || '') !== (input.dueAt || '')) return undefined;
    return snapshot(existing, 'duplicate', reason, evidence);
  }
  if (!input.dueAt || input.dueAt === existing.dueAt) return undefined;
  return snapshot(existing, 'update', reason, evidence);
}

export function prepareImportSave(inputs: ImportSaveInput[], candidates: ImportCandidate[], current: Task[], now = new Date().toISOString(), newId = () => crypto.randomUUID()): { allTasks: Task[]; result: ImportSaveResult } {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 40) throw new Error('请选择 1–40 条任务');
  const result: ImportSaveResult = { tasks: [], created: 0, updated: 0, skipped: 0 };
  let allTasks = [...current];
  const updatedIds = new Set<string>();
  const candidateIds = new Set<string>();
  for (const item of inputs) {
    if (!item || !['create', 'update'].includes(item.action) || !item.task || item.task.id
      || (item.forceCreate !== undefined && typeof item.forceCreate !== 'boolean')) throw new Error('导入任务格式不正确');
    if (item.candidateId) {
      if (candidateIds.has(item.candidateId)) throw new Error('同一候选不能保存两次');
      candidateIds.add(item.candidateId);
    }
    const clean = normalizeInput({ ...item.task, sourceType: 'file' });
    const candidate = candidates.find(candidate => candidate.id === item.candidateId);
    if (item.action === 'update') {
      const match = candidate?.match;
      if (!match || match.kind !== 'update') throw new Error('更新预览已失效，请重新整理通知');
      const existing = allTasks.find(task => task.id === match.taskId);
      if (!existing || noticeRevision(existing) !== match.revision) throw new Error('原任务已修改或删除，请重新整理后确认，避免覆盖你的更改');
      if (updatedIds.has(existing.id)) throw new Error('多条通知都要更新同一任务，请每次只选择一条');
      updatedIds.add(existing.id);
      const updated = saveTaskRecord({ ...existing, dueAt: clean.dueAt, reminderAt: clean.reminderAt, reminderTimes: clean.reminderTimes, reminderMode: clean.reminderMode }, existing, existing.id, now);
      updated.noticeHistory = [...(existing.noticeHistory || [{ title: existing.title, dueAt: existing.dueAt, sourceText: existing.sourceText }]), { title: clean.title, dueAt: clean.dueAt || undefined, sourceText: clean.sourceText }].slice(-20);
      // Preserve the user's title, category, notes, original source and completion.
      // Append update evidence so repeated imports of the original still match.
      const addition = `通知时间更新：${existing.dueAt || '未设时间'} → ${updated.dueAt || '未设时间'}\n${candidate.evidence.slice(0, 1200)}`;
      updated.notes = (existing.notes ? `${existing.notes}\n\n` : '') + addition;
      if (updated.notes.length > 4000) updated.notes = existing.notes; // Never truncate user notes.
      if (updated.completed) { updated.reminderShown = true; updated.awaitingResponse = false; updated.responseDueAt = undefined; }
      allTasks = allTasks.map(task => task.id === existing.id ? updated : task);
      result.tasks.push(updated); result.updated++;
    } else {
      const duplicate = exactNoticeMatch(clean, allTasks);
      const proposed = candidate?.match?.kind === 'duplicate' && allTasks.find(task => task.id === candidate.match!.taskId);
      if (!item.forceCreate && candidate?.match?.kind === 'duplicate' && (!proposed || noticeRevision(proposed) !== candidate.match.revision)) throw new Error('已有提醒发生变化，请重新整理后确认');
      if (!item.forceCreate && (duplicate || proposed)) { result.skipped++; continue; }
      const task = saveTaskRecord(clean, undefined, newId(), now);
      allTasks.unshift(task); result.tasks.push(task); result.created++;
    }
  }
  return { allTasks, result };
}
