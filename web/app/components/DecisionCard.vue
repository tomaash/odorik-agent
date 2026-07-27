<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <div class="relative mx-auto w-full max-w-[340px]">
    <!-- Warm glow behind the device -->
    <div
      aria-hidden="true"
      class="absolute -inset-12 rounded-full bg-brand-500/20 blur-3xl"
    />

    <!-- Cards waiting behind the top one: one decision at a time, more in the queue -->
    <div
      aria-hidden="true"
      class="absolute inset-x-6 -bottom-3 h-24 rounded-[2rem] border border-white/5 bg-ink-800/60"
    />
    <div
      aria-hidden="true"
      class="absolute inset-x-3 -bottom-1.5 h-24 rounded-[2rem] border border-white/5 bg-ink-800/80"
    />

    <div
      class="relative rounded-[2.25rem] border border-white/10 bg-ink-900 p-2.5 shadow-2xl shadow-black/60"
    >
      <div class="rounded-[1.85rem] bg-ink-950 p-5">
        <!-- Status row -->
        <div class="flex items-center justify-between">
          <span
            class="inline-flex items-center gap-2 rounded-full bg-brand-400/10 px-3 py-1 text-[11px] font-medium text-brand-300"
          >
            <span class="relative flex h-1.5 w-1.5">
              <span
                class="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75"
              />
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-400" />
            </span>
            {{ t('card.label') }}
          </span>
          <span class="text-[11px] text-zinc-600">{{ t('card.time') }}</span>
        </div>

        <!-- The proposed action -->
        <p class="mt-4 text-[17px] font-semibold leading-snug text-white">
          {{ t('card.action') }}
        </p>

        <!-- Trigger -->
        <div class="mt-5 border-t border-white/5 pt-4">
          <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-600">
            {{ t('card.triggerLabel') }}
          </p>
          <p class="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
            {{ t('card.trigger') }}
          </p>
        </div>

        <!-- Evidence -->
        <div class="mt-4 border-t border-white/5 pt-4">
          <p class="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-600">
            {{ t('card.evidenceLabel') }}
          </p>
          <ul class="mt-2 space-y-2">
            <li
              v-for="i in 2"
              :key="i"
              class="flex gap-2.5 text-[13px] leading-relaxed text-zinc-400"
            >
              <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" />
              <span>{{ t(`card.evidence.${i - 1}`) }}</span>
            </li>
          </ul>
        </div>

        <!-- Disclosed consequence -->
        <p
          class="mt-4 rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-zinc-500"
        >
          {{ t('card.consequence') }}
        </p>

        <!-- Controls: buttons, not gestures -->
        <div class="mt-5 grid grid-cols-4 gap-2">
          <button
            type="button"
            tabindex="-1"
            class="col-span-1 rounded-xl border border-white/10 py-2.5 text-[12px] font-medium text-zinc-400"
          >
            {{ t('card.reject') }}
          </button>
          <button
            type="button"
            tabindex="-1"
            class="col-span-1 rounded-xl border border-white/10 py-2.5 text-[12px] font-medium text-zinc-400"
          >
            {{ t('card.refine') }}
          </button>
          <button
            type="button"
            tabindex="-1"
            class="col-span-2 rounded-xl bg-brand-400 py-2.5 text-[12px] font-semibold text-ink-950"
          >
            {{ t('card.approve') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
