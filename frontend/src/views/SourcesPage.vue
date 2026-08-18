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
  backfillKnowledgeIndexDeliveries,
  connectConfiguredGitHubInstallation,
  deleteSourceConnection,
  disconnectGrokSubscription,
  getKnowledgeIndexStatus,
  getGrokSubscriptionAuthorization,
  getGoogleCalendars,
  getMicrosoftOutlookCalendars,
  getGoogleDriveFolders,
  getSlackChannels,
  getTeamOverview,
  getOdorikSetup,
  listSources,
  listChatNotificationDeliveries,
  replayKnowledgeIndexDelivery,
  replaySourceSync,
  retryChatNotificationDelivery,
  selectGoogleCalendars,
  selectMicrosoftOutlookCalendars,
  selectGoogleDriveFolders,
  selectSlackChannels,
  setSourceCapabilityStatus,
  setSourceConnectionStatus,
  setSourceResourceEnabled,
  setSourceResourceAudience,
  startGoogleWorkspaceAuthorization,
  startMicrosoftAuthorization,
  refreshMicrosoftConnection,
  syncMicrosoftOutlook,
  syncMicrosoftOutlookCalendars,
  startSlackAuthorization,
  startGrokSubscriptionAuthorization,
  syncGoogleCalendars,
  syncGoogleDrive,
  syncGitHubIssues,
  type SourceCapabilityDescriptor,
  type SourceCapabilityId,
  type SourceConnector,
  type SourceConnection,
  type SourceResource,
  getGmailLabels,
  selectGmailLabels,
  syncGmailLabels,
  workspaceCapabilityIds,
  type MicrosoftCapabilityId,
  type SelectableCalendar,
  type SelectableFolder,
  type SelectableMailLabel,
  type WorkspaceCapabilityId,
  type SourcesResponse,
  type GrokAuthorization,
  type KnowledgeIndexStatus,
  type SelectableSlackChannel,
  type ChatNotificationDelivery,
  type TeamMember,
} from '../api/client'

const { t, locale } = useI18n()
const auth = useAuthStore()
const data = ref<SourcesResponse | null>(null)
const searchIndex = ref<KnowledgeIndexStatus | null>(null)
const searchIndexError = ref('')
const replayingIndexDeliveryId = ref('')
const backfillingIndex = ref(false)
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
const microsoftRefreshingId = ref('')
const mailConnection = ref<SourceConnection | null>(null)
const mailLabels = ref<SelectableMailLabel[]>([])
const selectedLabelIds = ref<string[]>([])
const loadingLabels = ref(false)
const workspaceDialogVisible = ref(false)
const workspaceConnection = ref<SourceConnection | null>(null)
const selectedWorkspaceCapabilities = ref<WorkspaceCapabilityId[]>([...workspaceCapabilityIds])
const slackConnection = ref<SourceConnection | null>(null)
const slackChannels = ref<SelectableSlackChannel[]>([])
const selectedSlackChannelIds = ref<string[]>([])
const loadingSlackChannels = ref(false)
const chatDeliveries = ref<ChatNotificationDelivery[]>([])
const chatDeliveryError = ref('')
const retryingChatApprovalId = ref('')

