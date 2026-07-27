// https://nuxt.com/docs/api/configuration/nuxt-config
// Locale is baked in at build time — one build per domain, same as appheadstart/web.
const locale = process.env.DEFAULT_LOCALE || 'en'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/i18n', '@nuxt/image'],
  app: {
    head: {
      htmlAttrs: { lang: locale === 'cs' ? 'cs' : 'en' },
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
        },
      ],
    },
  },
  // Without this the module injects its own stylesheet and silently ignores
  // ours, dropping every @layer base/components rule.
  tailwindcss: {
    cssPath: '~/assets/css/tailwind.css',
  },
  image: {
    dir: 'source-images',
    format: ['webp'],
    quality: 80,
  },
  i18n: {
    locales: [
      { code: 'cs', name: 'CZ', file: 'cs.json' },
      { code: 'en', name: 'EN', file: 'en.json' },
    ],
    defaultLocale: locale,
    strategy: 'no_prefix',
    langDir: 'locales',
    // Each domain serves one locale, baked in at build time. Browser detection
    // would override that and serve Czech copy on the .com domain.
    detectBrowserLanguage: false,
  },
  runtimeConfig: {
    public: {
      buildLocale: locale,
      // Empty until the design-partner endpoint exists; the form falls back to
      // a prefilled mail draft while this is unset. See web/README.md.
      partnerFormUrl: '',
      contactEmail: 'hello@agenterik.com',
      siteHostCs: 'agenterik.cz',
      siteHostEn: 'agenterik.com',
    },
  },
  nitro: {
    preset: 'static',
    output: { dir: `.output-${locale}` },
    prerender: {
      routes: ['/how-it-works', '/jak-to-funguje', '/privacy', '/soukromi'],
      failOnError: true,
    },
  },
})
