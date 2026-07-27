<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import { useAuthStore } from '../stores/auth'
import {
  addOdorikConnection,
  deleteSourceConnection,
  getGoogleCalendars,
  getGoogleDriveFolders,
  getOdorikSetup,
  listSources,
  selectGoogleCalendars,
  selectGoogleDriveFolders,
  setSourceConnectionStatus,
  setSourceResourceEnabled,
  startGoogleCalendarAuthorization,
  startGoogleDriveAuthorization,
  syncGoogleCalendars,
  syncGoogleDrive,
  type SourceAdapter,
  type SourceConnection,
  type SelectableCalendar,
  type SelectableFolder,
  type SourcesResponse,
} from '../api/client'

const { t, locale } = useI18n()
const auth = useAuthStore()
const data = ref<SourcesResponse | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const createdUrl = ref('')
const createdConnectionId = ref('')
const odorikSetupUrls = ref<Record<string, string>>({})
const loadingOdorikSetupId = ref('')
const calendarConnection = ref<SourceConnection | null>(null)
const calendars = ref<SelectableCalendar[]>([])
const selectedCalendarIds = ref<string[]>([])
const loadingCalendars = ref(false)
const driveConnection = ref<SourceConnection | null>(null)
const folders = ref<SelectableFolder[]>([])
const selectedFolders = ref<SelectableFolder[]>([])
const folderSearchQuery = ref('')
const showFolderSearchResults = ref(false)
const currentFolderId = ref<string | null>(null)
const loadingFolders = ref(false)
const searchContainerRef = ref<HTMLElement | null>(null)
const synchronizingId = ref('')
const pendingDeleteId = ref('')
const deletingId = ref('')
const isAdmin = computed(() => auth.access?.admin === true)
const drivePickerVisible = computed({
  get: () => driveConnection.value !== null,
  set: (visible: boolean) => {
    if (!visible) closeDrivePicker()
  },
})
const connectionsByAdapter = computed(() => {
  const grouped = new Map<string, SourceConnection[]>()
  for (const connection of data.value?.connections || []) {
    grouped.set(connection.adapterId, [...(grouped.get(connection.adapterId) || []), connection])
  }
  return grouped
})
const folderById = computed(() => new Map(
  folders.value.map((folder) => [folder.id, folder]),
))
const currentFolder = computed(() => (
  currentFolderId.value ? folderById.value.get(currentFolderId.value) || null : null
))
const currentFolderChildren = computed(() => folders.value.filter(
  (folder) => folder.parentId === currentFolderId.value,
))
const folderBreadcrumbs = computed(() => {
  const breadcrumbs: SelectableFolder[] = []
  const visited = new Set<string>()
  let folder = currentFolder.value
  while (folder && !visited.has(folder.id)) {
    visited.add(folder.id)
    breadcrumbs.unshift(folder)
    folder = folder.parentId ? folderById.value.get(folder.parentId) || null : null
  }
  return breadcrumbs
})
const matchingDriveFolders = computed(() => {
  const query = folderSearchQuery.value.trim().toLocaleLowerCase(locale.value)
  if (!query) return folders.value
  return folders.value.filter((folder) => [
    folder.displayName,
    folder.description || '',
    folder.id,
    folderPath(folder),
  ].some((value) => value.toLocaleLowerCase(locale.value).includes(query)))
})

