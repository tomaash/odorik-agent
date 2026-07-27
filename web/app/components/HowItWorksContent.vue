<script setup lang="ts">
const { t } = useI18n()

useHead({
  title: t('meta.howTitle'),
  meta: [{ name: 'description', content: t('how.intro') }],
})
</script>

<template>
  <div>
    <!-- Header -->
    <section class="border-b border-white/5 py-20 sm:py-24">
      <div class="container-page max-w-3xl">
        <p class="eyebrow">{{ t('how.eyebrow') }}</p>
        <h1 class="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          {{ t('how.h1') }}
        </h1>
        <p class="body-lg mt-6">{{ t('how.intro') }}</p>
      </div>
    </section>

    <!-- Six loops -->
    <section class="border-b border-white/5 py-20 sm:py-24">
      <div class="container-page">
        <h2 class="h-section">{{ t('how.loopsTitle') }}</h2>

        <div class="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2">
          <div v-for="i in 6" :key="i" class="border-t border-white/10 pt-5">
            <span class="text-sm font-semibold text-brand-400">0{{ i }}</span>
            <p class="mt-2 text-lg font-semibold text-white">
              {{ t(`how.loops.${i - 1}.title`) }}
            </p>
            <p class="mt-2 text-sm leading-relaxed text-zinc-400">
              {{ t(`how.loops.${i - 1}.body`) }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Responsibility boundary -->
    <section class="border-b border-white/5 py-20 sm:py-24">
      <div class="container-page">
        <h2 class="h-section">{{ t('how.boundaryTitle') }}</h2>

        <div class="mt-10 overflow-hidden rounded-2xl border border-white/10">
          <div
            class="hidden bg-white/[0.03] px-6 py-4 text-sm font-medium text-zinc-500 md:grid md:grid-cols-[1.6fr_0.6fr_1.2fr] md:gap-6"
          >
            <span v-for="i in 3" :key="i">{{ t(`how.boundaryHead.${i - 1}`) }}</span>
          </div>

          <div
            v-for="i in 3"
            :key="i"
            class="border-t border-white/5 px-6 py-5 md:grid md:grid-cols-[1.6fr_0.6fr_1.2fr] md:gap-6"
          >
            <p class="text-sm text-white">{{ t(`how.boundaryRows.${i - 1}.write`) }}</p>
            <p
              class="mt-2 text-sm font-semibold md:mt-0"
              :class="i === 3 ? 'text-brand-400' : 'text-zinc-400'"
            >
              {{ t(`how.boundaryRows.${i - 1}.auto`) }}
            </p>
            <p class="mt-1 text-sm text-zinc-500 md:mt-0">
              {{ t(`how.boundaryRows.${i - 1}.authority`) }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Anatomy of a card -->
    <section class="border-b border-white/5 py-20 sm:py-24">
      <div class="container-page grid gap-14 lg:grid-cols-[1fr_340px] lg:items-start">
        <div>
          <h2 class="h-section">{{ t('how.anatomyTitle') }}</h2>

          <dl class="mt-10 space-y-6">
            <div v-for="i in 5" :key="i" class="border-t border-white/10 pt-4">
              <dt class="font-semibold text-white">{{ t(`how.anatomy.${i - 1}.title`) }}</dt>
              <dd class="mt-1.5 text-sm leading-relaxed text-zinc-400">
                {{ t(`how.anatomy.${i - 1}.body`) }}
              </dd>
            </div>
          </dl>
        </div>

        <div class="lg:sticky lg:top-24">
          <DecisionCard />
        </div>
      </div>
    </section>

    <!-- Connectors -->
    <section class="py-20 sm:py-24">
      <div class="container-page max-w-3xl">
        <h2 class="h-section">{{ t('how.connectorsTitle') }}</h2>
        <p class="body-lg mt-6">{{ t('how.connectorsBody') }}</p>
      </div>
    </section>

    <CtaBand />
  </div>
</template>
