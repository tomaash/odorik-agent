<script setup lang="ts">
const { t } = useI18n()
const contact = useContactModal()
</script>

<template>
  <section class="py-20 sm:py-24">
    <div class="container-page max-w-2xl">
      <h1 class="text-4xl font-semibold tracking-tight text-white">{{ t('terms.h1') }}</h1>
      <p class="mt-3 text-sm text-zinc-500">{{ t('terms.updated') }}</p>
      <p class="mt-6 text-zinc-400">{{ t('terms.intro') }}</p>

      <div class="mt-12 space-y-10">
        <div v-for="i in 6" :key="i">
          <h2 class="text-lg font-semibold text-white">
            {{ t(`terms.sections.${i - 1}.title`) }}
          </h2>
          <p class="mt-2 leading-relaxed text-zinc-400">
            {{ t(`terms.sections.${i - 1}.body`) }}
          </p>
        </div>
      </div>

      <p class="mt-12 border-t border-white/10 pt-6 text-sm text-zinc-500">
        {{ t('terms.contact') }}
        <button
          type="button"
          class="text-brand-300 underline underline-offset-4"
          @click="contact.open()"
        >
          {{ t('footer.contact') }}
        </button>
      </p>
    </div>
  </section>
</template>
