export type CallTranscribedTriggerBlock = {
  id: string;
  kind: "event.call.transcribed";
};

export type TaskRecipe = {
  title: string;
  instructions?: string;
  assigneeUid: string;
  assigneeName: string;
  dueAfterDays?: number | null;
  // Older schema-v4 task blocks did not declare a subject. An absent subject
  // retains their deployed behavior: keep the source call and link a resolved
  // contact when one exists. Newly created blocks always set this explicitly.
  subject?: TaskSubject;
};

export type TaskSubject =
  | { kind: "internal" }
  | { kind: "contact" }
  | {
      kind: "matching_case";
      pipelineId: "default";
      stageId: string;
      stageName: string;
    };

export type RequiredApproval = {
  kind: "required";
  approverUid: string;
  approverName: string;
};

export type CreateTaskBlock = {
  id: string;
  kind: "action.task.create";
  task: TaskRecipe;
  approval: RequiredApproval;
};

export type CaseRecipe = {
  title: string;
  pipelineId: string;
  stageId: string;
  stageName: string;
  ownerUid: string;
  ownerName: string;
};

export type CreateCaseBlock = {
  id: string;
  kind: "action.case.create";
  case: CaseRecipe;
  approval: RequiredApproval;
};

export type MoveCaseRecipe = {
  pipelineId: string;
  fromStageId: string;
  fromStageName: string;
  toStageId: string;
  toStageName: string;
};

export type MoveCaseBlock = {
  id: string;
  kind: "action.case.move";
  case: MoveCaseRecipe;
  approval: RequiredApproval;
};

// Where the draft is addressed. A literal address is authored into the block and
// always resolves; a contact address is only known once someone has recorded one
// against the caller, so it fails closed rather than guessing.
export type MailRecipientSource =
  | { kind: "literal"; email: string }
  | { kind: "contact" };

export type MailDraftRecipe = {
  connectionId: string;
  recipient: MailRecipientSource;
  // Rendered with the same token substitution as a task title. Deliberately not
  // model-generated: the block language admits typed, executable recipes only.
  subject: string;
  body: string;
};

export type MailDraftCreateBlock = {
  id: string;
  kind: "action.mail.draft.create";
  mail: MailDraftRecipe;
  approval: RequiredApproval;
};

export type ActionBlock =
  | CreateTaskBlock
  | CreateCaseBlock
  | MoveCaseBlock
  | MailDraftCreateBlock;

export type ConditionField =
  | "call.durationSeconds"
  | "caller.hasContact"
  | "transcript.text";

export type ConditionOperator =
  | "eq"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export type WorkflowCondition = {
  field: ConditionField;
  operator: ConditionOperator;
  value: string | number | boolean;
};

export type IfBlock = {
  id: string;
  kind: "control.if";
  condition: WorkflowCondition;
  then: ActionBlock[];
  else: ActionBlock[];
};

// This union is deliberately small. New block kinds belong here only after
// their normal product behavior and runtime semantics exist.
export type WorkflowBlock = ActionBlock | IfBlock;

export type WorkflowSpec = {
  schemaVersion: 4;
  name: string;
  trigger: CallTranscribedTriggerBlock;
  blocks: WorkflowBlock[];
};

type Schema3TaskBlock = Omit<CreateTaskBlock, "approval">;

type Schema3IfBlock = Omit<IfBlock, "then" | "else"> & {
  then: Schema3TaskBlock[];
  else: Schema3TaskBlock[];
};

type Schema3Workflow = {
  schemaVersion: 3;
  name: string;
  trigger: CallTranscribedTriggerBlock;
  blocks: Array<Schema3TaskBlock | Schema3IfBlock>;
};

type Schema2Workflow = {
  schemaVersion: 2;
  name: string;
  trigger: { kind: "call.transcribed" };
  task: TaskRecipe;
};

export type SpecIssue = {
  code: string;
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: SpecIssue[];
  holes: SpecIssue[];
};

export type CallTaskContext = {
  callerName?: string | null;
  callerPhone?: string | null;
  callSummary?: string | null;
  transcriptExcerpt?: string | null;
  callDurationSeconds?: number | null;
  callerHasContact?: boolean;
  transcriptText?: string | null;
  cases?: CaseContext[];
  // Resolved by the caller (see resolveCall) so that preview stays pure and a
  // history dry run reports the same skips a real run would produce.
  contactEmail?: string | null;
  mailConnections?: MailConnectionContext[];
};

export type MailConnectionContext = {
  connectionId: string;
  address: string;
  providerAccountId: string;
  active: boolean;
};

export type CaseContext = {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  stageName: string;
  revision: number;
};

export type TaskRecipePreview = {
  kind: "task.create";
  blockId: string;
  title: string;
  instructions: string | null;
  assigneeUid: string;
  assigneeName: string;
  approverUid: string;
  approverName: string;
  dueAt: string | null;
  subject: TaskSubject | null;
  caseId: string | null;
  caseTitle: string | null;
  context: CallTaskContext;
};

