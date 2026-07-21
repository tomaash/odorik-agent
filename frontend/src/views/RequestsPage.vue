<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import SelectButton from 'primevue/selectbutton'
import RequestCard from '../components/RequestCard.vue'
import { openRequestStatuses, requestStatuses } from '../crm/status'
import { useRequestsStore } from '../stores/requests'
import type { RequestStatus } from '../api/client'

type RequestScope = 'open' | 'all' | RequestStatus

const store = useRequestsStore()
const { t } = useI18n()
const scope = ref<RequestScope>('open')
const search = ref('')
const viewMode = ref<'list' | 'board'>('list')
const viewOptions = computed(() => [
  { label: t('requests.list'), value: 'list', icon: 'pi pi-list' },
  { label: t('requests.board'), value: 'board', icon: 'pi pi-th-large' },
])

const allCount = computed(() => requestStatuses.reduce((sum, status) => sum + store.counts[status], 0))
const scopes = computed<Array<{ value: RequestScope; label: string; count: number }>>(() => [
  { value: 'open', label: t('requests.open'), count: store.openCount },
  ...requestStatuses.map((status) => ({ value: status, label: t(`requests.status.${status}`), count: store.counts[status] })),
  { value: 'all', label: t('requests.all'), count: allCount.value },
])

const searchedItems = computed(() => {
  const term = search.value.trim().toLocaleLowerCase()
  if (!term) return store.items
  return store.items.filter((item) => [
    item.title,
    item.description,
    item.serviceType,
    item.contact.displayName,
    item.contact.phone,
    item.contact.email,
  ].some((value) => String(value || '').toLocaleLowerCase().includes(term)))
})

const filteredItems = computed(() => {
  if (scope.value === 'all') return searchedItems.value
  if (scope.value === 'open') return searchedItems.value.filter((item) => openRequestStatuses.includes(item.status))
  return searchedItems.value.filter((item) => item.status === scope.value)
})

function byStatus(status: RequestStatus) {
  return filteredItems.value.filter((item) => item.status === status)
}

onMounted(() => store.loadList())
</script>

<template>
  <section class="min-w-0">
    <div class="grid gap-4 lg:flex lg:items-end lg:justify-between mb-6">
      <div class="min-w-0">
        <div class="text-sm font-semibold uppercase tracking-[.14em] text-emerald-700 mb-2">CRM</div>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight mb-2 break-words">{{ t('requests.title') }}</h1>
        <p class="text-surface-500 text-base sm:text-lg leading-relaxed">{{ t('requests.subtitle') }}</p>
      </div>
      <div class="min-w-0 flex items-center gap-2 sm:gap-3">
        <SelectButton
          v-model="viewMode"
          :options="viewOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
          class="hidden lg:flex"
        >
          <template #option="slotProps"><i :class="slotProps.option.icon" /><span>{{ slotProps.option.label }}</span></template>
        </SelectButton>
        <Button icon="pi pi-refresh" severity="secondary" outlined :loading="store.loading" :aria-label="t('common.refresh')" @click="store.loadList" />
      </div>
    </div>

    <Message v-if="store.error" severity="error" :closable="false" class="mb-5">{{ store.error }}</Message>

    <div class="min-w-0 grid gap-4 mb-6">
      <div class="min-w-0 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
        <div class="flex gap-2 w-max">
          <button
            v-for="option in scopes"
            :key="option.value"
            type="button"
            :class="[
              'shrink-0 rounded-full border px-3.5 py-2 text-sm font-medium transition cursor-pointer',
              scope === option.value
                ? 'bg-emerald-800 border-emerald-800 text-white'
                : 'bg-white border-surface-200 text-surface-600 hover:border-emerald-300',
            ]"
            @click="scope = option.value"
          >
            {{ option.label }} <span :class="scope === option.value ? 'text-emerald-100' : 'text-surface-400'">{{ option.count }}</span>
          </button>
        </div>
      </div>
      <label class="relative block min-w-0 max-w-xl">
        <i class="pi pi-search absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 z-10" />
        <InputText v-model="search" :placeholder="t('requests.search')" class="w-full min-w-0 pl-10" />
      </label>
    </div>

    <div v-if="store.loading && store.items.length === 0" class="flex justify-center py-20"><ProgressSpinner /></div>

    <div
      v-else-if="viewMode === 'list' || viewMode === 'board'"
      :class="['min-w-0 grid gap-4', viewMode === 'board' ? 'lg:hidden' : '']"
    >
      <RequestCard v-for="item in filteredItems" :key="item.id" :item="item" />
      <div v-if="filteredItems.length === 0" class="rounded-2xl border border-dashed border-surface-300 bg-white/70 p-12 text-center text-surface-500">
        <i class="pi pi-filter text-3xl block mb-3 text-surface-300" />{{ t('requests.empty') }}
      </div>
    </div>

    <div v-if="viewMode === 'board'" class="hidden lg:block min-w-0 overflow-x-auto pb-3">
      <div class="grid grid-cols-5 gap-4 min-w-[1120px]">
        <section v-for="status in requestStatuses" :key="status" class="min-w-0 rounded-2xl bg-surface-100/80 border border-surface-200 p-3">
          <header class="flex items-center justify-between gap-2 px-1 mb-3">
            <h2 class="font-semibold text-sm m-0">{{ t(`requests.status.${status}`) }}</h2>
            <span class="text-xs rounded-full bg-white border border-surface-200 px-2 py-1">{{ byStatus(status).length }}</span>
          </header>
          <div class="grid gap-3">
            <RequestCard v-for="item in byStatus(status)" :key="item.id" :item="item" compact />
            <div v-if="byStatus(status).length === 0" class="text-xs text-center text-surface-400 py-8">{{ t('requests.noItems') }}</div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
