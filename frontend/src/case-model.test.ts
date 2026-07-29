import { describe, expect, it } from 'vitest'
import { caseActivity } from './case-model'
import type { CaseDetails } from './api/client'

function details(): CaseDetails {
  return {
    case: {
      id: 'case-1',
      objectType: 'case',
      title: 'Renew ACME',
      pipelineId: 'default',
      stageId: 'new',
      contactId: 'contact-1',
      contactName: 'ACME',
      ownerUid: 'member-1',
      ownerName: 'Eva',
      revision: 0,
      createdAt: '2026-07-29T09:00:00.000Z',
    },
    pipeline: {
      id: 'default',
      name: 'Cases',
      schemaVersion: 2,
      revision: 0,
      initialStageId: 'new',
      stages: [{
        id: 'new',
        name: 'New',
        position: 0,
        color: 'slate',
        terminal: false,
        archived: false,
      }],
    },
    contact: { id: 'contact-1', displayName: 'ACME' },
    tasks: [{
      id: 'task-1',
      status: 'completed',
      title: 'Call ACME',
      assigneeUid: 'member-1',
      assigneeName: 'Eva',
      createdAt: '2026-07-29T10:00:00.000Z',
      completedAt: '2026-07-29T11:00:00.000Z',
    }],
    approvals: [],
    calls: [],
    activity: [],
  }
}

describe('case activity', () => {
  it('derives a chronological history from durable case and task timestamps', () => {
    expect(caseActivity(details()).map((item) => item.type)).toEqual([
      'task_completed',
      'task_created',
      'case_created',
    ])
  })

  it('does not duplicate persisted audit events', () => {
    const value = details()
    value.activity.push({
      id: 'audit-task-created',
      aggregateType: 'task',
      aggregateId: 'task-1',
      caseId: 'case-1',
      type: 'task_created',
      createdAt: '2026-07-29T10:00:00.000Z',
    })
    expect(caseActivity(value).filter((item) => item.type === 'task_created')).toHaveLength(1)
  })
})
