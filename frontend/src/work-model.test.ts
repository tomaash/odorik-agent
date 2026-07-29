import { describe, expect, it } from 'vitest'
import type { ActionApprovalItem, TaskItem } from './api/client'
import {
  approvalNeedsAttention,
  approvalsForScope,
  tasksForScope,
} from './work-model'

function task(id: string, status: TaskItem['status'], dueAt?: string, updatedAt?: string): TaskItem {
  return {
    id,
    status,
    title: id,
    assigneeUid: 'member-1',
    assigneeName: 'Member',
    dueAt,
    updatedAt,
  }
}

function approval(
  id: string,
  status: ActionApprovalItem['status'],
  updatedAt: string,
): ActionApprovalItem {
  return {
    id,
    objectType: 'action_approval',
    status,
    approverUid: 'member-1',
    approverName: 'Member',
    action: {
      kind: 'task.create',
      taskId: `task-${id}`,
      title: id,
      assigneeUid: 'member-1',
      assigneeName: 'Member',
    },
    source: {
      kind: 'workflow',
      callId: 'call-1',
      workflowId: 'workflow-1',
      workflowVersion: 2,
      runId: 'run-1',
      blockId: 'block-1',
    },
    effectDigest: `digest-${id}`,
    updatedAt,
  }
}

describe('work model', () => {
  it('keeps pending, executing, and safely retryable approvals in attention', () => {
    expect([
      approval('pending', 'pending', '2026-07-01T00:00:00Z'),
      approval('executing', 'executing', '2026-07-01T00:00:00Z'),
      approval('failed', 'execution_failed', '2026-07-01T00:00:00Z'),
    ].every(approvalNeedsAttention)).toBe(true)
    expect(approvalNeedsAttention(approval('approved', 'approved', '2026-07-01T00:00:00Z'))).toBe(false)
    expect(approvalNeedsAttention(approval('rejected', 'rejected', '2026-07-01T00:00:00Z'))).toBe(false)
  })

  it('separates actionable approval work from decision history', () => {
    const items = [
      approval('approved', 'approved', '2026-07-05T00:00:00Z'),
      approval('pending', 'pending', '2026-07-04T00:00:00Z'),
      approval('rejected', 'rejected', '2026-07-03T00:00:00Z'),
      approval('executing', 'executing', '2026-07-02T00:00:00Z'),
      approval('failed', 'execution_failed', '2026-07-01T00:00:00Z'),
    ]

    expect(approvalsForScope(items, 'waiting').map((item) => item.id))
      .toEqual(['pending', 'executing', 'failed'])
    expect(approvalsForScope(items, 'history').map((item) => item.id))
      .toEqual(['approved', 'rejected'])
  })

  it('orders open tasks by due date and completed work by recency', () => {
    const items = [
      task('later', 'open', '2026-07-05T00:00:00Z'),
      task('undated', 'open'),
      task('first', 'open', '2026-07-03T00:00:00Z'),
      task('older', 'completed', undefined, '2026-07-01T00:00:00Z'),
      task('newer', 'dismissed', undefined, '2026-07-02T00:00:00Z'),
    ]

    expect(tasksForScope(items, 'todo').map((item) => item.id))
      .toEqual(['first', 'later', 'undated'])
    expect(tasksForScope(items, 'done').map((item) => item.id))
      .toEqual(['newer', 'older'])
  })
})
