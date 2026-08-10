import { Hono } from "hono";
import { ZodError } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { zOrgSettingsUpdate, zApprovalRouting } from "@sentire-books/domain";
import { withOrgContext, orgSettings, documentCounters } from "@sentire-books/db";
import { requireAuth } from "../auth";
import { reportError } from "../observability";

export const settingsRoutes = new Hono();

settingsRoutes.use("*", requireAuth);

// Org settings: company profile (name/logo/notedBy), approval routing, doc
// numbering. Read by any member (PDF headers, signatories); written by admins.
settingsRoutes.get("/", async (c) => {
  const auth = c.get("auth");
  const [row] = await withOrgContext(
    { userId: auth.userId, orgId: auth.orgId, role: auth.role },
    (tx) => tx.select().from(orgSettings).where(eq(orgSettings.orgId, auth.orgId)),
  );
  // Reads stay LENIENT: a legacy or unrecognised blob is returned as-is with a
  // validity flag, never a 500. The typed schema (M3.1) only gates WRITES.
  const ar = row?.approvalRouting ?? null;
  const approvalRoutingValid = ar === null ? null : zApprovalRouting.safeParse(ar).success;
  return c.json({
    profile: row?.profile ?? null,
    approvalRouting: ar,
    approvalRoutingValid,
    ...(approvalRoutingValid === false
      ? { approvalRoutingWarning: "Stored approval_routing does not match the typed schema; returned unvalidated." }
      : {}),
    docNumbering: row?.docNumbering ?? null,
    modulePolicies: row?.modulePolicies ?? null,
  });
});

settingsRoutes.put("/", async (c) => {
  const auth = c.get("auth");
  if (auth.role !== "admin") {
    return c.json({ error: "forbidden", detail: "Admin role required" }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  try {
    const input = zOrgSettingsUpdate.parse(body);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.profile !== undefined) set.profile = input.profile;
    if (input.approvalRouting !== undefined) set.approvalRouting = input.approvalRouting;
    if (input.docNumbering !== undefined) set.docNumbering = input.docNumbering;
    if (input.modulePolicies !== undefined) set.modulePolicies = input.modulePolicies;

    const [row] = await withOrgContext(
      { userId: auth.userId, orgId: auth.orgId, role: auth.role },
      (tx) =>
        tx
          .insert(orgSettings)
          .values({ orgId: auth.orgId, ...set })
          .onConflictDoUpdate({ target: orgSettings.orgId, set })
          .returning(),
    );
    return c.json({
      profile: row?.profile ?? null,
      approvalRouting: row?.approvalRouting ?? null,
      docNumbering: row?.docNumbering ?? null,
      modulePolicies: row?.modulePolicies ?? null,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json({ error: "validation_error", issues: err.issues }, 400);
    }
    reportError(c, "updateSettings", err);
    return c.json({ error: "internal_error" }, 500);
  }
});

// ── Document counters (admin) ─────────────────────────────────────────────────
// The Settings screen shows each period's last-issued sequence and lets an
// admin override it (e.g. after importing legacy documents). Numbering itself
// happens atomically in the create endpoints; these are inspection/override.
settingsRoutes.get("/counters", async (c) => {
  const auth = c.get("auth");
  if (auth.role !== "admin") {
    return c.json({ error: "forbidden", detail: "Admin role required" }, 403);
  }
  const rows = await withOrgContext(
    { userId: auth.userId, orgId: auth.orgId, role: auth.role },
    (tx) =>
      tx
        .select()
        .from(documentCounters)
        .where(eq(documentCounters.orgId, auth.orgId))
        .orderBy(asc(documentCounters.periodKey)),
  );
  return c.json({ counters: rows });
});

const zCounterOverride = z.object({ seq: z.number().int().min(0) });
settingsRoutes.put("/counters/:periodKey", async (c) => {
  const auth = c.get("auth");
  if (auth.role !== "admin") {
    return c.json({ error: "forbidden", detail: "Admin role required" }, 403);
  }
  const periodKey = c.req.param("periodKey");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  try {
    const { seq } = zCounterOverride.parse(body);
    const rows = (await withOrgContext(
      { userId: auth.userId, orgId: auth.orgId, role: auth.role },
      (tx) =>
        tx.execute(sql`
          INSERT INTO document_counters (org_id, period_key, seq)
          VALUES (${auth.orgId}, ${periodKey}, ${seq})
          ON CONFLICT (org_id, period_key)
          DO UPDATE SET seq = ${seq}
          RETURNING period_key, seq
        `),
    )) as unknown as Array<{ period_key: string; seq: number }>;
    return c.json({ counter: { periodKey: rows[0]!.period_key, seq: Number(rows[0]!.seq) } });
  } catch (err) {
    if (err instanceof ZodError) return c.json({ error: "validation_error", issues: err.issues }, 400);
    reportError(c, "counterOverride", err);
    return c.json({ error: "internal_error" }, 500);
  }
});
