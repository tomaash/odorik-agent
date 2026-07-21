export const requestStatusValues = [
  "new",
  "in_progress",
  "waiting_customer",
  "completed",
  "cancelled",
] as const;

export type RequestStatus = typeof requestStatusValues[number];

export const openRequestStatuses: RequestStatus[] = ["new", "in_progress", "waiting_customer"];

const transitions: Record<RequestStatus, RequestStatus[]> = {
  new: ["in_progress", "waiting_customer", "cancelled"],
  in_progress: ["waiting_customer", "completed", "cancelled"],
  waiting_customer: ["in_progress", "completed", "cancelled"],
  completed: ["in_progress"],
  cancelled: ["new"],
};

export function normalizeRequestStatus(value: unknown): RequestStatus | null {
  if (value === "open") return "new";
  return requestStatusValues.includes(value as RequestStatus) ? value as RequestStatus : null;
}

export function canTransitionRequestStatus(from: RequestStatus, to: RequestStatus): boolean {
  return transitions[from].includes(to);
}

export function allowedRequestTransitions(from: RequestStatus): RequestStatus[] {
  return [...transitions[from]];
}

export function storedStatusesFor(statuses: RequestStatus[]): string[] {
  const stored = new Set<string>(statuses);
  if (stored.has("new")) stored.add("open");
  return [...stored];
}
