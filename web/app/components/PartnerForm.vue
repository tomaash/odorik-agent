<script setup lang="ts">
const { t } = useI18n()
const config = useRuntimeConfig()
const paths = useSitePaths()

const form = reactive({
  name: '',
  email: '',
  company: '',
  runsOn: '',
  message: '',
})

type Status = 'idle' | 'sending' | 'success' | 'error'
const status = ref<Status>('idle')

const runsOnOptions = computed(() =>
  [0, 1, 2, 3].map((i) => t(`form.runsOnOptions.${i}`)),
)

function mailtoHref() {
  const subject = `Design partner: ${form.company || form.name}`
  const body = [
    `${t('form.name')}: ${form.name}`,
    `${t('form.email')}: ${form.email}`,
    `${t('form.company')}: ${form.company}`,
    `${t('form.runsOn')} ${form.runsOn}`,
    '',
    form.message,
  ].join('\n')

  return `mailto:${paths.contactEmail.value}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`
}

async function onSubmit() {
  status.value = 'sending'

  const endpoint = config.public.partnerFormUrl as string

  // No endpoint configured yet — hand off to the visitor's mail client rather
  // than silently dropping what they typed.
  if (!endpoint) {
    window.location.href = mailtoHref()
    status.value = 'success'
    return
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, locale: config.public.buildLocale }),
    })
    if (!res.ok) throw new Error(String(res.status))
    status.value = 'success'
  } catch {
    status.value = 'error'
  }
}
</script>

<template>
  <div class="rounded-2xl border border-white/10 bg-ink-900/60 p-6 sm:p-8">
    <form v-if="status !== 'success'" class="space-y-4" @submit.prevent="onSubmit">
      <div class="grid gap-4 sm:grid-cols-2">
        <input
          v-model="form.name"
          class="field"
          type="text"
          required
          autocomplete="name"
          :placeholder="t('form.name')"
          :aria-label="t('form.name')"
        />
        <input
          v-model="form.email"
          class="field"
          type="email"
          required
          autocomplete="email"
          :placeholder="t('form.email')"
          :aria-label="t('form.email')"
        />
      </div>

      <input
        v-model="form.company"
        class="field"
        type="text"
        required
        autocomplete="organization"
        :placeholder="t('form.company')"
        :aria-label="t('form.company')"
      />

      <fieldset>
        <legend class="mb-2 text-sm text-zinc-400">{{ t('form.runsOn') }}</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="option in runsOnOptions"
            :key="option"
            class="cursor-pointer rounded-full border px-4 py-2 text-sm transition"
            :class="
              form.runsOn === option
                ? 'border-brand-400 bg-brand-400/10 text-brand-200'
                : 'border-white/10 text-zinc-400 hover:border-white/25'
            "
          >
            <input v-model="form.runsOn" type="radio" :value="option" class="sr-only" />
            {{ option }}
          </label>
        </div>
      </fieldset>

      <textarea
        v-model="form.message"
        class="field min-h-[96px] resize-y"
        rows="3"
        :placeholder="t('form.message')"
        :aria-label="t('form.message')"
      />

      <div class="flex flex-wrap items-center gap-4 pt-1">
        <button type="submit" class="btn-primary" :disabled="status === 'sending'">
          {{ status === 'sending' ? t('form.sending') : t('form.submit') }}
        </button>

        <p v-if="status === 'error'" class="text-sm text-zinc-400">
          {{ t('form.error') }}
          <a
            :href="`mailto:${paths.contactEmail.value}`"
            class="text-brand-300 underline underline-offset-4"
          >
            {{ paths.contactEmail.value }}
          </a>
        </p>
      </div>
    </form>

    <div v-else class="flex items-start gap-3 py-4">
      <span
        class="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-400 text-sm font-bold text-ink-950"
        >✓</span
      >
      <p class="text-zinc-200">{{ t('form.success') }}</p>
    </div>
  </div>
</template>
