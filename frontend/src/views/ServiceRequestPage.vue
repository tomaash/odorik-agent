<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Drawer from 'primevue/drawer'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { requestStatuses, requestTransitions, statusIcon, statusSeverity } from '../crm/status'
import { useRequestsStore } from '../stores/requests'
import type { RequestStatus } from '../api/client'

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const toast = useToast()
const store = useRequestsStore()
const transitionOpen = ref(false)
const selectedStatus = ref<RequestStatus | null>(null)
const transitionNote = ref('')

const details = computed(() => store.current)
const request = computed(() => details.value?.request as Record<string, unknown> | undefined)
const contact = computed(() => details.value?.contact as Record<string, unknown> | undefined)
const status = computed<RequestStatus>(() => {
  const value = String(request.value?.status || '')
  if (value === 'open') return 'new'
  return requestStatuses.includes(value as RequestStatus) ? value as RequestStatus : 'new'
})
const availableTransitions = computed(() => requestTransitions[status.value])

function formatDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function showTransitions() {
  selectedStatus.value = availableTransitions.value[0] || null
  transitionNote.value = ''
  transitionOpen.value = true
}

async function applyTransition() {
  if (!selectedStatus.value) return
  try {
    await store.transition(selectedStatus.value, transitionNote.value)
    transitionOpen.value = false
    toast.add({ severity: 'success', summary: t('requests.statusUpdated'), life: 3000 })
  } catch (cause) {
    toast.add({ severity: 'error', summary: t('common.error'), detail: cause instanceof Error ? cause.message : String(cause), life: 6000 })
  }
}

store.load(String(route.params.id))
</script>

