import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { defineSecret } from "firebase-functions/params";
import { db, jsonSafe } from "./firestore.js";
import { canMemberAccessSourceData } from "./access.js";
import { adminProcedure, enabledProcedure, router, signedInProcedure } from "./trpc.js";
import { factAgentPromptVersion } from "./agent/loop.js";
import { FirestoreCompanyData, rehydrateCitationPresentation } from "./agent/knowledge.js";
import {
  embeddingDimensions,
  embeddingModel,
  qdrantCollection,
  qdrantConfigurationFromEnvironment,
  qdrantFromEnvironment,
} from "./agent/search.js";
import { memberThreadDocumentId } from "./agent/threads.js";
import { askCompanyFactAgent } from "./agent/service.js";
import { createKnowledgeIndexDependencies } from "./sync-qdrant.js";
import {
  enqueueKnowledgeIndexBackfill,
  getKnowledgeIndexStatus,
  replayKnowledgeIndexDelivery,
} from "./knowledge-index-runtime.js";
import type { WorkflowSpec } from "@agent-erik/workflow";
import {
  createWorkflowDraft,
  enableWorkflow,
  getWorkflow,
  listWorkflows,
  pauseWorkflow,
  saveWorkflowDraft,
} from "./workflow/repository.js";
import {
  dryRunHistory,
  workflowHealth,
  workflowRuntimeFlags,
} from "./workflow/runtime.js";
import {
  approveAction,
  getActionApproval,
  listActionApprovals,
  rejectAction,
} from "./approvals/repository.js";
import { encryptCredentials } from "./connectors/credentials.js";
import { normalizeInvitationEmail } from "./invitation-token.js";
import {
  createOdorikConnection,
  deleteSourceConnection,
  getOdorikSetupDestination,
  listSources,
  migrateLegacyOdorik,
  prepareConnectionDeletion,
  setCapabilityStatus,
  setConnectionStatus,
  setResourceAudience,
  setResourceStatus,
} from "./connectors/repository.js";
import { odorikDestinationUrl } from "./connectors/odorik.js";
import {
  listGoogleCalendars,
  replayGoogleCalendarSyncRun,
  selectGoogleCalendars,
  syncGoogleCalendarConnection,
} from "./connectors/google-calendar.js";
import {
  DriveSelectionBroadeningError,
  listGoogleDriveFolders,
  replayGoogleDriveSyncRun,
  selectGoogleDriveFolders,
  syncGoogleDriveConnection,
} from "./connectors/google-drive.js";
import {
  listGmailLabels,
  replayGoogleGmailSyncRun,
  selectGmailLabels,
  syncGoogleGmailConnection,
} from "./connectors/google-gmail.js";
import {
  createGoogleWorkspaceAuthorization,
  revokeGoogleWorkspaceAuthorization,
} from "./connectors/google-oauth.js";
import {
  createMicrosoftAuthorization,
  refreshMicrosoftConnection,
} from "./connectors/microsoft-oauth.js";
import {
  configuredGitHubInstallationId,
  connectGitHubInstallation,
  githubConfigurationFromEnvironment,
  replayGitHubSyncRun,
  syncGitHubConnection,
} from "./connectors/github.js";
import {
  createCloudRunGrokAuthJobExecutor,
  getGrokAuthorization,
  GrokAuthorizationError,
  startGrokAuthorization,
} from "./connectors/grok-subscription.js";
import {
  createSlackAuthorization,
  revokeSlackAuthorization,
  slackConnectorClientId,
} from "./connectors/slack-oauth.js";
import { listSlackChannels, selectSlackChannels } from "./chat/channels.js";
import { consumeSlackLink, inspectSlackLink } from "./chat/slack-link.js";
import {
  listChatNotifications,
  retryApprovalNotifications,
} from "./chat/deliver.js";
import { productionAppOrigin } from "./connectors/google-oauth-return.js";
import type { SourceCapabilityId } from "./connectors/types.js";
import {
  acceptTeamInvitation,
  createTeamInvitation,
  inspectTeamInvitation,
  removeTeamMember,
  resendTeamInvitation,
  revokeTeamInvitation,
  teamOverview,
} from "./teams.js";
import {
  companyCollectionPath,
  companyDocumentPath,
  registerUser,
  registrationStatus,
} from "./tenancy.js";
import {
  createTask,
  listTasks,
  transitionTask,
  updateTask,
} from "./tasks/repository.js";
import {
  archiveCase,
  createCase,
  getCaseDetails,
  getPipeline,
  listCases,
  moveCase,
  updatePipeline,
} from "./pipeline/repository.js";
import { GoogleCodingArtifactStore } from "./coding/artifacts.js";
import {
  cancelCodingExecution,
} from "./coding/cloud-run.js";
import {
  CodingRunError,
  getCodingRun,
  listCodingIssues,
  listCodingRuns,
} from "./coding/repository.js";
import {
  cancelCodingRun,
  codingArtifactDownloadUrl,
  codingPatchPreview,
  reconcileCodingPublication,
} from "./coding/service.js";
import {
  requestCodingImplementationApproval,
  requestCodingPullRequestChangesApproval,
  requestCodingRetryApproval,
} from "./coding/proposal.js";
import { inspectGitHubPublication } from "./coding/github-recovery.js";

export const geminiApiKey = defineSecret("GEMINI_API_KEY");
export const qdrantApiKey = defineSecret("QDRANT_API_KEY");
export const qdrantUrl = defineSecret("QDRANT_URL");
export const connectorCredentialKey = defineSecret("CONNECTOR_CREDENTIAL_KEY");

