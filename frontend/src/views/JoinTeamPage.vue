<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import { acceptInvitation, inspectInvitation, type InvitationPreview } from '../api/client'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()
const invitation = ref<InvitationPreview | null>(null)
const loading = ref(true)
const accepting = ref(false)
const error = ref('')

function token() {
  return sessionStorage.getItem('pendingInvitationToken') || ''
}

async function load() {
  const invitationToken = token()
  if (!invitationToken) {
    error.value = 'INVALID_INVITATION'
    loading.value = false
    return
  }
  try {
    invitation.value = await inspectInvitation(invitationToken)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function accept() {
  accepting.value = true
  error.value = ''
  try {
    await acceptInvitation(token())
    sessionStorage.removeItem('pendingInvitationToken')
    await auth.refreshAccess()
    await router.replace('/')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    accepting.value = false
  }
}

async function switchAccount() {
  await auth.signOut()
  await router.replace('/login')
}

onMounted(load)
</script>

<template>
  <main class="app-gradient min-h-screen min-w-0 overflow-x-hidden flex items-center justify-center p-4 sm:p-5">
    <Card class="min-w-0 w-full max-w-xl overflow-hidden shadow-lg rounded-3xl [&_.p-card-body]:p-0">
      <template #content>
        <div class="p-5 sm:p-9">
          <div v-if="loading" class="flex min-h-52 items-center justify-center">
            <ProgressSpinner class="w-10 h-10" />
          </div>
          <template v-else-if="invitation">
            <div class="w-16 h-16 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center mb-6">
              <i class="pi pi-users text-2xl" />
            </div>
            <p class="text-sm font-semibold uppercase tracking-wide text-emerald-700 mb-2">
              {{ $t('join.eyebrow') }}
            </p>
            <h1 class="text-3xl font-semibold text-surface-900 mb-3">
              {{ $t('join.title', { team: invitation.teamName }) }}
            </h1>
            <p class="text-surface-500 leading-relaxed mb-6">
              {{ $t('join.description', { inviter: invitation.invitedByName || $t('join.teammate') }) }}
            </p>
            <div class="rounded-2xl bg-surface-100 p-4 mb-6">
              <div class="text-sm text-surface-500">{{ $t('join.account') }}</div>
              <div class="font-semibold break-all mt-1">{{ auth.user?.email }}</div>
            </div>
            <Message v-if="error" severity="error" :closable="false" class="mb-4">
              {{ $t('join.failed') }}
            </Message>
            <div class="grid sm:flex gap-3">
              <Button
                :label="$t('join.accept')"
                icon="pi pi-check"
                :loading="accepting"
                class="w-full sm:w-auto"
                @click="accept"
              />
              <Button
                :label="$t('join.switchAccount')"
                icon="pi pi-google"
                severity="secondary"
                outlined
                class="w-full sm:w-auto"
                @click="switchAccount"
              />
            </div>
          </template>
          <template v-else>
            <div class="w-16 h-16 rounded-2xl bg-red-100 text-red-700 flex items-center justify-center mb-6">
              <i class="pi pi-times text-2xl" />
            </div>
            <h1 class="text-3xl font-semibold mb-3">{{ $t('join.invalidTitle') }}</h1>
            <p class="text-surface-500 leading-relaxed mb-6">{{ $t('join.invalidDescription') }}</p>
            <Button :label="$t('join.switchAccount')" severity="secondary" outlined @click="switchAccount" />
          </template>
        </div>
      </template>
    </Card>
  </main>
</template>
