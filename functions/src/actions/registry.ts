import type { ZodType } from "zod";
import type { WorkflowActionSource } from "./contracts.js";
import type { ResourceAudience } from "../access.js";
import { internalActionDescriptors } from "./internal-actions.js";
import { codingActionDescriptors } from "../coding/action.js";

export type RegisteredAction = {
  kind: string;
};

export type ActionScope = {
  contactId: string | null;
  callId: string | null;
  caseId: string | null;
  issueContextItemId?: string | null;
};

export type ActionResultReference = {
  kind: string;
  id: string;
};

export type ActionFailureStatus =
  | "failed_safe_to_retry"
  | "outcome_unknown";

export type ActionPreparationContext = {
  companyId: string;
  actorUid: string;
  database: FirebaseFirestore.Firestore;
  resolveActiveMember: (
    companyId: string,
    uid: string,
  ) => Promise<{ uid: string; displayName: string; email: string }>;
};

export type ActionPreconditionContext = {
  companyId: string;
  database: FirebaseFirestore.Firestore;
  transaction: FirebaseFirestore.Transaction;
};

export type ApprovedActionExecutionContext = {
  companyId: string;
  actorUid: string;
  approvalId: string;
  approvedBy: string;
  attemptId: string;
  source: WorkflowActionSource;
  access?: ResourceAudience;
};

export type ActionDescriptor<
  TAction extends RegisteredAction = RegisteredAction,
  TResult = unknown,
> = {
  kind: TAction["kind"];
  capabilityId: string;
  contractVersion: 1;
  category: "company.write" | "external.write";
  inputSchema: ZodType<TAction>;
  resultSchema: ZodType<TResult>;
  authorization: {
    requiresApproval: true;
    providerCapabilityId?: string;
  };
  reversibility: "compensatable" | "irreversible";
  idempotency: "deterministic_internal" | "provider_aware";
  reconciliation: "deterministic_lookup" | "required_before_retry";
  prepareForApproval: (
    context: ActionPreparationContext,
    action: TAction,
  ) => Promise<TAction>;
  assertRequestPreconditions: (
    context: ActionPreconditionContext,
    action: TAction,
  ) => Promise<void>;
  scope: (action: TAction) => ActionScope;
  execute: (
    context: ApprovedActionExecutionContext,
    action: TAction,
  ) => Promise<TResult>;
  resultId: (action: TAction, result: TResult) => string;
  resultReference: (
    action: TAction,
    result: TResult,
  ) => ActionResultReference;
  classifyFailure: (
    error: unknown,
    phase: "validation" | "execution",
  ) => ActionFailureStatus;
};

// Descriptors are heterogeneous after registration; their schemas restore the
// specific action/result types at every lookup boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDescriptor = ActionDescriptor<any, any>;

export type ResolvedAction = {
  descriptor: AnyActionDescriptor;
  action: RegisteredAction;
};

export type ActionRegistry = {
  descriptors(): readonly AnyActionDescriptor[];
  lookup(kind: string): AnyActionDescriptor;
  resolve(value: unknown): ResolvedAction;
};

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function createActionRegistry(
  descriptors: readonly AnyActionDescriptor[],
): ActionRegistry {
  const byKind = new Map<string, AnyActionDescriptor>();
  const capabilityIds = new Set<string>();
  for (const descriptor of descriptors) {
    const kind = requiredText(descriptor.kind, "Action kind");
    const capabilityId = requiredText(
      descriptor.capabilityId,
      `Capability ID for ${kind}`,
    );
    if (byKind.has(kind)) {
      throw new Error(`Duplicate action kind: ${kind}`);
    }
    if (capabilityIds.has(capabilityId)) {
      throw new Error(`Duplicate action capability: ${capabilityId}`);
    }
    if (descriptor.authorization?.requiresApproval !== true) {
      throw new Error(`Action ${kind} must require approval`);
    }
    if (
      descriptor.category === "external.write"
      && (
        !descriptor.authorization.providerCapabilityId
        || descriptor.idempotency !== "provider_aware"
        || descriptor.reconciliation !== "required_before_retry"
      )
    ) {
      throw new Error(
        `External action ${kind} must declare its provider capability, `
        + "provider-aware idempotency, and reconciliation",
      );
    }
    byKind.set(kind, Object.freeze(descriptor));
    capabilityIds.add(capabilityId);
  }
  const values = Object.freeze([...byKind.values()]);
  return Object.freeze({
    descriptors: () => values,
    lookup(kind: string) {
      const descriptor = byKind.get(kind);
      if (!descriptor) throw new Error(`Unregistered action kind: ${kind}`);
      return descriptor;
    },
    resolve(value: unknown) {
      if (!value || typeof value !== "object") {
        throw new Error("An action object is required");
      }
      const kind = requiredText(
        (value as { kind?: unknown }).kind,
        "Action kind",
      );
      const descriptor = byKind.get(kind);
      if (!descriptor) throw new Error(`Unregistered action kind: ${kind}`);
      return {
        descriptor,
        action: descriptor.inputSchema.parse(value),
      };
    },
  });
}

function assertApprovedExecution(
  context: ApprovedActionExecutionContext,
): void {
  requiredText(context.companyId, "Company ID");
  requiredText(context.actorUid, "Execution actor");
  requiredText(context.approvalId, "Approval ID");
  requiredText(context.approvedBy, "Named approver");
  requiredText(context.attemptId, "Execution attempt ID");
  if (!context.source || context.source.kind !== "workflow") {
    throw new Error("Immutable workflow provenance is required");
  }
}

export async function executeRegisteredAction(input: {
  registry: ActionRegistry;
  action: unknown;
  context: ApprovedActionExecutionContext;
}) {
  assertApprovedExecution(input.context);
  const resolved = input.registry.resolve(input.action);
  const rawResult = await resolved.descriptor.execute(
    input.context,
    resolved.action,
  );
  const executionResult = resolved.descriptor.resultSchema.parse(rawResult);
  return {
    descriptor: resolved.descriptor,
    action: resolved.action,
    resultId: resolved.descriptor.resultId(
      resolved.action,
      executionResult,
    ),
    result: resolved.descriptor.resultReference(
      resolved.action,
      executionResult,
    ),
    executionResult,
  };
}

export const actionRegistry = createActionRegistry(
  [...internalActionDescriptors, ...codingActionDescriptors],
);
