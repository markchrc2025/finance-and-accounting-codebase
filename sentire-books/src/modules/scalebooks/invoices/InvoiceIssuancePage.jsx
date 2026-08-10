// Invoice Issuance (Track B B2).
//
// The first screen of the revenue flow: create/edit a draft service invoice,
// review the journal entry it will post, then issue it. Issuing posts
//   DR Trade Receivable / CR Revenue / CR Output Tax (vatable only)
// through the API — there is NO EWT line at issuance (withholding is recognised
// at COLLECTION from the payor's 2307, on the collections screen).
//
// MONEY DISCIPLINE (R38/R39): the browser performs NO money arithmetic that
// could become a second source of truth. It never computes the net/VAT split,
// never sums the journal entry, never decides whether it balances. Those values
// come verbatim from server responses:
//   • net / VAT / gross — from the invoice the server returns on save,
//   • the DR/CR lines, totals and `balanced` flag — from the issue-preview
//     endpoint (a SEAM; see api.previewInvoiceIssuance) or, after commit, from
//     the issue response's posted `lines`.
// The only scaling here is centavos→pesos for display (`pesos()`), the same
// presentation convention every portal screen uses; it derives no money value.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ContactPicker from '../../../components/ContactPicker.jsx';
import AccountCombobox from '../../../components/AccountCombobox.jsx';
import { MoneyText } from '../../../components/common/MoneyText.jsx';
import { StatusPill } from '../../../components/common/StatusPill.jsx';
import {
  listContacts,
  listAccounts,
  serviceInvoicesApi,
  issueInvoice,
  previewInvoiceIssuance,
  ApiError,
} from '../../../lib/api.js';

// VAT treatments, mirroring the domain enum. Labels only — the server owns the
// arithmetic each one implies.
const TREATMENTS = [
  { value: 'none', label: 'Non-VAT (Sec. 116)' },
  { value: 'vatable', label: 'VATable (12% output tax)' },
  { value: 'exempt', label: 'VAT-exempt' },
  { value: 'zero_rated', label: 'Zero-rated (0%)' },
];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Request-boundary ONLY: turn a peso string the user typed into integer
 * centavos for the API. Never used to derive a value the screen displays.
 */