export const googleConnectorClientId = defineSecret("GOOGLE_CONNECTOR_CLIENT_ID");
export const googleConnectorClientSecret = defineSecret("GOOGLE_CONNECTOR_CLIENT_SECRET");
export const microsoftConnectorClientId = defineSecret("MICROSOFT_CONNECTOR_CLIENT_ID");
export const microsoftConnectorClientSecret = defineSecret("MICROSOFT_CONNECTOR_CLIENT_SECRET");
export const githubAppPrivateKey = defineSecret("GITHUB_APP_PRIVATE_KEY");
const executeGrokAuthJob = createCloudRunGrokAuthJobExecutor();
const codingArtifacts = new GoogleCodingArtifactStore();

function knowledgeIndexDependencies() {
  return createKnowledgeIndexDependencies({
    database: db,
    geminiApiKey: geminiApiKey.value(),
  });
}

async function getAccess(uid: string) {
  return registrationStatus(uid);
}

export const appRouter = router({
  auth: router({
    register: signedInProcedure.mutation(({ ctx }) => registerUser(ctx)),
    status: signedInProcedure.query(({ ctx }) => getAccess(ctx.uid)),
  }),

  invitations: router({
    inspect: signedInProcedure
      .input(z.object({ token: z.string().min(60).max(300) }))
      .query(({ ctx, input }) => inspectTeamInvitation({
        token: input.token,
        email: ctx.email,
        emailVerified: ctx.emailVerified,
      })),
    accept: signedInProcedure
      .input(z.object({ token: z.string().min(60).max(300) }))
      .mutation(({ ctx, input }) => acceptTeamInvitation({
        token: input.token,
        uid: ctx.uid,
        email: ctx.email,
        emailVerified: ctx.emailVerified,
        displayName: ctx.displayName,
        photoURL: ctx.photoURL,
      })),
  }),

  team: router({
    overview: enabledProcedure.query(({ ctx }) => teamOverview(ctx.companyId)),
    invite: enabledProcedure
      .input(z.object({ email: z.string().trim().email().max(320) }))
      .mutation(({ ctx, input }) => createTeamInvitation({
        companyId: ctx.companyId,
        teamName: ctx.teamName,
        email: input.email,
        inviterUid: ctx.uid,
        inviterName: ctx.displayName || ctx.email,
      })),
    resendInvitation: enabledProcedure
      .input(z.object({
        invitationId: z.string().regex(/^[a-zA-Z0-9]{10,40}$/),
      }))
      .mutation(({ ctx, input }) => resendTeamInvitation({
        companyId: ctx.companyId,
        teamName: ctx.teamName,
        invitationId: input.invitationId,
        inviterUid: ctx.uid,
        inviterName: ctx.displayName || ctx.email,
      })),
    revokeInvitation: enabledProcedure
      .input(z.object({
        invitationId: z.string().regex(/^[a-zA-Z0-9]{10,40}$/),
      }))
      .mutation(({ ctx, input }) => revokeTeamInvitation({
        companyId: ctx.companyId,
        invitationId: input.invitationId,
        actorUid: ctx.uid,
      })),
    removeMember: adminProcedure
      .input(z.object({ uid: z.string().min(1).max(128) }))
      .mutation(({ ctx, input }) => removeTeamMember({
        companyId: ctx.companyId,
        targetUid: input.uid,
        actorUid: ctx.uid,
      })),
  }),

  system: router({
    health: enabledProcedure.query(async ({ ctx }) => {
      await db.collection(
        companyCollectionPath(ctx.companyId, "workItems"),
      ).limit(1).get();
      return {
        ok: true,
        projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d",
        databaseId: "odorik",
        databaseEdition: "Firestore Enterprise",
        model: "gemini-3.5-flash-lite",
      };
    }),
  }),

  coding: router({
    listIssues: enabledProcedure.query(({ ctx }) => listCodingIssues({
      companyId: ctx.companyId,
      memberUid: ctx.uid,
    })),
    listRuns: enabledProcedure.query(({ ctx }) => listCodingRuns({
      companyId: ctx.companyId,
      memberUid: ctx.uid,
    })),
    getRun: enabledProcedure
      .input(z.object({ runId: z.string().regex(/^coding_[a-f0-9]{32}$/) }))
      .query(async ({ ctx, input }) => {
        try {
          return await getCodingRun({
            companyId: ctx.companyId,
            runId: input.runId,
            memberUid: ctx.uid,
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    requestFromIssue: adminProcedure
      .input(z.object({
        issueContextItemId: z.string().regex(/^github_issue_[a-f0-9]{32}$/),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await requestCodingImplementationApproval({
            companyId: ctx.companyId,
            actorUid: ctx.uid,
            preferredApproverUid: ctx.uid,
            issueContextItemId: input.issueContextItemId,
            configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    cancelRun: adminProcedure
      .input(z.object({ runId: z.string().regex(/^coding_[a-f0-9]{32}$/) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await cancelCodingRun({
            companyId: ctx.companyId,
            runId: input.runId,
            actorUid: ctx.uid,
            cancelExecution: cancelCodingExecution,
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    reconcileRun: adminProcedure
      .input(z.object({ runId: z.string().regex(/^coding_[a-f0-9]{32}$/) }))
      .mutation(async ({ ctx, input }) => {
        try {
          const configuration = githubConfigurationFromEnvironment(githubAppPrivateKey.value());
          return await reconcileCodingPublication({
            companyId: ctx.companyId,
            runId: input.runId,
            actorUid: ctx.uid,
            inspectPublication: (value) => inspectGitHubPublication({
              ...value,
              configuration,
            }),
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    retryRun: adminProcedure
      .input(z.object({
        runId: z.string().regex(/^coding_[a-f0-9]{32}$/),
        instructions: z.string().trim().max(20_000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const approval = await requestCodingRetryApproval({
            companyId: ctx.companyId,
            actorUid: ctx.uid,
            preferredApproverUid: ctx.uid,
            runId: input.runId,
            instructions: input.instructions,
            configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
          });
          // When the admin who requests the retry is the named approver, start
          // immediately so operators are not bounced through Tasks for a second
          // click on a re-run they already authorized.
          if (
            !approval.duplicate
            && approval.decisionStatus === "pending"
            && approval.approverUid === ctx.uid
          ) {
            const executed = await approveAction({
              companyId: ctx.companyId,
              actorUid: ctx.uid,
              approvalId: String(approval.id),
            }) as Record<string, unknown>;
            const executionResult = (
              executed.executionResult
              && typeof executed.executionResult === "object"
              ? executed.executionResult as { codingRunId?: string; status?: string }
              : undefined
            );
            return {
              ...approval,
              decisionStatus: "approved",
              status: "approved",
              started: true,
              codingRunId: executionResult?.codingRunId || null,
              executionResult: executionResult || null,
            };
          }
          return {
            ...approval,
            started: false,
            codingRunId: null,
          };
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    requestPullRequestChanges: adminProcedure
      .input(z.object({
        runId: z.string().regex(/^coding_[a-f0-9]{32}$/),
        instructions: z.string().trim().min(1).max(20_000),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const configuration = githubConfigurationFromEnvironment(githubAppPrivateKey.value());
          return await requestCodingPullRequestChangesApproval({
            companyId: ctx.companyId,
            actorUid: ctx.uid,
            preferredApproverUid: ctx.uid,
            runId: input.runId,
            instructions: input.instructions,
            configuration,
            inspectPublication: (value) => inspectGitHubPublication({
              ...value,
              configuration,
            }),
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    getPatchPreview: enabledProcedure
      .input(z.object({ runId: z.string().regex(/^coding_[a-f0-9]{32}$/) }))
      .query(async ({ ctx, input }) => {
        try {
          return await codingPatchPreview({
            companyId: ctx.companyId,
            runId: input.runId,
            memberUid: ctx.uid,
            artifactStore: codingArtifacts,
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    getArtifactDownloadUrl: enabledProcedure
      .input(z.object({ runId: z.string().regex(/^coding_[a-f0-9]{32}$/) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await codingArtifactDownloadUrl({
            companyId: ctx.companyId,
            runId: input.runId,
            memberUid: ctx.uid,
            artifactStore: codingArtifacts,
          });
        } catch (error) {
          if (error instanceof CodingRunError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
  }),

  sources: router({
    list: enabledProcedure.query(({ ctx }) => listSources(ctx.companyId)),
    indexStatus: adminProcedure.query(({ ctx }) => getKnowledgeIndexStatus(ctx.companyId, db)),
    backfillIndexDeliveries: adminProcedure.mutation(({ ctx }) => (
      enqueueKnowledgeIndexBackfill({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
      }, knowledgeIndexDependencies())
    )),
    replayIndexDelivery: adminProcedure
      .input(z.object({
        deliveryId: z.string().regex(/^idx_[a-f0-9]{64}$/),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await replayKnowledgeIndexDelivery({
            companyId: ctx.companyId,
            deliveryId: input.deliveryId,
            actorUid: ctx.uid,
          }, knowledgeIndexDependencies());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new TRPCError({
            code: message === "Knowledge-index delivery not found" ? "NOT_FOUND" : "BAD_REQUEST",
            message,
          });
        }
      }),
    googleWorkspace: router({
      authorizationUrl: adminProcedure
        .input(z.object({
          capabilityIds: z.array(z.enum([
            "context.calendar.read",
            "context.document.read",
            "context.mail.read_scoped",
            "action.mail.draft.create",
          ])).min(1).max(4),
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
          returnOrigin: z.string().max(200).optional(),
        }))
        .mutation(({ ctx, input }) => createGoogleWorkspaceAuthorization({
          companyId: ctx.companyId,
          uid: ctx.uid,
          email: ctx.email,
          displayName: ctx.displayName,
          clientId: googleConnectorClientId.value(),
          capabilityIds: input.capabilityIds as SourceCapabilityId[],
          connectionId: input.connectionId,
          returnOrigin: input.returnOrigin,
        })),
    }),
    microsoft365: router({
      authorizationUrl: adminProcedure
        .input(z.object({
          capabilityIds: z.array(z.enum([
            "context.mail.read_scoped",
            "action.mail.draft.create",
          ])).max(1).default([]),
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
          returnOrigin: z.string().max(200).optional(),
        }))
        .mutation(({ ctx, input }) => createMicrosoftAuthorization({
          companyId: ctx.companyId,
          uid: ctx.uid,
          email: ctx.email,
          displayName: ctx.displayName,
          clientId: microsoftConnectorClientId.value(),
          credentialKey: connectorCredentialKey.value(),
          capabilityIds: input.capabilityIds as SourceCapabilityId[],
          connectionId: input.connectionId,
          returnOrigin: input.returnOrigin,
        })),
      refresh: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await refreshMicrosoftConnection({
              companyId: ctx.companyId,
              connectionId: input.connectionId,
              clientId: microsoftConnectorClientId.value(),
              clientSecret: microsoftConnectorClientSecret.value(),
              credentialKey: connectorCredentialKey.value(),
            });
          } catch (error) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    }),
    slack: router({
      authorizationUrl: adminProcedure
        .input(z.object({
          capabilityIds: z.array(z.enum([
            "action.chat.notify",
            "context.chat.direct",
          ])).min(1).max(2).default(["action.chat.notify"]),
          returnOrigin: z.string().max(200).optional(),
        }))
        .mutation(({ ctx, input }) => createSlackAuthorization({
          companyId: ctx.companyId,
          uid: ctx.uid,
          email: ctx.email,
          displayName: ctx.displayName,
          clientId: slackConnectorClientId.value(),
          capabilityIds: input.capabilityIds,
          returnOrigin: input.returnOrigin,
        })),
      channels: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .query(({ ctx, input }) => listSlackChannels({
          companyId: ctx.companyId,
          ...input,
          credentialKey: connectorCredentialKey.value(),
        })),
      select: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          channelIds: z.array(z.string().min(1).max(100)).max(20),
        }))
        .mutation(({ ctx, input }) => selectSlackChannels({
          companyId: ctx.companyId,
          ...input,
          actorUid: ctx.uid,
          credentialKey: connectorCredentialKey.value(),
        })),
      deliveries: adminProcedure
        .input(z.object({
          limit: z.number().int().min(1).max(200).default(100),
        }).optional())
        .query(({ ctx, input }) => listChatNotifications({
          companyId: ctx.companyId,
          limit: input?.limit,
        })),
      retryDelivery: adminProcedure
        .input(z.object({
          approvalId: z.string().min(1).max(200),
        }))
        .mutation(({ ctx, input }) => retryApprovalNotifications({
          companyId: ctx.companyId,
          approvalId: input.approvalId,
          appOrigin: productionAppOrigin,
          credentialKey: connectorCredentialKey.value(),
        })),
      linkPreview: enabledProcedure
        .input(z.object({ token: z.string().min(20).max(200) }))
        .query(async ({ ctx, input }) => {
          const link = await inspectSlackLink({
            token: input.token,
            companyId: ctx.companyId,
          });
          return {
            teamId: link.teamId,
            slackUserId: link.slackUserId,
            expiresAt: link.expiresAt.toDate().toISOString(),
          };
        }),
      linkIdentity: enabledProcedure
        .input(z.object({ token: z.string().min(20).max(200) }))
        .mutation(({ ctx, input }) => consumeSlackLink({
          token: input.token,
          companyId: ctx.companyId,
          uid: ctx.uid,
        })),
    }),
    googleCalendar: router({
      calendars: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .query(({ ctx, input }) => listGoogleCalendars({
          companyId: ctx.companyId,
          ...input,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
      select: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          calendarIds: z.array(z.string().min(1).max(1000)).max(50),
        }))
        .mutation(({ ctx, input }) => selectGoogleCalendars({
          companyId: ctx.companyId,
          ...input,
          actorUid: ctx.uid,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
      sync: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .mutation(({ ctx, input }) => syncGoogleCalendarConnection({
          companyId: ctx.companyId,
          ...input,
          trigger: "manual",
          requestedBy: ctx.uid,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
    }),
    googleMail: router({
      labels: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .query(({ ctx, input }) => listGmailLabels({
          companyId: ctx.companyId,
          ...input,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
      select: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          labelIds: z.array(z.string().min(1).max(1000)).max(50),
        }))
        .mutation(({ ctx, input }) => selectGmailLabels({
          companyId: ctx.companyId,
          ...input,
          actorUid: ctx.uid,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
      sync: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .mutation(({ ctx, input }) => syncGoogleGmailConnection({
          companyId: ctx.companyId,
          ...input,
          trigger: "manual",
          requestedBy: ctx.uid,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
    }),
    googleDrive: router({
      folders: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .query(({ ctx, input }) => listGoogleDriveFolders({
          companyId: ctx.companyId,
          ...input,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
      select: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          folderIds: z.array(z.string().min(1).max(1000)).max(50),
          confirmBroadening: z.boolean().default(false),
        }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await selectGoogleDriveFolders({
              companyId: ctx.companyId,
              ...input,
              actorUid: ctx.uid,
              clientId: googleConnectorClientId.value(),
              clientSecret: googleConnectorClientSecret.value(),
              credentialKey: connectorCredentialKey.value(),
            });
          } catch (error) {
            if (error instanceof DriveSelectionBroadeningError) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: error.code,
              });
            }
            throw error;
          }
        }),
      sync: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        }))
        .mutation(({ ctx, input }) => syncGoogleDriveConnection({
          companyId: ctx.companyId,
          ...input,
          trigger: "manual",
          requestedBy: ctx.uid,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        })),
    }),
    github: router({
      connectConfiguredInstallation: adminProcedure
        .mutation(({ ctx }) => connectGitHubInstallation({
          companyId: ctx.companyId,
          actorUid: ctx.uid,
          installationId: configuredGitHubInstallationId(),
          configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
        })),
      sync: adminProcedure
        .input(z.object({
          connectionId: z.string().regex(/^github_[0-9]{1,20}$/),
        }))
        .mutation(({ ctx, input }) => syncGitHubConnection({
          companyId: ctx.companyId,
          connectionId: input.connectionId,
          trigger: "manual",
          requestedBy: ctx.uid,
          configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
        })),
    }),
    replaySync: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      }))
      .mutation(async ({ ctx, input }) => {
        const run = await db.doc(
          `${companyDocumentPath(ctx.companyId, "connections", input.connectionId)}`
            + `/syncRuns/${input.runId}`,
        ).get();
        if (!run.exists) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Synchronization run not found" });
        }
        switch (run.data()?.serviceId) {
          case "calendar":
            return replayGoogleCalendarSyncRun({
              companyId: ctx.companyId,
              ...input,
              actorUid: ctx.uid,
              clientId: googleConnectorClientId.value(),
              clientSecret: googleConnectorClientSecret.value(),
              credentialKey: connectorCredentialKey.value(),
            });
          case "drive":
            return replayGoogleDriveSyncRun({
              companyId: ctx.companyId,
              ...input,
              actorUid: ctx.uid,
              clientId: googleConnectorClientId.value(),
              clientSecret: googleConnectorClientSecret.value(),
              credentialKey: connectorCredentialKey.value(),
            });
          case "mail":
            return replayGoogleGmailSyncRun({
              companyId: ctx.companyId,
              ...input,
              actorUid: ctx.uid,
              clientId: googleConnectorClientId.value(),
              clientSecret: googleConnectorClientSecret.value(),
              credentialKey: connectorCredentialKey.value(),
            });
          case "issues":
            return replayGitHubSyncRun({
              companyId: ctx.companyId,
              ...input,
              actorUid: ctx.uid,
              configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
            });
          default:
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This synchronization run cannot be replayed",
            });
        }
      }),
    grok: router({
      connect: adminProcedure.mutation(async ({ ctx }) => {
        try {
          return await startGrokAuthorization({
            companyId: ctx.companyId,
            actorUid: ctx.uid,
            action: "connect",
            executeJob: executeGrokAuthJob,
          });
        } catch (error) {
          if (error instanceof GrokAuthorizationError) {
            throw new TRPCError({
              code: error.statusCode === 409 ? "CONFLICT" : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
      status: adminProcedure
        .input(z.object({
          sessionId: z.string().regex(/^grok_[a-f0-9]{32}$/),
        }))
        .query(({ ctx, input }) => getGrokAuthorization({
          companyId: ctx.companyId,
          sessionId: input.sessionId,
        })),
      disconnect: adminProcedure.mutation(async ({ ctx }) => {
        try {
          return await startGrokAuthorization({
            companyId: ctx.companyId,
            actorUid: ctx.uid,
            action: "disconnect",
            executeJob: executeGrokAuthJob,
          });
        } catch (error) {
          if (error instanceof GrokAuthorizationError) {
            throw new TRPCError({
              code: error.statusCode === 404
                ? "NOT_FOUND"
                : error.statusCode === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST",
              message: error.message,
            });
          }
          throw error;
        }
      }),
    }),
    addOdorik: adminProcedure
      .mutation(async ({ ctx }) => {
        const username = `odorik-${randomBytes(5).toString("hex")}`;
        const password = randomBytes(24).toString("base64url");
        const credentialCiphertext = encryptCredentials({
          username,
          password,
        }, connectorCredentialKey.value());
        const connection = await createOdorikConnection({
          companyId: ctx.companyId,
          displayName: "Odorik",
          credentialCiphertext,
          usernameHint: username.slice(0, 10),
          createdBy: ctx.uid,
          numbers: [],
        });
        return {
          ...connection,
          setupUrl: odorikDestinationUrl(connection.uploadUrl, username, password),
        };
      }),
    getOdorikSetup: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      }))
      .mutation(({ ctx, input }) => getOdorikSetupDestination({
        companyId: ctx.companyId,
        connectionId: input.connectionId,
        credentialKey: connectorCredentialKey.value(),
      })),
    setConnectionStatus: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        status: z.enum(["active", "disconnected"]),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          await setConnectionStatus(ctx.companyId, input.connectionId, input.status, ctx.uid);
          return { ok: true };
        } catch (error) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    setCapabilityStatus: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        capabilityId: z.enum([
          "context.calendar.read",
          "context.document.read",
          "context.mail.read_scoped",
          "action.mail.draft.create",
        ]),
        enabled: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        await setCapabilityStatus({
          companyId: ctx.companyId,
          connectionId: input.connectionId,
          capabilityId: input.capabilityId,
          enabled: input.enabled,
          actorUid: ctx.uid,
        });
        return { ok: true };
      }),
    deleteConnection: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const prepared = await prepareConnectionDeletion(
            ctx.companyId,
            input.connectionId,
            ctx.uid,
          );
          let providerAccessRevoked: boolean | null = null;
          if (prepared.connectorId === "google_workspace") {
            try {
              providerAccessRevoked = await revokeGoogleWorkspaceAuthorization({
                companyId: ctx.companyId,
                connectionId: input.connectionId,
                credentialKey: connectorCredentialKey.value(),
              });
            } catch (error) {
              console.warn("Google OAuth revocation failed; deleting local credentials anyway", {
                connectionId: input.connectionId,
                error: error instanceof Error ? error.message : String(error),
              });
              providerAccessRevoked = false;
            }
          } else if (prepared.connectorId === "microsoft_365") {
            // Microsoft offers no least-privilege self-revocation endpoint. Removing
            // the local encrypted credential ends Erik's access immediately; tenant
            // admins can additionally remove consent in Entra/My Apps.
            providerAccessRevoked = null;
          } else if (prepared.connectorId === "slack") {
            providerAccessRevoked = await revokeSlackAuthorization({
              companyId: ctx.companyId,
              connectionId: input.connectionId,
              credentialKey: connectorCredentialKey.value(),
            });
          }
          return await deleteSourceConnection({
            companyId: ctx.companyId,
            ...input,
            ...prepared,
            actorUid: ctx.uid,
            providerAccessRevoked,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new TRPCError({
            code: message === "Connection not found" ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
            message,
          });
        }
      }),
    setResourceEnabled: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        resourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        enabled: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          await setResourceStatus({
            companyId: ctx.companyId,
            ...input,
            actorUid: ctx.uid,
          });
          if (!input.enabled) return { ok: true, sync: null };
          const connectionPath = companyDocumentPath(
            ctx.companyId,
            "connections",
            input.connectionId,
          );
          const [connection, resource] = await Promise.all([
            db.doc(connectionPath).get(),
            db.doc(`${connectionPath}/resources/${input.resourceId}`).get(),
          ]);
          const capabilityId = resource.data()?.capabilityId;
          if (connection.data()?.connectorId === "google_workspace") {
            if (capabilityId === "context.calendar.read") {
              const sync = await syncGoogleCalendarConnection({
                companyId: ctx.companyId,
                connectionId: input.connectionId,
                resourceIds: [input.resourceId],
                trigger: "selection",
                requestedBy: ctx.uid,
                clientId: googleConnectorClientId.value(),
                clientSecret: googleConnectorClientSecret.value(),
                credentialKey: connectorCredentialKey.value(),
              });
              return { ok: true, sync };
            }
            if (capabilityId === "context.document.read") {
              const sync = await syncGoogleDriveConnection({
                companyId: ctx.companyId,
                connectionId: input.connectionId,
                resourceIds: [input.resourceId],
                trigger: "selection",
                requestedBy: ctx.uid,
                clientId: googleConnectorClientId.value(),
                clientSecret: googleConnectorClientSecret.value(),
                credentialKey: connectorCredentialKey.value(),
              });
              return { ok: true, sync };
            }
          }
          if (
            connection.data()?.connectorId === "github"
            && capabilityId === "context.github.issue.read"
          ) {
            const sync = await syncGitHubConnection({
              companyId: ctx.companyId,
              connectionId: input.connectionId,
              resourceIds: [input.resourceId],
              trigger: "selection",
              requestedBy: ctx.uid,
              configuration: githubConfigurationFromEnvironment(githubAppPrivateKey.value()),
            });
            return { ok: true, sync };
          }
          return { ok: true, sync: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new TRPCError({
            code: message === "Connection resource not found" ? "NOT_FOUND" : "BAD_REQUEST",
            message,
          });
        }
      }),
    setResourceAudience: adminProcedure
      .input(z.object({
        connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        resourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        audience: z.discriminatedUnion("visibility", [
          z.object({ visibility: z.literal("company") }),
          z.object({
            visibility: z.literal("restricted"),
            memberIds: z.array(z.string().min(1).max(128)).min(1).max(200),
          }),
        ]),
        expectedRevision: z.number().int().positive(),
        confirmBroadening: z.boolean().default(false),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await setResourceAudience({
            companyId: ctx.companyId,
            actorUid: ctx.uid,
            ...input,
          });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new TRPCError({
            code: message === "Connection resource not found" ? "NOT_FOUND" : "BAD_REQUEST",
            message,
          });
        }
      }),
    migrateLegacyOdorik: adminProcedure.mutation(({ ctx }) => migrateLegacyOdorik(
      ctx.companyId,
      ctx.uid,
    )),
  }),

  assistant: router({
    status: enabledProcedure.query(() => ({
      model: "gemini-3.5-flash-lite",
      promptVersion: factAgentPromptVersion,
      search: qdrantConfigurationFromEnvironment()
        ? "qdrant_hybrid_rrf"
        : "unavailable",
      embeddingModel,
      embeddingDimensions,
      collection: qdrantCollection,
      synchronization: "firestore_on_write",
      readOnly: true,
    })),
    threads: enabledProcedure.query(async ({ ctx }) => {
      const snapshot = await db.collection(companyCollectionPath(ctx.companyId, "agentThreads"))
        .where("ownerUid", "==", ctx.uid)
        .limit(100)
        .get();
      return jsonSafe(snapshot.docs.map((document) => ({
        id: String(document.data().clientThreadId || document.id),
        title: String(document.data().title || "New chat"),
        lastMessageAt: document.data().lastMessageAt || null,
        createdAt: document.data().createdAt || null,
      })).sort((left, right) => (
        Number((right.lastMessageAt as { toMillis?: () => number } | null)?.toMillis?.() || 0)
        - Number((left.lastMessageAt as { toMillis?: () => number } | null)?.toMillis?.() || 0)
      )));
    }),
    createThread: enabledProcedure.mutation(async ({ ctx }) => {
      const threadId = `chat_${randomBytes(12).toString("hex")}`;
      const threadRef = db.doc(companyDocumentPath(
        ctx.companyId,
        "agentThreads",
        memberThreadDocumentId(ctx.uid, threadId),
      ));
      const now = Timestamp.now();
      await threadRef.create({
        ownerUid: ctx.uid,
        clientThreadId: threadId,
        title: "New chat",
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      });
      return { id: threadId, title: "New chat", createdAt: now.toDate().toISOString() };
    }),
    history: enabledProcedure
      .input(z.object({ threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default("general") }).optional())
      .query(async ({ ctx, input }) => {
        const threadId = input?.threadId || "general";
        const threadDocumentId = memberThreadDocumentId(ctx.uid, threadId);
        const snapshot = await db.collection(
          `${companyDocumentPath(ctx.companyId, "agentThreads", threadDocumentId)}/messages`,
        )
          .orderBy("createdAt", "desc")
          .limit(40)
          .get();
        // Rehydrate citation deep links from live context items so older answers
        // pick up improved source URLs (e.g. Gmail rfc822msgid) without a new ask.
        const messages = await Promise.all(snapshot.docs.reverse().map(async (document) => {
          const data = document.data();
          if (data.role !== "assistant" || !Array.isArray(data.citations)) {
            return { id: document.id, ...data };
          }
          return {
            id: document.id,
            ...data,
            citations: await rehydrateCitationPresentation(db, ctx.companyId, data.citations),
          };
        }));
        return jsonSafe(messages);
      }),
    ask: enabledProcedure
      .input(z.object({
        threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default("general"),
        question: z.string().trim().min(1).max(3000),
      }))
      .mutation(({ ctx, input }) => askCompanyFactAgent({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        threadId: input.threadId,
        question: input.question,
        geminiApiKey: geminiApiKey.value(),
      })),
    reindex: adminProcedure.mutation(async ({ ctx }) => {
      const apiKey = geminiApiKey.value();
      const repository = new FirestoreCompanyData(db, ctx.companyId);
      const { qdrant } = qdrantFromEnvironment({
        geminiApiKey: apiKey,
        companyId: ctx.companyId,
      });
      if (!qdrant) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "QDRANT_URL and QDRANT_API_KEY are not configured; company search is unavailable.",
        });
      }
      const documents = await repository.allDocuments();
      const indexed = await qdrant.replaceTenantDocuments(documents);
      return {
        indexed,
        collection: qdrantCollection,
        fusion: "rrf",
        dense: embeddingModel,
        dimensions: embeddingDimensions,
        sparse: "qdrant/bm25",
      };
      }),
    }),

  tasks: router({
    list: enabledProcedure
      .input(z.object({
        status: z.enum(["open", "completed", "dismissed"]).optional(),
        statuses: z.array(z.enum(["open", "completed", "dismissed"])).min(1).max(3).optional(),
        assigneeUid: z.string().min(1).max(128).optional(),
        contactId: z.string().min(1).max(200).optional(),
        caseId: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }).optional())
      .query(({ ctx, input }) => listTasks({
        companyId: ctx.companyId,
        memberUid: ctx.uid,
        ...(input || {}),
      })),
    create: enabledProcedure
      .input(z.object({
        title: z.string().trim().min(1).max(300),
        instructions: z.string().trim().max(5_000).optional(),
        assigneeUid: z.string().min(1).max(128),
        dueAt: z.string().datetime().nullable().optional(),
        contactId: z.string().min(1).max(200).nullable().optional(),
        caseId: z.string().min(1).max(200).nullable().optional(),
        callId: z.string().min(1).max(200).nullable().optional(),
      }))
      .mutation(({ ctx, input }) => createTask({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        ...input,
      })),
    update: enabledProcedure
      .input(z.object({
        taskId: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(300).optional(),
        instructions: z.string().trim().max(5_000).optional(),
        assigneeUid: z.string().min(1).max(128).optional(),
        dueAt: z.string().datetime().nullable().optional(),
      }))
      .mutation(({ ctx, input }) => updateTask({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        ...input,
      })),
    transition: enabledProcedure
      .input(z.object({
        taskId: z.string().min(1).max(200),
        to: z.enum(["open", "completed", "dismissed"]),
        note: z.string().trim().max(2_000).optional(),
      }))
      .mutation(({ ctx, input }) => transitionTask({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        ...input,
      })),
  }),

  approvals: router({
    get: enabledProcedure
      .input(z.object({ approvalId: z.string().min(1).max(200) }))
      .query(({ ctx, input }) => getActionApproval({
        companyId: ctx.companyId,
        memberUid: ctx.uid,
        approvalId: input.approvalId,
      })),
    list: enabledProcedure
      .input(z.object({
        status: z.enum([
          "pending",
          "executing",
          "approved",
          "rejected",
          "execution_failed",
        ]).optional(),
        statuses: z.array(z.enum([
          "pending",
          "executing",
          "approved",
          "rejected",
          "execution_failed",
        ])).min(1).max(5).optional(),
        approverUid: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }).optional())
      .query(({ ctx, input }) => listActionApprovals({
        companyId: ctx.companyId,
        memberUid: ctx.uid,
        ...(input || {}),
      })),
    approve: enabledProcedure
      .input(z.object({ approvalId: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }) => approveAction({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        approvalId: input.approvalId,
      })),
    reject: enabledProcedure
      .input(z.object({
        approvalId: z.string().min(1).max(200),
        note: z.string().trim().max(2_000).optional(),
      }))
      .mutation(({ ctx, input }) => rejectAction({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        approvalId: input.approvalId,
        note: input.note,
      })),
    /**
     * Reconcile an outcome_unknown mail.draft.create attempt: look up the draft
     * by Erik's Message-ID marker without creating a second one.
     */
    reconcileMailDraft: enabledProcedure
      .input(z.object({ approvalId: z.string().min(1).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const { reconcileMailDraftApproval } = await import("./mail/reconcile-approval.js");
        return reconcileMailDraftApproval({
          companyId: ctx.companyId,
          actorUid: ctx.uid,
          approvalId: input.approvalId,
          clientId: googleConnectorClientId.value(),
          clientSecret: googleConnectorClientSecret.value(),
          credentialKey: connectorCredentialKey.value(),
        });
      }),
  }),

  pipeline: router({
    get: enabledProcedure.query(({ ctx }) => getPipeline(ctx.companyId)),
    update: adminProcedure
      .input(z.object({
        expectedRevision: z.number().int().nonnegative(),
        name: z.string().trim().min(1).max(100),
        initialStageId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        stages: z.array(z.object({
          id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
          name: z.string().trim().min(1).max(100),
          position: z.number().int().nonnegative(),
          color: z.string().min(1).max(30),
          terminal: z.boolean(),
          archived: z.boolean(),
        })).min(1).max(20),
      }))
      .mutation(({ ctx, input }) => updatePipeline({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        ...input,
      })),
  }),

  cases: router({
    list: enabledProcedure
      .input(z.object({
        contactId: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }).optional())
      .query(({ ctx, input }) => listCases({
        companyId: ctx.companyId,
        memberUid: ctx.uid,
        ...(input || {}),
      })),
    get: enabledProcedure
      .input(z.object({ caseId: z.string().min(1).max(200) }))
      .query(({ ctx, input }) => getCaseDetails({
        companyId: ctx.companyId,
        caseId: input.caseId,
        memberUid: ctx.uid,
      })),
    create: enabledProcedure
      .input(z.object({
        title: z.string().trim().min(1).max(300),
        contactId: z.string().min(1).max(200),
        ownerUid: z.string().min(1).max(128),
        stageId: z.string().min(1).max(100).optional(),
      }))
      .mutation(({ ctx, input }) => createCase({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        ...input,
      })),
    move: enabledProcedure
      .input(z.object({
        caseId: z.string().min(1).max(200),
        stageId: z.string().min(1).max(100),
        expectedRevision: z.number().int().nonnegative(),
        expectedStageId: z.string().min(1).max(100),
      }))
      .mutation(({ ctx, input }) => moveCase({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        ...input,
      })),
    archive: enabledProcedure
      .input(z.object({ caseId: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }) => archiveCase({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        caseId: input.caseId,
      })),
  }),

  workflows: router({
    list: enabledProcedure.query(({ ctx }) => listWorkflows(ctx.companyId)),
    get: enabledProcedure
      .input(z.object({ workflowId: z.string().min(1).max(200) }))
      .query(({ ctx, input }) => getWorkflow(ctx.companyId, input.workflowId)),
    create: enabledProcedure
      .input(z.object({ name: z.string().trim().max(200).optional() }).optional())
      .mutation(({ ctx, input }) => createWorkflowDraft({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        name: input?.name,
      })),
    save: enabledProcedure
      .input(z.object({
        workflowId: z.string().min(1).max(200),
        spec: z.unknown(),
      }))
      .mutation(({ ctx, input }) => saveWorkflowDraft({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        workflowId: input.workflowId,
        spec: input.spec as WorkflowSpec,
      })),
    enable: enabledProcedure
      .input(z.object({ workflowId: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }) => enableWorkflow({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        workflowId: input.workflowId,
      })),
    pause: enabledProcedure
      .input(z.object({ workflowId: z.string().min(1).max(200) }))
      .mutation(({ ctx, input }) => pauseWorkflow({
        companyId: ctx.companyId,
        actorUid: ctx.uid,
        workflowId: input.workflowId,
      })),
    dryRun: enabledProcedure
      .input(z.object({
        workflowId: z.string().min(1).max(200),
        spec: z.unknown().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }))
      .mutation(({ ctx, input }) => dryRunHistory({
        companyId: ctx.companyId,
        memberUid: ctx.uid,
        workflowId: input.workflowId,
        spec: input.spec as WorkflowSpec | undefined,
        limit: input.limit,
      })),
    health: enabledProcedure.query(async ({ ctx }) => ({
      flags: workflowRuntimeFlags(),
      ...await workflowHealth(ctx.companyId, ctx.uid),
    })),
  }),

  contacts: router({
    list: enabledProcedure
      .input(z.object({ limit: z.number().int().min(1).max(50).default(30) }).optional())
      .query(async ({ ctx, input }) => {
        const snapshot = await db.collection(
          companyCollectionPath(ctx.companyId, "contacts"),
        )
          .orderBy("updatedAt", "desc")
          .limit(input?.limit || 30)
          .get();
        return jsonSafe(snapshot.docs
          .filter((document) => canMemberAccessSourceData(document.data(), ctx.uid))
          .map((document) => ({ id: document.id, ...document.data() })));
      }),
    get: enabledProcedure
      .input(z.object({ contactId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const [snapshot, calls, cases, tasks] = await Promise.all([
          db.doc(companyDocumentPath(ctx.companyId, "contacts", input.contactId)).get(),
          db.collection(companyCollectionPath(ctx.companyId, "calls"))
            .where("contactId", "==", input.contactId).limit(50).get(),
          listCases({
            companyId: ctx.companyId,
            memberUid: ctx.uid,
            contactId: input.contactId,
            limit: 50,
          }),
          listTasks({
            companyId: ctx.companyId,
            memberUid: ctx.uid,
            contactId: input.contactId,
            limit: 100,
          }),
        ]);
        if (
          !snapshot.exists
          || !canMemberAccessSourceData(snapshot.data() || {}, ctx.uid)
        ) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
        return jsonSafe({
          contact: { id: snapshot.id, ...snapshot.data()! },
          calls: calls.docs
            .filter((document) => canMemberAccessSourceData(document.data(), ctx.uid))
            .sort((a, b) => String(b.data().odorikTime || b.data().uploadedAt || "")
              .localeCompare(String(a.data().odorikTime || a.data().uploadedAt || "")))
            .map((document) => ({ id: document.id, ...document.data() })),
          cases,
          tasks,
        });
      }),

    /**
     * Record an email address against a contact.
     *
     * Calls only ever supply a phone number, so this is the sole way an address
     * reaches a contact — and therefore the only way a workflow can address a
     * draft to the person who rang. Storing it is not consent to write to it:
     * every draft still names an approver and stops at a proposal.
     */
    update: enabledProcedure
      .input(z.object({
        contactId: z.string().min(1).max(200),
        email: z.string().trim().email().max(320).nullable(),
      }))
      .mutation(async ({ ctx, input }) => {
        const ref = db.doc(companyDocumentPath(ctx.companyId, "contacts", input.contactId));
        const snapshot = await ref.get();
        if (
          !snapshot.exists
          || !canMemberAccessSourceData(snapshot.data() || {}, ctx.uid)
        ) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });

        const now = Timestamp.now();
        const email = input.email ? normalizeInvitationEmail(input.email) : null;
        const previous = snapshot.data()?.email || null;
        if (email === previous) return jsonSafe({ id: snapshot.id, email });

        await ref.set({
          email,
          emailUpdatedBy: ctx.uid,
          emailUpdatedAt: now,
          updatedAt: now,
        }, { merge: true });

        await db.collection(companyCollectionPath(ctx.companyId, "auditEvents")).add({
          objectType: "audit_event",
          type: "contact_email_updated",
          contactId: input.contactId,
          // The addresses themselves stay on the contact; the trail records that
          // someone set or cleared one, not a second copy of the value.
          hadEmail: Boolean(previous),
          hasEmail: Boolean(email),
          actorUid: ctx.uid,
          createdAt: now,
        });

        return jsonSafe({ id: snapshot.id, email });
      }),
  }),

});

export type AppRouter = typeof appRouter;
