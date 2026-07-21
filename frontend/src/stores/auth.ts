import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth } from '../firebase'
import { getAccessStatus, registerAccess, type AccessStatus } from '../api/client'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const access = ref<AccessStatus | null>(null)
  const isReady = ref(false)
  const error = ref('')
  let initialization: Promise<void> | null = null

  const isAuthenticated = computed(() => user.value !== null)
  const isEnabled = computed(() => access.value?.enabled === true)

  function initialize() {
    if (initialization) return initialization
    initialization = new Promise<void>((resolve) => {
      onAuthStateChanged(auth, async (currentUser) => {
        user.value = currentUser
        access.value = null
        error.value = ''
        if (currentUser) {
          try {
            access.value = await registerAccess()
          } catch (cause) {
            error.value = cause instanceof Error ? cause.message : String(cause)
          }
        }
        isReady.value = true
        resolve()
      })
    })
    return initialization
  }

  async function signIn() {
    error.value = ''
    const provider = new GoogleAuthProvider()
    provider.setCustomParameters({ prompt: 'select_account' })
    await signInWithRedirect(auth, provider)
  }

  async function refreshAccess() {
    if (!user.value) return null
    access.value = await getAccessStatus()
    return access.value
  }

  async function signOut() {
    await firebaseSignOut(auth)
    user.value = null
    access.value = null
  }

  return {
    user,
    access,
    error,
    isReady,
    isAuthenticated,
    isEnabled,
    initialize,
    signIn,
    refreshAccess,
    signOut,
  }
})
