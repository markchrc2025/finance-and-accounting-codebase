// Collections posting (Track B B3).
//
// The screen that takes money OFF the books: record a receipt against one or
// more issued invoices, capture the EWT from the payor's BIR 2307, and post.
// Posting books the C1 entry:
//   DR  Cash in Bank                 received
//   DR  Creditable Withholding Tax   ewt         (omitted when 0)
//       CR  Trade Receivable             received + ewt
//
// MONEY DISCIPLINE (R45): the browser performs no ledger money arithmetic. It
// never computes the net/VAT split, never sums the journal entry, never decides
// whether it balances, and never derives the EWT or the AR relief. Those come
// verbatim from the server:
//   • EWT is a captured INPUT (the 2307 figure), echoed back from the saved
//     collection — never derived from a rate.
//   • AR relief (received + ewt) is the DB-generated `arReliefCents`.
//   • the DR/CR lines, totals and `balanced` flag come from the post-preview
//     seam, or after commit from the post response's lines.
// The ONE client-side tally is the allocation aid — "allocated so far / left to
// allocate" — computed only from the user's own per-invoice INPUT amounts to
// guide data entry (the server enforces that applications sum to the receipt and
// rejects a mismatch). It is not a server/ledger figure and not a second source
// of truth. Unit scaling centavos↔pesos at the edge is the house convention.
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
  collectionsApi,
  postCollection,
  previewCollectionPost,
  ApiError,
} from '../../../lib/api.js';

const today = () => new Date().toISOString().slice(0, 10);
const ISSUED_STATUS = 'Issued';

