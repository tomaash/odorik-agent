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
  createIfBlock,
  createTaskBlock,
  validateWorkflow,
  type ConditionField,
  type ConditionOperator,
  type CreateTaskBlock,
  type IfBlock,
  type WorkflowSpec,
} from '@agent-erik/workflow'
import WorkflowTaskBlock from '../components/WorkflowTaskBlock.vue'
import {
  dryRunWorkflow,
  enableWorkflow,
  getTeamOverview,
  getWorkflow,
  pauseWorkflow,
  saveWorkflow,
  type DryRunResult,
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
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const error = ref('')
const preview = ref<DryRunResult | null>(null)

const validation = computed(() => validateWorkflow(spec.value))
const status = computed(() => workflow.value?.status || 'draft')
const isEnabled = computed(() => status.value === 'enabled')
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
      const task = block.kind === 'action.task.create'
        ? block
        : block.then[0] || block.else[0]
      if (task?.task.assigneeUid) {
        return {
          uid: task.task.assigneeUid,
          name: task.task.assigneeName,
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

function addRootTask() {
  spec.value?.blocks.push(newTask())
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

function addBranchTask(block: IfBlock, name: 'then' | 'else') {
  branch(block, name).push(newTask())
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

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [details, team] = await Promise.all([
      getWorkflow(workflowId),
      getTeamOverview(),
    ])
    workflow.value = details
    members.value = team.members
    spec.value = details.draft ? cloneWorkflow(details.draft) : null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function save(showToast = true) {
  if (!spec.value || !validation.value.valid) return false
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
  if (!spec.value || !validation.value.valid) return
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
      <Button :label="t('workflows.dryRun')" icon="pi pi-history" severity="secondary" outlined class="hidden sm:inline-flex" :loading="testing" :disabled="!validation.valid" @click="tryHistory" />
      <Button :label="t('workflows.save')" severity="secondary" outlined class="hidden sm:inline-flex" :loading="saving" :disabled="!validation.valid" @click="save()" />
      <Button v-if="isEnabled" :label="t('workflows.pause')" icon="pi pi-pause" severity="secondary" :loading="saving" @click="pause" />
      <Button v-else :label="t('workflows.turnOn')" icon="pi pi-play" :disabled="!validation.valid || !spec" :loading="saving" @click="turnOn" />
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
                v-if="block.kind === 'action.task.create'"
                :block="block"
                :members="members"
                :canMoveUp="index > 0"
                :canMoveDown="index < spec.blocks.length - 1"
                @moveUp="moveItem(spec.blocks, index, -1)"
                @moveDown="moveItem(spec.blocks, index, 1)"
                @remove="removeRoot(index)"
              />

              <section v-else class="rounded-lg border-2 border-amber-300 bg-amber-50/80 shadow-sm overflow-hidden">
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
                      <Button :label="t('workflows.addTaskBlock')" icon="pi pi-plus" size="small" severity="success" text @click="addBranchTask(block, 'then')" />
                    </div>
                    <p v-if="block.then.length === 0" class="text-xs text-surface-500 m-0 px-1">{{ t('workflows.branchEmpty') }}</p>
                    <WorkflowTaskBlock
                      v-for="(task, taskIndex) in block.then"
                      :key="task.id"
                      compact
                      :block="task"
                      :members="members"
                      :canMoveUp="taskIndex > 0"
                      :canMoveDown="taskIndex < block.then.length - 1"
                      @moveUp="moveBranchTask(block, 'then', taskIndex, -1)"
                      @moveDown="moveBranchTask(block, 'then', taskIndex, 1)"
                      @remove="removeBranchTask(block, 'then', taskIndex)"
                    />
                  </section>

                  <section class="rounded-lg border border-surface-300 bg-surface-100/60 p-2.5 sm:p-3 grid gap-2.5">
                    <div class="flex items-center justify-between gap-2">
                      <strong class="text-xs uppercase tracking-[.16em] text-surface-700">{{ t('workflows.else') }}</strong>
                      <Button :label="t('workflows.addTaskBlock')" icon="pi pi-plus" size="small" severity="secondary" text @click="addBranchTask(block, 'else')" />
                    </div>
                    <p v-if="block.else.length === 0" class="text-xs text-surface-500 m-0 px-1">{{ t('workflows.branchEmpty') }}</p>
                    <WorkflowTaskBlock
                      v-for="(task, taskIndex) in block.else"
                      :key="task.id"
                      compact
                      :block="task"
                      :members="members"
                      :canMoveUp="taskIndex > 0"
                      :canMoveDown="taskIndex < block.else.length - 1"
                      @moveUp="moveBranchTask(block, 'else', taskIndex, -1)"
                      @moveDown="moveBranchTask(block, 'else', taskIndex, 1)"
                      @remove="removeBranchTask(block, 'else', taskIndex)"
                    />
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
                <Button :label="t('workflows.addTaskBlock')" icon="pi pi-check-square" severity="success" outlined @click="addRootTask" />
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
              <Tag :value="validation.valid ? t('workflows.ready') : `${validation.errors.length + validation.holes.length}`" :severity="validation.valid ? 'success' : 'warn'" />
            </div>
            <div v-if="!validation.valid" class="grid gap-2">
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
                  <template v-if="item.tasks?.length">
                    <div v-for="task in item.tasks" :key="task.blockId" class="not-last:mb-2">
                      <strong class="block text-xs leading-snug">{{ task.title }}</strong>
                      <span class="font-mono text-[.6rem] text-surface-500 mt-1 block">{{ task.assigneeName }} · {{ formatDate(task.dueAt) }}</span>
                      <span class="font-mono text-[.6rem] text-violet-700 mt-1 block"><i class="pi pi-shield mr-1" />{{ task.approverName }}</span>
                    </div>
                  </template>
                  <span v-else class="text-xs text-surface-500">{{ item.error || t('workflows.noTaskForCall') }}</span>
                  <div v-if="item.conditions?.length" class="flex flex-wrap gap-1 mt-2">
                    <Tag v-for="condition in item.conditions" :key="condition.blockId" :value="conditionSummary(condition)" :severity="condition.result ? 'success' : 'secondary'" />
                  </div>
                </article>
              </div>
            </template>
            <p v-else class="text-sm text-surface-500 leading-relaxed mt-0">{{ t('workflows.historyBody') }}</p>
            <Button :label="t('workflows.dryRun')" icon="pi pi-history" severity="secondary" outlined size="small" class="mt-3 w-full" :loading="testing" :disabled="!validation.valid" @click="tryHistory" />
          </section>
        </aside>
      </div>
    </main>

    <div v-if="spec && !workflow?.legacy" class="sm:hidden fixed left-3 right-3 bottom-[4.75rem] z-20 grid grid-cols-2 gap-2">
      <Button :label="t('workflows.dryRun')" icon="pi pi-history" severity="secondary" outlined class="bg-white" :loading="testing" :disabled="!validation.valid" @click="tryHistory" />
      <Button :label="t('workflows.save')" severity="secondary" outlined class="bg-white" :loading="saving" :disabled="!validation.valid" @click="save()" />
    </div>
  </section>
</template>