function formatDate(value?: string | null) {
  if (!value) return t('sources.never')
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function adapterIcon(adapter: SourceAdapter) {
  return {
    odorik: 'pi pi-phone',
    google_calendar: 'pi pi-calendar',
    google_drive: 'pi pi-folder',
    gmail: 'pi pi-envelope',
    github: 'pi pi-github',
  }[adapter.id]
}

function resourceIcon(resourceType: string) {
  return {
    phone_line: 'pi pi-phone',
    calendar: 'pi pi-calendar',
    folder: 'pi pi-folder',
    label: 'pi pi-tag',
    repository: 'pi pi-github',
  }[resourceType] || 'pi pi-database'
}

function resourceName(resource: { externalId: string; displayName: string }) {
  return resource.externalId === 'line:unassigned'
    ? t('sources.unassignedLine')
    : resource.displayName
}

function emptyResourceMessage(connection: SourceConnection) {
  if (connection.adapterId === 'google_calendar') return t('sources.emptyCalendars')
  if (connection.adapterId === 'google_drive') return t('sources.emptyFolders')
  if (connection.adapterId === 'odorik') return t('sources.emptyPhoneLines')
  return t('sources.emptyResources')
}

function connectionStatusLabel(connection: SourceConnection) {
  if (
    connection.adapterId === 'odorik'
    && connection.status === 'active'
    && !connection.lastObservedAt
  ) return t('sources.waitingForRecording')
  if (connection.status === 'active') return t('sources.active')
  if (connection.status === 'attention') return t('sources.attention')
  return t('sources.disconnected')
}

function connectionStatusSeverity(connection: SourceConnection) {
  if (
    connection.adapterId === 'odorik'
    && connection.status === 'active'
    && !connection.lastObservedAt
  ) return 'warn'
  if (connection.status === 'active') return 'success'
  if (connection.status === 'attention') return 'warn'
  return 'secondary'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await listSources()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function createOdorik() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await addOdorikConnection()
    createdUrl.value = result.setupUrl
    createdConnectionId.value = result.connectionId
    odorikSetupUrls.value[result.connectionId] = result.setupUrl
    notice.value = t('sources.created')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function addConnection(adapter: SourceAdapter) {
  if (adapter.id === 'google_calendar') {
    await connectCalendar()
    return
  }
  if (adapter.id === 'google_drive') {
    await connectDrive()
    return
  }
  if (adapter.id === 'odorik') {
    await createOdorik()
  }
}

function canAddConnection(adapter: SourceAdapter) {
  return adapter.available && ['odorik', 'google_calendar', 'google_drive'].includes(adapter.id)
}

async function toggleConnection(connection: SourceConnection) {
  error.value = ''
  try {
    await setSourceConnectionStatus(
      connection.id,
      connection.status === 'disconnected' ? 'active' : 'disconnected',
    )
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function deleteConnection(connection: SourceConnection) {
  deletingId.value = connection.id
  error.value = ''
  notice.value = ''
  try {
    await deleteSourceConnection(connection.id)
    if (calendarConnection.value?.id === connection.id) calendarConnection.value = null
    if (driveConnection.value?.id === connection.id) driveConnection.value = null
    pendingDeleteId.value = ''
    notice.value = t('sources.deleted', { name: connection.accountLabel || connection.displayName })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    deletingId.value = ''
  }
}

async function toggleResource(connection: SourceConnection, resourceId: string, enabled: boolean) {
  error.value = ''
  try {
    await setSourceResourceEnabled(connection.id, resourceId, enabled)
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function copyUrl(url: string) {
  await navigator.clipboard.writeText(url)
  notice.value = t('sources.copied')
}

async function revealOdorikSetup(connection: SourceConnection) {
  loadingOdorikSetupId.value = connection.id
  error.value = ''
  try {
    const result = await getOdorikSetup(connection.id)
    odorikSetupUrls.value[connection.id] = result.setupUrl
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingOdorikSetupId.value = ''
  }
}

async function connectCalendar() {
  error.value = ''
  try {
    const result = await startGoogleCalendarAuthorization()
    window.location.assign(result.authorizationUrl)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function openCalendarPicker(connection: SourceConnection) {
  loadingCalendars.value = true
  error.value = ''
  calendarConnection.value = connection
  calendars.value = []
  await nextTick()
  document.getElementById('calendar-picker')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  try {
    calendars.value = await getGoogleCalendars(connection.id)
    selectedCalendarIds.value = calendars.value
      .filter((calendar) => calendar.selected)
      .map((calendar) => calendar.id)
  } catch (cause) {
    calendarConnection.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingCalendars.value = false
  }
}

function toggleCalendar(calendarId: string) {
  selectedCalendarIds.value = selectedCalendarIds.value.includes(calendarId)
    ? selectedCalendarIds.value.filter((id) => id !== calendarId)
    : [...selectedCalendarIds.value, calendarId]
}

async function saveCalendarSelection() {
  if (!calendarConnection.value) return
  saving.value = true
  error.value = ''
  try {
    await selectGoogleCalendars(calendarConnection.value.id, selectedCalendarIds.value)
    calendarConnection.value = null
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function synchronizeCalendar(connection: SourceConnection) {
  synchronizingId.value = connection.id
  error.value = ''
  try {
    await syncGoogleCalendars(connection.id)
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    synchronizingId.value = ''
  }
}

async function connectDrive() {
  error.value = ''
  try {
    const result = await startGoogleDriveAuthorization()
    window.location.assign(result.authorizationUrl)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function openDrivePicker(connection: SourceConnection) {
  loadingFolders.value = true
  error.value = ''
  driveConnection.value = connection
  folders.value = []
  selectedFolders.value = []
  folderSearchQuery.value = ''
  showFolderSearchResults.value = false
  currentFolderId.value = null
  try {
    folders.value = await getGoogleDriveFolders(connection.id)
    selectedFolders.value = folders.value.filter((folder) => folder.selected)
    showFolderSearchResults.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingFolders.value = false
  }
}

function closeDrivePicker() {
  if (saving.value) return
  driveConnection.value = null
  folders.value = []
  selectedFolders.value = []
  folderSearchQuery.value = ''
  showFolderSearchResults.value = false
  currentFolderId.value = null
}

function folderPath(folder: SelectableFolder) {
  const names: string[] = []
  const visited = new Set<string>()
  let cursor: SelectableFolder | null = folder
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    names.unshift(cursor.displayName)
    cursor = cursor.parentId ? folderById.value.get(cursor.parentId) || null : null
  }
  return names.join(' / ')
}

function navigateToFolder(folderId: string | null) {
  currentFolderId.value = folderId
  showFolderSearchResults.value = false
}

function openSearchFolder(folder: SelectableFolder) {
  navigateToFolder(folder.id)
  folderSearchQuery.value = ''
  showFolderSearchResults.value = false
}

function openFirstSearchFolder() {
  const folder = matchingDriveFolders.value[0]
  if (folder) openSearchFolder(folder)
}

function handleDocumentClick(event: MouseEvent) {
  if (searchContainerRef.value && !searchContainerRef.value.contains(event.target as Node)) {
    showFolderSearchResults.value = false
  }
}

function isFolderSelected(folderId: string) {
  return selectedFolders.value.some((folder) => folder.id === folderId)
}

function toggleFolderSelection(folder: SelectableFolder) {
  selectedFolders.value = isFolderSelected(folder.id)
    ? selectedFolders.value.filter((selected) => selected.id !== folder.id)
    : [...selectedFolders.value, folder]
}

async function saveFolderSelection() {
  if (!driveConnection.value) return
  saving.value = true
  error.value = ''
  try {
    await selectGoogleDriveFolders(
      driveConnection.value.id,
      selectedFolders.value.map((folder) => folder.id),
    )
    driveConnection.value = null
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function synchronizeDrive(connection: SourceConnection) {
  synchronizingId.value = connection.id
  error.value = ''
  try {
    await syncGoogleDrive(connection.id)
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    synchronizingId.value = ''
  }
}

onMounted(async () => {
  document.addEventListener('pointerdown', handleDocumentClick)
  const params = new URLSearchParams(window.location.search)
  const calendarResult = params.get('calendar')
  const driveResult = params.get('drive')
  const authResult = params.get('auth')
  if (calendarResult === 'connected') notice.value = t('sources.calendarConnected')
  else if (calendarResult === 'denied') error.value = t('sources.calendarDenied')
  else if (calendarResult === 'failed' || calendarResult === 'invalid') error.value = t('sources.calendarFailed')
  else if (driveResult === 'connected') notice.value = t('sources.driveConnected')
  else if (driveResult === 'denied') error.value = t('sources.driveDenied')
  else if (driveResult === 'failed' || driveResult === 'invalid') error.value = t('sources.driveFailed')
  else if (authResult === 'denied') error.value = t('sources.googleDenied')
  else if (authResult === 'failed' || authResult === 'invalid') error.value = t('sources.googleFailed')
  await load()
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentClick)
})
</script>

<template>
  <section class="min-w-0">
    <header class="min-w-0 mb-6 sm:mb-8">
      <div class="min-w-0">
        <div class="text-sm font-semibold uppercase tracking-[.14em] text-emerald-700 mb-2">{{ t('sources.eyebrow') }}</div>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight mb-2">{{ t('sources.title') }}</h1>
        <p class="text-surface-500 text-base sm:text-lg leading-relaxed max-w-3xl m-0">{{ t('sources.subtitle') }}</p>
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="mb-4">{{ error }}</Message>
    <Message v-if="notice" severity="success" :closable="true" class="mb-4" @close="notice = ''">{{ notice }}</Message>
    <Message v-if="!isAdmin" severity="info" :closable="false" class="mb-4">{{ t('sources.adminOnly') }}</Message>

    <Card id="calendar-picker" v-if="calendarConnection && isAdmin" class="scroll-mt-4 rounded-3xl border border-emerald-200 shadow-sm mb-6 overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
      <template #title>{{ t('sources.calendarPicker.title') }}</template>
      <template #subtitle>{{ t('sources.calendarPicker.description') }}</template>
      <template #content>
        <div v-if="loadingCalendars" class="flex justify-center py-10"><ProgressSpinner /></div>
        <form v-else class="grid gap-3" @submit.prevent="saveCalendarSelection">
          <label
            v-for="calendar in calendars"
            :key="calendar.id"
            class="min-w-0 flex items-start gap-3 rounded-2xl border border-surface-200 bg-surface-50 p-3.5 cursor-pointer"
          >
            <input
              type="checkbox"
              class="mt-1 w-4 h-4 accent-emerald-700 shrink-0"
              :checked="selectedCalendarIds.includes(calendar.id)"
              @change="toggleCalendar(calendar.id)"
            />
            <span class="min-w-0 grow">
              <span class="flex items-center gap-2 flex-wrap font-semibold">
                {{ calendar.displayName }}
                <Tag v-if="calendar.primary" :value="t('sources.calendarPicker.primary')" severity="success" rounded />
              </span>
              <span v-if="calendar.description" class="block text-sm text-surface-500 mt-1 break-words">{{ calendar.description }}</span>
              <span class="block text-xs text-surface-400 mt-1 break-all">{{ calendar.id }}</span>
            </span>
          </label>
          <p v-if="calendars.length === 0" class="text-sm text-surface-500">{{ t('sources.calendarPicker.none') }}</p>
          <Message severity="warn" :closable="false">{{ t('sources.calendarPicker.privacy') }}</Message>
          <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-1">
            <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="calendarConnection = null" />
            <Button :label="t('sources.calendarPicker.submit')" icon="pi pi-check" type="submit" :loading="saving" />
          </div>
        </form>
      </template>
    </Card>

    <Dialog
      v-model:visible="drivePickerVisible"
      modal
      blockScroll
      dismissableMask
      :draggable="false"
      :header="t('sources.drivePicker.title')"
      class="w-[calc(100vw-2rem)] h-[calc(100dvh-3rem)] sm:w-[min(48rem,calc(100vw-4rem))] sm:h-[calc(100dvh-4rem)] max-w-4xl my-auto"
      contentClass="!p-0 h-full flex flex-col min-h-0 min-w-0 overflow-hidden"
    >
      <div v-if="loadingFolders" class="flex flex-col items-center justify-center gap-3 flex-1 h-full px-4 py-14">
        <ProgressSpinner />
        <p class="m-0 text-sm text-surface-500">{{ t('sources.drivePicker.loading') }}</p>
      </div>

      <form v-else class="flex flex-col h-full min-h-0 min-w-0 flex-1 overflow-hidden" @submit.prevent="saveFolderSelection">
        <div class="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6">
          <div>
            <p class="m-0 text-sm leading-relaxed text-surface-500">
              {{ t('sources.drivePicker.description') }}
            </p>
            <p v-if="driveConnection?.accountLabel" class="m-0 mt-1 text-sm font-medium text-surface-700 break-all">
              {{ driveConnection.accountLabel }}
            </p>
          </div>

          <div ref="searchContainerRef" class="relative z-30 min-w-0 grid gap-2">
            <label for="drive-folder-search" class="text-sm font-semibold text-surface-700">
              {{ t('sources.drivePicker.searchLabel') }}
            </label>
            <div class="relative min-w-0">
              <InputText
                id="drive-folder-search"
                v-model="folderSearchQuery"
                fluid
                autocomplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="drive-folder-search-results"
                :aria-expanded="showFolderSearchResults"
                :placeholder="t('sources.drivePicker.searchPlaceholder')"
                @focus="showFolderSearchResults = true"
                @keydown.enter.prevent="openFirstSearchFolder"
                @keydown.escape="showFolderSearchResults = false"
              />
              <div
                v-if="showFolderSearchResults"
                id="drive-folder-search-results"
                role="listbox"
                class="absolute left-0 right-0 top-[100%] mt-1.5 z-50 max-h-60 overflow-y-auto rounded-2xl border border-surface-200 bg-white shadow-xl ring-1 ring-black/5"
              >
                <button
                  v-for="folder in matchingDriveFolders"
                  :key="folder.id"
                  type="button"
                  role="option"
                  :aria-selected="currentFolderId === folder.id"
                  class="flex min-h-14 w-full min-w-0 items-center gap-3 border-b border-surface-100 px-3 py-2 text-left last:border-b-0 hover:bg-surface-50 focus:bg-surface-50 focus:outline-none"
                  @click="openSearchFolder(folder)"
                >
                  <i class="pi pi-folder shrink-0 text-emerald-700" />
                  <span class="min-w-0 grow">
                    <span class="block truncate text-sm font-semibold text-surface-800">{{ folder.displayName }}</span>
                    <span class="block truncate text-xs text-surface-500">{{ folderPath(folder) }}</span>
                  </span>
                  <Tag
                    v-if="folder.shared"
                    :value="t('sources.drivePicker.shared')"
                    severity="info"
                    rounded
                    class="hidden shrink-0 sm:inline-flex"
                  />
                </button>
                <div v-if="matchingDriveFolders.length === 0" class="px-4 py-6 text-center text-sm text-surface-500">
                  {{ folders.length === 0 ? t('sources.drivePicker.none') : t('sources.drivePicker.noMatches') }}
                </div>
              </div>
            </div>
          </div>

          <nav class="flex min-w-0 items-center gap-1 overflow-x-auto pb-1" :aria-label="t('sources.drivePicker.breadcrumbs')">
            <button
              type="button"
              class="min-h-10 shrink-0 rounded-xl px-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
              @click="navigateToFolder(null)"
            >
              <i class="pi pi-home mr-1" />
              {{ t('sources.drivePicker.root') }}
            </button>
            <template v-for="folder in folderBreadcrumbs" :key="folder.id">
              <i class="pi pi-angle-right shrink-0 text-xs text-surface-400" />
              <button
                type="button"
                class="min-h-10 max-w-44 shrink-0 truncate rounded-xl px-2 text-sm font-semibold text-surface-700 hover:bg-surface-100"
                @click="navigateToFolder(folder.id)"
              >
                {{ folder.displayName }}
              </button>
            </template>
          </nav>

          <label
            v-if="currentFolder"
            class="flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2.5"
          >
            <input
              type="checkbox"
              class="h-5 w-5 shrink-0 accent-emerald-700"
              :checked="isFolderSelected(currentFolder.id)"
              @change="toggleFolderSelection(currentFolder)"
            />
            <span class="min-w-0 grow">
              <span class="block text-sm font-semibold text-emerald-950">
                {{ t('sources.drivePicker.includeCurrent') }}
              </span>
              <span class="block truncate text-xs text-emerald-800">{{ currentFolder.displayName }}</span>
            </span>
          </label>

          <div class="flex-1 flex flex-col min-h-[16rem] min-w-0">
            <div class="mb-2 flex shrink-0 items-center justify-between gap-3">
              <h3 class="m-0 text-sm font-semibold text-surface-800">
                {{ currentFolder ? t('sources.drivePicker.subfolders') : t('sources.drivePicker.topLevel') }}
              </h3>
              <Button
                v-if="currentFolder"
                :label="t('sources.drivePicker.back')"
                icon="pi pi-arrow-left"
                severity="secondary"
                text
                size="small"
                type="button"
                @click="navigateToFolder(currentFolder.parentId)"
              />
            </div>

            <div class="flex-1 min-h-[14rem] overflow-y-auto rounded-2xl border border-surface-200 bg-white">
              <div
                v-for="folder in currentFolderChildren"
                :key="folder.id"
                class="flex min-h-14 items-stretch border-b border-surface-100 last:border-b-0 hover:bg-surface-50/50"
              >
                <label class="flex w-12 shrink-0 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    class="h-5 w-5 accent-emerald-700"
                    :checked="isFolderSelected(folder.id)"
                    :aria-label="t('sources.drivePicker.selectFolder', { name: folder.displayName })"
                    @change="toggleFolderSelection(folder)"
                  />
                </label>
                <button
                  type="button"
                  class="flex min-w-0 grow items-center gap-3 px-1 py-2.5 pr-3 text-left hover:bg-surface-50"
                  @click="navigateToFolder(folder.id)"
                >
                  <i class="pi pi-folder shrink-0 text-emerald-700" />
                  <span class="min-w-0 grow truncate text-sm font-semibold text-surface-800">
                    {{ folder.displayName }}
                  </span>
                  <Tag
                    v-if="folder.shared"
                    :value="t('sources.drivePicker.shared')"
                    severity="info"
                    rounded
                    class="hidden shrink-0 sm:inline-flex"
                  />
                  <i class="pi pi-angle-right shrink-0 text-surface-400" />
                </button>
              </div>
              <div
                v-if="currentFolderChildren.length === 0"
                class="flex h-full min-h-[14rem] flex-col items-center justify-center p-8 text-center"
              >
                <i class="pi pi-folder-open text-3xl text-surface-300 mb-2" />
                <p class="m-0 text-sm font-medium text-surface-500">{{ t('sources.drivePicker.emptyLevel') }}</p>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3 rounded-2xl bg-surface-50 px-4 py-3">
            <span class="text-sm text-surface-600">{{ t('sources.drivePicker.selected') }}</span>
            <Tag :value="String(selectedFolders.length)" severity="success" rounded />
          </div>

          <Message severity="warn" :closable="false">{{ t('sources.drivePicker.privacy') }}</Message>
        </div>

        <div class="shrink-0 flex flex-col-reverse gap-2 border-t border-surface-200 bg-white px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            type="button"
            :disabled="saving"
            @click="closeDrivePicker"
          />
          <Button
            :label="t('sources.drivePicker.submit')"
            icon="pi pi-check"
            type="submit"
            :loading="saving"
          />
        </div>
      </form>
    </Dialog>

    <div v-if="loading" class="flex justify-center py-24"><ProgressSpinner /></div>

    <div v-else class="grid gap-5 lg:grid-cols-2">
      <Card
        v-for="adapter in data?.adapters"
        :key="adapter.id"
        class="min-w-0 rounded-3xl border border-surface-200 shadow-sm overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6"
      >
        <template #title>
          <div class="min-w-0 flex items-start justify-between gap-3">
            <div class="min-w-0 flex items-center gap-3">
              <span class="w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-800 flex items-center justify-center shrink-0">
                <i :class="[adapterIcon(adapter), 'text-lg']" />
              </span>
              <div class="min-w-0">
                <div class="truncate">{{ adapter.name }}</div>
                <div class="text-xs font-normal text-surface-400 mt-0.5">
                  {{ connectionsByAdapter.get(adapter.id)?.length || 0 }}
                  {{ (connectionsByAdapter.get(adapter.id)?.length || 0) === 1 ? t('sources.connection') : t('sources.connections') }}
                </div>
              </div>
            </div>
            <Tag
              :value="adapter.id === 'odorik' ? t('sources.receivesRecordings') : adapter.availability === 'available' ? t('sources.readOnly') : adapter.availability === 'needs_configuration' ? t('sources.needsConfiguration') : t('sources.planned')"
              :severity="adapter.availability === 'available' ? 'success' : 'secondary'"
              rounded
            />
          </div>
        </template>
        <template #subtitle><span class="leading-relaxed">{{ t(`sources.adapters.${adapter.id}`) }}</span></template>
        <template #content>
          <div
            v-if="isAdmin && adapter.id === 'odorik' && canAddConnection(adapter)"
            class="min-w-0 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 mb-4"
          >
            <div class="flex items-start gap-3">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-800 shadow-xs">
                <i class="pi pi-arrow-right-arrow-left" />
              </span>
              <div class="min-w-0 grow">
                <div class="font-semibold text-sm text-emerald-950">{{ t('sources.odorikSetup.title') }}</div>
                <p class="text-xs text-emerald-900/75 mt-1 mb-0 leading-relaxed">{{ t('sources.odorikSetup.description') }}</p>
              </div>
            </div>
            <ol class="grid gap-2 my-4 pl-0 list-none text-sm text-emerald-950">
              <li class="flex items-start gap-2">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-[.65rem] font-bold text-white">1</span>
                <span>{{ t('sources.odorikSetup.createStep') }}</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-[.65rem] font-bold text-white">2</span>
                <span>{{ t('sources.odorikSetup.pasteStep') }}</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-[.65rem] font-bold text-white">3</span>
                <span>{{ t('sources.odorikSetup.recordStep') }}</span>
              </li>
            </ol>
            <Button
              :label="t('sources.odorikSetup.createButton')"
              icon="pi pi-plus"
              class="w-full"
              :loading="saving"
              @click="addConnection(adapter)"
            />
          </div>

          <div
            v-else-if="isAdmin && canAddConnection(adapter)"
            class="min-w-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 p-3.5 sm:p-4 mb-4"
          >
            <div class="min-w-0">
              <div class="font-semibold text-sm text-emerald-950">{{ t('sources.multipleAccounts') }}</div>
              <div class="text-xs text-emerald-800/80 mt-1 leading-relaxed">{{ t('sources.multipleAccountsHint') }}</div>
            </div>
            <Button
              :label="t('sources.addAccount')"
              icon="pi pi-plus"
              class="w-full sm:w-auto shrink-0"
              @click="addConnection(adapter)"
            />
          </div>

          <div
            v-if="adapter.id === 'odorik' && createdUrl"
            class="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 sm:p-5 mb-4"
          >
            <div class="flex items-start gap-3 mb-3">
              <i class="pi pi-check-circle mt-0.5 text-lg text-emerald-700" />
              <div>
                <div class="text-sm font-semibold text-emerald-950">{{ t('sources.odorikSetup.readyTitle') }}</div>
                <p class="m-0 mt-1 text-xs leading-relaxed text-emerald-900/75">{{ t('sources.odorikSetup.readyDescription') }}</p>
              </div>
            </div>
            <div class="min-w-0 flex flex-col sm:flex-row gap-2">
              <code class="min-w-0 grow rounded-xl bg-white border border-emerald-200 p-3 text-xs break-all">{{ createdUrl }}</code>
              <Button :label="t('common.copy')" icon="pi pi-copy" severity="secondary" @click="copyUrl(createdUrl)" />
            </div>
            <p class="m-0 mt-2 text-xs text-emerald-900/70">
              <i class="pi pi-lock mr-1" />
              {{ t('sources.odorikSetup.secretHint') }}
            </p>
          </div>

          <div v-if="connectionsByAdapter.get(adapter.id)?.length" class="grid gap-4">
            <article
              v-for="connection in connectionsByAdapter.get(adapter.id)"
              :key="connection.id"
              :class="[
                'min-w-0 rounded-2xl border bg-surface-50 p-3.5 sm:p-4',
                createdConnectionId === connection.id ? 'border-emerald-300 ring-2 ring-emerald-100' : 'border-surface-200',
              ]"
            >
              <div class="min-w-0 flex items-start justify-between gap-3 mb-3">
                <div class="min-w-0">
                  <h3 class="text-base font-semibold m-0 break-words">{{ connection.displayName }}</h3>
                  <p v-if="connection.accountLabel" class="text-sm text-surface-500 mt-1 mb-0 break-words">{{ connection.accountLabel }}</p>
                </div>
                <Tag
                  :value="connectionStatusLabel(connection)"
                  :severity="connectionStatusSeverity(connection)"
                  rounded
                />
              </div>

              <dl class="grid grid-cols-2 gap-2 text-sm m-0 mb-3">
                <div class="rounded-xl bg-white border border-surface-200 p-3">
                  <dt class="text-xs text-surface-400">{{ t('sources.items') }}</dt>
                  <dd class="font-semibold mt-1 ml-0">{{ connection.itemCount }}</dd>
                </div>
                <div class="rounded-xl bg-white border border-surface-200 p-3">
                  <dt class="text-xs text-surface-400">{{ t('sources.lastObserved') }}</dt>
                  <dd class="font-semibold text-xs mt-1 ml-0 break-words">{{ formatDate(connection.lastObservedAt) }}</dd>
                </div>
              </dl>

              <div
                v-if="connection.adapterId === 'odorik'"
                class="mb-4 rounded-xl border border-surface-200 bg-white p-3"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-sm font-semibold text-surface-800">{{ t('sources.odorikSetup.connectionTitle') }}</div>
                    <p class="m-0 mt-1 text-xs leading-relaxed text-surface-500">
                      {{ t('sources.odorikSetup.connectionDescription') }}
                    </p>
                  </div>
                  <Button
                    v-if="isAdmin && connection.credentialMode === 'encrypted' && !odorikSetupUrls[connection.id]"
                    :label="t('sources.odorikSetup.showButton')"
                    icon="pi pi-eye"
                    severity="secondary"
                    outlined
                    size="small"
                    class="shrink-0"
                    :loading="loadingOdorikSetupId === connection.id"
                    @click="revealOdorikSetup(connection)"
                  />
                </div>
                <div v-if="odorikSetupUrls[connection.id]" class="min-w-0 flex items-stretch gap-2 mt-3">
                  <code class="min-w-0 grow rounded-xl bg-surface-50 border border-surface-200 p-2.5 text-[.7rem] break-all">{{ odorikSetupUrls[connection.id] }}</code>
                  <Button
                    icon="pi pi-copy"
                    severity="secondary"
                    outlined
                    :aria-label="t('common.copy')"
                    @click="copyUrl(odorikSetupUrls[connection.id]!)"
                  />
                </div>
                <p v-if="connection.credentialMode === 'legacy_secret'" class="m-0 mt-2 text-xs text-surface-400">
                  {{ t('sources.odorikSetup.legacyHint') }}
                </p>
              </div>

              <div class="text-xs font-semibold uppercase tracking-[.12em] text-surface-400 mb-2">
                {{ t('sources.accountSetup') }}
              </div>
              <div class="grid gap-2">
                <div
                  v-for="resource in connection.resources"
                  :key="resource.id"
                  class="min-w-0 flex items-center justify-between gap-3 rounded-xl bg-white border border-surface-200 p-3"
                >
                  <div class="min-w-0 flex items-center gap-2.5">
                    <i :class="[resourceIcon(resource.resourceType), 'text-emerald-700 shrink-0']" />
                    <div class="min-w-0">
                      <div class="font-medium text-sm truncate">{{ resourceName(resource) }}</div>
                      <div class="text-xs text-surface-400">{{ resource.itemCount }} {{ t('sources.items') }}</div>
                    </div>
                  </div>
                  <Button
                    v-if="isAdmin"
                    :label="resource.status === 'enabled' ? t('sources.pause') : t('sources.resume')"
                    :icon="resource.status === 'enabled' ? 'pi pi-minus-circle' : 'pi pi-check-circle'"
                    :severity="resource.status === 'enabled' ? 'secondary' : 'success'"
                    text
                    size="small"
                    @click="toggleResource(connection, resource.id, resource.status !== 'enabled')"
                  />
                  <Tag v-else :value="resource.status === 'enabled' ? t('sources.enabled') : t('sources.disabled')" severity="secondary" />
                </div>
                <p v-if="connection.resources.length === 0" class="text-sm text-surface-400 m-0">
                  {{ emptyResourceMessage(connection) }}
                </p>
              </div>

              <div v-if="isAdmin" class="flex flex-wrap justify-end mt-3">
                <Button
                  v-if="connection.adapterId === 'google_calendar' && connection.status !== 'disconnected'"
                  :label="t('sources.chooseCalendars')"
                  icon="pi pi-list-check"
                  severity="secondary"
                  text
                  size="small"
                  @click="openCalendarPicker(connection)"
                />
                <Button
                  v-if="connection.adapterId === 'google_calendar' && connection.status !== 'disconnected'"
                  :label="synchronizingId === connection.id ? t('sources.syncing') : t('sources.syncNow')"
                  icon="pi pi-refresh"
                  severity="secondary"
                  text
                  size="small"
                  :loading="synchronizingId === connection.id"
                  @click="synchronizeCalendar(connection)"
                />
                <Button
                  v-if="connection.adapterId === 'google_drive' && connection.status !== 'disconnected'"
                  :label="t('sources.chooseFolders')"
                  icon="pi pi-list-check"
                  severity="secondary"
                  text
                  size="small"
                  @click="openDrivePicker(connection)"
                />
                <Button
                  v-if="connection.adapterId === 'google_drive' && connection.status !== 'disconnected'"
                  :label="synchronizingId === connection.id ? t('sources.syncing') : t('sources.syncNow')"
                  icon="pi pi-refresh"
                  severity="secondary"
                  text
                  size="small"
                  :loading="synchronizingId === connection.id"
                  @click="synchronizeDrive(connection)"
                />
                <Button
                  :label="connection.status === 'disconnected' ? t('sources.reconnect') : t('sources.disconnect')"
                  :icon="connection.status === 'disconnected' ? 'pi pi-link' : 'pi pi-power-off'"
                  severity="secondary"
                  text
                  size="small"
                  @click="toggleConnection(connection)"
                />
                <Button
                  :label="t('sources.deleteConnection')"
                  icon="pi pi-trash"
                  severity="danger"
                  text
                  size="small"
                  @click="pendingDeleteId = connection.id"
                />
              </div>

              <div
                v-if="pendingDeleteId === connection.id"
                role="alert"
                class="mt-3 rounded-2xl border border-red-200 bg-red-50 p-3.5 sm:p-4"
              >
                <div class="font-semibold text-red-950">
                  {{ t('sources.deleteConfirmTitle', { name: connection.accountLabel || connection.displayName }) }}
                </div>
                <p class="text-sm text-red-900/80 leading-relaxed my-2">{{ t('sources.deleteConfirmDescription') }}</p>
                <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <Button
                    :label="t('common.cancel')"
                    severity="secondary"
                    text
                    :disabled="deletingId === connection.id"
                    @click="pendingDeleteId = ''"
                  />
                  <Button
                    :label="t('sources.deletePermanently')"
                    icon="pi pi-trash"
                    severity="danger"
                    :loading="deletingId === connection.id"
                    @click="deleteConnection(connection)"
                  />
                </div>
              </div>
            </article>
          </div>
          <div v-else-if="adapter.availability !== 'available'" class="rounded-2xl bg-surface-50 border border-dashed border-surface-300 p-4 text-sm text-surface-500">
            {{ adapter.availability === 'needs_configuration' ? t('sources.needsConfiguration') : t('sources.planned') }}
          </div>
        </template>
      </Card>
    </div>
  </section>
</template>
