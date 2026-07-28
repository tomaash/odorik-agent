import { describe, expect, it } from 'vitest'
import { isTaskOverdue, sortedTasks, taskStatusCounts } from './task-model'
import type { TaskItem } from './api/client'

function task(id: string, status: TaskItem['status'], dueAt?: string): TaskItem {
  return {
    id,
    status,
    title: id,
    assigneeUid: 'member-1',
    assigneeName: 'Member',
    dueAt,
  }
}

describe('task model', () => {
  it('counts only the supported lifecycle states', () => {
    expect(taskStatusCounts([
      task('a', 'open'),
      task('b', 'completed'),
      task('c', 'dismissed'),
      task('d', 'open'),
    ])).toEqual({ open: 2, completed: 1, dismissed: 1 })
  })

  it('orders open work by due date and leaves undated work last', () => {
    expect(sortedTasks([
      task('later', 'open', '2026-08-03T00:00:00.000Z'),
      task('undated', 'open'),
      task('first', 'open', '2026-08-01T00:00:00.000Z'),
    ], 'open').map((item) => item.id)).toEqual(['first', 'later', 'undated'])
  })

  it('marks only open tasks with a past valid due date overdue', () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z')
    expect(isTaskOverdue(task('open', 'open', '2026-08-01T00:00:00.000Z'), now)).toBe(true)
    expect(isTaskOverdue(task('done', 'completed', '2026-08-01T00:00:00.000Z'), now)).toBe(false)
    expect(isTaskOverdue(task('invalid', 'open', 'not-a-date'), now)).toBe(false)
  })
})
