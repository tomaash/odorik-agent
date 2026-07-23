<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import {
  askAssistant,
  getAssistantHistory,
  getAssistantStatus,
  type AssistantMessage,
} from '../api/client'

const { t, tm } = useI18n()
const messages = ref<AssistantMessage[]>([])
const question = ref('')
const loading = ref(true)
const sending = ref(false)
const error = ref('')
const status = ref<{ search?: string; readOnly?: boolean } | null>(null)
const bottom = ref<HTMLElement | null>(null)

const suggestions = computed(() => tm('assistant.suggestions') as string[])

async function scrollToBottom() {
  await nextTick()
  bottom.value?.scrollIntoView({ behavior: 'smooth', block: 'end' })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [history, agentStatus] = await Promise.all([
      getAssistantHistory(),
      getAssistantStatus(),
    ])
    messages.value = history
    status.value = agentStatus
    await scrollToBottom()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
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
    const answer = await askAssistant(text)
    messages.value.push({
      id: answer.messageId,
      role: 'assistant',
      text: answer.answer,
      citations: answer.citations,
      confidence: answer.confidence,
      limitations: answer.limitations,
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') send()
}

onMounted(load)
</script>

<template>
  <section class="min-w-0 max-w-5xl mx-auto pb-32 md:pb-8">
    <header class="min-w-0 grid gap-3 sm:flex sm:items-start sm:justify-between mb-6 sm:mb-8">
      <div class="min-w-0">
        <div class="text-sm font-semibold uppercase tracking-[.14em] text-emerald-700 mb-2">{{ t('assistant.eyebrow') }}</div>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight mb-2 break-words">{{ t('assistant.title') }}</h1>
        <p class="text-surface-500 text-base sm:text-lg leading-relaxed max-w-3xl m-0">{{ t('assistant.subtitle') }}</p>
      </div>
      <div class="flex gap-2 flex-wrap shrink-0">
        <Tag :value="t('assistant.readOnly')" icon="pi pi-lock" severity="success" rounded />
        <Tag
          v-if="status"
          :value="status.search === 'qdrant_hybrid_rrf' ? t('assistant.hybrid') : t('assistant.lexical')"
          icon="pi pi-database"
          severity="secondary"
          rounded
        />
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="mb-5">{{ error }}</Message>
    <div v-if="loading" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else>
      <div v-if="messages.length === 0" class="rounded-3xl border border-surface-200 bg-white/80 p-5 sm:p-8 shadow-sm mb-5">
        <div class="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center mb-4"><i class="pi pi-sparkles text-xl" /></div>
        <p class="text-surface-600 leading-relaxed mt-0 mb-5">{{ t('assistant.empty') }}</p>
        <div class="grid gap-2 sm:grid-cols-3">
          <button
            v-for="suggestion in suggestions"
            :key="suggestion"
            type="button"
            class="text-left rounded-2xl border border-surface-200 bg-white p-4 text-sm leading-relaxed cursor-pointer hover:border-emerald-300 hover:bg-emerald-50 transition"
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
          <div v-if="message.role === 'user'" class="max-w-[90%] sm:max-w-[75%] rounded-3xl rounded-br-lg bg-emerald-800 text-white px-4 py-3 sm:px-5 sm:py-4 shadow-sm">
            <p class="m-0 whitespace-pre-wrap break-words leading-relaxed">{{ message.text }}</p>
          </div>

          <Card v-else class="min-w-0 w-full rounded-3xl border border-surface-200 shadow-sm overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
            <template #title>
              <div class="flex items-center justify-between gap-3 flex-wrap text-base">
                <span class="flex items-center gap-2"><i class="pi pi-sparkles text-emerald-700" />Agent</span>
                <Tag v-if="message.confidence" :value="message.confidence" :severity="message.confidence === 'high' ? 'success' : message.confidence === 'medium' ? 'warn' : 'secondary'" rounded />
              </div>
            </template>
            <template #content>
              <p class="m-0 whitespace-pre-wrap break-words leading-relaxed">{{ message.text }}</p>

              <details v-if="message.citations?.length" class="mt-5 border-t border-surface-100 pt-4">
                <summary class="cursor-pointer font-semibold text-sm text-emerald-800">{{ t('assistant.sources') }} · {{ message.citations.length }}</summary>
                <div class="grid gap-3 mt-3">
                  <div v-for="citation in message.citations" :key="citation.citationId" class="min-w-0 rounded-xl bg-surface-50 border border-surface-200 p-3">
                    <div class="flex items-center gap-2 flex-wrap mb-1.5">
                      <Tag :value="citation.citationId" severity="secondary" rounded />
                      <strong class="text-sm break-words">{{ citation.title }}</strong>
                    </div>
                    <p class="text-sm text-surface-500 leading-relaxed break-words m-0">{{ citation.excerpt }}</p>
                    <code class="block text-xs text-surface-400 break-all mt-2">{{ citation.sourcePath }}</code>
                  </div>
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
        <form class="max-w-5xl mx-auto min-w-0 flex items-end gap-2 rounded-2xl border border-surface-200 bg-white/95 backdrop-blur p-2 sm:p-3 shadow-xl" @submit.prevent="send()">
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
