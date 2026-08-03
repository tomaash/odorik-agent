import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import ToastService from 'primevue/toastservice'
import Tooltip from 'primevue/tooltip'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { ErikPreset } from './theme'
import '@fontsource/ibm-plex-sans/latin-ext-400.css'
import '@fontsource/ibm-plex-sans/latin-ext-500.css'
import '@fontsource/ibm-plex-sans/latin-ext-600.css'
import '@fontsource/ibm-plex-sans/latin-ext-700.css'
import '@fontsource/ibm-plex-mono/latin-ext-400.css'
import '@fontsource/ibm-plex-mono/latin-ext-500.css'
import 'primeicons/primeicons.css'
import './index.css'
import { clearStaleChunkReloadGuard, recoverFromStaleChunkError } from './chunk-load-recovery'

clearStaleChunkReloadGuard()

// Vite fires this when a preloaded lazy chunk 404s after a deploy (hashed filename gone).
window.addEventListener('vite:preloadError', (event) => {
  const error = 'payload' in event ? (event as Event & { payload?: unknown }).payload : event
  if (recoverFromStaleChunkError(error ?? event)) {
    event.preventDefault()
  }
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
app.use(PrimeVue, {
  theme: {
    preset: ErikPreset,
    options: {
      darkModeSelector: '.dark-mode',
      cssLayer: { name: 'primevue', order: 'tailwind-base, primevue, tailwind-utilities' },
    },
  },
})
app.use(ConfirmationService)
app.use(ToastService)
app.directive('tooltip', Tooltip)
app.mount('#app')
