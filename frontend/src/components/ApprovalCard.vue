<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import type { ActionApprovalItem } from '../api/client'

const props = defineProps<{
  approval: ActionApprovalItem
  currentUid?: string | null
  processing?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  approve: [approval: ActionApprovalItem]
  reject: [approval: ActionApprovalItem, note?: string]
}>()

const { t } = useI18n()
const rejectOpen = ref(false)
const rejectionNote = ref('')

const canAct = computed(() => (
  props.approval.approverUid === props.currentUid
  && (
    props.approval.status === 'pending'
    || (
      props.approval.status === 'execution_failed'
      && props.approval.executionStatus !== 'outcome_unknown'
    )
  )
))

const relatedCaseId = computed(() => {
  if (props.approval.scope?.caseId) return props.approval.scope.caseId
  if (props.approval.action.kind === 'case.move') return props.approval.action.caseId
  if (props.approval.action.kind === 'task.create' && props.approval.action.caseId) {
    return props.approval.action.caseId
  }
  return null
})

const resultCaseId = computed(() => (
  props.approval.result?.kind === 'case'
    ? props.approval.result.id
    : props.approval.action.kind === 'case.create' && props.approval.status === 'approved'
      ? props.approval.action.caseId
      : null
))
const resultCodingRunId = computed(() => (
  props.approval.result?.kind === 'coding_run'
    ? props.approval.result.id
    : props.approval.action.kind === 'coding.issue.implement'
      && props.approval.status === 'approved'
      ? props.approval.action.runId
      : null
))

function severity(status: ActionApprovalItem['status']) {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'execution_failed') return 'warn'
  if (status === 'executing') return 'info'
  return 'secondary'
}

function title() {
  if (props.approval.action.kind === 'case.move') return props.approval.action.caseTitle
  if (props.approval.action.kind === 'mail.draft.create') return props.approval.action.subject
  return props.approval.action.title
}

function actionLabel() {
  if (props.approval.action.kind === 'coding.issue.implement') {
    if (props.approval.action.linkedAttempt?.kind === 'retry') return t('approvals.codingRetryAction')
    if (props.approval.action.linkedAttempt?.kind === 'pull_request_changes') {
      return t('approvals.codingChangesAction')
    }
    return t('approvals.codingAction')
  }
  if (props.approval.action.kind === 'task.create') return t('approvals.taskAction')
  if (props.approval.action.kind === 'case.create') return t('approvals.createCaseAction')
  if (props.approval.action.kind === 'case.move') return t('approvals.moveCaseAction')
  if (props.approval.action.kind === 'mail.draft.create') return t('approvals.mailDraftAction')
  return t('approvals.title')
}

function effect() {
  if (props.approval.action.kind === 'coding.issue.implement') {
    if (props.approval.action.linkedAttempt?.kind === 'retry') {
      return t('approvals.retryAndOpenDraft', {
        repository: `${props.approval.action.github.owner}/${props.approval.action.github.repo}`,
        issue: props.approval.action.github.issueNumber,
      })
    }
    if (props.approval.action.linkedAttempt?.kind === 'pull_request_changes') {
      return t('approvals.updatePullRequest', {
        pullRequest: props.approval.action.linkedAttempt.pullRequestNumber,
      })
    }
    return t('approvals.implementAndOpenDraft', {
      repository: `${props.approval.action.github.owner}/${props.approval.action.github.repo}`,
      issue: props.approval.action.github.issueNumber,
    })
  }
  if (props.approval.action.kind === 'task.create') {
    return t('approvals.createTaskFor', { assignee: props.approval.action.assigneeName })
  }
  if (props.approval.action.kind === 'case.create') {
    return t('approvals.createCaseFor', {
      owner: props.approval.action.ownerName,
      stage: props.approval.action.stageName,
    })
  }
  if (props.approval.action.kind === 'case.move') return t('approvals.moveCaseFromTo', {
    from: props.approval.action.fromStageName,
    to: props.approval.action.toStageName,
  })
  if (props.approval.action.kind === 'mail.draft.create') {
    return t('approvals.mailDraftFor', {
      recipient: props.approval.action.to.join(', '),
      mailbox: props.approval.action.mailboxAddress,
    })
  }
  return ''
}

function taskSubject() {
  if (props.approval.action.kind !== 'task.create') return ''
  const subject = props.approval.action.subject
  if (!subject) return t('approvals.subject.legacy')
  if (subject?.kind === 'internal') return t('approvals.subject.internal')
  if (subject?.kind === 'matching_case') {
    return t('approvals.subject.case', {
      case: props.approval.action.caseTitle || props.approval.action.caseId || '—',
      stage: subject.stageName || '—',
    })
  }
  return t('approvals.subject.contact', {
    contact: props.approval.action.context?.callerName
      || props.approval.action.context?.callerPhone
      || t('contacts.unknown'),
  })
}

