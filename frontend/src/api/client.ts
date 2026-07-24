import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '@odorik/functions/router'
import { auth } from '../firebase'

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: import.meta.env.VITE_API_URL || '/api',
      async headers() {
        const token = await auth.currentUser?.getIdToken()
        return token ? { Authorization: `Bearer ${token}` } : {}
      },
    }),
  ],
})

export type AccessStatus = {
  exists: boolean
  enabled: boolean
  admin: boolean
  email: string
  displayName: string
  photoURL: string
}

export type IntakeListItem = {
  id: string
  status: 'open' | 'completed' | 'dismissed'
  createdAt: string | null
  requestId: string
  requestStatus: string
  revision: number
  title: string
  missingInformation: string[]
  contactName: string | null
  phone: string | null
  occurredAt: string | null
  summary: string | null
}

export type FieldProposal = {
  field: 'contactName' | 'requestTitle' | 'serviceType' | 'description' | 'address' | 'requestedTiming' | 'urgency' | 'notes'
  value: string
  support: 'explicit' | 'inferred'
  evidence: Array<{ segmentIndex: number; quote: string }>
}

export type IntakeDetails = {
  request: Record<string, unknown> & { id: string; revision: number; missingInformation?: string[] }
  contact: (Record<string, unknown> & { id: string }) | null
  interaction: (Record<string, unknown> & {
    id: string
    transcript?: string
    summary?: string
    from?: string
    segments?: Array<{ speaker?: string; text?: string }>
  }) | null
  processingRun: (Record<string, unknown> & { id: string; proposals?: FieldProposal[] }) | null
  task: (Record<string, unknown> & { id: string; status?: string }) | null
}

export type RequestStatus = 'new' | 'in_progress' | 'waiting_customer' | 'completed' | 'cancelled'

export type ServiceRequestListItem = {
  id: string
  title?: string | null
  status: RequestStatus
  revision: number
  urgency?: 'normal' | 'urgent'
  serviceType?: string | null
  description?: string | null
  requestedTiming?: string | null
  missingInformation?: string[]
  createdAt?: string | null
  updatedAt?: string | null
  statusChangedAt?: string | null
  contact: {
    id: string
    displayName: string | null
    phone: string | null
    email: string | null
  }
}

export type ServiceRequestListResponse = {
  items: ServiceRequestListItem[]
  counts: Record<RequestStatus, number>
}

export type ContactListItem = {
  id: string
  displayName?: string | null
  phoneE164?: string | null
  phoneRaw?: string | null
  email?: string | null
  updatedAt?: string | null
}

export type ContactDetails = {
  contact: ContactListItem
  requests: ServiceRequestListItem[]
  interactions: Array<Record<string, unknown> & {
    id: string
    summary?: string | null
    transcript?: string | null
    occurredAt?: string | null
    createdAt?: string | null
    durationSeconds?: number | null
  }>
}

export type AssistantCitation = {
  citationId: string
  kind: 'call' | 'interaction' | 'contact' | 'service_request' | 'task' | 'review' | 'audit_event' | 'context_item'
  recordId: string
  sourcePath: string
  title: string
  excerpt: string
  occurredAt: string | null
  adapterId?: string
  externalUrl?: string
  internalRoute?: string
  metadata?: Record<string, unknown>
  artifactRefs?: string[]
}

export type AssistantAnswer = {
  answer: string
  citations: AssistantCitation[]
  confidence: 'high' | 'medium' | 'low'
  limitations: string[]
  runId: string
  messageId: string
  usage: {
    promptTokens: number
    outputTokens: number
    thinkingTokens: number
    totalTokens: number
  }
}

export type AssistantMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  citations?: AssistantCitation[]
  confidence?: 'high' | 'medium' | 'low'
  limitations?: string[]
  createdAt?: string | null
}

export type AdapterId = 'odorik' | 'google_calendar' | 'google_drive' | 'gmail' | 'github'

export type SourceAdapter = {
  id: AdapterId
  name: string
  description: string
  resourceNoun: string
  available: boolean
  availability: 'available' | 'needs_configuration' | 'planned'
  readOnly: boolean
}

export type SourceResource = {
  id: string
  connectionId: string
  resourceType: 'phone_line' | 'calendar' | 'folder' | 'label' | 'repository'
  externalId: string
  displayName: string
  status: 'enabled' | 'disabled'
  itemCount: number
  lastObservedAt?: string | null
}

export type SourceConnection = {
  id: string
  companyId: string
  adapterId: AdapterId
  displayName: string
  status: 'configuring' | 'active' | 'attention' | 'disconnected'
  authKind: 'basic_upload' | 'oauth2' | 'github_app'
  credentialMode: 'encrypted' | 'legacy_secret' | 'none'
  uploadUrl?: string
  accountLabel?: string
  lastSyncAt?: string | null
  lastObservedAt?: string | null
  lastError?: string | null
  itemCount: number
  resourceCount: number
  resources: SourceResource[]
}

