import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getContact, listContacts, type ContactDetails, type ContactListItem } from '../api/client'

export const useContactsStore = defineStore('contacts', () => {
  const items = ref<ContactListItem[]>([])
  const current = ref<ContactDetails | null>(null)
  const loading = ref(false)
  const error = ref('')

  async function loadList() {
    loading.value = true
    error.value = ''
    try {
      items.value = await listContacts()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function load(contactId: string) {
    loading.value = true
    error.value = ''
    current.value = null
    try {
      current.value = await getContact(contactId)
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
