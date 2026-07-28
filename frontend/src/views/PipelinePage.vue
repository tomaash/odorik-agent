<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Skeleton from 'primevue/skeleton'
import Tag from 'primevue/tag'
import { useAuthStore } from '../stores/auth'
import {
  createDeal,
  getPipeline,
  getTeamOverview,
  listContacts,
  listDeals,
  listTasks,
  moveDeal,
  type ContactListItem,
  type DealItem,
  type Pipeline,
  type TaskItem,
  type TeamMember,
} from '../api/client'

const { t, locale } = useI18n()
const authStore = useAuthStore()
const pipeline = ref<Pipeline | null>(null)
const deals = ref<DealItem[]>([])
const tasks = ref<TaskItem[]>([])
const members = ref<TeamMember[]>([])
const contacts = ref<ContactListItem[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const createOpen = ref(false)
const draggingId = ref<string | null>(null)
const form = ref({
  title: '',
  contactId: '',
  ownerUid: '',
  stageId: 'new',
})

const orderedStages = computed(() => [...(pipeline.value?.stages || [])].sort((a, b) => a.position - b.position))
const localizedStages = computed(() => {
  void locale.value
  return orderedStages.value.map((stage) => ({
    ...stage,
    name: t(`pipeline.stages.${stage.id}`),
  }))
})
const contactOptions = computed(() => contacts.value.map((contact) => {
  const phone = contact.phoneE164 || contact.phoneRaw || ''
  return {
    ...contact,
    label: contact.displayName
      ? [contact.displayName, phone].filter(Boolean).join(' · ')
      : phone || t('contacts.unknown'),
  }
}))

function stageDeals(stageId: string) {
  return deals.value.filter((deal) => deal.stageId === stageId)
}

function openTaskCount(dealId: string) {
  return tasks.value.filter((task) => task.dealId === dealId && task.status === 'open').length
}

function openCreate(stageId?: string) {
  form.value = {
    title: '',
    contactId: '',
    ownerUid: authStore.user?.uid || members.value[0]?.uid || '',
    stageId: stageId || orderedStages.value[0]?.id || 'new',
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
    const deal = await createDeal(form.value)
    deals.value.unshift(deal)
    createOpen.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function move(deal: DealItem, stageId: string) {
  if (deal.stageId === stageId) return
  const previous = {
    stageId: deal.stageId,
    stageName: deal.stageName,
    stageCategory: deal.stageCategory,
  }
  const stage = orderedStages.value.find((item) => item.id === stageId)
  if (!stage) return
  deal.stageId = stage.id
  deal.stageName = stage.name
  deal.stageCategory = stage.category
  error.value = ''
  try {
    await moveDeal(deal.id, stageId)
  } catch (cause) {
    Object.assign(deal, previous)
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function drop(stageId: string) {
  const deal = deals.value.find((item) => item.id === draggingId.value)
  draggingId.value = null
  if (deal) void move(deal, stageId)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [pipelineData, dealItems, taskItems, team, contactItems] = await Promise.all([
      getPipeline(),
      listDeals(),
      listTasks({ status: 'open' }),
      getTeamOverview(),
      listContacts(),
    ])
    pipeline.value = pipelineData
    deals.value = dealItems
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
        <h1 class="m-0 text-base font-semibold truncate">{{ t('pipeline.title') }}</h1>
      </div>
      <div class="flex items-center gap-1">
        <Button icon="pi pi-refresh" severity="secondary" text :loading="loading" :aria-label="t('common.refresh')" @click="load" />
        <Button :label="t('pipeline.newDeal')" icon="pi pi-plus" size="small" @click="openCreate()" />
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <Skeleton v-for="index in 6" :key="index" height="28rem" />
    </div>

    <div v-else class="pipeline-scroll min-w-0 overflow-x-auto p-3 sm:p-5">
      <div class="flex items-start gap-3 sm:gap-4 min-w-max">
        <section
          v-for="stage in orderedStages"
          :key="stage.id"
          class="w-[17.5rem] sm:w-[19rem] shrink-0 rounded-lg bg-surface-100/70 border border-surface-200 overflow-hidden"
          @dragover.prevent
          @drop="drop(stage.id)"
        >
          <header class="h-11 px-3 flex items-center justify-between gap-2 border-b border-surface-200 bg-white/70">
            <div class="flex items-center gap-2 min-w-0">
              <span :class="[
                'w-2 h-2 rounded-full shrink-0',
                stage.category === 'won' ? 'bg-emerald-600' : stage.category === 'lost' ? 'bg-rose-500' : 'bg-indigo-500',
              ]" />
              <h2 class="text-xs font-semibold m-0 truncate">{{ t(`pipeline.stages.${stage.id}`) }}</h2>
            </div>
            <span class="font-mono text-[.65rem] text-surface-400">{{ stageDeals(stage.id).length }}</span>
          </header>

          <div class="p-2 grid gap-2 min-h-32">
            <article
              v-for="deal in stageDeals(stage.id)"
              :key="deal.id"
              draggable="true"
              class="rounded-md border border-surface-200 bg-white p-3 shadow-sm cursor-grab active:cursor-grabbing"
              @dragstart="draggingId = deal.id"
              @dragend="draggingId = null"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <h3 class="text-sm font-semibold leading-snug m-0 break-words">{{ deal.title }}</h3>
                  <router-link :to="`/contacts/${deal.contactId}`" class="text-xs text-indigo-700 no-underline mt-1 inline-block">
                    {{ deal.contactName }}
                  </router-link>
                </div>
                <Tag v-if="openTaskCount(deal.id)" :value="`${openTaskCount(deal.id)}`" icon="pi pi-check-square" severity="secondary" />
              </div>
              <div class="mt-3 pt-2 border-t border-surface-100 flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-surface-900 text-white text-[.62rem] flex items-center justify-center shrink-0">
                  {{ deal.ownerName.slice(0, 1).toUpperCase() }}
                </span>
                <span class="text-[.68rem] text-surface-500 truncate flex-1">{{ deal.ownerName }}</span>
              </div>
              <Select
                :modelValue="deal.stageId"
                :options="localizedStages"
                optionLabel="name"
                optionValue="id"
                size="small"
                class="w-full mt-2 sm:hidden"
                @update:modelValue="(stageId) => move(deal, stageId)"
              />
            </article>

            <button type="button" class="h-10 rounded-md border border-dashed border-surface-300 text-xs text-surface-500 bg-white/40 cursor-pointer hover:bg-white" @click="openCreate(stage.id)">
              <i class="pi pi-plus mr-1" />{{ t('pipeline.addHere') }}
            </button>
          </div>
        </section>
      </div>
    </div>

    <Dialog v-model:visible="createOpen" modal :header="t('pipeline.newDeal')" class="w-[min(32rem,calc(100vw-2rem))]">
      <form class="grid gap-4" @submit.prevent="submitCreate">
        <label class="grid gap-1.5 text-sm font-medium">
          {{ t('pipeline.fields.contact') }}
          <Select
            v-model="form.contactId"
            :options="contactOptions"
            optionLabel="label"
            optionValue="id"
            filter
            @update:modelValue="contactChanged"
          />
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
            <Select v-model="form.stageId" :options="localizedStages" optionLabel="name" optionValue="id" />
          </label>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="createOpen = false" />
          <Button :label="t('pipeline.create')" icon="pi pi-plus" type="submit" :loading="saving" :disabled="!form.title.trim() || !form.contactId || !form.ownerUid" />
        </div>
      </form>
    </Dialog>
  </section>
</template>
