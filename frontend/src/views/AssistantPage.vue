<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import MarkdownContent from '../components/MarkdownContent.vue'
import SourceCard from '../components/SourceCard.vue'
import {
  askAssistant,
  createAssistantThread,
  forgetAssistantConversation,
  getAssistantConversationData,
  getAssistantHistory,
  getAssistantStatus,
  listAssistantThreads,
  type AssistantMessage,
  type AssistantConversationData,
  type AssistantThread,
} from '../api/client'

const { t, tm } = useI18n()
const route = useRoute()
const router = useRouter()
const messages = ref<AssistantMessage[]>([])
const question = ref('')
const loading = ref(true)
const sending = ref(false)
const error = ref('')
const status = ref<{ search?: string; readOnly?: boolean } | null>(null)
const bottom = ref<HTMLElement | null>(null)
const threads = ref<AssistantThread[]>([])
const activeThreadId = ref('')
const conversationData = ref<AssistantConversationData | null>(null)
const conversationDataLoading = ref(false)
const forgetting = ref(false)

const suggestions = computed(() => tm('assistant.suggestions') as string[])
const activeThread = computed(() => threads.value.find((thread) => thread.id === activeThreadId.value) || null)
const activeExternalSurface = computed(() => {
  const surface = activeThread.value?.surface
  return surface === 'slack_dm' || surface === 'teams_personal' ? surface : null
})

function surfaceLabel(surface?: AssistantThread['surface']) {
  return surface === 'slack_dm'
    ? t('assistant.surfaces.slack')
    : surface === 'teams_personal'
      ? t('assistant.surfaces.teams')
      : t('assistant.surfaces.web')
}

async function reflectActiveThread(threadId: string) {
  if (route.query.thread === threadId) return
  await router.replace({ name: 'ask', query: { thread: threadId } })
}

async function scrollToBottom() {
  await nextTick()
  bottom.value?.scrollIntoView({ behavior: 'smooth', block: 'end' })
}

