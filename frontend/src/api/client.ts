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
