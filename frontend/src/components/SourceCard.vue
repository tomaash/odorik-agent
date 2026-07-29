<script setup lang="ts">
import { computed } from 'vue'
import Tag from 'primevue/tag'
import type { AssistantCitation } from '../api/client'

const props = defineProps<{
  citation: AssistantCitation
}>()

const adapterId = computed(() => {
  if (props.citation.adapterId) return props.citation.adapterId
  const url = externalUrl.value || ''
  const path = props.citation.sourcePath || ''
  if (url.includes('drive.google.com') || path.includes('drive')) return 'google_drive'
  if (url.includes('calendar.google.com') || path.includes('calendar')) return 'google_calendar'
  if (props.citation.kind === 'call' || props.citation.kind === 'interaction') return 'odorik'
  if (props.citation.kind === 'contact' || props.citation.kind === 'case') return 'crm'
  return 'unknown'
})

const externalUrl = computed(() => {
  if (props.citation.externalUrl) return props.citation.externalUrl
  if (props.citation.artifactRefs?.[0] && props.citation.artifactRefs[0].startsWith('http')) {
    return props.citation.artifactRefs[0]
  }
  return null
})

const internalRoute = computed(() => {
  if (props.citation.internalRoute) return props.citation.internalRoute
  if (props.citation.kind === 'contact') return `/contacts/${props.citation.recordId}`
  if (props.citation.kind === 'case') return `/cases/${props.citation.recordId}`
  if (props.citation.kind === 'call' || props.citation.kind === 'interaction') return '/contacts'
  return null
})

const icon = computed(() => {
  switch (adapterId.value) {
    case 'google_drive':
      return 'pi pi-file'
    case 'google_calendar':
      return 'pi pi-calendar'
    case 'odorik':
      return 'pi pi-phone'
    case 'gmail':
      return 'pi pi-envelope'
    case 'github':
      return 'pi pi-github'
    default:
      if (props.citation.kind === 'contact') return 'pi pi-user'
      if (props.citation.kind === 'case') return 'pi pi-folder'
      if (props.citation.kind === 'task') return 'pi pi-check-square'
      return 'pi pi-file'
  }
})

const badgeLabel = computed(() => {
  switch (adapterId.value) {
    case 'google_drive':
      return 'Google Drive'
    case 'google_calendar':
      return 'Google Calendar'
    case 'odorik':
      return 'Odorik Call'
    case 'gmail':
      return 'Gmail'
    case 'github':
      return 'GitHub'
    default:
      if (props.citation.kind === 'contact') return 'CRM Contact'
      if (props.citation.kind === 'case') return 'CRM Case'
      if (props.citation.kind === 'task') return 'CRM Task'
      if (props.citation.kind === 'context_item') return 'Dokument'
      return props.citation.kind
  }
})

const externalButtonText = computed(() => {
  switch (adapterId.value) {
    case 'google_drive':
      return 'Open in Google Drive'
    case 'google_calendar':
      return 'Open in Google Calendar'
    case 'gmail':
      return 'Open in Gmail'
    case 'github':
      return 'View on GitHub'
    default:
      return 'Open external link'
  }
})

const internalButtonText = computed(() => {
  if (props.citation.kind === 'contact') return 'View Contact'
  if (props.citation.kind === 'case') return 'View Case'
  if (props.citation.kind === 'call' || props.citation.kind === 'interaction') return 'View Call'
  return 'View Record'
})

const formattedDate = computed(() => {
  if (!props.citation.occurredAt) return null
  try {
    const d = new Date(props.citation.occurredAt)
    if (isNaN(d.getTime())) return null
    return new Intl.DateTimeFormat('cs-CZ', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)
  } catch {
    return null
  }
})

const conferenceLink = computed(() => {
  const links = props.citation.metadata?.conferenceLinks
  if (Array.isArray(links) && links[0] && typeof links[0] === 'string') {
    return links[0]
  }
  return null
})
</script>

<template>
  <div class="min-w-0 rounded-2xl bg-white border border-surface-200 p-4 shadow-xs hover:border-emerald-300 transition-colors">
    <!-- Header row -->
    <div class="flex items-center justify-between gap-2 flex-wrap mb-2">
      <div class="flex items-center gap-2">
        <Tag severity="secondary" rounded class="!font-mono !text-xs !px-2">
          {{ citation.citationId }}
        </Tag>
        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-800 border border-emerald-100">
          <i :class="icon" class="text-xs" />
          {{ badgeLabel }}
        </span>
      </div>
      <span v-if="formattedDate" class="text-xs text-surface-400 font-medium">
        {{ formattedDate }}
      </span>
    </div>

    <!-- Title -->
    <strong class="block text-sm font-semibold text-surface-900 leading-snug break-words mb-1.5">
      {{ citation.title }}
    </strong>

    <!-- Clean Excerpt snippet -->
    <p v-if="citation.excerpt" class="text-xs text-surface-600 leading-relaxed break-words m-0 mb-3 line-clamp-3">
      {{ citation.excerpt }}
    </p>

    <!-- Action Links & Buttons -->
    <div class="flex items-center gap-2 flex-wrap pt-1 border-t border-surface-100 mt-2">
      <a
        v-if="externalUrl"
        :href="externalUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 transition-colors no-underline shadow-xs"
      >
        <i class="pi pi-external-link text-xs" />
        {{ externalButtonText }}
      </a>

      <a
        v-if="conferenceLink"
        :href="conferenceLink"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-colors no-underline shadow-xs"
      >
        <i class="pi pi-video text-xs" />
        Join Google Meet
      </a>

      <router-link
        v-if="internalRoute"
        :to="internalRoute"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors no-underline"
      >
        <i class="pi pi-arrow-right text-xs" />
        {{ internalButtonText }}
      </router-link>
    </div>
  </div>
</template>