export type CreateCasePreview = {
  kind: "case.create";
  blockId: string;
  title: string;
  pipelineId: string;
  stageId: string;
  stageName: string;
  ownerUid: string;
  ownerName: string;
  approverUid: string;
  approverName: string;
  context: CallTaskContext;
};

export type MoveCasePreview = {
  kind: "case.move";
  blockId: string;
  caseId: string;
  caseTitle: string;
  pipelineId: string;
  fromStageId: string;
  fromStageName: string;
  toStageId: string;
  toStageName: string;
  expectedRevision: number;
  approverUid: string;
  approverName: string;
  context: CallTaskContext;
};

export type MailDraftPreview = {
  kind: "mail.draft.create";
  blockId: string;
  connectionId: string;
  mailboxAddress: string;
  providerAccountId: string;
  to: string[];
  subject: string;
  body: string;
  approverUid: string;
  approverName: string;
  context: CallTaskContext;
};

export type ActionPreview =
  | TaskRecipePreview
  | CreateCasePreview
  | MoveCasePreview
  | MailDraftPreview;

export type ActionSkipReason =
  | "contact_required"
  | "no_matching_case"
  | "ambiguous_case"
  | "target_unavailable"
  | "recipient_missing"
  | "mailbox_unavailable"
  | "insufficient_context";

export type ActionSkip = {
  blockId: string;
  kind: ActionBlock["kind"];
  reason: ActionSkipReason;
  matches: number;
};

export type ConditionTrace = {
  blockId: string;
  field: ConditionField;
  operator: ConditionOperator;
  expected: string | number | boolean;
  actual: string | number | boolean | null;
  result: boolean;
  branch: "then" | "else";
};

export type WorkflowPreview = {
  actions: ActionPreview[];
  skippedActions: ActionSkip[];
  conditions: ConditionTrace[];
};

function nextBlockId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createTaskBlock(input: {
  assigneeUid: string;
  assigneeName: string;
  id?: string;
  title?: string;
}): CreateTaskBlock {
  return {
    id: input.id || nextBlockId("task"),
    kind: "action.task.create",
    task: {
      title: input.title || "Follow up after call with {caller.name}",
      instructions: "Review the call and complete any promised follow-up outside Agent Erik.",
      assigneeUid: input.assigneeUid,
      assigneeName: input.assigneeName,
      dueAfterDays: 1,
      subject: { kind: "contact" },
    },
    approval: {
      kind: "required",
      approverUid: input.assigneeUid,
      approverName: input.assigneeName,
    },
  };
}

export function createCaseBlock(input: {
  ownerUid: string;
  ownerName: string;
  pipelineId: string;
  stageId: string;
  stageName: string;
  id?: string;
  title?: string;
}): CreateCaseBlock {
  return {
    id: input.id || nextBlockId("case_create"),
    kind: "action.case.create",
    case: {
      title: input.title || "Follow up with {caller.name}",
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      stageName: input.stageName,
      ownerUid: input.ownerUid,
      ownerName: input.ownerName,
    },
    approval: {
      kind: "required",
      approverUid: input.ownerUid,
      approverName: input.ownerName,
    },
  };
}

export function createMoveCaseBlock(input: {
  approverUid: string;
  approverName: string;
  pipelineId: string;
  fromStageId: string;
  fromStageName: string;
  toStageId: string;
  toStageName: string;
  id?: string;
}): MoveCaseBlock {
  return {
    id: input.id || nextBlockId("case_move"),
    kind: "action.case.move",
    case: {
      pipelineId: input.pipelineId,
      fromStageId: input.fromStageId,
      fromStageName: input.fromStageName,
      toStageId: input.toStageId,
      toStageName: input.toStageName,
    },
    approval: {
      kind: "required",
      approverUid: input.approverUid,
      approverName: input.approverName,
    },
  };
}

export function createMailDraftBlock(input: {
  approverUid: string;
  approverName: string;
  connectionId: string;
  recipient?: MailRecipientSource;
  id?: string;
  subject?: string;
  body?: string;
}): MailDraftCreateBlock {
  return {
    id: input.id || nextBlockId("mail_draft"),
    kind: "action.mail.draft.create",
    mail: {
      connectionId: input.connectionId,
      recipient: input.recipient || { kind: "contact" },
      subject: input.subject || "Following up on your call",
      body: input.body || "Hello {caller.name},\n\n{call.summary}\n",
    },
    approval: {
      kind: "required",
      approverUid: input.approverUid,
      approverName: input.approverName,
    },
  };
}

export function createIfBlock(input: {
  assigneeUid: string;
  assigneeName: string;
  id?: string;
}): IfBlock {
  return {
    id: input.id || nextBlockId("if"),
    kind: "control.if",
    condition: {
      field: "call.durationSeconds",
      operator: "gte",
      value: 60,
    },
    then: [createTaskBlock({
      assigneeUid: input.assigneeUid,
      assigneeName: input.assigneeName,
    })],
    else: [],
  };
}

