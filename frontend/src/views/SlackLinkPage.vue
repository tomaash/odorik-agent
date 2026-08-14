<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Card from 'primevue/card'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import {
  inspectSlackIdentityLink,
  linkSlackIdentity,
  type SlackLinkPreview,
} from '../api/client'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()
const preview = ref<SlackLinkPreview | null>(null)
const loading = ref(true)
const linking = ref(false)
const linked = ref(false)
const error = ref('')

function token() {
  return sessionStorage.getItem('pendingSlackLinkToken') || ''
}

async function load() {
  if (!token()) {
    error.value = 'The Slack account-link link is missing.'
    loading.value = false
    return
  }
  try {
    preview.value = await inspectSlackIdentityLink(token())
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function link() {
  linking.value = true
  error.value = ''
  try {
    await linkSlackIdentity(token())
    sessionStorage.removeItem('pendingSlackLinkToken')
    linked.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    linking.value = false
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
          <template v-else-if="linked">
            <div class="w-16 h-16 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center mb-6">
              <i class="pi pi-check text-2xl" />
            </div>
            <h1 class="text-3xl font-semibold mb-3">Slack is linked</h1>
            <p class="text-surface-500 leading-relaxed mb-6">
              Return to Slack and send Agent Erik another direct message.
            </p>
            <Button label="Open Agent Erik" icon="pi pi-arrow-right" @click="router.replace('/ask')" />
          </template>
          <template v-else-if="preview">
            <div class="w-16 h-16 rounded-2xl bg-violet-100 text-violet-800 flex items-center justify-center mb-6">
              <i class="pi pi-comments text-2xl" />
            </div>
            <p class="text-sm font-semibold uppercase tracking-wide text-violet-700 mb-2">Slack direct messages</p>
            <h1 class="text-3xl font-semibold mb-3">Link Slack to Agent Erik</h1>
            <p class="text-surface-500 leading-relaxed mb-6">
              This lets the Slack account that received the link ask the same read-only company assistant available in Agent Erik.
            </p>
            <div class="rounded-2xl bg-surface-100 p-4 mb-6">
              <div class="text-sm text-surface-500">Agent Erik account</div>
              <div class="font-semibold break-all mt-1">{{ auth.user?.email }}</div>
            </div>
            <Message severity="info" :closable="false" class="mb-4">
              Answers respect this member’s source access. Ordinary replies cannot approve actions;
              structured approval cards can authorize one exact disclosed proposal.
            </Message>
            <Message v-if="error" severity="error" :closable="false" class="mb-4">{{ error }}</Message>
            <div class="grid sm:flex gap-3">
              <Button label="Link account" icon="pi pi-link" :loading="linking" @click="link" />
              <Button label="Use another account" icon="pi pi-google" severity="secondary" outlined @click="switchAccount" />
            </div>
          </template>
          <template v-else>
            <div class="w-16 h-16 rounded-2xl bg-red-100 text-red-700 flex items-center justify-center mb-6">
              <i class="pi pi-times text-2xl" />
            </div>
            <h1 class="text-3xl font-semibold mb-3">Link unavailable</h1>
            <p class="text-surface-500 leading-relaxed mb-6">{{ error || 'Request a new link by messaging Agent Erik in Slack.' }}</p>
            <Button label="Go to Agent Erik" severity="secondary" outlined @click="router.replace('/')" />
          </template>
        </div>
      </template>
    </Card>
  </main>
</template>
