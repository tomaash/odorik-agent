<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Skeleton from 'primevue/skeleton'
import Tag from 'primevue/tag'
import {
  cloneWorkflow,
  createCaseBlock,
  createIfBlock,
  createMailDraftBlock,
  createMoveCaseBlock,
  createTaskBlock,
  validateWorkflow,
  type ActionBlock,
  type ConditionField,
  type ConditionOperator,
  type CreateTaskBlock,
  type IfBlock,
  type WorkflowSpec,
} from '@agent-erik/workflow'
import WorkflowCaseBlock from '../components/WorkflowCaseBlock.vue'
import WorkflowMailBlock from '../components/WorkflowMailBlock.vue'
import WorkflowTaskBlock from '../components/WorkflowTaskBlock.vue'
import {
  dryRunWorkflow,
  enableWorkflow,
  getPipeline,
  getTeamOverview,
  listSources,
  getWorkflow,
  pauseWorkflow,
  saveWorkflow,
  type DryRunResult,
  type Pipeline,
  type TeamMember,
  type WorkflowDetails,
} from '../api/client'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { t, locale } = useI18n()
const workflowId = String(route.params.id)
const workflow = ref<WorkflowDetails | null>(null)
const spec = ref<WorkflowSpec | null>(null)
const members = ref<TeamMember[]>([])
const pipeline = ref<Pipeline | null>(null)
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const error = ref('')
const preview = ref<DryRunResult | null>(null)
const mailboxes = ref<Array<{ label: string; value: string }>>([])

const validation = computed(() => validateWorkflow(spec.value))
const missingTaskSubjects = computed(() => {
  if (!spec.value) return []
  return spec.value.blocks.flatMap((block) => {
    const actions = block.kind === 'control.if' ? [...block.then, ...block.else] : [block]
    return actions.filter((action) => (
      action.kind === 'action.task.create' && !action.task.subject
    ))
  })
})
const editorValid = computed(() => validation.value.valid && missingTaskSubjects.value.length === 0)
const status = computed(() => workflow.value?.status || 'draft')
const isEnabled = computed(() => status.value === 'enabled')
const activeStages = computed(() => pipeline.value?.stages.filter((stage) => !stage.archived) || [])
const booleanOptions = computed(() => [
  { label: t('workflows.condition.yes'), value: true },
  { label: t('workflows.condition.no'), value: false },
])
const fieldOptions = computed(() => [
  { label: t('workflows.condition.fields.duration'), value: 'call.durationSeconds' },
  { label: t('workflows.condition.fields.hasContact'), value: 'caller.hasContact' },
  { label: t('workflows.condition.fields.transcript'), value: 'transcript.text' },
])

function formatDate(value?: string | null) {
  if (!value) return t('workflows.noDueDate')
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', {
    dateStyle: 'medium',
  }).format(new Date(value))
}

function defaultAssignee() {
  if (spec.value) {
    for (const block of spec.value.blocks) {
      const actions = block.kind === 'control.if'
        ? [...block.then, ...block.else]
        : [block]
      for (const action of actions) {
        const member = action.kind === 'action.task.create'
          ? { uid: action.task.assigneeUid, name: action.task.assigneeName }
          : action.kind === 'action.case.create'
            ? { uid: action.case.ownerUid, name: action.case.ownerName }
            : { uid: action.approval.approverUid, name: action.approval.approverName }
        if (!member.uid) continue
        return {
          uid: member.uid,
          name: member.name,
        }
      }
    }
  }
  return {
    uid: members.value[0]?.uid || '',
    name: members.value[0]?.displayName || '',
  }
}

function newTask(): CreateTaskBlock {
  const assignee = defaultAssignee()
  return createTaskBlock({
    assigneeUid: assignee.uid,
    assigneeName: assignee.name,
  })
}

function defaultStages() {
  const stages = pipeline.value?.stages.filter((stage) => !stage.archived) || []
  const initial = stages.find((stage) => stage.id === pipeline.value?.initialStageId) || stages[0]
  const destination = stages.find((stage) => stage.id !== initial?.id) || initial
  return { initial, destination }
}

function newCreateCase(): ActionBlock {
  const owner = defaultAssignee()
  const { initial } = defaultStages()
  return createCaseBlock({
    ownerUid: owner.uid,
    ownerName: owner.name,
    pipelineId: pipeline.value?.id || 'default',
    stageId: initial?.id || '',
    stageName: initial?.name || '',
  })
}