export function createCallTaskWorkflow(input: {
  assigneeUid: string;
  assigneeName: string;
  name?: string;
}): WorkflowSpec {
  return {
    schemaVersion: 4,
    name: input.name?.trim() || "Call follow-up",
    trigger: {
      id: "trigger_call_transcribed",
      kind: "event.call.transcribed",
    },
    blocks: [createTaskBlock({
      id: "task_primary",
      assigneeUid: input.assigneeUid,
      assigneeName: input.assigneeName,
    })],
  };
}

export function normalizeWorkflowSpec(untrusted: unknown): WorkflowSpec | null {
  if (!untrusted || typeof untrusted !== "object") return null;
  const candidate = untrusted as {
    schemaVersion?: unknown;
    name?: unknown;
    trigger?: unknown;
    blocks?: unknown;
    task?: unknown;
  };
  if (candidate.schemaVersion === 4) return cloneWorkflow(candidate as WorkflowSpec);
  if (
    candidate.schemaVersion === 3
    && typeof candidate.name === "string"
    && candidate.trigger
    && typeof candidate.trigger === "object"
    && Array.isArray(candidate.blocks)
  ) {
    try {
      const legacy = JSON.parse(JSON.stringify(candidate)) as Schema3Workflow;
      const upgradeTask = (block: Schema3TaskBlock): CreateTaskBlock => ({
        ...block,
        approval: {
          kind: "required",
          approverUid: block.task.assigneeUid,
          approverName: block.task.assigneeName,
        },
      });
      return {
        schemaVersion: 4,
        name: legacy.name,
        trigger: legacy.trigger,
        blocks: legacy.blocks.map((block) => (
          block.kind === "action.task.create"
            ? upgradeTask(block)
            : {
                ...block,
                then: block.then.map(upgradeTask),
                else: block.else.map(upgradeTask),
              }
        )),
      };
    } catch {
      return null;
    }
  }
  if (
    candidate.schemaVersion === 2
    && typeof candidate.name === "string"
    && candidate.trigger
    && typeof candidate.trigger === "object"
    && (candidate.trigger as { kind?: unknown }).kind === "call.transcribed"
    && candidate.task
    && typeof candidate.task === "object"
  ) {
    const legacy = candidate as Schema2Workflow;
    return {
      schemaVersion: 4,
      name: legacy.name,
      trigger: {
        id: "trigger_call_transcribed",
        kind: "event.call.transcribed",
      },
      blocks: [{
        id: "task_primary",
        kind: "action.task.create",
        task: { ...legacy.task },
        approval: {
          kind: "required",
          approverUid: legacy.task.assigneeUid,
          approverName: legacy.task.assigneeName,
        },
      }],
    };
  }
  return null;
}

export function cloneWorkflow(spec: WorkflowSpec): WorkflowSpec {
  return JSON.parse(JSON.stringify(spec)) as WorkflowSpec;
}

function issue(code: string, path: string, message: string): SpecIssue {
  return { code, path, message };
}

function validateTask(
  task: Partial<TaskRecipe> | undefined,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
) {
  if (!task || typeof task !== "object") {
    errors.push(issue("task.invalid", path, "Task settings are required."));
    return;
  }
  if (typeof task.title !== "string" || !task.title.trim()) {
    holes.push(issue("task.title_empty", `${path}.title`, "Task title is required."));
  } else if (task.title.trim().length > 300) {
    errors.push(issue("task.title_long", `${path}.title`, "Task title is too long."));
  }
  if (
    task.instructions !== undefined
    && (typeof task.instructions !== "string" || task.instructions.length > 5_000)
  ) {
    errors.push(issue(
      "task.instructions",
      `${path}.instructions`,
      "Task instructions must be at most 5,000 characters.",
    ));
  }
  if (typeof task.assigneeUid !== "string" || !task.assigneeUid.trim()) {
    holes.push(issue("task.assignee_empty", `${path}.assigneeUid`, "Choose a team member."));
  }
  if (typeof task.assigneeName !== "string" || !task.assigneeName.trim()) {
    holes.push(issue("task.assignee_name_empty", `${path}.assigneeName`, "Assignee name is required."));
  }
  if (
    task.dueAfterDays !== undefined
    && task.dueAfterDays !== null
    && (
      !Number.isInteger(task.dueAfterDays)
      || task.dueAfterDays < 0
      || task.dueAfterDays > 365
    )
  ) {
    errors.push(issue(
      "task.due_range",
      `${path}.dueAfterDays`,
      "Due offset must be a whole number from 0 to 365.",
    ));
  }
  if (task.subject !== undefined) {
    if (!task.subject || typeof task.subject !== "object") {
      errors.push(issue(
        "task.subject_invalid",
        `${path}.subject`,
        "Choose what this task is about.",
      ));
    } else if (task.subject.kind === "matching_case") {
      if (typeof task.subject.pipelineId !== "string" || !task.subject.pipelineId.trim()) {
        holes.push(issue(
          "task.subject_pipeline_empty",
          `${path}.subject.pipelineId`,
          "Choose the case pipeline.",
        ));
      }
      if (typeof task.subject.stageId !== "string" || !task.subject.stageId.trim()) {
        holes.push(issue(
          "task.subject_stage_empty",
          `${path}.subject.stageId`,
          "Choose the case stage to match.",
        ));
      }
      if (typeof task.subject.stageName !== "string" || !task.subject.stageName.trim()) {
        holes.push(issue(
          "task.subject_stage_name_empty",
          `${path}.subject.stageName`,
          "The matching case stage needs a name.",
        ));
      }
    } else if (task.subject.kind !== "internal" && task.subject.kind !== "contact") {
      errors.push(issue(
        "task.subject_unsupported",
        `${path}.subject.kind`,
        "This task subject is not supported.",
      ));
    }
  }
}