export type SourcesResponse = {
  companyId: string
  adapters: SourceAdapter[]
  connections: SourceConnection[]
}

export type SelectableCalendar = {
  id: string
  displayName: string
  description: string | null
  primary: boolean
  accessRole: string
  timeZone: string | null
  selected: boolean
}

export async function registerAccess(): Promise<AccessStatus> {
  return trpc.auth.register.mutate() as Promise<AccessStatus>
}

export async function getAccessStatus(): Promise<AccessStatus> {
  return trpc.auth.status.query() as Promise<AccessStatus>
}

export async function listIntakes(): Promise<IntakeListItem[]> {
  return trpc.intake.list.query({ limit: 30 }) as Promise<IntakeListItem[]>
}

export async function getIntake(requestId: string): Promise<IntakeDetails> {
  return trpc.intake.get.query({ requestId }) as Promise<IntakeDetails>
}

export async function listServiceRequests(): Promise<ServiceRequestListResponse> {
  return trpc.serviceRequests.list.query({
    statuses: ['new', 'in_progress', 'waiting_customer', 'completed', 'cancelled'],
    limit: 100,
  }) as Promise<ServiceRequestListResponse>
}

export async function getServiceRequest(requestId: string): Promise<IntakeDetails> {
  return trpc.serviceRequests.get.query({ requestId }) as Promise<IntakeDetails>
}

export async function transitionServiceRequest(input: {
  requestId: string
  expectedRevision: number
  to: RequestStatus
  note?: string
}) {
  return trpc.serviceRequests.transition.mutate(input)
}

export async function listContacts(): Promise<ContactListItem[]> {
  return trpc.contacts.list.query({ limit: 50 }) as Promise<ContactListItem[]>
}

export async function getContact(contactId: string): Promise<ContactDetails> {
  return trpc.contacts.get.query({ contactId }) as Promise<ContactDetails>
}

export async function getAssistantStatus() {
  return trpc.assistant.status.query()
}

export async function getAssistantHistory(threadId = 'general'): Promise<AssistantMessage[]> {
  return trpc.assistant.history.query({ threadId }) as Promise<AssistantMessage[]>
}

export async function askAssistant(question: string, threadId = 'general'): Promise<AssistantAnswer> {
  return trpc.assistant.ask.mutate({ threadId, question }) as Promise<AssistantAnswer>
}

export async function listSources(): Promise<SourcesResponse> {
  return trpc.sources.list.query() as Promise<SourcesResponse>
}

export async function addOdorikConnection(input: {
  displayName: string
  accountLabel?: string
  username: string
  password: string
  numbers: string[]
}) {
  return trpc.sources.addOdorik.mutate(input)
}

export async function setSourceConnectionStatus(
  connectionId: string,
  status: 'active' | 'disconnected',
) {
  return trpc.sources.setConnectionStatus.mutate({ connectionId, status })
}

export async function deleteSourceConnection(connectionId: string) {
  return trpc.sources.deleteConnection.mutate({ connectionId })
}

export async function setSourceResourceEnabled(
  connectionId: string,
  resourceId: string,
  enabled: boolean,
) {
  return trpc.sources.setResourceEnabled.mutate({ connectionId, resourceId, enabled })
}

export type SelectableFolder = {
  id: string
  parentId: string | null
  displayName: string
  description: string | null
  shared: boolean
  selected: boolean
}

export async function startGoogleCalendarAuthorization() {
  return trpc.sources.googleCalendar.authorizationUrl.mutate({
    returnOrigin: window.location.origin,
  })
}

export async function getGoogleCalendars(connectionId: string): Promise<SelectableCalendar[]> {
  return trpc.sources.googleCalendar.calendars.query({ connectionId }) as Promise<SelectableCalendar[]>
}

export async function selectGoogleCalendars(connectionId: string, calendarIds: string[]) {
  return trpc.sources.googleCalendar.select.mutate({ connectionId, calendarIds })
}

export async function syncGoogleCalendars(connectionId: string) {
  return trpc.sources.googleCalendar.sync.mutate({ connectionId })
}

export async function startGoogleDriveAuthorization() {
  return trpc.sources.googleDrive.authorizationUrl.mutate({
    returnOrigin: window.location.origin,
  })
}

export async function getGoogleDriveFolders(connectionId: string): Promise<SelectableFolder[]> {
  return trpc.sources.googleDrive.folders.query({ connectionId }) as Promise<SelectableFolder[]>
}

export async function selectGoogleDriveFolders(connectionId: string, folderIds: string[]) {
  return trpc.sources.googleDrive.select.mutate({ connectionId, folderIds })
}

export async function syncGoogleDrive(connectionId: string) {
  return trpc.sources.googleDrive.sync.mutate({ connectionId })
}
