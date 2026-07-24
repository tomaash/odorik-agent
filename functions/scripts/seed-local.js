import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { Firestore } from '@google-cloud/firestore'

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'

const app = initializeApp({ projectId: 'odorik-tx-260720-c58d' })
const auth = getAuth(app)
const db = new Firestore({ projectId: 'odorik-tx-260720-c58d', databaseId: 'odorik' })

const emails = ['tomas.holas@gmail.com', 'jos.hercik@gmail.com']

for (const email of emails) {
  let user
  try {
    user = await auth.getUserByEmail(email)
  } catch {
    user = await auth.createUser({
      email,
      displayName: email.split('@')[0],
      emailVerified: true,
    })
  }

  await db.doc(`access/${user.uid}`).set(
    {
      email,
      displayName: email.split('@')[0],
      photoURL: '',
      enabled: true,
      admin: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { merge: true },
  )

  console.log(`✓ Seeded user ${email} (UID: ${user.uid}) as enabled admin in local Firestore & Auth`)
}
