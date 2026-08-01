<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Skeleton from 'primevue/skeleton'
import Tag from 'primevue/tag'
import { useAuthStore } from '../stores/auth'
import {
  cancelCodingRun,
  getCodingArtifactDownload,
  getCodingPatchPreview,
  getCodingRun,
  listCodingIssues,
  listCodingRuns,
  requestCodingRunApprovalFromIssue,
  type CodingIssue,
  type CodingRun,
  type CodingRunStatus,
} from '../api/client'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const issues = ref<CodingIssue[]>([])
const runs = ref<CodingRun[]>([])
const selectedRun = ref<CodingRun | null>(null)
const patch = ref('')
const patchTruncated = ref(false)
const loading = ref(true)
const refreshing = ref(false)
const workingId = ref('')
const error = ref('')
let pollTimer: number | null = null

const activeStatuses: CodingRunStatus[] = [
  'queued', 'packaging', 'provisioning', 'running', 'ready_to_publish', 'publishing',
  'cancel_requested',
]
const patchStatuses: CodingRunStatus[] = [
  'ready_to_publish', 'publishing', 'succeeded', 'no_changes', 'outcome_unknown',
]
const hasActiveRuns = computed(() => runs.value.some((run) => activeStatuses.includes(run.status)))
const isAdmin = computed(() => auth.access?.admin === true)

function statusSeverity(status: CodingRunStatus) {
  if (status === 'succeeded') return 'success'
  if (status === 'no_changes' || status === 'cancelled') return 'secondary'
  if (status === 'ready_to_publish' || status === 'publishing' || status === 'outcome_unknown') return 'warn'
  if (status === 'failed') return 'danger'
  if (status === 'cancel_requested') return 'warn'
  return 'info'
}

