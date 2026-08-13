import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalNotificationLink,
  composeApprovalNotification,
} from "../chat/notification.js";

const appOrigin = "https://app.agenterik.cz";

/** A stored mail-draft approval, with every field the executor would send to Gmail. */
function pendingMailDraftApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    objectType: "action_approval",
    status: "pending",
    decisionStatus: "pending",
    executionStatus: "not_started",
    approverUid: "member-1",
    approverName: "Tomáš Holas",
    access: { visibility: "company" },
    scope: { contactId: "contact-1", callId: "call-1", caseId: "case-9" },
    action: {
      kind: "mail.draft.create",
      draftRequestId: "maildraft_abc123",
      mailboxAddress: "ops@acme.cz",
      to: ["buyer@acme.cz"],
      subject: "Quote for the Brno site",
      body: "Hello Jan,\n\nAs promised on the call, our price is 240000 CZK.\n",
      context: { callerName: "ACME", callSummary: "Wants a discount before Friday" },
    },
    ...overrides,
  };
}

test("the channel gets a pointer and never the payload", () => {
  const approval = pendingMailDraftApproval();
  const notification = composeApprovalNotification(approval, { appOrigin });
  assert.ok(notification, "a pending company-wide approval must notify");

  const posted = `${notification.text} ${notification.linkUrl}`;
  for (const secret of [
    "buyer@acme.cz",
    "ops@acme.cz",
    "Quote for the Brno site",
    "240000",
    "Hello Jan",
    "Wants a discount before Friday",
    "maildraft_abc123",
  ]) {
    assert.equal(
      posted.includes(secret),
      false,
      `posted message must not carry ${secret}`,
    );
  }
  assert.equal(notification.text, "Approval waiting: Email draft — Tomáš Holas decides");
});

test("a restricted approval says nothing at all", () => {
  const approval = pendingMailDraftApproval({
    access: { visibility: "restricted", memberIds: ["member-1"] },
  });
  assert.equal(
    composeApprovalNotification(approval, { appOrigin }),
    null,
    "a shared channel cannot carry an item restricted to named members",
  );
});

test("a decided approval is never announced", () => {
  for (const decisionStatus of ["approved", "rejected"]) {
    assert.equal(
      composeApprovalNotification(
        pendingMailDraftApproval({ decisionStatus }),
        { appOrigin },
      ),
      null,
      `a ${decisionStatus} approval must not be replayed into chat`,
    );
  }
});

test("the link points where the approval card actually renders", () => {
  const withCase = composeApprovalNotification(pendingMailDraftApproval(), { appOrigin });
  assert.equal(withCase?.linkUrl, "https://app.agenterik.cz/approvals/approval-1");

  const withoutCase = composeApprovalNotification(
    pendingMailDraftApproval({
      scope: { contactId: "contact-1", callId: "call-1", caseId: null },
    }),
    { appOrigin },
  );
  assert.equal(withoutCase?.linkUrl, "https://app.agenterik.cz/approvals/approval-1");

  assert.equal(
    approvalNotificationLink({ appOrigin: "https://app.agenterik.cz/", approvalId: "a 1" }),
    "https://app.agenterik.cz/approvals/a%201",
  );
});

test("an unknown action kind notifies without describing itself", () => {
  const notification = composeApprovalNotification(
    pendingMailDraftApproval({
      action: { kind: "some.future.effect", secretField: "must-not-appear" },
    }),
    { appOrigin },
  );
  assert.equal(notification?.text, "Approval waiting: Action — Tomáš Holas decides");
  assert.equal(notification?.text.includes("must-not-appear"), false);
  assert.equal(notification?.text.includes("some.future.effect"), false);
});

test("internal action kinds keep their own labels", () => {
  const labels = ["task.create", "case.create", "case.move"].map((kind) =>
    composeApprovalNotification(
      pendingMailDraftApproval({ action: { kind } }),
      { appOrigin },
    )?.text);
  assert.deepEqual(labels, [
    "Approval waiting: Task — Tomáš Holas decides",
    "Approval waiting: Case — Tomáš Holas decides",
    "Approval waiting: Case move — Tomáš Holas decides",
  ]);
});
