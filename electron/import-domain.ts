import { CATEGORIES, chinaDay, normalizeInput, type TaskInput, type Task } from './domain';
import { campusAIContext, type CampusProfile } from './campus-profile';
import { resolveNoticeMatch, type NoticeMatch } from './notice-review';

export const IMPORT_EXTENSIONS = ['pdf', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'txt', 'md', 'csv'];
export const IMPORT_LIMITS = { files: 8, fileBytes: 20 * 1024 * 1024, pages: 20, text: 50_000, tasks: 40 };
export interface ImportedDocument { id: string; name: string; text: string; warnings: string[]; error?: string }
export interface CampusAssessment { status: 'related' | 'uncertain' | 'unrelated' | 'general'; reason: string; questions: string[]; audienceEvidence: string }
export interface ImportCandidate { id: string; documentId: string; task: TaskInput; evidence: string; warnings: string[]; needsReview: boolean; assessment?: CampusAssessment; match?: NoticeMatch }
export interface ImportProgress { message: string }

function compact(value: string) { return value.replace(/\s+/g, ''); }
function string(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

// File dates need their own schedule. Never run typed-input clock overrides on
// a whole document: different paragraphs may describe different events.
export function dateOnlyImportSchedule(day: string, now = Date.now(), profile?: CampusProfile): Pick<TaskInput, 'dueAt' | 'reminderAt' | 'reminderTimes' | 'reminderMode'> {
  const end = Date.parse(`${day}T23:59:00+08:00`);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(end) || chinaDay(end) !== day) throw new Error('日期无效');
  const reminders: string[] = [];
  if (end > now) {
    const today = chinaDay(now);
    if (profile?.dateOnlyMode === 'daily') {
      // Only date-only tasks use this preference. Never move an explicit clock.
      for (let at = Date.parse(`${today}T${profile.dailyTime}:00+08:00`); at <= end && reminders.length < 366; at += 86_400_000) {
        if (at > now) reminders.push(new Date(at).toISOString());
      }
      // If today's preferred time has passed, keep today's task actionable.
      if (!reminders.length) reminders.push(new Date(Math.min(now + 5 * 60_000, end)).toISOString());
    } else if (day > today) {
      reminders.push(new Date(Math.min(now + 3_600_000, Date.parse(`${today}T23:59:00+08:00`))).toISOString());
      for (let at = Date.parse(`${today}T09:00:00+08:00`) + 86_400_000; chinaDay(at) < day && reminders.length < 365; at += 86_400_000) reminders.push(new Date(at).toISOString());
      for (let at = Date.parse(`${day}T09:00:00+08:00`); at <= end; at += 3_600_000) reminders.push(new Date(at).toISOString());
    } else {
      for (let at = Math.min(now + 3_600_000, end); at <= end; at += 3_600_000) reminders.push(new Date(at).toISOString());
    }
  }
  return { dueAt: new Date(end).toISOString(), reminderMode: reminders.length ? 'custom' : 'none', reminderAt: reminders[0], reminderTimes: reminders.slice(1) };
}

export function parseDocumentCandidates(content: string, documents: ImportedDocument[], now = Date.now(), profile?: CampusProfile, clarification = '', existingTasks: Task[] = []): ImportCandidate[] {
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
    let assessment: CampusAssessment | undefined;
    if (campusAIContext(profile) || clarification.trim()) {
      const rawAssessment = entry.assessment || {};
      let status: CampusAssessment['status'] = ['related', 'uncertain', 'unrelated', 'general'].includes(rawAssessment.status) ? rawAssessment.status : 'uncertain';
      const audienceEvidence = string(rawAssessment.audienceEvidence, 800);
      let reason = string(rawAssessment.reason, 500);
      const questions: string[] = Array.isArray(rawAssessment.questions) ? rawAssessment.questions.filter((item: unknown) => typeof item === 'string' && item.trim()).slice(0, 3).map((item: string) => item.trim().slice(0, 200)) : [];
      const evidenceValid = !!audienceEvidence && compact(document.text).includes(compact(audienceEvidence));
      if (['related', 'unrelated'].includes(status) && (!evidenceValid || !reason)) {
        status = 'uncertain'; reason = '适用对象的判断缺少可核对的原文，请确认后再加入。';
      }
      if (!reason) status = 'uncertain';
      if (questions.length) status = 'uncertain';
      assessment = { status, reason: reason || '资料不足，请结合通知确认是否适用。', questions, audienceEvidence: evidenceValid ? audienceEvidence : '' };
    }
    let schedule: Pick<TaskInput, 'dueAt' | 'reminderAt' | 'reminderTimes' | 'reminderMode'> = { reminderMode: 'none' };
    const ambiguous = (entry.timeStatus !== 'exact' && entry.timeStatus !== 'date-only') || !/(?:19|20)\d{2}(?:年|[-/.])/.test(compact(document.text + '\n' + clarification));
    if (ambiguous) warnings.push('原文时间不明确，请确认日期和提醒时间；暂未自动安排提醒。');
    else {
      try {
        if (entry.timeStatus === 'date-only') {
          schedule = dateOnlyImportSchedule(entry.dueDate, now, profile);
          if (entry.reminderMode === 'none') schedule = { dueAt: schedule.dueAt, reminderMode: 'none' };
          else warnings.push(profile?.dateOnlyMode === 'daily' ? `只有日期：每天 ${profile.dailyTime} 提醒；若今天该时刻已过且今天截止，则 5 分钟内提醒。可在下方调整。` : '原文只有日期：当天按小时提醒，提前的日期每天提醒一次；可在下方调整。');
        } else {
          if (typeof entry.dueAt !== 'string') throw new Error('缺少明确时刻');
          schedule = { dueAt: entry.dueAt, reminderAt: entry.reminderMode === 'custom' ? entry.reminderAt : undefined, reminderMode: ['custom', 'none'].includes(entry.reminderMode) ? entry.reminderMode : 'default' };
          normalizeInput({ title, ...schedule });
        }
      } catch { schedule = { reminderMode: 'none' }; warnings.push('识别的日期或提醒时间无效，请手动确认。'); }
    }
    if (schedule.dueAt && Date.parse(schedule.dueAt) < now) warnings.push('这个日期已经过去，请核对通知年份和截止时间。');
    const notes = [assessment ? `适用判断（AI，供核对）：${assessment.reason}` : '', clarification ? `本次补充：${clarification.slice(0, 500)}` : '', string(entry.notes, 1200), `来源：${document.name}`, `原文摘录：${evidence}`].filter(Boolean).join('\n').slice(0, 4000);
    const task = normalizeInput({ title, ...schedule, sourceType: 'file', category: CATEGORIES.includes(entry.category) ? entry.category : '其他', notes, sourceText: `【${document.name}】\n${evidence}`.slice(0, 4000) });
    const key = `${compact(task.title)}|${task.dueAt || ''}`;
    const duplicate = seen.has(key); seen.add(key);
    if (duplicate) warnings.push('本次导入中可能存在重复任务，请核对后再勾选。');
    const match = resolveNoticeMatch(task, entry.match, existingTasks, document);
    if (entry.match?.kind && entry.match.kind !== 'none' && !match) warnings.push('疑似关联已有事项，但关联依据不足，请核对后再添加。');
    return { id: `candidate-${index}`, documentId: document.id, task, evidence, warnings, assessment, match, needsReview: !!match || ambiguous || duplicate || assessment?.status === 'uncertain' || assessment?.status === 'unrelated' || warnings.some(item => /已经过去|无效|关联依据不足/.test(item)) };
  });
}
