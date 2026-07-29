import type { ActionApprovalItem, TaskItem } from './api/client'

export type TaskWorkScope = 'todo' | 'done'
export type ApprovalWorkScope = 'waiting' | 'history'

export function approvalNeedsAttention(approval: ActionApprovalItem): boolean {
  return approval.status === 'pending'
    || approval.status === 'executing'
    || approval.status === 'execution_failed'
}

export function tasksForScope(tasks: TaskItem[], scope: TaskWorkScope): TaskItem[] {
  return tasks
    .filter((task) => scope === 'todo' ? task.status === 'open' : task.status !== 'open')
    .sort((left, right) => {
      if (scope === 'done') {
        return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
      }
      const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER
      const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER
      return leftDue - rightDue
    })
}

export function approvalsForScope(
  approvals: ActionApprovalItem[],
  scope: ApprovalWorkScope,
): ActionApprovalItem[] {
  return approvals
    .filter((approval) => (
      scope === 'waiting'
        ? approvalNeedsAttention(approval)
        : !approvalNeedsAttention(approval)
    ))
    .sort((left, right) => (
      new Date(right.updatedAt || right.createdAt || 0).getTime()
        - new Date(left.updatedAt || left.createdAt || 0).getTime()
    ))
}
