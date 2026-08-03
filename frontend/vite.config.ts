import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// Production Hosting origin that rewrites /api and OAuth callbacks to Functions.
// Prefer the current app site; the legacy project-id site is still deployed.
const productionOrigin = 'https://agent-erik-app.web.app'
const emulatorFunctionsOrigin =
  'http://127.0.0.1:5001/odorik-tx-260720-c58d/europe-west3'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Shell-exported VITE_* (npm scripts) win over .env* files for this check:
  // process.env is merged first so dev:prod / dev:emulator are deterministic.
  const useEmulators =
    (process.env.VITE_USE_FIREBASE_EMULATORS ?? env.VITE_USE_FIREBASE_EMULATORS) === 'true'
  const defaultTarget = useEmulators ? emulatorFunctionsOrigin : productionOrigin
  const target = process.env.VITE_API_TARGET || env.VITE_API_TARGET || defaultTarget

  return {
    plugins: [vue()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/@firebase/') || id.includes('/node_modules/firebase/')) {
              return 'firebase'
            }
            if (
              id.includes('/node_modules/vue/')
              || id.includes('/node_modules/vue-router/')
              || id.includes('/node_modules/vue-i18n/')
              || id.includes('/node_modules/pinia/')
            ) {
              return 'vue'
            }
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
        '/oauth/google/callback': useEmulators
          ? {
              target,
              changeOrigin: true,
              rewrite: (path) => path.replace(
                /^\/oauth\/google\/callback/,
                '/googleOAuthCallback',
              ),
            }
          : {
              target: productionOrigin,
              changeOrigin: true,
            },
      },
    },
    test: {
      environment: 'happy-dom',
      globals: true,
    },
  }
})
