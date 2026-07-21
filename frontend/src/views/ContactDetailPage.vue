<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import RequestCard from '../components/RequestCard.vue'
import { useContactsStore } from '../stores/contacts'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const store = useContactsStore()
const details = computed(() => store.current)
const interactions = computed(() => [...(details.value?.interactions || [])].sort((a, b) => {
  const aTime = new Date(String(a.occurredAt || a.createdAt || 0)).getTime()
  const bTime = new Date(String(b.occurredAt || b.createdAt || 0)).getTime()
  return bTime - aTime
}))

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatDuration(value?: number | null) {
  if (!value) return ''
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

store.load(String(route.params.id))
</script>

<template>
  <section class="min-w-0">
    <Button :label="t('contacts.back')" icon="pi pi-arrow-left" severity="secondary" text class="max-w-full mb-4" @click="router.push('/contacts')" />
    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>
    <div v-if="store.loading && !details" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else-if="details">
      <div class="min-w-0 flex items-start gap-4 mb-7">
        <div class="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0"><i class="pi pi-user text-xl" /></div>
        <div class="min-w-0">
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight break-words">{{ details.contact.displayName || t('contacts.unknown') }}</h1>
          <p class="text-surface-500 mt-2 mb-0 break-all">{{ details.contact.phoneE164 || details.contact.phoneRaw || '—' }}</p>
          <p v-if="details.contact.email" class="text-surface-500 mt-1 mb-0 break-all">{{ details.contact.email }}</p>
        </div>
      </div>

      <div class="grid lg:grid-cols-2 gap-6 items-start">
        <section class="min-w-0">
          <h2 class="text-xl font-semibold mb-4">{{ t('contacts.requests') }} <span class="text-surface-400">{{ details.requests.length }}</span></h2>
          <div class="grid gap-4">
            <RequestCard v-for="request in details.requests" :key="request.id" :item="request" />
            <Card v-if="details.requests.length === 0" class="border border-surface-200 shadow-none rounded-2xl"><template #content><p class="text-surface-500 text-center py-8 m-0">{{ t('contacts.noRequests') }}</p></template></Card>
          </div>
        </section>

        <section class="min-w-0">
          <h2 class="text-xl font-semibold mb-4">{{ t('contacts.calls') }} <span class="text-surface-400">{{ interactions.length }}</span></h2>
          <div class="grid gap-4">
            <Card v-for="interaction in interactions" :key="interaction.id" class="min-w-0 overflow-hidden border border-surface-200 shadow-sm rounded-2xl [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-5">
              <template #title><div class="flex items-center gap-2 text-base"><i class="pi pi-phone text-emerald-700" />{{ formatDate(interaction.occurredAt || interaction.createdAt) }}</div></template>
              <template #subtitle><span v-if="interaction.durationSeconds">{{ formatDuration(interaction.durationSeconds) }}</span></template>
              <template #content>
                <p class="m-0 leading-relaxed break-words">{{ interaction.summary || t('contacts.noSummary') }}</p>
                <details v-if="interaction.transcript" class="mt-3">
                  <summary class="cursor-pointer text-sm font-medium text-emerald-800">{{ t('requests.showTranscript') }}</summary>
                  <p class="whitespace-pre-wrap break-words leading-relaxed text-sm mt-3 mb-0">{{ interaction.transcript }}</p>
                </details>
              </template>
            </Card>
            <Card v-if="interactions.length === 0" class="border border-surface-200 shadow-none rounded-2xl"><template #content><p class="text-surface-500 text-center py-8 m-0">{{ t('contacts.noCalls') }}</p></template></Card>
          </div>
        </section>
      </div>
    </template>
  </section>
</template>
