import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { TRPCError } from "@trpc/server";
import { Resend } from "resend";
import { db, jsonSafe } from "./firestore.js";
import {
  digestInvitationSecret,
  formatInvitationToken,
  invitationSecretMatches,
  normalizeInvitationEmail,
  parseInvitationToken,
  type InvitationToken,
} from "./invitation-token.js";
import { registrationStatus, type TeamRole } from "./tenancy.js";

export const resendApiKey = defineSecret("RESEND_API_KEY");

const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maximumPendingInvitations = 20;
const productionAppOrigin = "https://odorik-tx-260720-c58d.web.app";

function timestampMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  return 0;
}

function publicInvitation(
  id: string,
  data: FirebaseFirestore.DocumentData,
): Record<string, unknown> {
  return jsonSafe({
    id,
    email: data.email || data.emailNormalized || "",
    status: data.status || "pending",
    invitedByName: data.invitedByName || "",
    createdAt: data.createdAt || null,
    expiresAt: data.expiresAt || null,
    deliveryStatus: data.deliveryStatus || "pending",
    deliveryError: data.deliveryStatus === "failed"
      ? String(data.deliveryError || "Email could not be sent")
      : null,
  }) as Record<string, unknown>;
}

async function sendInvitationEmail(input: {
  companyId: string;
  invitationId: string;
  teamName: string;
  email: string;
  inviterName: string;
  secret: string;
  tokenVersion: number;
}): Promise<{ deliveryStatus: "sent" | "failed"; resendEmailId: string | null; error: string | null }> {
  const token = formatInvitationToken(input);
  const origin = process.env.APP_ORIGIN?.trim() || productionAppOrigin;
  const invitationUrl = `${origin.replace(/\/$/, "")}/join?token=${encodeURIComponent(token)}`;
  const resend = new Resend(resendApiKey.value());
  try {
    const { data, error } = await resend.emails.send({
      from: "Agent Erik <hello@agenterik.cz>",
      to: input.email,
      subject: `Join ${input.teamName} on Agent Erik`,
      html: [
        "<p>Hello,</p>",
        `<p>${escapeHtml(input.inviterName)} invited you to join <strong>${escapeHtml(input.teamName)}</strong> on Agent Erik.</p>`,
        `<p><a href="${escapeHtml(invitationUrl)}">Review invitation</a></p>`,
        "<p>This invitation expires in seven days. Sign in with the Google account matching this email address.</p>",
      ].join(""),
      text: `${input.inviterName} invited you to join ${input.teamName} on Agent Erik.\n\n${invitationUrl}\n\nThis invitation expires in seven days.`,
    }, {
      idempotencyKey: `team-invite/${input.companyId}/${input.invitationId}/${input.tokenVersion}`,
    });
    if (error) throw new Error(error.message);
    return {
      deliveryStatus: "sent",
      resendEmailId: data?.id || null,
      error: null,
    };
  } catch (error) {
    return {
      deliveryStatus: "failed",
      resendEmailId: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function issueInvitation(input: {
  companyId: string;
  teamName: string;
  invitationRef: FirebaseFirestore.DocumentReference;
  email: string;
  inviterUid: string;
  inviterName: string;
  existingData?: FirebaseFirestore.DocumentData;
}): Promise<Record<string, unknown>> {
  const secret = randomBytes(32).toString("base64url");
  const tokenVersion = Number(input.existingData?.tokenVersion || 0) + 1;
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + invitationLifetimeMs);
  await input.invitationRef.set({
    companyId: input.companyId,
    email: input.email,
    emailNormalized: normalizeInvitationEmail(input.email),
    tokenHash: digestInvitationSecret(secret),
    tokenVersion,
    status: "pending",
    invitedBy: input.inviterUid,
    invitedByName: input.inviterName,
    createdAt: input.existingData?.createdAt || now,
    updatedAt: now,
    expiresAt,
    deliveryStatus: "pending",
    deliveryError: FieldValue.delete(),
    resendEmailId: FieldValue.delete(),
    acceptedAt: FieldValue.delete(),
    acceptedBy: FieldValue.delete(),
    revokedAt: FieldValue.delete(),
    revokedBy: FieldValue.delete(),
  }, { merge: true });

  const delivery = await sendInvitationEmail({
    companyId: input.companyId,
    invitationId: input.invitationRef.id,
    teamName: input.teamName,
    email: input.email,
    inviterName: input.inviterName,
    secret,
    tokenVersion,
  });
  await input.invitationRef.set({
    deliveryStatus: delivery.deliveryStatus,
    resendEmailId: delivery.resendEmailId,
    deliveryError: delivery.error,
    deliveryAttemptedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const updated = await input.invitationRef.get();
  return publicInvitation(updated.id, updated.data() || {});
}

export async function teamOverview(companyId: string): Promise<{
  team: Record<string, unknown>;
  members: Record<string, unknown>[];
  invitations: Record<string, unknown>[];
}> {
  const [company, memberships, invitations] = await Promise.all([
    db.doc(`companies/${companyId}`).get(),
    db.collection(`companies/${companyId}/memberships`).get(),
    db.collection(`companies/${companyId}/invitations`).limit(100).get(),
  ]);
  if (!company.exists) throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
  const members = memberships.docs
    .filter((document) => document.data().status === "active")
    .map((document) => jsonSafe({
      uid: document.id,
      email: document.data().email || "",
      displayName: document.data().displayName || "",
      photoURL: document.data().photoURL || "",
      role: document.data().role === "admin" ? "admin" : "member",
      joinedAt: document.data().joinedAt || null,
    }) as Record<string, unknown>)
    .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
  const pendingInvitations = invitations.docs
    .filter((document) => (
      document.data().status === "pending"
      && timestampMillis(document.data().expiresAt) > Date.now()
    ))
    .map((document) => publicInvitation(document.id, document.data()))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return {
    team: jsonSafe({
      id: company.id,
      displayName: company.data()?.displayName || company.id,
      createdAt: company.data()?.createdAt || null,
    }) as Record<string, unknown>,
    members,
    invitations: pendingInvitations,
  };
}

export async function createTeamInvitation(input: {
  companyId: string;
  teamName: string;
  email: string;
  inviterUid: string;
  inviterName: string;
}): Promise<Record<string, unknown>> {
  const emailNormalized = normalizeInvitationEmail(input.email);
  const [memberships, invitations] = await Promise.all([
    db.collection(`companies/${input.companyId}/memberships`)
      .where("emailNormalized", "==", emailNormalized)
      .limit(1)
      .get(),
    db.collection(`companies/${input.companyId}/invitations`).limit(100).get(),
  ]);
  if (memberships.docs.some((document) => document.data().status === "active")) {
    throw new TRPCError({ code: "CONFLICT", message: "ALREADY_TEAM_MEMBER" });
  }
  const pending = invitations.docs.filter((document) => (
    document.data().status === "pending"
    && timestampMillis(document.data().expiresAt) > Date.now()
  ));
  const existing = pending.find(
    (document) => document.data().emailNormalized === emailNormalized,
  );
  if (!existing && pending.length >= maximumPendingInvitations) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TOO_MANY_PENDING_INVITATIONS" });
  }
  const invitationRef = existing?.ref
    || db.collection(`companies/${input.companyId}/invitations`).doc();
  return issueInvitation({
    ...input,
    email: emailNormalized,
    invitationRef,
    existingData: existing?.data(),
  });
}

export async function resendTeamInvitation(input: {
  companyId: string;
  teamName: string;
  invitationId: string;
  inviterUid: string;
  inviterName: string;
}): Promise<Record<string, unknown>> {
  const invitationRef = db.doc(
    `companies/${input.companyId}/invitations/${input.invitationId}`,
  );
  const invitation = await invitationRef.get();
  if (!invitation.exists || invitation.data()?.status !== "pending") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
  }
  return issueInvitation({
    ...input,
    invitationRef,
    email: String(invitation.data()?.emailNormalized || invitation.data()?.email || ""),
    existingData: invitation.data(),
  });
}

export async function revokeTeamInvitation(input: {
  companyId: string;
  invitationId: string;
  actorUid: string;
}): Promise<{ ok: true }> {
  const invitationRef = db.doc(
    `companies/${input.companyId}/invitations/${input.invitationId}`,
  );
  const invitation = await invitationRef.get();
  if (!invitation.exists || invitation.data()?.status !== "pending") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
  }
  await invitationRef.set({
    status: "revoked",
    tokenHash: FieldValue.delete(),
    revokedBy: input.actorUid,
    revokedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
}

function verifiedInvitation(
  token: string,
  email: string,
  emailVerified: boolean,
): Promise<{
  parsed: InvitationToken;
  invitation: FirebaseFirestore.DocumentSnapshot;
  company: FirebaseFirestore.DocumentSnapshot;
}> {
  if (!emailVerified || !email) {
    throw new TRPCError({ code: "FORBIDDEN", message: "VERIFIED_EMAIL_REQUIRED" });
  }
  const parsed = parseInvitationToken(token);
  if (!parsed) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_INVITATION" });
  }
  return Promise.all([
    db.doc(`companies/${parsed.companyId}/invitations/${parsed.invitationId}`).get(),
    db.doc(`companies/${parsed.companyId}`).get(),
  ]).then(([invitation, company]) => {
    const data = invitation.data() || {};
    if (
      !invitation.exists
      || !company.exists
      || data.status !== "pending"
      || timestampMillis(data.expiresAt) <= Date.now()
      || normalizeInvitationEmail(String(data.emailNormalized || data.email || ""))
        !== normalizeInvitationEmail(email)
      || typeof data.tokenHash !== "string"
      || !invitationSecretMatches(data.tokenHash, parsed.secret)
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "INVALID_INVITATION" });
    }
    return { parsed, invitation, company };
  });
}

