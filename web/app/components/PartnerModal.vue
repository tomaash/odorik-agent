<script setup lang="ts">
const { t } = useI18n()
const { isOpen, sent, close, markSent } = useContactModal()

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
}

// The backdrop covers the page, so the body must not scroll behind it.
watch(isOpen, (open) => {
  if (import.meta.server) return
  document.body.style.overflow = open ? 'hidden' : ''
})

onMounted(() => document.addEventListener('keydown', onKeydown))

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (import.meta.client) document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        class="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:items-center"
        role="dialog"
        aria-modal="true"
        :aria-label="t('form.modalTitle')"
      >
        <div class="fixed inset-0 bg-black/70 backdrop-blur-sm" @click="close" />

        <div
          class="relative z-10 my-auto w-full max-w-lg rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/60 sm:p-8"
        >
          <button
            type="button"
            class="absolute right-4 top-4 text-zinc-500 transition hover:text-white"
            :aria-label="t('form.close')"
            @click="close"
          >
            <svg
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="2"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>

          <template v-if="sent">
            <h2 class="text-2xl font-semibold tracking-tight text-white">
              {{ t('form.successTitle') }}
            </h2>
            <p class="mt-3 text-zinc-400">{{ t('form.success') }}</p>
            <button type="button" class="btn-primary mt-8" @click="close">
              {{ t('form.ok') }}
            </button>
          </template>

          <template v-else>
            <p class="eyebrow">{{ t('cta.eyebrow') }}</p>
            <h2 class="mt-3 text-2xl font-semibold tracking-tight text-white">
              {{ t('form.modalTitle') }}
            </h2>
            <p class="mt-2 text-zinc-400">{{ t('form.modalSubtitle') }}</p>

            <div class="mt-6">
              <PartnerForm @success="markSent()" />
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