function validateApproval(
  approval: Partial<RequiredApproval> | undefined,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
) {
  if (!approval || typeof approval !== "object" || approval.kind !== "required") {
    errors.push(issue(
      "approval.required",
      path,
      "Every action must have a required approval gate.",
    ));
    return;
  }
  if (typeof approval.approverUid !== "string" || !approval.approverUid.trim()) {
    holes.push(issue(
      "approval.approver_empty",
      `${path}.approverUid`,
      "Choose an approver for this action.",
    ));
  }
  if (typeof approval.approverName !== "string" || !approval.approverName.trim()) {
    holes.push(issue(
      "approval.approver_name_empty",
      `${path}.approverName`,
      "Approver name is required.",
    ));
  }
}

function expectedOperators(field: ConditionField): ConditionOperator[] {
  if (field === "call.durationSeconds") return ["eq", "gt", "gte", "lt", "lte"];
  if (field === "caller.hasContact") return ["eq"];
  return ["eq", "contains"];
}

function validateCondition(
  condition: Partial<WorkflowCondition> | undefined,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
) {
  if (!condition || typeof condition !== "object") {
    errors.push(issue("condition.invalid", path, "Condition settings are required."));
    return;
  }
  const fields: ConditionField[] = [
    "call.durationSeconds",
    "caller.hasContact",
    "transcript.text",
  ];
  if (!fields.includes(condition.field as ConditionField)) {
    errors.push(issue("condition.field", `${path}.field`, "Condition field is not supported."));
    return;
  }
  const field = condition.field as ConditionField;
  if (!expectedOperators(field).includes(condition.operator as ConditionOperator)) {
    errors.push(issue(
      "condition.operator",
      `${path}.operator`,
      "Operator is not supported for this field.",
    ));
  }
  if (field === "call.durationSeconds") {
    if (typeof condition.value !== "number" || !Number.isFinite(condition.value) || condition.value < 0) {
      errors.push(issue(
        "condition.value_number",
        `${path}.value`,
        "Call duration must be a non-negative number of seconds.",
      ));
    }
  } else if (field === "caller.hasContact") {
    if (typeof condition.value !== "boolean") {
      errors.push(issue(
        "condition.value_boolean",
        `${path}.value`,
        "Contact condition must be yes or no.",
      ));
    }
  } else if (typeof condition.value !== "string" || !condition.value.trim()) {
    holes.push(issue(
      "condition.value_text",
      `${path}.value`,
      "Enter text to compare with the transcript.",
    ));
  } else if (condition.value.length > 500) {
    errors.push(issue(
      "condition.value_text_long",
      `${path}.value`,
      "Condition text is too long.",
    ));
  }
}

function validateCaseRecipe(
  recipe: Partial<CaseRecipe> | undefined,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
) {
  if (!recipe || typeof recipe !== "object") {
    errors.push(issue("case.invalid", path, "Case settings are required."));
    return;
  }
  if (typeof recipe.title !== "string" || !recipe.title.trim()) {
    holes.push(issue("case.title_empty", `${path}.title`, "Case title is required."));
  } else if (recipe.title.trim().length > 300) {
    errors.push(issue("case.title_long", `${path}.title`, "Case title is too long."));
  }
  for (const [field, message] of [
    ["pipelineId", "Choose a pipeline."],
    ["stageId", "Choose an initial stage."],
    ["stageName", "Stage name is required."],
    ["ownerUid", "Choose a case owner."],
    ["ownerName", "Owner name is required."],
  ] as const) {
    if (typeof recipe[field] !== "string" || !recipe[field]?.trim()) {
      holes.push(issue(`case.${field}_empty`, `${path}.${field}`, message));
    }
  }
}

