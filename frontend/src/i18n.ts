import { createI18n } from 'vue-i18n'

const messages = {
  cs: {
    app: { name: 'Odorik CRM', inbox: 'Příchozí požadavky', signOut: 'Odhlásit' },
    login: {
      title: 'Hovory proměněné v práci',
      subtitle: 'Přihlaste se firemním Google účtem. Přístup musí být ručně povolen ve Firebase.',
      google: 'Přihlásit přes Google',
    },
    pending: {
      title: 'Čeká na povolení',
      description: 'Účet je vytvořený, ale zatím není povolený. Správce musí ve Firestore nastavit enabled na true.',
      refresh: 'Zkontrolovat přístup',
    },
    inbox: {
      title: 'Intake inbox',
      subtitle: 'Návrhy z telefonních hovorů čekající na kontrolu.',
      refresh: 'Obnovit',
      empty: 'Žádné hovory nečekají na kontrolu.',
      missing: 'chybějící údaje',
    },
  },
  en: {
    app: { name: 'Odorik CRM', inbox: 'Incoming requests', signOut: 'Sign out' },
    login: {
      title: 'Turn calls into work',
      subtitle: 'Sign in with Google. Access must be enabled manually in Firebase.',
      google: 'Continue with Google',
    },
    pending: {
      title: 'Waiting for access',
      description: 'Your account exists but is disabled. An administrator must set enabled to true in Firestore.',
      refresh: 'Check access',
    },
    inbox: {
      title: 'Intake inbox',
      subtitle: 'Proposals from phone calls waiting for review.',
      refresh: 'Refresh',
      empty: 'No calls are waiting for review.',
      missing: 'missing details',
    },
  },
}

export const i18n = createI18n({
  legacy: false,
  locale: localStorage.getItem('odorik-locale') || 'cs',
  fallbackLocale: 'en',
  messages,
})

export function setLocale(locale: string) {
  i18n.global.locale.value = locale as 'cs' | 'en'
  localStorage.setItem('odorik-locale', locale)
}
