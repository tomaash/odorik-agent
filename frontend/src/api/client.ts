import { createTRPCClient, httpBatchLink, httpLink } from '@trpc/client'
import type { AppRouter } from '@agent-erik/functions/router'
import type {
  ActionPreview,
  ActionSkip,
  ValidationResult,
  WorkflowSpec,
} from '@agent-erik/workflow'
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

// Keep team management on a single-request link. Its response is small and
// this avoids an empty-input batching edge case seen on direct route loads.
const teamTrpc = createTRPCClient<AppRouter>({
  links: [
    httpLink({
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
  companyId: string | null
  teamName: string | null
  role: 'admin' | 'member' | null
}

export type TeamMember = {
  uid: string
  email: string
  displayName: string
  photoURL: string
  role: 'admin' | 'member'
  joinedAt: string | null
}

export type TeamInvitation = {
  id: string
  email: string
  status: 'pending'
  invitedByName: string
  createdAt: string | null
  expiresAt: string | null
  deliveryStatus: 'pending' | 'sent' | 'failed'
  deliveryError: string | null
}

export type TeamOverview = {
  team: {
    id: string
    displayName: string
    createdAt: string | null
  }
  members: TeamMember[]
  invitations: TeamInvitation[]
}

export type InvitationPreview = {
  teamId: string
  teamName: string
  invitedByName: string
  expiresAt: string | null
  email: string
}

export type ContactListItem = {
  id: string
  displayName?: string | null
  phoneE164?: string | null
  phoneRaw?: string | null
  email?: string | null
  updatedAt?: string | null
}

export type ContactCall = {
  id: string
  from?: string | null
  to?: string | null
  status?: string | null
  summary?: string | null
  transcript?: string | null
  language?: string | null
  durationSeconds?: number | null
  duration?: number | null
  odorikTime?: string | null
  uploadedAt?: string | null
}

export type ContactDetails = {
  contact: ContactListItem
  calls: ContactCall[]
  cases: CaseItem[]
  tasks: TaskItem[]
}

export type TaskStatus = 'open' | 'completed' | 'dismissed'

export type TaskItem = {
  id: string
  objectType?: 'task'
  status: TaskStatus
  title: string
  instructions?: string | null
  assigneeUid: string
  assigneeName: string
  dueAt?: string | null
  contactId?: string | null
  caseId?: string | null
  callId?: string | null
  context?: {
    contactName?: string | null
    contactPhone?: string | null
    callerName?: string | null
    callerPhone?: string | null
    callSummary?: string | null
    transcriptExcerpt?: string | null
  } | null
  source?: {
    kind?: 'manual' | 'call' | 'case' | 'workflow'
    workflowId?: string
    workflowVersion?: number
    approvalId?: string
    approvedBy?: string
  } | null
  outcomeNote?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  dismissedAt?: string | null
}

export type PipelineStage = {
  id: string
  name: string
  position: number
  color: string
  terminal: boolean
  archived: boolean
}

export type Pipeline = {
  id: string
  name: string
  schemaVersion: 2
  revision: number
  initialStageId: string
  stages: PipelineStage[]
}

export type CaseItem = {
  id: string
  objectType: 'case'
  title: string
  pipelineId: string
  stageId: string
  contactId: string
  contactName: string
  contactPhone?: string | null
  ownerUid: string
  ownerName: string
  revision: number
  callId?: string | null
  source?: {
    kind?: 'manual' | 'call' | 'workflow'
    callId?: string
    workflowId?: string
    workflowVersion?: number
    runId?: string
    blockId?: string
    approvalId?: string
    approvedBy?: string
  } | null
  authorization?: {
    kind?: 'direct_user_action' | 'approval'
    approvalId?: string
    approvedBy?: string
    approvedAt?: string | null
  } | null
  archived?: boolean
  archivedAt?: string | null
  closedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  stageChangedAt?: string | null
}

export type CaseActivity = {
  id: string
  aggregateType: 'case' | 'task' | 'action_approval' | string
  aggregateId: string
  caseId?: string
  type: string
  actor?: {
    kind?: 'user' | 'system'
    id?: string
  } | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  createdAt?: string | null
}

export type CaseDetails = {
  case: CaseItem
  pipeline: Pipeline
  contact: ContactListItem & { missing?: boolean }
  tasks: TaskItem[]
  approvals: ActionApprovalItem[]
  calls: ContactCall[]
  activity: CaseActivity[]
}

export type AssistantCitation = {
  citationId: string
  kind: 'call' | 'interaction' | 'contact' | 'case' | 'task' | 'review' | 'audit_event' | 'context_item'
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

export type WorkflowListItem = {
  id: string
  name: string
  status: 'draft' | 'enabled' | 'paused' | 'legacy'
  deployedVersion: number | null
  versionCount: number
  draft: WorkflowSpec | null
  legacy?: boolean
  warning?: string
  updatedAt: string | null
  recentRuns: Record<string, number>
  recentExceptions?: Array<{
    runId: string
    callId: string
    occurredAt?: string | null
    blockId: string
    actionKind: string
    reason: string
    matches: number
  }>
}

export type WorkflowDetails = WorkflowListItem & {
  draftValidation?: ValidationResult
}

export type DryRunResult = {
  workflowId: string
  sampleSize: number
  wouldRequest: number
  matchedCalls: number
  skipped: number
  failed: number
  results: Array<{
    callId: string
    occurredAt?: string | null
    status: 'would_request' | 'would_skip' | 'failed'
    actions?: ActionPreview[]
    skippedActions?: ActionSkip[]
    conditions?: Array<{
      blockId: string
      field: 'call.durationSeconds' | 'caller.hasContact' | 'transcript.text'
      operator: 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'
      expected: string | number | boolean
      actual: string | number | boolean | null
      result: boolean
      branch: 'then' | 'else'
    }>
    error?: string
  }>
}

export type ApprovalStatus =
  | 'pending'
  | 'executing'
  | 'approved'
  | 'rejected'
  | 'execution_failed'

export type ActionApprovalItem = {
  id: string
  objectType: 'action_approval'
  status: ApprovalStatus
  approverUid: string
  approverName: string
  decisionStatus?: 'pending' | 'approved' | 'rejected'
  executionStatus?: 'not_started' | 'executing' | 'succeeded' | 'failed_safe_to_retry' | 'outcome_unknown'
  scope?: {
    contactId?: string | null
    callId?: string | null
    caseId?: string | null
  } | null
  result?: {
    kind: 'task' | 'case' | 'case_movement'
    id: string
  } | null
  action: ({
    kind: 'task.create'
    taskId: string
    title: string
    instructions?: string | null
    assigneeUid: string
    assigneeName: string
    dueAt?: string | null
    contactId?: string | null
    caseId?: string | null
    caseTitle?: string | null
    callId?: string | null
    subject?: {
      kind: 'internal' | 'contact' | 'matching_case'
      pipelineId?: string
      stageId?: string
      stageName?: string
    } | null
  } | {
    kind: 'case.create'
    caseId: string
    title: string
    stageId: string
    stageName: string
    ownerUid: string
    ownerName: string
    contactId: string
    callId: string
  } | {
    kind: 'case.move'
    movementId: string
    caseId: string
    caseTitle: string
    fromStageId: string
    fromStageName: string
    toStageId: string
    toStageName: string
    expectedRevision: number
    contactId: string
    callId: string
  }) & {
    context?: {
      callerName?: string | null
      callerPhone?: string | null
      callSummary?: string | null
      transcriptExcerpt?: string | null
    } | null
  }
  source: {
    kind: 'workflow'
    callId: string
    workflowId: string
    workflowVersion: number
    runId: string
    blockId: string
  }
  actionCapabilityId?: string
  actionContractVersion?: number
  effectDigest: string
  resultId?: string | null
  executionResult?: unknown
  executionError?: string | null
  rejectionNote?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  approvedAt?: string | null
  rejectedAt?: string | null
  executedAt?: string | null
}

export type ConnectorId = 'odorik' | 'google_workspace' | 'github'
export type SourceCapabilityId =
  | 'context.call.read'
  | 'context.calendar.read'
  | 'context.document.read'
  | 'context.github.issue.read'

export type SourceCapabilityDescriptor = {
  id: SourceCapabilityId
  serviceId: 'calls' | 'calendar' | 'drive' | 'issues'
  direction: 'observe'
  resourceType: 'phone_line' | 'calendar' | 'folder' | 'repository'
  requiredScopes: string[]
  syncMode: 'webhook' | 'incremental' | 'manual'
  requiresApproval: false
}

export type SourceConnector = {
  id: ConnectorId
  name: string
  description: string
  availability: 'available' | 'needs_configuration'
  capabilities: SourceCapabilityDescriptor[]
}

export type SourceCapability = {
  id: 'calls' | 'calendar' | 'drive' | 'issues'
  capabilityId: SourceCapabilityId
  status: 'active' | 'attention' | 'reauthorization_required' | 'disabled'
  grantedScopes: string[]
  requiredScopes: string[]
  itemCount: number
  resourceCount: number
  lastSyncAt?: string | null
  lastObservedAt?: string | null
  lastError?: string | null
}

export type SourceResource = {
  id: string
  connectionId: string
  capabilityId: SourceCapabilityId
  resourceType: 'phone_line' | 'calendar' | 'folder' | 'repository'
  externalId: string
  displayName: string
  status: 'enabled' | 'disabled'
  itemCount: number
  lastObservedAt?: string | null
}

export type SourceConnection = {
  id: string
  companyId: string
  connectorId: ConnectorId
  providerId: 'odorik' | 'google' | 'github'
  providerAccountId?: string
  tenantId?: string
  displayName: string
  status: 'configuring' | 'active' | 'attention' | 'disconnected'
  authKind: 'basic_upload' | 'oauth2' | 'github_app'
  credentialMode: 'encrypted' | 'legacy_secret' | 'shared_secret' | 'none'
  uploadUrl?: string
  accountLabel?: string
  grantedScopes: string[]
  lastSyncAt?: string | null
  lastObservedAt?: string | null
  lastError?: string | null
  reauthorizationRequired?: boolean
  itemCount: number
  resourceCount: number
  webhook?: {
    status: 'pending' | 'active' | 'attention'
    lastDeliveryAt?: string | null
    lastEvent?: string | null
    lastAction?: string | null
    lastOutcome?: string | null
    lastError?: string | null
  }
  capabilities: SourceCapability[]
  resources: SourceResource[]
}

export type SourcesResponse = {
  companyId: string
  connectors: SourceConnector[]
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

export async function inspectInvitation(token: string): Promise<InvitationPreview> {
  return trpc.invitations.inspect.query({ token }) as Promise<InvitationPreview>
}

export async function acceptInvitation(token: string): Promise<AccessStatus> {
  return trpc.invitations.accept.mutate({ token }) as Promise<AccessStatus>
}

export async function getTeamOverview(): Promise<TeamOverview> {
  const token = await auth.currentUser?.getIdToken()
  const baseUrl = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/team.overview`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const payload = await response.json() as {
    result?: { data?: unknown }
    error?: { json?: { message?: string }; message?: string }
  }
  const rawData = payload.result?.data
  if (!response.ok || !rawData) {
    throw new Error(
      payload.error?.json?.message
      || payload.error?.message
      || `Team request failed (${response.status})`,
    )
  }
  return rawData as TeamOverview
}

export async function inviteTeamMember(email: string): Promise<TeamInvitation> {
  return teamTrpc.team.invite.mutate({ email }) as Promise<TeamInvitation>
}

export async function resendTeamMemberInvitation(invitationId: string): Promise<TeamInvitation> {
  return teamTrpc.team.resendInvitation.mutate({ invitationId }) as Promise<TeamInvitation>
}

export async function revokeTeamMemberInvitation(invitationId: string) {
  return teamTrpc.team.revokeInvitation.mutate({ invitationId })
}

export async function removeTeamMember(uid: string) {
  return teamTrpc.team.removeMember.mutate({ uid })
}

export async function listContacts(): Promise<ContactListItem[]> {
  return trpc.contacts.list.query({ limit: 50 }) as Promise<ContactListItem[]>
}

export async function getContact(contactId: string): Promise<ContactDetails> {
  return trpc.contacts.get.query({ contactId }) as Promise<ContactDetails>
}

export async function listTasks(input?: {
  status?: TaskStatus
  statuses?: TaskStatus[]
  assigneeUid?: string
  contactId?: string
  caseId?: string
}): Promise<TaskItem[]> {
  return trpc.tasks.list.query({ ...(input || {}), limit: 200 }) as Promise<TaskItem[]>
}

export async function createTask(input: {
  title: string
  instructions?: string
  assigneeUid: string
  dueAt?: string | null
  contactId?: string | null
  caseId?: string | null
  callId?: string | null
}): Promise<TaskItem> {
  return trpc.tasks.create.mutate(input) as Promise<TaskItem>
}

export async function updateTask(input: {
  taskId: string
  title?: string
  instructions?: string
  assigneeUid?: string
  dueAt?: string | null
}): Promise<TaskItem> {
  return trpc.tasks.update.mutate(input) as Promise<TaskItem>
}

export async function transitionTask(input: {
  taskId: string
  to: TaskStatus
  note?: string
}) {
  return trpc.tasks.transition.mutate(input)
}

export async function listActionApprovals(input?: {
  status?: ApprovalStatus
  statuses?: ApprovalStatus[]
  approverUid?: string
}): Promise<ActionApprovalItem[]> {
  return trpc.approvals.list.query({ ...(input || {}), limit: 200 }) as Promise<ActionApprovalItem[]>
}

export async function approveAction(approvalId: string) {
  return trpc.approvals.approve.mutate({ approvalId })
}

export async function rejectAction(approvalId: string, note?: string) {
  return trpc.approvals.reject.mutate({
    approvalId,
    ...(note?.trim() ? { note: note.trim() } : {}),
  })
}

export async function getPipeline(): Promise<Pipeline> {
  return trpc.pipeline.get.query() as Promise<Pipeline>
}

export async function updatePipeline(input: {
  expectedRevision: number
  name: string
  initialStageId: string
  stages: PipelineStage[]
}): Promise<Pipeline> {
  return trpc.pipeline.update.mutate(input) as Promise<Pipeline>
}

export async function listCases(contactId?: string): Promise<CaseItem[]> {
  return trpc.cases.list.query({ ...(contactId ? { contactId } : {}), limit: 200 }) as Promise<CaseItem[]>
}

export async function getCaseDetails(caseId: string): Promise<CaseDetails> {
  return trpc.cases.get.query({ caseId }) as Promise<CaseDetails>
}

export async function createCase(input: {
  title: string
  contactId: string
  ownerUid: string
  stageId?: string
}): Promise<CaseItem> {
  return trpc.cases.create.mutate(input) as Promise<CaseItem>
}

export async function moveCase(input: {
  caseId: string
  stageId: string
  expectedRevision: number
  expectedStageId: string
}) {
  return trpc.cases.move.mutate(input)
}

export async function archiveCase(caseId: string) {
  return trpc.cases.archive.mutate({ caseId })
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

export async function listWorkflows(): Promise<WorkflowListItem[]> {
  return trpc.workflows.list.query() as Promise<WorkflowListItem[]>
}

export async function getWorkflow(workflowId: string): Promise<WorkflowDetails> {
  return trpc.workflows.get.query({ workflowId }) as Promise<WorkflowDetails>
}

export async function createWorkflow(name?: string): Promise<{
  id: string
  spec: WorkflowSpec
  status: 'draft'
  deployedVersion: null
}> {
  return trpc.workflows.create.mutate(name ? { name } : undefined) as Promise<{
    id: string
    spec: WorkflowSpec
    status: 'draft'
    deployedVersion: null
  }>
}

export async function saveWorkflow(workflowId: string, spec: WorkflowSpec) {
  return trpc.workflows.save.mutate({ workflowId, spec })
}

export async function enableWorkflow(workflowId: string) {
  return trpc.workflows.enable.mutate({ workflowId })
}

export async function pauseWorkflow(workflowId: string) {
  return trpc.workflows.pause.mutate({ workflowId })
}

export async function dryRunWorkflow(
  workflowId: string,
  spec: WorkflowSpec,
  limit = 20,
): Promise<DryRunResult> {
  return trpc.workflows.dryRun.mutate({ workflowId, spec, limit }) as Promise<DryRunResult>
}

export async function getWorkflowHealth() {
  return trpc.workflows.health.query()
}

export async function listSources(): Promise<SourcesResponse> {
  return trpc.sources.list.query() as Promise<SourcesResponse>
}

export async function addOdorikConnection() {
  return trpc.sources.addOdorik.mutate()
}

export async function getOdorikSetup(connectionId: string): Promise<{ setupUrl: string }> {
  return trpc.sources.getOdorikSetup.mutate({ connectionId }) as Promise<{ setupUrl: string }>
}

export async function setSourceConnectionStatus(
  connectionId: string,
  status: 'active' | 'disconnected',
) {
  return trpc.sources.setConnectionStatus.mutate({ connectionId, status })
}

export async function setSourceCapabilityStatus(
  connectionId: string,
  capabilityId: 'context.calendar.read' | 'context.document.read',
  enabled: boolean,
) {
  return trpc.sources.setCapabilityStatus.mutate({
    connectionId,
    capabilityId,
    enabled,
  })
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

export async function startGoogleWorkspaceAuthorization(
  capabilityIds: Array<'context.calendar.read' | 'context.document.read'>,
  connectionId?: string,
) {
  return trpc.sources.googleWorkspace.authorizationUrl.mutate({
    capabilityIds,
    ...(connectionId ? { connectionId } : {}),
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

export async function getGoogleDriveFolders(connectionId: string): Promise<SelectableFolder[]> {
  return trpc.sources.googleDrive.folders.query({ connectionId }) as Promise<SelectableFolder[]>
}

export async function selectGoogleDriveFolders(connectionId: string, folderIds: string[]) {
  return trpc.sources.googleDrive.select.mutate({ connectionId, folderIds })
}

export async function syncGoogleDrive(connectionId: string) {
  return trpc.sources.googleDrive.sync.mutate({ connectionId })
}

export async function connectConfiguredGitHubInstallation() {
  return trpc.sources.github.connectConfiguredInstallation.mutate()
}

export async function syncGitHubIssues(connectionId: string) {
  return trpc.sources.github.sync.mutate({ connectionId })
}