function statusLabel(status: CodingRunStatus) {
  return t(`coding.status.${status}`)
}

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale.value === 'cs' ? 'cs-CZ' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatBytes(value?: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

async function load(background = false) {
  if (background) refreshing.value = true
  else loading.value = true
  error.value = ''
  try {
    const [nextIssues, nextRuns] = await Promise.all([listCodingIssues(), listCodingRuns()])
    issues.value = nextIssues
    runs.value = nextRuns
    if (selectedRun.value) {
      selectedRun.value = await getCodingRun(selectedRun.value.id)
      if (patchStatuses.includes(selectedRun.value.status) && !patch.value) await loadPatch()
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    refreshing.value = false
    schedulePoll()
  }
}

function schedulePoll() {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
  pollTimer = null
  if (hasActiveRuns.value) pollTimer = window.setTimeout(() => void load(true), 3000)
}

async function implement(issue: CodingIssue) {
  workingId.value = issue.id
  error.value = ''
  try {
    await requestCodingRunApprovalFromIssue(issue.id)
    await router.push({ path: '/tasks', query: { view: 'approvals' } })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    workingId.value = ''
  }
}

async function selectRun(runId: string) {
  workingId.value = runId
  error.value = ''
  patch.value = ''
  patchTruncated.value = false
  try {
    selectedRun.value = await getCodingRun(runId)
    if (patchStatuses.includes(selectedRun.value.status)) await loadPatch()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    workingId.value = ''
  }
}

async function loadPatch() {
  if (!selectedRun.value) return
  const preview = await getCodingPatchPreview(selectedRun.value.id)
  patch.value = preview.patch
  patchTruncated.value = preview.truncated
}

async function cancel() {
  if (!selectedRun.value) return
  workingId.value = selectedRun.value.id
  error.value = ''
  try {
    selectedRun.value = await cancelCodingRun(selectedRun.value.id)
    await load(true)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    workingId.value = ''
  }
}

async function download() {
  if (!selectedRun.value) return
  workingId.value = selectedRun.value.id
  error.value = ''
  try {
    const artifact = await getCodingArtifactDownload(selectedRun.value.id)
    window.location.assign(artifact.url)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    workingId.value = ''
  }
}

onMounted(async () => {
  await load()
  if (typeof route.query.run === 'string') await selectRun(route.query.run)
})
onUnmounted(() => {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
})
</script>

<template>
  <section class="min-h-screen min-w-0">
    <header class="min-h-16 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 border-b border-[var(--hairline)]">
      <div>
        <div class="eyebrow mb-1">{{ t('coding.eyebrow') }}</div>
        <h1 class="m-0 text-sm font-semibold">{{ t('coding.title') }}</h1>
      </div>
      <Button
        :label="t('coding.refresh')"
        icon="pi pi-refresh"
        severity="secondary"
        text
        size="small"
        :loading="refreshing"
        @click="load(true)"
      />
    </header>

    <Message v-if="error" severity="error" :closable="false" class="m-4 sm:m-6">{{ error }}</Message>

    <div v-if="loading" class="p-4 sm:p-6 grid lg:grid-cols-2 gap-4">
      <Skeleton v-for="index in 4" :key="index" height="10rem" />
    </div>

    <div v-else class="grid xl:grid-cols-[minmax(22rem,.85fr)_minmax(28rem,1.4fr)] min-h-[calc(100vh-4rem)]">
      <div class="min-w-0 border-r border-[var(--hairline)]">
        <div class="px-4 sm:px-6 py-4 border-b border-[var(--hairline)]">
          <h2 class="m-0 text-sm font-semibold">{{ t('coding.issues') }}</h2>
          <p class="mt-1 mb-0 text-xs text-surface-500">{{ t('coding.issuesHint') }}</p>
        </div>
        <div v-if="issues.length" class="divide-y divide-[var(--hairline)]">
          <article v-for="issue in issues" :key="issue.id" class="p-4 sm:px-6 bg-white/25">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-mono text-[.65rem] text-indigo-700 mb-1">
                  {{ issue.repository }} · #{{ issue.issueNumber }}
                </div>
                <h3 class="m-0 text-sm font-semibold leading-snug">{{ issue.title.replace(/^\[[^\]]+\]\s*/, '') }}</h3>
                <div v-if="issue.labels.length" class="flex flex-wrap gap-1 mt-2">
                  <Tag v-for="label in issue.labels" :key="label" :value="label" severity="secondary" />
                </div>
              </div>
              <Button
                v-if="isAdmin && !issue.activeRunId && !issue.pendingApprovalId"
                :label="t('coding.implement')"
                icon="pi pi-play"
                size="small"
                :loading="workingId === issue.id"
                @click="implement(issue)"
              />
              <Button
                v-else-if="issue.pendingApprovalId"
                :label="t('coding.reviewApproval')"
                icon="pi pi-shield"
                severity="secondary"
                size="small"
                @click="router.push({ path: '/tasks', query: { view: 'approvals' } })"
              />
              <Button
                v-else-if="issue.activeRunId"
                :label="t('coding.openRun')"
                icon="pi pi-arrow-right"
                severity="secondary"
                text
                size="small"
                @click="selectRun(issue.activeRunId)"
              />
            </div>
          </article>
        </div>
        <div v-else class="p-6 text-sm text-surface-500">{{ t('coding.noIssues') }}</div>

        <div class="px-4 sm:px-6 py-4 border-y border-[var(--hairline)] mt-3">
          <h2 class="m-0 text-sm font-semibold">{{ t('coding.runs') }}</h2>
        </div>
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="w-full text-left p-4 sm:px-6 border-0 border-b border-[var(--hairline)] bg-transparent hover:bg-white/70 cursor-pointer"
          :class="selectedRun?.id === run.id ? '!bg-white' : ''"
          @click="selectRun(run.id)"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium truncate">{{ run.issueSnapshot?.title || `#${run.github.issueNumber}` }}</span>
            <Tag :value="statusLabel(run.status)" :severity="statusSeverity(run.status)" />
          </div>
          <div class="mt-2 font-mono text-[.65rem] text-surface-500">
            {{ run.github.owner }}/{{ run.github.repo }} · {{ formatDate(run.createdAt) }}
          </div>
        </button>
        <div v-if="!runs.length" class="p-6 text-sm text-surface-500">{{ t('coding.noRuns') }}</div>
      </div>

      <div class="min-w-0 p-4 sm:p-6">
        <div v-if="!selectedRun" class="h-full min-h-64 grid place-items-center text-center text-surface-500">
          <div>
            <i class="pi pi-code text-2xl mb-3" />
            <p class="m-0 text-sm">{{ t('coding.selectRun') }}</p>
          </div>
        </div>

        <div v-else class="grid gap-5">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <Tag :value="statusLabel(selectedRun.status)" :severity="statusSeverity(selectedRun.status)" />
              <h2 class="mt-3 mb-1 text-lg font-semibold">{{ selectedRun.issueSnapshot.title }}</h2>
              <a :href="selectedRun.github.issueUrl" target="_blank" rel="noopener" class="text-xs text-indigo-700">
                {{ selectedRun.github.owner }}/{{ selectedRun.github.repo }} #{{ selectedRun.github.issueNumber }}
              </a>
            </div>
            <div class="flex gap-2">
              <Button
                v-if="isAdmin && activeStatuses.includes(selectedRun.status)"
                :label="t('coding.cancel')"
                icon="pi pi-times"
                severity="danger"
                outlined
                size="small"
                :loading="workingId === selectedRun.id"
                @click="cancel"
              />
              <Button
                v-if="['ready_to_publish', 'publishing', 'succeeded', 'no_changes', 'outcome_unknown', 'failed'].includes(selectedRun.status)"
                :label="t('coding.download')"
                icon="pi pi-download"
                severity="secondary"
                outlined
                size="small"
                :loading="workingId === selectedRun.id"
                @click="download"
              />
            </div>
          </div>

          <Message v-if="selectedRun.status === 'ready_to_publish' || selectedRun.status === 'publishing'" severity="info" :closable="false">
            {{ t('coding.publishing') }}
          </Message>
          <Message v-if="selectedRun.status === 'succeeded'" severity="success" :closable="false">
            {{ t('coding.prOpened') }}
            <a
              v-if="selectedRun.publicationResult?.pullRequestUrl"
              :href="selectedRun.publicationResult.pullRequestUrl"
              target="_blank"
              rel="noopener"
              class="ml-1 font-semibold text-emerald-800"
            >{{ t('coding.openPr') }}</a>
          </Message>
          <Message v-if="selectedRun.status === 'no_changes'" severity="secondary" :closable="false">
            {{ t('coding.noChanges') }}
          </Message>
          <Message v-if="selectedRun.status === 'outcome_unknown'" severity="warn" :closable="false">
            {{ t('coding.outcomeUnknown') }}
          </Message>
          <Message v-if="selectedRun.error" severity="error" :closable="false">
            {{ selectedRun.error.message }}
          </Message>

          <div class="grid sm:grid-cols-3 gap-px border border-[var(--hairline)] bg-[var(--hairline)] rounded-md overflow-hidden">
            <div class="bg-white p-3">
              <div class="meta-label text-[.62rem] text-surface-500 uppercase">{{ t('coding.base') }}</div>
              <div class="mt-1 text-xs font-mono break-all">{{ selectedRun.git.baseBranch }} @ {{ selectedRun.git.baseSha?.slice(0, 12) || '—' }}</div>
            </div>
            <div class="bg-white p-3">
              <div class="meta-label text-[.62rem] text-surface-500 uppercase">{{ t('coding.proposedBranch') }}</div>
              <div class="mt-1 text-xs font-mono break-all">{{ selectedRun.git.proposedBranch }}</div>
            </div>
            <div class="bg-white p-3">
              <div class="meta-label text-[.62rem] text-surface-500 uppercase">{{ t('coding.result') }}</div>
              <div class="mt-1 text-xs font-mono">{{ selectedRun.result?.changedFiles ?? '—' }} {{ t('coding.files') }} · {{ formatBytes(selectedRun.result?.patchBytes) }}</div>
            </div>
          </div>

          <div>
            <h3 class="text-sm font-semibold mt-0 mb-3">{{ t('coding.timeline') }}</h3>
            <ol class="m-0 p-0 list-none grid gap-2">
              <li v-for="event in selectedRun.events || []" :key="event.id" class="grid grid-cols-[.65rem_minmax(0,1fr)] gap-3">
                <span class="w-2 h-2 mt-1 rounded-full bg-indigo-500" />
                <div class="pb-3 border-b border-[var(--hairline)]">
                  <div class="text-xs font-medium">{{ event.message }}</div>
                  <div class="mt-1 font-mono text-[.62rem] text-surface-500">{{ event.phase }} · {{ formatDate(event.createdAt) }}</div>
                </div>
              </li>
            </ol>
          </div>

          <div v-if="selectedRun.result?.changedPaths?.length">
            <h3 class="text-sm font-semibold mt-0 mb-2">{{ t('coding.changedFiles') }}</h3>
            <div class="border border-[var(--hairline)] rounded-md divide-y divide-[var(--hairline)] bg-white">
              <div v-for="path in selectedRun.result.changedPaths" :key="path" class="px-3 py-2 text-xs font-mono break-all">{{ path }}</div>
            </div>
          </div>

          <div v-if="patch || patchStatuses.includes(selectedRun.status)">
            <div class="flex items-center justify-between gap-3 mb-2">
              <h3 class="text-sm font-semibold m-0">{{ t('coding.patch') }}</h3>
              <Tag v-if="patchTruncated" :value="t('coding.truncated')" severity="warn" />
            </div>
            <pre class="m-0 max-h-[36rem] overflow-auto p-4 rounded-md bg-[#171716] text-[#efeee9] text-[.72rem] leading-relaxed whitespace-pre-wrap break-words">{{ patch || t('coding.noPatch') }}</pre>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
