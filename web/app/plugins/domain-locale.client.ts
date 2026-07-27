export default defineNuxtPlugin((nuxtApp) => {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname.toLowerCase()
    const i18n = nuxtApp.$i18n as any
    if (hostname.endsWith('.cz') && i18n) {
      const currentLocale = typeof i18n.locale === 'object' ? i18n.locale.value : i18n.locale
      if (currentLocale !== 'cs' && typeof i18n.setLocale === 'function') {
        i18n.setLocale('cs')
      }
    }
  }
})
