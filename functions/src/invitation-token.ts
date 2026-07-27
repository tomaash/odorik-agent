import { createHash, timingSafeEqual } from "node:crypto";
import { companyIdPattern } from "./tenancy.js";

export type InvitationToken = {
  companyId: string;
  invitationId: string;
  secret: string;
};

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

export function digestInvitationSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function invitationSecretMatches(digest: string, secret: string): boolean {
  const actual = Buffer.from(digest, "hex");
  const expected = Buffer.from(digestInvitationSecret(secret), "hex");
  return actual.length === expected.length
    && actual.length > 0
    && timingSafeEqual(actual, expected);
}

export function formatInvitationToken(input: InvitationToken): string {
  return `${input.companyId}.${input.invitationId}.${input.secret}`;
}

export function parseInvitationToken(value: string): InvitationToken | null {
  const [companyId, invitationId, secret, ...rest] = value.split(".");
  if (
    rest.length
    || !companyId
    || !companyIdPattern.test(companyId)
    || !invitationId
    || !/^[a-zA-Z0-9]{10,40}$/.test(invitationId)
    || !secret
    || !/^[a-zA-Z0-9_-]{40,60}$/.test(secret)
  ) return null;
  return { companyId, invitationId, secret };
}
