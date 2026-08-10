/**
 * Operations domain: checkbooks, the check registry, disbursement reports, and
 * org settings. These are operational documents (not ledger primitives) — jsonb
 * carries report snapshots/config faithfully; money is integer centavos.
 */
import { z } from "zod";

const optionalTrimmed = (max: number) => z.string().trim().max(max).optional();
const nullableTrimmed = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

// ── Checkbooks ────────────────────────────────────────────────────────────────
export const zCheckbookInput = z.object({
  bankCode: z.string().trim().min(1, "Bank is required").max(40),
  checkbookType: optionalTrimmed(20),
  startingNumber: z.string().trim().min(1, "Starting series required").max(20),
  endingNumber: nullableTrimmed(20),
  checksCount: z.number().int().positive().nullable().optional(),
  nextCheckNumber: nullableTrimmed(20),
  isActive: z.boolean().default(true),
  notes: nullableTrimmed(2000),
});
export type CheckbookInput = z.infer<typeof zCheckbookInput>;
export const zCheckbookUpdate = zCheckbookInput.partial();
export type CheckbookUpdate = z.infer<typeof zCheckbookUpdate>;

// ── Check registry ────────────────────────────────────────────────────────────
export const CHECK_STATUSES = ["Issued", "Cleared", "Voided", "Stopped", "Stale"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const zCheckInput = z.object({
  checkNo: optionalTrimmed(40), // server-assigned when absent
  checkbookId: z.string().uuid().nullable().optional(),
  bankCode: optionalTrimmed(40),
  checkNumber: z.string().trim().min(1, "Check number required").max(20),
  checkDate: isoDate.nullable().optional(),
  issueDate: isoDate.nullable().optional(),
  payeeName: optionalTrimmed(200),
  amountCents: z.number().int().positive(),
  netAmountCents: z.number().int().nonnegative().nullable().optional(),
  referenceType: nullableTrimmed(40),
  referenceId: nullableTrimmed(80),
  voucherId: z.string().uuid().nullable().optional(),
  journalEntryId: z.string().uuid().nullable().optional(),
  isPartOfMultiple: z.boolean().optional(),
  lineNo: z.number().int().positive().nullable().optional(),
  notes: nullableTrimmed(2000),
  meta: z.record(z.unknown()).nullable().optional(),
});
export type CheckInput = z.infer<typeof zCheckInput>;
export const zCheckUpdate = zCheckInput.partial();
export type CheckUpdate = z.infer<typeof zCheckUpdate>;

export const zCheckStatusUpdate = z.object({
  status: z.enum(CHECK_STATUSES),
  date: isoDate.optional(),
  reason: optionalTrimmed(500),
});

// ── Disbursement reports ──────────────────────────────────────────────────────
export const DISBURSEMENT_STATUSES = [
  "Pending",
  "For Verification",
  "Verified",
  "For Approval",
  "Approved",
  "Rejected",
  "In Disbursement",
  "Disbursed",
  "Voided",
] as const;
export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number];

export const zDisbursementLine = z
  .object({
    // The portal keeps its human voucher number in voucherId and the Postgres
    // uuid in voucherDocId; the server parks/reverts by whichever is uuid-shaped.
    voucherId: z.string().max(80).nullable().optional(),
    voucherDocId: z.string().uuid().nullable().optional(),
    voucherNo: optionalTrimmed(40),
    amountCents: z.number().int().nonnegative().optional(),
  })
  .passthrough(); // report lines are a snapshot — keep whatever the UI adds

export const zDisbursementReportInput = z.object({
  reportDate: isoDate,
  bankCode: optionalTrimmed(40),
  totalCents: z.number().int().nonnegative().default(0),
  expectedCollectionCents: z.number().int().nonnegative().default(0),
  notes: nullableTrimmed(4000),
  bankBalances: z.unknown().nullable().optional(),
  lines: z.array(zDisbursementLine).default([]),
  meta: z.record(z.unknown()).nullable().optional(),
});
export type DisbursementReportInput = z.infer<typeof zDisbursementReportInput>;
export const zDisbursementReportUpdate = zDisbursementReportInput.partial();
export type DisbursementReportUpdate = z.infer<typeof zDisbursementReportUpdate>;

