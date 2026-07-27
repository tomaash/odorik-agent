<script setup lang="ts">
const { t, locale, locales, setLocale } = useI18n()
const paths = useSitePaths()
const route = useRoute()
const router = useRouter()

const langOpen = ref(false)
const langWrap = ref<HTMLElement | null>(null)

const currentLocaleName = computed(() => {
  const loc = locales.value.find((l: any) => l.code === locale.value)
  return (loc as any)?.name || locale.value.toUpperCase()
})

// Routes are localised, so switching language must also move you to the
// equivalent path — otherwise you read Czech copy at /how-it-works.
const routePairs: Record<string, string> = {
  '/how-it-works': '/jak-to-funguje',
  '/jak-to-funguje': '/how-it-works',
  '/privacy': '/soukromi',
  '/soukromi': '/privacy',
}

async function switchLang(code: string) {
  langOpen.value = false
  if (code === locale.value) return

  await setLocale(code as 'cs' | 'en')

  const target = routePairs[route.path]
  if (target) router.replace(target)
}

function onDocumentClick(event: MouseEvent) {
  if (!langWrap.value?.contains(event.target as Node)) langOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') langOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="flex min-h-screen flex-col bg-ink-950">
    <header
      class="sticky top-0 z-50 border-b border-white/5 bg-ink-950/80 backdrop-blur-lg"
    >
      <div class="container-page flex h-16 items-center justify-between gap-4">
        <NuxtLink to="/" class="flex items-center gap-2.5 font-semibold tracking-tight">
          <span class="h-2.5 w-2.5 rounded-full bg-brand-400" />
          <span class="text-white">Agent Erik</span>
        </NuxtLink>

        <nav class="flex items-center gap-2 sm:gap-6">
          <NuxtLink
            :to="paths.howItWorks.value"
            class="hidden text-sm text-zinc-400 transition hover:text-white sm:block"
          >
            {{ t('nav.howItWorks') }}
          </NuxtLink>

          <div ref="langWrap" class="relative">
            <button
              type="button"
              class="flex items-center gap-1 text-sm text-zinc-500 transition hover:text-white"
              :aria-expanded="langOpen"
              aria-haspopup="listbox"
              @click="langOpen = !langOpen"
            >
              {{ currentLocaleName }}
              <svg
                class="h-3 w-3 transition-transform"
                :class="langOpen ? 'rotate-180' : ''"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2.5"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            <div
              v-if="langOpen"
              role="listbox"
              class="absolute right-0 mt-2 min-w-[4.5rem] overflow-hidden rounded-xl border border-white/10 bg-ink-900 py-1 shadow-xl shadow-black/50"
            >
              <button
                v-for="loc in locales"
                :key="(loc as any).code"
                type="button"
                role="option"
                :aria-selected="(loc as any).code === locale"
                class="block w-full px-4 py-2 text-left text-sm transition"
                :class="
                  (loc as any).code === locale
                    ? 'font-semibold text-brand-400'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-white'
                "
                @click="switchLang((loc as any).code)"
              >
                {{ (loc as any).name }}
              </button>
            </div>
          </div>

          <NuxtLink
            to="/#design-partner"
            class="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
          >
            {{ t('nav.cta') }}
          </NuxtLink>
        </nav>
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>

    <AppFooter />
  </div>
</template>
