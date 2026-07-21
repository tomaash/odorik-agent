<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useIntakeStore } from '../stores/intake'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'

const store = useIntakeStore()
const router = useRouter()

function formatDate(value: string | null) {
  if (!value) return 'Unknown time'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date)
}

onMounted(() => store.loadList())
</script>

<template>
  <section>
    <div class="flex items-end justify-between gap-4 mb-7 flex-wrap">
      <div>
        <div class="text-sm font-semibold uppercase tracking-[.14em] text-emerald-700 mb-2">CRM</div>
        <h1 class="text-4xl font-bold tracking-tight mb-2">{{ $t('inbox.title') }}</h1>
        <p class="text-surface-500 text-lg">{{ $t('inbox.subtitle') }}</p>
      </div>
      <Button :label="$t('inbox.refresh')" icon="pi pi-refresh" severity="secondary" outlined :loading="store.loading" @click="store.loadList" />
    </div>

    <Message v-if="store.error" severity="error" :closable="false" class="mb-5">{{ store.error }}</Message>

    <div v-if="store.loading && store.items.length === 0" class="flex justify-center py-20">
      <ProgressSpinner />
    </div>

    <Card v-else-if="store.items.length === 0" class="border border-surface-200 shadow-none rounded-2xl">
      <template #content>
        <div class="text-center py-16 text-surface-500">
          <i class="pi pi-inbox text-4xl text-surface-300 block mb-4" />
          {{ $t('inbox.empty') }}
        </div>
      </template>
    </Card>

    <div v-else class="grid gap-4">
      <button
        v-for="item in store.items"
        :key="item.id"
        type="button"
        class="w-full text-left bg-white border border-surface-200 rounded-2xl p-5 sm:p-6 shadow-sm hover:shadow-md hover:border-emerald-300 transition cursor-pointer"
        @click="router.push(`/requests/${item.requestId}`)"
      >
        <div class="flex items-start gap-4">
          <div class="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <i class="pi pi-phone" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <h2 class="font-semibold text-xl truncate">{{ item.title }}</h2>
              <Tag :value="item.status === 'open' ? 'Needs review' : item.status" :severity="item.status === 'open' ? 'warn' : 'success'" rounded />
            </div>
            <div class="flex gap-x-4 gap-y-1 flex-wrap text-sm text-surface-500 mt-2">
              <span><i class="pi pi-user mr-1" /> {{ item.contactName || item.phone || 'Unknown caller' }}</span>
              <span><i class="pi pi-clock mr-1" /> {{ formatDate(item.occurredAt) }}</span>
              <span v-if="item.missingInformation.length" class="text-amber-700">
                <i class="pi pi-question-circle mr-1" /> {{ item.missingInformation.length }} {{ $t('inbox.missing') }}
              </span>
            </div>
            <p v-if="item.summary" class="text-surface-600 mt-3 mb-0 line-clamp-2">{{ item.summary }}</p>
          </div>
          <i class="pi pi-chevron-right text-surface-300 mt-3" />
        </div>
      </button>
    </div>
  </section>
</template>