function validateMoveCaseRecipe(
  recipe: Partial<MoveCaseRecipe> | undefined,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
) {
  if (!recipe || typeof recipe !== "object") {
    errors.push(issue("case_move.invalid", path, "Case movement settings are required."));
    return;
  }
  for (const [field, message] of [
    ["pipelineId", "Choose a pipeline."],
    ["fromStageId", "Choose the exact current stage."],
    ["fromStageName", "Current stage name is required."],
    ["toStageId", "Choose a destination stage."],
    ["toStageName", "Destination stage name is required."],
  ] as const) {
    if (typeof recipe[field] !== "string" || !recipe[field]?.trim()) {
      holes.push(issue(`case_move.${field}_empty`, `${path}.${field}`, message));
    }
  }
  if (
    typeof recipe.fromStageId === "string"
    && recipe.fromStageId.trim()
    && recipe.fromStageId === recipe.toStageId
  ) {
    errors.push(issue(
      "case_move.same_stage",
      `${path}.toStageId`,
      "Current and destination stages must be different.",
    ));
  }
}

// Deliberately conservative: one address, no display names, no comma lists. A
// draft that could reach more than one person is a different, larger effect.
const emailPattern = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

function validateMailDraftRecipe(
  recipe: Partial<MailDraftRecipe> | undefined,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
) {
  if (!recipe || typeof recipe !== "object") {
    errors.push(issue("mail_draft.invalid", path, "Draft settings are required."));
    return;
  }
  if (typeof recipe.connectionId !== "string" || !recipe.connectionId.trim()) {
    holes.push(issue(
      "mail_draft.connection_empty",
      `${path}.connectionId`,
      "Choose the mailbox this draft is written from.",
    ));
  }
  const recipient = recipe.recipient;
  if (!recipient || typeof recipient !== "object") {
    holes.push(issue("mail_draft.recipient_empty", `${path}.recipient`, "Choose a recipient."));
  } else if (recipient.kind === "literal") {
    if (typeof recipient.email !== "string" || !recipient.email.trim()) {
      holes.push(issue(
        "mail_draft.recipient_email_empty",
        `${path}.recipient.email`,
        "Enter the recipient address.",
      ));
    } else if (!emailPattern.test(recipient.email.trim()) || recipient.email.trim().length > 320) {
      errors.push(issue(
        "mail_draft.recipient_email_invalid",
        `${path}.recipient.email`,
        "Enter one valid email address.",
      ));
    }
  } else if (recipient.kind !== "contact") {
    errors.push(issue(
      "mail_draft.recipient_unsupported",
      `${path}.recipient.kind`,
      "This recipient type is not supported.",
    ));
  }
  if (typeof recipe.subject !== "string" || !recipe.subject.trim()) {
    holes.push(issue("mail_draft.subject_empty", `${path}.subject`, "Subject is required."));
  } else if (recipe.subject.trim().length > 500) {
    errors.push(issue("mail_draft.subject_long", `${path}.subject`, "Subject is too long."));
  }
  if (typeof recipe.body !== "string" || !recipe.body.trim()) {
    holes.push(issue("mail_draft.body_empty", `${path}.body`, "Message is required."));
  } else if (recipe.body.length > 50_000) {
    errors.push(issue(
      "mail_draft.body_long",
      `${path}.body`,
      "Message must be at most 50,000 characters.",
    ));
  }
}

function validateActionBlock(
  block: unknown,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
  ids: Set<string>,
) {
  if (!block || typeof block !== "object") {
    errors.push(issue("block.invalid", path, "Block must be an object."));
    return;
  }
  const candidate = block as Partial<ActionBlock>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    holes.push(issue("block.id_empty", `${path}.id`, "Block id is required."));
  } else if (ids.has(candidate.id)) {
    errors.push(issue("block.id_duplicate", `${path}.id`, "Block ids must be unique."));
  } else {
    ids.add(candidate.id);
  }
  if (candidate.kind === "action.task.create") {
    validateTask(candidate.task, `${path}.task`, errors, holes);
    validateApproval(candidate.approval, `${path}.approval`, errors, holes);
    return;
  }
  if (candidate.kind === "action.case.create") {
    validateCaseRecipe(candidate.case, `${path}.case`, errors, holes);
    validateApproval(candidate.approval, `${path}.approval`, errors, holes);
    return;
  }
  if (candidate.kind === "action.case.move") {
    validateMoveCaseRecipe(candidate.case, `${path}.case`, errors, holes);
    validateApproval(candidate.approval, `${path}.approval`, errors, holes);
    return;
  }
  if (candidate.kind === "action.mail.draft.create") {
    validateMailDraftRecipe(candidate.mail, `${path}.mail`, errors, holes);
    validateApproval(candidate.approval, `${path}.approval`, errors, holes);
    return;
  }
  errors.push(issue("block.unsupported", `${path}.kind`, "This action type is not supported."));
}

function validateActionBlocks(
  blocks: unknown,
  path: string,
  errors: SpecIssue[],
  holes: SpecIssue[],
  ids: Set<string>,
) {
  if (!Array.isArray(blocks)) {
    errors.push(issue("branch.invalid", path, "Branch blocks must be an array."));
    return;
  }
  if (blocks.length > 10) {
    errors.push(issue("branch.limit", path, "A branch can contain at most 10 action blocks."));
  }
  blocks.forEach((block, index) => {
    validateActionBlock(block, `${path}[${index}]`, errors, holes, ids);
  });
}

