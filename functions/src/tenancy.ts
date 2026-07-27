import { FieldValue } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { db, jsonSafe } from "./firestore.js";

export const explorersCompanyId = "explorers";
export const companyIdPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export type TeamRole = "admin" | "member";

export type RegistrationStatus = {
  exists: boolean;
  enabled: boolean;
  admin: boolean;
  email: string;
  displayName: string;
  photoURL: string;
  companyId: string | null;
  teamName: string | null;
  role: TeamRole | null;
};

export function companyCollectionPath(companyId: string, collection: string): string {
  if (!companyIdPattern.test(companyId)) throw new Error("Invalid company ID");
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(collection)) {
    throw new Error("Invalid company collection");
  }
  return `companies/${companyId}/${collection}`;
}

export function companyDocumentPath(
  companyId: string,
  collection: string,
  documentId: string,
): string {
  if (!documentId || documentId.includes("/")) throw new Error("Invalid document ID");
  return `${companyCollectionPath(companyId, collection)}/${documentId}`;
}

export async function registrationStatus(uid: string): Promise<RegistrationStatus> {
  const user = await db.doc(`users/${uid}`).get();
  const userData = user.data() || {};
  const companyId = typeof userData.activeCompanyId === "string"
    ? userData.activeCompanyId
    : null;
  if (!user.exists || !companyId || !companyIdPattern.test(companyId)) {
    return {
      exists: user.exists,
      enabled: false,
      admin: false,
      email: String(userData.email || ""),
      displayName: String(userData.displayName || ""),
      photoURL: String(userData.photoURL || ""),
      companyId: null,
      teamName: null,
      role: null,
    };
  }

  const [company, membership] = await Promise.all([
    db.doc(`companies/${companyId}`).get(),
    db.doc(`companies/${companyId}/memberships/${uid}`).get(),
  ]);
  const membershipData = membership.data() || {};
  const role = membershipData.role === "admin" ? "admin" : "member";
  const enabled = membership.exists && membershipData.status === "active" && company.exists;
  return {
    exists: true,
    enabled,
    admin: enabled && role === "admin",
    email: String(userData.email || membershipData.email || ""),
    displayName: String(userData.displayName || membershipData.displayName || ""),
    photoURL: String(userData.photoURL || membershipData.photoURL || ""),
    companyId: enabled ? companyId : null,
    teamName: enabled ? String(company.data()?.displayName || companyId) : null,
    role: enabled ? role : null,
  };
}

export async function registerUser(input: {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
}): Promise<RegistrationStatus> {
  const userRef = db.doc(`users/${input.uid}`);
  const snapshot = await userRef.get();
  await userRef.set({
    email: input.email,
    emailNormalized: input.email.trim().toLocaleLowerCase(),
    displayName: input.displayName,
    photoURL: input.photoURL,
    ...(!snapshot.exists ? { registeredAt: FieldValue.serverTimestamp() } : {}),
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return registrationStatus(input.uid);
}

export async function requireTeamMembership(uid: string): Promise<{
  companyId: string;
  teamName: string;
  role: TeamRole;
  membership: Record<string, unknown>;
}> {
  const status = await registrationStatus(uid);
  if (!status.enabled || !status.companyId || !status.role || !status.teamName) {
    throw new TRPCError({ code: "FORBIDDEN", message: "PENDING_APPROVAL" });
  }
  const membership = await db.doc(
    `companies/${status.companyId}/memberships/${uid}`,
  ).get();
  return {
    companyId: status.companyId,
    teamName: status.teamName,
    role: status.role,
    membership: jsonSafe(membership.data() || {}) as Record<string, unknown>,
  };
}