function isWorkspaceCapability(
  capabilityId: SourceCapabilityId,
): capabilityId is WorkspaceCapabilityId {
  return (workspaceCapabilityIds as SourceCapabilityId[]).includes(capabilityId)
}
const pendingDeleteId = ref('')
const deletingId = ref('')
const grokAuthorization = ref<GrokAuthorization | null>(null)
const grokDialogVisible = ref(false)
const grokPendingAction = ref<'connect' | 'disconnect' | null>(null)
let grokPollTimer: number | null = null
const isAdmin = computed(() => auth.access?.admin === true)
const teamMembers = ref<TeamMember[]>([])
const audienceConnection = ref<SourceConnection | null>(null)
const audienceResource = ref<SourceResource | null>(null)
const audienceVisibility = ref<'company' | 'restricted'>('company')
const audienceMemberIds = ref<string[]>([])
const audienceSaving = ref(false)
const audienceBroadeningConfirmed = ref(false)
const audienceDialogVisible = computed({
  get: () => audienceResource.value !== null,
  set: (visible: boolean) => {
    if (!visible && !audienceSaving.value) {
      audienceConnection.value = null
      audienceResource.value = null
    }
  },
})
const proposedAudience = computed<SourceResource['audience']>(() => (
  audienceVisibility.value === 'company'
    ? { visibility: 'company' }
    : { visibility: 'restricted', memberIds: [...audienceMemberIds.value].sort() }
))
const audienceIsBroader = computed(() => {
  const current = audienceResource.value?.audience
  const next = proposedAudience.value
  if (!current || current.visibility === 'company') return false
  if (next.visibility === 'company') return true
  const currentIds = new Set(current.memberIds)
  return next.memberIds.some((memberId) => !currentIds.has(memberId))
})
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
const mailPickerVisible = computed({
  get: () => mailConnection.value !== null,
  set: (visible: boolean) => {
    if (!visible) closeMailPicker()
  },
})
const slackPickerVisible = computed({
  get: () => slackConnection.value !== null,
  set: (visible: boolean) => {
    if (!visible && !saving.value) slackConnection.value = null
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

function formatIndexDuration(milliseconds?: number | null) {
  if (milliseconds === null || milliseconds === undefined) return t('sources.searchIndex.unmeasured')
  if (milliseconds < 60_000) {
    return t('sources.searchIndex.seconds', { value: Math.max(1, Math.round(milliseconds / 1_000)) })
  }
  return t('sources.searchIndex.minutes', { value: Math.round(milliseconds / 60_000) })
}

function searchIndexHealthSeverity(health?: KnowledgeIndexStatus['health']) {
  if (health === 'fresh') return 'success'
  if (health === 'indexing' || health === 'retrying') return 'info'
  if (health === 'attention') return 'warn'
  return 'secondary'
}

const searchIndexPendingCount = computed(() => (
  (searchIndex.value?.counts.queued || 0)
  + (searchIndex.value?.counts.running || 0)
  + (searchIndex.value?.counts.retrying || 0)
))

function connectorIcon(connector: SourceConnector) {
  return {
    odorik: 'pi pi-phone',
    google_workspace: 'pi pi-google',
    microsoft_365: 'pi pi-microsoft',
    github: 'pi pi-github',
    grok_subscription: 'pi pi-code',
    slack: 'pi pi-slack',
  }[connector.id]
}

function connectorTag(connector: SourceConnector) {
  if (connector.id === 'odorik') return t('sources.receivesRecordings')
  if (connector.id === 'github') return t('sources.github.readOnlyIssues')
  if (connector.id === 'grok_subscription') return t('sources.grok.subscriptionOAuth')
  if (connector.id === 'slack') return t('sources.slack.notificationsOnly')
  if (connector.id === 'microsoft_365') return t('sources.microsoft.foundation')
  return t('sources.workspace.services')
}

function addConnectionTitle(connector: SourceConnector) {
  if (connector.id === 'grok_subscription') return t('sources.grok.connectTitle')
  if (connector.id === 'slack') return t('sources.slack.connectTitle')
  if (connector.id === 'microsoft_365') return t('sources.microsoft.connectTitle')
  if (connector.id !== 'github') return t('sources.workspace.addAccountTitle')
  return connectionsByConnector.value.get('github')?.length
    ? t('sources.github.refreshTitle')
    : t('sources.github.addTitle')
}

function addConnectionHint(connector: SourceConnector) {
  if (connector.id === 'grok_subscription') return t('sources.grok.connectHint')
  if (connector.id === 'slack') return t('sources.slack.connectHint')
  if (connector.id === 'microsoft_365') return t('sources.microsoft.connectHint')
  if (connector.id !== 'github') return t('sources.workspace.addAccountHint')
  return connectionsByConnector.value.get('github')?.length
    ? t('sources.github.refreshHint')
    : t('sources.github.addHint')
}

function addConnectionLabel(connector: SourceConnector) {
  if (connector.id === 'grok_subscription') return t('sources.grok.connect')
  if (connector.id === 'slack') return t('sources.slack.connect')
  if (connector.id === 'microsoft_365') return t('sources.microsoft.connect')
  if (connector.id !== 'github') return t('sources.workspace.connectAccount')
  return connectionsByConnector.value.get('github')?.length
    ? t('sources.github.refreshInstallation')
    : t('sources.github.connectInstallation')
}

function addConnectionIcon(connector: SourceConnector) {
  return connector.id === 'github' && connectionsByConnector.value.get('github')?.length
    ? 'pi pi-refresh'
    : 'pi pi-plus'
}

function connectionKindLabel(connection: SourceConnection) {
  if (connection.connectorId === 'google_workspace') return t('sources.workspace.account')
  if (connection.connectorId === 'microsoft_365') return t('sources.microsoft.connectionKind')
  if (connection.connectorId === 'github') return t('sources.github.installation')
  if (connection.connectorId === 'grok_subscription') return t('sources.grok.connectionKind')
  if (connection.connectorId === 'slack') return t('sources.slack.connectionKind')
  return connection.displayName
}

function permissionDetailsLabel(connection: SourceConnection) {
  if (connection.connectorId === 'microsoft_365') return t('sources.microsoft.permissionDetails')
  return connection.connectorId === 'github'
    ? t('sources.github.permissionDetails')
    : t('sources.workspace.permissionDetails')
}

function deleteDescriptionKey(connection: SourceConnection) {
  if (connection.connectorId === 'google_workspace') return 'sources.workspace.disconnectDescription'
  if (connection.connectorId === 'microsoft_365') return 'sources.microsoft.disconnectDescription'
  if (connection.connectorId === 'github') return 'sources.github.deleteDescription'
  if (connection.connectorId === 'slack') return 'sources.slack.disconnectDescription'
  return 'sources.deleteConfirmDescription'
}

function resourceIcon(resourceType: string) {
  return {
    phone_line: 'pi pi-phone',
    calendar: 'pi pi-calendar',
    folder: 'pi pi-folder',
    label: 'pi pi-tag',
    repository: 'pi pi-github',
    mailbox: 'pi pi-envelope',
  }[resourceType] || 'pi pi-database'
}

function resourceName(resource: { externalId: string; displayName: string }) {
  return resource.externalId === 'line:unassigned'
    ? t('sources.unassignedLine')
    : resource.displayName
}

function audienceLabel(resource: SourceResource) {
  return resource.audience.visibility === 'company'
    ? t('sources.audience.company')
    : t('sources.audience.selectedCount', { count: resource.audience.memberIds.length })
}

function openAudienceEditor(connection: SourceConnection, resource: SourceResource) {
  audienceConnection.value = connection
  audienceResource.value = resource
  audienceVisibility.value = resource.audience.visibility
  audienceMemberIds.value = resource.audience.visibility === 'restricted'
    ? [...resource.audience.memberIds]
    : []
  audienceBroadeningConfirmed.value = false
}

function toggleAudienceMember(uid: string) {
  audienceMemberIds.value = audienceMemberIds.value.includes(uid)
    ? audienceMemberIds.value.filter((memberId) => memberId !== uid)
    : [...audienceMemberIds.value, uid]
  audienceBroadeningConfirmed.value = false
}

function chooseAudienceVisibility(visibility: 'company' | 'restricted') {
  audienceVisibility.value = visibility
  audienceBroadeningConfirmed.value = false
}

async function saveAudience() {
  const connection = audienceConnection.value
  const resource = audienceResource.value
  if (!connection || !resource) return
  if (proposedAudience.value.visibility === 'restricted' && proposedAudience.value.memberIds.length === 0) return
  if (audienceIsBroader.value && !audienceBroadeningConfirmed.value) {
    audienceBroadeningConfirmed.value = true
    return
  }
  audienceSaving.value = true
  error.value = ''
  try {
    await setSourceResourceAudience({
      connectionId: connection.id,
      resourceId: resource.id,
      audience: proposedAudience.value,
      expectedRevision: resource.audienceRevision,
      confirmBroadening: audienceBroadeningConfirmed.value,
    })
    audienceConnection.value = null
    audienceResource.value = null
    notice.value = t('sources.audience.saved')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    audienceSaving.value = false
  }
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

function capabilityLatestRunId(
  connection: SourceConnection,
  descriptor: SourceCapabilityDescriptor,
) {
  return capabilityConfiguration(connection, descriptor)?.sync?.latestRunId || ''
}

function capabilitySyncOperationId(
  connection: SourceConnection,
  descriptor: SourceCapabilityDescriptor,
) {
  const operation = descriptor.serviceId === 'issues' ? 'github' : descriptor.serviceId
  return `${connection.id}:${operation}`
}

function capabilityName(capabilityId: string, connectorId?: string) {
  if (connectorId === 'microsoft_365') {
    return t(`sources.microsoft.capabilities.${capabilityId}.name`)
  }
  return t(`sources.capabilities.${capabilityId}.name`)
}

function capabilityDescription(capabilityId: string, connectorId?: string) {
  if (connectorId === 'microsoft_365') {
    return t(`sources.microsoft.capabilities.${capabilityId}.description`)
  }
  return t(`sources.capabilities.${capabilityId}.description`)
}

function capabilityStatusLabel(status?: string) {
  if (status === 'active') return t('sources.enabled')
  if (status === 'permission_granted') return t('sources.microsoft.permissionGranted')
  if (status === 'reauthorization_required') return t('sources.reauthorize.title')
  if (status === 'attention') return t('sources.attention')
  return t('sources.notEnabled')
}

function capabilityStatusSeverity(status?: string) {
  if (status === 'active') return 'success'
  if (status === 'attention' || status === 'reauthorization_required') return 'warn'
  return 'secondary'
}

function syncHealthLabel(health?: string) {
  return t(`sources.sync.health.${health || 'unmeasured'}`)
}

function syncHealthSeverity(health?: string) {
  if (health === 'fresh') return 'success'
  if (health === 'syncing' || health === 'retrying') return 'info'
  if (health === 'stale' || health === 'attention') return 'warn'
  return 'secondary'
}

function scopeLabel(scope: string) {
  return {
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly': t('sources.scopes.calendarList'),
    'https://www.googleapis.com/auth/calendar.events.readonly': t('sources.scopes.calendarEvents'),
    'https://www.googleapis.com/auth/drive.readonly': t('sources.scopes.drive'),
    'https://www.googleapis.com/auth/gmail.readonly': t('sources.scopes.gmail'),
    'https://www.googleapis.com/auth/gmail.compose': t('sources.scopes.gmailCompose'),
    'Mail.Read': t('sources.scopes.microsoftMailRead'),
    'Mail.ReadWrite': t('sources.scopes.microsoftMailReadWrite'),
    'Calendars.Read': t('sources.scopes.microsoftCalendarRead'),
    'chat:write': t('sources.scopes.slackChatWrite'),
    'channels:read': t('sources.scopes.slackChannelsRead'),
    'im:history': t('sources.scopes.slackImHistory'),
    'contents:read': t('sources.scopes.githubContents'),
    'contents:write': t('sources.scopes.githubContentsWrite'),
    'issues:read': t('sources.scopes.githubIssues'),
    'metadata:read': t('sources.scopes.githubMetadata'),
    'pull_requests:read': t('sources.scopes.githubPullRequests'),
    'pull_requests:write': t('sources.scopes.githubPullRequestsWrite'),
  }[scope] || scope
}

function emptyResourceMessage(capabilityId: string) {
  if (capabilityId === 'context.calendar.read') return t('sources.emptyCalendars')
  if (capabilityId === 'context.document.read') return t('sources.emptyFolders')
  if (capabilityId === 'context.call.read') return t('sources.emptyPhoneLines')
  if (capabilityId === 'context.mail.read_scoped') return t('sources.emptyLabels')
  if (capabilityId === 'context.github.issue.read') return t('sources.emptyRepositories')
  if (capabilityId === 'action.mail.draft.create') return t('sources.emptyMailDraft')
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
  if (connection.status === 'configuring') return t('sources.connecting')
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
  if (connection.status === 'configuring') return 'info'
  return 'secondary'
}

function webhookStatusLabel(connection: SourceConnection) {
  if (connection.webhook?.status === 'active') return t('sources.github.webhook.active')
  if (connection.webhook?.status === 'attention') return t('sources.github.webhook.attention')
  return t('sources.github.webhook.pending')
}

function webhookStatusSeverity(connection: SourceConnection) {
  if (connection.webhook?.status === 'active') return 'success'
  if (connection.webhook?.status === 'attention') return 'warn'
  return 'secondary'
}

async function load() {
  loading.value = true
  error.value = ''
  searchIndexError.value = ''
  chatDeliveryError.value = ''
  try {
    const indexStatus = isAdmin.value
      ? getKnowledgeIndexStatus().catch((cause) => {
          searchIndexError.value = cause instanceof Error ? cause.message : String(cause)
          return null
        })
      : Promise.resolve(null)
    const team = isAdmin.value ? getTeamOverview() : Promise.resolve(null)
    const deliveries = isAdmin.value
      ? listChatNotificationDeliveries().catch((cause) => {
          chatDeliveryError.value = cause instanceof Error ? cause.message : String(cause)
          return [] as ChatNotificationDelivery[]
        })
      : Promise.resolve([] as ChatNotificationDelivery[])
    const [sources, index, overview, recentDeliveries] = await Promise.all([
      listSources(), indexStatus, team, deliveries,
    ])
    data.value = sources
    searchIndex.value = index
    teamMembers.value = overview?.members || []
    chatDeliveries.value = recentDeliveries
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function replayIndexDelivery(deliveryId: string) {
  replayingIndexDeliveryId.value = deliveryId
  searchIndexError.value = ''
  try {
    await replayKnowledgeIndexDelivery(deliveryId)
    searchIndex.value = await getKnowledgeIndexStatus()
  } catch (cause) {
    searchIndexError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    replayingIndexDeliveryId.value = ''
  }
}

async function backfillIndexDeliveries() {
  backfillingIndex.value = true
  searchIndexError.value = ''
  try {
    const result = await backfillKnowledgeIndexDeliveries()
    notice.value = t('sources.searchIndex.backfillQueued', { count: result.queued })
    searchIndex.value = await getKnowledgeIndexStatus()
  } catch (cause) {
    searchIndexError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    backfillingIndex.value = false
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
  if (connector.id === 'grok_subscription') {
    await beginGrokAuthorization()
    return
  }
  if (connector.id === 'google_workspace') {
    openWorkspaceAuthorization()
    return
  }
  if (connector.id === 'microsoft_365') {
    await beginMicrosoftAuthorization()
    return
  }
  if (connector.id === 'slack') {
    saving.value = true
    error.value = ''
    try {
      const result = await startSlackAuthorization()
      window.location.assign(result.authorizationUrl)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      saving.value = false
    }
    return
  }
  if (connector.id === 'odorik') {
    await createOdorik()
    return
  }
  if (connector.id === 'github') {
    saving.value = true
    error.value = ''
    notice.value = ''
    try {
      const result = await connectConfiguredGitHubInstallation()
      notice.value = t('sources.github.connected', { count: result.repositories })
      await load()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving.value = false
    }
  }
}

async function beginMicrosoftAuthorization(
  connection: SourceConnection | null = null,
  capabilityId?: SourceCapabilityId,
) {
  saving.value = true
  error.value = ''
  try {
    const capabilityIds = capabilityId ? [capabilityId as MicrosoftCapabilityId] : []
    const result = await startMicrosoftAuthorization(capabilityIds, connection?.id)
    window.location.assign(result.authorizationUrl)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    saving.value = false
  }
}

async function checkMicrosoftConnection(connection: SourceConnection) {
  microsoftRefreshingId.value = connection.id
  error.value = ''
  try {
    await refreshMicrosoftConnection(connection.id)
    notice.value = t('sources.microsoft.healthPassed')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    await load()
  } finally {
    microsoftRefreshingId.value = ''
  }
}

async function openSlackPicker(connection: SourceConnection) {
  loadingSlackChannels.value = true
  error.value = ''
  slackConnection.value = connection
  slackChannels.value = []
  selectedSlackChannelIds.value = connection.resources
    .filter((resource) => resource.capabilityId === 'action.chat.notify' && resource.status === 'enabled')
    .map((resource) => resource.externalId)
  try {
    slackChannels.value = await getSlackChannels(connection.id)
  } catch (cause) {
    slackConnection.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingSlackChannels.value = false
  }
}

function toggleSlackChannel(channelId: string) {
  selectedSlackChannelIds.value = selectedSlackChannelIds.value.includes(channelId)
    ? selectedSlackChannelIds.value.filter((id) => id !== channelId)
    : [...selectedSlackChannelIds.value, channelId]
}

async function saveSlackSelection() {
  if (!slackConnection.value) return
  saving.value = true
  error.value = ''
  try {
    await selectSlackChannels(slackConnection.value.id, selectedSlackChannelIds.value)
    slackConnection.value = null
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

function deliveriesForConnection(connectionId: string) {
  return chatDeliveries.value.filter((delivery) => delivery.connectionId === connectionId)
}

function slackChannelName(connection: SourceConnection, channelId: string) {
  return connection.resources.find((resource) => resource.externalId === channelId)?.displayName || channelId
}

function chatDeliverySeverity(status: ChatNotificationDelivery['status']) {
  if (status === 'succeeded') return 'success'
  if (status === 'sending') return 'info'
  return 'warn'
}

async function retryChatDelivery(delivery: ChatNotificationDelivery) {
  retryingChatApprovalId.value = delivery.approvalId
  error.value = ''
  try {
    await retryChatNotificationDelivery(delivery.approvalId)
    chatDeliveries.value = await listChatNotificationDeliveries()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    retryingChatApprovalId.value = ''
  }
}

function canAddConnection(connector: SourceConnector) {
  if (connector.id === 'grok_subscription') {
    return connector.availability === 'available'
      && !connectionsByConnector.value.get('grok_subscription')?.length
  }
  if (connector.id === 'microsoft_365') {
    return connector.availability === 'available'
      && !connectionsByConnector.value.get('microsoft_365')?.length
  }
  return connector.availability === 'available'
}

function stopGrokPolling() {
  if (grokPollTimer !== null) window.clearTimeout(grokPollTimer)
  grokPollTimer = null
}

function scheduleGrokPoll() {
  stopGrokPolling()
  grokPollTimer = window.setTimeout(() => void pollGrokAuthorization(), 1500)
}

async function pollGrokAuthorization() {
  const sessionId = grokAuthorization.value?.sessionId
  if (!sessionId) return
  try {
    const result = await getGrokSubscriptionAuthorization(sessionId)
    grokAuthorization.value = result
    if (['starting', 'waiting_for_user'].includes(result.status)) {
      scheduleGrokPoll()
      return
    }
    stopGrokPolling()
    await load()
    if (result.status === 'completed') {
      notice.value = result.action === 'connect'
        ? t('sources.grok.connected')
        : t('sources.grok.disconnected')
    } else {
      error.value = result.error || t('sources.grok.failed')
    }
  } catch (cause) {
    stopGrokPolling()
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function beginGrokAuthorization() {
  saving.value = true
  error.value = ''
  notice.value = ''
  stopGrokPolling()
  grokAuthorization.value = null
  grokPendingAction.value = 'connect'
  grokDialogVisible.value = true
  try {
    grokAuthorization.value = await startGrokSubscriptionAuthorization()
    scheduleGrokPoll()
    await load()
  } catch (cause) {
    grokDialogVisible.value = false
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    grokPendingAction.value = null
    saving.value = false
  }
}

async function beginGrokDisconnect() {
  saving.value = true
  error.value = ''
  notice.value = ''
  stopGrokPolling()
  grokAuthorization.value = null
  grokPendingAction.value = 'disconnect'
  grokDialogVisible.value = true
  try {
    grokAuthorization.value = await disconnectGrokSubscription()
    scheduleGrokPoll()
    await load()
  } catch (cause) {
    grokDialogVisible.value = false
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    grokPendingAction.value = null
    saving.value = false
  }
}

function openGrokVerification() {
  if (!grokAuthorization.value?.verificationUri) return
  window.open(grokAuthorization.value.verificationUri, '_blank', 'noopener,noreferrer')
}

async function copyGrokCode() {
  if (!grokAuthorization.value?.userCode) return
  await navigator.clipboard.writeText(grokAuthorization.value.userCode)
  notice.value = t('sources.grok.codeCopied')
}

function closeGrokDialog() {
  grokDialogVisible.value = false
  stopGrokPolling()
}

function grokConnectionBusy(connection: SourceConnection) {
  return ['connecting', 'waiting_for_user', 'disconnecting'].includes(connection.subscription?.state || '')
}

function grokDialogTitle() {
  return (grokAuthorization.value?.action || grokPendingAction.value) === 'disconnect'
    ? t('sources.grok.dialogDisconnectTitle')
    : t('sources.grok.dialogConnectTitle')
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
  if (!isWorkspaceCapability(capabilityId)) return
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
  if (capabilityId && !isWorkspaceCapability(capabilityId)) return
  workspaceConnection.value = connection
  selectedWorkspaceCapabilities.value = capabilityId
    ? [capabilityId]
    : connection
      ? connection.capabilities
        .filter((capability) => capability.status !== 'disabled')
        .map((capability) => capability.capabilityId)
        .filter(isWorkspaceCapability)
      : [...workspaceCapabilityIds]
  workspaceDialogVisible.value = true
}

function toggleWorkspaceCapability(capabilityId: WorkspaceCapabilityId) {
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
    calendars.value = connection.connectorId === 'microsoft_365'
      ? await getMicrosoftOutlookCalendars(connection.id)
      : await getGoogleCalendars(connection.id)
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
    if (calendarConnection.value.connectorId === 'microsoft_365') {
      await selectMicrosoftOutlookCalendars(calendarConnection.value.id, selectedCalendarIds.value)
    } else {
      await selectGoogleCalendars(calendarConnection.value.id, selectedCalendarIds.value)
    }
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
    if (connection.connectorId === 'microsoft_365') {
      await syncMicrosoftOutlookCalendars(connection.id)
    } else {
      await syncGoogleCalendars(connection.id)
    }
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    synchronizingId.value = ''
  }
}

async function openMailPicker(connection: SourceConnection) {
  loadingLabels.value = true
  error.value = ''
  mailConnection.value = connection
  mailLabels.value = []
  selectedLabelIds.value = []
  try {
    mailLabels.value = await getGmailLabels(connection.id)
    selectedLabelIds.value = mailLabels.value
      .filter((label) => label.selected)
      .map((label) => label.id)
  } catch (cause) {
    mailConnection.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loadingLabels.value = false
  }
}

function toggleLabel(labelId: string) {
  selectedLabelIds.value = selectedLabelIds.value.includes(labelId)
    ? selectedLabelIds.value.filter((id) => id !== labelId)
    : [...selectedLabelIds.value, labelId]
}

async function saveLabelSelection() {
  if (!mailConnection.value) return
  saving.value = true
  error.value = ''
  try {
    await selectGmailLabels(mailConnection.value.id, selectedLabelIds.value)
    mailConnection.value = null
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

async function synchronizeMail(connection: SourceConnection) {
  synchronizingId.value = `${connection.id}:mail`
  error.value = ''
  try {
    if (connection.connectorId === 'microsoft_365') {
      await syncMicrosoftOutlook(connection.id)
    } else {
      await syncGmailLabels(connection.id)
    }
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    synchronizingId.value = ''
  }
}

async function replaySync(
  connection: SourceConnection,
  descriptor: SourceCapabilityDescriptor,
  runId: string,
) {
  synchronizingId.value = capabilitySyncOperationId(connection, descriptor)
  error.value = ''
  try {
    await replaySourceSync(connection.id, runId)
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

function closeMailPicker() {
  if (saving.value) return
  mailConnection.value = null
  mailLabels.value = []
  selectedLabelIds.value = []
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
    const folderIds = selectedFolders.value.map((folder) => folder.id)
    try {
      await selectGoogleDriveFolders(driveConnection.value.id, folderIds)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (
        !message.includes('DRIVE_SELECTION_BROADENING_REQUIRES_CONFIRMATION')
        || !window.confirm(t('sources.folderBroadeningConfirm'))
      ) throw cause
      await selectGoogleDriveFolders(driveConnection.value.id, folderIds, true)
    }
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

async function synchronizeGitHub(connection: SourceConnection) {
  synchronizingId.value = `${connection.id}:github`
  error.value = ''
  notice.value = ''
  try {
    const result = await syncGitHubIssues(connection.id)
    notice.value = t('sources.github.synchronized', {
      repositories: result.repositories,
      issues: result.issues,
    })
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
  const microsoftResult = params.get('microsoft')
  await load()
  const grokConnection = data.value?.connections.find(
    (connection) => connection.connectorId === 'grok_subscription',
  )
  const grokSessionId = grokConnection?.subscription?.currentAuthSessionId
  if (
    grokSessionId
    && ['connecting', 'waiting_for_user', 'disconnecting'].includes(grokConnection.subscription?.state || '')
  ) {
    try {
      grokAuthorization.value = await getGrokSubscriptionAuthorization(grokSessionId)
      if (['starting', 'waiting_for_user'].includes(grokAuthorization.value.status)) {
        grokDialogVisible.value = true
        scheduleGrokPoll()
      }
    } catch {
      // A stale retained session must not block the rest of Sources.
    }
  }
  if (workspaceResult === 'connected') notice.value = t('sources.workspaceConnected')
  else if (workspaceResult === 'partial') error.value = t('sources.workspacePartial')
  else if (workspaceResult === 'denied') error.value = t('sources.googleDenied')
  else if (workspaceResult === 'failed' || workspaceResult === 'invalid') error.value = t('sources.googleFailed')
  if (microsoftResult === 'connected') notice.value = t('sources.microsoft.connected')
  else if (microsoftResult === 'partial') error.value = t('sources.microsoft.partial')
  else if (microsoftResult) error.value = t(`sources.microsoft.authorization.${microsoftResult}`)
  if (workspaceResult || microsoftResult) window.history.replaceState({}, '', window.location.pathname)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentClick)
  stopGrokPolling()
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
      v-model:visible="audienceDialogVisible"
      modal
      blockScroll
      :draggable="false"
      :header="t('sources.audience.title')"
      class="w-[calc(100vw-2rem)] sm:w-[min(36rem,calc(100vw-4rem))] my-auto"
      contentClass="!p-0"
    >
      <form v-if="audienceResource" @submit.prevent="saveAudience">
        <div class="grid gap-4 px-4 py-5 sm:px-6">
          <div>
            <div class="font-semibold text-surface-900">{{ resourceName(audienceResource) }}</div>
            <p class="m-0 mt-1 text-sm leading-relaxed text-surface-500">{{ t('sources.audience.description') }}</p>
          </div>
          <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-surface-200 p-3">
            <input
              type="radio"
              name="resource-audience"
              class="mt-1 h-4 w-4 accent-emerald-700"
              :checked="audienceVisibility === 'company'"
              @change="chooseAudienceVisibility('company')"
            />
            <span>
              <span class="block font-semibold">{{ t('sources.audience.company') }}</span>
              <span class="block text-sm text-surface-500">{{ t('sources.audience.companyDescription') }}</span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-surface-200 p-3">
            <input
              type="radio"
              name="resource-audience"
              class="mt-1 h-4 w-4 accent-emerald-700"
              :checked="audienceVisibility === 'restricted'"
              @change="chooseAudienceVisibility('restricted')"
            />
            <span>
              <span class="block font-semibold">{{ t('sources.audience.selected') }}</span>
              <span class="block text-sm text-surface-500">{{ t('sources.audience.selectedDescription') }}</span>
            </span>
          </label>
          <div v-if="audienceVisibility === 'restricted'" class="grid max-h-64 gap-2 overflow-y-auto rounded-xl bg-surface-50 p-3">
            <label
              v-for="member in teamMembers"
              :key="member.uid"
              class="flex cursor-pointer items-center gap-3 rounded-lg bg-white px-3 py-2"
            >
              <input
                type="checkbox"
                class="h-4 w-4 accent-emerald-700"
                :checked="audienceMemberIds.includes(member.uid)"
                @change="toggleAudienceMember(member.uid)"
              />
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold">{{ member.displayName }}</span>
                <span class="block truncate text-xs text-surface-500">{{ member.email }}</span>
              </span>
            </label>
            <Message v-if="audienceMemberIds.length === 0" severity="warn" :closable="false">
              {{ t('sources.audience.chooseMember') }}
            </Message>
          </div>
          <Message v-if="audienceBroadeningConfirmed" severity="warn" :closable="false">
            {{ t('sources.audience.broadeningWarning') }}
          </Message>
          <Message severity="info" :closable="false">{{ t('sources.audience.reindexNotice') }}</Message>
        </div>
        <div class="flex flex-col-reverse gap-2 border-t border-surface-200 px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            type="button"
            :disabled="audienceSaving"
            @click="audienceDialogVisible = false"
          />
          <Button
            :label="audienceBroadeningConfirmed ? t('sources.audience.confirmBroader') : t('common.save')"
            icon="pi pi-shield"
            type="submit"
            :severity="audienceBroadeningConfirmed ? 'warn' : undefined"
            :loading="audienceSaving"
            :disabled="audienceVisibility === 'restricted' && audienceMemberIds.length === 0"
          />
        </div>
      </form>
    </Dialog>

    <Dialog
      v-model:visible="grokDialogVisible"
      modal
      blockScroll
      :draggable="false"
      :header="grokDialogTitle()"
      class="w-[calc(100vw-2rem)] sm:w-[min(34rem,calc(100vw-4rem))] my-auto"
      contentClass="!p-0 flex flex-col min-w-0 overflow-hidden"
      @hide="stopGrokPolling"
    >
      <div v-if="grokAuthorization" class="grid gap-4 px-4 py-5 sm:px-6">
        <div
          v-if="grokAuthorization.status === 'starting'"
          class="flex flex-col items-center gap-3 py-8 text-center"
        >
          <ProgressSpinner class="h-10 w-10" />
          <p class="m-0 text-sm leading-relaxed text-surface-500">
            {{ grokAuthorization.action === 'disconnect' ? t('sources.grok.disconnecting') : t('sources.grok.starting') }}
          </p>
        </div>

        <template v-else-if="grokAuthorization.status === 'waiting_for_user'">
          <Message severity="info" :closable="false">{{ t('sources.grok.waiting') }}</Message>
          <div class="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 text-center">
            <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-indigo-700">
              {{ t('sources.grok.authorizationCode') }}
            </div>
            <code class="block text-3xl font-bold tracking-[0.18em] text-indigo-950 sm:text-4xl">
              {{ grokAuthorization.userCode }}
            </code>
          </div>
          <p class="m-0 text-sm leading-relaxed text-surface-500">{{ t('sources.grok.codeHint') }}</p>
          <div class="grid gap-2 sm:grid-cols-2">
            <Button
              :label="t('sources.grok.copyCode')"
              icon="pi pi-copy"
              severity="secondary"
              outlined
              @click="copyGrokCode"
            />
            <Button
              :label="t('sources.grok.open')"
              icon="pi pi-external-link"
              @click="openGrokVerification"
            />
          </div>
          <p v-if="grokAuthorization.expiresAt" class="m-0 text-center text-xs text-surface-400">
            {{ t('sources.grok.expires') }}: {{ formatDate(grokAuthorization.expiresAt) }}
          </p>
        </template>

        <Message v-else-if="grokAuthorization.status === 'completed'" severity="success" :closable="false">
          {{ grokAuthorization.action === 'connect' ? t('sources.grok.connected') : t('sources.grok.disconnected') }}
        </Message>
        <Message v-else severity="error" :closable="false">
          {{ grokAuthorization.error || t('sources.grok.failed') }}
        </Message>
      </div>
      <div v-else class="flex flex-col items-center gap-3 px-4 py-12 text-center sm:px-6">
        <ProgressSpinner class="h-10 w-10" />
        <p class="m-0 text-sm leading-relaxed text-surface-500">
          {{ grokPendingAction === 'disconnect' ? t('sources.grok.disconnecting') : t('sources.grok.starting') }}
        </p>
      </div>
      <div class="flex justify-end border-t border-surface-200 bg-white px-4 py-3 sm:px-6">
        <Button :label="t('common.close')" severity="secondary" text @click="closeGrokDialog" />
      </div>
    </Dialog>

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
            v-for="capabilityId in workspaceCapabilityIds"
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
          <Message
            v-if="selectedWorkspaceCapabilities.includes('context.mail.read_scoped')"
            severity="warn"
            :closable="false"
          >
            {{ t('sources.mailFullMailboxNotice') }}
          </Message>
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
          <p v-if="calendars.length === 0" class="text-sm text-surface-500">
            {{ t(calendarConnection?.connectorId === 'microsoft_365' ? 'sources.calendarPicker.noneMicrosoft' : 'sources.calendarPicker.none') }}
          </p>
          <Message severity="warn" :closable="false">
            {{ t(calendarConnection?.connectorId === 'microsoft_365' ? 'sources.calendarPicker.privacyRestricted' : 'sources.calendarPicker.privacy') }}
          </Message>
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
      v-model:visible="slackPickerVisible"
      modal
      blockScroll
      dismissableMask
      :draggable="false"
      :header="t('sources.slack.pickerTitle')"
      class="w-[calc(100vw-2rem)] sm:w-[min(40rem,calc(100vw-4rem))] max-h-[calc(100dvh-4rem)] my-auto"
      contentClass="!p-0 flex flex-col min-h-0 min-w-0 overflow-hidden"
    >
      <div v-if="loadingSlackChannels" class="flex flex-col items-center justify-center gap-3 px-4 py-14">
        <ProgressSpinner />
      </div>
      <form v-else class="flex flex-col min-h-0 min-w-0 overflow-hidden" @submit.prevent="saveSlackSelection">
        <div class="flex-1 min-h-0 grid content-start gap-3 overflow-y-auto px-4 py-4 sm:px-6">
          <Message severity="info" :closable="false">{{ t('sources.slack.privacy') }}</Message>
          <label
            v-for="channel in slackChannels"
            :key="channel.id"
            class="min-w-0 flex items-start gap-3 rounded-2xl border border-surface-200 bg-surface-50 p-3.5 cursor-pointer"
          >
            <input
              type="checkbox"
              class="mt-1 w-4 h-4 accent-emerald-700 shrink-0"
              :checked="selectedSlackChannelIds.includes(channel.id)"
              @change="toggleSlackChannel(channel.id)"
            />
            <span class="min-w-0 grow">
              <span class="font-semibold">{{ channel.displayName }}</span>
              <span v-if="channel.isPrivate" class="block text-xs text-surface-400 mt-1">{{ t('sources.slack.privateChannel') }}</span>
            </span>
          </label>
          <p v-if="slackChannels.length === 0" class="text-sm text-surface-500">{{ t('sources.slack.noChannels') }}</p>
        </div>
        <div class="shrink-0 flex flex-col-reverse gap-2 border-t border-surface-200 bg-white px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <Button :label="t('common.cancel')" severity="secondary" text type="button" :disabled="saving" @click="slackConnection = null" />
          <Button :label="t('sources.slack.saveChannels')" icon="pi pi-check" type="submit" :loading="saving" />
        </div>
      </form>
    </Dialog>

    <Dialog
      v-model:visible="mailPickerVisible"
      modal
      blockScroll
      dismissableMask
      :draggable="false"
      :header="t('sources.mailPicker.title')"
      class="w-[calc(100vw-2rem)] sm:w-[min(40rem,calc(100vw-4rem))] max-h-[calc(100dvh-4rem)] my-auto"
      contentClass="!p-0 flex flex-col min-h-0 min-w-0 overflow-hidden"
    >
      <div v-if="loadingLabels" class="flex flex-col items-center justify-center gap-3 px-4 py-14">
        <ProgressSpinner />
      </div>

      <form v-else class="flex flex-col min-h-0 min-w-0 overflow-hidden" @submit.prevent="saveLabelSelection">
        <div class="flex-1 min-h-0 grid content-start gap-3 overflow-y-auto px-4 py-4 sm:px-6">
          <div>
            <p class="m-0 text-sm leading-relaxed text-surface-500">{{ t('sources.mailPicker.description') }}</p>
            <p v-if="mailConnection?.accountLabel" class="m-0 mt-1 text-sm font-medium text-surface-700 break-all">
              {{ mailConnection.accountLabel }}
            </p>
          </div>
          <label
            v-for="label in mailLabels"
            :key="label.id"
            class="min-w-0 flex items-start gap-3 rounded-2xl border border-surface-200 bg-surface-50 p-3.5 cursor-pointer"
          >
            <input
              type="checkbox"
              class="mt-1 w-4 h-4 accent-emerald-700 shrink-0"
              :checked="selectedLabelIds.includes(label.id)"
              @change="toggleLabel(label.id)"
            />
            <span class="min-w-0 grow">
              <span class="flex items-center gap-2 flex-wrap font-semibold">
                {{ label.displayName }}
                <Tag v-if="label.type === 'system'" :value="t('sources.mailPicker.system')" severity="secondary" rounded />
              </span>
              <span v-if="label.messageCount !== null" class="block text-xs text-surface-400 mt-1">
                {{ t('sources.mailPicker.messageCount', { count: label.messageCount }) }}
              </span>
            </span>
          </label>
          <p v-if="mailLabels.length === 0" class="text-sm text-surface-500">{{ t('sources.mailPicker.none') }}</p>
          <Message severity="warn" :closable="false">{{ t('sources.mailFullMailboxNotice') }}</Message>
          <Message severity="info" :closable="false">{{ t('sources.mailPicker.privacy') }}</Message>
        </div>

        <div class="shrink-0 flex flex-col-reverse gap-2 border-t border-surface-200 bg-white px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          <Button
            :label="t('common.cancel')"
            severity="secondary"
            text
            type="button"
            :disabled="saving"
            @click="closeMailPicker"
          />
          <Button
            :label="t('sources.mailPicker.submit')"
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
        : pendingDeleteConnection?.connectorId === 'microsoft_365'
          ? t('sources.microsoft.disconnect')
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
          {{ t(deleteDescriptionKey(pendingDeleteConnection)) }}
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
            : pendingDeleteConnection?.connectorId === 'microsoft_365'
              ? t('sources.microsoft.disconnect')
            : t('sources.deletePermanently')"
          icon="pi pi-trash"
          severity="danger"
          :loading="Boolean(deletingId)"
          @click="pendingDeleteConnection && deleteConnection(pendingDeleteConnection)"
        />
      </div>
    </Dialog>

    <div v-if="loading" class="flex justify-center py-24"><ProgressSpinner /></div>

    <template v-else>
      <Card
        v-if="isAdmin"
        class="mb-5 min-w-0 rounded-lg border border-surface-200 overflow-hidden [&_.p-card-body]:p-4 sm:[&_.p-card-body]:p-6"
      >
        <template #title>
          <div class="min-w-0 flex items-start justify-between gap-3">
            <div class="min-w-0 flex items-center gap-3">
              <span class="w-10 h-10 rounded-md bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0">
                <i class="pi pi-database text-lg" />
              </span>
              <div class="min-w-0">
                <div>{{ t('sources.searchIndex.title') }}</div>
                <div class="text-xs font-normal text-surface-400 mt-0.5">{{ t('sources.searchIndex.boundary') }}</div>
              </div>
            </div>
            <Tag
              v-if="searchIndex"
              :value="t(`sources.searchIndex.health.${searchIndex.health}`)"
              :severity="searchIndexHealthSeverity(searchIndex.health)"
              rounded
            />
          </div>
        </template>
        <template #subtitle><span class="leading-relaxed">{{ t('sources.searchIndex.description') }}</span></template>
        <template #content>
          <Message v-if="searchIndexError" severity="warn" :closable="false">{{ searchIndexError }}</Message>
          <div v-if="searchIndex" class="grid gap-3">
            <div
              v-if="searchIndex.untrackedRecords > 0"
              class="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <p class="m-0 text-sm leading-relaxed text-amber-950">
                {{ t('sources.searchIndex.untracked', { count: searchIndex.untrackedRecords }) }}
              </p>
              <Button
                :label="t('sources.searchIndex.backfill')"
                icon="pi pi-database"
                severity="warn"
                size="small"
                class="shrink-0"
                :loading="backfillingIndex"
                @click="backfillIndexDeliveries"
              />
            </div>
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <div class="rounded-xl bg-surface-50 border border-surface-200 p-3">
                <div class="text-xs text-surface-500">{{ t('sources.searchIndex.tracked') }}</div>
                <div class="mt-1 text-xl font-semibold text-surface-900">{{ searchIndex.trackedRecords }} / {{ searchIndex.expectedRecords }}</div>
              </div>
              <div class="rounded-xl bg-surface-50 border border-surface-200 p-3">
                <div class="text-xs text-surface-500">{{ t('sources.searchIndex.pending') }}</div>
                <div class="mt-1 text-xl font-semibold text-surface-900">{{ searchIndexPendingCount }}</div>
              </div>
              <div class="rounded-xl bg-surface-50 border border-surface-200 p-3">
                <div class="text-xs text-surface-500">{{ t('sources.searchIndex.attention') }}</div>
                <div class="mt-1 text-xl font-semibold text-surface-900">{{ searchIndex.counts.attention }}</div>
              </div>
              <div class="rounded-xl bg-surface-50 border border-surface-200 p-3">
                <div class="text-xs text-surface-500">{{ t('sources.searchIndex.lastSuccess') }}</div>
                <div class="mt-1 text-sm font-semibold text-surface-900">{{ formatDate(searchIndex.lastSuccessAt) }}</div>
              </div>
              <div class="rounded-xl bg-surface-50 border border-surface-200 p-3">
                <div class="text-xs text-surface-500">{{ t('sources.searchIndex.p95') }}</div>
                <div class="mt-1 text-sm font-semibold text-surface-900">{{ formatIndexDuration(searchIndex.p95ContextToSearchMs) }}</div>
              </div>
            </div>

            <Message
              v-if="searchIndex.p95ContextToSearchMs !== null && searchIndex.p95ContextToSearchMs > searchIndex.targetMs"
              severity="warn"
              :closable="false"
            >
              {{ t('sources.searchIndex.targetMissed', { target: formatIndexDuration(searchIndex.targetMs) }) }}
            </Message>
            <p v-else class="m-0 text-xs leading-relaxed text-surface-500">
              {{ t('sources.searchIndex.target', { target: formatIndexDuration(searchIndex.targetMs), count: searchIndex.freshnessSampleSize }) }}
            </p>
            <p v-if="searchIndex.oldestOutstandingAt" class="m-0 text-xs text-surface-500">
              {{ t('sources.searchIndex.oldestOutstanding') }}:
              <strong class="text-surface-700">{{ formatDate(searchIndex.oldestOutstandingAt) }}</strong>
            </p>

            <div v-if="searchIndex.sourceFreshness?.length" class="grid gap-2 sm:grid-cols-2">
              <div
                v-for="sample in searchIndex.sourceFreshness"
                :key="`${sample.capabilityId}:${sample.trigger}`"
                class="rounded-xl border border-surface-200 bg-surface-50 p-3 text-xs"
              >
                <div class="font-semibold text-surface-800">
                  {{ capabilityName(sample.capabilityId) }} · {{ t(`sources.searchIndex.triggers.${sample.trigger}`) }}
                </div>
                <div class="mt-2 grid gap-1 text-surface-500">
                  <span>{{ t('sources.searchIndex.sourceToContext') }}: <strong class="text-surface-700">{{ formatIndexDuration(sample.p95SourceToContextMs) }}</strong></span>
                  <span>{{ t('sources.searchIndex.sourceToSearch') }}: <strong class="text-surface-700">{{ formatIndexDuration(sample.p95SourceToSearchMs) }}</strong></span>
                  <span>{{ t('sources.searchIndex.sourceTarget', { target: formatIndexDuration(sample.targetMs), count: sample.sampleSize }) }}</span>
                </div>
              </div>
            </div>

            <div v-if="searchIndex.attentionDeliveries.length" class="grid gap-2">
              <div class="text-sm font-semibold text-surface-800">{{ t('sources.searchIndex.failedTitle') }}</div>
              <div
                v-for="delivery in searchIndex.attentionDeliveries"
                :key="delivery.id"
                class="min-w-0 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div class="min-w-0">
                  <div class="text-sm font-medium text-surface-900 break-all">{{ delivery.sourcePath }}</div>
                  <div class="mt-1 text-xs text-amber-900 break-words">{{ delivery.lastError || t('sources.searchIndex.unknownError') }}</div>
                  <div class="mt-1 text-xs text-surface-400">
                    {{ t('sources.searchIndex.attempts', { count: delivery.attempt }) }} · {{ formatDate(delivery.lastAttemptAt) }}
                  </div>
                </div>
                <Button
                  :label="t('sources.searchIndex.replay')"
                  icon="pi pi-replay"
                  severity="warn"
                  size="small"
                  class="shrink-0"
                  :loading="replayingIndexDeliveryId === delivery.id"
                  @click="replayIndexDelivery(delivery.id)"
                />
              </div>
            </div>
          </div>
        </template>
      </Card>

      <div class="grid gap-5 lg:grid-cols-2">
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
              :value="connectorTag(connector)"
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
              <div class="font-semibold text-sm text-emerald-950">{{ addConnectionTitle(connector) }}</div>
              <div class="text-xs text-emerald-800/80 mt-1 leading-relaxed">{{ addConnectionHint(connector) }}</div>
            </div>
            <Button
              :label="addConnectionLabel(connector)"
              :icon="addConnectionIcon(connector)"
              class="w-full sm:w-auto shrink-0"
              :loading="saving"
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
                    {{ connectionKindLabel(connection) }}
                  </p>
                </div>
                <Tag
                  :value="connectionStatusLabel(connection)"
                  :severity="connectionStatusSeverity(connection)"
                  rounded
                />
              </div>

              <div
                v-if="connection.connectorId === 'google_workspace' && connection.reauthorizationRequired"
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

              <section
                v-if="connection.connectorId === 'microsoft_365'"
                class="mb-3 grid gap-3 rounded-xl border border-surface-200 bg-white p-3"
              >
                <div class="grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <div class="text-surface-400">{{ t('sources.microsoft.tenant') }}</div>
                    <div class="mt-1 break-all font-semibold text-surface-800">{{ connection.tenantId }}</div>
                  </div>
                  <div>
                    <div class="text-surface-400">{{ t('sources.microsoft.member') }}</div>
                    <div class="mt-1 break-all font-semibold text-surface-800">{{ connection.member?.displayName || connection.accountLabel }}</div>
                    <div class="break-all text-surface-500">{{ connection.member?.entraObjectId }}</div>
                  </div>
                </div>
                <Message
                  v-if="connection.authorization?.state !== 'healthy'"
                  severity="warn"
                  :closable="false"
                >
                  <div class="font-semibold">{{ t(`sources.microsoft.authorization.${connection.authorization?.state || 'error'}`) }}</div>
                  <div v-if="connection.authorization?.lastError" class="mt-1 text-xs">{{ connection.authorization.lastError }}</div>
                </Message>
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-500">
                  <span>{{ t('sources.microsoft.lastChecked') }}: <strong>{{ formatDate(connection.authorization?.lastCheckedAt) }}</strong></span>
                  <div v-if="isAdmin" class="flex flex-wrap gap-1">
                    <Button
                      :label="t('sources.microsoft.checkHealth')"
                      icon="pi pi-refresh"
                      severity="secondary"
                      text
                      size="small"
                      :loading="microsoftRefreshingId === connection.id"
                      @click="checkMicrosoftConnection(connection)"
                    />
                    <Button
                      v-if="connection.authorization?.state !== 'healthy'"
                      :label="t('sources.microsoft.reconnect')"
                      icon="pi pi-external-link"
                      severity="warn"
                      text
                      size="small"
                      @click="beginMicrosoftAuthorization(connection)"
                    />
                  </div>
                </div>
                <details class="rounded-xl bg-surface-50 px-3 py-2 text-xs text-surface-500">
                  <summary class="cursor-pointer font-semibold text-surface-700">{{ t('sources.microsoft.allDelegatedPermissions') }}</summary>
                  <ul class="mb-0 mt-2 grid gap-1 pl-4">
                    <li v-for="scope in connection.grantedScopes" :key="scope">{{ scopeLabel(scope) }}</li>
                  </ul>
                </details>
              </section>

              <div
                v-if="connection.connectorId === 'github'"
                class="mb-3 rounded-xl border border-surface-200 bg-white p-3"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-sm font-semibold text-surface-800">{{ t('sources.github.webhook.title') }}</div>
                    <p class="m-0 mt-1 text-xs leading-relaxed text-surface-500">
                      {{ t(`sources.github.webhook.${connection.webhook?.status === 'active' ? 'activeDescription' : connection.webhook?.status === 'attention' ? 'attentionDescription' : 'pendingDescription'}`) }}
                    </p>
                  </div>
                  <Tag
                    :value="webhookStatusLabel(connection)"
                    :severity="webhookStatusSeverity(connection)"
                    rounded
                  />
                </div>
                <div v-if="connection.webhook?.lastDeliveryAt" class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-500">
                  <span>{{ t('sources.github.webhook.lastDelivery') }}: <strong>{{ formatDate(connection.webhook.lastDeliveryAt) }}</strong></span>
                  <span v-if="connection.webhook.lastEvent">
                    {{ t('sources.github.webhook.event') }}: <strong>{{ connection.webhook.lastEvent }}{{ connection.webhook.lastAction ? ` · ${connection.webhook.lastAction}` : '' }}</strong>
                  </span>
                </div>
                <p v-if="connection.webhook?.lastError" class="m-0 mt-2 text-xs text-amber-800 break-words">
                  {{ connection.webhook.lastError }}
                </p>
              </div>

              <template v-if="connection.connectorId === 'grok_subscription'">
                <Message severity="info" :closable="false" class="mb-3">
                  {{ t('sources.grok.noApiKey') }}
                </Message>
                <div class="grid gap-2 rounded-xl border border-surface-200 bg-white p-3 text-sm">
                  <div class="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span class="text-surface-500">{{ t('sources.grok.lastAuthenticated') }}</span>
                    <strong class="text-right text-surface-800">{{ formatDate(connection.subscription?.lastAuthenticatedAt) }}</strong>
                  </div>
                  <div class="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span class="text-surface-500">{{ t('sources.grok.sessionExpires') }}</span>
                    <strong class="text-right text-surface-800">{{ formatDate(connection.subscription?.sessionExpiresAt) }}</strong>
                  </div>
                  <div v-if="connection.subscription?.teamId" class="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span class="text-surface-500">{{ t('sources.grok.team') }}</span>
                    <strong class="max-w-full break-all text-right text-surface-800">{{ connection.subscription.teamId }}</strong>
                  </div>
                  <div class="flex flex-wrap justify-between gap-x-4 gap-y-1">
                    <span class="text-surface-500">{{ t('sources.grok.lastRun') }}</span>
                    <strong class="text-right text-surface-800">{{ formatDate(connection.subscription?.lastSuccessfulRunAt) }}</strong>
                  </div>
                </div>
                <Message
                  v-if="connection.subscription?.lastError"
                  severity="warn"
                  :closable="false"
                  class="mt-3"
                >
                  {{ connection.subscription.lastError }}
                </Message>
                <div v-if="isAdmin" class="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    :label="connection.status === 'disconnected' ? t('sources.grok.connect') : t('sources.grok.reconnect')"
                    icon="pi pi-refresh"
                    severity="secondary"
                    outlined
                    :disabled="grokConnectionBusy(connection)"
                    :loading="saving"
                    @click="beginGrokAuthorization"
                  />
                  <Button
                    v-if="connection.status !== 'disconnected'"
                    :label="t('sources.grok.disconnect')"
                    icon="pi pi-power-off"
                    severity="danger"
                    outlined
                    :disabled="grokConnectionBusy(connection)"
                    :loading="saving"
                    @click="beginGrokDisconnect"
                  />
                </div>
              </template>

              <template v-else-if="connection.connectorId === 'odorik'">
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
                    <div class="flex shrink-0 items-center gap-1">
                      <Tag :value="audienceLabel(resource)" icon="pi pi-users" severity="secondary" rounded />
                      <Button
                        v-if="isAdmin"
                        :aria-label="t('sources.audience.edit')"
                        icon="pi pi-shield"
                        severity="secondary"
                        text
                        rounded
                        size="small"
                        @click="openAudienceEditor(connection, resource)"
                      />
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
                  </div>
                  <p v-if="connection.resources.length === 0" class="text-sm text-surface-400 m-0">{{ emptyResourceMessage('context.call.read') }}</p>
                </div>
              </template>

              <template v-else-if="connection.connectorId === 'slack'">
                <div class="grid gap-3">
                  <section class="rounded-2xl border border-surface-200 bg-white p-3.5">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <h4 class="m-0 text-sm font-semibold text-surface-900">{{ t('sources.slack.destinations') }}</h4>
                        <p class="m-0 mt-1 text-xs leading-relaxed text-surface-500">{{ t('sources.slack.destinationsHint') }}</p>
                      </div>
                      <Button
                        v-if="isAdmin"
                        :label="t('sources.slack.chooseChannels')"
                        icon="pi pi-list-check"
                        severity="secondary"
                        outlined
                        size="small"
                        @click="openSlackPicker(connection)"
                      />
                    </div>
                    <div v-if="connection.resources.length" class="mt-3 flex flex-wrap gap-2">
                      <Tag v-for="resource in connection.resources" :key="resource.id" :value="resource.displayName" icon="pi pi-hashtag" rounded />
                    </div>
                    <p v-else class="m-0 mt-3 text-sm text-surface-400">{{ t('sources.slack.noDestinations') }}</p>
                  </section>

                  <section class="rounded-2xl border border-surface-200 bg-white p-3.5">
                    <h4 class="m-0 text-sm font-semibold text-surface-900">{{ t('sources.slack.recentDeliveries') }}</h4>
                    <Message v-if="chatDeliveryError" severity="warn" :closable="false" class="mt-3">{{ chatDeliveryError }}</Message>
                    <div v-if="deliveriesForConnection(connection.id).length" class="mt-3 grid gap-2">
                      <div
                        v-for="delivery in deliveriesForConnection(connection.id)"
                        :key="delivery.id"
                        class="rounded-xl border border-surface-200 p-3 text-xs"
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="font-semibold text-surface-800">{{ slackChannelName(connection, delivery.channelId) }}</div>
                            <div class="mt-1 text-surface-400">{{ formatDate(delivery.updatedAt) }}</div>
                          </div>
                          <Tag :value="t(`sources.slack.delivery.${delivery.status}`)" :severity="chatDeliverySeverity(delivery.status)" rounded />
                        </div>
                        <p v-if="delivery.error" class="m-0 mt-2 break-words text-amber-800">{{ delivery.error }}</p>
                        <div class="mt-2 flex justify-end gap-2">
                          <a v-if="delivery.permalink" :href="delivery.permalink" target="_blank" rel="noopener noreferrer" class="self-center font-semibold text-emerald-800 no-underline">
                            {{ t('sources.slack.openMessage') }}
                          </a>
                          <Button
                            v-if="delivery.status === 'failed_safe_to_retry'"
                            :label="t('sources.slack.retry')"
                            icon="pi pi-replay"
                            severity="warn"
                            text
                            size="small"
                            :loading="retryingChatApprovalId === delivery.approvalId"
                            @click="retryChatDelivery(delivery)"
                          />
                        </div>
                      </div>
                    </div>
                    <p v-else class="m-0 mt-3 text-sm text-surface-400">{{ t('sources.slack.noDeliveries') }}</p>
                  </section>
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
                        <h4 class="m-0 text-sm font-semibold text-surface-900">{{ capabilityName(descriptor.id, connection.connectorId) }}</h4>
                      </div>
                      <p class="m-0 mt-1 text-xs leading-relaxed text-surface-500">{{ capabilityDescription(descriptor.id, connection.connectorId) }}</p>
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
                    <div
                      v-if="capabilityConfiguration(connection, descriptor)?.sync"
                      class="mt-2 rounded-xl border border-surface-200 bg-surface-50 p-3 text-xs"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <span class="font-semibold text-surface-700">{{ t('sources.sync.title') }}</span>
                        <Tag
                          :value="syncHealthLabel(capabilityConfiguration(connection, descriptor)?.sync?.health)"
                          :severity="syncHealthSeverity(capabilityConfiguration(connection, descriptor)?.sync?.health)"
                          rounded
                        />
                      </div>
                      <div class="mt-2 grid gap-1 text-surface-500 sm:grid-cols-2">
                        <span>{{ t('sources.sync.lastAttempt') }}: <strong class="text-surface-700">{{ formatDate(capabilityConfiguration(connection, descriptor)?.sync?.lastAttemptAt) }}</strong></span>
                        <span>{{ t('sources.sync.lastSuccess') }}: <strong class="text-surface-700">{{ formatDate(capabilityConfiguration(connection, descriptor)?.sync?.lastSuccessAt) }}</strong></span>
                        <span v-if="capabilityConfiguration(connection, descriptor)?.sync?.nextRetryAt">
                          {{ t('sources.sync.nextRetry') }}: <strong class="text-surface-700">{{ formatDate(capabilityConfiguration(connection, descriptor)?.sync?.nextRetryAt) }}</strong>
                        </span>
                      </div>
                      <Message
                        v-if="capabilityConfiguration(connection, descriptor)?.sync?.lastError"
                        severity="warn"
                        :closable="false"
                        class="mt-2"
                      >
                        {{ capabilityConfiguration(connection, descriptor)?.sync?.lastError }}
                      </Message>
                    </div>
                    <details class="mt-2 rounded-xl bg-surface-50 px-3 py-2 text-xs text-surface-500">
                      <summary class="cursor-pointer font-semibold text-surface-700">{{ permissionDetailsLabel(connection) }}</summary>
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
                          <div v-if="resource.document" class="mt-1 text-xs text-surface-400">
                            {{ t('sources.driveExtractionSummary', {
                              markdown: resource.document.markdownCount,
                              text: resource.document.plainTextCount,
                              metadata: resource.document.metadataOnlyCount,
                            }) }}
                          </div>
                        </div>
                        <div class="flex shrink-0 items-center gap-1">
                          <Tag :value="audienceLabel(resource)" icon="pi pi-users" severity="secondary" rounded />
                          <Button
                            v-if="isAdmin"
                            :aria-label="t('sources.audience.edit')"
                            icon="pi pi-shield"
                            severity="secondary"
                            text
                            rounded
                            size="small"
                            @click="openAudienceEditor(connection, resource)"
                          />
                          <Button
                            v-if="isAdmin"
                            :label="resource.status === 'enabled' ? t('sources.pause') : t('sources.resume')"
                            severity="secondary"
                            text
                            size="small"
                            @click="toggleResource(connection, resource.id, resource.status !== 'enabled')"
                          />
                        </div>
                      </div>
                      <p v-if="capabilityResources(connection, descriptor.id).length === 0" class="m-0 text-sm text-surface-400">
                        {{ emptyResourceMessage(descriptor.id) }}
                      </p>
                    </div>

                    <div v-if="isAdmin" class="mt-3 flex flex-wrap justify-end gap-1">
                      <Button
                        v-if="descriptor.id === 'context.calendar.read' && ['active', 'permission_granted'].includes(capabilityConfiguration(connection, descriptor)?.status || '')"
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
                        v-if="connection.connectorId === 'google_workspace' && descriptor.id === 'context.mail.read_scoped' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="t('sources.chooseLabels')"
                        icon="pi pi-list-check"
                        severity="secondary"
                        text
                        size="small"
                        @click="openMailPicker(connection)"
                      />
                      <Button
                        v-if="descriptor.id === 'context.mail.read_scoped' && ['active', 'permission_granted'].includes(capabilityConfiguration(connection, descriptor)?.status || '')"
                        :label="synchronizingId === `${connection.id}:mail` ? t('sources.syncing') : t('sources.syncNow')"
                        icon="pi pi-refresh"
                        severity="secondary"
                        text
                        size="small"
                        :loading="synchronizingId === `${connection.id}:mail`"
                        @click="synchronizeMail(connection)"
                      />
                      <Button
                        v-if="descriptor.id === 'context.github.issue.read' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="synchronizingId === `${connection.id}:github` ? t('sources.syncing') : t('sources.syncNow')"
                        icon="pi pi-refresh"
                        severity="secondary"
                        text
                        size="small"
                        :loading="synchronizingId === `${connection.id}:github`"
                        @click="synchronizeGitHub(connection)"
                      />
                      <Button
                        v-if="capabilityConfiguration(connection, descriptor)?.status === 'attention' && capabilityConfiguration(connection, descriptor)?.sync?.health === 'attention' && capabilityConfiguration(connection, descriptor)?.sync?.latestRunId"
                        :label="t('sources.sync.replay')"
                        icon="pi pi-replay"
                        severity="warn"
                        text
                        size="small"
                        :loading="synchronizingId === capabilitySyncOperationId(connection, descriptor)"
                        @click="replaySync(connection, descriptor, capabilityLatestRunId(connection, descriptor))"
                      />
                      <Button
                        v-if="connection.connectorId === 'google_workspace' && capabilityConfiguration(connection, descriptor)?.status === 'reauthorization_required'"
                        :label="t('sources.workspace.grantPermission')"
                        icon="pi pi-refresh"
                        severity="warn"
                        text
                        size="small"
                        @click="openWorkspaceAuthorization(connection, descriptor.id)"
                      />
                      <Button
                        v-else-if="connection.connectorId === 'google_workspace' && capabilityConfiguration(connection, descriptor)?.status === 'disabled'"
                        :label="t('sources.workspace.enableService')"
                        icon="pi pi-check-circle"
                        severity="success"
                        text
                        size="small"
                        @click="toggleCapability(connection, descriptor.id, true)"
                      />
                      <Button
                        v-else-if="connection.connectorId === 'google_workspace' && capabilityConfiguration(connection, descriptor)?.status === 'active'"
                        :label="t('sources.workspace.disableService')"
                        icon="pi pi-minus-circle"
                        severity="secondary"
                        text
                        size="small"
                        @click="toggleCapability(connection, descriptor.id, false)"
                      />
                      <Button
                        v-if="connection.connectorId === 'microsoft_365' && ['attention', 'reauthorization_required'].includes(capabilityConfiguration(connection, descriptor)?.status || '')"
                        :label="t('sources.microsoft.grantPermission')"
                        icon="pi pi-external-link"
                        severity="warn"
                        text
                        size="small"
                        @click="beginMicrosoftAuthorization(connection, descriptor.id)"
                      />
                      <Button
                        v-else-if="connection.connectorId === 'microsoft_365' && capabilityConfiguration(connection, descriptor)?.status === 'disabled'"
                        :label="t('sources.microsoft.enableCapability')"
                        icon="pi pi-check-circle"
                        severity="success"
                        text
                        size="small"
                        @click="toggleCapability(connection, descriptor.id, true)"
                      />
                      <Button
                        v-else-if="connection.connectorId === 'microsoft_365' && ['permission_granted', 'active'].includes(capabilityConfiguration(connection, descriptor)?.status || '')"
                        :label="t('sources.microsoft.disableCapability')"
                        icon="pi pi-minus-circle"
                        severity="secondary"
                        text
                        size="small"
                        @click="toggleCapability(connection, descriptor.id, false)"
                      />
                    </div>
                  </template>
                  <Button
                    v-else-if="isAdmin && connection.connectorId === 'google_workspace'"
                    :label="t('sources.workspace.enableService')"
                    icon="pi pi-plus"
                    severity="secondary"
                    outlined
                    size="small"
                    class="mt-3 w-full"
                    @click="openWorkspaceAuthorization(connection, descriptor.id)"
                  />
                  <Button
                    v-else-if="isAdmin && connection.connectorId === 'microsoft_365'"
                    :label="t('sources.microsoft.grantPermission')"
                    icon="pi pi-external-link"
                    severity="secondary"
                    outlined
                    size="small"
                    class="mt-3 w-full"
                    @click="beginMicrosoftAuthorization(connection, descriptor.id)"
                  />
                </section>
              </div>

              <div v-if="isAdmin && connection.connectorId !== 'grok_subscription'" class="flex flex-wrap justify-end mt-3">
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
                  :label="connection.connectorId === 'google_workspace'
                    ? t('sources.workspace.disconnectAccount')
                    : connection.connectorId === 'microsoft_365'
                      ? t('sources.microsoft.disconnect')
                      : t('sources.deleteConnection')"
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
    </template>
  </section>
</template>
