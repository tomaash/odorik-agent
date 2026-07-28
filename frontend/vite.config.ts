import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const useEmulators = env.VITE_USE_FIREBASE_EMULATORS === 'true'
  const defaultTarget = useEmulators
    ? 'http://127.0.0.1:5001/odorik-tx-260720-c58d/europe-west3'
    : 'https://odorik-tx-260720-c58d.web.app'
  const target = env.VITE_API_TARGET || defaultTarget

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
              target: 'https://odorik-tx-260720-c58d.web.app',
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
