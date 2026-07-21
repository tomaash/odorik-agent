import { z } from "zod";

export const proposalFieldSchema = z.enum([
  "contactName",
  "requestTitle",
  "serviceType",
  "description",
  "address",
  "requestedTiming",
  "urgency",
  "notes",
]);

export type ProposalField = z.infer<typeof proposalFieldSchema>;

export const evidenceSchema = z.object({
  segmentIndex: z.number().int().nonnegative(),
  quote: z.string().min(1).max(500),
});

export const fieldProposalSchema = z.object({
  field: proposalFieldSchema,
  value: z.string().min(1).max(4000),
  support: z.enum(["explicit", "inferred"]),
  evidence: z.array(evidenceSchema).max(5),
});

export const extractionSchema = z.object({
  proposals: z.array(fieldProposalSchema).max(24),
  missingInformation: z.array(z.string().min(1).max(300)).max(20),
});

export type FieldProposal = z.infer<typeof fieldProposalSchema>;
export type ExtractionResult = z.infer<typeof extractionSchema>;

export const reviewInputSchema = z.object({
  requestId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  contact: z.object({
    displayName: z.string().trim().max(300).optional(),
    email: z.string().trim().email().max(320).optional().or(z.literal("")),
  }),
  request: z.object({
    title: z.string().trim().min(1).max(300),
    serviceType: z.string().trim().max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    address: z.string().trim().max(1000).optional(),
    requestedTiming: z.string().trim().max(500).optional(),
    urgency: z.enum(["normal", "urgent"]),
    notes: z.string().trim().max(5000).optional(),
    missingInformation: z.array(z.string().trim().min(1).max(300)).max(20),
  }),
  decisions: z.array(z.object({
    field: proposalFieldSchema,
    decision: z.enum(["accepted", "corrected", "rejected"]),
    originalValue: z.string().max(4000).optional(),
    finalValue: z.string().max(4000).optional(),
  })).max(24),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;
