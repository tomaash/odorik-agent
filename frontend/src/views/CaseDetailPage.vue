<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Skeleton from 'primevue/skeleton'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useAuthStore } from '../stores/auth'
import { caseActivity } from '../case-model'
import {
  archiveCase,
  createTask,
  getCaseDetails,
  getTeamOverview,
  moveCase,
  transitionTask,
  type ActionApprovalItem,
  type CaseActivity,
  type CaseDetails,
  type TaskItem,
  type TeamMember,
} from '../api/client'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const authStore = useAuthStore()
const caseId = String(route.params.id)
const details = ref<CaseDetails | null>(null)
const members = ref<TeamMember[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const dialog = ref<'create' | 'outcome' | 'archive' | null>(null)
const selectedTask = ref<TaskItem | null>(null)
const outcome = ref<'completed' | 'dismissed'>('completed')
const outcomeNote = ref('')
const taskForm = ref({
  title: '',
  instructions: '',
  assigneeUid: '',
  dueAt: null as Date | null,
})

const activeStages = computed(() => (
  [...(details.value?.pipeline.stages || [])]
    .filter((stage) => !stage.archived)
    .sort((left, right) => left.position - right.position)
))
const currentStage = computed(() => details.value?.pipeline.stages.find(
  (stage) => stage.id === details.value?.case.stageId,
))
const tasks = computed(() => [...(details.value?.tasks || [])].sort((left, right) => {
  if (left.status === 'open' && right.status !== 'open') return -1
  if (right.status === 'open' && left.status !== 'open') return 1
  return new Date(right.updatedAt || right.createdAt || 0).getTime()
    - new Date(left.updatedAt || left.createdAt || 0).getTime()
}))
const pendingApprovals = computed(() => details.value?.approvals.filter(
  (approval) => approval.status === 'pending' || approval.status === 'execution_failed',
).length || 0)

function formatDate(value?: string | null, includeTime = true) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', {
    dateStyle: 'medium',
    ...(includeTime ? { timeStyle: 'short' as const } : {}),
  }).format(date)
}

function formatDuration(value?: number | null) {
  if (!value) return ''
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function stageName(stageId: unknown) {
  if (typeof stageId !== 'string') return '—'
  return details.value?.pipeline.stages.find((stage) => stage.id === stageId)?.name || stageId
}

function taskSeverity(status: TaskItem['status']) {
  if (status === 'completed') return 'success'
  if (status === 'dismissed') return 'secondary'
  return 'info'
}

function approvalSeverity(status: ActionApprovalItem['status']) {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'execution_failed') return 'warn'
  if (status === 'executing') return 'info'
  return 'secondary'
}

function approvalTitle(approval: ActionApprovalItem) {
  return approval.action.kind === 'case.move'
    ? approval.action.caseTitle
    : approval.action.title
}

function approvalEffect(approval: ActionApprovalItem) {
  if (approval.action.kind === 'case.create') {
    return t('approvals.createCaseFor', {
      owner: approval.action.ownerName,
      stage: approval.action.stageName,
    })
  }
  if (approval.action.kind === 'case.move') {
    return t('approvals.moveCaseFromTo', {
      from: approval.action.fromStageName,
      to: approval.action.toStageName,
    })
  }
  return t('approvals.createTaskFor', { assignee: approval.action.assigneeName })
}

function originLabel() {
  const kind = details.value?.case.source?.kind
  if (kind === 'workflow') return t('caseDetails.originWorkflow')
  if (kind === 'call') return t('caseDetails.originCall')
  return t('caseDetails.originManual')
}

function memberName(uid?: string) {
  if (!uid) return ''
  if (uid.startsWith('workflow:')) return t('app.agentName')
  return members.value.find((member) => member.uid === uid)?.displayName
    || (uid === details.value?.case.ownerUid ? details.value.case.ownerName : '')
    || uid.slice(0, 12)
}

function activityText(item: CaseActivity) {
  const task = details.value?.tasks.find((candidate) => candidate.id === item.aggregateId)
  const params = {
    title: task?.title || t('tasks.title'),
    from: stageName(item.before?.stageId),
    to: stageName(item.after?.stageId),
  }
  const known = new Set([
    'case_created',
    'deal_created',
    'case_stage_changed',
    'deal_stage_changed',
    'case_archived',
    'task_created',
    'task_completed',
    'task_dismissed',
    'task_reopened',
    'approval_requested',
    'approval_approved',
    'approval_execution_retried',
    'approval_executed',
    'approval_rejected',
  ])
  return t(`caseDetails.events.${known.has(item.type) ? item.type : 'other'}`, params)
}