/** Request-boundary ONLY: peso string → integer centavos. Never a displayed value. */
function centsFromPeso(str) {
  const n = Number.parseFloat(String(str ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Presentation unit only (centavos→pesos), the house convention. */
function pesos(cents) {
  return (Number(cents) || 0) / 100;
}

function messageFor(err) {
  if (!(err instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  const body = err.body || {};
  if (body.error === 'validation_error' && Array.isArray(body.issues)) {
    return body.issues
      .map((i) => {
        const path =
          Array.isArray(i.path) && i.path.length ? `${i.path.join('.')}: ` : '';
        return `${path}${i.message}`;
      })
      .join(' · ');
  }
  return body.detail || body.error || `Request failed (${err.status}).`;
}

export default function CollectionsPostingPage() {
  const navigate = useNavigate();

  const [contacts, setContacts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [invoices, setInvoices] = useState([]);

  const [form, setForm] = useState({
    contactId: null,
    contactName: '',
    collectionDate: today(),
    amountReceived: '', // pesos, as typed
    ewt: '', // pesos, as typed (from the 2307)
    method: 'Cash',
    referenceNo: '',
    cashAccountCode: '',
    cwtAccountCode: '',
    arAccountCode: '',
    notes: '',
  });

  // Per-invoice allocation the user enters: invoiceId → { applied, ewt } (pesos).
  const [alloc, setAlloc] = useState({});

  const [collection, setCollection] = useState(null); // saved draft (server truth)
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // {status, data?} — the seam
  const [posted, setPosted] = useState(null); // {journalEntryNo, lines, ...}

  useEffect(() => {
    let alive = true;
    listContacts('Customer')
      .then((c) => alive && setContacts(c || []))
      .catch(() => alive && setContacts([]));
    listAccounts()
      .then((a) => alive && setAccounts(a || []))
      .catch(() => alive && setAccounts([]));
    serviceInvoicesApi
      .list()
      .then(
        (rows) =>
          alive &&
          setInvoices(
            (rows || []).filter(
              (i) => i.status === ISSUED_STATUS && (i.balanceCents ?? 0) > 0,
            ),
          ),
      )
      .catch(() => alive && setInvoices([]));
    return () => {
      alive = false;
    };
  }, []);

  const accountName = useMemo(() => {
    const byCode = new Map((accounts || []).map((a) => [a.code, a.name]));
    return (code) => byCode.get(code) || null;
  }, [accounts]);

  const ewtEntered = centsFromPeso(form.ewt) > 0;

  // Editing anything invalidates a prior review — you must re-see the entry.
  function reset() {
    setCollection(null);
    setPreview(null);
    setPosted(null);
    setError(null);
  }
  function patch(next) {
    setForm((f) => ({ ...f, ...next }));
    reset();
  }
  function setAllocFor(invoiceId, field, value) {
    setAlloc((a) => ({
      ...a,
      [invoiceId]: { ...(a[invoiceId] || {}), [field]: value },
    }));
    reset();
  }

  // The applications payload — invoices the user allocated something to.
  const applications = useMemo(() => {
    return Object.entries(alloc)
      .map(([invoiceId, v]) => ({
        invoiceId,
        appliedCents: centsFromPeso(v.applied),
        ewtCents: centsFromPeso(v.ewt),
      }))
      .filter((a) => a.appliedCents > 0 || a.ewtCents > 0);
  }, [alloc]);

  // ── Allocation entry-aid (client tally of the user's OWN inputs) ───────────
  // Not a server/ledger figure: guides the user to fully allocate the receipt.
  // The server is the authority (applications must sum to the receipt on post).
  const receivedCents = centsFromPeso(form.amountReceived);
  const allocatedCents = applications.reduce((s, a) => s + a.appliedCents, 0);
  const unappliedCents = receivedCents - allocatedCents;

  const canSave =
    !!form.contactName.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.collectionDate) &&
    receivedCents + centsFromPeso(form.ewt) > 0;

  const reviewed = preview !== null && preview.status !== 'loading';

  function draftPayload() {
    return {
      contactId: form.contactId || null,
      contactName: form.contactName.trim(),
      collectionDate: form.collectionDate,
      amountReceivedCents: receivedCents,
      ewtCents: centsFromPeso(form.ewt),
      method: form.method || 'Cash',
      referenceNo: form.referenceNo || null,
      cashAccountCode: form.cashAccountCode || null,
      cwtAccountCode: ewtEntered ? form.cwtAccountCode || null : null,
      arAccountCode: form.arAccountCode || null,
      notes: form.notes || null,
      status: 'Unposted',
    };
  }

  function postBody() {
    return {
      date: form.collectionDate,
      cashAccountCode: form.cashAccountCode || null,
      cwtAccountCode: ewtEntered ? form.cwtAccountCode || null : null,
      arAccountCode: form.arAccountCode || null,
      applications,
    };
  }

  async function saveDraft() {
    setError(null);
    setSaving(true);
    try {
      const saved = collection?.id
        ? await collectionsApi.update(collection.id, draftPayload())
        : await collectionsApi.create(draftPayload());
      setCollection(saved);
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
    let col = collection;
    if (!col?.id) {
      col = await saveDraft();
      if (!col) return;
    }
    setPreview({ status: 'loading' });
    try {
      const data = await previewCollectionPost(col.id, postBody());
      setPreview({ status: 'ready', data });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPreview({ status: 'unavailable' });
      } else {
        setPreview({ status: 'error', message: messageFor(err) });
      }
    }
  }

  async function commitPost() {
    if (!collection?.id || !reviewed) return;
    setError(null);
    setPosting(true);
    try {
      const res = await postCollection(collection.id, postBody());
      setCollection(res.collection || collection);
      setPosted({
        journalEntryNo: res.journalEntryNo,
        percentageTaxEntryNo: res.percentageTaxEntryNo,
        lines: res.lines || [],
      });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div style={S.wrap}>
      <div style={S.top}>
        <div>
          <button
            type="button"
            style={S.link}
            onClick={() => navigate('/collections')}
          >
            ← Collections
          </button>
          <h1 style={S.h1}>Record a collection</h1>
        </div>
        <StatusPill status={collection?.status || 'Unposted'} />
      </div>

      <div style={S.body}>
        {error && (
          <div role="alert" style={S.errorBanner}>
            {error}
          </div>
        )}

        <div style={S.grid}>
          {/* ── Left: the receipt + allocation ──────────────────── */}
          <section style={S.card}>
            <h2 style={S.h2}>Receipt</h2>

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
                <label style={S.label}>Collection date</label>
                <input
                  type="date"
                  aria-label="Collection date"
                  style={S.input}
                  value={form.collectionDate}
                  onChange={(e) => patch({ collectionDate: e.target.value })}
                />
              </div>
              <div>
                <label style={S.label}>Method</label>
                <input
                  style={S.input}
                  value={form.method}
                  onChange={(e) => patch({ method: e.target.value })}
                />
              </div>
            </div>

            <div style={S.row2}>
              <div>
                <label style={S.label}>Amount received (₱)</label>
                <input
                  inputMode="decimal"
                  aria-label="Amount received"
                  style={S.input}
                  placeholder="0.00"
                  value={form.amountReceived}
                  onChange={(e) => patch({ amountReceived: e.target.value })}
                />
              </div>
              <div>
                <label style={S.label}>EWT from 2307 (₱)</label>
                <input
                  inputMode="decimal"
                  aria-label="EWT from 2307"
                  style={S.input}
                  placeholder="0.00"
                  value={form.ewt}
                  onChange={(e) => patch({ ewt: e.target.value })}
                />
              </div>
            </div>

            <label style={S.label}>Cash / bank account</label>
            <AccountCombobox
              rawAccounts={accounts}
              value={form.cashAccountCode}
              onChange={(code) => patch({ cashAccountCode: code })}
              placeholder="— Cash in bank account —"
            />
            {ewtEntered && (
              <>
                <label style={S.label}>
                  Creditable withholding tax account
                </label>
                <AccountCombobox
                  rawAccounts={accounts}
                  value={form.cwtAccountCode}
                  onChange={(code) => patch({ cwtAccountCode: code })}
                  placeholder="— Default: 1009002 Creditable Withholding Tax —"
                />
              </>
            )}

            {/* ── Invoice allocation ─────────────────────────────── */}
            <h2 style={{ ...S.h2, marginTop: 18 }}>Apply to invoices</h2>
            {invoices.length === 0 ? (
              <p style={S.help}>
                No issued invoices with an outstanding balance.
              </p>
            ) : (
              <table style={S.allocTable}>
                <thead>
                  <tr>
                    <th style={S.thLeft}>Invoice</th>
                    <th style={S.thRight}>Outstanding</th>
                    <th style={S.thRight}>Apply ₱</th>
                    <th style={S.thRight}>EWT ₱</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td style={S.td}>
                        <div style={{ fontWeight: 600 }}>{inv.siNo}</div>
                        <div style={S.muted}>{inv.contactName}</div>
                      </td>
                      {/* Outstanding = server-generated balanceCents, verbatim. */}
                      <td style={S.tdRight}>
                        <MoneyText value={pesos(inv.balanceCents)} />
                      </td>
                      <td style={S.tdRight}>
                        <input
                          inputMode="decimal"
                          aria-label={`Apply to ${inv.siNo}`}
                          style={S.smallInput}
                          placeholder="0.00"
                          value={alloc[inv.id]?.applied || ''}
                          onChange={(e) =>
                            setAllocFor(inv.id, 'applied', e.target.value)
                          }
                        />
                      </td>
                      <td style={S.tdRight}>
                        <input
                          inputMode="decimal"
                          aria-label={`EWT for ${inv.siNo}`}
                          style={S.smallInput}
                          placeholder="0.00"
                          value={alloc[inv.id]?.ewt || ''}
                          onChange={(e) =>
                            setAllocFor(inv.id, 'ewt', e.target.value)
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Allocation entry-aid — client tally of the user's own inputs. */}
            <div style={S.allocAid} data-testid="allocation-aid">
              <span>Allocated so far</span>
              <MoneyText value={pesos(allocatedCents)} />
              <span style={{ marginLeft: 'auto' }}>Left to allocate</span>
              <strong
                style={{ color: unappliedCents === 0 ? '#15803a' : '#c2410c' }}
              >
                <MoneyText value={pesos(unappliedCents)} />
              </strong>
            </div>
            <p style={S.tinyNote}>
              A guide for data entry — the server confirms the applications sum
              to the receipt when you post.
            </p>

            <div style={S.actions}>
              <button
                type="button"
                style={{ ...S.btn, ...S.btnGhost }}
                disabled={!canSave || saving || !!posted}
                onClick={saveDraft}
              >
                {saving
                  ? 'Saving…'
                  : collection?.id
                    ? 'Save changes'
                    : 'Save draft'}
              </button>
            </div>

            {/* Server-computed receipt summary (verbatim, never recomputed). */}
            {collection && (
              <div style={S.decomp} data-testid="receipt-summary">
                <Line
                  label="Amount received"
                  cents={collection.amountReceivedCents}
                  testid="sum-received"
                />
                <Line
                  label="EWT (from 2307)"
                  cents={collection.ewtCents}
                  testid="sum-ewt"
                />
                <Line
                  label="Receivable relieved"
                  cents={collection.arReliefCents}
                  strong
                  testid="sum-relief"
                />
              </div>
            )}
          </section>

          {/* ── Right: JE preview + commit ──────────────────────── */}
          <section style={S.card}>
            <h2 style={S.h2}>Journal entry</h2>
            <p style={S.help}>
              The entry posting will book. EWT is the creditable withholding tax
              your client withheld, taken from their BIR 2307 — never computed
              here.
            </p>

            <CollectionEntryPreview
              preview={preview}
              posted={posted}
              hasEwt={ewtEntered}
              accountName={accountName}
            />

            <div style={S.actions}>
              {!posted && (
                <>
                  <button
                    type="button"
                    style={{ ...S.btn, ...S.btnGhost }}
                    disabled={
                      !canSave ||
                      preview?.status === 'loading' ||
                      applications.length === 0
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
                    disabled={
                      !collection?.id ||
                      !reviewed ||
                      posting ||
                      applications.length === 0
                    }
                    title={!reviewed ? 'Review the journal entry first' : ''}
                    onClick={commitPost}
                  >
                    {posting ? 'Posting…' : 'Post collection'}
                  </button>
                </>
              )}
              {posted && (
                <button
                  type="button"
                  style={{ ...S.btn, ...S.btnGhost }}
                  onClick={() => navigate('/collections')}
                >
                  Done
                </button>
              )}
            </div>

            {posted && (
              <div role="status" style={S.success}>
                Posted — journal entry <strong>{posted.journalEntryNo}</strong>
                {posted.percentageTaxEntryNo ? (
                  <>
                    {' '}
                    (percentage tax:{' '}
                    <strong>{posted.percentageTaxEntryNo}</strong>)
                  </>
                ) : null}
                .
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
 * The C1 preview panel. Shows, in order: posted lines (after commit), a server
 * preview (before commit), an honest "unavailable" state when the seam endpoint
 * is not deployed, or a preview error. Never fabricates peso figures.
 */
function CollectionEntryPreview({ preview, posted, hasEwt, accountName }) {
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
  // unavailable — honest fallback, structure only, NO amounts.
  return (
    <div style={S.previewUnavailable} data-testid="preview-unavailable">
      <p style={{ margin: '0 0 8px', fontWeight: 700 }}>
        Server preview not available in this build
      </p>
      <p style={{ margin: '0 0 10px' }}>
        The peso amounts and the exact accounts are computed by the server.
        Posting will book this entry and show the posted lines. The structure
        is:
      </p>
      <ul style={S.structList}>
        <li>DR — Cash in Bank</li>
        {hasEwt && <li>DR — Creditable Withholding Tax</li>}
        <li>CR — Trade Receivable</li>
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

/** Total a centavo column of the ALREADY-POSTED lines (server-computed, balanced
 *  by construction) to display a footer — never to derive or split a value. */
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
  smallInput: {
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: '6px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    width: 90,
    textAlign: 'right',
    boxSizing: 'border-box',
  },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
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
  allocTable: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  thLeft: {
    textAlign: 'left',
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: 800,
    textTransform: 'uppercase',
    padding: '6px 8px',
    borderBottom: '1px solid #e5e7eb',
  },
  thRight: {
    textAlign: 'right',
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: 800,
    textTransform: 'uppercase',
    padding: '6px 8px',
    borderBottom: '1px solid #e5e7eb',
  },
  td: { padding: '8px', borderBottom: '1px solid #f1f5f9' },
  tdRight: {
    padding: '8px',
    borderBottom: '1px solid #f1f5f9',
    textAlign: 'right',
  },
  muted: { fontSize: 11, color: '#94a3b8' },
  allocAid: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    padding: '8px 10px',
    background: '#f8fafc',
    borderRadius: 8,
    fontSize: 12,
    color: '#475569',
  },
  tinyNote: { fontSize: 11, color: '#94a3b8', margin: '6px 0 0' },
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
