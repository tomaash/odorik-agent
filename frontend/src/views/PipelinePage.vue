<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Skeleton from 'primevue/skeleton'
import Tag from 'primevue/tag'
import { useAuthStore } from '../stores/auth'
import {
  createCase,
  getPipeline,
  getTeamOverview,
  listCases,
  listContacts,
  listTasks,
  moveCase,
  updatePipeline,
  type CaseItem,
  type ContactListItem,
  type Pipeline,
  type TaskItem,
  type TeamMember,
} from '../api/client'

const { t } = useI18n()
const authStore = useAuthStore()
const pipeline = ref<Pipeline | null>(null)
const cases = ref<CaseItem[]>([])
const tasks = ref<TaskItem[]>([])
const members = ref<TeamMember[]>([])
const contacts = ref<ContactListItem[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const createOpen = ref(false)
const settingsOpen = ref(false)
const draggingId = ref<string | null>(null)
const settings = ref<Pipeline | null>(null)
const form = ref({
  title: '',
  contactId: '',
  ownerUid: '',
  stageId: '',
})

const colorOptions = ['slate', 'indigo', 'emerald', 'amber', 'green', 'rose', 'blue', 'violet']
  .map((value) => ({ label: value, value }))
const orderedStages = computed(() => [...(pipeline.value?.stages || [])].sort((a, b) => a.position - b.position))
const visibleStages = computed(() => orderedStages.value.filter((stage) => (
  !stage.archived || cases.value.some((item) => item.stageId === stage.id)
)))
const activeStages = computed(() => orderedStages.value.filter((stage) => !stage.archived))
const contactOptions = computed(() => contacts.value.map((contact) => {
  const phone = contact.phoneE164 || contact.phoneRaw || ''
  return {
    ...contact,
    label: contact.displayName
      ? [contact.displayName, phone].filter(Boolean).join(' · ')
      : phone || t('contacts.unknown'),
  }
}))

function stageCases(stageId: string) {
  return cases.value.filter((item) => item.stageId === stageId)
}

function stageColorClass(stage: Pipeline['stages'][number]) {
  if (stage.terminal) return 'bg-emerald-600'
  return {
    slate: 'bg-slate-500',
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    green: 'bg-green-500',
    rose: 'bg-rose-500',
    blue: 'bg-blue-500',
    violet: 'bg-violet-500',
  }[stage.color] || 'bg-slate-500'
}

function openTaskCount(caseId: string) {
  return tasks.value.filter((task) => task.caseId === caseId && task.status === 'open').length
}

function openCreate(stageId?: string) {
  form.value = {
    title: '',
    contactId: '',
    ownerUid: authStore.user?.uid || members.value[0]?.uid || '',
    stageId: stageId || pipeline.value?.initialStageId || activeStages.value[0]?.id || '',
  }
  createOpen.value = true
}

function contactChanged(contactId: string) {
  const contact = contacts.value.find((item) => item.id === contactId)
  if (contact && !form.value.title.trim()) {
    form.value.title = `${t('pipeline.followUpWith')} ${contact.displayName || contact.phoneE164 || contact.phoneRaw || ''}`.trim()
  }
}

async function submitCreate() {
  if (!form.value.title.trim() || !form.value.contactId || !form.value.ownerUid) return
  saving.value = true
  error.value = ''
  try {
    const created = await createCase(form.value)
    cases.value.unshift(created)
    createOpen.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function move(item: CaseItem, stageId: string) {
  if (item.stageId === stageId) return
  const previous = { stageId: item.stageId, revision: item.revision }
  const stage = activeStages.value.find((candidate) => candidate.id === stageId)
  if (!stage) return
  item.stageId = stage.id
  error.value = ''
  try {
    const result = await moveCase({
      caseId: item.id,
      stageId,
      expectedRevision: previous.revision,
      expectedStageId: previous.stageId,
    }) as { revision?: number }
    item.revision = result.revision ?? previous.revision + 1
  } catch (cause) {
    Object.assign(item, previous)
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function drop(stageId: string) {
  const item = cases.value.find((candidate) => candidate.id === draggingId.value)
  draggingId.value = null
  if (item) void move(item, stageId)
}

function openSettings() {
  if (!pipeline.value) return
  settings.value = {
    ...pipeline.value,
    stages: pipeline.value.stages.map((stage) => ({ ...stage })),
  }
  settingsOpen.value = true
}

function moveStage(index: number, delta: number) {
  if (!settings.value) return
  const target = index + delta
  if (target < 0 || target >= settings.value.stages.length) return
  const [stage] = settings.value.stages.splice(index, 1)
  if (stage) settings.value.stages.splice(target, 0, stage)
}

function nextStageId() {
  if (!settings.value) return 'stage'
  const used = new Set(settings.value.stages.map((stage) => stage.id))
  let suffix = settings.value.stages.length + 1
  while (used.has(`stage_${suffix}`)) suffix += 1
  return `stage_${suffix}`
}

function addStage() {
  if (!settings.value) return
  settings.value.stages.push({
    id: nextStageId(),
    name: t('pipeline.settings.newStage'),
    position: settings.value.stages.length,
    color: 'slate',
    terminal: false,
    archived: false,
  })
}

async function saveSettings() {
  if (!settings.value) return
  saving.value = true
  error.value = ''
  try {
    pipeline.value = await updatePipeline({
      expectedRevision: settings.value.revision,
      name: settings.value.name,
      initialStageId: settings.value.initialStageId,
      stages: settings.value.stages.map((stage, position) => ({ ...stage, position })),
    })
    settingsOpen.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [pipelineData, caseItems, taskItems, team, contactItems] = await Promise.all([
      getPipeline(),
      listCases(),
      listTasks({ status: 'open' }),
      getTeamOverview(),
      listContacts(),
    ])
    pipeline.value = pipelineData
    cases.value = caseItems
    tasks.value = taskItems
    members.value = team.members
    contacts.value = contactItems
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="min-h-screen min-w-0 overflow-hidden">
    <header class="px-4 sm:px-6 h-16 flex items-center justify-between gap-4 border-b border-[var(--hairline)]">
      <div class="min-w-0">
        <div class="eyebrow !text-surface-500">{{ t('pipeline.eyebrow') }}</div>
        <h1 class="m-0 text-base font-semibold truncate">{{ pipeline?.name || t('pipeline.title') }}</h1>
      </div>
      <div class="flex items-center gap-1">
        <Button v-if="authStore.access?.admin" icon="pi pi-cog" severity="secondary" text :aria-label="t('pipeline.settings.title')" @click="openSettings" />
        <Button icon="pi pi-refresh" severity="secondary" text :loading="loading" :aria-label="t('common.refresh')" @click="load" />
        <Button :label="t('pipeline.newCase')" icon="pi pi-plus" size="small" @click="openCreate()" />
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <Skeleton v-for="index in 6" :key="index" height="28rem" />
    </div>

    <div v-else class="pipeline-scroll min-w-0 overflow-x-auto p-3 sm:p-5">
      <div class="flex items-start gap-3 sm:gap-4 min-w-max">
        <section
          v-for="stage in visibleStages"
          :key="stage.id"
          class="w-[17.5rem] sm:w-[19rem] shrink-0 rounded-lg bg-surface-100/70 border border-surface-200 overflow-hidden"
          :class="stage.archived ? 'opacity-65' : ''"
          @dragover.prevent
          @drop="drop(stage.id)"
        >
          <header class="h-11 px-3 flex items-center justify-between gap-2 border-b border-surface-200 bg-white/70">
            <div class="flex items-center gap-2 min-w-0">
              <span :class="['w-2 h-2 rounded-full shrink-0', stageColorClass(stage)]" />
              <h2 class="text-xs font-semibold m-0 truncate">{{ stage.name }}</h2>
              <Tag v-if="stage.archived" :value="t('pipeline.settings.archived')" severity="secondary" />
            </div>
            <span class="font-mono text-[.65rem] text-surface-400">{{ stageCases(stage.id).length }}</span>
          </header>

          <div class="p-2 grid gap-2 min-h-32">
            <article
              v-for="item in stageCases(stage.id)"
              :key="item.id"
              :draggable="!stage.archived"
              class="rounded-md border border-surface-200 bg-white p-3 shadow-sm cursor-grab active:cursor-grabbing"
              @dragstart="draggingId = item.id"
              @dragend="draggingId = null"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <h3 class="text-sm font-semibold leading-snug m-0 break-words">
                    <router-link :to="`/cases/${item.id}`" class="text-[var(--ink)] no-underline hover:text-indigo-700">
                      {{ item.title }}
                    </router-link>
                  </h3>
                  <router-link :to="`/contacts/${item.contactId}`" class="text-xs text-indigo-700 no-underline mt-1 inline-block">
                    {{ item.contactName }}
                  </router-link>
                </div>
                <Tag v-if="openTaskCount(item.id)" :value="`${openTaskCount(item.id)}`" icon="pi pi-check-square" severity="secondary" />
              </div>
              <div class="mt-3 pt-2 border-t border-surface-100 flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-surface-900 text-white text-[.62rem] flex items-center justify-center shrink-0">
                  {{ item.ownerName.slice(0, 1).toUpperCase() }}
                </span>
                <span class="text-[.68rem] text-surface-500 truncate flex-1">{{ item.ownerName }}</span>
              </div>
              <Select
                :modelValue="item.stageId"
                :options="activeStages"
                optionLabel="name"
                optionValue="id"
                size="small"
                class="w-full mt-2 sm:hidden"
                @update:modelValue="(stageId) => move(item, stageId)"
              />
            </article>

            <button v-if="!stage.archived" type="button" class="h-10 rounded-md border border-dashed border-surface-300 text-xs text-surface-500 bg-white/40 cursor-pointer hover:bg-white" @click="openCreate(stage.id)">
              <i class="pi pi-plus mr-1" />{{ t('pipeline.addHere') }}
            </button>
          </div>
        </section>
      </div>
    </div>

    <Dialog v-model:visible="createOpen" modal :header="t('pipeline.newCase')" class="w-[min(32rem,calc(100vw-2rem))]">
      <form class="grid gap-4" @submit.prevent="submitCreate">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('pipeline.fields.contact') }}
          <Select v-model="form.contactId" :options="contactOptions" optionLabel="label" optionValue="id" filter @update:modelValue="contactChanged" />
        </label>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('pipeline.fields.title') }}
          <InputText v-model="form.title" />
        </label>
        <div class="grid sm:grid-cols-2 gap-4">
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('pipeline.fields.owner') }}
            <Select v-model="form.ownerUid" :options="members" optionLabel="displayName" optionValue="uid" />
          </label>
          <label class="grid gap-1.5 text-sm font-medium">
            {{ t('pipeline.fields.stage') }}
            <Select v-model="form.stageId" :options="activeStages" optionLabel="name" optionValue="id" />
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="createOpen = false" />
          <Button :label="t('pipeline.create')" icon="pi pi-plus" type="submit" :loading="saving" :disabled="!form.title.trim() || !form.contactId || !form.ownerUid" />
        </div>
      </form>
    </Dialog>

    <Dialog v-model:visible="settingsOpen" modal :header="t('pipeline.settings.title')" class="w-[min(46rem,calc(100vw-2rem))]">
      <form v-if="settings" class="grid gap-4" @submit.prevent="saveSettings">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('pipeline.settings.name') }}
          <InputText v-model="settings.name" />
        </label>
        <div class="grid gap-2">
          <div v-for="(stage, index) in settings.stages" :key="stage.id" class="grid grid-cols-[auto_minmax(8rem,1fr)_7rem_auto_auto_auto] gap-2 items-center rounded border border-surface-200 p-2">
            <div class="flex">
              <Button type="button" icon="pi pi-chevron-up" text severity="secondary" size="small" :disabled="index === 0" @click="moveStage(index, -1)" />
              <Button type="button" icon="pi pi-chevron-down" text severity="secondary" size="small" :disabled="index === settings.stages.length - 1" @click="moveStage(index, 1)" />
            </div>
            <InputText v-model="stage.name" :aria-label="t('pipeline.settings.stageName')" />
            <Select v-model="stage.color" :options="colorOptions" optionLabel="label" optionValue="value" />
            <label class="flex items-center gap-1 text-xs"><Checkbox v-model="stage.terminal" binary />{{ t('pipeline.settings.terminal') }}</label>
            <label class="flex items-center gap-1 text-xs"><Checkbox v-model="stage.archived" binary />{{ t('pipeline.settings.archived') }}</label>
            <span class="font-mono text-[.6rem] text-surface-400">{{ stage.id }}</span>
          </div>
          <Button type="button" :label="t('pipeline.settings.addStage')" icon="pi pi-plus" severity="secondary" outlined @click="addStage" />
        </div>
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('pipeline.settings.initialStage') }}
          <Select v-model="settings.initialStageId" :options="settings.stages.filter((stage) => !stage.archived && !stage.terminal)" optionLabel="name" optionValue="id" />
        </label>
        <Message severity="info" :closable="false">{{ t('pipeline.settings.hint') }}</Message>
        <div class="flex justify-end gap-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="settingsOpen = false" />
          <Button :label="t('common.save')" type="submit" :loading="saving" />
        </div>
      </form>
    </Dialog>
  </section>
</template>