function activityIcon(item: CaseActivity) {
  if (item.type.includes('stage')) return 'pi pi-arrow-right'
  if (item.type.includes('approval')) return 'pi pi-shield'
  if (item.type.includes('task')) return 'pi pi-check-square'
  if (item.type.includes('archive')) return 'pi pi-box'
  return 'pi pi-folder'
}

const activity = computed<CaseActivity[]>(() => {
  if (!details.value) return []
  return caseActivity(details.value)
})

async function load(showLoading = true) {
  if (showLoading) loading.value = true
  error.value = ''
  try {
    const [caseData, team] = await Promise.all([
      getCaseDetails(caseId),
      getTeamOverview(),
    ])
    details.value = caseData
    members.value = team.members
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function move(stageId: string) {
  const item = details.value?.case
  if (!item || item.archived || item.stageId === stageId) return
  saving.value = true
  error.value = ''
  try {
    await moveCase({
      caseId: item.id,
      stageId,
      expectedRevision: item.revision,
      expectedStageId: item.stageId,
    })
    await load(false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

function openCreateTask() {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  taskForm.value = {
    title: '',
    instructions: '',
    assigneeUid: details.value?.case.ownerUid
      || authStore.user?.uid
      || members.value[0]?.uid
      || '',
    dueAt: tomorrow,
  }
  dialog.value = 'create'
}

async function submitTask() {
  if (!details.value || !taskForm.value.title.trim() || !taskForm.value.assigneeUid) return
  saving.value = true
  error.value = ''
  try {
    await createTask({
      title: taskForm.value.title,
      instructions: taskForm.value.instructions || undefined,
      assigneeUid: taskForm.value.assigneeUid,
      dueAt: taskForm.value.dueAt?.toISOString() || null,
      contactId: details.value.case.contactId,
      caseId: details.value.case.id,
    })
    dialog.value = null
    await load(false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

function openOutcome(task: TaskItem, to: 'completed' | 'dismissed') {
  selectedTask.value = task
  outcome.value = to
  outcomeNote.value = ''
  dialog.value = 'outcome'
}

async function submitOutcome() {
  if (!selectedTask.value) return
  saving.value = true
  error.value = ''
  try {
    await transitionTask({
      taskId: selectedTask.value.id,
      to: outcome.value,
      ...(outcomeNote.value.trim() ? { note: outcomeNote.value.trim() } : {}),
    })
    dialog.value = null
    await load(false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function reopen(task: TaskItem) {
  saving.value = true
  error.value = ''
  try {
    await transitionTask({ taskId: task.id, to: 'open' })
    await load(false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function confirmArchive() {
  if (!details.value) return
  saving.value = true
  error.value = ''
  try {
    await archiveCase(details.value.case.id)
    await router.push('/pipeline')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="min-h-screen min-w-0">
    <header class="px-3 sm:px-6 h-16 flex items-center justify-between gap-3 border-b border-[var(--hairline)]">
      <div class="min-w-0 flex items-center gap-2">
        <Button icon="pi pi-arrow-left" severity="secondary" text :aria-label="t('caseDetails.back')" @click="router.push('/pipeline')" />
        <div class="min-w-0">
          <div class="eyebrow !text-surface-500">{{ t('caseDetails.eyebrow') }}</div>
          <h1 class="m-0 text-base font-semibold truncate">{{ details?.case.title || t('caseDetails.eyebrow') }}</h1>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <Button icon="pi pi-refresh" severity="secondary" text :loading="loading" :aria-label="t('common.refresh')" @click="load()" />
        <Button
          v-if="details && !details.case.archived"
          :label="t('caseDetails.newTask')"
          icon="pi pi-plus"
          size="small"
          @click="openCreateTask"
        />
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading && !details" class="p-4 sm:p-6 max-w-6xl mx-auto grid gap-4">
      <Skeleton height="13rem" />
      <div class="grid lg:grid-cols-2 gap-4">
        <Skeleton height="28rem" />
        <Skeleton height="28rem" />
      </div>
    </div>

    <main v-else-if="details" class="max-w-6xl mx-auto p-4 sm:p-6">
      <section class="hairline-card overflow-hidden mb-5">
        <div class="p-4 sm:p-6 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap mb-2">
              <span class="eyebrow">{{ details.pipeline.name }}</span>
              <Tag v-if="details.case.archived" :value="t('caseDetails.archived')" severity="secondary" />
              <Tag v-if="currentStage?.terminal" :value="currentStage.name" severity="success" />
            </div>
            <h2 class="text-2xl sm:text-3xl font-semibold tracking-[-.03em] leading-tight m-0 break-words">{{ details.case.title }}</h2>
            <p class="mt-2 mb-0 text-sm text-surface-500">
              {{ t('caseDetails.origin') }}: {{ originLabel() }} · {{ formatDate(details.case.createdAt) }}
            </p>
          </div>
          <div v-if="!details.case.archived" class="w-full lg:w-[18rem] grid gap-2">
            <label class="grid gap-1.5 text-xs font-medium text-surface-600">
              {{ t('caseDetails.stage') }}
              <Select
                :modelValue="details.case.stageId"
                :options="activeStages"
                optionLabel="name"
                optionValue="id"
                :loading="saving"
                @update:modelValue="move"
              />
            </label>
            <Button
              :label="t('caseDetails.archive')"
              icon="pi pi-box"
              severity="secondary"
              text
              size="small"
              class="justify-self-start"
              @click="dialog = 'archive'"
            />
          </div>
        </div>

        <div class="grid sm:grid-cols-3 border-t border-[var(--hairline)] divide-y sm:divide-y-0 sm:divide-x divide-[var(--hairline)]">
          <router-link :to="`/contacts/${details.contact.id}`" class="p-4 no-underline text-[var(--ink)] hover:bg-white">
            <span class="eyebrow !text-surface-400">{{ t('caseDetails.contact') }}</span>
            <strong class="block text-sm mt-1 break-words">{{ details.contact.displayName || details.contact.phoneE164 || details.contact.phoneRaw || '—' }}</strong>
            <span class="block text-xs text-surface-500 mt-1 break-all">{{ details.contact.phoneE164 || details.contact.phoneRaw || details.contact.email || '—' }}</span>
          </router-link>
          <div class="p-4">
            <span class="eyebrow !text-surface-400">{{ t('caseDetails.owner') }}</span>
            <strong class="block text-sm mt-1">{{ details.case.ownerName }}</strong>
          </div>
          <div class="p-4">
            <span class="eyebrow !text-surface-400">{{ t('caseDetails.stage') }}</span>
            <strong class="block text-sm mt-1">{{ currentStage?.name || details.case.stageId }}</strong>
            <span class="block font-mono text-[.62rem] text-surface-400 mt-1">rev {{ details.case.revision }}</span>
          </div>
        </div>
      </section>

      <div class="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(19rem,.75fr)] gap-5 items-start">
        <div class="min-w-0 grid gap-5">
          <section class="hairline-card overflow-hidden">
            <header class="px-4 py-3 border-b border-[var(--hairline)] flex items-center justify-between gap-3">
              <h2 class="text-sm font-semibold m-0">{{ t('caseDetails.tasks') }} <span class="text-surface-400 ml-1">{{ tasks.length }}</span></h2>
              <Button v-if="!details.case.archived" :label="t('caseDetails.newTask')" icon="pi pi-plus" size="small" text @click="openCreateTask" />
            </header>
            <div v-if="tasks.length" class="divide-y divide-[var(--hairline)]">
              <article v-for="task in tasks" :key="task.id" class="p-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <strong class="block text-sm break-words">{{ task.title }}</strong>
                    <p v-if="task.instructions" class="text-sm text-surface-600 leading-relaxed mt-1.5 mb-0 break-words">{{ task.instructions }}</p>
                  </div>
                  <Tag :value="t(`tasks.status.${task.status}`)" :severity="taskSeverity(task.status)" />
                </div>
                <div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 font-mono text-[.63rem] text-surface-500">
                  <span><i class="pi pi-user mr-1" />{{ task.assigneeName }}</span>
                  <span><i class="pi pi-calendar mr-1" />{{ formatDate(task.dueAt, false) }}</span>
                </div>
                <p v-if="task.outcomeNote" class="text-xs text-surface-500 mt-2 mb-0">{{ task.outcomeNote }}</p>
                <div v-if="!details.case.archived" class="mt-3 flex justify-end gap-2">
                  <template v-if="task.status === 'open'">
                    <Button :label="t('tasks.dismiss')" severity="secondary" outlined size="small" @click="openOutcome(task, 'dismissed')" />
                    <Button :label="t('tasks.done')" icon="pi pi-check" size="small" @click="openOutcome(task, 'completed')" />
                  </template>
                  <Button v-else :label="t('tasks.reopen')" icon="pi pi-undo" severity="secondary" text size="small" @click="reopen(task)" />
                </div>
              </article>
            </div>
            <p v-else class="text-sm text-surface-500 text-center py-10 px-4 m-0">{{ t('caseDetails.noTasks') }}</p>
          </section>

          <section class="hairline-card overflow-hidden">
            <header class="px-4 py-3 border-b border-[var(--hairline)]">
              <h2 class="text-sm font-semibold m-0">{{ t('caseDetails.calls') }} <span class="text-surface-400 ml-1">{{ details.calls.length }}</span></h2>
            </header>
            <div v-if="details.calls.length" class="divide-y divide-[var(--hairline)]">
              <article v-for="call in details.calls" :key="call.id" class="p-4">
                <div class="flex items-center gap-2 text-xs font-medium text-indigo-800">
                  <i class="pi pi-phone" />
                  <span>{{ t('caseDetails.sourceCall') }} · {{ formatDate(call.odorikTime || call.uploadedAt) }}</span>
                  <span v-if="call.durationSeconds || call.duration" class="font-mono text-surface-400">{{ formatDuration(call.durationSeconds || call.duration) }}</span>
                </div>
                <p class="text-sm leading-relaxed mt-2 mb-0 break-words">{{ call.summary || t('caseDetails.noSummary') }}</p>
                <details v-if="call.transcript" class="mt-3">
                  <summary class="cursor-pointer text-xs font-medium text-indigo-800">{{ t('caseDetails.showTranscript') }}</summary>
                  <p class="whitespace-pre-wrap break-words leading-relaxed text-sm mt-3 mb-0">{{ call.transcript }}</p>
                </details>
              </article>
            </div>
            <p v-else class="text-sm text-surface-500 text-center py-10 px-4 m-0">{{ t('caseDetails.noCalls') }}</p>
          </section>
        </div>

        <aside class="min-w-0 grid gap-5">
          <section class="hairline-card overflow-hidden">
            <header class="px-4 py-3 border-b border-[var(--hairline)] flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold m-0">{{ t('caseDetails.approvals') }} <span class="text-surface-400 ml-1">{{ details.approvals.length }}</span></h2>
              <Tag v-if="pendingApprovals" :value="String(pendingApprovals)" severity="warn" />
            </header>
            <div v-if="details.approvals.length" class="divide-y divide-[var(--hairline)]">
              <article v-for="approval in details.approvals" :key="approval.id" class="p-4">
                <div class="flex items-center gap-2 flex-wrap">
                  <Tag :value="t(`approvals.status.${approval.status}`)" :severity="approvalSeverity(approval.status)" />
                  <span class="eyebrow !text-violet-700">{{ approval.action.kind === 'case.move' ? t('approvals.moveCaseAction') : t('approvals.createCaseAction') }}</span>
                </div>
                <strong class="block text-sm mt-2 break-words">{{ approvalTitle(approval) }}</strong>
                <p class="text-xs text-surface-600 leading-relaxed mt-2 mb-0">{{ approvalEffect(approval) }}</p>
                <p class="text-xs text-surface-500 mt-2 mb-0">{{ t('approvals.approver', { approver: approval.approverName }) }}</p>
              </article>
              <router-link to="/tasks?view=approvals" class="h-11 px-4 flex items-center justify-center text-xs font-semibold text-indigo-700 no-underline hover:bg-white">
                {{ t('caseDetails.viewApprovalQueue') }}
              </router-link>
            </div>
            <p v-else class="text-sm text-surface-500 text-center py-8 px-4 m-0">{{ t('caseDetails.noApprovals') }}</p>
          </section>

          <section class="hairline-card overflow-hidden">
            <header class="px-4 py-3 border-b border-[var(--hairline)]">
              <h2 class="text-sm font-semibold m-0">{{ t('caseDetails.activity') }}</h2>
            </header>
            <div v-if="activity.length" class="p-4">
              <ol class="m-0 p-0 list-none grid">
                <li v-for="(item, index) in activity" :key="item.id" class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 min-w-0">
                  <div class="flex flex-col items-center">
                    <span class="w-7 h-7 rounded-full bg-surface-100 text-surface-600 flex items-center justify-center shrink-0">
                      <i :class="[activityIcon(item), 'text-[.7rem]']" />
                    </span>
                    <span v-if="index < activity.length - 1" class="w-px min-h-8 flex-1 bg-surface-200" />
                  </div>
                  <div class="pb-5 min-w-0">
                    <p class="text-xs font-medium leading-relaxed m-0 break-words">{{ activityText(item) }}</p>
                    <p class="font-mono text-[.58rem] text-surface-400 mt-1 mb-0">
                      {{ formatDate(item.createdAt) }}
                      <template v-if="item.actor?.id"> · {{ t('caseDetails.by', { name: memberName(item.actor.id) }) }}</template>
                    </p>
                  </div>
                </li>
              </ol>
            </div>
            <p v-else class="text-sm text-surface-500 text-center py-8 px-4 m-0">{{ t('caseDetails.noActivity') }}</p>
          </section>
        </aside>
      </div>
    </main>

    <Dialog
      :visible="dialog === 'create'"
      modal
      :header="t('caseDetails.newTask')"
      class="w-[min(34rem,calc(100vw-2rem))]"
      @update:visible="(visible) => { if (!visible) dialog = null }"
    >
      <form class="grid gap-4" @submit.prevent="submitTask">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('tasks.fields.title') }}
          <InputText v-model="taskForm.title" autofocus />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('tasks.fields.instructions') }}
          <Textarea v-model="taskForm.instructions" rows="3" autoResize />
        </label>
        <div class="grid sm:grid-cols-2 gap-4">
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.assignee') }}
            <Select v-model="taskForm.assigneeUid" :options="members" optionLabel="displayName" optionValue="uid" />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.due') }}
            <DatePicker v-model="taskForm.dueAt" showIcon dateFormat="dd M yy" />
          </label>
        </div>
        <div class="flex justify-end gap-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="dialog = null" />
          <Button :label="t('tasks.create')" icon="pi pi-plus" type="submit" :loading="saving" :disabled="!taskForm.title.trim() || !taskForm.assigneeUid" />
        </div>
      </form>
    </Dialog>

    <Dialog
      :visible="dialog === 'outcome'"
      modal
      :header="t('caseDetails.taskOutcome')"
      class="w-[min(30rem,calc(100vw-2rem))]"
      @update:visible="(visible) => { if (!visible) dialog = null }"
    >
      <form class="grid gap-4" @submit.prevent="submitOutcome">
        <strong class="text-sm">{{ selectedTask?.title }}</strong>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('tasks.fields.outcome') }}
          <Textarea v-model="outcomeNote" rows="3" autoResize :placeholder="t('caseDetails.taskOutcomeHint')" />
        </label>
        <div class="flex justify-end gap-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="dialog = null" />
          <Button :label="outcome === 'completed' ? t('tasks.done') : t('tasks.dismiss')" type="submit" :loading="saving" />
        </div>
      </form>
    </Dialog>

    <Dialog
      :visible="dialog === 'archive'"
      modal
      :header="t('caseDetails.archiveTitle')"
      class="w-[min(30rem,calc(100vw-2rem))]"
      @update:visible="(visible) => { if (!visible) dialog = null }"
    >
      <p class="text-sm text-surface-600 leading-relaxed mt-0">{{ t('caseDetails.archiveBody') }}</p>
      <div class="flex justify-end gap-2 mt-5">
        <Button :label="t('common.cancel')" severity="secondary" text @click="dialog = null" />
        <Button :label="t('caseDetails.archiveConfirm')" icon="pi pi-box" severity="danger" :loading="saving" @click="confirmArchive" />
      </div>
    </Dialog>
  </section>
</template>
