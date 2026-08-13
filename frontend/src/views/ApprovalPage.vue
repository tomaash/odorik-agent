<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Skeleton from 'primevue/skeleton'
import ApprovalCard from '../components/ApprovalCard.vue'
import { useAuthStore } from '../stores/auth'
import {
  approveAction,
  getActionApproval,
  reconcileMailDraftApproval,
  rejectAction,
  type ActionApprovalItem,
} from '../api/client'

const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()
const approval = ref<ActionApprovalItem | null>(null)
const loading = ref(true)
const processing = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    approval.value = await getActionApproval(String(route.params.id))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function act(operation: () => Promise<unknown>) {
  processing.value = true
  error.value = ''
  try {
    await operation()
    approval.value = await getActionApproval(String(route.params.id))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    processing.value = false
  }
}

function approve(item: ActionApprovalItem) {
  return act(() => approveAction(item.id))
}

function reject(item: ActionApprovalItem, note?: string) {
  return act(() => rejectAction(item.id, note))
}

function reconcile(item: ActionApprovalItem) {
  return act(() => reconcileMailDraftApproval(item.id))
}

onMounted(load)
</script>

<template>
  <main class="min-w-0 max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
    <div class="mb-5">
      <router-link to="/tasks?view=approvals" class="inline-flex items-center gap-1 text-sm font-semibold text-indigo-700 no-underline">
        <i class="pi pi-arrow-left text-xs" />{{ t('approvals.backToWork') }}
      </router-link>
      <p class="eyebrow !text-violet-700 mt-6 mb-2">{{ t('approvals.deepLinkEyebrow') }}</p>
      <h1 class="text-2xl sm:text-3xl font-semibold m-0">{{ t('approvals.deepLinkTitle') }}</h1>
      <p class="text-surface-500 mt-2 mb-0">{{ t('approvals.deepLinkSubtitle') }}</p>
    </div>

    <Message v-if="error" severity="error" :closable="false" class="mb-4">{{ error }}</Message>
    <div v-if="loading" class="grid gap-2">
      <Skeleton height="18rem" />
    </div>
    <div v-else-if="approval" class="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
      <ApprovalCard
        :approval="approval"
        :currentUid="auth.user?.uid"
        :processing="processing"
        @approve="approve"
        @reject="reject"
        @reconcile="reconcile"
      />
    </div>
    <Button v-else :label="t('common.retry')" icon="pi pi-refresh" severity="secondary" outlined @click="load" />
  </main>
</template>