export const zDisbursementStatusUpdate = z.object({
  status: z.enum(DISBURSEMENT_STATUSES),
  reason: optionalTrimmed(500),
});

// ── Approval routing (M3.1) ──────────────────────────────────────────────────
// Typed parser for org_settings.approval_routing. The store stays jsonb; this is
// what the server applies on PUT /settings so garbage stops being storable
// (previously `z.record(z.unknown())` — anything saved). The shape mirrors
// EXACTLY what the Settings screen writes today — routes + delegates, the
// portal's own field names and its five document-type labels
// (MILESTONE-3-PROPOSAL.md §2:93-100) — so no existing portal save breaks.
// Objects strip unknown keys rather than rejecting them, keeping the settings
// screen alive on any older stored row while still validating types/enums/emails.
// The `voucher | journal_entry` vocabulary is the M3.2 resolver's internal
// mapping target (§2:177), NOT the stored routing label — these stay portal
// labels. New M3 fields are optional; nothing honors them until M3.2/M3.3.
export const ROUTING_DOCUMENT_TYPES = [
  "Vouchers",
  "Check Voucher",
  "Journal",
  "Weekly Projections",
  "Disbursements",
] as const;
export type RoutingDocumentType = (typeof ROUTING_DOCUMENT_TYPES)[number];

const lc = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
const zEmail = z.preprocess(lc, z.string().email("must be a valid email address"));
const zEmailOrBlank = z.preprocess(
  lc,
  z.string().refine((s) => s === "" || z.string().email().safeParse(s).success, {
    message: "must be a valid email address or blank",
  }),
);
const zIsoDateOrBlank = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.string().refine((s) => s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s), {
    message: "date must be YYYY-MM-DD or blank",
  }),
);

export const zApprovalRoute = z.object({
  id: z.string().min(1),
  documentType: z.enum(ROUTING_DOCUMENT_TYPES),
  makerEmail: zEmail,
  verifierEmail: zEmailOrBlank.default(""),
  approverEmail: zEmail,
  autoBypass: z.boolean().default(false),
});
export type ApprovalRoute = z.infer<typeof zApprovalRoute>;

export const zApprovalDelegate = z.object({
  id: z.string().min(1),
  delegatorEmail: zEmail,
  delegateEmail: zEmail,
  documentTypes: z.array(z.enum(ROUTING_DOCUMENT_TYPES)).default([]),
  fromDate: zIsoDateOrBlank.default(""),
  toDate: zIsoDateOrBlank.default(""),
  isActive: z.boolean().default(true),
});
export type ApprovalDelegate = z.infer<typeof zApprovalDelegate>;

export const zApprovalRouting = z
  .object({
    routes: z.array(zApprovalRoute).default([]),
    delegates: z.array(zApprovalDelegate).default([]),
    // Typed now, honored later (M3.2/M3.3). Optional so the current portal
    // payload — which omits them — validates unchanged.
    singleOperatorMode: z.boolean().optional(),
    strictMode: z.boolean().optional(),
    requireVerification: z.boolean().optional(),
  })
  // Strict at the TOP level so a wholesale-wrong blob (e.g. a legacy shape with
  // none of these keys) is flagged unvalidated on read, instead of silently
  // passing as "empty routing". Sub-objects stay strip-mode: an older stored
  // route carrying an extra field is normalised, never rejected, so the portal
  // (which re-sends whole route objects via `{...route}`) can never be 400'd.
  .strict();
export type ApprovalRouting = z.infer<typeof zApprovalRouting>;

// ── Org settings ─────────────────────────────────────────────────────────────
export const zOrgSettingsUpdate = z.object({
  profile: z.record(z.unknown()).nullable().optional(),
  approvalRouting: zApprovalRouting.nullable().optional(),
  docNumbering: z.record(z.unknown()).nullable().optional(),
  modulePolicies: z.record(z.unknown()).nullable().optional(),
});
export type OrgSettingsUpdate = z.infer<typeof zOrgSettingsUpdate>;

// ── Payment terms (Settings reference data) ──────────────────────────────────
export const zPaymentTermInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  days: z.number().int().min(0).max(3650).default(0),
  description: nullableTrimmed(500),
});
export const zPaymentTermUpdate = zPaymentTermInput.partial();
