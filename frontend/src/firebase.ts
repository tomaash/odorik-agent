import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { firebaseConfig } from './firebase.config'

// Firebase Auth sends `https://<authDomain>/__/auth/handler` to Google as the
// OAuth redirect_uri, so authDomain — not the site we are served from — decides
// which redirect URI must be registered on the OAuth client. Only the domain
// below is registered there, so every site pins it: agent-erik-app.web.app, the
// legacy site and any future custom domain all sign in through one handler, and
// adding a domain never needs a Google Cloud Console change. Serving the handler
// from each site instead would mean registering a redirect URI per domain —
// unregistered ones fail with Error 400 redirect_uri_mismatch.
const app = initializeApp({
  ...firebaseConfig,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfig.authDomain,
})
export const auth = getAuth(app)

if (import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099')
}