export async function inspectTeamInvitation(input: {
  token: string;
  email: string;
  emailVerified: boolean;
}): Promise<Record<string, unknown>> {
  const { invitation, company } = await verifiedInvitation(
    input.token,
    input.email,
    input.emailVerified,
  );
  return jsonSafe({
    teamId: company.id,
    teamName: company.data()?.displayName || company.id,
    invitedByName: invitation.data()?.invitedByName || "",
    expiresAt: invitation.data()?.expiresAt || null,
    email: invitation.data()?.email || invitation.data()?.emailNormalized || "",
  }) as Record<string, unknown>;
}

export async function acceptTeamInvitation(input: {
  token: string;
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  photoURL: string;
}): Promise<Awaited<ReturnType<typeof registrationStatus>>> {
  const verified = await verifiedInvitation(
    input.token,
    input.email,
    input.emailVerified,
  );
  const { parsed } = verified;
  const userRef = db.doc(`users/${input.uid}`);
  const membershipRef = db.doc(
    `companies/${parsed.companyId}/memberships/${input.uid}`,
  );
  const invitationRef = verified.invitation.ref;
  const eventRef = db.collection(`companies/${parsed.companyId}/auditEvents`).doc();
  await db.runTransaction(async (transaction) => {
    const [user, invitation, membership] = await Promise.all([
      transaction.get(userRef),
      transaction.get(invitationRef),
      transaction.get(membershipRef),
    ]);
    const invitationData = invitation.data() || {};
    const activeCompanyId = user.data()?.activeCompanyId;
    if (activeCompanyId && activeCompanyId !== parsed.companyId) {
      throw new TRPCError({ code: "CONFLICT", message: "ALREADY_ON_ANOTHER_TEAM" });
    }
    if (
      !invitation.exists
      || invitationData.status !== "pending"
      || timestampMillis(invitationData.expiresAt) <= Date.now()
      || normalizeInvitationEmail(String(invitationData.emailNormalized || invitationData.email || ""))
        !== normalizeInvitationEmail(input.email)
      || typeof invitationData.tokenHash !== "string"
      || !invitationSecretMatches(invitationData.tokenHash, parsed.secret)
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "INVALID_INVITATION" });
    }
    const now = Timestamp.now();
    transaction.set(userRef, {
      email: input.email,
      emailNormalized: normalizeInvitationEmail(input.email),
      displayName: input.displayName,
      photoURL: input.photoURL,
      activeCompanyId: parsed.companyId,
      updatedAt: now,
    }, { merge: true });
    transaction.set(membershipRef, {
      uid: input.uid,
      email: input.email,
      emailNormalized: normalizeInvitationEmail(input.email),
      displayName: input.displayName,
      photoURL: input.photoURL,
      role: (membership.data()?.role === "admin" ? "admin" : "member") satisfies TeamRole,
      status: "active",
      invitedBy: invitationData.invitedBy || null,
      joinedAt: membership.data()?.joinedAt || now,
      updatedAt: now,
    }, { merge: true });
    transaction.set(invitationRef, {
      status: "accepted",
      tokenHash: FieldValue.delete(),
      acceptedBy: input.uid,
      acceptedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.set(eventRef, {
      type: "team.member_joined",
      actor: { kind: "user", id: input.uid },
      after: { uid: input.uid, email: input.email, role: "member" },
      createdAt: now,
    });
  });
  return registrationStatus(input.uid);
}

