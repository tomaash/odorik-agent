<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
  setSourceCapabilityStatus,
  setSourceConnectionStatus,
  setSourceResourceEnabled,
  startGoogleWorkspaceAuthorization,
  syncGoogleCalendars,
  syncGoogleDrive,
  type SourceCapabilityDescriptor,
  type SourceCapabilityId,
  type SourceConnector,
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
const workspaceDialogVisible = ref(false)
const workspaceConnection = ref<SourceConnection | null>(null)
const selectedWorkspaceCapabilities = ref<Array<'context.calendar.read' | 'context.document.read'>>([
  'context.calendar.read',
  'context.document.read',
])
const pendingDeleteId = ref('')
const deletingId = ref('')
const isAdmin = computed(() => auth.access?.admin === true)
// Every choice that belongs to a source card opens as a modal over that card.
// Nothing configuration-related renders alongside or above the card grid.
const drivePickerVisible = computed({
  get: () => driveConnection.value !== null,
  set: (visible: boolean) => {
    if (!visible) closeDrivePicker()
  },
})
const calendarPickerVisible = computed({
  get: () => calendarConnection.value !== null,
  set: (visible: boolean) => {
    if (!visible) closeCalendarPicker()
  },
})
const pendingDeleteConnection = computed(() => (
  data.value?.connections.find((connection) => connection.id === pendingDeleteId.value) || null
))
const deleteConfirmVisible = computed({
  get: () => pendingDeleteConnection.value !== null,
  set: (visible: boolean) => {
    if (!visible && !deletingId.value) pendingDeleteId.value = ''
  },
})
const connectionsByConnector = computed(() => {
  const grouped = new Map<string, SourceConnection[]>()
  for (const connection of data.value?.connections || []) {
    grouped.set(connection.connectorId, [...(grouped.get(connection.connectorId) || []), connection])
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

function connectorIcon(connector: SourceConnector) {
  return {
    odorik: 'pi pi-phone',
    google_workspace: 'pi pi-google',
  }[connector.id]
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

function capabilityConfiguration(
  connection: SourceConnection,
  descriptor: SourceCapabilityDescriptor,
) {
  return connection.capabilities.find(
    (capability) => capability.capabilityId === descriptor.id,
  )
}

function capabilityResources(
  connection: SourceConnection,
  capabilityId: string,
) {
  return connection.resources.filter((resource) => resource.capabilityId === capabilityId)
}

function capabilityName(capabilityId: string) {
  return t(`sources.capabilities.${capabilityId}.name`)
}

function capabilityDescription(capabilityId: string) {
  return t(`sources.capabilities.${capabilityId}.description`)
}

function capabilityStatusLabel(status?: string) {
  if (status === 'active') return t('sources.enabled')
  if (status === 'reauthorization_required') return t('sources.reauthorize.title')
  if (status === 'attention') return t('sources.attention')
  return t('sources.notEnabled')
}

function capabilityStatusSeverity(status?: string) {
  if (status === 'active') return 'success'
  if (status === 'attention' || status === 'reauthorization_required') return 'warn'
  return 'secondary'
}

function scopeLabel(scope: string) {
  return {
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly': t('sources.scopes.calendarList'),
    'https://www.googleapis.com/auth/calendar.events.readonly': t('sources.scopes.calendarEvents'),
    'https://www.googleapis.com/auth/drive.readonly': t('sources.scopes.drive'),
  }[scope] || scope
}

function emptyResourceMessage(capabilityId: string) {
  if (capabilityId === 'context.calendar.read') return t('sources.emptyCalendars')
  if (capabilityId === 'context.document.read') return t('sources.emptyFolders')
  if (capabilityId === 'context.call.read') return t('sources.emptyPhoneLines')
  return t('sources.emptyResources')
}

function connectionStatusLabel(connection: SourceConnection) {
  if (
    connection.connectorId === 'odorik'
    && connection.status === 'active'
    && !connection.lastObservedAt
  ) return t('sources.waitingForRecording')
  if (connection.status === 'active') return t('sources.active')
  if (connection.status === 'attention') return t('sources.attention')
  return t('sources.disconnected')
}

function connectionStatusSeverity(connection: SourceConnection) {
  if (
    connection.connectorId === 'odorik'
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

async function addConnection(connector: SourceConnector) {
  if (connector.id === 'google_workspace') {
    openWorkspaceAuthorization()
    return
  }
  if (connector.id === 'odorik') {
    await createOdorik()
  }
}

function canAddConnection(connector: SourceConnector) {
  return connector.availability === 'available'
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

async function toggleCapability(
  connection: SourceConnection,
  capabilityId: SourceCapabilityId,
  enabled: boolean,
) {
  if (capabilityId === 'context.call.read') return
  error.value = ''
  try {
    await setSourceCapabilityStatus(connection.id, capabilityId, enabled)
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

function openWorkspaceAuthorization(
  connection: SourceConnection | null = null,
  capabilityId?: SourceCapabilityId,
) {
  if (capabilityId === 'context.call.read') return
  workspaceConnection.value = connection
  selectedWorkspaceCapabilities.value = capabilityId
    ? [capabilityId]
    : connection
      ? connection.capabilities
        .filter((capability) => capability.status !== 'disabled')
        .map((capability) => capability.capabilityId)
        .filter((id): id is 'context.calendar.read' | 'context.document.read' => id !== 'context.call.read')
      : ['context.calendar.read', 'context.document.read']
  workspaceDialogVisible.value = true
}

function toggleWorkspaceCapability(
  capabilityId: 'context.calendar.read' | 'context.document.read',
) {
  selectedWorkspaceCapabilities.value = selectedWorkspaceCapabilities.value.includes(capabilityId)
    ? selectedWorkspaceCapabilities.value.filter((id) => id !== capabilityId)
    : [...selectedWorkspaceCapabilities.value, capabilityId]
}

async function connectWorkspace() {
  if (selectedWorkspaceCapabilities.value.length === 0) return
  saving.value = true
  error.value = ''
  try {
    const result = await startGoogleWorkspaceAuthorization(
      selectedWorkspaceCapabilities.value,
      workspaceConnection.value?.id,
    )
    window.location.assign(result.authorizationUrl)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    saving.value = false
  }
}

async function openCalendarPicker(connection: SourceConnection) {
  loadingCalendars.value = true
  error.value = ''
  calendarConnection.value = connection
  calendars.value = []
  selectedCalendarIds.value = []
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
  synchronizingId.value = `${connection.id}:calendar`
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

function closeCalendarPicker() {
  if (saving.value) return
  calendarConnection.value = null
  calendars.value = []
  selectedCalendarIds.value = []
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
  synchronizingId.value = `${connection.id}:drive`
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
  const workspaceResult = params.get('workspace')
  await load()
  if (workspaceResult === 'connected') notice.value = t('sources.workspaceConnected')
  else if (workspaceResult === 'partial') error.value = t('sources.workspacePartial')
  else if (workspaceResult === 'denied') error.value = t('sources.googleDenied')
  else if (workspaceResult === 'failed' || workspaceResult === 'invalid') error.value = t('sources.googleFailed')
  if (workspaceResult) window.history.replaceState({}, '', window.location.pathname)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentClick)
})
</script>

<template>
  <section class="min-w-0 px-4 sm:px-6 py-7">
    <header class="min-w-0 mb-6 sm:mb-8">
      <div class="min-w-0">
        <div class="eyebrow mb-2">{{ t('sources.eyebrow') }}</div>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight leading-tight mb-2">{{ t('sources.title') }}</h1>
        <p class="text-surface-500 text-base sm:text-lg leading-relaxed max-w-3xl m-0">{{ t('sources.subtitle') }}</p>
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false" class="mb-4">{{ error }}</Message>
    <Message v-if="notice" severity="success" :closable="true" class="mb-4" @close="notice = ''">{{ notice }}</Message>
    <Message v-if="!isAdmin" severity="info" :closable="false" class="mb-4">{{ t('sources.adminOnly') }}</Message>

    <Dialog
      v-model:visible="workspaceDialogVisible"
      modal
      blockScroll
      :draggable="false"
      :header="workspaceConnection ? t('sources.workspace.enableTitle') : t('sources.workspace.connectTitle')"
      class="w-[calc(100vw-2rem)] sm:w-[min(36rem,calc(100vw-4rem))] my-auto"
      contentClass="!p-0 flex flex-col min-w-0 overflow-hidden"
    >
      <form @submit.prevent="connectWorkspace">
        <div class="grid gap-3 px-4 py-4 sm:px-6">
          <p class="m-0 text-sm leading-relaxed text-surface-500">
            {{ t('sources.workspace.chooseDescription') }}
          </p>
          <p v-if="workspaceConnection?.accountLabel" class="m-0 text-sm font-semibold text-surface-800 break-all">
            {{ workspaceConnection.accountLabel }}
          </p>
          <label
            v-for="capabilityId in (['context.calendar.read', 'context.document.read'] as const)"
            :key="capabilityId"
            class="flex cursor-pointer items-start gap-3 rounded-2xl border border-surface-200 bg-surface-50 p-4"
          >
            <input
              type="checkbox"
              class="mt-1 h-5 w-5 shrink-0 accent-emerald-700"
              :checked="selectedWorkspaceCapabilities.includes(capabilityId)"
              :disabled="Boolean(workspaceConnection?.capabilities.some((capability) => capability.capabilityId === capabilityId && capability.status === 'active'))"
              @change="toggleWorkspaceCapability(capabilityId)"
            />
            <span class="min-w-0">
              <span class="block font-semibold text-surface-900">{{ capabilityName(capabilityId) }}</span>
              <span class="mt-1 block text-sm leading-relaxed text-surface-500">{{ capabilityDescription(capabilityId) }}</span>
            </span>
          </label>
          <Message severity="info" :closable="false">{{ t('sources.workspace.permissionHint') }}</Message>
        </div>
        <div class="flex flex-col-reverse gap-2 border-t border-surface-200 px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            type="button"
            :disabled="saving"
            @click="workspaceDialogVisible = false"
          />
          <Button
            :label="t('sources.workspace.continueToGoogle')"
            icon="pi pi-external-link"
            type="submit"
            :loading="saving"
            :disabled="selectedWorkspaceCapabilities.length === 0"
          />
        </div>
      </form>
    </Dialog>

    <Dialog
      v-model:visible="calendarPickerVisible"
      modal
      blockScroll
      dismissableMask
      :draggable="false"
      :header="t('sources.calendarPicker.title')"
      class="w-[calc(100vw-2rem)] sm:w-[min(40rem,calc(100vw-4rem))] max-h-[calc(100dvh-4rem)] my-auto"
      contentClass="!p-0 flex flex-col min-h-0 min-w-0 overflow-hidden"
    >
      <div v-if="loadingCalendars" class="flex flex-col items-center justify-center gap-3 px-4 py-14">
        <ProgressSpinner />
      </div>

      <form v-else class="flex flex-col min-h-0 min-w-0 overflow-hidden" @submit.prevent="saveCalendarSelection">
        <div class="flex-1 min-h-0 grid content-start gap-3 overflow-y-auto px-4 py-4 sm:px-6">
          <div>
            <p class="m-0 text-sm leading-relaxed text-surface-500">{{ t('sources.calendarPicker.description') }}</p>
            <p v-if="calendarConnection?.accountLabel" class="m-0 mt-1 text-sm font-medium text-surface-700 break-all">
              {{ calendarConnection.accountLabel }}
            </p>
          </div>
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
        </div>

        <div class="shrink-0 flex flex-col-reverse gap-2 border-t border-surface-200 bg-white px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            type="button"
            :disabled="saving"
            @click="closeCalendarPicker"
          />
          <Button
            :label="t('sources.calendarPicker.submit')"
            icon="pi pi-check"
            type="submit"
            :loading="saving"
          />
        </div>
      </form>
    </Dialog>

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

    <Dialog
      v-model:visible="deleteConfirmVisible"
      modal
      blockScroll
      :dismissableMask="!deletingId"
      :closable="!deletingId"
      :draggable="false"
      :header="pendingDeleteConnection?.connectorId === 'google_workspace'
        ? t('sources.workspace.disconnectAccount')
        : t('sources.deleteConnection')"
      class="w-[calc(100vw-2rem)] sm:w-[min(32rem,calc(100vw-4rem))] my-auto"
      contentClass="!p-0 flex flex-col min-w-0 overflow-hidden"
    >
      <div v-if="pendingDeleteConnection" class="grid gap-2 px-4 py-4 sm:px-6">
        <div class="font-semibold text-red-950">
          {{ t('sources.deleteConfirmTitle', {
            name: pendingDeleteConnection.accountLabel || pendingDeleteConnection.displayName,
          }) }}
        </div>
        <p class="m-0 text-sm text-red-900/80 leading-relaxed">
          {{ t(pendingDeleteConnection.connectorId === 'google_workspace'
            ? 'sources.workspace.disconnectDescription'
            : 'sources.deleteConfirmDescription') }}
        </p>
      </div>
      <div class="shrink-0 flex flex-col-reverse gap-2 border-t border-surface-200 bg-white px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
        <Button
          :label="t('common.cancel')"
          severity="secondary"
          text
          type="button"
          :disabled="Boolean(deletingId)"
          @click="pendingDeleteId = ''"
        />
        <Button
          :label="pendingDeleteConnection?.connectorId === 'google_workspace'
            ? t('sources.workspace.disconnectAccount')
            : t('sources.deletePermanently')"
          icon="pi pi-trash"
          severity="danger"
          :loading="Boolean(deletingId)"
          @click="pendingDeleteConnection && deleteConnection(pendingDeleteConnection)"
        />
      </div>
    </Dialog>

    <div v-if="loading" class="flex justify-center py-24"><ProgressSpinner /></div>

    <div v-else class="grid gap-5 lg:grid-cols-2">
      <Card
        v-for="connector in data?.connectors"
        :key="connector.id"
        class="min-w-0 rounded-lg border border-surface-200 overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6"
      >
        <template #title>
          <div class="min-w-0 flex items-start justify-between gap-3">
            <div class="min-w-0 flex items-center gap-3">
              <span class="w-10 h-10 rounded-md bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0">
                <i :class="[connectorIcon(connector), 'text-lg']" />
              </span>
              <div class="min-w-0">
                <div class="truncate">{{ connector.name }}</div>
                <div class="text-xs font-normal text-surface-400 mt-0.5">
                  {{ connectionsByConnector.get(connector.id)?.length || 0 }}
                  {{ (connectionsByConnector.get(connector.id)?.length || 0) === 1 ? t('sources.connection') : t('sources.connections') }}
                </div>
              </div>
            </div>
            <Tag
              :value="connector.id === 'odorik' ? t('sources.receivesRecordings') : t('sources.workspace.services')"
              severity="success"
              rounded
            />
          </div>
        </template>
        <template #subtitle><span class="leading-relaxed">{{ t(`sources.connectors.${connector.id}`) }}</span></template>
        <template #content>
          <div
            v-if="isAdmin && connector.id === 'odorik' && canAddConnection(connector)"
            class="min-w-0 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 mb-4"
          >
            <div class="font-semibold text-sm text-emerald-950">{{ t('sources.odorikSetup.title') }}</div>
            <p class="text-xs text-emerald-900/75 mt-1 mb-4 leading-relaxed">{{ t('sources.odorikSetup.description') }}</p>
            <Button
              :label="t('sources.odorikSetup.createButton')"
              icon="pi pi-plus"
              class="w-full"
              :loading="saving"
              @click="addConnection(connector)"
            />
          </div>

          <div
            v-else-if="isAdmin && canAddConnection(connector)"
            class="min-w-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 p-3.5 sm:p-4 mb-4"
          >
            <div class="min-w-0">
              <div class="font-semibold text-sm text-emerald-950">{{ t('sources.workspace.addAccountTitle') }}</div>
              <div class="text-xs text-emerald-800/80 mt-1 leading-relaxed">{{ t('sources.workspace.addAccountHint') }}</div>
            </div>
            <Button
              :label="t('sources.workspace.connectAccount')"
              icon="pi pi-plus"
              class="w-full sm:w-auto shrink-0"
              @click="addConnection(connector)"
            />
          </div>

          <div
            v-if="connector.id === 'odorik' && createdUrl"
            class="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 sm:p-5 mb-4"
          >
            <div class="text-sm font-semibold text-emerald-950">{{ t('sources.odorikSetup.readyTitle') }}</div>
            <p class="m-0 mt-1 mb-3 text-xs leading-relaxed text-emerald-900/75">{{ t('sources.odorikSetup.readyDescription') }}</p>
            <div class="min-w-0 flex flex-col sm:flex-row gap-2">
              <code class="min-w-0 grow rounded-xl bg-white border border-emerald-200 p-3 text-xs break-all">{{ createdUrl }}</code>
              <Button :label="t('common.copy')" icon="pi pi-copy" severity="secondary" @click="copyUrl(createdUrl)" />
            </div>
          </div>

          <div v-if="connectionsByConnector.get(connector.id)?.length" class="grid gap-4">
            <article
              v-for="connection in connectionsByConnector.get(connector.id)"
              :key="connection.id"
              :class="[
                'min-w-0 rounded-2xl border bg-surface-50 p-3.5 sm:p-4',
                createdConnectionId === connection.id ? 'border-emerald-300 ring-2 ring-emerald-100' : 'border-surface-200',
              ]"
            >
              <div class="min-w-0 flex items-start justify-between gap-3 mb-3">
                <div class="min-w-0">
                  <h3 class="text-base font-semibold m-0 break-words">
                    {{ connection.accountLabel || connection.displayName }}
                  </h3>
                  <p class="text-xs text-surface-400 mt-1 mb-0">
                    {{ connection.connectorId === 'google_workspace' ? t('sources.workspace.account') : connection.displayName }}
                  </p>
                </div>
                <Tag
                  :value="connectionStatusLabel(connection)"
                  :severity="connectionStatusSeverity(connection)"
                  rounded
                />
              </div>

              <div
                v-if="connection.reauthorizationRequired"
                class="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3"
              >
                <div class="text-sm font-semibold text-amber-950">{{ t('sources.reauthorize.title') }}</div>
                <p class="m-0 mt-1 text-xs leading-relaxed text-amber-900/80">{{ t('sources.reauthorize.description') }}</p>
                <Button
                  v-if="isAdmin"
                  :label="t('sources.reauthorize.action')"
                  icon="pi pi-refresh"
                  size="small"
                  class="mt-3 w-full sm:w-auto"
                  @click="openWorkspaceAuthorization(connection)"
                />
              </div>

              <template v-if="connection.connectorId === 'odorik'">
                <div class="mb-4 rounded-xl border border-surface-200 bg-white p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="text-sm font-semibold text-surface-800">{{ t('sources.odorikSetup.connectionTitle') }}</div>
                      <p class="m-0 mt-1 text-xs leading-relaxed text-surface-500">{{ t('sources.odorikSetup.connectionDescription') }}</p>
                    </div>
                    <Button
                      v-if="isAdmin && connection.credentialMode === 'encrypted' && !odorikSetupUrls[connection.id]"
                      :label="t('sources.odorikSetup.showButton')"
                      icon="pi pi-eye"
                      severity="secondary"
                      outlined
                      size="small"
                      :loading="loadingOdorikSetupId === connection.id"
                      @click="revealOdorikSetup(connection)"
                    />
                  </div>
                  <div v-if="odorikSetupUrls[connection.id]" class="min-w-0 flex items-stretch gap-2 mt-3">
                    <code class="min-w-0 grow rounded-xl bg-surface-50 border border-surface-200 p-2.5 text-[.7rem] break-all">{{ odorikSetupUrls[connection.id] }}</code>
                    <Button icon="pi pi-copy" severity="secondary" outlined :aria-label="t('common.copy')" @click="copyUrl(odorikSetupUrls[connection.id]!)" />
                  </div>
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
                      severity="secondary"
                      text
                      size="small"
                      @click="toggleResource(connection, resource.id, resource.status !== 'enabled')"
                    />
                  </div>
                  <p v-if="connection.resources.length === 0" class="text-sm text-surface-400 m-0">{{ emptyResourceMessage('context.call.read') }}</p>
                </div>
              </template>

              <div v-else class="grid gap-3">
                <section
                  v-for="descriptor in connector.capabilities"
                  :key="descriptor.id"
                  class="rounded-2xl border border-surface-200 bg-white p-3.5"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <i :class="[resourceIcon(descriptor.resourceType), 'text-emerald-700']" />
                        <h4 class="m-0 text-sm font-semibold text-surface-900">{{ capabilityName(descriptor.id) }}</h4>
                      </div>
                      <p class="m-0 mt-1 text-xs leading-relaxed text-surface-500">{{ capabilityDescription(descriptor.id) }}</p>
                    </div>
                    <Tag
                      :value="capabilityStatusLabel(capabilityConfiguration(connection, descriptor)?.status)"
                      :severity="capabilityStatusSeverity(capabilityConfiguration(connection, descriptor)?.status)"
                      rounded
                    />
                  </div>

                  <template v-if="capabilityConfiguration(connection, descriptor)">
                    <div class="mt-3 flex items-center justify-between gap-3 rounded-xl bg-surface-50 px-3 py-2 text-xs">
                      <span class="text-surface-500">{{ t('sources.lastObserved') }}</span>
                      <span class="font-semibold text-surface-700">
                        {{ formatDate(capabilityConfiguration(connection, descriptor)?.lastObservedAt) }}
                      </span>
                    </div>
                    <details class="mt-2 rounded-xl bg-surface-50 px-3 py-2 text-xs text-surface-500">
                      <summary class="cursor-pointer font-semibold text-surface-700">{{ t('sources.workspace.permissionDetails') }}</summary>
                      <ul class="mb-0 mt-2 grid gap-1 pl-4">
                        <li v-for="scope in capabilityConfiguration(connection, descriptor)?.grantedScopes" :key="scope">
                          {{ scopeLabel(scope) }}
                        </li>
                      </ul>
                    </details>

                    <div
                      v-if="capabilityConfiguration(connection, descriptor)?.status === 'active'"
                      class="mt-3 grid gap-2"
                    >
                      <div
                        v-for="resource in capabilityResources(connection, descriptor.id)"
                        :key="resource.id"
                        class="min-w-0 flex items-center justify-between gap-3 rounded-xl border border-surface-200 p-3"
                      >
                        <div class="min-w-0">
                          <div class="font-medium text-sm truncate">{{ resourceName(resource) }}</div>
                          <div class="text-xs text-surface-400">{{ resource.itemCount }} {{ t('sources.items') }}</div>
                        </div>
                        <Button
                          v-if="isAdmin"
                          :label="resource.status === 'enabled' ? t('sources.pause') : t('sources.resume')"
                          severity="secondary"
                          text
                          size="small"
                          @click="toggleResource(connection, resource.id, resource.status !== 'enabled')"
                        />
                      </div>
                      <p v-if="capabilityResources(connection, descriptor.id).length === 0" class="m-0 text-sm text-surface-400">
                        {{ emptyResourceMessage(descriptor.id) }}
                      </p>
                    </div>

                    <div v-if="isAdmin" class="mt-3 flex flex-wrap justify-end gap-1">
                      <Button
                        v-if="descriptor.id === 'context.calendar.read' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="t('sources.chooseCalendars')"
                        icon="pi pi-list-check"
                        severity="secondary"
                        text
                        size="small"
                        @click="openCalendarPicker(connection)"
                      />
                      <Button
                        v-if="descriptor.id === 'context.calendar.read' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="synchronizingId === `${connection.id}:calendar` ? t('sources.syncing') : t('sources.syncNow')"
                        icon="pi pi-refresh"
                        severity="secondary"
                        text
                        size="small"
                        :loading="synchronizingId === `${connection.id}:calendar`"
                        @click="synchronizeCalendar(connection)"
                      />
                      <Button
                        v-if="descriptor.id === 'context.document.read' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="t('sources.chooseFolders')"
                        icon="pi pi-list-check"
                        severity="secondary"
                        text
                        size="small"
                        @click="openDrivePicker(connection)"
                      />
                      <Button
                        v-if="descriptor.id === 'context.document.read' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="synchronizingId === `${connection.id}:drive` ? t('sources.syncing') : t('sources.syncNow')"
                        icon="pi pi-refresh"
                        severity="secondary"
                        text
                        size="small"
                        :loading="synchronizingId === `${connection.id}:drive`"
                        @click="synchronizeDrive(connection)"
                      />
                      <Button
                        v-if="['attention', 'reauthorization_required'].includes(capabilityConfiguration(connection, descriptor)?.status || '')"
                        :label="t('sources.workspace.grantPermission')"
                        icon="pi pi-refresh"
                        severity="warn"
                        text
                        size="small"
                        @click="openWorkspaceAuthorization(connection, descriptor.id)"
                      />
                      <Button
                        v-else-if="capabilityConfiguration(connection, descriptor)?.status === 'disabled'"
                        :label="t('sources.workspace.enableService')"
                        icon="pi pi-check-circle"
                        severity="success"
                        text
                        size="small"
                        @click="toggleCapability(connection, descriptor.id, true)"
                      />
                      <Button
                        v-else-if="capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="t('sources.workspace.disableService')"
                        icon="pi pi-minus-circle"
                        severity="secondary"
                        text
                        size="small"
                        @click="toggleCapability(connection, descriptor.id, false)"
                      />
                    </div>
                  </template>
                  <Button
                    v-else-if="isAdmin"
                    :label="t('sources.workspace.enableService')"
                    icon="pi pi-plus"
                    severity="secondary"
                    outlined
                    size="small"
                    class="mt-3 w-full"
                    @click="openWorkspaceAuthorization(connection, descriptor.id)"
                  />
                </section>
              </div>

              <div v-if="isAdmin" class="flex flex-wrap justify-end mt-3">
                <Button
                  v-if="connection.connectorId === 'odorik'"
                  :label="connection.status === 'disconnected' ? t('sources.reconnect') : t('sources.disconnect')"
                  :icon="connection.status === 'disconnected' ? 'pi pi-link' : 'pi pi-power-off'"
                  severity="secondary"
                  text
                  size="small"
                  @click="toggleConnection(connection)"
                />
                <Button
                  :label="connection.connectorId === 'google_workspace' ? t('sources.workspace.disconnectAccount') : t('sources.deleteConnection')"
                  icon="pi pi-trash"
                  severity="danger"
                  text
                  size="small"
                  @click="pendingDeleteId = connection.id"
                />
              </div>
            </article>
          </div>
        </template>
      </Card>
    </div>
  </section>
</template>
