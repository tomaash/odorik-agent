<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Skeleton from 'primevue/skeleton'
import Tag from 'primevue/tag'
import {
  createWorkflow,
  listWorkflows,
  type WorkflowListItem,
} from '../api/client'

const router = useRouter()
const { t } = useI18n()
const items = ref<WorkflowListItem[]>([])
const loading = ref(true)
const creating = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    items.value = await listWorkflows()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function create() {
  creating.value = true
  error.value = ''
  try {
    const workflow = await createWorkflow()
    await router.push(`/workflows/${workflow.id}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    creating.value = false
  }
}

function runSummary(item: WorkflowListItem) {
  const created = item.recentRuns.approval_requested || 0
  const duplicate = item.recentRuns.duplicate || 0
  if (!created && !duplicate) return t('workflows.noRecentRuns')
  return t('workflows.recentTaskRuns', { created, duplicate })
}

onMounted(load)
</script>

<template>
  <section class="min-h-screen min-w-0">
    <header class="px-4 sm:px-6 h-16 flex items-center justify-between gap-4 border-b border-[var(--hairline)]">
      <div>
        <div class="eyebrow mb-1">{{ t('workflows.eyebrow') }}</div>
        <h1 class="m-0 text-sm font-semibold">{{ t('workflows.title') }}</h1>
      </div>
      <Button :label="t('workflows.new')" icon="pi pi-plus" size="small" :loading="creating" @click="create" />
    </header>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="p-4 sm:p-6 grid gap-3">
      <Skeleton v-for="index in 4" :key="index" height="7rem" />
    </div>

    <div v-else-if="items.length" class="divide-y divide-[var(--hairline)]">
      <router-link
        v-for="item in items"
        :key="item.id"
        :to="`/workflows/${item.id}`"
        class="group min-w-0 grid sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-center px-4 sm:px-6 py-5 text-[var(--ink)] no-underline bg-white/20 hover:bg-white/70 transition"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2 mb-2">
            <span :class="[
              'w-2 h-2 rounded-full',
              item.status === 'enabled' ? 'bg-emerald-600' : item.status === 'legacy' ? 'bg-surface-400' : 'bg-amber-500',
            ]" />
            <Tag
              :value="t(`workflows.status.${item.status}`)"
              :severity="item.status === 'enabled' ? 'success' : item.status === 'legacy' ? 'secondary' : 'warn'"
            />
          </div>
          <h2 class="text-base font-semibold m-0">{{ item.name }}</h2>
          <p class="font-mono text-[.65rem] text-surface-500 mt-2 mb-0">
            {{ runSummary(item) }}
          </p>
        </div>
        <span class="inline-flex items-center justify-end gap-2 text-xs font-medium text-surface-500">
          {{ t('workflows.edit') }} <i class="pi pi-chevron-right text-[.65rem]" />
        </span>
      </router-link>
    </div>

    <div v-else class="min-h-[calc(100vh-4rem)] flex items-center justify-center px-6 py-20">
      <div class="max-w-md text-center">
        <span class="w-10 h-10 mx-auto mb-4 rounded-md bg-indigo-600 text-white flex items-center justify-center"><i class="pi pi-sitemap" /></span>
        <h2 class="text-xl mt-0 mb-2">{{ t('workflows.empty') }}</h2>
        <p class="text-surface-500 leading-relaxed mt-0 mb-5">{{ t('workflows.template') }}</p>
        <Button :label="t('workflows.new')" icon="pi pi-plus" :loading="creating" @click="create" />
      </div>
    </div>
  </section>
</template>
