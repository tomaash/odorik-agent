<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import { takeAppReturnPath } from '../pending-return'

const authStore = useAuthStore()
const router = useRouter()
const busy = ref(false)
const error = ref('')

async function signIn() {
  busy.value = true
  error.value = ''
  try {
    await authStore.signIn()
    const pendingReturn = takeAppReturnPath()
    await router.push(
      sessionStorage.getItem('pendingInvitationToken')
        ? '/join'
        : sessionStorage.getItem('pendingSlackLinkToken')
          ? '/slack/link'
        : sessionStorage.getItem('pendingMicrosoftTeamsLinkToken')
          ? '/teams/link'
        : pendingReturn
          ? pendingReturn
        : authStore.isEnabled
          ? '/'
          : '/pending',
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="app-gradient min-h-screen min-w-0 overflow-x-hidden flex items-center justify-center p-4 sm:p-5">
    <div class="min-w-0 w-full max-w-5xl grid lg:grid-cols-[1.2fr_.8fr] gap-8 lg:gap-10 items-center">
      <section class="hidden lg:block">
        <div class="eyebrow mb-7">
          {{ $t('login.flow') }}
        </div>
        <h1 class="text-6xl font-bold tracking-tight leading-[1.02] text-surface-900 max-w-2xl">
          {{ $t('login.title') }}
        </h1>
        <p class="text-xl text-surface-500 mt-6 max-w-xl leading-relaxed">
          {{ $t('login.hero') }}
        </p>
      </section>

      <Card class="min-w-0 border border-surface-200 rounded-lg overflow-hidden [&_.p-card-body]:p-0">
        <template #content>
          <div class="p-4 sm:p-7">
            <div class="w-11 h-11 rounded-md bg-surface-950 text-white flex items-center justify-center mb-7 font-semibold">
              E
            </div>
            <h2 class="text-2xl sm:text-3xl font-semibold mb-3 break-words">{{ $t('app.name') }}</h2>
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
              {{ $t('login.accessNote') }}
            </p>
          </div>
        </template>
      </Card>
    </div>
  </main>
</template>
