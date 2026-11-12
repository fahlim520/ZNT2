import { isReminderDue, reminderSchedule, type Task } from './domain';

export function collectDueReminders(source: Task[], now: number): { tasks: Task[]; due: Task[]; changed: boolean } {
  const due: Task[] = [];
  const tasks = source.map(original => {
    if (original.completed) return original;
    let task = original;
    if (task.awaitingResponse && task.responseDueAt && Date.parse(task.responseDueAt) <= now) {
      const next = reminderSchedule(task).find(at => Date.parse(at) > Date.parse(task.reminderAt || '') && Date.parse(at) <= now);
      task = { ...task, reminderAt: next || task.reminderAt,
        reminderTimes: next ? reminderSchedule(task).filter(at => Date.parse(at) > Date.parse(next)) : task.reminderTimes,
        reminderShown: false, awaitingResponse: false, responseDueAt: undefined, updatedAt: new Date(now).toISOString() };
    }
    if (!isReminderDue(task, now)) return task;
    task = { ...task, reminderShown: true, awaitingResponse: true, responseDueAt: new Date(now + 5 * 60_000).toISOString(), updatedAt: new Date(now).toISOString() };
    due.push(task);
    return task;
  });
  due.sort((a, b) => Date.parse(a.reminderAt!) - Date.parse(b.reminderAt!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { tasks, due, changed: tasks.some((task, i) => task !== source[i]) };
}

export interface ReminderQueue { tasks: Task[]; replies: Record<string, string> }
export type ReminderAction =
  | { type: 'receive'; tasks: Task[] }
  | { type: 'reply'; id: string; text: string }
  | { type: 'dismiss'; id: string }
  | { type: 'resolve'; id: string }
  | { type: 'sync'; task: Task };
export const emptyReminderQueue: ReminderQueue = { tasks: [], replies: {} };
export function reminderQueueReducer(state: ReminderQueue, action: ReminderAction): ReminderQueue {
  if (action.type === 'reply') return { ...state, replies: { ...state.replies, [action.id]: action.text } };
  if (action.type === 'dismiss') return { ...state, tasks: state.tasks.filter(task => task.id !== action.id) };
  if (action.type === 'resolve') {
    const replies = { ...state.replies }; delete replies[action.id];
    return { tasks: state.tasks.filter(task => task.id !== action.id), replies };
  }
  if (action.type === 'sync') {
    if (action.task.completed || !action.task.awaitingResponse) return reminderQueueReducer(state, { type: 'resolve', id: action.task.id });
    return { ...state, tasks: state.tasks.map(task => task.id === action.task.id ? action.task : task) };
  }
  const tasks = [...state.tasks];
  for (const incoming of action.tasks) {
    if (incoming.completed || !incoming.awaitingResponse) continue;
    const index = tasks.findIndex(task => task.id === incoming.id);
    if (index < 0) tasks.push(incoming); else tasks[index] = incoming;
  }
  // Existing head, order and per-task text are stable across batches/retries.
  return { tasks, replies: state.replies };
}
