import type { CaseActivity, CaseDetails } from './api/client'

export function caseActivity(details: CaseDetails): CaseActivity[] {
  const caseId = details.case.id
  const items = [...details.activity]
  const hasEvent = (aggregateId: string, type: string) => items.some(
    (item) => item.aggregateId === aggregateId && item.type === type,
  )

  if (
    details.case.createdAt
    && !items.some((item) => (
      item.aggregateId === caseId
      && (item.type === 'case_created' || item.type === 'deal_created')
    ))
  ) {
    items.push({
      id: `case-created-${caseId}`,
      aggregateType: 'case',
      aggregateId: caseId,
      caseId,
      type: 'case_created',
      createdAt: details.case.createdAt,
    })
  }

  for (const task of details.tasks) {
    if (task.createdAt && !hasEvent(task.id, 'task_created')) {
      items.push({
        id: `task-created-${task.id}`,
        aggregateType: 'task',
        aggregateId: task.id,
        caseId,
        type: 'task_created',
        createdAt: task.createdAt,
      })
    }
    if (task.completedAt && !hasEvent(task.id, 'task_completed')) {
      items.push({
        id: `task-completed-${task.id}`,
        aggregateType: 'task',
        aggregateId: task.id,
        caseId,
        type: 'task_completed',
        createdAt: task.completedAt,
      })
    }
    if (task.dismissedAt && !hasEvent(task.id, 'task_dismissed')) {
      items.push({
        id: `task-dismissed-${task.id}`,
        aggregateType: 'task',
        aggregateId: task.id,
        caseId,
        type: 'task_dismissed',
        createdAt: task.dismissedAt,
      })
    }
  }

  for (const approval of details.approvals) {
    if (approval.createdAt && !hasEvent(approval.id, 'approval_requested')) {
      items.push({
        id: `approval-requested-${approval.id}`,
        aggregateType: 'action_approval',
        aggregateId: approval.id,
        caseId,
        type: 'approval_requested',
        createdAt: approval.createdAt,
      })
    }
    const decisionType = approval.status === 'rejected'
      ? 'approval_rejected'
      : approval.status === 'approved'
        ? 'approval_executed'
        : null
    const decisionAt = approval.status === 'rejected' ? approval.rejectedAt : approval.executedAt
    if (decisionType && decisionAt && !hasEvent(approval.id, decisionType)) {
      items.push({
        id: `${decisionType}-${approval.id}`,
        aggregateType: 'action_approval',
        aggregateId: approval.id,
        caseId,
        type: decisionType,
        createdAt: decisionAt,
      })
    }
  }

  return items.sort(
    (left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime(),
  )
}
