<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
import {
  approveAction,
  createTask,
  getTeamOverview,
  listActionApprovals,
  listContacts,
  listDeals,
  listTasks,
  rejectAction,
  transitionTask,
  type ActionApprovalItem,
  type ContactListItem,
  type DealItem,
  type TaskItem,
  type TaskStatus,
  type TeamMember,
} from '../api/client'
import { isTaskOverdue, sortedTasks, taskStatusCounts } from '../task-model'

const { t, locale } = useI18n()
const authStore = useAuthStore()
const tasks = ref<TaskItem[]>([])
const approvals = ref<ActionApprovalItem[]>([])
const members = ref<TeamMember[]>([])
const contacts = ref<ContactListItem[]>([])
const deals = ref<DealItem[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const scope = ref<TaskStatus>('open')
const view = ref<'tasks' | 'approvals'>('tasks')
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
  dealId: null as string | null,
})

const visibleTasks = computed(() => sortedTasks(tasks.value, scope.value))
const counts = computed(() => taskStatusCounts(tasks.value))
const pendingApprovalCount = computed(() => approvals.value.filter((approval) => (
  approval.status === 'pending' && approval.approverUid === authStore.user?.uid
)).length)
const availableDeals = computed(() => (
  form.value.contactId
    ? deals.value.filter((deal) => deal.contactId === form.value.contactId)
    : deals.value
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

function approvalSeverity(status: ActionApprovalItem['status']) {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'execution_failed') return 'warn'
  if (status === 'executing') return 'info'
  return 'secondary'
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
    dealId: null,
  }
  dialog.value = 'create'
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
      dealId: form.value.dealId,
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
    scope.value = 'open'
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

async function reject(approval: ActionApprovalItem) {
  processingApprovalId.value = approval.id
  error.value = ''
  try {
    await rejectAction(approval.id)
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
    const [taskItems, approvalItems, team, contactItems, dealItems] = await Promise.all([
      listTasks(),
      listActionApprovals(),
      getTeamOverview(),
      listContacts(),
      listDeals(),
    ])
    tasks.value = taskItems
    approvals.value = approvalItems
    members.value = team.members
    contacts.value = contactItems
    deals.value = dealItems
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="min-h-screen min-w-0">
    <header class="px-4 sm:px-6 h-16 flex items-center justify-between gap-4 border-b border-[var(--hairline)]">
      <div class="min-w-0">
        <div class="eyebrow !text-surface-500">{{ t('tasks.eyebrow') }}</div>
        <h1 class="m-0 text-base font-semibold">{{ t('tasks.title') }}</h1>
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
        {{ t('tasks.title') }}
      </button>
      <button
        type="button"
        :class="[
          'h-10 px-3 border-b-2 text-sm font-medium cursor-pointer bg-transparent',
          view === 'approvals' ? 'border-violet-600 text-violet-900' : 'border-transparent text-surface-500',
        ]"
        @click="view = 'approvals'"
      >
        {{ t('approvals.title') }}
        <span v-if="pendingApprovalCount" class="ml-1 min-w-5 h-5 px-1 rounded-full bg-violet-700 text-white text-[.65rem] inline-flex items-center justify-center">
          {{ pendingApprovalCount }}
        </span>
      </button>
    </div>

    <div v-if="view === 'tasks'" class="px-4 sm:px-6 py-3 flex items-center gap-2 overflow-x-auto border-b border-[var(--hairline)]">
      <button
        v-for="status in (['open', 'completed', 'dismissed'] as TaskStatus[])"
        :key="status"
        type="button"
        :class="[
          'shrink-0 h-8 rounded-md border px-3 text-xs font-medium cursor-pointer',
          scope === status
            ? 'bg-surface-950 border-surface-950 text-white'
            : 'bg-white border-surface-200 text-surface-600',
        ]"
        @click="scope = status"
      >
        {{ t(`tasks.status.${status}`) }}
        <span class="ml-1 opacity-60">{{ counts[status] }}</span>
      </button>
    </div>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="p-4 sm:p-6 grid gap-2">
      <Skeleton v-for="index in 7" :key="index" height="6.5rem" />
    </div>

    <div v-else-if="view === 'approvals' && approvals.length" class="divide-y divide-[var(--hairline)]">
      <article
        v-for="approval in approvals"
        :key="approval.id"
        class="min-w-0 grid grid-cols-[2.5rem_minmax(0,1fr)] sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-3 sm:gap-4 px-4 sm:px-6 py-4 bg-violet-50/20"
      >
        <span class="mt-0.5 w-8 h-8 rounded-md bg-violet-100 text-violet-800 flex items-center justify-center">
          <i class="pi pi-shield" />
        </span>
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1.5">
            <Tag :value="t(`approvals.status.${approval.status}`)" :severity="approvalSeverity(approval.status)" />
            <span class="eyebrow !text-violet-700">{{ t('approvals.taskAction') }}</span>
          </div>
          <h2 class="text-sm font-semibold leading-snug m-0 break-words">{{ approval.action.title }}</h2>
          <p v-if="approval.action.instructions" class="text-sm text-surface-600 leading-relaxed mt-1.5 mb-0 break-words">{{ approval.action.instructions }}</p>
          <div class="mt-3 rounded-md border border-violet-200 bg-white/80 p-3 grid gap-1.5 text-xs">
            <strong class="text-violet-950">{{ t('approvals.exactEffect') }}</strong>
            <span>{{ t('approvals.createTaskFor', { assignee: approval.action.assigneeName }) }}</span>
            <span><i class="pi pi-calendar mr-1" />{{ formatDate(approval.action.dueAt) }}</span>
            <span><i class="pi pi-user-edit mr-1" />{{ t('approvals.approver', { approver: approval.approverName }) }}</span>
          </div>
          <details v-if="approval.action.context?.callSummary || approval.action.context?.transcriptExcerpt" class="mt-3">
            <summary class="cursor-pointer text-xs font-medium text-surface-600">{{ t('tasks.callContext') }}</summary>
            <p v-if="approval.action.context.callSummary" class="text-sm leading-relaxed mt-2 mb-1">{{ approval.action.context.callSummary }}</p>
            <p v-if="approval.action.context.transcriptExcerpt" class="text-xs leading-relaxed text-surface-500 mt-1 mb-0">“{{ approval.action.context.transcriptExcerpt }}”</p>
          </details>
          <p v-if="approval.executionError" class="text-xs text-amber-800 mt-2 mb-0">{{ approval.executionError }}</p>
          <p class="font-mono text-[.58rem] text-surface-400 mt-2 mb-0">{{ t('approvals.effectId') }} {{ approval.effectDigest.slice(0, 12) }}</p>
        </div>
        <div class="col-start-2 sm:col-start-auto flex items-center gap-1 self-center">
          <template v-if="(approval.status === 'pending' || approval.status === 'execution_failed') && approval.approverUid === authStore.user?.uid">
            <Button
              :label="approval.status === 'execution_failed' ? t('approvals.retry') : t('approvals.approve')"
              icon="pi pi-check"
              size="small"
              severity="success"
              :loading="processingApprovalId === approval.id"
              @click="approve(approval)"
            />
            <Button
              v-if="approval.status === 'pending'"
              :label="t('approvals.reject')"
              icon="pi pi-times"
              size="small"
              severity="danger"
              outlined
              :disabled="Boolean(processingApprovalId)"
              @click="reject(approval)"
            />
          </template>
          <span v-else-if="approval.status === 'pending'" class="text-xs text-surface-500">{{ t('approvals.waitingFor', { approver: approval.approverName }) }}</span>
        </div>
      </article>
    </div>

    <div v-else-if="view === 'tasks' && visibleTasks.length" class="divide-y divide-[var(--hairline)]">
      <article
        v-for="task in visibleTasks"
        :key="task.id"
        class="min-w-0 grid grid-cols-[2.5rem_minmax(0,1fr)] sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-3 sm:gap-4 px-4 sm:px-6 py-4 bg-white/20 hover:bg-white/60 transition"
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
          </div>
          <details v-if="task.context?.callSummary || task.context?.transcriptExcerpt" class="mt-3">
            <summary class="cursor-pointer text-xs font-medium text-surface-600">{{ t('tasks.callContext') }}</summary>
            <p v-if="task.context.callSummary" class="text-sm leading-relaxed mt-2 mb-1">{{ task.context.callSummary }}</p>
            <p v-if="task.context.transcriptExcerpt" class="text-xs leading-relaxed text-surface-500 mt-1 mb-0">“{{ task.context.transcriptExcerpt }}”</p>
          </details>
          <p v-if="task.outcomeNote" class="text-xs text-surface-500 mt-2 mb-0">{{ task.outcomeNote }}</p>
        </div>
        <div class="col-start-2 sm:col-start-auto flex items-center gap-1 self-center">
          <template v-if="task.status === 'open'">
            <Button :label="t('tasks.done')" icon="pi pi-check" size="small" severity="success" outlined @click="openOutcome(task, 'completed')" />
            <Button icon="pi pi-minus" size="small" severity="secondary" text :aria-label="t('tasks.dismiss')" @click="openOutcome(task, 'dismissed')" />
          </template>
          <Button v-else :label="t('tasks.reopen')" icon="pi pi-undo" size="small" severity="secondary" text @click="reopen(task)" />
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
        <Button v-if="view === 'tasks' && scope === 'open'" :label="t('tasks.new')" icon="pi pi-plus" @click="openCreate" />
      </div>
    </div>

    <Dialog
      :visible="dialog !== null"
      modal
      :header="dialog === 'create' ? t('tasks.new') : outcome === 'completed' ? t('tasks.completeTitle') : t('tasks.dismissTitle')"
      class="w-[min(34rem,calc(100vw-2rem))]"
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
            <Select v-model="form.contactId" :options="contactOptions" optionLabel="label" optionValue="id" showClear filter />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('tasks.fields.deal') }}
            <Select v-model="form.dealId" :options="availableDeals" optionLabel="title" optionValue="id" showClear />
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
        <div class="flex justify-end gap-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="dialog = null" />
          <Button :label="outcome === 'completed' ? t('tasks.done') : t('tasks.dismiss')" type="submit" :severity="outcome === 'completed' ? 'success' : 'secondary'" :loading="saving" />
        </div>
      </form>
    </Dialog>
  </section>
</template>
