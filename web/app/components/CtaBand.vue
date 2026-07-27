<script setup lang="ts">
const { t } = useI18n()
const contact = useContactModal()
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
      <button type="button" class="btn-primary shrink-0" @click="contact.open()">
        {{ t('cta.bandCta') }}
      </button>
    </div>
  </section>
</template>
