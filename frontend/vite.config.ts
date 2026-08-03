import dns from 'node:dns'
import https from 'node:https'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// Prefer IPv4 for outbound proxy hops. Many local networks advertise AAAA for
// Firebase Hosting but cannot reach IPv6; Node's dual-stack connect then
// surfaces AggregateError [ETIMEDOUT] on /api via the Vite proxy.
dns.setDefaultResultOrder('ipv4first')

// Production Hosting origin that rewrites /api and OAuth callbacks to Functions.
// Prefer the current app site; the legacy project-id site is still deployed.
const productionOrigin = 'https://agent-erik-app.web.app'
const emulatorFunctionsOrigin =
  'http://127.0.0.1:5001/odorik-tx-260720-c58d/europe-west3'

/** Force IPv4 for HTTPS proxy targets (http-proxy ignores dns result order alone). */
const ipv4HttpsAgent = new https.Agent({ family: 4, keepAlive: true })

function proxyTo(target: string) {
  return {
    target,
    changeOrigin: true as const,
    ...(target.startsWith('https:') ? { agent: ipv4HttpsAgent } : {}),
  }
}

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
        '/api': proxyTo(target),
        '/oauth/google/callback': useEmulators
          ? {
              ...proxyTo(target),
              rewrite: (path: string) => path.replace(
                /^\/oauth\/google\/callback/,
                '/googleOAuthCallback',
              ),
            }
          : proxyTo(productionOrigin),
      },
    },
    test: {
      environment: 'happy-dom',
      globals: true,
    },
  }
})
