<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { i18n, setLocale } from '../i18n'
import Avatar from 'primevue/avatar'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Toast from 'primevue/toast'

const authStore = useAuthStore()
const router = useRouter()
const locale = ref(i18n.global.locale.value)
const localeOptions = [{ label: 'Česky', value: 'cs' }, { label: 'English', value: 'en' }]

function changeLocale(value: string) {
  locale.value = value as 'cs' | 'en'
  setLocale(value)
}

async function signOut() {
  await authStore.signOut()
  await router.replace('/login')
}
</script>

<template>
  <div class="app-gradient min-h-screen min-w-0 overflow-x-hidden">
    <Toast />
    <header class="bg-white/90 backdrop-blur border-b border-surface-200 sticky top-0 z-20">
      <div class="w-full max-w-7xl mx-auto px-4 sm:px-5 py-3 flex items-center justify-between gap-2 sm:gap-4">
        <router-link to="/" class="min-w-0 flex items-center gap-2.5 sm:gap-3 no-underline text-surface-900">
          <span class="w-10 h-10 rounded-xl bg-emerald-800 text-white flex items-center justify-center shrink-0">
            <i class="pi pi-comments" />
          </span>
          <div class="min-w-0">
            <div class="font-bold leading-tight truncate">{{ $t('app.name') }}</div>
            <div class="text-xs text-surface-400 truncate">Reviewable intake</div>
          </div>
        </router-link>
        <div class="shrink-0 flex items-center gap-1.5 sm:gap-3">
          <Select
            :modelValue="locale"
            :options="localeOptions"
            optionLabel="label"
            optionValue="value"
            size="small"
            class="hidden sm:flex w-28"
            @update:modelValue="changeLocale"
          />
          <Avatar
            v-if="authStore.user?.photoURL"
            :image="authStore.user.photoURL"
            shape="circle"
            class="hidden min-[360px]:inline-flex"
          />
          <span class="hidden md:block text-sm font-medium">{{ authStore.user?.displayName }}</span>
          <Button icon="pi pi-sign-out" severity="secondary" text rounded v-tooltip="$t('app.signOut')" @click="signOut" />
        </div>
      </div>
    </header>
    <main class="w-full min-w-0 max-w-7xl mx-auto px-4 sm:px-5 py-6 sm:py-8">
      <router-view />
    </main>
  </div>
</template>
