<script setup lang="ts">
const { t } = useI18n()
const config = useRuntimeConfig()

// The modal owns the confirmation screen — this component only reports that the
// submission landed, so the pitch above the form can be swapped out with it.
const emit = defineEmits<{ success: [] }>()

const form = reactive({
  name: '',
  email: '',
  company: '',
  runsOn: '',
  message: '',
  // Honeypot: hidden from people, so anything here marks the sender as a bot.
  website: '',
})

type Status = 'idle' | 'sending' | 'error'
const status = ref<Status>('idle')

const runsOnOptions = computed(() =>
  [0, 1, 2, 3].map((i) => t(`form.runsOnOptions.${i}`)),
)

async function onSubmit() {
  status.value = 'sending'

  const endpoint = config.public.partnerFormUrl as string

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, locale: config.public.buildLocale }),
    })
    // A missing function makes Hosting answer the rewrite with an HTML page, so
    // a 200 alone is not proof the submission was delivered.
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.ok !== true) throw new Error(String(res.status))
    emit('success')
  } catch {
    status.value = 'error'
  }
}
</script>

<template>
  <div>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <input
        v-model="form.website"
        class="hidden"
        type="text"
        tabindex="-1"
        autocomplete="off"
        aria-hidden="true"
      />
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
        </p>
      </div>
    </form>
  </div>
</template>