function formatDate(value?: string | null) {
  if (!value) return t('assistant.notAvailable')
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function loadConversationData(threadId: string) {
  conversationDataLoading.value = true
  try {
    conversationData.value = await getAssistantConversationData(threadId)
  } finally {
    conversationDataLoading.value = false
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [threadList, agentStatus] = await Promise.all([
      listAssistantThreads(),
      getAssistantStatus(),
    ])
    if (threadList.length === 0) threadList.push(await createAssistantThread())
    threads.value = threadList
    const requestedThreadId = typeof route.query.thread === 'string' ? route.query.thread : ''
    activeThreadId.value = threadList.find((thread) => thread.id === requestedThreadId)?.id
      || threadList[0]!.id
    await reflectActiveThread(activeThreadId.value)
    messages.value = await getAssistantHistory(activeThreadId.value)
    await loadConversationData(activeThreadId.value)
    status.value = agentStatus
    await scrollToBottom()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function selectThread(threadId: string) {
  if (threadId === activeThreadId.value || sending.value) return
  loading.value = true
  error.value = ''
  try {
    messages.value = await getAssistantHistory(threadId)
    activeThreadId.value = threadId
    await loadConversationData(threadId)
    await reflectActiveThread(threadId)
    await scrollToBottom()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function newThread() {
  if (sending.value) return
  error.value = ''
  try {
    const thread = await createAssistantThread()
    threads.value = [thread, ...threads.value]
    activeThreadId.value = thread.id
    messages.value = []
    await loadConversationData(thread.id)
    await reflectActiveThread(thread.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function forgetConversation() {
  if (!activeThreadId.value || forgetting.value) return
  if (!window.confirm(t('assistant.forgetConfirm'))) return
  forgetting.value = true
  error.value = ''
  try {
    conversationData.value = await forgetAssistantConversation(activeThreadId.value)
    messages.value = await getAssistantHistory(activeThreadId.value)
    threads.value = await listAssistantThreads()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    forgetting.value = false
  }
}

async function send(value = question.value) {
  const text = value.trim()
  if (!text || sending.value) return
  question.value = ''
  error.value = ''
  messages.value.push({ id: `pending-user-${Date.now()}`, role: 'user', text })
  sending.value = true
  await scrollToBottom()
  try {
    const answer = await askAssistant(text, activeThreadId.value)
    messages.value.push({
      id: answer.messageId,
      role: 'assistant',
      text: answer.answer,
      citations: answer.citations,
      confidence: answer.confidence,
      limitations: answer.limitations,
    })
    threads.value = await listAssistantThreads()
    await loadConversationData(activeThreadId.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}

onMounted(load)
</script>

<template>
  <section class="min-w-0 max-w-5xl mx-auto px-4 sm:px-6 py-7 pb-32 md:pb-8">
    <header class="min-w-0 grid gap-3 sm:flex sm:items-start sm:justify-between mb-6 sm:mb-8">
      <div class="min-w-0">
        <div class="eyebrow mb-2">{{ t('assistant.eyebrow') }}</div>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight mb-2 break-words">{{ t('assistant.title') }}</h1>
        <p class="text-surface-500 text-base sm:text-lg leading-relaxed max-w-3xl m-0">{{ t('assistant.subtitle') }}</p>
      </div>
      <div class="flex gap-2 flex-wrap shrink-0">
        <Tag :value="t('assistant.readOnly')" icon="pi pi-lock" severity="success" rounded />
        <Tag
          v-if="status"
          :value="status.search === 'qdrant_hybrid_rrf' ? t('assistant.hybrid') : t('assistant.unavailable')"
          icon="pi pi-database"
          :severity="status.search === 'qdrant_hybrid_rrf' ? 'secondary' : 'danger'"
          rounded
        />
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="mb-5">{{ error }}</Message>
    <nav
      v-if="threads.length"
      class="mb-5 flex min-w-0 items-center gap-2 overflow-x-auto rounded-lg border border-surface-200 bg-white/70 p-2"
      :aria-label="t('assistant.chats')"
    >
      <Button
        :label="t('assistant.newChat')"
        icon="pi pi-plus"
        size="small"
        class="shrink-0"
        :disabled="sending"
        @click="newThread"
      />
      <button
        v-for="thread in threads"
        :key="thread.id"
        type="button"
        :aria-current="thread.id === activeThreadId ? 'page' : undefined"
        :class="[
          'max-w-56 shrink-0 truncate rounded-md px-3 py-2 text-sm font-medium transition',
          thread.id === activeThreadId
            ? 'bg-surface-950 text-white'
            : 'bg-surface-100 text-surface-700 hover:bg-surface-200',
        ]"
        :disabled="sending"
        @click="selectThread(thread.id)"
      >
        <span class="block truncate">{{ thread.title }}</span>
        <span class="mt-0.5 block truncate text-[.68rem] font-normal opacity-70">{{ surfaceLabel(thread.surface) }}</span>
      </button>
    </nav>
    <Message
      v-if="activeExternalSurface"
      severity="info"
      :closable="false"
      class="mb-5"
    >
      {{ t('assistant.surfaceContinuity', { surface: surfaceLabel(activeExternalSurface) }) }}
    </Message>
    <details class="mb-5 rounded-lg border border-surface-200 bg-white/70 p-4">
      <summary class="cursor-pointer text-sm font-semibold text-surface-800">
        {{ t('assistant.conversationData') }}
      </summary>
      <div v-if="conversationDataLoading" class="mt-4 flex items-center gap-2 text-sm text-surface-500">
        <ProgressSpinner class="!h-4 !w-4" strokeWidth="5" />
        {{ t('assistant.loadingConversationData') }}
      </div>
      <div v-else-if="conversationData" class="mt-4 grid gap-4">
        <p class="m-0 text-sm leading-relaxed text-surface-600">
          {{ t('assistant.retentionExplanation', { days: conversationData.retentionDays }) }}
        </p>
        <dl class="m-0 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div class="flex justify-between gap-3 border-b border-surface-100 py-1.5">
            <dt class="text-surface-500">{{ t('assistant.boundSurface') }}</dt>
            <dd class="m-0 font-medium text-surface-800">{{ surfaceLabel(conversationData.surface) }}</dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-surface-100 py-1.5">
            <dt class="text-surface-500">{{ t('assistant.retainedMessages') }}</dt>
            <dd class="m-0 font-medium text-surface-800">{{ conversationData.retainedMessages }}</dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-surface-100 py-1.5">
            <dt class="text-surface-500">{{ t('assistant.memoryGeneration') }}</dt>
            <dd class="m-0 font-medium text-surface-800">{{ conversationData.memoryGeneration }}</dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-surface-100 py-1.5">
            <dt class="text-surface-500">{{ t('assistant.contentExpires') }}</dt>
            <dd class="m-0 text-right font-medium text-surface-800">{{ formatDate(conversationData.contentExpiresAt) }}</dd>
          </div>
        </dl>
        <Message severity="warn" :closable="false">
          {{ t('assistant.forgetExplanation') }}
        </Message>
        <div>
          <Button
            :label="t('assistant.forgetNow')"
            icon="pi pi-trash"
            severity="danger"
            outlined
            size="small"
            :loading="forgetting"
            :disabled="sending"
            @click="forgetConversation"
          />
        </div>
      </div>
    </details>
    <div v-if="loading" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else>
      <div v-if="messages.length === 0" class="rounded-lg border border-surface-200 bg-white/70 p-5 sm:p-8 mb-5">
        <div class="w-10 h-10 rounded-md bg-surface-950 text-white flex items-center justify-center mb-4 font-semibold">E</div>
        <p class="text-surface-600 leading-relaxed mt-0 mb-5">{{ t('assistant.empty') }}</p>
        <div class="grid gap-2 sm:grid-cols-3">
          <button
            v-for="suggestion in suggestions"
            :key="suggestion"
            type="button"
            class="text-left rounded-md border border-surface-200 bg-white p-4 text-sm leading-relaxed cursor-pointer hover:border-indigo-300 hover:bg-indigo-50 transition"
            @click="send(suggestion)"
          >
            {{ suggestion }}
          </button>
        </div>
      </div>

      <div class="grid gap-4 mb-5">
        <article
          v-for="message in messages"
          :key="message.id"
          :class="['min-w-0 flex', message.role === 'user' ? 'justify-end' : 'justify-start']"
        >
          <div v-if="message.role === 'user'" class="max-w-[90%] sm:max-w-[75%] rounded-lg rounded-br-sm bg-surface-950 text-white px-4 py-3 sm:px-5 sm:py-4">
            <p class="m-0 whitespace-pre-wrap break-words leading-relaxed">{{ message.text }}</p>
          </div>

          <Card v-else class="min-w-0 w-full rounded-lg border border-surface-200 overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>
              <div class="flex items-center justify-between gap-3 flex-wrap text-base">
                <span class="flex items-center gap-2"><span class="w-5 h-5 rounded bg-surface-950 text-white text-[.65rem] flex items-center justify-center">E</span>{{ t('app.agentName') }}</span>
                <Tag v-if="message.confidence" :value="message.confidence" :severity="message.confidence === 'high' ? 'success' : message.confidence === 'medium' ? 'warn' : 'secondary'" rounded />
              </div>
            </template>
            <template #content>
              <MarkdownContent :source="message.text" />

              <details v-if="message.citations?.length" class="mt-5 border-t border-surface-100 pt-4">
                <summary class="cursor-pointer font-semibold text-sm text-indigo-700">{{ t('assistant.sources') }} · {{ message.citations.length }}</summary>
                <div class="grid gap-3 mt-3">
                  <SourceCard
                    v-for="citation in message.citations"
                    :key="citation.citationId"
                    :citation="citation"
                  />
                </div>
              </details>

              <details v-if="message.limitations?.length" class="mt-4">
                <summary class="cursor-pointer font-semibold text-sm text-amber-700">{{ t('assistant.limitations') }} · {{ message.limitations.length }}</summary>
                <ul class="m-0 mt-2 pl-5 text-sm text-surface-500 grid gap-1">
                  <li v-for="limitation in message.limitations" :key="limitation">{{ limitation }}</li>
                </ul>
              </details>
            </template>
          </Card>
        </article>

        <div v-if="sending" class="flex items-center gap-3 text-surface-500 px-2 py-3">
          <ProgressSpinner class="!w-5 !h-5" strokeWidth="5" />
          <span>{{ t('assistant.thinking') }}</span>
        </div>
        <div ref="bottom" />
      </div>

      <div class="fixed md:sticky left-0 right-0 bottom-[4.55rem] md:bottom-4 z-20 px-3 md:px-0">
        <form class="max-w-5xl mx-auto min-w-0 flex items-end gap-2 rounded-lg border border-surface-200 bg-white/95 backdrop-blur p-2 sm:p-3" @submit.prevent="send()">
          <Textarea
            v-model="question"
            :placeholder="t('assistant.placeholder')"
            rows="1"
            autoResize
            fluid
            class="min-w-0 max-h-40 [&_textarea]:max-h-40"
            :disabled="sending"
            @keydown="onKeydown"
          />
          <Button icon="pi pi-arrow-up" type="submit" rounded :aria-label="t('assistant.send')" :loading="sending" :disabled="!question.trim()" class="shrink-0" />
        </form>
      </div>
    </template>
  </section>
</template>
