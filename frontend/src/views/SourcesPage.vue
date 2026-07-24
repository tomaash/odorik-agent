<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import Card from 'primevue/card'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Password from 'primevue/password'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import { useAuthStore } from '../stores/auth'
import {
  addOdorikConnection,
  deleteSourceConnection,
  getGoogleCalendars,
  getGoogleDriveFolders,
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
const showForm = ref(false)
const createdUrl = ref('')
const calendarConnection = ref<SourceConnection | null>(null)
const calendars = ref<SelectableCalendar[]>([])
const selectedCalendarIds = ref<string[]>([])
const loadingCalendars = ref(false)
const driveConnection = ref<SourceConnection | null>(null)
const folders = ref<SelectableFolder[]>([])
const selectedFolderIds = ref<string[]>([])
const loadingFolders = ref(false)
const synchronizingId = ref('')
const pendingDeleteId = ref('')
const deletingId = ref('')
const form = reactive({
  displayName: '',
  accountLabel: '',
  username: '',
  password: '',
  numbers: '',
})

const isAdmin = computed(() => auth.access?.admin === true)
const connectionsByAdapter = computed(() => {
  const grouped = new Map<string, SourceConnection[]>()
  for (const connection of data.value?.connections || []) {
    grouped.set(connection.adapterId, [...(grouped.get(connection.adapterId) || []), connection])
  }
  return grouped
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
    const result = await addOdorikConnection({
      displayName: form.displayName,
      ...(form.accountLabel.trim() ? { accountLabel: form.accountLabel.trim() } : {}),
      username: form.username,
      password: form.password,
      numbers: form.numbers.split(/\n|,/).map((value) => value.trim()).filter(Boolean),
    })
    createdUrl.value = result.uploadUrl
    notice.value = t('sources.created')
    Object.assign(form, { displayName: '', accountLabel: '', username: '', password: '', numbers: '' })
    showForm.value = false
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
    showForm.value = true
    await nextTick()
    document.getElementById('odorik-connection-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  try {
    folders.value = await getGoogleDriveFolders(connection.id)
    selectedFolderIds.value = folders.value
      .filter((folder) => folder.selected)
      .map((folder) => folder.id)
  } catch (cause) {
    driveConnection.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingFolders.value = false
  }
}

function toggleFolder(folderId: string) {
  selectedFolderIds.value = selectedFolderIds.value.includes(folderId)
    ? selectedFolderIds.value.filter((id) => id !== folderId)
    : [...selectedFolderIds.value, folderId]
}

async function saveFolderSelection() {
  if (!driveConnection.value) return
  saving.value = true
  error.value = ''
  try {
    await selectGoogleDriveFolders(driveConnection.value.id, selectedFolderIds.value)
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
  const params = new URLSearchParams(window.location.search)
  const calendarResult = params.get('calendar')
  const driveResult = params.get('drive')
  if (calendarResult === 'connected') notice.value = t('sources.calendarConnected')
  else if (calendarResult === 'denied') error.value = t('sources.calendarDenied')
  else if (calendarResult === 'failed' || calendarResult === 'invalid') error.value = t('sources.calendarFailed')
  else if (driveResult === 'connected') notice.value = t('sources.driveConnected')
  else if (driveResult === 'denied') error.value = t('sources.driveDenied')
  else if (driveResult === 'failed' || driveResult === 'invalid') error.value = t('sources.driveFailed')
  await load()
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

    <Card
      id="odorik-connection-form"
      v-if="showForm && isAdmin"
      class="rounded-3xl border border-emerald-200 shadow-sm mb-6 overflow-hidden scroll-mt-4 [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6"
    >
      <template #title>{{ t('sources.form.title') }}</template>
      <template #subtitle>{{ t('sources.form.description') }}</template>
      <template #content>
        <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="createOdorik">
          <label class="min-w-0 grid gap-2 text-sm font-medium">
            {{ t('sources.form.displayName') }}
            <InputText v-model="form.displayName" fluid required autocomplete="organization" />
          </label>
          <label class="min-w-0 grid gap-2 text-sm font-medium">
            {{ t('sources.form.accountLabel') }}
            <InputText v-model="form.accountLabel" fluid />
          </label>
          <label class="min-w-0 grid gap-2 text-sm font-medium">
            {{ t('sources.form.username') }}
            <InputText v-model="form.username" fluid required autocomplete="off" />
          </label>
          <label class="min-w-0 grid gap-2 text-sm font-medium">
            {{ t('sources.form.password') }}
            <Password v-model="form.password" fluid required :feedback="false" toggleMask autocomplete="new-password" />
          </label>
          <label class="min-w-0 grid gap-2 text-sm font-medium sm:col-span-2">
            {{ t('sources.form.numbers') }}
            <textarea v-model="form.numbers" rows="3" class="w-full min-w-0 rounded-xl border border-surface-300 bg-white p-3 text-sm font:inherit resize-y focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </label>
          <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:col-span-2">
            <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="showForm = false" />
            <Button :label="t('sources.form.submit')" icon="pi pi-check" type="submit" :loading="saving" />
          </div>
        </form>
      </template>
    </Card>

    <Card v-if="calendarConnection && isAdmin" class="rounded-3xl border border-emerald-200 shadow-sm mb-6 overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
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

    <Card v-if="driveConnection && isAdmin" class="rounded-3xl border border-emerald-200 shadow-sm mb-6 overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6">
      <template #title>{{ t('sources.drivePicker.title') }}</template>
      <template #subtitle>{{ t('sources.drivePicker.description') }}</template>
      <template #content>
        <div v-if="loadingFolders" class="flex justify-center py-10"><ProgressSpinner /></div>
        <form v-else class="grid gap-3" @submit.prevent="saveFolderSelection">
          <label
            v-for="folder in folders"
            :key="folder.id"
            class="min-w-0 flex items-start gap-3 rounded-2xl border border-surface-200 bg-surface-50 p-3.5 cursor-pointer"
          >
            <input
              type="checkbox"
              class="mt-1 w-4 h-4 accent-emerald-700 shrink-0"
              :checked="selectedFolderIds.includes(folder.id)"
              @change="toggleFolder(folder.id)"
            />
            <span class="min-w-0 grow">
              <span class="flex items-center gap-2 flex-wrap font-semibold">
                {{ folder.displayName }}
                <Tag v-if="folder.shared" :value="t('sources.drivePicker.shared')" severity="info" rounded />
              </span>
              <span v-if="folder.description" class="block text-sm text-surface-500 mt-1 break-words">{{ folder.description }}</span>
              <span class="block text-xs text-surface-400 mt-1 break-all">{{ folder.id }}</span>
            </span>
          </label>
          <p v-if="folders.length === 0" class="text-sm text-surface-500">{{ t('sources.drivePicker.none') }}</p>
          <Message severity="warn" :closable="false">{{ t('sources.drivePicker.privacy') }}</Message>
          <div class="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-1">
            <Button :label="t('common.cancel')" severity="secondary" text type="button" @click="driveConnection = null" />
            <Button :label="t('sources.drivePicker.submit')" icon="pi pi-check" type="submit" :loading="saving" />
          </div>
        </form>
      </template>
    </Card>

    <div v-if="createdUrl" class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5 mb-6">
      <div class="text-sm font-semibold text-emerald-900 mb-2">{{ t('sources.uploadUrl') }}</div>
      <div class="min-w-0 flex flex-col sm:flex-row gap-2">
        <code class="min-w-0 grow rounded-xl bg-white border border-emerald-200 p-3 text-xs break-all">{{ createdUrl }}</code>
        <Button :label="t('common.copy')" icon="pi pi-copy" severity="secondary" @click="copyUrl(createdUrl)" />
      </div>
    </div>

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
              :value="adapter.availability === 'available' ? t('sources.readOnly') : adapter.availability === 'needs_configuration' ? t('sources.needsConfiguration') : t('sources.planned')"
              :severity="adapter.availability === 'available' ? 'success' : 'secondary'"
              rounded
            />
          </div>
        </template>
        <template #subtitle><span class="leading-relaxed">{{ t(`sources.adapters.${adapter.id}`) }}</span></template>
        <template #content>
          <div
            v-if="isAdmin && canAddConnection(adapter)"
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

          <div v-if="connectionsByAdapter.get(adapter.id)?.length" class="grid gap-4">
            <article
              v-for="connection in connectionsByAdapter.get(adapter.id)"
              :key="connection.id"
              class="min-w-0 rounded-2xl border border-surface-200 bg-surface-50 p-3.5 sm:p-4"
            >
              <div class="min-w-0 flex items-start justify-between gap-3 mb-3">
                <div class="min-w-0">
                  <h3 class="text-base font-semibold m-0 break-words">{{ connection.displayName }}</h3>
                  <p v-if="connection.accountLabel" class="text-sm text-surface-500 mt-1 mb-0 break-words">{{ connection.accountLabel }}</p>
                </div>
                <Tag
                  :value="connection.status === 'active' ? t('sources.active') : connection.status === 'attention' ? t('sources.attention') : t('sources.disconnected')"
                  :severity="connection.status === 'active' ? 'success' : connection.status === 'attention' ? 'warn' : 'secondary'"
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

              <div v-if="connection.uploadUrl" class="mb-4">
                <div class="text-xs font-semibold text-surface-500 mb-1.5">{{ t('sources.uploadUrl') }}</div>
                <div class="min-w-0 flex items-stretch gap-2">
                  <code class="min-w-0 grow rounded-xl bg-white border border-surface-200 p-2.5 text-[.7rem] break-all">{{ connection.uploadUrl }}</code>
                  <Button icon="pi pi-copy" severity="secondary" outlined :aria-label="t('common.copy')" @click="copyUrl(connection.uploadUrl!)" />
                </div>
                <div class="text-xs text-surface-400 mt-1.5">
                  {{ connection.credentialMode === 'legacy_secret' ? t('sources.legacyCredential') : t('sources.encryptedCredential') }}
                </div>
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
