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
    server: {
      proxy: {
        '/api': {
          target,
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

