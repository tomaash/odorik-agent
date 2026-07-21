<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Tag from 'primevue/tag'
import type { ServiceRequestListItem } from '../api/client'
import { statusIcon, statusSeverity } from '../crm/status'

const props = defineProps<{ item: ServiceRequestListItem; compact?: boolean }>()
const { t, locale } = useI18n()

const contactLabel = computed(() => props.item.contact.displayName || props.item.contact.phone || t('requests.unknownCustomer'))

function formatDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
</script>

<template>
  <router-link
    :to="`/requests/${item.id}`"
    class="group block min-w-0 max-w-full overflow-hidden no-underline text-surface-900 bg-white border border-surface-200 rounded-2xl p-4 sm:p-5 shadow-sm hover:shadow-md hover:border-emerald-300 transition"
  >
    <div class="min-w-0 flex items-start justify-between gap-2 flex-wrap">
      <Tag
        :value="t(`requests.status.${item.status}`)"
        :severity="statusSeverity[item.status]"
        :icon="statusIcon[item.status]"
        rounded
      />
      <Tag v-if="item.urgency === 'urgent'" :value="t('requests.urgent')" severity="danger" rounded />
    </div>
    <h2 :class="['font-semibold leading-snug break-words mt-3 mb-0', compact ? 'text-base' : 'text-lg sm:text-xl']">
      {{ item.title || t('requests.untitled') }}
    </h2>
    <div class="min-w-0 grid gap-1.5 text-sm text-surface-500 mt-3">
      <span class="min-w-0 break-words"><i class="pi pi-user mr-1.5" />{{ contactLabel }}</span>
      <span v-if="item.updatedAt" class="min-w-0 break-words"><i class="pi pi-clock mr-1.5" />{{ formatDate(item.updatedAt) }}</span>
      <span v-if="item.requestedTiming" class="min-w-0 break-words"><i class="pi pi-calendar mr-1.5" />{{ item.requestedTiming }}</span>
    </div>
    <p v-if="item.description && !compact" class="max-w-full text-sm sm:text-base text-surface-600 leading-relaxed mt-3 mb-0 line-clamp-2 break-words">
      {{ item.description }}
    </p>
    <div v-if="item.missingInformation?.length" class="text-xs text-amber-700 mt-3">
      <i class="pi pi-question-circle mr-1" />{{ item.missingInformation.length }} {{ t('inbox.missing') }}
    </div>
  </router-link>
</template>
