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
