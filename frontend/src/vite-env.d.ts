/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When "true" in DEV, connect Firebase Auth to the local Auth emulator. */
  readonly VITE_USE_FIREBASE_EMULATORS?: string
  /** Override the Vite /api proxy target (emulator Functions or Hosting origin). */
  readonly VITE_API_TARGET?: string
  /** Override the browser tRPC base URL (default: "/api" via Vite proxy). */
  readonly VITE_API_URL?: string
  /** Pins the Firebase Auth handler domain when the serving host cannot host it. */
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
