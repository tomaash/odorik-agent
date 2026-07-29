<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
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
import ApprovalCard from '../components/ApprovalCard.vue'
import { useAuthStore } from '../stores/auth'
import {
  approveAction,
  createTask,
  getTeamOverview,
  listActionApprovals,
  listCases,
  listContacts,
  listTasks,
  rejectAction,
  transitionTask,
  type ActionApprovalItem,
  type ContactListItem,
  type CaseItem,
  type TaskItem,
  type TeamMember,
} from '../api/client'
import { isTaskOverdue } from '../task-model'
import {
  approvalNeedsAttention,
  approvalsForScope,
  tasksForScope,
  type ApprovalWorkScope,
  type TaskWorkScope,
} from '../work-model'

const { t, locale } = useI18n()
const route = useRoute()
const authStore = useAuthStore()
const tasks = ref<TaskItem[]>([])
const approvals = ref<ActionApprovalItem[]>([])
const members = ref<TeamMember[]>([])
const contacts = ref<ContactListItem[]>([])
const cases = ref<CaseItem[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const view = ref<'tasks' | 'approvals'>(route.query.view === 'approvals' ? 'approvals' : 'tasks')
const audience = ref<'mine' | 'team'>('mine')
const taskScope = ref<TaskWorkScope>('todo')
const approvalScope = ref<ApprovalWorkScope>('waiting')
const processingApprovalId = ref('')
const dialog = ref<'create' | 'outcome' | null>(null)
const selectedTask = ref<TaskItem | null>(null)
const outcome = ref<'completed' | 'dismissed'>('completed')
const outcomeNote = ref('')
const form = ref({
  title: '',
  instructions: '',
  assigneeUid: '',
  dueAt: null as Date | null,
  contactId: null as string | null,
  caseId: null as string | null,
})

const visibleTasks = computed(() => tasksForScope(tasks.value, taskScope.value))
const visibleApprovals = computed(() => approvalsForScope(approvals.value, approvalScope.value))
const pendingApprovalCount = computed(() => approvals.value.filter((approval) => (
  approvalNeedsAttention(approval)
  && approval.approverUid === authStore.user?.uid
)).length)
const availableCases = computed(() => (
  form.value.contactId
    ? cases.value.filter((item) => item.contactId === form.value.contactId)
    : cases.value
))
const contactOptions = computed(() => contacts.value.map((contact) => {
  const phone = contact.phoneE164 || contact.phoneRaw || ''
  return {
    ...contact,
    label: contact.displayName
      ? [contact.displayName, phone].filter(Boolean).join(' · ')
      : phone || t('contacts.unknown'),
  }
}))

function formatDate(value?: string | null) {
  if (!value) return t('tasks.noDueDate')
  const date = new Date(value)
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', {
    dateStyle: 'medium',
  }).format(date)
}

function openCreate() {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  form.value = {
    title: '',
    instructions: '',
    assigneeUid: authStore.user?.uid || members.value[0]?.uid || '',
    dueAt: tomorrow,
    contactId: null,
    caseId: null,
  }
  dialog.value = 'create'
}

function taskContactChanged(contactId: string | null) {
  if (!form.value.caseId) return
  const selectedCase = cases.value.find((item) => item.id === form.value.caseId)
  if (selectedCase && selectedCase.contactId !== contactId) form.value.caseId = null
}

function taskCaseChanged(caseId: string | null) {
  if (!caseId) return
  const selectedCase = cases.value.find((item) => item.id === caseId)
  if (selectedCase) form.value.contactId = selectedCase.contactId
}

