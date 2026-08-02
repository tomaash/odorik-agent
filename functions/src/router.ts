import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { defineSecret } from "firebase-functions/params";
import { db, jsonSafe } from "./firestore.js";
import { canMemberAccessSourceData } from "./access.js";
import { adminProcedure, enabledProcedure, router, signedInProcedure } from "./trpc.js";
import { GeminiRestAgentModel } from "./agent/gemini.js";
import { runFactAgent, factAgentPromptVersion } from "./agent/loop.js";
import { FirestoreCompanyData } from "./agent/knowledge.js";
import {
  embeddingDimensions,
  embeddingModel,
  qdrantCollection,
  qdrantConfigurationFromEnvironment,
  qdrantFromEnvironment,
} from "./agent/search.js";
import { CompanyFactTools } from "./agent/tools.js";
import { memberThreadDocumentId } from "./agent/threads.js";
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
  listActionApprovals,
  rejectAction,
} from "./approvals/repository.js";
import { encryptCredentials } from "./connectors/credentials.js";
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
  createGoogleWorkspaceAuthorization,
  revokeGoogleWorkspaceAuthorization,
} from "./connectors/google-oauth.js";
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
          ])).min(1).max(2),
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
        return jsonSafe(snapshot.docs.reverse().map((document) => ({ id: document.id, ...document.data() })));
      }),
    ask: enabledProcedure
      .input(z.object({
        threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default("general"),
        question: z.string().trim().min(1).max(3000),
      }))
      .mutation(async ({ ctx, input }) => {
        const threadRef = db.doc(
          companyDocumentPath(
            ctx.companyId,
            "agentThreads",
            memberThreadDocumentId(ctx.uid, input.threadId),
          ),
        );
        const messagesRef = threadRef.collection("messages");
        const [threadSnapshot, historySnapshot] = await Promise.all([
          threadRef.get(),
          messagesRef.orderBy("createdAt", "desc").limit(8).get(),
        ]);
        const priorMessages = historySnapshot.docs.reverse().flatMap((document) => {
          const data = document.data();
          const role = data.role === "assistant" ? "model" as const : data.role === "user" ? "user" as const : null;
          const text = typeof data.text === "string"
            ? data.text.replace(/\[C\d+(?:\s*,\s*C\d+)*\]/g, "[previous sources omitted; re-check with tools]")
            : "";
          return role && text ? [{ role, text }] : [];
        });
        const apiKey = geminiApiKey.value();
        const repository = new FirestoreCompanyData(db, ctx.companyId, ctx.uid);
        const { search } = qdrantFromEnvironment({
          geminiApiKey: apiKey,
          companyId: ctx.companyId,
          memberId: ctx.uid,
        });
        const tools = new CompanyFactTools(repository, search);
        const startedAt = Date.now();
        const answer = await runFactAgent({
          question: input.question,
          model: new GeminiRestAgentModel(apiKey),
          tools,
          priorMessages,
        });
        const userAt = Timestamp.now();
        const answerAt = Timestamp.fromMillis(userAt.toMillis() + 1);
        const userMessageRef = messagesRef.doc();
        const answerMessageRef = messagesRef.doc();
        const runRef = db.collection(
          companyCollectionPath(ctx.companyId, "agentRuns"),
        ).doc();
        const batch = db.batch();
        batch.set(threadRef, {
          ownerUid: ctx.uid,
          clientThreadId: input.threadId,
          ...(!threadSnapshot.exists || !threadSnapshot.data()?.lastMessageAt ? {
            title: input.question.slice(0, 80),
          } : {}),
          ...(threadSnapshot.exists ? {} : {
            createdAt: userAt,
          }),
          updatedAt: answerAt,
          lastMessageAt: answerAt,
        }, { merge: true });
        batch.set(userMessageRef, {
          role: "user",
          text: input.question,
          actorUid: ctx.uid,
          createdAt: userAt,
        });
        const safeCitations = jsonSafe(answer.citations);
        batch.set(answerMessageRef, {
          role: "assistant",
          text: answer.answer,
          citations: safeCitations,
          confidence: answer.confidence,
          limitations: answer.limitations,
          runId: runRef.id,
          actorUid: ctx.uid,
          createdAt: answerAt,
        });
        batch.set(runRef, {
          kind: "fact_agent",
          companyId: ctx.companyId,
          threadId: input.threadId,
          question: input.question,
          answer: answer.answer,
          citations: safeCitations,
          confidence: answer.confidence,
          limitations: answer.limitations,
          toolTrace: jsonSafe(answer.toolTrace),
          usage: answer.usage,
          model: "gemini-3.5-flash-lite",
          promptVersion: factAgentPromptVersion,
          actorUid: ctx.uid,
          latencyMs: Date.now() - startedAt,
          createdAt: answerAt,
        });
        await batch.commit();
        return { ...answer, runId: runRef.id, messageId: answerMessageRef.id };
      }),
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
  }),

});

export type AppRouter = typeof appRouter;
