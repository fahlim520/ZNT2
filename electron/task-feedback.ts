import { chinaDay, reminderSchedule, type Task } from './domain';

export function readableTime(at: string, now = Date.now()): string {
  const day = chinaDay(at);
  const label = day === chinaDay(now) ? '今天' : day === chinaDay(now + 86_400_000) ? '明天' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(at));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  return `${label} ${time}`;
}
export function taskFeedback(task: Task, now = Date.now()): string {
  if (!task.reminderAt || task.reminderMode === 'none') return task.dueAt ? `截止 ${readableTime(task.dueAt, now)} · 不提醒` : '未设时间 · 不提醒';
  const times = reminderSchedule(task);
  if (times.length === 2 && Date.parse(times[1]) - Date.parse(times[0]) === 14 * 3_600_000) return `${times.map(at => readableTime(at, now)).join('、')} 提醒${Date.parse(task.reminderAt) <= now ? '（首次时间已到，将补提醒）' : ''}`;
  const intervals = times.slice(1).map((at, i) => Date.parse(at) - Date.parse(times[i]));
  const pattern = intervals.length && intervals.every(ms => ms === 3_600_000) ? '，每小时一次'
    : intervals.length && intervals.every(ms => ms === 86_400_000) ? '，每天一次'
    : times.length > 1 ? `，共 ${times.length} 次` : '';
  return `${readableTime(task.reminderAt, now)} 提醒${pattern}${Date.parse(task.reminderAt) <= now ? '（时间已到，将补提醒）' : ''}`;
}

export function undoableTaskVersion(task: Task): string {
  // A notification being displayed does not invalidate undo; a user edit does.
  return JSON.stringify([task.id, task.title, task.dueAt, task.reminderAt, task.reminderTimes, task.reminderMode, task.category, task.notes, task.sourceText, task.completed]);
}