<template>
  <section class="min-w-0 pb-24 md:pb-0">
    <Button :label="t('requests.back')" icon="pi pi-arrow-left" severity="secondary" text class="max-w-full mb-4" @click="router.push('/requests')" />
    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>
    <div v-if="store.loading && !details" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else-if="details && request">
      <div class="min-w-0 grid gap-4 md:flex md:items-start md:justify-between mb-6">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-3">
            <Tag :value="t(`requests.status.${status}`)" :severity="statusSeverity[status]" :icon="statusIcon[status]" rounded />
            <Tag v-if="request.urgency === 'urgent'" :value="t('requests.urgent')" severity="danger" rounded />
          </div>
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight break-words">{{ request.title || t('requests.untitled') }}</h1>
          <p class="text-surface-500 mt-2 leading-relaxed">{{ contact?.displayName || contact?.phoneE164 || contact?.phoneRaw || t('requests.unknownCustomer') }}</p>
        </div>
        <Button :label="t('requests.changeStatus')" icon="pi pi-arrow-right-arrow-left" class="hidden md:inline-flex shrink-0" @click="showTransitions" />
      </div>

      <div class="min-w-0 grid lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,.9fr)] gap-5 sm:gap-6 items-start">
        <div class="min-w-0 grid gap-5">
          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>{{ t('requests.requestDetails') }}</template>
            <template #content>
              <dl class="grid sm:grid-cols-2 gap-x-5 gap-y-4 m-0">
                <div class="min-w-0"><dt class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ t('requests.serviceType') }}</dt><dd class="m-0 break-words">{{ request.serviceType || '—' }}</dd></div>
                <div class="min-w-0"><dt class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ t('requests.requestedTiming') }}</dt><dd class="m-0 break-words">{{ request.requestedTiming || '—' }}</dd></div>
                <div class="min-w-0 sm:col-span-2"><dt class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ t('requests.description') }}</dt><dd class="m-0 whitespace-pre-wrap break-words leading-relaxed">{{ request.description || '—' }}</dd></div>
                <div class="min-w-0 sm:col-span-2"><dt class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ t('requests.address') }}</dt><dd class="m-0 break-words">{{ request.address || '—' }}</dd></div>
                <div class="min-w-0 sm:col-span-2"><dt class="text-xs uppercase tracking-wide text-surface-400 mb-1">{{ t('requests.notes') }}</dt><dd class="m-0 whitespace-pre-wrap break-words leading-relaxed">{{ request.notes || '—' }}</dd></div>
              </dl>
            </template>
          </Card>

          <Card v-if="Array.isArray(request.missingInformation) && request.missingInformation.length" class="min-w-0 overflow-hidden rounded-2xl border border-amber-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>{{ t('requests.missingInformation') }}</template>
            <template #content><ul class="m-0 pl-5 grid gap-2"><li v-for="item in request.missingInformation" :key="String(item)" class="break-words">{{ item }}</li></ul></template>
          </Card>

          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>{{ t('requests.call') }}</template>
            <template #subtitle>{{ formatDate(details.interaction?.occurredAt || details.interaction?.createdAt) }}</template>
            <template #content>
              <p class="m-0 leading-relaxed break-words">{{ details.interaction?.summary || details.interaction?.transcript || '—' }}</p>
              <details v-if="details.interaction?.transcript" class="mt-4">
                <summary class="cursor-pointer font-medium text-emerald-800">{{ t('requests.showTranscript') }}</summary>
                <p class="whitespace-pre-wrap break-words leading-relaxed text-sm mt-3 mb-0">{{ details.interaction.transcript }}</p>
              </details>
            </template>
          </Card>
        </div>

        <div class="min-w-0 grid gap-5 lg:sticky lg:top-24">
          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>{{ t('contacts.customer') }}</template>
            <template #content>
              <div class="grid gap-3 text-sm">
                <router-link v-if="contact?.id" :to="`/contacts/${contact.id}`" class="font-semibold text-lg text-emerald-800 no-underline break-words hover:underline">{{ contact.displayName || t('requests.unknownCustomer') }}</router-link>
                <span class="break-all"><i class="pi pi-phone mr-2 text-surface-400" />{{ contact?.phoneE164 || contact?.phoneRaw || '—' }}</span>
                <span class="break-all"><i class="pi pi-envelope mr-2 text-surface-400" />{{ contact?.email || '—' }}</span>
              </div>
            </template>
          </Card>
          <Card class="min-w-0 overflow-hidden rounded-2xl border border-surface-200 shadow-sm [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>{{ t('requests.activity') }}</template>
            <template #content>
              <dl class="grid gap-4 m-0 text-sm">
                <div><dt class="text-surface-400">{{ t('requests.updated') }}</dt><dd class="m-0 mt-1">{{ formatDate(request.updatedAt) }}</dd></div>
                <div><dt class="text-surface-400">{{ t('requests.reviewed') }}</dt><dd class="m-0 mt-1">{{ formatDate(request.reviewedAt) }}</dd></div>
                <div><dt class="text-surface-400">{{ t('requests.revision') }}</dt><dd class="m-0 mt-1">{{ request.revision }}</dd></div>
                <div v-if="request.lastStatusNote"><dt class="text-surface-400">{{ t('requests.lastStatusNote') }}</dt><dd class="m-0 mt-1 whitespace-pre-wrap break-words">{{ request.lastStatusNote }}</dd></div>
              </dl>
            </template>
          </Card>
        </div>
      </div>

      <div class="fixed left-4 right-4 bottom-[5.25rem] z-20 md:hidden">
        <Button :label="t('requests.changeStatus')" icon="pi pi-arrow-right-arrow-left" size="large" fluid class="shadow-lg" @click="showTransitions" />
      </div>
    </template>

    <Drawer v-model:visible="transitionOpen" position="bottom" :header="t('requests.changeStatus')" class="!h-auto max-h-[85vh] rounded-t-3xl">
      <div class="max-w-2xl mx-auto grid gap-4 pb-4">
        <p class="m-0 text-surface-500">{{ t('requests.moveFrom', { status: t(`requests.status.${status}`) }) }}</p>
        <div class="grid sm:grid-cols-2 gap-2">
          <Button
            v-for="nextStatus in availableTransitions"
            :key="nextStatus"
            :label="t(`requests.status.${nextStatus}`)"
            :icon="statusIcon[nextStatus]"
            :severity="selectedStatus === nextStatus ? undefined : 'secondary'"
            :outlined="selectedStatus !== nextStatus"
            class="justify-start"
            @click="selectedStatus = nextStatus"
          />
        </div>
        <label class="grid gap-2 text-sm font-medium">{{ t('requests.transitionNote') }}<Textarea v-model="transitionNote" rows="3" autoResize fluid /></label>
        <Button :label="t('requests.applyStatus')" icon="pi pi-check" size="large" fluid :loading="store.saving" :disabled="!selectedStatus" @click="applyTransition" />
      </div>
    </Drawer>
  </section>
</template>
