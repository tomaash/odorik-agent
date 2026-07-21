import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  getServiceRequest,
  listServiceRequests,
  transitionServiceRequest,
  type IntakeDetails,
  type RequestStatus,
  type ServiceRequestListItem,
} from '../api/client'

export const useRequestsStore = defineStore('requests', () => {
  const items = ref<ServiceRequestListItem[]>([])
  const counts = ref<Record<RequestStatus, number>>({
    new: 0,
    in_progress: 0,
    waiting_customer: 0,
    completed: 0,
    cancelled: 0,
  })
  const current = ref<IntakeDetails | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  const openCount = computed(() => counts.value.new + counts.value.in_progress + counts.value.waiting_customer)

  async function loadList() {
    loading.value = true
    error.value = ''
    try {
      const response = await listServiceRequests()
      items.value = response.items
      counts.value = response.counts
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function load(requestId: string) {
    loading.value = true
    error.value = ''
    current.value = null
    try {
      current.value = await getServiceRequest(requestId)
      return current.value
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function transition(to: RequestStatus, note?: string) {
    if (!current.value) return null
    saving.value = true
    error.value = ''
    try {
      const result = await transitionServiceRequest({
        requestId: current.value.request.id,
        expectedRevision: Number(current.value.request.revision || 0),
        to,
        note: note?.trim() || undefined,
      })
      current.value.request.status = result.status
      current.value.request.revision = result.revision
      const listed = items.value.find((item) => item.id === result.requestId)
      if (listed) {
        counts.value[listed.status] = Math.max(0, counts.value[listed.status] - 1)
        listed.status = result.status
        listed.revision = result.revision
        counts.value[result.status] += 1
      }
      return result
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      saving.value = false
    }
  }

  return { items, counts, current, loading, saving, error, openCount, loadList, load, transition }
})
