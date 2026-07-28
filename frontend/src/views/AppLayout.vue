<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Avatar from 'primevue/avatar'
import Button from 'primevue/button'
import Drawer from 'primevue/drawer'
import Select from 'primevue/select'
import Toast from 'primevue/toast'
import { useAuthStore } from '../stores/auth'
import { i18n, setLocale } from '../i18n'

const authStore = useAuthStore()
const router = useRouter()
const locale = ref(i18n.global.locale.value)
const menuOpen = ref(false)
const localeOptions = [
  { label: 'CS', value: 'cs' },
  { label: 'EN', value: 'en' },
]
const navigation = [
  { to: '/tasks', icon: 'pi pi-check-square', label: 'nav.tasks' },
  { to: '/pipeline', icon: 'pi pi-th-large', label: 'nav.pipeline' },
  { to: '/contacts', icon: 'pi pi-users', label: 'nav.contacts' },
  { to: '/ask', icon: 'pi pi-comment', label: 'nav.ask' },
]
const secondaryNavigation = [
  { to: '/workflows', icon: 'pi pi-sitemap', label: 'nav.workflows' },
  { to: '/sources', icon: 'pi pi-database', label: 'nav.sources' },
  { to: '/team', icon: 'pi pi-users', label: 'nav.team' },
]

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
  <div class="min-h-screen min-w-0 bg-[var(--paper)] text-[var(--ink)]">
    <Toast />

    <header class="md:hidden sticky top-0 z-30 h-14 flex items-center justify-between gap-3 px-4 bg-[rgba(250,249,246,.96)] backdrop-blur border-b border-[var(--hairline)]">
      <router-link to="/" class="min-w-0 flex items-center gap-2.5 no-underline text-[var(--ink)]">
        <span class="w-7 h-7 rounded-md bg-[#151515] text-white flex items-center justify-center font-semibold text-sm shrink-0">E</span>
        <span class="min-w-0">
          <strong class="block text-sm leading-tight">{{ $t('app.agentName') }}</strong>
          <span class="block text-[.65rem] leading-tight font-mono text-surface-500 truncate">
            {{ authStore.access?.teamName || $t('app.subtitle') }}
          </span>
        </span>
      </router-link>
      <div class="flex items-center gap-1">
        <Select
          :modelValue="locale"
          :options="localeOptions"
          optionLabel="label"
          optionValue="value"
          size="small"
          class="w-[4.5rem]"
          @update:modelValue="changeLocale"
        />
        <button
          type="button"
          class="w-9 h-9 inline-flex items-center justify-center text-surface-500 no-underline"
          :aria-label="$t('team.manage')"
          @click="menuOpen = true"
        >
          <i class="pi pi-bars" />
        </button>
      </div>
    </header>

    <Drawer v-model:visible="menuOpen" position="right" class="!w-[min(22rem,88vw)]">
      <template #header>
        <div class="min-w-0">
          <strong class="block text-sm">{{ authStore.access?.teamName || $t('app.name') }}</strong>
          <span class="block text-xs text-surface-500 truncate">{{ authStore.user?.displayName || authStore.user?.email }}</span>
        </div>
      </template>
      <nav class="grid gap-1" :aria-label="$t('nav.primary')">
        <router-link
          v-for="item in secondaryNavigation"
          :key="item.to"
          :to="item.to"
          class="h-11 px-3 flex items-center gap-3 rounded-md text-sm font-medium no-underline text-surface-600 hover:bg-surface-50"
          active-class="!bg-surface-100 !text-surface-950"
          @click="menuOpen = false"
        >
          <i :class="[item.icon, 'text-sm text-surface-400']" />
          <span>{{ $t(item.label) }}</span>
        </router-link>
      </nav>
      <Button
        :label="$t('app.signOut')"
        icon="pi pi-sign-out"
        severity="secondary"
        outlined
        class="w-full mt-5"
        @click="signOut"
      />
    </Drawer>

    <aside class="hidden md:flex fixed inset-y-0 left-0 z-30 w-60 flex-col bg-[rgba(250,249,246,.98)] border-r border-[var(--hairline)]">
      <router-link to="/" class="h-16 px-5 flex items-center gap-3 no-underline text-[var(--ink)] border-b border-[var(--hairline)]">
        <span class="w-7 h-7 rounded-md bg-[#151515] text-white flex items-center justify-center font-semibold text-sm">E</span>
        <span class="min-w-0">
          <strong class="block text-sm leading-tight">{{ $t('app.name') }}</strong>
          <span class="block text-[.66rem] leading-tight font-mono text-surface-500 truncate">
            {{ authStore.access?.teamName || $t('app.subtitle') }}
          </span>
        </span>
      </router-link>

      <nav class="px-3 py-4 grid gap-1" :aria-label="$t('nav.primary')">
        <router-link
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="group h-10 px-3 flex items-center gap-3 rounded-md text-sm font-medium no-underline text-surface-600 hover:text-surface-950 hover:bg-white transition"
          active-class="!bg-white !text-surface-950 border border-surface-200"
        >
          <i :class="[item.icon, 'text-xs text-surface-400 group-[.router-link-active]:text-indigo-600']" />
          <span class="flex-1">{{ $t(item.label) }}</span>
        </router-link>
      </nav>

      <div class="px-3 pt-3 mt-1 border-t border-[var(--hairline)] grid gap-1">
        <router-link
          v-for="item in secondaryNavigation"
          :key="item.to"
          :to="item.to"
          class="group h-9 px-3 flex items-center gap-3 rounded-md text-xs font-medium no-underline text-surface-500 hover:text-surface-950 hover:bg-white transition"
          active-class="!bg-white !text-surface-950"
        >
          <i :class="[item.icon, 'text-xs text-surface-400']" />
          <span>{{ $t(item.label) }}</span>
        </router-link>
      </div>

      <div class="mt-auto border-t border-[var(--hairline)] p-3">
        <div class="flex items-center gap-2.5 px-2 py-2">
          <Avatar
            v-if="authStore.user?.photoURL"
            :image="authStore.user.photoURL"
            shape="circle"
            size="small"
          />
          <Avatar v-else icon="pi pi-user" shape="circle" size="small" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium truncate">{{ authStore.user?.displayName || authStore.user?.email }}</div>
            <div class="font-mono text-[.62rem] text-emerald-700">online</div>
          </div>
          <router-link
            to="/team"
            class="w-8 h-8 inline-flex items-center justify-center text-surface-500 no-underline"
            :aria-label="$t('team.manage')"
          >
            <i class="pi pi-users text-sm" />
          </router-link>
        </div>
        <div class="flex items-center gap-2 mt-1">
          <Select
            :modelValue="locale"
            :options="localeOptions"
            optionLabel="label"
            optionValue="value"
            size="small"
            class="flex-1"
            @update:modelValue="changeLocale"
          />
          <Button
            icon="pi pi-sign-out"
            severity="secondary"
            text
            :aria-label="$t('app.signOut')"
            @click="signOut"
          />
        </div>
      </div>
    </aside>

    <main class="min-w-0 md:pl-60 pb-24 md:pb-0">
      <router-view />
    </main>

    <nav class="mobile-nav md:hidden fixed left-0 right-0 bottom-0 z-40 grid grid-cols-4 bg-[rgba(250,249,246,.97)] backdrop-blur border-t border-[var(--hairline)]" :aria-label="$t('nav.primary')">
      <router-link
        v-for="item in navigation"
        :key="item.to"
        :to="item.to"
        class="relative min-w-0 h-14 px-1 pt-2 flex flex-col items-center gap-1 text-[.64rem] font-medium no-underline text-surface-500"
        active-class="!text-surface-950"
      >
        <span class="mobile-nav-indicator absolute top-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-transparent" />
        <i :class="[item.icon, 'text-sm']" />
        <span class="truncate max-w-full">{{ $t(item.label) }}</span>
      </router-link>
    </nav>
  </div>
</template>
