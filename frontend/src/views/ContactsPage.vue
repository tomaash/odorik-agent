<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import { useContactsStore } from '../stores/contacts'

const store = useContactsStore()
const { t } = useI18n()
const search = ref('')

const filteredItems = computed(() => {
  const term = search.value.trim().toLocaleLowerCase()
  if (!term) return store.items
  return store.items.filter((contact) => [contact.displayName, contact.phoneE164, contact.phoneRaw, contact.email]
    .some((value) => String(value || '').toLocaleLowerCase().includes(term)))
})

onMounted(() => store.loadList())
</script>

<template>
  <section class="min-h-screen min-w-0 px-4 py-5 sm:p-6">
    <div class="grid gap-4 sm:flex sm:items-end sm:justify-between mb-6">
      <div class="min-w-0">
        <div class="eyebrow mb-2">CRM</div>
        <h1 class="text-2xl sm:text-3xl font-semibold tracking-[-.03em] mb-2 break-words">{{ t('contacts.title') }}</h1>
        <p class="text-surface-500 text-sm sm:text-base leading-relaxed">{{ t('contacts.subtitle') }}</p>
      </div>
      <Button icon="pi pi-refresh" severity="secondary" outlined :loading="store.loading" :aria-label="t('common.refresh')" @click="store.loadList" />
    </div>

    <Message v-if="store.error" severity="error" :closable="false" class="mb-5">{{ store.error }}</Message>
    <label class="relative block min-w-0 max-w-xl mb-6">
      <i class="pi pi-search absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 z-10" />
      <InputText v-model="search" :placeholder="t('contacts.search')" class="w-full min-w-0 pl-10" />
    </label>

    <div v-if="store.loading && store.items.length === 0" class="flex justify-center py-20"><ProgressSpinner /></div>
    <div v-else class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
      <router-link
        v-for="contact in filteredItems"
        :key="contact.id"
        :to="`/contacts/${contact.id}`"
        class="hairline-card min-w-0 overflow-hidden no-underline text-surface-900 p-4 sm:p-5 hover:border-indigo-300 transition"
      >
        <div class="flex items-start gap-3 min-w-0">
          <div class="w-10 h-10 rounded-md bg-indigo-50 text-indigo-700 flex items-center justify-center shrink-0"><i class="pi pi-user" /></div>
          <div class="min-w-0">
            <h2 class="text-lg font-semibold m-0 break-words">{{ contact.displayName || t('contacts.unknown') }}</h2>
            <p class="text-sm text-surface-500 mt-1 mb-0 break-all">{{ contact.phoneE164 || contact.phoneRaw || '—' }}</p>
            <p v-if="contact.email" class="text-sm text-surface-500 mt-1 mb-0 break-all">{{ contact.email }}</p>
          </div>
        </div>
      </router-link>
      <div v-if="filteredItems.length === 0" class="sm:col-span-2 xl:col-span-3 rounded-md border border-dashed border-surface-300 bg-white/70 p-12 text-center text-surface-500">
        <i class="pi pi-users text-3xl block mb-3 text-surface-300" />{{ t('contacts.empty') }}
      </div>
    </div>
  </section>
</template>
