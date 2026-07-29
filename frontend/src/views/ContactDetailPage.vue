<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import { useContactsStore } from '../stores/contacts'
import { getPipeline, type Pipeline } from '../api/client'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const store = useContactsStore()
const pipeline = ref<Pipeline | null>(null)
const details = computed(() => store.current)
const calls = computed(() => [...(details.value?.calls || [])].sort((a, b) => {
  const aTime = new Date(String(a.odorikTime || a.uploadedAt || 0)).getTime()
  const bTime = new Date(String(b.odorikTime || b.uploadedAt || 0)).getTime()
  return bTime - aTime
}))
const tasks = computed(() => [...(details.value?.tasks || [])].sort((a, b) => {
  if (a.status === 'open' && b.status !== 'open') return -1
  if (b.status === 'open' && a.status !== 'open') return 1
  return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
}))

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatDuration(value?: number | null) {
  if (!value) return ''
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function stageName(stageId: string) {
  return pipeline.value?.stages.find((stage) => stage.id === stageId)?.name || stageId
}

function stageSeverity(stageId: string) {
  return pipeline.value?.stages.find((stage) => stage.id === stageId)?.terminal
    ? 'success'
    : 'secondary'
}

void Promise.all([
  store.load(String(route.params.id)),
  getPipeline().then((result) => { pipeline.value = result }),
])
</script>

<template>
  <section class="min-h-screen min-w-0 px-4 py-4 sm:p-6">
    <Button :label="t('contacts.back')" icon="pi pi-arrow-left" severity="secondary" text class="max-w-full mb-4" @click="router.push('/contacts')" />
    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>
    <div v-if="store.loading && !details" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else-if="details">
      <div class="min-w-0 flex items-start gap-4 mb-7">
        <div class="w-12 h-12 rounded-md bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0"><i class="pi pi-user text-lg" /></div>
        <div class="min-w-0">
          <div class="eyebrow mb-1">{{ t('contacts.customer') }}</div>
          <h1 class="text-2xl sm:text-3xl font-semibold tracking-[-.03em] leading-tight m-0 break-words">{{ details.contact.displayName || t('contacts.unknown') }}</h1>
          <p class="text-surface-500 mt-2 mb-0 break-all">{{ details.contact.phoneE164 || details.contact.phoneRaw || '—' }}</p>
          <p v-if="details.contact.email" class="text-surface-500 mt-1 mb-0 break-all">{{ details.contact.email }}</p>
        </div>
      </div>

      <div class="grid lg:grid-cols-2 gap-5 items-start mb-8">
        <section class="min-w-0">
          <h2 class="text-base font-semibold mb-3">{{ t('contacts.cases') }} <span class="text-surface-400">{{ details.cases.length }}</span></h2>
          <div class="hairline-card overflow-hidden divide-y divide-[var(--hairline)]">
            <router-link
              v-for="item in details.cases"
              :key="item.id"
              to="/pipeline"
              class="block p-4 no-underline text-[var(--ink)] hover:bg-white"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <strong class="block text-sm break-words">{{ item.title }}</strong>
                  <span class="text-xs text-surface-500 mt-1 block">{{ item.ownerName }}</span>
                </div>
                <Tag :value="stageName(item.stageId)" :severity="stageSeverity(item.stageId)" />
              </div>
            </router-link>
            <p v-if="details.cases.length === 0" class="text-sm text-surface-500 text-center py-8 px-4 m-0">{{ t('contacts.noCases') }}</p>
          </div>
        </section>

        <section class="min-w-0">
          <h2 class="text-base font-semibold mb-3">{{ t('contacts.tasks') }} <span class="text-surface-400">{{ tasks.length }}</span></h2>
          <div class="hairline-card overflow-hidden divide-y divide-[var(--hairline)]">
            <router-link
              v-for="task in tasks"
              :key="task.id"
              to="/tasks"
              class="block p-4 no-underline text-[var(--ink)] hover:bg-white"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <strong class="block text-sm break-words">{{ task.title }}</strong>
                  <span class="font-mono text-[.65rem] text-surface-500 mt-1 block">{{ task.assigneeName }} · {{ formatDate(task.dueAt) }}</span>
                </div>
                <Tag :value="t(`tasks.status.${task.status}`)" :severity="task.status === 'completed' ? 'success' : task.status === 'dismissed' ? 'secondary' : 'info'" />
              </div>
            </router-link>
            <p v-if="tasks.length === 0" class="text-sm text-surface-500 text-center py-8 px-4 m-0">{{ t('contacts.noTasks') }}</p>
          </div>
        </section>
      </div>

      <section class="min-w-0 mb-8">
        <h2 class="text-base font-semibold mb-3">{{ t('contacts.calls') }} <span class="text-surface-400">{{ calls.length }}</span></h2>
        <div class="grid lg:grid-cols-2 gap-4">
          <Card v-for="call in calls" :key="call.id" class="min-w-0 overflow-hidden border border-surface-200 shadow-none rounded-lg [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-5">
            <template #title><div class="flex items-center gap-2 text-sm"><i class="pi pi-phone text-indigo-700" />{{ formatDate(call.odorikTime || call.uploadedAt) }}</div></template>
            <template #subtitle><span v-if="call.durationSeconds || call.duration">{{ formatDuration(call.durationSeconds || call.duration || 0) }}</span></template>
            <template #content>
              <p class="m-0 leading-relaxed break-words text-sm">{{ call.summary || t('contacts.noSummary') }}</p>
              <details v-if="call.transcript" class="mt-3">
                <summary class="cursor-pointer text-xs font-medium text-indigo-800">{{ t('contacts.showTranscript') }}</summary>
                <p class="whitespace-pre-wrap break-words leading-relaxed text-sm mt-3 mb-0">{{ call.transcript }}</p>
              </details>
            </template>
          </Card>
          <Card v-if="calls.length === 0" class="border border-surface-200 shadow-none rounded-lg lg:col-span-2"><template #content><p class="text-surface-500 text-center py-8 m-0">{{ t('contacts.noCalls') }}</p></template></Card>
        </div>
      </section>
    </template>
  </section>
</template>
