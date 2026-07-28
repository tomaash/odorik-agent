<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'

const authStore = useAuthStore()
const router = useRouter()
const checking = ref(false)
const info = ref('')

async function check() {
  checking.value = true
  info.value = ''
  try {
    const access = await authStore.refreshAccess()
    if (access?.enabled) await router.replace('/')
    else info.value = 'Access is still disabled.'
  } finally {
    checking.value = false
  }
}

async function signOut() {
  await authStore.signOut()
  await router.replace('/login')
}
</script>

<template>
  <main class="app-gradient min-h-screen min-w-0 overflow-x-hidden flex items-center justify-center p-4 sm:p-5">
    <Card class="min-w-0 w-full max-w-xl overflow-hidden border border-surface-200 rounded-lg [&_.p-card-body]:p-0">
      <template #content>
        <div class="p-5 sm:p-9 text-center">
          <div class="w-16 h-16 mx-auto rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-6">
            <i class="pi pi-users text-2xl" />
          </div>
          <h1 class="text-2xl sm:text-3xl font-semibold mb-3 break-words">{{ $t('pending.title') }}</h1>
          <p class="text-surface-500 leading-relaxed mb-6">{{ $t('pending.description') }}</p>
          <div class="min-w-0 rounded-xl bg-surface-100 p-4 mb-6 text-sm overflow-hidden">
            <strong>{{ authStore.user?.displayName }}</strong><br />
            <span class="text-surface-500 break-all">{{ authStore.user?.email }}</span>
          </div>
          <div class="grid sm:flex gap-3 sm:justify-center sm:flex-wrap">
            <Button :label="$t('pending.refresh')" icon="pi pi-refresh" class="w-full sm:w-auto" :loading="checking" @click="check" />
            <Button label="Odhlásit" icon="pi pi-sign-out" class="w-full sm:w-auto" severity="secondary" outlined @click="signOut" />
          </div>
          <Message v-if="info" severity="info" :closable="false" class="mt-5">{{ info }}</Message>
        </div>
      </template>
    </Card>
  </main>
</template>