function newMoveCase(): ActionBlock {
  const approver = defaultAssignee()
  const { initial, destination } = defaultStages()
  return createMoveCaseBlock({
    approverUid: approver.uid,
    approverName: approver.name,
    pipelineId: pipeline.value?.id || 'default',
    fromStageId: initial?.id || '',
    fromStageName: initial?.name || '',
    toStageId: destination?.id || '',
    toStageName: destination?.name || '',
  })
}

function newMailDraft(): ActionBlock {
  const approver = defaultAssignee()
  return createMailDraftBlock({
    approverUid: approver.uid,
    approverName: approver.name,
    connectionId: mailboxes.value[0]?.value || '',
  })
}

function addRootAction(kind: 'task' | 'case.create' | 'case.move' | 'mail.draft') {
  if (!spec.value) return
  const block = kind === 'task'
    ? newTask()
    : kind === 'case.create'
      ? newCreateCase()
      : kind === 'case.move'
        ? newMoveCase()
        : newMailDraft()
  spec.value.blocks.push(block)
}

function addIf() {
  if (!spec.value) return
  const assignee = defaultAssignee()
  spec.value.blocks.push(createIfBlock({
    assigneeUid: assignee.uid,
    assigneeName: assignee.name,
  }))
}

function moveItem<T>(items: T[], index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= items.length) return
  const [item] = items.splice(index, 1)
  if (item !== undefined) items.splice(target, 0, item)
}

function removeRoot(index: number) {
  spec.value?.blocks.splice(index, 1)
}

function branch(block: IfBlock, name: 'then' | 'else') {
  return block[name]
}

function addBranchAction(
  block: IfBlock,
  name: 'then' | 'else',
  kind: 'task' | 'case.create' | 'case.move',
) {
  branch(block, name).push(
    kind === 'task' ? newTask() : kind === 'case.create' ? newCreateCase() : newMoveCase(),
  )
}

function removeBranchTask(block: IfBlock, name: 'then' | 'else', index: number) {
  branch(block, name).splice(index, 1)
}

function moveBranchTask(block: IfBlock, name: 'then' | 'else', index: number, delta: number) {
  moveItem(branch(block, name), index, delta)
}

function changeConditionField(block: IfBlock, field: ConditionField) {
  block.condition.field = field
  if (field === 'call.durationSeconds') {
    block.condition.operator = 'gte'
    block.condition.value = 60
  } else if (field === 'caller.hasContact') {
    block.condition.operator = 'eq'
    block.condition.value = true
  } else {
    block.condition.operator = 'contains'
    block.condition.value = ''
  }
}

function operatorOptions(field: ConditionField) {
  const operators: ConditionOperator[] = field === 'call.durationSeconds'
    ? ['eq', 'gt', 'gte', 'lt', 'lte']
    : field === 'caller.hasContact'
      ? ['eq']
      : ['contains', 'eq']
  return operators.map((value) => ({
    value,
    label: t(`workflows.condition.operators.${value}`),
  }))
}

function conditionSummary(item: NonNullable<DryRunResult['results'][number]['conditions']>[number]) {
  const field = t(`workflows.condition.fields.${
    item.field === 'call.durationSeconds'
      ? 'duration'
      : item.field === 'caller.hasContact'
        ? 'hasContact'
        : 'transcript'
  }`)
  const branchLabel = item.branch === 'then' ? t('workflows.then') : t('workflows.else')
  return `${field}: ${branchLabel}`
}

function actionTitle(action: NonNullable<DryRunResult['results'][number]['actions']>[number]) {
  if (action.kind === 'case.move') return action.caseTitle
  if (action.kind === 'mail.draft.create') return action.subject
  return action.title
}

function actionDetail(action: NonNullable<DryRunResult['results'][number]['actions']>[number]) {
  if (action.kind === 'task.create') {
    const subject = action.subject?.kind === 'matching_case'
      ? action.caseTitle || action.subject.stageName
      : t(`workflows.taskSubject.${action.subject?.kind || 'contact'}`)
    return `${action.assigneeName} · ${subject} · ${formatDate(action.dueAt)}`
  }
  if (action.kind === 'case.create') return `${action.ownerName} · ${action.stageName}`
  if (action.kind === 'mail.draft.create') {
    return `${action.mailboxAddress} → ${action.to.join(', ')}`
  }
  return `${action.fromStageName} → ${action.toStageName}`
}

