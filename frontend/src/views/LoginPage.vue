<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'

const authStore = useAuthStore()
const router = useRouter()
const busy = ref(false)
const error = ref('')

async function signIn() {
  busy.value = true
  error.value = ''
  try {
    await authStore.signIn()
    await router.push(authStore.isEnabled ? '/' : '/pending')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="app-gradient min-h-screen flex items-center justify-center p-5">
    <div class="w-full max-w-5xl grid lg:grid-cols-[1.2fr_.8fr] gap-10 items-center">
      <section class="hidden lg:block">
        <div class="inline-flex items-center gap-2 rounded-full bg-emerald-100 text-emerald-900 px-4 py-2 text-sm font-semibold mb-7">
          <i class="pi pi-phone" /> Odorik → Gemini → Firestore
        </div>
        <h1 class="text-6xl font-bold tracking-tight leading-[1.02] text-surface-900 max-w-2xl">
          {{ $t('login.title') }}
        </h1>
        <p class="text-xl text-surface-500 mt-6 max-w-xl leading-relaxed">
          Evidence-backed customer intake, reviewed by a person before it becomes company truth.
        </p>
      </section>

      <Card class="shadow-xl border border-surface-200 rounded-3xl overflow-hidden">
        <template #content>
          <div class="p-4 sm:p-7">
            <div class="w-14 h-14 rounded-2xl bg-emerald-800 text-white flex items-center justify-center mb-7">
              <i class="pi pi-comments text-2xl" />
            </div>
            <h2 class="text-3xl font-semibold mb-3">{{ $t('app.name') }}</h2>
            <p class="text-surface-500 mb-8 leading-relaxed">{{ $t('login.subtitle') }}</p>
            <Button
              :label="$t('login.google')"
              icon="pi pi-google"
              size="large"
              fluid
              :loading="busy"
              @click="signIn"
            />
            <Message v-if="error" severity="error" :closable="false" class="mt-4">{{ error }}</Message>
            <p class="text-xs text-surface-400 mt-6">
              New accounts are disabled by default. Authentication does not grant CRM access.
            </p>
          </div>
        </template>
      </Card>
    </div>
  </main>
</template>
