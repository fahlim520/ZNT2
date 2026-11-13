import type { Task } from './domain';

// Validate against the latest snapshot before a single atomic store write.
export function deleteCompletedTasks(tasks: Task[], input: unknown): { tasks: Task[]; deletedIds: string[] } {
  if (!Array.isArray(input) || !input.length || input.length > 5000
    || input.some(id => typeof id !== 'string' || !id.trim() || id.length > 100)) {
    throw new Error('请选择要删除的已完成任务（一次最多 5000 条）');
  }
  const ids = new Set<string>(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const id of ids) {
    const task = byId.get(id);
    if (!task) throw new Error('部分任务已不存在，请刷新列表后重新选择');
    if (!task.completed) throw new Error('部分任务已恢复为待办，本次未删除任何任务，请重新选择');
  }
  return { tasks: tasks.filter(task => !ids.has(task.id)), deletedIds: [...ids] };
}