function skipDetail(skip: NonNullable<DryRunResult['results'][number]['skippedActions']>[number]) {
  return t(`workflows.skipReason.${skip.reason}`, { count: skip.matches })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [details, team, pipelineData, sources] = await Promise.all([
      getWorkflow(workflowId),
      getTeamOverview(),
      getPipeline(),
      listSources(),
    ])
    workflow.value = details
    members.value = team.members
    pipeline.value = pipelineData
    // Only mailboxes that could actually draft today are offered, so a workflow
    // cannot be authored against a connection that would always skip.
    mailboxes.value = sources.connections
      .filter((connection) => (
        connection.connectorId === 'google_workspace'
        && connection.status !== 'disconnected'
        && connection.capabilities.some((capability) => (
          capability.capabilityId === 'context.mail.read_scoped'
          && capability.status === 'active'
        ))
      ))
      .map((connection) => ({
        label: connection.accountLabel || connection.displayName,
        value: connection.id,
      }))
    spec.value = details.draft ? cloneWorkflow(details.draft) : null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function save(showToast = true) {
  if (!spec.value || !editorValid.value) return false
  saving.value = true
  error.value = ''
  try {
    await saveWorkflow(workflowId, spec.value)
    if (showToast) toast.add({ severity: 'success', summary: t('workflows.saved'), life: 2200 })
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    saving.value = false
  }
}

async function turnOn() {
  if (!await save(false)) return
  saving.value = true
  error.value = ''
  try {
    const result = await enableWorkflow(workflowId)
    if (workflow.value) {
      workflow.value.status = 'enabled'
      workflow.value.deployedVersion = result.version
    }
    toast.add({ severity: 'success', summary: t('workflows.turnedOn'), life: 2600 })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function pause() {
  saving.value = true
  error.value = ''
  try {
    await pauseWorkflow(workflowId)
    if (workflow.value) workflow.value.status = 'paused'
    toast.add({ severity: 'success', summary: t('workflows.paused'), life: 2200 })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function tryHistory() {
  if (!spec.value || !editorValid.value) return
  testing.value = true
  error.value = ''
  try {
    preview.value = await dryRunWorkflow(workflowId, spec.value, 20)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="min-h-screen min-w-0">
    <header class="sticky top-14 md:top-0 z-20 min-h-16 px-3 sm:px-5 py-2 flex items-center gap-2 bg-[rgba(250,249,246,.96)] backdrop-blur border-b border-[var(--hairline)]">
      <Button icon="pi pi-arrow-left" severity="secondary" text :aria-label="t('common.cancel')" @click="router.push('/workflows')" />
      <div class="min-w-0 flex-1">
        <strong class="block text-sm truncate">{{ spec?.name || workflow?.name || t('workflows.title') }}</strong>
        <span class="font-mono text-[.62rem] text-surface-500">{{ t(`workflows.status.${status}`) }}</span>
      </div>
      <Tag v-if="workflow?.deployedVersion" :value="`v${workflow.deployedVersion}`" :severity="isEnabled ? 'success' : 'secondary'" />
      <Button :label="t('workflows.dryRun')" icon="pi pi-history" severity="secondary" outlined class="hidden sm:inline-flex" :loading="testing" :disabled="!editorValid" @click="tryHistory" />
      <Button :label="t('workflows.save')" severity="secondary" outlined class="hidden sm:inline-flex" :loading="saving" :disabled="!editorValid" @click="save()" />
      <Button v-if="isEnabled" :label="t('workflows.pause')" icon="pi pi-pause" severity="secondary" :loading="saving" @click="pause" />
      <Button v-else :label="t('workflows.turnOn')" icon="pi pi-play" :disabled="!editorValid || !spec" :loading="saving" @click="turnOn" />
    </header>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="max-w-5xl mx-auto p-4 sm:p-8 grid gap-4">
      <Skeleton height="5rem" />
      <Skeleton height="36rem" />
    </div>

    <div v-else-if="workflow?.legacy" class="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div class="max-w-lg text-center">
        <span class="w-11 h-11 rounded-md bg-amber-100 text-amber-800 mx-auto mb-4 flex items-center justify-center"><i class="pi pi-archive" /></span>
        <h1 class="text-2xl mt-0 mb-2">{{ t('workflows.legacyTitle') }}</h1>
        <p class="text-surface-600 leading-relaxed mt-0 mb-5">{{ workflow.warning }}</p>
        <Button :label="t('workflows.back')" icon="pi pi-arrow-left" severity="secondary" outlined @click="router.push('/workflows')" />
      </div>
    </div>

    <main v-else-if="spec" class="app-gradient min-h-[calc(100vh-4rem)] px-3 py-5 sm:p-8 pb-40 sm:pb-8">
      <div class="max-w-5xl mx-auto grid lg:grid-cols-[minmax(0,1fr)_20rem] gap-5 items-start">
        <section class="hairline-card bg-white/80 overflow-hidden">
          <div class="p-4 sm:p-6 border-b border-[var(--hairline)]">
            <div class="eyebrow !text-indigo-700 mb-2">{{ t('workflows.language') }}</div>
            <h1 class="text-2xl sm:text-3xl tracking-[-.03em] mt-0 mb-2">{{ t('workflows.languageTitle') }}</h1>
            <p class="text-surface-600 leading-relaxed m-0">{{ t('workflows.languageBody') }}</p>
          </div>

          <div class="p-3 sm:p-6 grid gap-4">
            <label class="grid gap-1.5 text-sm font-medium">
              {{ t('workflows.fields.name') }}
              <InputText v-model="spec.name" />
            </label>

            <section class="rounded-lg border border-indigo-300 bg-indigo-50/80 shadow-sm overflow-hidden">
              <header class="px-3 py-2.5 flex items-center gap-2 border-b border-indigo-200">
                <span class="w-8 h-8 rounded-md bg-[#142455] text-white flex items-center justify-center"><i class="pi pi-phone" /></span>
                <div>
                  <span class="eyebrow !text-indigo-800">{{ t('workflows.when') }}</span>
                  <strong class="block text-sm">{{ t('workflows.callTranscribed') }}</strong>
                </div>
              </header>
              <p class="text-xs text-surface-600 leading-relaxed px-3 py-2.5 m-0">{{ t('workflows.callContextAutomatic') }}</p>
            </section>

            <div class="flex items-center gap-3 px-2">
              <span class="h-7 border-l-2 border-dashed border-surface-300" />
              <span class="eyebrow !text-surface-500">{{ t('workflows.then') }}</span>
            </div>

            <template v-for="(block, index) in spec.blocks" :key="block.id">
              <WorkflowTaskBlock
                v-if="block.kind === 'action.task.create' && pipeline"
                :block="block"
                :members="members"
                :pipeline="pipeline"
                :canMoveUp="index > 0"
                :canMoveDown="index < spec.blocks.length - 1"
                @moveUp="moveItem(spec.blocks, index, -1)"
                @moveDown="moveItem(spec.blocks, index, 1)"
                @remove="removeRoot(index)"
              />

              <WorkflowCaseBlock
                v-else-if="pipeline && (block.kind === 'action.case.create' || block.kind === 'action.case.move')"
                :block="block"
                :members="members"
                :pipeline="pipeline"
                :canMoveUp="index > 0"
                :canMoveDown="index < spec.blocks.length - 1"
                @moveUp="moveItem(spec.blocks, index, -1)"
                @moveDown="moveItem(spec.blocks, index, 1)"
                @remove="removeRoot(index)"
              />

              <WorkflowMailBlock
                v-else-if="block.kind === 'action.mail.draft.create'"
                :block="block"
                :members="members"
                :mailboxes="mailboxes"
                :canMoveUp="index > 0"
                :canMoveDown="index < spec.blocks.length - 1"
                @moveUp="moveItem(spec.blocks, index, -1)"
                @moveDown="moveItem(spec.blocks, index, 1)"
                @remove="removeRoot(index)"
              />

              <section v-else-if="block.kind === 'control.if'" class="rounded-lg border-2 border-amber-300 bg-amber-50/80 shadow-sm overflow-hidden">
                <header class="px-3 py-2.5 flex items-center gap-2 border-b border-amber-300 bg-amber-100/60">
                  <span class="w-8 h-8 shrink-0 rounded-md bg-amber-700 text-white flex items-center justify-center"><i class="pi pi-code" /></span>
                  <div class="min-w-0 flex-1">
                    <span class="eyebrow !text-amber-900">{{ t('workflows.ifBlock') }}</span>
                    <strong class="block text-sm">{{ t('workflows.condition.title') }}</strong>
                  </div>
                  <div class="flex items-center">
                    <Button icon="pi pi-arrow-up" severity="secondary" text size="small" :disabled="index === 0" :aria-label="t('workflows.moveUp')" @click="moveItem(spec.blocks, index, -1)" />
                    <Button icon="pi pi-arrow-down" severity="secondary" text size="small" :disabled="index === spec.blocks.length - 1" :aria-label="t('workflows.moveDown')" @click="moveItem(spec.blocks, index, 1)" />
                    <Button icon="pi pi-trash" severity="danger" text size="small" :aria-label="t('workflows.removeBlock')" @click="removeRoot(index)" />
                  </div>
                </header>

                <div class="p-3 sm:p-4 grid gap-4">
                  <div class="grid sm:grid-cols-[1.35fr_1fr_1fr] gap-2">
                    <label class="grid gap-1.5 text-xs font-medium">
                      {{ t('workflows.fields.conditionField') }}
                      <Select
                        :modelValue="block.condition.field"
                        :options="fieldOptions"
                        optionLabel="label"
                        optionValue="value"
                        @update:modelValue="changeConditionField(block, $event as ConditionField)"
                      />
                    </label>
                    <label class="grid gap-1.5 text-xs font-medium">
                      {{ t('workflows.fields.operator') }}
                      <Select
                        v-model="block.condition.operator"
                        :options="operatorOptions(block.condition.field)"
                        optionLabel="label"
                        optionValue="value"
                      />
                    </label>
                    <label class="grid gap-1.5 text-xs font-medium">
                      {{ t('workflows.fields.value') }}
                      <InputNumber
                        v-if="block.condition.field === 'call.durationSeconds'"
                        :modelValue="Number(block.condition.value)"
                        :min="0"
                        suffix=" s"
                        @update:modelValue="block.condition.value = $event ?? 0"
                      />
                      <Select
                        v-else-if="block.condition.field === 'caller.hasContact'"
                        v-model="block.condition.value"
                        :options="booleanOptions"
                        optionLabel="label"
                        optionValue="value"
                      />
                      <InputText
                        v-else
                        :modelValue="String(block.condition.value)"
                        @update:modelValue="block.condition.value = String($event)"
                      />
                    </label>
                  </div>

                  <section class="rounded-lg border border-emerald-200 bg-emerald-100/40 p-2.5 sm:p-3 grid gap-2.5">
                    <div class="flex items-center justify-between gap-2">
                      <strong class="text-xs uppercase tracking-[.16em] text-emerald-900">{{ t('workflows.then') }}</strong>
                      <div class="flex flex-wrap justify-end">
                        <Button :label="t('workflows.addTaskBlock')" icon="pi pi-plus" size="small" severity="success" text @click="addBranchAction(block, 'then', 'task')" />
                        <Button :label="t('workflows.addCaseBlock')" icon="pi pi-plus" size="small" severity="success" text @click="addBranchAction(block, 'then', 'case.create')" />
                        <Button :label="t('workflows.addMoveCaseBlock')" icon="pi pi-plus" size="small" severity="success" text @click="addBranchAction(block, 'then', 'case.move')" />
                      </div>
                    </div>
                    <p v-if="block.then.length === 0" class="text-xs text-surface-500 m-0 px-1">{{ t('workflows.branchEmpty') }}</p>
                    <template v-for="(action, actionIndex) in block.then" :key="action.id">
                      <WorkflowTaskBlock
                        v-if="action.kind === 'action.task.create' && pipeline"
                        compact
                        :block="action"
                        :members="members"
                        :pipeline="pipeline"
                        :canMoveUp="actionIndex > 0"
                        :canMoveDown="actionIndex < block.then.length - 1"
                        @moveUp="moveBranchTask(block, 'then', actionIndex, -1)"
                        @moveDown="moveBranchTask(block, 'then', actionIndex, 1)"
                        @remove="removeBranchTask(block, 'then', actionIndex)"
                      />
                      <WorkflowCaseBlock
                        v-else-if="pipeline && (action.kind === 'action.case.create' || action.kind === 'action.case.move')"
                        compact
                        :block="action"
                        :members="members"
                        :pipeline="pipeline"
                        :canMoveUp="actionIndex > 0"
                        :canMoveDown="actionIndex < block.then.length - 1"
                        @moveUp="moveBranchTask(block, 'then', actionIndex, -1)"
                        @moveDown="moveBranchTask(block, 'then', actionIndex, 1)"
                        @remove="removeBranchTask(block, 'then', actionIndex)"
                      />
                    </template>
                  </section>

                  <section class="rounded-lg border border-surface-300 bg-surface-100/60 p-2.5 sm:p-3 grid gap-2.5">
                    <div class="flex items-center justify-between gap-2">
                      <strong class="text-xs uppercase tracking-[.16em] text-surface-700">{{ t('workflows.else') }}</strong>
                      <div class="flex flex-wrap justify-end">
                        <Button :label="t('workflows.addTaskBlock')" icon="pi pi-plus" size="small" severity="secondary" text @click="addBranchAction(block, 'else', 'task')" />
                        <Button :label="t('workflows.addCaseBlock')" icon="pi pi-plus" size="small" severity="secondary" text @click="addBranchAction(block, 'else', 'case.create')" />
                        <Button :label="t('workflows.addMoveCaseBlock')" icon="pi pi-plus" size="small" severity="secondary" text @click="addBranchAction(block, 'else', 'case.move')" />
                      </div>
                    </div>
                    <p v-if="block.else.length === 0" class="text-xs text-surface-500 m-0 px-1">{{ t('workflows.branchEmpty') }}</p>
                    <template v-for="(action, actionIndex) in block.else" :key="action.id">
                      <WorkflowTaskBlock
                        v-if="action.kind === 'action.task.create' && pipeline"
                        compact
                        :block="action"
                        :members="members"
                        :pipeline="pipeline"
                        :canMoveUp="actionIndex > 0"
                        :canMoveDown="actionIndex < block.else.length - 1"
                        @moveUp="moveBranchTask(block, 'else', actionIndex, -1)"
                        @moveDown="moveBranchTask(block, 'else', actionIndex, 1)"
                        @remove="removeBranchTask(block, 'else', actionIndex)"
                      />
                      <WorkflowCaseBlock
                        v-else-if="pipeline && (action.kind === 'action.case.create' || action.kind === 'action.case.move')"
                        compact
                        :block="action"
                        :members="members"
                        :pipeline="pipeline"
                        :canMoveUp="actionIndex > 0"
                        :canMoveDown="actionIndex < block.else.length - 1"
                        @moveUp="moveBranchTask(block, 'else', actionIndex, -1)"
                        @moveDown="moveBranchTask(block, 'else', actionIndex, 1)"
                        @remove="removeBranchTask(block, 'else', actionIndex)"
                      />
                    </template>
                  </section>
                </div>
              </section>
            </template>

            <section v-if="spec.blocks.length === 0" class="rounded-lg border-2 border-dashed border-surface-300 p-6 text-center">
              <strong class="block text-sm">{{ t('workflows.noBlocksTitle') }}</strong>
              <p class="text-xs text-surface-500 mt-1 mb-0">{{ t('workflows.noBlocksBody') }}</p>
            </section>

            <section class="rounded-lg border border-dashed border-indigo-300 bg-white/70 p-3">
              <div class="eyebrow !text-indigo-700 mb-2">{{ t('workflows.addBlock') }}</div>
              <div class="grid sm:grid-cols-2 gap-2">
                <Button :label="t('workflows.addTaskBlock')" icon="pi pi-check-square" severity="success" outlined @click="addRootAction('task')" />
                <Button :label="t('workflows.addCaseBlock')" icon="pi pi-folder-plus" severity="success" outlined :disabled="!pipeline" @click="addRootAction('case.create')" />
                <Button :label="t('workflows.addMoveCaseBlock')" icon="pi pi-arrow-right-arrow-left" severity="success" outlined :disabled="!pipeline || activeStages?.length < 2" @click="addRootAction('case.move')" />
                <Button :label="t('workflows.addMailDraftBlock')" icon="pi pi-envelope" severity="success" outlined :disabled="!mailboxes.length" @click="addRootAction('mail.draft')" />
                <Button :label="t('workflows.addIfBlock')" icon="pi pi-code" severity="warn" outlined @click="addIf" />
              </div>
            </section>

            <Message severity="info" :closable="false">
              {{ t('workflows.authorization') }}
            </Message>
          </div>
        </section>

        <aside class="grid gap-4 lg:sticky lg:top-20">
          <section class="hairline-card bg-white/80 p-4">
            <div class="flex items-center justify-between gap-2 mb-3">
              <div class="eyebrow !text-surface-500">{{ t('workflows.validation') }}</div>
              <Tag :value="editorValid ? t('workflows.ready') : `${validation.errors.length + validation.holes.length + missingTaskSubjects.length}`" :severity="editorValid ? 'success' : 'warn'" />
            </div>
            <div v-if="!editorValid" class="grid gap-2">
              <p v-if="missingTaskSubjects.length" class="text-xs leading-relaxed rounded bg-amber-50 border border-amber-200 p-2 m-0">
                {{ t('workflows.taskSubjectHelp.required') }}
              </p>
              <p v-for="item in [...validation.holes, ...validation.errors]" :key="`${item.code}-${item.path}`" class="text-xs leading-relaxed rounded bg-amber-50 border border-amber-200 p-2 m-0">
                {{ item.message }}
              </p>
            </div>
            <p v-else class="text-sm text-surface-500 leading-relaxed m-0">{{ t('workflows.readyBody') }}</p>
          </section>

          <section class="hairline-card bg-white/80 p-4">
            <div class="eyebrow !text-surface-500 mb-3">{{ t('workflows.historyPreview') }}</div>
            <template v-if="preview">
              <strong class="text-sm">{{ t('workflows.wouldRequest', { count: preview.wouldRequest, matched: preview.matchedCalls, total: preview.sampleSize }) }}</strong>
              <p v-if="preview.skipped" class="text-xs text-surface-500 mt-1 mb-0">{{ t('workflows.skippedCalls', { count: preview.skipped }) }}</p>
              <div class="grid gap-2 mt-3">
                <article v-for="item in preview.results.slice(0, 4)" :key="item.callId" class="rounded border border-surface-200 p-2.5">
                  <template v-if="item.actions?.length">
                    <div v-for="action in item.actions" :key="action.blockId" class="not-last:mb-2">
                      <strong class="block text-xs leading-snug">{{ actionTitle(action) }}</strong>
                      <span class="font-mono text-[.6rem] text-surface-500 mt-1 block">{{ actionDetail(action) }}</span>
                      <span class="font-mono text-[.6rem] text-violet-700 mt-1 block"><i class="pi pi-shield mr-1" />{{ action.approverName }}</span>
                    </div>
                  </template>
                  <span v-else-if="item.error" class="text-xs text-rose-700">{{ item.error }}</span>
                  <span v-else-if="!item.skippedActions?.length" class="text-xs text-surface-500">{{ t('workflows.noTaskForCall') }}</span>
                  <div v-if="item.skippedActions?.length" class="grid gap-1.5 mt-2">
                    <p v-for="skip in item.skippedActions" :key="skip.blockId" class="text-xs text-amber-800 bg-amber-50 rounded p-2 m-0">
                      <i class="pi pi-info-circle mr-1" />{{ skipDetail(skip) }}
                    </p>
                  </div>
                  <div v-if="item.conditions?.length" class="flex flex-wrap gap-1 mt-2">
                    <Tag v-for="condition in item.conditions" :key="condition.blockId" :value="conditionSummary(condition)" :severity="condition.result ? 'success' : 'secondary'" />
                  </div>
                </article>
              </div>
            </template>
            <p v-else class="text-sm text-surface-500 leading-relaxed mt-0">{{ t('workflows.historyBody') }}</p>
            <Button :label="t('workflows.dryRun')" icon="pi pi-history" severity="secondary" outlined size="small" class="mt-3 w-full" :loading="testing" :disabled="!editorValid" @click="tryHistory" />
          </section>
        </aside>
      </div>
    </main>

    <div v-if="spec && !workflow?.legacy" class="sm:hidden fixed left-3 right-3 bottom-[4.75rem] z-20 grid grid-cols-2 gap-2">
      <Button :label="t('workflows.dryRun')" icon="pi pi-history" severity="secondary" outlined class="bg-white" :loading="testing" :disabled="!editorValid" @click="tryHistory" />
      <Button :label="t('workflows.save')" severity="secondary" outlined class="bg-white" :loading="saving" :disabled="!editorValid" @click="save()" />
    </div>
  </section>
</template>
  getPipeline,
