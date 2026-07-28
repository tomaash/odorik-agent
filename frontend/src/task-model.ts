import type { TaskItem, TaskStatus } from './api/client'

export function isTaskOverdue(task: TaskItem, now = Date.now()): boolean {
  if (task.status !== 'open' || !task.dueAt) return false
  const due = new Date(task.dueAt).getTime()
  return Number.isFinite(due) && due < now
}

export function taskStatusCounts(tasks: TaskItem[]): Record<TaskStatus, number> {
  return {
    open: tasks.filter((task) => task.status === 'open').length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    dismissed: tasks.filter((task) => task.status === 'dismissed').length,
  }
}

export function sortedTasks(tasks: TaskItem[], status: TaskStatus): TaskItem[] {
  return tasks
    .filter((task) => task.status === status)
    .sort((left, right) => {
      if (status !== 'open') {
        return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
      }
      const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER
      const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER
      return leftDue - rightDue
    })
}