export function validateWorkflow(untrusted: unknown): ValidationResult {
  const errors: SpecIssue[] = [];
  const holes: SpecIssue[] = [];
  if (!untrusted || typeof untrusted !== "object") {
    return {
      valid: false,
      errors: [issue("workflow.invalid", "", "Workflow must be an object.")],
      holes,
    };
  }
  const spec = untrusted as Partial<WorkflowSpec>;
  if (spec.schemaVersion !== 4) {
    errors.push(issue(
      "workflow.schema_version",
      "schemaVersion",
      "Only the approval-gated executable block language is supported.",
    ));
  }
  if (typeof spec.name !== "string" || !spec.name.trim()) {
    holes.push(issue("workflow.name_empty", "name", "Workflow name is required."));
  } else if (spec.name.trim().length > 200) {
    errors.push(issue("workflow.name_long", "name", "Workflow name is too long."));
  }
  if (
    spec.trigger?.kind !== "event.call.transcribed"
    || typeof spec.trigger.id !== "string"
    || !spec.trigger.id.trim()
  ) {
    errors.push(issue(
      "workflow.trigger",
      "trigger",
      "The supported trigger block is a transcribed call.",
    ));
  }
  if (!Array.isArray(spec.blocks)) {
    errors.push(issue("workflow.blocks", "blocks", "Workflow blocks must be an array."));
    return { valid: false, errors, holes };
  }
  if (spec.blocks.length === 0) {
    holes.push(issue("workflow.blocks_empty", "blocks", "Add at least one result block."));
  }
  if (spec.blocks.length > 10) {
    errors.push(issue("workflow.blocks_limit", "blocks", "A workflow can contain at most 10 blocks."));
  }
  const ids = new Set<string>();
  spec.blocks.forEach((block, index) => {
    const path = `blocks[${index}]`;
    if (!block || typeof block !== "object") {
      errors.push(issue("block.invalid", path, "Block must be an object."));
      return;
    }
    if (typeof block.id !== "string" || !block.id.trim()) {
      holes.push(issue("block.id_empty", `${path}.id`, "Block id is required."));
    } else if (ids.has(block.id)) {
      errors.push(issue("block.id_duplicate", `${path}.id`, "Block ids must be unique."));
    } else {
      ids.add(block.id);
    }
    if (
      block.kind === "action.task.create"
      || block.kind === "action.case.create"
      || block.kind === "action.case.move"
      || block.kind === "action.mail.draft.create"
    ) {
      if (block.kind === "action.task.create") {
        validateTask(block.task, `${path}.task`, errors, holes);
      } else if (block.kind === "action.case.create") {
        validateCaseRecipe(block.case, `${path}.case`, errors, holes);
      } else if (block.kind === "action.case.move") {
        validateMoveCaseRecipe(block.case, `${path}.case`, errors, holes);
      } else {
        validateMailDraftRecipe(block.mail, `${path}.mail`, errors, holes);
      }
      validateApproval(block.approval, `${path}.approval`, errors, holes);
      return;
    }
    if (block.kind === "control.if") {
      validateCondition(block.condition, `${path}.condition`, errors, holes);
      validateActionBlocks(block.then, `${path}.then`, errors, holes, ids);
      validateActionBlocks(block.else, `${path}.else`, errors, holes, ids);
      if (
        Array.isArray(block.then)
        && Array.isArray(block.else)
        && block.then.length === 0
        && block.else.length === 0
      ) {
        holes.push(issue(
          "condition.branches_empty",
          path,
          "Add an action to at least one branch.",
        ));
      }
      return;
    }
    {
      errors.push(issue("block.unsupported", `${path}.kind`, "This block type is not supported."));
    }
  });
  const actionCount = spec.blocks.reduce((count, block) => {
    if (!block || typeof block !== "object") return count;
    if (block.kind !== "control.if") return count + 1;
    return count
      + (Array.isArray(block.then) ? block.then.length : 0)
      + (Array.isArray(block.else) ? block.else.length : 0);
  }, 0);
  if (actionCount > 20) {
    errors.push(issue(
      "workflow.action_limit",
      "blocks",
      "A workflow can define at most 20 action blocks.",
    ));
  }
  return { valid: errors.length === 0 && holes.length === 0, errors, holes };
}

function tokenValue(token: string, context: CallTaskContext): string {
  if (token === "caller.name") {
    return context.callerName?.trim() || context.callerPhone?.trim() || "caller";
  }
  if (token === "caller.phone") {
    return context.callerPhone?.trim() || context.callerName?.trim() || "unknown caller";
  }
  // Evidence tokens have no invented fallback. An absent summary renders as
  // nothing, so a message built only from evidence collapses to empty and is
  // skipped as `insufficient_context` rather than proposed half-written.
  if (token === "call.summary") return context.callSummary?.trim() || "";
  if (token === "call.transcriptExcerpt") return context.transcriptExcerpt?.trim() || "";
  return `{${token}}`;
}