export async function removeTeamMember(input: {
  companyId: string;
  targetUid: string;
  actorUid: string;
}): Promise<{ ok: true }> {
  if (input.targetUid === input.actorUid) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "CANNOT_REMOVE_YOURSELF" });
  }
  const membershipRef = db.doc(
    `companies/${input.companyId}/memberships/${input.targetUid}`,
  );
  const userRef = db.doc(`users/${input.targetUid}`);
  await db.runTransaction(async (transaction) => {
    const membership = await transaction.get(membershipRef);
    if (!membership.exists || membership.data()?.status !== "active") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Team member not found" });
    }
    if (membership.data()?.role === "admin") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "CANNOT_REMOVE_ADMIN" });
    }
    const now = Timestamp.now();
    transaction.set(membershipRef, {
      status: "removed",
      removedBy: input.actorUid,
      removedAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.set(userRef, {
      activeCompanyId: FieldValue.delete(),
      updatedAt: now,
    }, { merge: true });
    transaction.set(db.collection(`companies/${input.companyId}/auditEvents`).doc(), {
      type: "team.member_removed",
      actor: { kind: "user", id: input.actorUid },
      before: {
        uid: input.targetUid,
        email: membership.data()?.email || null,
        role: membership.data()?.role || "member",
      },
      createdAt: now,
    });
  });
  return { ok: true };
}