function requestReject() {
  rejectionNote.value = ''
  rejectOpen.value = true
}

function confirmReject() {
  emit('reject', props.approval, rejectionNote.value.trim() || undefined)
  rejectOpen.value = false
}
</script>

<template>
  <article
    class="min-w-0 bg-violet-50/25"
    :class="compact ? 'p-3' : 'grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 sm:gap-4 px-4 sm:px-6 py-4'"
  >
    <span v-if="!compact" class="mt-0.5 w-8 h-8 rounded-md bg-violet-100 text-violet-800 flex items-center justify-center">
      <i class="pi pi-shield" />
    </span>
    <div class="min-w-0">
      <div class="flex items-center gap-2 flex-wrap mb-1.5">
        <Tag :value="t(`approvals.status.${approval.status}`)" :severity="severity(approval.status)" />
        <span class="eyebrow !text-violet-700">{{ actionLabel() }}</span>
      </div>

      <h3 class="text-sm font-semibold leading-snug m-0 break-words">
        <router-link
          v-if="relatedCaseId"
          :to="`/cases/${relatedCaseId}`"
          class="text-[var(--ink)] no-underline hover:text-indigo-700"
        >
          {{ title() }}
        </router-link>
        <template v-else>{{ title() }}</template>
      </h3>

      <p
        v-if="approval.action.kind === 'task.create' && approval.action.instructions"
        class="text-sm text-surface-600 leading-relaxed mt-1.5 mb-0 break-words"
      >
        {{ approval.action.instructions }}
      </p>

      <div class="mt-3 rounded-md border border-violet-200 bg-white/80 p-3 grid gap-1.5 text-xs">
        <strong class="text-violet-950">{{ t('approvals.exactEffect') }}</strong>
        <span>{{ effect() }}</span>
        <template v-if="approval.action.kind === 'coding.issue.implement'">
          <span><i class="pi pi-code-branch mr-1" />{{ approval.action.git.sourceBranch || approval.action.git.baseBranch }} @ {{ approval.action.git.baseSha.slice(0, 12) }}</span>
          <span>
            <i class="pi pi-github mr-1" />{{ approval.action.git.resultBranch }} ·
            {{ approval.action.linkedAttempt?.kind === 'pull_request_changes'
              ? `PR #${approval.action.linkedAttempt.pullRequestNumber}`
              : t('approvals.draftPrAutomatic') }}
          </span>
          <span v-if="approval.action.linkedAttempt">
            <i class="pi pi-link mr-1" />{{ t('approvals.linkedAttempt', { attempt: approval.action.linkedAttempt.attempt }) }}
          </span>
          <span><i class="pi pi-sparkles mr-1" />{{ t('approvals.grokSubscriptionOnly') }}</span>
          <span><i class="pi pi-clock mr-1" />{{ t('approvals.codingLimits', {
            minutes: approval.action.limits.maxRuntimeMinutes,
            turns: approval.action.limits.maxTurns,
            files: approval.action.limits.maxChangedFiles,
          }) }}</span>
          <span><i class="pi pi-ban mr-1" />{{ t('approvals.noMergeDeploy') }}</span>
        </template>
        <template v-if="approval.action.kind === 'mail.draft.create'">
          <span><i class="pi pi-inbox mr-1" />{{ t('approvals.mailFrom', { mailbox: approval.action.mailboxAddress }) }}</span>
          <span><i class="pi pi-send mr-1" />{{ t('approvals.mailTo', { recipient: approval.action.to.join(', ') }) }}</span>
          <span><i class="pi pi-tag mr-1" />{{ approval.action.subject }}</span>
          <span><i class="pi pi-ban mr-1" />{{ t('approvals.mailNoSend') }}</span>
        </template>
        <span v-if="approval.action.kind === 'task.create'">{{ taskSubject() }}</span>
        <span v-if="approval.action.kind === 'task.create'">
          <i class="pi pi-calendar mr-1" />{{ approval.action.dueAt ? new Date(approval.action.dueAt).toLocaleDateString() : t('tasks.noDueDate') }}
        </span>
        <span><i class="pi pi-user-edit mr-1" />{{ t('approvals.approver', { approver: approval.approverName }) }}</span>
      </div>

      <p class="text-xs text-surface-500 mt-2 mb-0">
        <i class="pi pi-sitemap mr-1" />{{ t('approvals.workflowSource', { version: approval.source.workflowVersion }) }}
      </p>

      <details v-if="approval.action.context?.callSummary || approval.action.context?.transcriptExcerpt" class="mt-3">
        <summary class="cursor-pointer text-xs font-medium text-surface-600">{{ t('tasks.callContext') }}</summary>
        <p v-if="approval.action.context.callSummary" class="text-sm leading-relaxed mt-2 mb-1">{{ approval.action.context.callSummary }}</p>
        <p v-if="approval.action.context.transcriptExcerpt" class="text-xs leading-relaxed text-surface-500 mt-1 mb-0">“{{ approval.action.context.transcriptExcerpt }}”</p>
      </details>
      <details v-if="approval.action.kind === 'mail.draft.create'" class="mt-3" open>
        <summary class="cursor-pointer text-xs font-medium" style="color: var(--missing)">
          <i class="pi pi-pencil mr-1" />{{ t('approvals.mailBodyGenerated') }}
        </summary>
        <p
          class="text-sm whitespace-pre-wrap leading-relaxed mt-2 mb-0 rounded-md p-3"
          style="background: var(--missing-soft)"
        >{{ approval.action.body }}</p>
        <p class="text-xs text-surface-500 mt-2 mb-0">{{ t('approvals.mailBodyNotInGmail') }}</p>
      </details>
      <details v-if="approval.action.kind === 'coding.issue.implement'" class="mt-3">
        <summary class="cursor-pointer text-xs font-medium text-surface-600">{{ t('approvals.issueSnapshot') }}</summary>
        <p class="text-xs whitespace-pre-wrap leading-relaxed text-surface-600 mt-2 mb-0">{{ approval.action.issueExcerpt }}</p>
      </details>
      <details v-if="approval.action.kind === 'coding.issue.implement' && approval.action.linkedAttempt" class="mt-3">
        <summary class="cursor-pointer text-xs font-medium text-surface-600">
          {{ t('approvals.linkedAttempt', { attempt: approval.action.linkedAttempt.attempt }) }}
        </summary>
        <p class="text-xs whitespace-pre-wrap leading-relaxed text-surface-600 mt-2 mb-0">
          {{ approval.action.linkedAttempt.instructions }}
        </p>
      </details>

      <p v-if="approval.executionError" class="text-xs text-amber-800 mt-2 mb-0">{{ approval.executionError }}</p>
      <p v-if="approval.rejectionNote" class="text-xs text-rose-800 mt-2 mb-0">
        {{ t('approvals.rejectionReason', { reason: approval.rejectionNote }) }}
      </p>

      <router-link
        v-if="resultCaseId"
        :to="`/cases/${resultCaseId}`"
        class="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 no-underline"
      >
        {{ t('approvals.openResult') }} <i class="pi pi-arrow-right text-[.65rem]" />
      </router-link>
      <router-link
        v-if="resultCodingRunId"
        :to="{ path: '/coding', query: { run: resultCodingRunId } }"
        class="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 no-underline"
      >
        {{ t('approvals.openResult') }} <i class="pi pi-arrow-right text-[.65rem]" />
      </router-link>

      <div
        v-if="canAct"
        class="mt-3 pt-3 border-t border-violet-200/80 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2"
      >
        <Button
          v-if="approval.status === 'pending'"
          :label="t('approvals.reject')"
          icon="pi pi-times"
          size="small"
          severity="secondary"
          outlined
          class="w-full sm:w-auto"
          :disabled="processing"
          @click="requestReject"
        />
        <Button
          :label="approval.status === 'execution_failed' ? t('approvals.retry') : t('approvals.approve')"
          icon="pi pi-check"
          size="small"
          class="w-full sm:w-auto"
          :loading="processing"
          @click="emit('approve', approval)"
        />
      </div>
      <p
        v-else-if="approval.status === 'pending'"
        class="mt-3 pt-3 border-t border-violet-200/80 text-xs text-surface-500 mb-0"
      >
        {{ t('approvals.waitingFor', { approver: approval.approverName }) }}
      </p>
    </div>
  </article>

  <Dialog
    v-model:visible="rejectOpen"
    modal
    :header="t('approvals.rejectTitle')"
    class="w-[min(30rem,calc(100vw-2rem))]"
  >
    <label class="grid gap-1.5 text-sm font-medium">
      {{ t('approvals.rejectReason') }}
      <Textarea v-model="rejectionNote" rows="3" autoResize :placeholder="t('approvals.rejectReasonHint')" autofocus />
    </label>
    <div class="flex justify-end gap-2 mt-5">
      <Button :label="t('common.cancel')" severity="secondary" text @click="rejectOpen = false" />
      <Button :label="t('approvals.reject')" icon="pi pi-times" severity="danger" @click="confirmReject" />
    </div>
  </Dialog>
</template>
