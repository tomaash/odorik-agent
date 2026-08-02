<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getTeamOverview,
  inviteTeamMember,
  removeTeamMember,
  resendTeamMemberInvitation,
  revokeTeamMemberInvitation,
  type TeamOverview,
} from '../api/client'
import { useAuthStore } from '../stores/auth'

const { t, locale } = useI18n()
const auth = useAuthStore()
const data = ref<TeamOverview>({
  team: {
    id: auth.access?.companyId || '',
    displayName: auth.access?.teamName || '',
    createdAt: null,
  },
  members: [],
  invitations: [],
})
const email = ref('')
const loading = ref(true)
const busy = ref('')
const error = ref('')
const notice = ref('')
const isAdmin = computed(() => auth.access?.role === 'admin')

function formatDate(value: string | null) {
  if (!value) return ''
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const overview = await getTeamOverview()
    if (overview) data.value = overview
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function invite() {
  const value = email.value.trim()
  if (!value) return
  busy.value = 'invite'
  error.value = ''
  notice.value = ''
  try {
    const invitation = await inviteTeamMember(value)
    email.value = ''
    notice.value = invitation.deliveryStatus === 'sent'
      ? t('team.invitationSent')
      : t('team.invitationCreatedButFailed')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = ''
  }
}

async function resend(invitationId: string) {
  busy.value = `resend:${invitationId}`
  error.value = ''
  notice.value = ''
  try {
    const invitation = await resendTeamMemberInvitation(invitationId)
    notice.value = invitation.deliveryStatus === 'sent'
      ? t('team.invitationSent')
      : t('team.invitationCreatedButFailed')
    if (invitation.deliveryStatus !== 'sent' && invitation.deliveryError) {
      error.value = String(invitation.deliveryError)
    }
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = ''
  }
}

async function revoke(invitationId: string) {
  busy.value = `revoke:${invitationId}`
  error.value = ''
  try {
    await revokeTeamMemberInvitation(invitationId)
    notice.value = t('team.invitationRevoked')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = ''
  }
}

async function remove(uid: string, displayName: string) {
  if (!window.confirm(t('team.removeConfirm', { name: displayName }))) return
  busy.value = `remove:${uid}`
  error.value = ''
  try {
    await removeTeamMember(uid)
    notice.value = t('team.memberRemoved')
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<template>
  <section class="min-w-0 space-y-5">
    <header class="min-w-0">
      <p class="text-sm font-semibold uppercase tracking-wide text-emerald-700 mb-2">{{ $t('team.eyebrow') }}</p>
      <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-surface-900">
        {{ data?.team.displayName || auth.access?.teamName || $t('team.title') }}
      </h1>
      <p class="text-surface-500 mt-2 max-w-2xl">{{ $t('team.subtitle') }}</p>
    </header>

    <div v-if="error" class="rounded-xl bg-red-50 px-4 py-3 text-red-700">{{ error }}</div>
    <div v-if="notice" class="rounded-xl bg-emerald-50 px-4 py-3 text-emerald-800">{{ notice }}</div>

    <div v-if="loading" class="flex min-h-64 items-center justify-center">
      <span class="text-surface-500">{{ $t('common.refresh') }}…</span>
    </div>

    <div v-if="!loading && data" class="space-y-5">
      <div class="rounded-3xl border border-surface-200 bg-white overflow-hidden">
        <div class="p-5 sm:p-7 border-b border-surface-200">
          <h2 class="text-xl font-semibold">{{ $t('team.inviteTitle') }}</h2>
          <p class="text-surface-500 mt-1">{{ $t('team.inviteDescription') }}</p>
          <form class="grid sm:grid-cols-[1fr_auto] gap-3 mt-5" @submit.prevent="invite">
            <input
              v-model="email"
              type="email"
              autocomplete="email"
              :placeholder="$t('team.emailPlaceholder')"
              required
              class="w-full rounded-xl border border-surface-300 px-4 py-3 outline-none focus:border-emerald-700"
            />
            <button
              type="submit"
              :disabled="busy === 'invite'"
              class="rounded-xl bg-emerald-800 px-5 py-3 font-semibold text-white disabled:opacity-50"
            >
              {{ $t('team.sendInvitation') }}
            </button>
          </form>
        </div>

        <div class="p-5 sm:p-7">
          <h2 class="text-xl font-semibold mb-4">{{ $t('team.members') }}</h2>
          <div class="divide-y divide-surface-200">
            <div
              v-for="member in data.members"
              :key="member.uid"
              class="min-w-0 py-4 first:pt-0 last:pb-0 flex items-center gap-3"
            >
              <img
                v-if="member.photoURL"
                :src="member.photoURL"
                :alt="member.displayName || member.email"
                class="w-10 h-10 rounded-full object-cover shrink-0"
              />
              <span
                v-else
                class="w-10 h-10 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-semibold shrink-0"
              >
                {{ (member.displayName || member.email).slice(0, 1) }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="font-semibold truncate">{{ member.displayName || member.email }}</div>
                <div class="text-sm text-surface-500 truncate">{{ member.email }}</div>
              </div>
              <span class="rounded-full bg-surface-100 px-3 py-1 text-sm font-medium">
                {{ member.role === 'admin' ? $t('team.admin') : $t('team.member') }}
              </span>
              <button
                v-if="isAdmin && member.role !== 'admin' && member.uid !== auth.user?.uid"
                type="button"
                :disabled="busy === `remove:${member.uid}`"
                :aria-label="$t('team.removeMember')"
                class="rounded-lg px-3 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50"
                @click="remove(member.uid, member.displayName || member.email)"
              >
                <i class="pi pi-user-minus" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="data.invitations.length"
        class="rounded-3xl border border-surface-200 bg-white overflow-hidden"
      >
        <div class="p-5 sm:p-7">
          <h2 class="text-xl font-semibold mb-4">{{ $t('team.pendingInvitations') }}</h2>
          <div class="divide-y divide-surface-200">
            <div
              v-for="invitation in data.invitations"
              :key="invitation.id"
              class="min-w-0 py-4 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div class="min-w-0 flex-1">
                <div class="font-semibold break-all">{{ invitation.email }}</div>
                <div class="text-sm text-surface-500">
                  {{ $t('team.expires', { date: formatDate(invitation.expiresAt) }) }}
                </div>
                <div v-if="invitation.deliveryStatus === 'failed'" class="text-sm text-red-600 mt-1">
                  {{ $t('team.deliveryFailed') }}
                  <span v-if="invitation.deliveryError"> — {{ invitation.deliveryError }}</span>
                </div>
                <div v-else-if="invitation.deliveryStatus === 'sent'" class="text-sm text-surface-500 mt-1">
                  {{ $t('team.deliveryAccepted') }}
                </div>
              </div>
              <div class="flex gap-2">
                <button
                  type="button"
                  :disabled="busy === `resend:${invitation.id}`"
                  class="rounded-lg border border-surface-300 px-3 py-2 text-sm font-semibold disabled:opacity-50"
                  @click="resend(invitation.id)"
                >
                  {{ $t('team.resend') }}
                </button>
                <button
                  type="button"
                  :disabled="busy === `revoke:${invitation.id}`"
                  class="rounded-lg px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"
                  @click="revoke(invitation.id)"
                >
                  {{ $t('team.revoke') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
