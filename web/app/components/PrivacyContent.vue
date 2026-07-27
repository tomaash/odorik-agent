<script setup lang="ts">
const { t } = useI18n()
const paths = useSitePaths()

useHead({
  title: t('meta.privacyTitle'),
  meta: [{ name: 'robots', content: 'noindex' }],
})
</script>

<template>
  <section class="py-20 sm:py-24">
    <div class="container-page max-w-2xl">
      <h1 class="text-4xl font-semibold tracking-tight text-white">{{ t('privacy.h1') }}</h1>
      <p class="mt-6 text-zinc-400">{{ t('privacy.intro') }}</p>

      <div class="mt-12 space-y-10">
        <div v-for="i in 4" :key="i">
          <h2 class="text-lg font-semibold text-white">
            {{ t(`privacy.sections.${i - 1}.title`) }}
          </h2>
          <p class="mt-2 leading-relaxed text-zinc-400">
            {{ t(`privacy.sections.${i - 1}.body`) }}
          </p>
        </div>
      </div>

      <p class="mt-12 border-t border-white/10 pt-6 text-sm text-zinc-500">
        {{ t('privacy.contact') }}
        <a
          :href="`mailto:${paths.contactEmail.value}`"
          class="text-brand-300 underline underline-offset-4"
        >
          {{ paths.contactEmail.value }}
        </a>
      </p>
    </div>
  </section>
</template>