function centsFromPeso(str) {
  const n = Number.parseFloat(String(str ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Presentation unit only (centavos→pesos), matching every other portal screen. */
function pesos(cents) {
  return (Number(cents) || 0) / 100;
}

/** Pull a bookkeeper-actionable message out of any ApiError the contract returns. */
function messageFor(err) {
  if (!(err instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  const body = err.body || {};
  // Zod validation — surface the field messages, not just "validation_error".
  if (body.error === 'validation_error' && Array.isArray(body.issues)) {
    return body.issues
      .map((i) => {
        const path =
          Array.isArray(i.path) && i.path.length ? `${i.path.join('.')}: ` : '';
        return `${path}${i.message}`;
      })
      .join(' · ');
  }
  // Every meaningful issuance failure carries a human `detail`.
  return body.detail || body.error || `Request failed (${err.status}).`;
}

export default function InvoiceIssuancePage() {
  const navigate = useNavigate();

  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);

  // Draft form — raw user inputs. Money fields hold peso strings.
  const [form, setForm] = useState({
    contactId: null,
    contactName: '',
    siDate: today(),
    dueDate: '',
    amount: '', // gross pesos, as typed
    vat: '', // output VAT pesos, as typed (vatable only)
    vatTreatment: 'none',
    incomeAccountCode: '',
    arAccountCode: '',
    outputVatAccountCode: '',
    notes: '',
  });

  // The server's copy of the saved draft (authoritative net/vat/amount live here).
  const [invoice, setInvoice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState(null);

  // Journal-entry preview / posted result.
  //   null                      → not reviewed yet
  //   {status:'loading'}        → calling the seam
  //   {status:'ready', data}    → server preview (before commit)
  //   {status:'unavailable'}    → seam endpoint not deployed (honest fallback)
  //   {status:'error', message} → preview rejected (e.g. accounts_unset)
  const [preview, setPreview] = useState(null);
  const [posted, setPosted] = useState(null); // {journalEntryNo, lines} after issue

  useEffect(() => {
    let alive = true;
    listContacts('Customer')
      .then((c) => alive && setContacts(c || []))
      .catch(() => alive && setContacts([]));
    listAccounts()
      .then((a) => alive && setAccounts(a || []))
      .catch(() => alive && setAccounts([]));
    return () => {
      alive = false;
    };
  }, []);

  const accountName = useMemo(() => {
    const byCode = new Map((accounts || []).map((a) => [a.code, a.name]));
    return (code) => byCode.get(code) || null;
  }, [accounts]);

  const isVatable = form.vatTreatment === 'vatable';

  // Editing any field invalidates a prior review — you must re-see the entry
  // before committing what you just changed.
  function patch(next) {
    setForm((f) => ({ ...f, ...next }));
    setInvoice(null);
    setPreview(null);
    setPosted(null);
    setError(null);
  }

  // Client-side gate only decides whether to ATTEMPT a save; the server is the
  // authority on validity. No money math here — presence checks only.
  const canSave =
    !!form.contactName.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.siDate) &&
    centsFromPeso(form.amount) > 0;

  const reviewed = preview !== null && preview.status !== 'loading';
  const isIssued = invoice?.status === 'Issued' || !!posted;

  function buildDraftPayload() {
    // Send the two user-entered money inputs; the server derives netCents and
    // validates the identity. The browser sends no computed net.
    const amountCents = centsFromPeso(form.amount);
    const vatCents = isVatable ? centsFromPeso(form.vat) : 0;
    return {
      contactId: form.contactId || null,
      contactName: form.contactName.trim(),
      siDate: form.siDate,
      dueDate: form.dueDate || null,
      amountCents,
      vatCents,
      vatTreatment: form.vatTreatment,
      incomeAccountCode: form.incomeAccountCode || null,
      arAccountCode: form.arAccountCode || null,
      outputVatAccountCode: isVatable
        ? form.outputVatAccountCode || null
        : null,
      notes: form.notes || null,
      status: 'Draft',
    };
  }

  // Overrides sent to preview and issue so both reflect the same accounts.
  function issueOverrides() {
    return {
      date: form.siDate,
      arAccountCode: form.arAccountCode || null,
      incomeAccountCode: form.incomeAccountCode || null,
      outputVatAccountCode: isVatable
        ? form.outputVatAccountCode || null
        : null,
    };
  }

  async function saveDraft() {
    setError(null);
    setSaving(true);
    try {
      const saved = invoice?.id
        ? await serviceInvoicesApi.update(invoice.id, buildDraftPayload())
        : await serviceInvoicesApi.create(buildDraftPayload());
      setInvoice(saved);
      setPreview(null);
      setPosted(null);
      return saved;
    } catch (err) {
      setError(messageFor(err));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function reviewEntry() {
    // Ensure a saved draft exists (the preview and issue act on a persisted id).
    let inv = invoice;
    if (!inv?.id) {
      inv = await saveDraft();
      if (!inv) return;
    }
    setPreview({ status: 'loading' });
    try {
      const data = await previewInvoiceIssuance(inv.id, issueOverrides());
      setPreview({ status: 'ready', data });
    } catch (err) {
      // A 404 on THIS route means the preview endpoint is not deployed (the
      // invoice itself exists — we just saved it). Show the honest unavailable
      // state rather than a fabricated preview.
      if (err instanceof ApiError && err.status === 404) {
        setPreview({ status: 'unavailable' });
      } else {
        setPreview({ status: 'error', message: messageFor(err) });
      }
    }
  }

  async function commitIssue() {
    if (!invoice?.id || !reviewed) return;
    setError(null);
    setIssuing(true);
    try {
      const res = await issueInvoice(invoice.id, issueOverrides());
      setInvoice(res.invoice || invoice);
      setPosted({ journalEntryNo: res.journalEntryNo, lines: res.lines || [] });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div style={S.wrap}>
      <div style={S.top}>
        <div>
          <button
            type="button"
            style={S.link}
            onClick={() => navigate('/invoices')}
          >
            ← Service Invoices
          </button>
          <h1 style={S.h1}>Issue an invoice</h1>
        </div>
        <StatusPill status={invoice?.status || 'Draft'} />
      </div>

      <div style={S.body}>
        {error && (
          <div role="alert" style={S.errorBanner}>
            {error}
          </div>
        )}

        <div style={S.grid}>
          {/* ── Left: the draft form ─────────────────────────────── */}
          <section style={S.card}>
            <h2 style={S.h2}>Invoice details</h2>

            <label style={S.label}>Client</label>
            <ContactPicker
              contacts={contacts}
              value={form.contactId || ''}
              displayName={form.contactName}
              typeFilter="Customer"
              placeholder="Search customer…"
              onChange={({ contactId, contactName }) =>
                patch({
                  contactId: contactId || null,
                  contactName: contactName || '',
                })
              }
            />

            <div style={S.row2}>
              <div>
                <label style={S.label}>Invoice date</label>
                <input
                  type="date"
                  style={S.input}
                  value={form.siDate}
                  onChange={(e) => patch({ siDate: e.target.value })}
                />
              </div>
              <div>
                <label style={S.label}>Due date (optional)</label>
                <input
                  type="date"
                  style={S.input}
                  value={form.dueDate}
                  onChange={(e) => patch({ dueDate: e.target.value })}
                />
              </div>
            </div>

            <label style={S.label}>VAT treatment</label>
            <select
              style={S.input}
              value={form.vatTreatment}
              onChange={(e) =>
                patch({
                  vatTreatment: e.target.value,
                  vat: e.target.value === 'vatable' ? form.vat : '',
                })
              }
            >
              {TREATMENTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>

            <div style={S.row2}>
              <div>
                <label style={S.label}>Gross amount (₱)</label>
                <input
                  inputMode="decimal"
                  aria-label="Gross amount"
                  style={S.input}
                  placeholder="0.00"
                  value={form.amount}
                  onChange={(e) => patch({ amount: e.target.value })}
                />
              </div>
              <div>
                <label style={S.label}>Output VAT (₱)</label>
                <input
                  inputMode="decimal"
                  aria-label="Output VAT"
                  style={{
                    ...S.input,
                    ...(isVatable ? null : S.inputDisabled),
                  }}
                  placeholder="0.00"
                  value={isVatable ? form.vat : ''}
                  disabled={!isVatable}
                  title={isVatable ? '' : 'VAT applies only to a VATable sale'}
                  onChange={(e) => patch({ vat: e.target.value })}
                />
              </div>
            </div>

            <label style={S.label}>Income account</label>
            <AccountCombobox
              rawAccounts={accounts}
              value={form.incomeAccountCode}
              onChange={(code) => patch({ incomeAccountCode: code })}
              placeholder="— Revenue account —"
            />

            <details style={S.details}>
              <summary style={S.summary}>Account overrides (optional)</summary>
              <label style={S.label}>Receivable account</label>
              <AccountCombobox
                rawAccounts={accounts}
                value={form.arAccountCode}
                onChange={(code) => patch({ arAccountCode: code })}
                placeholder="— Default: customer AR / control —"
              />
              {isVatable && (
                <>
                  <label style={S.label}>Output VAT account</label>
                  <AccountCombobox
                    rawAccounts={accounts}
                    value={form.outputVatAccountCode}
                    onChange={(code) => patch({ outputVatAccountCode: code })}
                    placeholder="— Default: 2003003 Output Tax —"
                  />
                </>
              )}
            </details>

            <label style={S.label}>Notes (optional)</label>
            <textarea
              style={{ ...S.input, minHeight: 60, resize: 'vertical' }}
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />

            <div style={S.actions}>
              <button
                type="button"
                style={{ ...S.btn, ...S.btnGhost }}
                disabled={!canSave || saving || isIssued}
                onClick={saveDraft}
              >
                {saving
                  ? 'Saving…'
                  : invoice?.id
                    ? 'Save changes'
                    : 'Save draft'}
              </button>
            </div>

            {/* Server-computed decomposition of the SAVED draft. Not recomputed. */}
            {invoice && (
              <div style={S.decomp} data-testid="decomposition">
                <Line
                  label="Net of VAT"
                  cents={invoice.netCents}
                  testid="decomp-net"
                />
                <Line
                  label="Output VAT"
                  cents={invoice.vatCents}
                  testid="decomp-vat"
                />
                <Line
                  label="Invoice total"
                  cents={invoice.amountCents}
                  strong
                  testid="decomp-total"
                />
              </div>
            )}
          </section>

          {/* ── Right: the journal-entry preview + commit ─────────── */}
          <section style={S.card}>
            <h2 style={S.h2}>Journal entry</h2>
            <p style={S.help}>
              This is the entry issuing will post. Withholding tax (EWT) is not
              recognised here — it is booked at collection from the
              client&apos;s BIR 2307.
            </p>

            <JournalEntryPreview
              preview={preview}
              posted={posted}
              vatTreatment={invoice?.vatTreatment || form.vatTreatment}
              accountName={accountName}
            />

            <div style={S.actions}>
              {!posted && (
                <>
                  <button
                    type="button"
                    style={{ ...S.btn, ...S.btnGhost }}
                    disabled={
                      !canSave || preview?.status === 'loading' || isIssued
                    }
                    onClick={reviewEntry}
                  >
                    {preview?.status === 'loading'
                      ? 'Loading…'
                      : 'Review journal entry'}
                  </button>
                  <button
                    type="button"
                    style={{ ...S.btn, ...S.btnPrimary }}
                    disabled={!invoice?.id || !reviewed || issuing}
                    title={!reviewed ? 'Review the journal entry first' : ''}
                    onClick={commitIssue}
                  >
                    {issuing ? 'Issuing…' : 'Issue invoice'}
                  </button>
                </>
              )}
              {posted && (
                <button
                  type="button"
                  style={{ ...S.btn, ...S.btnGhost }}
                  onClick={() => navigate('/invoices')}
                >
                  Done
                </button>
              )}
            </div>

            {posted && (
              <div role="status" style={S.success}>
                Issued — journal entry <strong>{posted.journalEntryNo}</strong>{' '}
                posted.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Line({ label, cents, strong, testid }) {
  return (
    <div
      style={{ ...S.decompRow, ...(strong ? S.decompStrong : null) }}
      data-testid={testid}
    >
      <span>{label}</span>
      <MoneyText
        value={pesos(cents)}
        className={strong ? 'font-semibold' : ''}
      />
    </div>
  );
}

/**
 * The JE preview panel. Renders, in order of what is available:
 *   • posted lines (authoritative, after commit),
 *   • a server preview (authoritative, before commit),
 *   • an honest "unavailable" state when the seam endpoint is not deployed,
 *   • a preview error (e.g. accounts_unset) surfaced from the server.
 * It NEVER fabricates peso figures.
 */
function JournalEntryPreview({ preview, posted, vatTreatment, accountName }) {
  if (posted) {
    return (
      <EntryTable
        caption="Posted entry"
        lines={posted.lines}
        accountName={accountName}
        totalDebitCents={sumOf(posted.lines, 'debitCents')}
        totalCreditCents={sumOf(posted.lines, 'creditCents')}
        balanced
        source="posted"
      />
    );
  }

  if (!preview) {
    return (
      <div style={S.previewIdle} data-testid="preview-idle">
        Review the entry to see the debit and credit lines.
      </div>
    );
  }
  if (preview.status === 'loading') {
    return <div style={S.previewIdle}>Computing the entry…</div>;
  }
  if (preview.status === 'ready') {
    const d = preview.data || {};
    return (
      <EntryTable
        caption="Entry to be posted"
        lines={d.lines || []}
        accountName={accountName}
        totalDebitCents={d.totalDebitCents}
        totalCreditCents={d.totalCreditCents}
        balanced={d.balanced}
        source="preview"
      />
    );
  }
  if (preview.status === 'error') {
    return (
      <div role="alert" style={S.previewError} data-testid="preview-error">
        {preview.message}
      </div>
    );
  }
  // status === 'unavailable' — honest fallback, structure only, NO amounts.
  return (
    <div style={S.previewUnavailable} data-testid="preview-unavailable">
      <p style={{ margin: '0 0 8px', fontWeight: 700 }}>
        Server preview not available in this build
      </p>
      <p style={{ margin: '0 0 10px' }}>
        The peso split and the exact accounts are computed by the server.
        Issuing will post this entry and show the posted lines. The structure
        is:
      </p>
      <ul style={S.structList}>
        <li>DR — Trade Receivable</li>
        <li>CR — Revenue</li>
        {vatTreatment === 'vatable' && <li>CR — Output VAT</li>}
      </ul>
      <p style={{ margin: '8px 0 0', color: '#94a3b8' }}>
        Amounts pending server computation.
      </p>
    </div>
  );
}

function EntryTable({
  caption,
  lines,
  accountName,
  totalDebitCents,
  totalCreditCents,
  balanced,
  source,
}) {
  return (
    <table style={S.jeTable} data-testid={`entry-${source}`}>
      <caption style={S.caption}>{caption}</caption>
      <thead>
        <tr>
          <th style={S.jeThLeft}>Account</th>
          <th style={S.jeThRight}>Debit</th>
          <th style={S.jeThRight}>Credit</th>
        </tr>
      </thead>
      <tbody>
        {(lines || []).map((l, i) => (
          <tr key={i}>
            <td style={S.jeTd}>
              <div style={{ fontWeight: 600 }}>
                {l.accountName || accountName(l.accountCode) || l.description}
              </div>
              <div style={S.acctCode}>[{l.accountCode}]</div>
            </td>
            <td style={S.jeTdRight}>
              {l.debitCents ? (
                <MoneyText value={pesos(l.debitCents)} />
              ) : (
                <span style={S.dash}>—</span>
              )}
            </td>
            <td style={S.jeTdRight}>
              {l.creditCents ? (
                <MoneyText value={pesos(l.creditCents)} />
              ) : (
                <span style={S.dash}>—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td style={{ ...S.jeTd, fontWeight: 700 }}>Totals</td>
          <td style={S.jeTdRight}>
            <MoneyText
              value={pesos(totalDebitCents)}
              className="font-semibold"
            />
          </td>
          <td style={S.jeTdRight}>
            <MoneyText
              value={pesos(totalCreditCents)}
              className="font-semibold"
            />
          </td>
        </tr>
        <tr>
          <td colSpan={3} style={S.balanceCell}>
            <span
              data-testid="balance-badge"
              style={balanced ? S.balOk : S.balBad}
            >
              {balanced ? '✓ Balanced' : '⚠ Not balanced'}
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * Sum of a centavo column across posted lines — used only to TOTAL the entry
 * the server already computed and posted (identity/echo), never to derive or
 * decompose a money value. The server-provided `balanced` flag is authoritative
 * for the preview path; posted entries are balanced by construction.
 */
function sumOf(lines, key) {
  return (lines || []).reduce((acc, l) => acc + (Number(l[key]) || 0), 0);
}

const S = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: 'Inter, system-ui, sans-serif',
    background: '#f8fafc',
  },
  top: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 22px',
    borderBottom: '1px solid #e5e7eb',
    background: '#fff',
  },
  link: {
    border: 0,
    background: 'none',
    color: '#64748b',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  h1: { margin: '4px 0 0', fontSize: 20, color: '#0b1220' },
  body: { flex: 1, overflowY: 'auto', padding: '18px 22px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
    gap: 18,
    alignItems: 'start',
  },
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 14,
    padding: 18,
  },
  h2: { margin: '0 0 12px', fontSize: 15, color: '#0b1220' },
  help: { margin: '0 0 14px', fontSize: 12, color: '#64748b', lineHeight: 1.5 },
  label: {
    display: 'block',
    fontSize: 10,
    fontWeight: 800,
    color: '#64748b',
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    margin: '12px 0 5px',
  },
  input: {
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '9px 10px',
    fontSize: 13,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
    background: '#fff',
  },
  inputDisabled: { background: '#f1f5f9', color: '#94a3b8' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  details: { marginTop: 6 },
  summary: { fontSize: 12, color: '#64748b', cursor: 'pointer', marginTop: 8 },
  actions: { display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' },
  btn: {
    border: 0,
    borderRadius: 10,
    padding: '9px 16px',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
  },
  btnPrimary: { background: '#f97316', color: '#fff' },
  btnGhost: { background: '#f1f5f9', color: '#0b1220' },
  decomp: { marginTop: 16, borderTop: '1px dashed #e5e7eb', paddingTop: 12 },
  decompRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 13,
    color: '#334155',
    padding: '3px 0',
  },
  decompStrong: {
    fontWeight: 700,
    color: '#0b1220',
    borderTop: '1px solid #e5e7eb',
    marginTop: 4,
    paddingTop: 8,
  },
  errorBanner: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: 10,
    padding: '10px 14px',
    fontSize: 13,
    marginBottom: 14,
  },
  previewIdle: { color: '#94a3b8', fontSize: 13, padding: '18px 0' },
  previewError: {
    background: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    borderRadius: 10,
    padding: '12px 14px',
    fontSize: 13,
  },
  previewUnavailable: {
    background: '#fffbeb',
    border: '1px solid #fde68a',
    color: '#92400e',
    borderRadius: 10,
    padding: '14px 16px',
    fontSize: 13,
    lineHeight: 1.5,
  },
  structList: { margin: 0, paddingLeft: 18 },
  jeTable: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  caption: {
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 800,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '.05em',
    padding: '0 0 8px',
  },
  jeThLeft: {
    textAlign: 'left',
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: 700,
    padding: '6px 8px',
    borderBottom: '1px solid #e5e7eb',
  },
  jeThRight: {
    textAlign: 'right',
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: 700,
    padding: '6px 8px',
    borderBottom: '1px solid #e5e7eb',
  },
  jeTd: {
    padding: '8px',
    borderBottom: '1px solid #f1f5f9',
    verticalAlign: 'top',
  },
  jeTdRight: {
    padding: '8px',
    borderBottom: '1px solid #f1f5f9',
    textAlign: 'right',
    whiteSpace: 'nowrap',
  },
  acctCode: {
    fontSize: 11,
    color: '#94a3b8',
    fontFamily: 'ui-monospace, monospace',
  },
  dash: { color: '#cbd5e1' },
  balanceCell: { padding: '10px 8px 0', textAlign: 'right' },
  balOk: { color: '#15803a', fontWeight: 700, fontSize: 12 },
  balBad: { color: '#b91c1c', fontWeight: 700, fontSize: 12 },
  success: {
    marginTop: 14,
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#15803a',
    borderRadius: 10,
    padding: '10px 14px',
    fontSize: 13,
  },
};
