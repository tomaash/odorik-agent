<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <section class="border-t border-white/5 py-16">
    <div
      class="container-page flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p class="text-lg font-semibold text-white">{{ t('cta.bandTitle') }}</p>
        <p class="mt-1 text-zinc-400">{{ t('cta.bandBody') }}</p>
      </div>
      <NuxtLink to="/#design-partner" class="btn-primary shrink-0">
        {{ t('cta.bandCta') }}
      </NuxtLink>
    </div>
  </section>
</template>
