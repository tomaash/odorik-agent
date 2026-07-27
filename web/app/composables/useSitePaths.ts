/**
 * Locale-aware paths.
 *
 * The site ships one static build per locale (DEFAULT_LOCALE), each mapped to
 * its own domain, so the locale never changes at runtime — but both locales'
 * routes exist in every build, and the nav has to point at the right ones.
 */
export function useSitePaths() {
  const { locale } = useI18n()
  const config = useRuntimeConfig()

  const isCs = computed(() => locale.value === 'cs')

  return {
    isCs,
    howItWorks: computed(() => (isCs.value ? '/jak-to-funguje' : '/how-it-works')),
    privacy: computed(() => (isCs.value ? '/soukromi' : '/privacy')),
    contactEmail: computed(() => config.public.contactEmail as string),
  }
}
