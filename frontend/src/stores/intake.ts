import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getIntake, listIntakes, type IntakeDetails, type IntakeListItem } from '../api/client'

export const useIntakeStore = defineStore('intake', () => {
  const items = ref<IntakeListItem[]>([])
  const current = ref<IntakeDetails | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function loadList() {
    loading.value = true
    error.value = ''
    try {
      items.value = await listIntakes()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function load(requestId: string) {
    loading.value = true
    error.value = ''
    try {
      current.value = await getIntake(requestId)
      return current.value
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  return { items, current, loading, error, loadList, load }
})
