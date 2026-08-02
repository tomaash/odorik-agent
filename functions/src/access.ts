import { TRPCError } from "@trpc/server";

export type ResourceAudience =
  | { visibility: "company" }
  | { visibility: "restricted"; memberIds: string[] };

export const companyAudience: ResourceAudience = { visibility: "company" };

function uniqueMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
    .sort();
}

/** Existing source resources were company-visible before C4. */
export function normalizeResourceAudience(
  value: unknown,
  fallback: ResourceAudience = companyAudience,
): ResourceAudience {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  if (candidate.visibility === "company") return companyAudience;
  if (candidate.visibility === "restricted") {
    const memberIds = uniqueMemberIds(candidate.memberIds);
    return { visibility: "restricted", memberIds };
  }
  return fallback;
}

export function canMemberAccess(
  value: unknown,
  memberId: string,
  fallback: ResourceAudience = companyAudience,
): boolean {
  const audience = normalizeResourceAudience(value, fallback);
  return audience.visibility === "company" || audience.memberIds.includes(memberId);
}

export function canMemberAccessSourceData(
  data: Record<string, unknown> | FirebaseFirestore.DocumentData | undefined,
  memberId: string,
): boolean {
  if (!data || data.indexingEnabled === false || data.contextEnabled === false) return false;
  return canMemberAccess(data.access, memberId);
}

export function isAudienceBroadened(
  currentValue: unknown,
  nextValue: unknown,
): boolean {
  const current = normalizeResourceAudience(currentValue);
  const next = normalizeResourceAudience(nextValue);
  if (current.visibility === "company") return false;
  if (next.visibility === "company") return true;
  const currentIds = new Set(current.memberIds);
  return next.memberIds.some((memberId) => !currentIds.has(memberId));
}

export function audienceEquals(leftValue: unknown, rightValue: unknown): boolean {
  const left = normalizeResourceAudience(leftValue);
  const right = normalizeResourceAudience(rightValue);
  return left.visibility === right.visibility
    && (left.visibility === "company"
      || (
        right.visibility === "restricted"
        && left.memberIds.length === right.memberIds.length
        && left.memberIds.every((memberId, index) => memberId === right.memberIds[index])
      ));
}

export async function validatedResourceAudience(input: {
  companyId: string;
  audience: ResourceAudience;
  database: FirebaseFirestore.Firestore;
}): Promise<ResourceAudience> {
  const audience = normalizeResourceAudience(input.audience);
  if (audience.visibility === "company") return audience;
  if (audience.memberIds.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose at least one active company member.",
    });
  }
  const snapshots = await input.database.getAll(...audience.memberIds.map((memberId) => (
    input.database.doc(`companies/${input.companyId}/memberships/${memberId}`)
  )));
  if (snapshots.some((snapshot) => !snapshot.exists || snapshot.data()?.status !== "active")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The resource audience contains an inactive company member.",
    });
  }
  return audience;
}

export function accessForSourceRecord(
  _kind: string,
  data: Record<string, unknown>,
): ResourceAudience {
  return normalizeResourceAudience(data.access);
}
