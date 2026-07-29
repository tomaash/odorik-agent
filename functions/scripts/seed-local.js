/**
 * Bootstrap local Auth + multi-tenant access for emulator development.
 *
 * The app no longer reads legacy `access/{uid}`. Enabled status requires:
 *   users/{uid}.activeCompanyId
 *   companies/{companyId} (exists)
 *   companies/{companyId}/memberships/{uid} with status "active"
 *
 * Run while emulators are up (`npm run dev`), after at least one Google
 * sign-in if you want the seed UID to match the browser session. Re-run
 * after sign-in is safe and updates membership for the current Auth user.
 */
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore'

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'

const projectId = 'odorik-tx-260720-c58d'
const companyId = 'explorers'
const companyName = 'Explorers'

const app = initializeApp({ projectId })
const auth = getAuth(app)
const db = new Firestore({ projectId, databaseId: 'odorik' })

/** @type {Array<{ email: string, displayName: string, role: 'admin' | 'member' }>} */
const members = [
  {
    email: 'tomas.holas@gmail.com',
    displayName: 'Tomáš Holas',
    role: 'admin',
  },
  {
    email: 'jos.hercik@gmail.com',
    displayName: 'Josef Herčík',
    role: 'member',
  },
  {
    email: 'stefanikova.katka@gmail.com',
    displayName: 'Katarína Štefániková',
    role: 'member',
  },
]

const now = Timestamp.now()

await db.doc(`companies/${companyId}`).set(
  {
    displayName: companyName,
    status: 'active',
    createdAt: now,
    updatedAt: FieldValue.serverTimestamp(),
  },
  { merge: true },
)
console.log(`✓ Company ${companyId} (${companyName})`)

/**
 * Resolve every Auth user whose email matches (case-insensitive).
 * Google sign-in on the emulator often creates a different UID than
 * admin.createUser for the same email; membership must use the browser UID.
 */
async function resolveAuthUsers(email) {
  const normalized = email.trim().toLocaleLowerCase()
  const found = []

  try {
    found.push(await auth.getUserByEmail(email))
  } catch {
    // create below if none
  }

  // Emulator can hold multiple accounts with the same email across providers.
  // Walk the full list so a Google-signed-in session is never left pending.
  const listed = await auth.listUsers(1000)
  for (const user of listed.users) {
    if ((user.email || '').trim().toLocaleLowerCase() !== normalized) continue
    if (!found.some((existing) => existing.uid === user.uid)) found.push(user)
  }

  if (found.length === 0) {
    const created = await auth.createUser({
      email,
      displayName: email.split('@')[0],
      emailVerified: true,
    })
    found.push(created)
    console.log(`  created Auth user ${email} → ${created.uid}`)
  }

  return found
}

for (const member of members) {
  const users = await resolveAuthUsers(member.email)
  for (const user of users) {
    const displayName = user.displayName || member.displayName
    const photoURL = user.photoURL || ''
    const emailNormalized = member.email.trim().toLocaleLowerCase()

    await db.doc(`users/${user.uid}`).set(
      {
        email: member.email,
        emailNormalized,
        displayName,
        photoURL,
        activeCompanyId: companyId,
        registeredAt: now,
        lastSeenAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    await db.doc(`companies/${companyId}/memberships/${user.uid}`).set(
      {
        uid: user.uid,
        email: member.email,
        emailNormalized,
        displayName,
        photoURL,
        role: member.role,
        status: 'active',
        joinedAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    // Keep legacy access docs in sync for any leftover tooling.
    await db.doc(`access/${user.uid}`).set(
      {
        email: member.email,
        displayName,
        photoURL,
        enabled: true,
        admin: member.role === 'admin',
        createdAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    console.log(
      `✓ ${member.email} uid=${user.uid} role=${member.role} → ${companyId}`,
    )
  }
}

console.log('')
console.log('Refresh the app (or click “Zkontrolovat znovu” on /pending).')
console.log('If still pending, sign out, sign in, then re-run: npm run seed:local')
