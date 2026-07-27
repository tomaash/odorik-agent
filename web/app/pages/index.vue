<script setup lang="ts">
const { t } = useI18n()
const paths = useSitePaths()
const contact = useContactModal()

useHead({
  title: t('meta.title'),
  meta: [{ name: 'description', content: t('meta.description') }],
})
</script>

<template>
  <div>
    <!-- Hero -->
    <section class="relative overflow-hidden">
      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-0 -top-40 h-96 bg-gradient-to-b from-brand-500/10 to-transparent blur-2xl"
      />
      <div class="container-page relative grid gap-16 py-20 lg:grid-cols-2 lg:items-center lg:py-28">
        <div>
          <h1 class="text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            {{ t('hero.h1a') }}<br />
            <span class="text-brand-400">{{ t('hero.h1b') }}</span>
          </h1>

          <p class="mt-7 max-w-xl text-lg leading-relaxed text-zinc-400">
            {{ t('hero.sub') }}
          </p>

          <div class="mt-9 flex flex-wrap gap-3">
            <button type="button" class="btn-primary" @click="contact.open()">
              {{ t('hero.ctaPrimary') }}
            </button>
            <NuxtLink :to="paths.howItWorks.value" class="btn-ghost">
              {{ t('hero.ctaSecondary') }} →
            </NuxtLink>
          </div>

          <ul class="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-zinc-500">
            <li v-for="i in 3" :key="i" class="flex items-center gap-2">
              <span class="h-1 w-1 rounded-full bg-zinc-600" />
              {{ t(`hero.trust.${i - 1}`) }}
            </li>
          </ul>
        </div>

        <div class="lg:pl-8">
          <DecisionCard />
        </div>
      </div>
    </section>

    <!-- Problem -->
    <section class="border-t border-white/5 py-20 sm:py-28">
      <div class="container-page">
        <p class="eyebrow">{{ t('problem.eyebrow') }}</p>
        <h2 class="h-section mt-4 max-w-3xl">{{ t('problem.h2') }}</h2>
        <p class="body-lg mt-6 max-w-3xl">{{ t('problem.body') }}</p>

        <div class="mt-14 grid gap-8 sm:grid-cols-3">
          <div v-for="i in 3" :key="i" class="border-t border-white/10 pt-5">
            <p class="font-semibold text-white">{{ t(`problem.items.${i - 1}.title`) }}</p>
            <p class="mt-2 text-sm leading-relaxed text-zinc-500">
              {{ t(`problem.items.${i - 1}.body`) }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- The shift -->
    <section class="border-t border-white/5 py-20 sm:py-28">
      <div class="container-page">
        <p class="eyebrow">{{ t('shift.eyebrow') }}</p>
        <h2 class="h-section mt-4 max-w-3xl">{{ t('shift.h2') }}</h2>
        <p class="body-lg mt-6 max-w-3xl">{{ t('shift.body') }}</p>

        <div class="mt-14 grid gap-6 md:grid-cols-3">
          <div
            v-for="i in 3"
            :key="i"
            class="relative rounded-2xl border border-white/10 bg-ink-900/40 p-6"
          >
            <span class="text-sm font-semibold text-brand-400">0{{ i }}</span>
            <p class="mt-3 text-lg font-semibold text-white">
              {{ t(`shift.steps.${i - 1}.title`) }}
            </p>
            <p class="mt-2 text-sm leading-relaxed text-zinc-400">
              {{ t(`shift.steps.${i - 1}.body`) }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Difference -->
    <section class="border-t border-white/5 py-20 sm:py-28">
      <div class="container-page">
        <p class="eyebrow">{{ t('diff.eyebrow') }}</p>
        <h2 class="h-section mt-4">{{ t('diff.h2') }}</h2>

        <div class="mt-12 overflow-hidden rounded-2xl border border-white/10">
          <!-- Header: desktop only -->
          <div
            class="hidden bg-white/[0.03] px-6 py-4 text-sm font-medium md:grid md:grid-cols-[1fr_1fr_1.2fr] md:gap-6"
          >
            <span class="text-zinc-500" />
            <span class="text-zinc-500">{{ t('diff.colA') }}</span>
            <span class="text-brand-400">{{ t('diff.colB') }}</span>
          </div>

          <div
            v-for="i in 4"
            :key="i"
            class="border-t border-white/5 px-6 py-5 md:grid md:grid-cols-[1fr_1fr_1.2fr] md:gap-6"
          >
            <p class="text-sm font-medium text-white">{{ t(`diff.rows.${i - 1}.label`) }}</p>

            <p class="mt-3 text-sm text-zinc-500 md:mt-0">
              <span class="mr-2 text-xs uppercase tracking-wider text-zinc-600 md:hidden">
                {{ t('diff.colA') }}
              </span>
              {{ t(`diff.rows.${i - 1}.a`) }}
            </p>

            <p class="mt-2 text-sm text-zinc-200 md:mt-0">
              <span class="mr-2 text-xs uppercase tracking-wider text-brand-400 md:hidden">
                {{ t('diff.colB') }}
              </span>
              {{ t(`diff.rows.${i - 1}.b`) }}
            </p>
          </div>
        </div>

        <p class="mt-8 text-lg font-medium text-white">{{ t('diff.note') }}</p>
      </div>
    </section>

    <!-- Anywhere -->
    <section class="border-t border-white/5 py-20 sm:py-28">
      <div class="container-page grid gap-12 lg:grid-cols-[1.3fr_1fr] lg:items-start">
        <div>
          <p class="eyebrow">{{ t('anywhere.eyebrow') }}</p>
          <h2 class="h-section mt-4">{{ t('anywhere.h2') }}</h2>
          <p class="body-lg mt-6">{{ t('anywhere.body') }}</p>
        </div>

        <div class="rounded-2xl border border-white/10 bg-ink-900/40 p-6">
          <p class="text-sm font-semibold text-brand-400">{{ t('anywhere.voiceTitle') }}</p>

          <div class="mt-4 flex items-center gap-3 rounded-xl bg-white/[0.04] px-4 py-3">
            <span class="flex items-end gap-[3px]" aria-hidden="true">
              <span class="h-2 w-[3px] rounded-full bg-brand-400" />
              <span class="h-4 w-[3px] rounded-full bg-brand-400" />
              <span class="h-6 w-[3px] rounded-full bg-brand-400" />
              <span class="h-3 w-[3px] rounded-full bg-brand-400" />
              <span class="h-5 w-[3px] rounded-full bg-brand-400" />
            </span>
            <p class="text-sm italic text-zinc-300">“{{ t('anywhere.voiceQuote') }}”</p>
          </div>

          <p class="mt-4 text-sm leading-relaxed text-zinc-400">
            {{ t('anywhere.voiceBody') }}
          </p>
        </div>
      </div>
    </section>

    <!-- Accountability -->
    <section class="border-t border-white/5 py-20 sm:py-28">
      <div class="container-page">
        <p class="eyebrow">{{ t('accountability.eyebrow') }}</p>
        <h2 class="h-section mt-4 max-w-3xl">{{ t('accountability.h2') }}</h2>
        <p class="body-lg mt-6 max-w-3xl">{{ t('accountability.body') }}</p>

        <div class="mt-14 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          <div v-for="i in 4" :key="i" class="flex gap-4">
            <span class="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
            <div>
              <p class="font-semibold text-white">
                {{ t(`accountability.items.${i - 1}.title`) }}
              </p>
              <p class="mt-1 text-sm leading-relaxed text-zinc-500">
                {{ t(`accountability.items.${i - 1}.body`) }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Where it starts -->
    <section class="border-t border-white/5 py-20 sm:py-28">
      <div class="container-page max-w-3xl">
        <p class="eyebrow">{{ t('start.eyebrow') }}</p>
        <h2 class="h-section mt-4">{{ t('start.h2') }}</h2>
        <p class="body-lg mt-6">{{ t('start.body') }}</p>
      </div>
    </section>

    <!-- Design partner -->
    <section id="design-partner" class="scroll-mt-20 border-t border-white/5 py-20 sm:py-28">
      <div class="container-page grid gap-12 lg:grid-cols-2 lg:items-start">
        <div>
          <p class="eyebrow">{{ t('cta.eyebrow') }}</p>
          <h2 class="h-section mt-4">{{ t('cta.h2') }}</h2>
          <p class="body-lg mt-6">{{ t('cta.body') }}</p>

          <p class="mt-8 border-l-2 border-brand-400 pl-4 text-zinc-300">
            {{ t('cta.pricing') }}
          </p>

          <p class="mt-8 text-sm leading-relaxed text-zinc-500">{{ t('cta.status') }}</p>
        </div>

        <div class="rounded-2xl border border-white/10 bg-ink-900/60 p-6 sm:p-8">
          <p class="text-lg font-semibold text-white">{{ t('form.modalTitle') }}</p>
          <p class="mt-2 text-zinc-400">{{ t('form.modalSubtitle') }}</p>
          <button type="button" class="btn-primary mt-6" @click="contact.open()">
            {{ t('cta.bandCta') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
