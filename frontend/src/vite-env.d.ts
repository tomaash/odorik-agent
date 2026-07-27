/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_FIREBASE_EMULATORS?: string
  // Pins the Firebase Auth handler domain when the serving host cannot host it.
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
