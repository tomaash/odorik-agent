import type { RequestStatus } from '../api/client'

export const requestStatuses: RequestStatus[] = [
  'new',
  'in_progress',
  'waiting_customer',
  'completed',
  'cancelled',
]

export const openRequestStatuses: RequestStatus[] = ['new', 'in_progress', 'waiting_customer']

export const requestTransitions: Record<RequestStatus, RequestStatus[]> = {
  new: ['in_progress', 'waiting_customer', 'cancelled'],
  in_progress: ['waiting_customer', 'completed', 'cancelled'],
  waiting_customer: ['in_progress', 'completed', 'cancelled'],
  completed: ['in_progress'],
  cancelled: ['new'],
}

export const statusSeverity: Record<RequestStatus, 'info' | 'warn' | 'success' | 'danger' | 'secondary'> = {
  new: 'info',
  in_progress: 'warn',
  waiting_customer: 'secondary',
  completed: 'success',
  cancelled: 'danger',
}

export const statusIcon: Record<RequestStatus, string> = {
  new: 'pi pi-sparkles',
  in_progress: 'pi pi-play-circle',
  waiting_customer: 'pi pi-clock',
  completed: 'pi pi-check-circle',
  cancelled: 'pi pi-times-circle',
}
