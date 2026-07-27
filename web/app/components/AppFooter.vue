<script setup lang="ts">
const { t } = useI18n()
const paths = useSitePaths()
const year = new Date().getFullYear()
</script>

<template>
  <footer class="border-t border-white/5 py-12">
    <div
      class="container-page flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <div class="flex items-center gap-2.5 font-semibold tracking-tight">
          <span class="h-2 w-2 rounded-full bg-brand-400" />
          <span class="text-white">Agent Erik</span>
        </div>
        <p class="mt-2 text-sm text-zinc-500">{{ t('footer.tagline') }}</p>
      </div>

      <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-zinc-500">
        <NuxtLink :to="paths.privacy.value" class="transition hover:text-white">
          {{ t('footer.privacy') }}
        </NuxtLink>
        <a
          :href="`mailto:${paths.contactEmail.value}`"
          class="transition hover:text-white"
        >
          {{ paths.contactEmail.value }}
        </a>
        <span>&copy; {{ year }}</span>
      </div>
    </div>
  </footer>
</template>
