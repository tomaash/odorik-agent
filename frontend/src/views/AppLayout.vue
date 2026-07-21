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
  <div class="app-gradient min-h-screen">
    <Toast />
    <header class="bg-white/90 backdrop-blur border-b border-surface-200 sticky top-0 z-20">
      <div class="max-w-7xl mx-auto px-5 py-3 flex items-center justify-between gap-4">
        <router-link to="/" class="flex items-center gap-3 no-underline text-surface-900">
          <span class="w-10 h-10 rounded-xl bg-emerald-800 text-white flex items-center justify-center">
            <i class="pi pi-comments" />
          </span>
          <div>
            <div class="font-bold leading-tight">{{ $t('app.name') }}</div>
            <div class="text-xs text-surface-400">Reviewable intake</div>
          </div>
        </router-link>
        <div class="flex items-center gap-3">
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
          />
          <span class="hidden md:block text-sm font-medium">{{ authStore.user?.displayName }}</span>
          <Button icon="pi pi-sign-out" severity="secondary" text rounded v-tooltip="$t('app.signOut')" @click="signOut" />
        </div>
      </div>
    </header>
    <main class="max-w-7xl mx-auto px-5 py-8">
      <router-view />
    </main>
  </div>
</template>