export function renderTaskText(template: string, context: CallTaskContext): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, token: string) => (
    tokenValue(token, context)
  ));
}

export function resolveTaskDueAt(
  dueAfterDays: number | null | undefined,
  now = new Date(),
): string | null {
  if (dueAfterDays === null || dueAfterDays === undefined) return null;
  const result = new Date(now);
  result.setUTCDate(result.getUTCDate() + dueAfterDays);
  return result.toISOString();
}

function conditionActual(
  field: ConditionField,
  context: CallTaskContext,
): string | number | boolean | null {
  if (field === "call.durationSeconds") return context.callDurationSeconds ?? null;
  if (field === "caller.hasContact") return context.callerHasContact ?? false;
  return context.transcriptText ?? "";
}

export function evaluateCondition(
  condition: WorkflowCondition,
  context: CallTaskContext,
): { actual: string | number | boolean | null; result: boolean } {
  const actual = conditionActual(condition.field, context);
  if (condition.operator === "contains") {
    return {
      actual,
      result: typeof actual === "string"
        && actual.toLocaleLowerCase().includes(String(condition.value).toLocaleLowerCase()),
    };
  }
  if (condition.operator === "eq") {
    if (typeof actual === "string") {
      return {
        actual,
        result: actual.toLocaleLowerCase() === String(condition.value).toLocaleLowerCase(),
      };
    }
    return { actual, result: actual === condition.value };
  }
  if (typeof actual !== "number" || typeof condition.value !== "number") {
    return { actual, result: false };
  }
  if (condition.operator === "gt") return { actual, result: actual > condition.value };
  if (condition.operator === "gte") return { actual, result: actual >= condition.value };
  if (condition.operator === "lt") return { actual, result: actual < condition.value };
  return { actual, result: actual <= condition.value };
}

function previewTaskBlock(
  block: CreateTaskBlock,
  context: CallTaskContext,
  now: Date,
  match: CaseContext | null = null,
): TaskRecipePreview {
  return {
    kind: "task.create",
    blockId: block.id,
    title: renderTaskText(block.task.title, context),
    instructions: block.task.instructions
      ? renderTaskText(block.task.instructions, context)
      : null,
    assigneeUid: block.task.assigneeUid,
    assigneeName: block.task.assigneeName,
    approverUid: block.approval.approverUid,
    approverName: block.approval.approverName,
    dueAt: resolveTaskDueAt(block.task.dueAfterDays, now),
    subject: block.task.subject || null,
    caseId: match?.id || null,
    caseTitle: match?.title || null,
    // Conditions may inspect the complete transcript, but tasks should retain
    // only the compact, human-readable context needed to complete the work.
    context: {
      callerName: context.callerName ?? null,
      callerPhone: context.callerPhone ?? null,
      callSummary: context.callSummary ?? null,
      transcriptExcerpt: context.transcriptExcerpt ?? null,
    },
  };
}

function compactContext(context: CallTaskContext): CallTaskContext {
  return {
    callerName: context.callerName ?? null,
    callerPhone: context.callerPhone ?? null,
    callSummary: context.callSummary ?? null,
    transcriptExcerpt: context.transcriptExcerpt ?? null,
  };
}

function previewMailDraftBlock(
  block: MailDraftCreateBlock,
  context: CallTaskContext,
): { action?: ActionPreview; skipped?: ActionSkip } {
  const skip = (reason: ActionSkipReason): { skipped: ActionSkip } => ({
    skipped: { blockId: block.id, kind: block.kind, reason, matches: 0 },
  });

  // The mailbox is proven before the recipient so an operator sees the cause
  // they can actually fix first: a disconnected account, not a missing address.
  const mailbox = (context.mailConnections || []).find(
    (candidate) => candidate.connectionId === block.mail.connectionId,
  );
  if (!mailbox || !mailbox.active) return skip("mailbox_unavailable");

  const recipient = block.mail.recipient.kind === "literal"
    ? block.mail.recipient.email.trim().toLocaleLowerCase()
    : (context.contactEmail || "").trim().toLocaleLowerCase();
  if (!recipient) return skip("recipient_missing");

  const subject = renderTaskText(block.mail.subject, context).trim();
  const body = renderTaskText(block.mail.body, context).trim();
  // A template whose evidence tokens all resolved to nothing would propose an
  // empty message. Refuse rather than send a shell of an email for approval.
  if (!subject || !body) return skip("insufficient_context");

  return {
    action: {
      kind: "mail.draft.create",
      blockId: block.id,
      connectionId: block.mail.connectionId,
      mailboxAddress: mailbox.address,
      providerAccountId: mailbox.providerAccountId,
      to: [recipient],
      subject,
      body,
      approverUid: block.approval.approverUid,
      approverName: block.approval.approverName,
      context: compactContext(context),
    },
  };
}