async function submitCreate() {
  if (!form.value.title.trim() || !form.value.assigneeUid) return
  saving.value = true
  error.value = ''
  try {
    await createTask({
      title: form.value.title,
      instructions: form.value.instructions || undefined,
      assigneeUid: form.value.assigneeUid,
      dueAt: form.value.dueAt?.toISOString() || null,
      contactId: form.value.contactId,
      caseId: form.value.caseId,
    })
    dialog.value = null
    await load()
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
      ...(outcomeNote.value.trim() ? { note: outcomeNote.value } : {}),
    })
    selectedTask.value.status = outcome.value
    dialog.value = null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function reopen(task: TaskItem) {
  error.value = ''
  try {
    await transitionTask({ taskId: task.id, to: 'open' })
    task.status = 'open'
    taskScope.value = 'todo'
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function approve(approval: ActionApprovalItem) {
  processingApprovalId.value = approval.id
  error.value = ''
  try {
    await approveAction(approval.id)
    await load()
    view.value = 'approvals'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    processingApprovalId.value = ''
  }
}

async function reject(approval: ActionApprovalItem, note?: string) {
  processingApprovalId.value = approval.id
  error.value = ''
  try {
    await rejectAction(approval.id, note)
    await load()
    view.value = 'approvals'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    processingApprovalId.value = ''
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const personalUid = audience.value === 'mine' ? authStore.user?.uid : undefined
    const taskStatuses: TaskItem['status'][] = taskScope.value === 'todo'
      ? ['open']
      : ['completed', 'dismissed']
    const approvalStatuses: ActionApprovalItem['status'][] = approvalScope.value === 'waiting'
      ? ['pending', 'executing', 'execution_failed']
      : ['approved', 'rejected']
    const personalWaitingPromise = approvalScope.value === 'history' && authStore.user?.uid
      ? listActionApprovals({
          statuses: ['pending', 'executing', 'execution_failed'],
          approverUid: authStore.user.uid,
        })
      : Promise.resolve([] as ActionApprovalItem[])
    const [
      taskItems,
      approvalItems,
      personalWaitingItems,
      team,
      contactItems,
      caseItems,
    ] = await Promise.all([
      listTasks({
        statuses: taskStatuses,
        ...(personalUid ? { assigneeUid: personalUid } : {}),
      }),
      listActionApprovals({
        statuses: approvalStatuses,
        ...(personalUid ? { approverUid: personalUid } : {}),
      }),
      personalWaitingPromise,
      getTeamOverview(),
      listContacts(),
      listCases(),
    ])
    tasks.value = taskItems
    approvals.value = [...new Map(
      [...approvalItems, ...personalWaitingItems].map((approval) => [approval.id, approval]),
    ).values()]
    members.value = team.members
    contacts.value = contactItems
    cases.value = caseItems
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function setAudience(value: 'mine' | 'team') {
  if (audience.value === value) return
  audience.value = value
  await load()
}

async function selectScope(value: string) {
  if (view.value === 'tasks') taskScope.value = value as TaskWorkScope
  else approvalScope.value = value as ApprovalWorkScope
  await load()
}

onMounted(load)
</script>

<template>
  <section class="min-h-screen min-w-0">
    <header class="px-4 sm:px-6 h-16 flex items-center justify-between gap-4 border-b border-[var(--hairline)]">
      <div class="min-w-0">
        <div class="eyebrow !text-surface-500">{{ t('work.eyebrow') }}</div>
        <h1 class="m-0 text-base font-semibold">{{ t('work.title') }}</h1>
      </div>
      <div class="flex items-center gap-1">
        <Button icon="pi pi-refresh" severity="secondary" text :loading="loading" :aria-label="t('common.refresh')" @click="load" />
        <Button v-if="view === 'tasks'" :label="t('tasks.new')" icon="pi pi-plus" size="small" @click="openCreate" />
      </div>
    </header>

    <div class="px-4 sm:px-6 pt-3 flex items-center gap-2 border-b border-[var(--hairline)]">
      <button
        type="button"
        :class="[
          'h-10 px-3 border-b-2 text-sm font-medium cursor-pointer bg-transparent',
          view === 'tasks' ? 'border-indigo-600 text-surface-950' : 'border-transparent text-surface-500',
        ]"
        @click="view = 'tasks'"
      >
        {{ t('work.tasks') }}
      </button>
      <button
        type="button"
        :class="[
          'h-10 px-3 border-b-2 text-sm font-medium cursor-pointer bg-transparent',
          view === 'approvals' ? 'border-violet-600 text-violet-900' : 'border-transparent text-surface-500',
        ]"
        @click="view = 'approvals'"
      >
        {{ t('work.approvals') }}
        <span v-if="pendingApprovalCount" class="ml-1 min-w-5 h-5 px-1 rounded-full bg-violet-700 text-white text-[.65rem] inline-flex items-center justify-center">
          {{ pendingApprovalCount }}
        </span>
      </button>
    </div>

    <div class="px-4 sm:px-6 py-3 flex items-center justify-between gap-3 overflow-x-auto border-b border-[var(--hairline)]">
      <div class="flex items-center gap-2">
      <button
        v-for="item in (view === 'tasks'
          ? [{ value: 'todo', label: t('work.todo') }, { value: 'done', label: t('work.done') }]
          : [{ value: 'waiting', label: t('work.waiting') }, { value: 'history', label: t('work.history') }])"
        :key="item.value"
        type="button"
        :class="[
          'shrink-0 h-8 rounded-md border px-3 text-xs font-medium cursor-pointer',
          (view === 'tasks' ? taskScope : approvalScope) === item.value
            ? 'bg-surface-950 border-surface-950 text-white'
            : 'bg-white border-surface-200 text-surface-600',
        ]"
        @click="selectScope(item.value)"
      >
        {{ item.label }}
      </button>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <Button
          :label="t('work.mine')"
          size="small"
          :severity="audience === 'mine' ? undefined : 'secondary'"
          :outlined="audience !== 'mine'"
          @click="setAudience('mine')"
        />
        <Button
          :label="t('work.team')"
          size="small"
          :severity="audience === 'team' ? undefined : 'secondary'"
          :outlined="audience !== 'team'"
          @click="setAudience('team')"
        />
      </div>
    </div>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="p-4 sm:p-6 grid gap-2">
      <Skeleton v-for="index in 7" :key="index" height="6.5rem" />
    </div>

    <div v-else-if="view === 'approvals' && visibleApprovals.length" class="divide-y divide-[var(--hairline)]">
      <ApprovalCard
        v-for="approval in visibleApprovals"
        :key="approval.id"
        :approval="approval"
        :currentUid="authStore.user?.uid"
        :processing="processingApprovalId === approval.id"
        @approve="approve"
        @reject="reject"
      />
    </div>

    <div v-else-if="view === 'tasks' && visibleTasks.length" class="divide-y divide-[var(--hairline)]">
      <article
        v-for="task in visibleTasks"
        :key="task.id"
        class="min-w-0 grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 sm:gap-4 px-4 sm:px-6 py-4 bg-white/20 hover:bg-white/60 transition"
      >
        <span :class="[
          'mt-0.5 w-8 h-8 rounded-md flex items-center justify-center',
          task.status === 'completed'
            ? 'bg-emerald-50 text-emerald-700'
            : task.status === 'dismissed'
              ? 'bg-surface-100 text-surface-500'
                : isTaskOverdue(task)
                ? 'bg-rose-50 text-rose-700'
                : 'bg-indigo-50 text-indigo-700',
        ]">
          <i :class="task.status === 'completed' ? 'pi pi-check' : task.status === 'dismissed' ? 'pi pi-minus' : 'pi pi-clock'" />
        </span>
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <Tag v-if="isTaskOverdue(task)" :value="t('tasks.overdue')" severity="danger" />
            <span v-if="task.source?.kind === 'workflow'" class="eyebrow">{{ t('tasks.automatic') }}</span>
          </div>
          <h2 class="text-sm font-semibold leading-snug m-0 break-words">{{ task.title }}</h2>
          <p v-if="task.instructions" class="text-sm text-surface-600 leading-relaxed mt-1.5 mb-0 break-words">{{ task.instructions }}</p>
          <div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 font-mono text-[.64rem] text-surface-500">
            <span><i class="pi pi-user mr-1" />{{ task.assigneeName }}</span>
            <span :class="isTaskOverdue(task) ? 'text-rose-700' : ''"><i class="pi pi-calendar mr-1" />{{ formatDate(task.dueAt) }}</span>
            <router-link v-if="task.contactId" :to="`/contacts/${task.contactId}`" class="text-indigo-700 no-underline">
              {{ task.context?.contactName || task.context?.callerName || task.context?.contactPhone || task.context?.callerPhone || t('tasks.contact') }}
            </router-link>
            <router-link v-if="task.caseId" :to="`/cases/${task.caseId}`" class="text-indigo-700 no-underline">
              {{ cases.find((item) => item.id === task.caseId)?.title || t('tasks.fields.case') }}
            </router-link>
          </div>
          <details v-if="task.context?.callSummary || task.context?.transcriptExcerpt" class="mt-3">
            <summary class="cursor-pointer text-xs font-medium text-surface-600">{{ t('tasks.callContext') }}</summary>
            <p v-if="task.context.callSummary" class="text-sm leading-relaxed mt-2 mb-1">{{ task.context.callSummary }}</p>
            <p v-if="task.context.transcriptExcerpt" class="text-xs leading-relaxed text-surface-500 mt-1 mb-0">“{{ task.context.transcriptExcerpt }}”</p>
          </details>
          <p v-if="task.outcomeNote" class="text-xs text-surface-500 mt-2 mb-0">{{ task.outcomeNote }}</p>

          <div
            v-if="task.status === 'open'"
            class="mt-3 pt-3 border-t border-[var(--hairline)] flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2"
          >
            <Button
              :label="t('tasks.dismiss')"
              icon="pi pi-minus"
              size="small"
              severity="secondary"
              outlined
              class="w-full sm:w-auto"
              @click="openOutcome(task, 'dismissed')"
            />
            <Button
              :label="t('tasks.done')"
              icon="pi pi-check"
              size="small"
              class="w-full sm:w-auto"
              @click="openOutcome(task, 'completed')"
            />
          </div>
          <div
            v-else
            class="mt-3 pt-3 border-t border-[var(--hairline)] flex sm:justify-end"
          >
            <Button
              :label="t('tasks.reopen')"
              icon="pi pi-undo"
              size="small"
              severity="secondary"
              text
              class="w-full sm:w-auto"
              @click="reopen(task)"
            />
          </div>
        </div>
      </article>
    </div>

    <div v-else class="min-h-[calc(100vh-8rem)] flex items-center justify-center p-8">
      <div class="text-center max-w-sm">
        <span class="w-10 h-10 mx-auto mb-4 rounded-md bg-surface-900 text-white flex items-center justify-center">
          <i :class="view === 'tasks' ? 'pi pi-check-square' : 'pi pi-shield'" />
        </span>
        <h2 class="text-xl mt-0 mb-2">{{ view === 'tasks' ? t('tasks.emptyTitle') : t('approvals.emptyTitle') }}</h2>
        <p class="text-surface-500 leading-relaxed mt-0 mb-5">{{ view === 'tasks' ? t('tasks.emptyBody') : t('approvals.emptyBody') }}</p>
        <Button v-if="view === 'tasks' && taskScope === 'todo'" :label="t('tasks.new')" icon="pi pi-plus" @click="openCreate" />
      </div>
    </div>

    <Dialog
      :visible="dialog !== null"
      modal
      :header="dialog === 'create' ? t('tasks.new') : outcome === 'completed' ? t('tasks.completeTitle') : t('tasks.dismissTitle')"
      class="w-[min(34rem,calc(100vw-2rem))]"
      :close-button-props="{ severity: 'secondary', text: true, rounded: false }"
      @update:visible="(visible) => { if (!visible) dialog = null }"
    >
      <form v-if="dialog === 'create'" class="grid gap-4" @submit.prevent="submitCreate">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('tasks.fields.title') }}
          <InputText v-model="form.title" autofocus />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('tasks.fields.instructions') }}
          <Textarea v-model="form.instructions" rows="3" autoResize />
        </label>
        <div class="grid sm:grid-cols-2 gap-4">
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.assignee') }}
            <Select v-model="form.assigneeUid" :options="members" optionLabel="displayName" optionValue="uid" />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.due') }}
            <DatePicker v-model="form.dueAt" showIcon dateFormat="dd M yy" />
          </label>
        </div>
        <div class="grid sm:grid-cols-2 gap-4">
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.contact') }}
            <Select v-model="form.contactId" :options="contactOptions" optionLabel="label" optionValue="id" showClear filter @update:modelValue="taskContactChanged" />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.case') }}
            <Select v-model="form.caseId" :options="availableCases" optionLabel="title" optionValue="id" showClear @update:modelValue="taskCaseChanged" />
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="dialog = null" />
          <Button :label="t('tasks.create')" icon="pi pi-plus" type="submit" :loading="saving" :disabled="!form.title.trim() || !form.assigneeUid" />
        </div>
      </form>
      <form v-else class="grid gap-4" @submit.prevent="submitOutcome">
        <p class="text-sm text-surface-600 leading-relaxed m-0">{{ selectedTask?.title }}</p>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('tasks.fields.outcome') }}
          <Textarea v-model="outcomeNote" rows="3" autoResize :placeholder="t('tasks.outcomePlaceholder')" />
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="dialog = null" />
          <Button
            :label="outcome === 'completed' ? t('tasks.done') : t('tasks.dismiss')"
            type="submit"
            :severity="outcome === 'completed' ? undefined : 'secondary'"
            :loading="saving"
          />
        </div>
      </form>
    </Dialog>
  </section>
</template>