function previewActionBlock(
  block: ActionBlock,
  context: CallTaskContext,
  now: Date,
): { action?: ActionPreview; skipped?: ActionSkip } {
  if (block.kind === "action.task.create") {
    const subject = block.task.subject;
    // Compatibility for deployed schema-v4 blocks: retain the original
    // contact-if-resolved behavior when no explicit subject was stored.
    if (!subject || subject.kind === "internal") {
      return { action: previewTaskBlock(block, context, now) };
    }
    if (!context.callerHasContact) {
      return {
        skipped: {
          blockId: block.id,
          kind: block.kind,
          reason: "contact_required",
          matches: 0,
        },
      };
    }
    if (subject.kind === "contact") {
      return { action: previewTaskBlock(block, context, now) };
    }
    const matches = (context.cases || []).filter((candidate) => (
      candidate.pipelineId === subject.pipelineId
      && candidate.stageId === subject.stageId
    ));
    if (matches.length !== 1) {
      return {
        skipped: {
          blockId: block.id,
          kind: block.kind,
          reason: matches.length === 0 ? "no_matching_case" : "ambiguous_case",
          matches: matches.length,
        },
      };
    }
    return { action: previewTaskBlock(block, context, now, matches[0]!) };
  }
  // Mail is resolved before the contact gate below: a draft addressed to a
  // literal address is a complete instruction without a resolved caller.
  if (block.kind === "action.mail.draft.create") {
    return previewMailDraftBlock(block, context);
  }
  if (!context.callerHasContact) {
    return {
      skipped: {
        blockId: block.id,
        kind: block.kind,
        reason: "contact_required",
        matches: 0,
      },
    };
  }
  if (block.kind === "action.case.create") {
    return {
      action: {
        kind: "case.create",
        blockId: block.id,
        title: renderTaskText(block.case.title, context),
        pipelineId: block.case.pipelineId,
        stageId: block.case.stageId,
        stageName: block.case.stageName,
        ownerUid: block.case.ownerUid,
        ownerName: block.case.ownerName,
        approverUid: block.approval.approverUid,
        approverName: block.approval.approverName,
        context: compactContext(context),
      },
    };
  }
  const matches = (context.cases || []).filter((candidate) => (
    candidate.pipelineId === block.case.pipelineId
    && candidate.stageId === block.case.fromStageId
  ));
  if (matches.length !== 1) {
    return {
      skipped: {
        blockId: block.id,
        kind: block.kind,
        reason: matches.length === 0 ? "no_matching_case" : "ambiguous_case",
        matches: matches.length,
      },
    };
  }
  const match = matches[0]!;
  return {
    action: {
      kind: "case.move",
      blockId: block.id,
      caseId: match.id,
      caseTitle: match.title,
      pipelineId: block.case.pipelineId,
      fromStageId: block.case.fromStageId,
      fromStageName: block.case.fromStageName,
      toStageId: block.case.toStageId,
      toStageName: block.case.toStageName,
      expectedRevision: match.revision,
      approverUid: block.approval.approverUid,
      approverName: block.approval.approverName,
      context: compactContext(context),
    },
  };
}

export function previewWorkflow(
  spec: WorkflowSpec,
  context: CallTaskContext,
  now = new Date(),
): WorkflowPreview {
  const validation = validateWorkflow(spec);
  if (!validation.valid) {
    const summary = [...validation.errors, ...validation.holes]
      .map((entry) => `${entry.path}: ${entry.message}`)
      .join("; ");
    throw new Error(`Workflow is not executable: ${summary}`);
  }
  const actions: ActionPreview[] = [];
  const skippedActions: ActionSkip[] = [];
  const conditions: ConditionTrace[] = [];
  const collect = (block: ActionBlock) => {
    const result = previewActionBlock(block, context, now);
    if (result.action) actions.push(result.action);
    if (result.skipped) skippedActions.push(result.skipped);
  };
  for (const block of spec.blocks) {
    if (block.kind !== "control.if") {
      collect(block);
      continue;
    }
    const evaluated = evaluateCondition(block.condition, context);
    const branch = evaluated.result ? "then" : "else";
    conditions.push({
      blockId: block.id,
      field: block.condition.field,
      operator: block.condition.operator,
      expected: block.condition.value,
      actual: block.condition.field === "transcript.text"
        && typeof evaluated.actual === "string"
        ? evaluated.actual.slice(0, 160)
        : evaluated.actual,
      result: evaluated.result,
      branch,
    });
    const selectedBlocks = evaluated.result ? block.then : block.else;
    selectedBlocks.forEach(collect);
  }
  return { actions, skippedActions, conditions };
}

export function previewWorkflowTasks(
  spec: WorkflowSpec,
  context: CallTaskContext,
  now = new Date(),
): TaskRecipePreview[] {
  return previewWorkflow(spec, context, now).actions.filter(
    (action): action is TaskRecipePreview => action.kind === "task.create",
  );
}
