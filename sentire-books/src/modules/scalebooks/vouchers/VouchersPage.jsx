import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
  listVouchers, getVoucher, createVoucherDraft, updateVoucher, deleteVoucher as apiDeleteVoucher,
  transitionVoucher, voidVoucher as apiVoidVoucher,
  listAccounts, listContacts, createAccount, getJournalEntry, ApiError,
  taxRatesApi, taxGroupsApi, purposeCategoriesApi,
} from '../../../lib/api.js';
import AccountCombobox from '../../../components/AccountCombobox.jsx';
import ContactPicker from '../../../components/ContactPicker.jsx';
import NewAccountModal from './NewAccountModal.jsx';
import { consumeSchedulePrefill } from '../../../utils/schedulePrefill.js';
import VoucherPdfModal from './VoucherPdfModal.jsx';

const fmt  = (n) => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(n || 0);
const fmtP = (n) => new Intl.NumberFormat('en-PH', { minimumFractionDigits:0, maximumFractionDigits:4 }).format(n || 0) + '%';
const uid  = () => Math.random().toString(36).slice(2, 10).toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);

// Matches GAS acounting.js getAppConfig() voucherTypes.
// CHECK vouchers are created from Check Registry, not here.
const VOUCHER_TYPES = [
  { value:'PAYMENT',   label:'Payment Voucher' },
  { value:'PAYROLL',   label:'Payroll Voucher' },
  { value:'FINAL_PAY', label:'Final Pay Voucher' },
  { value:'LOAN',      label:'Loan Voucher' },
];
// Types where Purpose Category and Payment From are hidden (auto-bank)
const AUTO_BANK_TYPES = ['PAYROLL','FINAL_PAY'];
// Types where Tax columns are shown
const TAX_VISIBLE_TYPES = ['PAYMENT'];
const STATUSES = ['Draft','Pending','For Verification','Verified','For Approval','Approved','Paid','Rejected','Voided'];


const STATUS_STYLES = {
  'Draft':            { background:'#f8fafc', borderColor:'#e2e8f0', color:'#64748b' },
  'Pending':          { background:'#fff7ed', borderColor:'#fed7aa', color:'#c2410c' },
  'For Verification': { background:'#fffbeb', borderColor:'#fde68a', color:'#92400e' },
  'Verified':         { background:'#f0f9ff', borderColor:'#bae6fd', color:'#0369a1' },
  'For Approval':     { background:'#eff6ff', borderColor:'#bfdbfe', color:'#1d4ed8' },
  'Approved':         { background:'#ecfdf5', borderColor:'#6ee7b7', color:'#065f46' },
  'Paid':             { background:'#f0fdf4', borderColor:'#bbf7d0', color:'#15803d' },
  'Rejected':         { background:'#fef2f2', borderColor:'#fecaca', color:'#dc2626' },
  'Voided':           { background:'#f8fafc', borderColor:'#e2e8f0', color:'#94a3b8' },
};

const EMPTY_LINE = () => ({ id: uid(), contactId:'', contact:'', expenseAccount:'', description:'', amount:'', category:'', taxRateId:'', taxType:'N/A', taxRate:0, taxAmt:0, inclusive:false });

// ── API <-> UI mapping ────────────────────────────────────────
// The API speaks lowercase enums + centavos; the screen keeps its labels/pesos.
const TYPE_TO_API = { PAYMENT:'payment', RECEIPT:'receipt', PAYROLL:'payroll', FINAL_PAY:'final_pay', LOAN:'loan', CHECK:'check' };
const API_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_API).map(([k,v])=>[v,k]));
const VSTATUS_LABEL = {
  draft:'Draft', pending:'Pending', for_verification:'For Verification', verified:'Verified',
  for_approval:'For Approval', approved:'Approved', paid:'Paid', rejected:'Rejected',
  posted:'Approved', void:'Voided',
};
// API list row -> the shape this screen renders (legacy portal fields).
const fromApi = (v) => {
  const m = v.meta || {};
  return {
    id: v.id,
    voucherId: v.voucherNo,
    voucherType: API_TO_TYPE[v.voucherType] || 'PAYMENT',
    preparationDate: v.voucherDate,
    purposeCategory: v.purposeCategory || '',
    contactSummary: m.contactSummary || v.contactName || '',
    totalAmount: (v.totalCents ?? 0) / 100,
    status: VSTATUS_LABEL[v.status] || v.status,
    notes: v.notes || '',
    linkedJeId: v.journalEntryId || null,
    paymentFromAccountCode: v.paymentFromAccountCode || '',
    loanId: m.loanId || '', checkVoucherId: m.checkVoucherId || '',
    createdBy: v.createdByEmail || '',
    lines: null, // loaded on demand via getVoucher (see withLines)
  };
};
// API detail line -> the legacy line shape (tax/contact config lives in meta).
const lineFromApi = (l) => {
  const m = l.meta || {};
  return {
    lineNo: l.lineNo, contactId: m.contactId || '', contact: m.contact || '',
    expenseAccountCode: l.accountCode || '', description: l.description || '',
    amount: (l.amountCents ?? 0) / 100, category: m.category || '',
    taxRateId: m.taxRateId || '', taxType: m.taxType || 'N/A',
    taxRate: m.taxRate || 0, taxAmt: m.taxAmt || 0, inclusive: !!m.inclusive,
  };
};

const CSS = `
  .vp-wrap   { display:flex; flex-direction:column; height:100%; overflow:hidden; font-family:Inter,system-ui,sans-serif; background:#f8fafc; }
  .vp-topbar { display:flex; align-items:center; justify-content:space-between; padding:16px 22px 12px; flex-shrink:0; border-bottom:1px solid #e5e7eb; background:#fff; }
  .vp-body   { flex:1; overflow-y:auto; padding:16px 22px; }
  .toolbar   { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
  .input     { border:1px solid #e5e7eb; border-radius:10px; padding:9px 12px; font-size:13px; background:#fff; font-family:inherit; }
  .btn       { border:0; border-radius:10px; padding:9px 16px; font-weight:700; cursor:pointer; font-size:13px; font-family:inherit; transition:opacity .15s; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .btn-primary { background:#f97316; color:#fff; }
  .btn-dark    { background:#0b1220; color:#fff; }
  .btn-ghost   { background:#f1f5f9; color:#0b1220; }
  .btn-ghost:hover { background:#e2e8f0; }
  .km-item     { display:block; width:100%; background:none; border:0; text-align:left; padding:9px 16px; font-size:13px; font-family:inherit; cursor:pointer; color:#0b1220; white-space:nowrap; }
  .km-item:hover { background:#f1f5f9; }
  .btn-danger  { background:#ef4444; color:#fff; }
  .btn-sm      { padding:6px 12px; font-size:12px; }
  .btn-xs      { padding:4px 8px; font-size:11px; border-radius:8px; }
  .card { background:#fff; border:1px solid #e5e7eb; border-radius:14px; overflow:hidden; }
  table { width:100%; border-collapse:collapse; }
  th,td { padding:11px 12px; border-bottom:1px solid #f1f5f9; font-size:13px; text-align:left; }
  th { color:#64748b; font-weight:800; font-size:11px; letter-spacing:.05em; text-transform:uppercase; background:#f8fafc; }
  tr:hover td { background:#fafafa; }
  tr:last-child td { border-bottom:none; }
  .pill { display:inline-block; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:700; border:1px solid; white-space:nowrap; }
  .backdrop { position:fixed; inset:0; background:rgba(15,23,42,.45); display:flex; align-items:center; justify-content:center; padding:16px; z-index:100; }
  .modal    { width:min(1400px,98vw); max-height:92vh; background:#fff; border-radius:16px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 64px rgba(0,0,0,.25); }
  .modal-sm { width:min(480px,98vw); }
  .modal-h  { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #e5e7eb; background:#f8fafc; flex-shrink:0; }
  .modal-h strong { font-size:15px; font-weight:900; }
  .modal-b  { padding:20px; overflow-y:auto; flex:1; }
  .modal-f  { display:flex; justify-content:flex-end; gap:10px; padding:14px 20px; border-top:1px solid #e5e7eb; background:#fff; flex-shrink:0; }
  .grid6    { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:12px; }
  .col2     { grid-column:span 2; }
  .col3     { grid-column:span 3; }
  .col4     { grid-column:span 4; }
  .col6     { grid-column:span 6; }
  .field    { display:flex; flex-direction:column; gap:5px; }
  .field label { font-size:10px; font-weight:800; color:#64748b; letter-spacing:.06em; text-transform:uppercase; }
  .field input,.field select,.field textarea { width:100%; border:1px solid #e5e7eb; border-radius:10px; padding:9px 10px; font-size:13px; background:#fff; font-family:inherit; box-sizing:border-box; }
  .section-title { font-size:11px; font-weight:800; color:#94a3b8; letter-spacing:.07em; text-transform:uppercase; margin:16px 0 8px; border-bottom:1px solid #f1f5f9; padding-bottom:6px; }
  .lines-tbl th,.lines-tbl td { border-bottom:1px solid #f1f5f9; padding:8px 10px; }
  .lines-tbl td input,.lines-tbl td select { width:100%; border:1px solid #e5e7eb; border-radius:8px; padding:7px 8px; font-size:12px; font-family:inherit; }
  .tfoot-row { display:flex; justify-content:flex-end; gap:20px; padding:10px 16px; background:#f8fafc; border-top:2px solid #e5e7eb; font-size:13px; font-weight:700; }
  .bulk-bar  { display:flex; align-items:center; gap:10px; padding:8px 14px; background:#fff7ed; border:1px solid #fed7aa; border-radius:10px; margin-bottom:10px; flex-wrap:wrap; }
  .kpi-row   { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:16px; }
  .kpi-card  { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:14px 16px; }
  .kpi-label { font-size:10px; font-weight:800; color:#94a3b8; letter-spacing:.07em; text-transform:uppercase; margin-bottom:4px; }
  .kpi-value { font-size:18px; font-weight:900; color:#0b1220; }
  .empty { padding:48px; text-align:center; color:#94a3b8; font-size:13px; }
  .toast { position:fixed; right:16px; bottom:16px; background:#0b1220; color:#fff; padding:12px 18px; border-radius:12px; font-size:13px; font-weight:600; z-index:999; animation:fadeIn .2s; }
  .backdrop { position:fixed; inset:0; background:rgba(15,23,42,.45); display:flex; align-items:center; justify-content:center; padding:16px; z-index:100; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
  .expand-row td { background:#f8fafc; padding:16px 20px; }
  .pg-bar { display:flex; align-items:center; justify-content:space-between; padding:10px 4px; flex-shrink:0; margin-top:8px; flex-wrap:wrap; gap:8px; }
  .pg-bar span { font-size:12px; color:#64748b; font-weight:600; }
`;

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES['Pending'];
  return <span className="pill" style={s}>{status || 'Pending'}</span>;
}

export default function VouchersPage() {
  const [vouchers,         setVouchers]         = useState([]);
  const [accounts,         setAccounts]         = useState([]);
  const [contacts,         setContacts]         = useState([]);
  const [taxRates,         setTaxRates]         = useState([]);
  const [taxGroups,        setTaxGroups]        = useState([]);
  const [purposeCategories, setPurposeCategories] = useState([]);
  const [loans,      setLoans]      = useState([]); // for LOAN voucher → loanId picker
  const [cvList,     setCvList]     = useState([]); // loan-linked CVs for checkVoucherId picker
  const [cvSearch,   setCvSearch]   = useState('');
  const [cvDropOpen, setCvDropOpen] = useState(false);

  // Filters
  const [search,        setSearch]       = useState('');
  const [filterType,    setFilterType]   = useState('');
  const [filterStatus,  setFilterStatus] = useState('');
  const [dateFrom,      setDateFrom]     = useState('');
  const [dateTo,        setDateTo]       = useState('');

  // Pagination
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Sort
  const [sortCol, setSortCol] = useState('preparationDate');
  const [sortDir, setSortDir] = useState('desc');

  // Bulk
  const [selected, setSelected] = useState(new Set());

  // Modals
  const [showModal,    setShowModal]   = useState(false);
  const [viewModal,    setViewModal]   = useState(null);
  const [previewJe,    setPreviewJe]   = useState(null);
  const [pdfModal,     setPdfModal]    = useState(null);
  const [openMenuId,   setOpenMenuId]  = useState(null);
  const [menuPos,      setMenuPos]     = useState({ top:0, right:0 });
  const menuRef = useRef(null);

  // Close kebab menu on outside click or scroll
  useEffect(() => {
    if (!openMenuId) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenuId(null);
    };
    const closeScroll = () => setOpenMenuId(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', closeScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', closeScroll, true);
    };
  }, [openMenuId]);

  const [newAcctModal, setNewAcctModal] = useState(null);

  // Form
  const [editing,   setEditing]   = useState(null);
  const [form,      setForm]      = useState({});
  const [lines,     setLines]     = useState([EMPTY_LINE()]);
  const [saving,    setSaving]    = useState(false);
  const [toast,     setToast]     = useState('');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };
  const [confirmModal, setConfirmModal] = useState(null);
  const askConfirm = (message, onConfirm) => setConfirmModal({ message, onConfirm });

  // Fetch the linked JE (posted at approval) when the view modal opens.
  useEffect(() => {
    setPreviewJe(null);
    if (!viewModal?.linkedJeId) return;
    getJournalEntry(viewModal.linkedJeId)
      .then(({ entry, lines: jl }) => setPreviewJe({
        id: entry.id, jeId: entry.entryNo, date: entry.entryDate, status: entry.status,
        lines: (jl || []).map(l => ({
          accountCode: l.accountCode || '', accountName: l.accountName || '',
          description: l.description || '', debit: (l.debitCents ?? 0) / 100, credit: (l.creditCents ?? 0) / 100,
        })),
      }))
      .catch(() => {});
  }, [viewModal]);

  // Data (API; refetched after every mutation). CHECK vouchers live in the
  // Check Registry module, so they're filtered from this list like before.
  const loadVouchers = useCallback(async () => {
    try {
      const rows = await listVouchers({ limit: 500 });
      setVouchers(rows.filter(v => v.voucherType !== 'check').map(fromApi));
    } catch (e) {
      showToast(`Couldn't load vouchers: ${e instanceof ApiError ? e.detail : e.message}`);
    }
  }, []);

  useEffect(() => {
    loadVouchers();
    listAccounts().then(rows => setAccounts(rows.map(a => ({ ...a, subType: a.subtype || '' })))).catch(()=>{});
    listContacts().then(setContacts).catch(()=>{});
    taxRatesApi.list().then(rs => setTaxRates(rs.map(r => ({ ...r, rate: Number(r.rate) })).filter(r => r.isActive !== false))).catch(()=>{});
    taxGroupsApi.list().then(gs => setTaxGroups(gs.filter(g => g.isActive !== false))).catch(()=>{});
    purposeCategoriesApi.list().then(cs => setPurposeCategories(cs.map(c => c.name))).catch(()=>{});
    // Loans/check-linkage return with the loans domain (Phase 6).
    setLoans([]); setCvList([]);
  }, [loadVouchers]);

  // Voucher numbers are assigned server-side at save (PV/PR/FP/LV per type).
  const idPreview = '';

  /** Load a voucher's persisted lines and return it in the legacy shape. */
  const withLines = useCallback(async (v) => {
    const d = await getVoucher(v.id);
    return { ...v, lines: (d.lines || []).map(lineFromApi) };
  }, []);

  // Filtered + sorted
  const filtered = useMemo(() => {
    let v = [...vouchers];
    const q = search.toLowerCase();
    if (q) v = v.filter(x => (x.voucherId||x.id||'').toLowerCase().includes(q) || (x.contactSummary||'').toLowerCase().includes(q) || (x.purposeCategory||'').toLowerCase().includes(q));
    if (filterType)   v = v.filter(x => (x.voucherType||'') === filterType);
    if (filterStatus) v = v.filter(x => (x.status||'') === filterStatus);
    if (dateFrom) v = v.filter(x => (x.preparationDate||'') >= dateFrom);
    if (dateTo)   v = v.filter(x => (x.preparationDate||'') <= dateTo);

    v.sort((a, b) => {
      let av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
      if (sortCol === 'totalAmount') { av = Number(av)||0; bv = Number(bv)||0; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return v;
  }, [vouchers, search, filterType, filterStatus, dateFrom, dateTo, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated  = filtered.slice((page-1)*pageSize, page*pageSize);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
    setPage(1);
  };

  // KPIs
  const kpis = useMemo(() => {
    const total   = vouchers.length;
    const pending = vouchers.filter(v => ['Pending','For Verification','Verified','For Approval'].includes(v.status)).length;
    const approved = vouchers.filter(v => v.status === 'Approved').length;
    const paid    = vouchers.filter(v => v.status === 'Paid').length;
    const totalAmt = vouchers.filter(v => v.status !== 'Voided').reduce((s,v) => s + (Number(v.totalAmount)||0), 0);
    return { total, pending, approved, paid, totalAmt };
  }, [vouchers]);

  // Bulk helpers
  const toggleSel = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => {
    if (selected.size === paginated.length) setSelected(new Set());
    else setSelected(new Set(paginated.map(v => v.id)));
  };

  const bulkSubmit = () => {
    if (!selected.size) return;
    const submittable = vouchers.filter(v => selected.has(v.id) && ['Draft', 'Pending'].includes(v.status));
    const skipped     = selected.size - submittable.length;
    if (!submittable.length) {
      showToast('No eligible vouchers to submit (only Draft vouchers can be submitted).');
      return;
    }
    const skipNote = skipped > 0 ? ` (${skipped} already submitted/approved will be skipped)` : '';
    askConfirm(`Submit ${submittable.length} Draft voucher(s) for verification?${skipNote}`, async () => {
      const results = await Promise.allSettled(submittable.map(v => transitionVoucher(v.id, 'for_verification')));
      const okCount = results.filter(r => r.status === 'fulfilled').length;
      setSelected(new Set());
      showToast(`${okCount}/${submittable.length} voucher(s) submitted for verification.`);
      await loadVouchers();
    });
  };

  const bulkVoid = () => {
    if (!selected.size) return;
    const count = selected.size;
    askConfirm(`Void ${count} voucher(s)? Approved vouchers will have their journal entries reversed.`, async () => {
      const results = await Promise.allSettled([...selected].map(id => apiVoidVoucher(id)));
      const okCount = results.filter(r => r.status === 'fulfilled').length;
      setSelected(new Set());
      showToast(`${okCount}/${count} voucher(s) voided.`);
      await loadVouchers();
    });
  };

  const bulkDelete = () => {
    if (!selected.size) return;
    const count = selected.size;
    askConfirm(`Delete ${count} voucher(s)? Only draft/rejected vouchers can be deleted.`, async () => {
      const results = await Promise.allSettled([...selected].map(id => apiDeleteVoucher(id)));
      const okCount = results.filter(r => r.status === 'fulfilled').length;
      setSelected(new Set());
      showToast(okCount === count ? `${count} voucher(s) deleted.` : `${okCount}/${count} deleted (others aren't deletable — void them instead).`);
      await loadVouchers();
    });
  };

  // Open create/edit modal
  const openNew = (prefill) => {
    setEditing(null);
    if (prefill) {
      const vt = (prefill.voucherType === 'LOAN') ? 'LOAN' : 'PAYMENT';
      setForm({
        voucherType: vt,
        preparationDate: prefill.occurrenceDate || today(),
        purposeCategory: prefill.purposeCategory || '',
        paymentFrom: prefill.bankCode || '',
        status: 'Pending',
        notes: prefill.notes || '',
        inclusive: false,
        loanId: prefill.loanId || '',
        linkedScheduleId: prefill.scheduleId || '',
        linkedScheduleDate: prefill.occurrenceDate || '',
        linkedScheduleTitle: prefill.scheduleTitle || '',
      });
      setLines([{
        ...EMPTY_LINE(),
        contactId:   prefill.contactId || '',
        contact:     prefill.contactName || prefill.contactId || '',
        expenseAccount: prefill.expenseAccountCode || '',
        description: prefill.scheduleTitle || '',
        amount:      prefill.amount ? String(prefill.amount) : '',
        taxRateId:   prefill.taxRateId || '',
      }]);
    } else {
      setForm({ voucherType:'PAYMENT', preparationDate:today(), purposeCategory:'', paymentFrom:'', status:'Pending', notes:'', inclusive:false, loanId:'', checkVoucherId:'' });
      setLines([EMPTY_LINE()]);
    }
    setShowModal(true);
  };

  // Auto-open the new-voucher modal when arriving from Payment Schedule via prefill
  useEffect(() => {
    const prefill = consumeSchedulePrefill('voucher');
    if (prefill) openNew(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open create form when navigating from CreateFlyout
  const location = useLocation();
  useEffect(() => {
    if (location.state?.openCreate) { window.history.replaceState({}, ''); openNew(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openView = async (v) => {
    try {
      setViewModal(await withLines(v));
    } catch (e) {
      showToast(e instanceof ApiError ? e.detail : e.message);
    }
  };

  const openEdit = async (vRow) => {
    let v = vRow;
    try {
      if (!Array.isArray(v.lines)) v = await withLines(v);
    } catch (e) {
      showToast(e instanceof ApiError ? e.detail : e.message);
      return;
    }
    setEditing(v);
    setForm({ voucherType:v.voucherType||'PAYMENT', preparationDate:v.preparationDate||today(), purposeCategory:v.purposeCategory||'', paymentFrom:v.paymentFromAccountCode||'', status:v.status||'Pending', notes:v.notes||'', inclusive: !!(v.lines||[]).find(l=>l.taxRateId)?.inclusive, loanId: v.loanId || '', checkVoucherId: v.checkVoucherId || '' });
    setLines((v.lines||[]).map(l => ({ id:uid(), contactId:l.contactId||'', contact:l.contact||'', expenseAccount:l.expenseAccountCode||'', description:l.description||'', amount:String(l.amount||''), category:l.category||'', taxRateId:l.taxRateId||'', taxType:l.taxType||'N/A', taxRate:l.taxRate||0, taxAmt:l.taxAmt||0, inclusive:l.inclusive||false })));
    if ((v.lines||[]).length === 0) setLines([EMPTY_LINE()]);
    setShowModal(true);
  };

  const duplicate = async (v) => {
    try {
      const src = Array.isArray(v.lines) ? v : await withLines(v);
      await createVoucherDraft(toApiPayload({
        voucherType: src.voucherType, preparationDate: today(),
        purposeCategory: src.purposeCategory, paymentFrom: src.paymentFromAccountCode,
        notes: src.notes, loanId: src.loanId, checkVoucherId: src.checkVoucherId,
      }, (src.lines||[]).map(l => ({ ...l, expenseAccount: l.expenseAccountCode, amount: String(l.amount) }))));
      showToast('Voucher duplicated.');
      await loadVouchers();
    } catch (e) {
      showToast(e instanceof ApiError ? e.detail : e.message);
    }
  };

  const deleteVoucher = (v) => {
    askConfirm(`Delete voucher ${v.voucherId||v.id}?`, async () => {
      try {
        await apiDeleteVoucher(v.id);
        showToast('Voucher deleted.');
        await loadVouchers();
      } catch (e) {
        showToast(e instanceof ApiError ? e.detail : e.message);
      }
    });
  };

  // Build the API payload from a form + lines. Tax/contact/category per-line
  // config rides in `meta` (round-trips losslessly); amounts become centavos.
  const toApiPayload = (f, ls) => {
    const validLines = ls.filter(l => (Number(l.amount)||0) > 0);
    const bank = accounts.find(a => a.code === f.paymentFrom || a.id === f.paymentFrom);
    const contactUuid = validLines.map(l => l.contactId).find(id => id && String(id).length === 36) || null;
    return {
      type: TYPE_TO_API[f.voucherType] || 'payment',
      contactId: contactUuid,
      voucherDate: f.preparationDate,
      notes: f.notes || null,
      purposeCategory: f.purposeCategory || null,
      paymentFromAccountId: bank?.id || null,
      meta: {
        inclusive: !!f.inclusive,
        loanId: f.loanId || '', checkVoucherId: f.checkVoucherId || '',
        linkedScheduleId: f.linkedScheduleId || '', linkedScheduleDate: f.linkedScheduleDate || '',
        contactSummary: [...new Set(validLines.map(l => l.contact).filter(Boolean))].join(', '),
      },
      lines: validLines.map(l => {
        const acct = accounts.find(a => a.code === l.expenseAccount || a.id === l.expenseAccount);
        return {
          accountId: acct?.id,
          description: l.description || undefined,
          amountCents: Math.round((Number(l.amount)||0) * 100),
          meta: {
            contactId: l.contactId || '', contact: l.contact || '', category: l.category || '',
            taxRateId: l.taxRateId || '', taxType: l.taxType || 'N/A',
            taxRate: Number(l.taxRate)||0, taxAmt: Number(l.taxAmt)||0, inclusive: !!l.inclusive,
          },
        };
      }),
    };
  };

  // Save. The server assigns the voucher number and posts the JE only at
  // approval — the old client-side JE creation/syncing is gone.
  const saveVoucher = async () => {
    const payload = toApiPayload(form, lines);
    if (!payload.lines.length) { showToast('Add at least one line with an amount.'); return; }
    if (payload.lines.some(l => !l.accountId)) { showToast('Every line with an amount needs an account.'); return; }
    setSaving(true);
    try {
      if (editing) {
        await updateVoucher(editing.id, payload);
        showToast('Voucher updated.');
      } else {
        const res = await createVoucherDraft(payload);
        // New vouchers enter the queue as Pending (the portal's default flow).
        await transitionVoucher(res.id, 'pending').catch(() => {});
        showToast(`Voucher ${res.voucherNo} created.`);
      }
      setShowModal(false);
      await loadVouchers();
    } catch(e) {
      showToast(e instanceof ApiError ? e.detail : ('Error: ' + e.message));
    }
    setSaving(false);
  };

  const ACCT_TYPE_TO_API = { 'Asset':'asset', 'Liability':'liability', 'Equity':'equity', 'Income':'income', 'Expense':'expense', 'Cost of Services':'expense' };
  const handleSaveNewAcct = async () => {
    if (!newAcctModal.code.trim() || !newAcctModal.name.trim()) { showToast('Account code and name are required.'); return; }
    setNewAcctModal(m => ({...m, saving:true}));
    try {
      await createAccount({
        code: newAcctModal.code.trim(),
        name: newAcctModal.name.trim(),
        type: ACCT_TYPE_TO_API[newAcctModal.type] || 'expense',
        subtype: newAcctModal.type === 'Cost of Services' ? 'Cost of Services' : (newAcctModal.subType || null),
      });
      const rows = await listAccounts();
      setAccounts(rows.map(a => ({ ...a, subType: a.subtype || '' })));
      showToast(`Account ${newAcctModal.code.trim()} created.`);
      setNewAcctModal(null);
    } catch(e) { showToast(e instanceof ApiError ? e.detail : ('Error: ' + e.message)); setNewAcctModal(m => ({...m, saving:false})); }
  };

  const sortIcon = (col) => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // Unified tax registry: individual rates + groups (with effective aggregate rate)
  const taxRegistry = useMemo(() => {
    const rateItems = taxRates.map(r => ({ id: r.id, name: r.name, rate: r.rate || 0, kind: 'rate' }));
    const groupItems = taxGroups.map(g => {
      const effRate = (g.rateNames || []).reduce((sum, rn) => {
        const r = taxRates.find(r2 => r2.name.toLowerCase() === rn.toLowerCase());
        return sum + (r?.rate || 0);
      }, 0);
      return { id: g.id, name: g.name, rate: effRate, kind: 'group' };
    });
    return [...rateItems, ...groupItems].sort((a,b) => a.name.localeCompare(b.name));
  }, [taxRates, taxGroups]);

  // Line helpers
  const setLine = (i, key, val) => setLines(prev => prev.map((l,idx) => {
    if (idx !== i) return l;
    const updated = {...l, [key]:val};
    // When taxRateId changes, auto-fill taxType & rate
    if (key === 'taxRateId') {
      const item = taxRegistry.find(r => r.id === val);
      if (item) { updated.taxType = item.name; updated.taxRate = item.rate || 0; }
      else { updated.taxType = 'N/A'; updated.taxRate = 0; }
    }
    // Recalc tax amount
    const amt = Number(updated.amount)||0;
    const rate = Number(updated.taxRate)||0;
    updated.taxAmt = updated.taxRateId ? (form.inclusive ? amt - amt/(1+rate/100) : amt*(rate/100)) : 0;
    updated.taxAmt = Math.round(updated.taxAmt*100)/100;
    return updated;
  }));
  const addLine = () => setLines(prev => [...prev, EMPTY_LINE()]);
  const removeLine = (i) => setLines(prev => prev.filter((_,idx) => idx !== i));

  // Global inclusive toggle — recalculates taxAmt on all lines
  const handleInclusiveToggle = (checked) => {
    setForm(f => ({...f, inclusive: checked}));
    setLines(prev => prev.map(l => {
      const amt  = Number(l.amount) || 0;
      const rate = Number(l.taxRate) || 0;
      const taxAmt = l.taxRateId ? (checked ? amt - amt/(1+rate/100) : amt*(rate/100)) : 0;
      return {...l, taxAmt: Math.round(taxAmt*100)/100};
    }));
  };

  // isAutoBank: hide Purpose/PaymentFrom for PAYROLL, FINAL_PAY (matches GAS toggleVoucherMode)
  const isAutoBank    = AUTO_BANK_TYPES.includes(form.voucherType);
  const isLoan        = form.voucherType === 'LOAN';
  const isLoanLinked  = form.voucherType === 'LOAN' || form.voucherType === 'PAYMENT';
  const showTax       = TAX_VISIBLE_TYPES.includes(form.voucherType);

  // Derived loan helpers
  const selectedLoan  = isLoan ? (loans.find(l => String(l.id) === String(form.loanId)) || null) : null;
  const isCheckLoan   = !selectedLoan || selectedLoan.paymentMethod === 'Check' || !selectedLoan.paymentMethod;

  // When the linked loan changes: pre-fill lines with contact + categories, clear stale CV
  const handleLoanChange = (newLoanId) => {
    const ln = loans.find(l => String(l.id) === String(newLoanId)) || null;
    const isCheck = !ln || ln.paymentMethod === 'Check' || !ln.paymentMethod;
    // Prioritise "Finance Cost" account; fall back to "Interest Expense" if absent
    const intAcct = accounts.find(a => /finance.?cost/i.test(a.name))
                 || accounts.find(a => /interest.?exp/i.test(a.name));
    const priAcct = accounts.find(a => /loans?.payable/i.test(a.name));
    setForm(f => ({
      ...f,
      loanId: newLoanId,
      checkVoucherId: isCheck ? f.checkVoucherId : '', // clear if switching to non-check loan
    }));
    if (newLoanId && ln) {
      // Only pre-fill if lines are still at default (single empty row)
      const isDefaultLines = lines.length === 1 && !lines[0].contact && !lines[0].amount && !lines[0].expenseAccount;
      if (isDefaultLines) {
        // Compute period-1 interest & principal from loan parameters
        const P  = parseFloat(ln.principal) || 0;
        const r  = (parseFloat(ln.annualRate) || 0) / 100 / 12;
        const tm = Math.max(parseInt(ln.termMonths) || 1, 1);
        let intAmt = 0, priAmt = 0;
        if (P > 0) {
          if (ln.interestMethod === 'Straight-Line' || ln.interestMethod === 'Straight-Line (Monthly Rate)') {
            priAmt = +(P / tm).toFixed(2);
            intAmt = +(P * r).toFixed(2);
          } else if (ln.interestMethod === 'Fixed') {
            priAmt = +(P / tm).toFixed(2);
            intAmt = +(P * (parseFloat(ln.annualRate) || 0) / 100 / 12).toFixed(2);
          } else {
            // Reducing Balance (default)
            const pmt = r === 0 ? P / tm : P * r * Math.pow(1+r,tm) / (Math.pow(1+r,tm)-1);
            intAmt = +(P * r).toFixed(2);
            priAmt = +(Math.max(pmt - intAmt, 0)).toFixed(2);
          }
        }
        setLines([
          { ...EMPTY_LINE(), contact: ln.name || '', description: 'Interest / Finance Cost', category: 'Finance Cost',  expenseAccount: intAcct?.code || '', amount: intAmt || '' },
          { ...EMPTY_LINE(), contact: ln.name || '', description: 'Principal Repayment',      category: 'Loans Payable', expenseAccount: priAcct?.code || '', amount: priAmt || '' },
        ]);
      }
    }
  };

  const lineTotal = lines.reduce((s,l) => s + (Number(l.amount)||0), 0);
  const taxTotal  = showTax ? lines.reduce((s,l) => s + (Number(l.taxAmt)||0), 0) : 0;
  const netCash   = lineTotal - taxTotal;

  // Bank/cash accounts from COA (subType = Bank or Cash)
  const bankAccounts = accounts.filter(a => ['Bank','Cash Equivalents','Cash','Cash and Cash Equivalents'].includes(a.subType) || (a.name||'').toLowerCase().includes('cash in bank'));

  // Auto-generate journal entry lines from voucher lines
  const journalLines = useMemo(() => {
    const jl = [];

    // Format account as "(code) Name"
    const acctLabel = (codeOrFull, fallback = '—') => {
      if (!codeOrFull) return fallback;
      if (codeOrFull.includes(' — ')) {
        const [c, ...rest] = codeOrFull.split(' — ');
        return `(${c.trim()}) ${rest.join(' — ').trim()}`;
      }
      const found = accounts.find(a => a.code === codeOrFull);
      return found ? `(${found.code}) ${found.name}` : codeOrFull;
    };

    // Get display label for a taxRate doc
    // Payment Vouchers are purchases → use taxAccountPurchases for separate tracking
    const taxRateLabel = (rateDoc) => {
      const raw = rateDoc.trackingType === 'separate'
        ? (rateDoc.taxAccountPurchases || rateDoc.taxAccountSingle || '')
        : (rateDoc.taxAccountSingle || '');
      return raw ? acctLabel(raw) : `Tax — ${rateDoc.name}`;
    };

    let bankCreditTotal = 0;

    lines.forEach(l => {
      const amt = Number(l.amount) || 0;
      const tax = Number(l.taxAmt)  || 0;
      if (!amt) return;

      // 1. Expense debit (net of inclusive tax)
      const expenseAmt = (tax > 0 && form.inclusive) ? amt - tax : amt;
      if (l.expenseAccount) {
        jl.push({ account: acctLabel(l.expenseAccount), debit: expenseAmt, credit: 0 });
      }

      // 2. Tax debit lines
      if (tax > 0 && l.taxRateId) {
        const rateDoc = taxRates.find(r => r.id === l.taxRateId);
        if (rateDoc) {
          // Single rate
          jl.push({ account: taxRateLabel(rateDoc), debit: tax, credit: 0 });
        } else {
          // Tax group — split pro-rata across constituent rates
          const groupDoc = taxGroups.find(g => g.id === l.taxRateId);
          if (groupDoc?.rateNames?.length) {
            const effectiveRate = groupDoc.rateNames.reduce((s, rn) => {
              const r = taxRates.find(x => x.name === rn);
              return s + (r?.rate || 0);
            }, 0);
            groupDoc.rateNames.forEach(rn => {
              const r = taxRates.find(x => x.name === rn);
              if (!r) return;
              const share = effectiveRate > 0
                ? Math.round((r.rate / effectiveRate) * tax * 100) / 100
                : Math.round(tax / groupDoc.rateNames.length * 100) / 100;
              jl.push({ account: taxRateLabel(r), debit: share, credit: 0 });
            });
          } else {
            jl.push({ account: `Tax — ${l.taxType || 'Unknown'}`, debit: tax, credit: 0 });
          }
        }
      }

      // 3. Bank credit: gross amount paid (inclusive = full amt; exclusive = amt + tax)
      bankCreditTotal += form.inclusive ? amt : amt + tax;
    });

    // 4. Bank / Cash credit
    const bankAcct = bankAccounts.find(a => a.code === form.paymentFrom || a.id === form.paymentFrom);
    const bankLabel = bankAcct
      ? acctLabel(`${bankAcct.code} — ${bankAcct.name}`)
      : (form.paymentFrom || 'Cash / Bank');
    if (bankCreditTotal > 0) jl.push({ account: bankLabel, debit: 0, credit: bankCreditTotal });

    return jl;
  }, [lines, form.paymentFrom, form.inclusive, bankAccounts, taxRates, taxGroups, accounts]);

  const jDebit  = journalLines.reduce((s,j)=>s+j.debit,0);
  const jCredit = journalLines.reduce((s,j)=>s+j.credit,0);

  const canEdit = (v) => !['Paid','Voided'].includes(v.status);

  return (
    <div className="vp-wrap">
      <style>{CSS}</style>

      {/* Topbar */}
      <div className="vp-topbar">
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <strong style={{fontSize:18,fontWeight:900,color:'#0b1220'}}>VOUCHERS</strong>
          {selected.size > 0 && (
            <div className="bulk-bar" style={{margin:0}}>
              <span style={{fontSize:12,fontWeight:800,color:'#c2410c'}}>{selected.size} Selected</span>
              <button className="btn btn-ghost btn-sm" onClick={bulkSubmit}>Submit for Approval</button>
              <button className="btn btn-ghost btn-sm" style={{color:'#dc2626'}} onClick={bulkVoid}>Void</button>
              <button className="btn btn-ghost btn-sm" style={{color:'#dc2626'}} onClick={bulkDelete}>Delete</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>setSelected(new Set())}>Clear</button>
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={openNew}>＋ NEW VOUCHER</button>
      </div>

      <div className="vp-body">
        {/* ── Primary KPI Scorecards ─────────────────────────────────────── */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:14,marginBottom:12}}>
          <div style={{background:'linear-gradient(135deg,#1e40af 0%,#2563eb 100%)',borderRadius:14,padding:'18px 20px',color:'#fff',position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',right:-8,top:-8,opacity:.13}}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            </div>
            <div style={{fontSize:10,fontWeight:800,letterSpacing:'.08em',textTransform:'uppercase',opacity:.8,marginBottom:6}}>Total Active Amount</div>
            <div style={{fontSize:22,fontWeight:900,letterSpacing:'-.5px'}}>{fmt(kpis.totalAmt)}</div>
            <div style={{marginTop:10,fontSize:11,opacity:.8}}>Across {kpis.total} voucher{kpis.total!==1?'s':''}</div>
          </div>
          <div style={{background:'linear-gradient(135deg,#166534 0%,#16a34a 100%)',borderRadius:14,padding:'18px 20px',color:'#fff',position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',right:-8,top:-8,opacity:.13}}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            </div>
            <div style={{fontSize:10,fontWeight:800,letterSpacing:'.08em',textTransform:'uppercase',opacity:.8,marginBottom:6}}>Approved</div>
            <div style={{fontSize:22,fontWeight:900,letterSpacing:'-.5px'}}>{kpis.approved}</div>
            <div style={{marginTop:10,fontSize:11,opacity:.8}}>Ready for disbursement</div>
          </div>
          <div style={{background:'linear-gradient(135deg,#b45309 0%,#d97706 100%)',borderRadius:14,padding:'18px 20px',color:'#fff',position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',right:-8,top:-8,opacity:.13}}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
            </div>
            <div style={{fontSize:10,fontWeight:800,letterSpacing:'.08em',textTransform:'uppercase',opacity:.8,marginBottom:6}}>Pending / In-Review</div>
            <div style={{fontSize:22,fontWeight:900,letterSpacing:'-.5px'}}>{kpis.pending}</div>
            <div style={{marginTop:10,fontSize:11,opacity:.8}}>Awaiting approval</div>
          </div>
        </div>
        {/* ── Secondary KPI Row ─────────────────────────────────────────── */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:10,marginBottom:16}}>
          {[
            {label:'Total Vouchers',value:kpis.total,sub:'all vouchers',color:'#1d4ed8',bg:'#eff6ff',border:'#bfdbfe',icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>},
            {label:'Paid',value:kpis.paid,sub:'fully disbursed',color:'#15803d',bg:'#f0fdf4',border:'#bbf7d0',icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>},
            {label:'Voided',value:vouchers.filter(v=>v.status==='Voided').length,sub:'cancelled entries',color:'#dc2626',bg:'#fef2f2',border:'#fecaca',icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>},
          ].map(({label,value,sub,color,bg,border,icon})=>(
            <div key={label} style={{background:bg,border:`1px solid ${border}`,borderRadius:12,padding:'14px 15px'}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
                <span style={{color,display:'flex'}}>{icon}</span>
                <span style={{fontSize:9,fontWeight:800,color:'#64748b',letterSpacing:'.07em',textTransform:'uppercase'}}>{label}</span>
              </div>
              <div style={{fontSize:20,fontWeight:900,color,lineHeight:1}}>{value}</div>
              <div style={{fontSize:11,color:'#94a3b8',marginTop:4}}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="toolbar">
          <input className="input" placeholder="🔍 Search ID, contact, purpose…" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} style={{flex:'1 1 200px',minWidth:180}} />
          <select className="input" value={filterType} onChange={e=>{setFilterType(e.target.value);setPage(1);}}>
            <option value="">All Types</option>
            {VOUCHER_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select className="input" value={filterStatus} onChange={e=>{setFilterStatus(e.target.value);setPage(1);}}>
            <option value="">All Statuses</option>
            {STATUSES.map(s=><option key={s}>{s}</option>)}
          </select>
          <input type="date" className="input" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setPage(1);}} />
          <span style={{fontSize:12,color:'#94a3b8',fontWeight:700}}>TO</span>
          <input type="date" className="input" value={dateTo} onChange={e=>{setDateTo(e.target.value);setPage(1);}} />
          <button className="btn btn-ghost btn-sm" onClick={()=>{setSearch('');setFilterType('');setFilterStatus('');setDateFrom('');setDateTo('');setPage(1);}}>✕ Clear</button>
          <span style={{fontSize:12,color:'#94a3b8',fontWeight:600}}>{filtered.length} result{filtered.length!==1?'s':''}</span>
        </div>

        {/* Table */}
        <div className="card">
          <table>
            <thead>
              <tr>
                <th style={{width:40,textAlign:'center'}}><input type="checkbox" checked={selected.size === paginated.length && paginated.length > 0} onChange={toggleAll} /></th>
                <th style={{cursor:'pointer'}} onClick={()=>handleSort('voucherId')}>VOUCHER ID{sortIcon('voucherId')}</th>
                <th style={{cursor:'pointer'}} onClick={()=>handleSort('voucherType')}>TYPE{sortIcon('voucherType')}</th>
                <th style={{cursor:'pointer'}} onClick={()=>handleSort('preparationDate')}>DATE{sortIcon('preparationDate')}</th>
                <th>CONTACT</th>
                <th style={{textAlign:'right',cursor:'pointer'}} onClick={()=>handleSort('totalAmount')}>AMOUNT{sortIcon('totalAmount')}</th>
                <th>STATUS</th>
                <th style={{textAlign:'center'}}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 && (
                <tr><td colSpan={8} className="empty">No vouchers found.</td></tr>
              )}
              {paginated.map(v => {
                return (
                  <tr key={v.id} style={{cursor:'pointer'}} onClick={() => openView(v)}>
                    <td style={{textAlign:'center'}} onClick={e=>e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(v.id)} onChange={()=>toggleSel(v.id)} />
                    </td>
                    <td>
                      <a style={{fontWeight:900,color:'#f97316',textDecoration:'underline',cursor:'pointer'}} onClick={()=>setPdfModal(v)}>
                        {v.voucherId || v.id}
                      </a>
                    </td>
                    <td><span style={{fontSize:11,fontWeight:700,background:'#f1f5f9',padding:'2px 8px',borderRadius:6}}>{v.voucherType||'—'}</span></td>
                    <td>{v.preparationDate||'—'}</td>
                    <td style={{maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.contactSummary||'—'}</td>
                    <td style={{textAlign:'right',fontWeight:700}}>{fmt(v.totalAmount)}</td>
                    <td><StatusPill status={v.status} /></td>
                    <td style={{textAlign:'center'}} onClick={e=>e.stopPropagation()}>
                      <div style={{display:'inline-block'}} ref={openMenuId===v.id ? menuRef : null}>
                        <button
                          className="btn btn-ghost btn-xs"
                          style={{fontWeight:900,letterSpacing:2,padding:'4px 10px',fontSize:15,lineHeight:1}}
                          onClick={(e)=>{
                            if (openMenuId===v.id) { setOpenMenuId(null); return; }
                            const rect = e.currentTarget.getBoundingClientRect();
                            setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                            setOpenMenuId(v.id);
                          }}
                          title="Actions"
                        >···</button>
                        {openMenuId === v.id && (
                          <div style={{
                            position:'fixed',right:menuPos.right,top:menuPos.top,zIndex:9999,
                            background:'#fff',border:'1px solid #e5e7eb',borderRadius:10,
                            boxShadow:'0 8px 24px rgba(0,0,0,.12)',minWidth:140,padding:'4px 0',
                          }}>
                            <button className="km-item" onClick={()=>{openView(v);setOpenMenuId(null);}}>View</button>
                            <button className="km-item" onClick={()=>{setPdfModal(v);setOpenMenuId(null);}}>Download PDF</button>
                            {canEdit(v) && (
                              <button className="km-item" onClick={()=>{openEdit(v);setOpenMenuId(null);}}>Edit</button>
                            )}
                            <button className="km-item" onClick={()=>{duplicate(v);setOpenMenuId(null);}}>Duplicate</button>
                            {v.status === 'Draft' && (
                              <button className="km-item" style={{color:'#dc2626'}} onClick={()=>{deleteVoucher(v);setOpenMenuId(null);}}>Delete</button>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {filtered.length > 0 && (
          <div className="pg-bar">
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span>Rows per page:</span>
              <select className="input" style={{padding:'5px 8px',fontSize:12}} value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1);}}>
                {[25,50,100,200].map(n=><option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <span>Page {page} of {totalPages} — {filtered.length} results</span>
            <div style={{display:'flex',gap:4}}>
              <button className="btn btn-ghost btn-sm" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>‹ Prev</button>
              {Array.from({length:Math.min(5,totalPages)},(_,i)=>i+1).map(n=>(
                <button key={n} className="btn btn-sm" style={{background:page===n?'#f97316':'#f1f5f9',color:page===n?'#fff':'#0b1220'}} onClick={()=>setPage(n)}>{n}</button>
              ))}
              <button className="btn btn-ghost btn-sm" disabled={page>=totalPages} onClick={()=>setPage(p=>p+1)}>Next ›</button>
            </div>
          </div>
        )}
      </div>

      {/* PDF Preview Modal */}
      {pdfModal && (
        <VoucherPdfModal
          voucher={pdfModal}
          autoDownload={!!pdfModal._autoDownload}
          onClose={() => setPdfModal(null)}
        />
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="backdrop" onClick={()=>setShowModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-h">
              <strong>{editing ? `Edit Voucher — ${editing.voucherId||editing.id}` : 'New Voucher'}</strong>
              <button className="btn btn-ghost btn-sm" onClick={()=>setShowModal(false)}>✕</button>
            </div>
            <div className="modal-b">
              {editing && ['For Verification','Verified','For Approval','Approved','For Disbursement'].includes(editing.status) && (
                <div style={{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:10,padding:'10px 14px',marginBottom:14,fontSize:12,fontWeight:700,color:'#92400e'}}>
                  ⚠ This voucher is in <strong>{editing.status}</strong> status. Saving will revert it to <strong>For Verification</strong> for re-processing.
                </div>
              )}
              <div className="grid6">
                {/* Row 1: Voucher ID (read-only) | Voucher Type | Preparation Date */}
                <div className="field col2">
                  <label>Voucher ID</label>
                  <input readOnly value={editing ? (editing.voucherId||editing.id) : (idPreview || 'Auto-assigned on save')} style={{background:'#f8fafc',color:'#64748b',fontWeight:700}} />
                </div>
                <div className="field col2">
                  <label>Voucher Type</label>
                  <select value={form.voucherType||'PAYMENT'} onChange={e=>setForm(f=>({...f,voucherType:e.target.value}))}>
                    {VOUCHER_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="field col2">
                  <label>Preparation Date</label>
                  <input type="date" value={form.preparationDate||''} onChange={e=>setForm(f=>({...f,preparationDate:e.target.value}))} />
                </div>

                {/* Status — always read-only; determined by approval routing */}
                <div className="field col2">
                  <label>Status</label>
                  <div style={{padding:'9px 10px',borderRadius:10,border:'1px solid #e5e7eb',background:'#f8fafc',fontSize:13,fontWeight:700,...(STATUS_STYLES[form.status||'Pending']||{})}}>{form.status||'Pending'}</div>
                </div>

                {/* Purpose Category — hidden for PAYROLL/FINAL_PAY (auto-bank, matches GAS toggleVoucherMode) */}
                {!isAutoBank && (
                  <div className="field col2">
                    <label>Purpose / Category</label>
                    <input value={form.purposeCategory||''} onChange={e=>setForm(f=>({...f,purposeCategory:e.target.value}))} placeholder="e.g. Bills Payment, Salaries…" list="purpose-suggestions" />
                    <datalist id="purpose-suggestions">{purposeCategories.map(s=><option key={s} value={s} />)}</datalist>
                  </div>
                )}

                {/* Payment From — hidden for PAYROLL/FINAL_PAY (bank auto-resolved per line) */}
                {!isAutoBank && (
                  <div className="field col2">
                    <label>Payment From (Bank)</label>
                    <AccountCombobox
                      options={[
                        ...bankAccounts.map(a=>({value:a.code||a.id,label:`${a.code} — ${a.name}`})),
                        ...(bankAccounts.length===0 ? accounts.map(a=>({value:a.code||a.id,label:`${a.code} — ${a.name}`})) : []),
                      ]}
                      value={form.paymentFrom||''}
                      onChange={v=>setForm(f=>({...f,paymentFrom:v}))}
                      placeholder="— Select Account —"
                    />
                  </div>
                )}

                {/* Payroll type notice */}
                {form.voucherType === 'PAYROLL' && (
                  <div className="field col6" style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:10,padding:'10px 14px',fontSize:12,color:'#15803d',fontWeight:700}}>
                    ℹ️ Payroll Voucher — Payment bank is resolved per payroll line. Add payroll lines manually or import from your Payroll module.
                  </div>
                )}
                {form.voucherType === 'FINAL_PAY' && (
                  <div className="field col6" style={{background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:10,padding:'10px 14px',fontSize:12,color:'#0369a1',fontWeight:700}}>
                    ℹ️ Final Pay Voucher — Payment bank is resolved per employee line. Add final pay lines manually.
                  </div>
                )}
                {isLoan && (
                  <>
                    <div className="field col6" style={{background:'#fdf4ff',border:'1px solid #e9d5ff',borderRadius:10,padding:'7px 14px',fontSize:12,color:'#7c3aed',fontWeight:700,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                      ℹ️ Loan Voucher — Records loan releases or amortization payments. Auto-posts to Loan Monitoring when paid via Disbursement Report.
                    </div>
                    <div className="field col3">
                      <label>Linked Loan</label>
                      <select value={form.loanId||''} onChange={e=>handleLoanChange(e.target.value)}>
                        <option value="">— None (skip auto-post) —</option>
                        {loans.filter(l=>l.status!=='Disposed').map(l => (
                          <option key={l.id} value={l.id}>{l.name||`Loan ${l.id}`} — {l.loanType||'Loan'}</option>
                        ))}
                      </select>
                    </div>
                    {isCheckLoan && (
                    <div className="field col3">
                      <label>Linked Check Voucher (CV) <span style={{fontWeight:400,color:'#94a3b8'}}>— optional, for check payments</span></label>
                      {/* Searchable CV picker — shows only loan-linked CVs */}
                      <div style={{position:'relative'}}>
                        <input
                          value={cvDropOpen ? cvSearch : (form.checkVoucherId || '')}
                          onChange={e => { setCvSearch(e.target.value); setCvDropOpen(true); setForm(f=>({...f,checkVoucherId:''})); }}
                          onFocus={() => { setCvSearch(''); setCvDropOpen(true); }}
                          onBlur={() => setTimeout(() => setCvDropOpen(false), 180)}
                          placeholder="Search CV…"
                          autoComplete="off"
                          style={{fontFamily:'monospace', width:'100%'}}
                        />
                        {cvDropOpen && (() => {
                          const loanCvs = cvList.filter(cv =>
                            (!form.loanId || String(cv.loanId) === String(form.loanId)) &&
                            (!cvSearch.trim() || (cv.voucherId||'').toLowerCase().includes(cvSearch.trim().toLowerCase()) ||
                              (cv.contactSummary||'').toLowerCase().includes(cvSearch.trim().toLowerCase()))
                          );
                          return (
                            <div style={{position:'absolute',top:'100%',left:0,right:0,zIndex:50,background:'#fff',border:'1px solid #d1d5db',borderRadius:8,boxShadow:'0 8px 24px rgba(0,0,0,.12)',maxHeight:200,overflowY:'auto'}}>
                              {loanCvs.length === 0
                                ? <div style={{padding:'10px 12px',fontSize:12,color:'#94a3b8'}}>
                                    {form.loanId ? 'No CVs found for this loan.' : 'No loan-linked CVs found.'}
                                  </div>
                                : loanCvs.map(cv => (
                                  <div
                                    key={cv.docId}
                                    onMouseDown={() => { setForm(f=>({...f,checkVoucherId:cv.voucherId})); setCvSearch(''); setCvDropOpen(false); }}
                                    style={{padding:'8px 12px',cursor:'pointer',fontSize:12,borderBottom:'1px solid #f1f5f9',background:'#fff'}}
                                    onMouseEnter={e=>e.currentTarget.style.background='#f0f9ff'}
                                    onMouseLeave={e=>e.currentTarget.style.background='#fff'}
                                  >
                                    <strong style={{fontFamily:'monospace',color:'#0369a1'}}>{cv.voucherId}</strong>
                                    {cv.contactSummary ? <span style={{color:'#64748b'}}> · {cv.contactSummary}</span> : null}
                                    {cv.totalAmount ? <span style={{color:'#f97316',fontWeight:700}}> · ₱{Number(cv.totalAmount).toLocaleString('en-PH',{minimumFractionDigits:2})}</span> : null}
                                    {cv.preparationDate ? <span style={{color:'#94a3b8'}}> · {cv.preparationDate}</span> : null}
                                  </div>
                                ))
                              }
                            </div>
                          );
                        })()}
                      </div>
                      {form.checkVoucherId && !cvDropOpen && (
                        <span style={{fontSize:10,color:'#0369a1',marginTop:3,display:'block'}}>
                          ✓ CV linked — check will be auto-cleared when payment is recorded.
                          <button
                            type="button"
                            onClick={() => setForm(f=>({...f,checkVoucherId:''}))}
                            style={{marginLeft:8,background:'none',border:'none',color:'#ef4444',cursor:'pointer',fontSize:10,fontWeight:700,padding:0}}
                          >✕ Remove</button>
                        </span>
                      )}
                      {!form.checkVoucherId && !cvDropOpen && (
                        <span style={{fontSize:10,color:'#94a3b8',marginTop:3,display:'block'}}>Optional — skip for auto-debit / bank transfer payments.</span>
                      )}
                    </div>
                    )}{/* end isCheckLoan */}
                    <div className="field col6" style={{marginTop:4}}>
                      <div style={{fontSize:11,color:'#64748b',fontWeight:600,padding:'9px 0'}}>
                        {form.loanId
                          ? <>✅ Auto-post enabled. Tag lines with category <code>Finance Cost</code> (interest) or <code>Loans Payable</code> (principal) for accurate split.</>
                          : 'No loan linked — payment will not auto-post.'}
                      </div>
                      {form.checkVoucherId && (
                        <div style={{marginTop:6,padding:'8px 12px',background:'#eff6ff',border:'1px solid #bfdbfe',borderLeft:'3px solid #2563eb',borderRadius:8,fontSize:11,color:'#1e40af',lineHeight:1.5}}>
                          📒 <strong>Non-posting LV</strong> — No journal entry will be created when this voucher is saved. The GL entry (Dr. Interest / Dr. Principal / Cr. Cash in Bank) will be posted automatically when the linked check <strong>{form.checkVoucherId}</strong> is cleared in Check Registry.
                        </div>
                      )}
                    </div>
                  </>
                )}
                <div className="field col6">
                  <label>Notes</label>
                  <textarea rows={2} value={form.notes||''} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} />
                </div>
              </div>

              {/* Payment Details */}
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:20,marginBottom:0}}>
                <div className="section-title" style={{margin:0}}>Payment Details</div>
                {showTax && (
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:12,fontWeight:700,color:'#64748b',userSelect:'none'}}>
                    <input type="checkbox" checked={!!form.inclusive} onChange={e=>handleInclusiveToggle(e.target.checked)}
                      style={{width:'auto',accentColor:'#f97316',cursor:'pointer'}} />
                    Tax amounts are inclusive
                  </label>
                )}
              </div>
              <table className="lines-tbl" style={{fontSize:12,marginBottom:8}}>
                <thead>
                  <tr>
                    <th style={{width:28}}>#</th>
                    <th>Contact</th>
                    <th>Account</th>
                    <th>Description</th>
                    {isAutoBank && <th style={{width:100}}>Category</th>}
                    {showTax && <th style={{minWidth:160}}>Tax Rate</th>}
                    <th style={{textAlign:'right',width:110}}>Amount</th>
                    {showTax && <th style={{textAlign:'right',width:90}}>Tax Amt</th>}
                    <th style={{width:32}}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l,i) => (
                    <tr key={l.id}>
                      <td style={{textAlign:'center',color:'#94a3b8',fontWeight:700}}>{i+1}</td>
                      <td>
                        <ContactPicker
                          contacts={contacts}
                          value={l.contactId}
                          displayName={l.contact}
                          defaultNewType={form.voucherType==='PAYROLL'||form.voucherType==='FINAL_PAY' ? 'Employee' : 'Supplier'}
                          onChange={({contactId, contactName})=>{ setLine(i,'contactId',contactId); setLine(i,'contact',contactName); }}
                          compact
                        />
                      </td>
                      <td>
                        <AccountCombobox
                          rawAccounts={accounts}
                          value={l.expenseAccount}
                          onChange={v=>setLine(i,'expenseAccount',v)}
                          placeholder="— Select Account —"
                          onNewAccount={()=>setNewAcctModal({code:'',name:'',type:'Expense',subType:'General and Administrative Expenses',parent:'',saving:false})}
                        />
                      </td>
                      <td><input value={l.description} onChange={e=>setLine(i,'description',e.target.value)} placeholder="Description" /></td>
                      {isAutoBank && (
                        <td>
                          <select value={l.category||'Deployed'} onChange={e=>setLine(i,'category',e.target.value)}>
                            <option>Head Office</option>
                            <option>Deployed</option>
                            <option>Other</option>
                          </select>
                        </td>
                      )}
                      {showTax && (
                        <td style={{minWidth:160}}>
                          <select value={l.taxRateId||''} onChange={e=>setLine(i,'taxRateId',e.target.value)} style={{marginBottom:3}}>
                            <option value="">N/A</option>
                            {taxRates.length > 0 && <optgroup label="— Rates —">{taxRates.map(r=><option key={r.id} value={r.id}>{r.name} ({fmtP(r.rate)})</option>)}</optgroup>}
                            {taxGroups.length > 0 && <optgroup label="— Groups —">{taxGroups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</optgroup>}
                          </select>
                        </td>
                      )}
                      <td><input type="number" style={{textAlign:'right'}} value={l.amount} onChange={e=>setLine(i,'amount',e.target.value)} placeholder="0.00" /></td>
                      {showTax && (
                        <td style={{textAlign:'right',color:'#7c3aed',fontWeight:700,fontSize:12,whiteSpace:'nowrap'}}>{l.taxAmt>0?fmt(l.taxAmt):'—'}</td>
                      )}
                      <td><button className="btn btn-ghost btn-xs" style={{color:'#dc2626'}} onClick={()=>removeLine(i)} disabled={lines.length<=1}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn btn-ghost btn-sm" onClick={addLine}>+ Add New Row</button>
              <div className="tfoot-row" style={{flexDirection:'column',alignItems:'flex-end',gap:4}}>
                {showTax && <div style={{display:'flex',gap:20}}><span style={{color:'#94a3b8'}}>Total Tax:</span><span style={{color:'#7c3aed'}}>{fmt(taxTotal)}</span></div>}
                <div style={{display:'flex',gap:20,fontSize:15,fontWeight:900}}><span style={{color:'#64748b'}}>NET CASH DISBURSED</span><span style={{color:'#0b1220'}}>{fmt(netCash)}</span></div>
              </div>

              {/* Auto-Generated Journal Entry */}
              <div className="section-title" style={{marginTop:20}}>Journal Entry (Auto-Generated)</div>
              <table className="lines-tbl" style={{fontSize:12,background:'#f8fafc',borderRadius:10,overflow:'hidden'}}>
                <thead>
                  <tr>
                    <th style={{width:'50%'}}>COA (Account Name)</th>
                    <th style={{textAlign:'right'}}>Debit</th>
                    <th style={{textAlign:'right'}}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {journalLines.length === 0 ? (
                    <tr><td colSpan={3} style={{textAlign:'center',color:'#94a3b8',padding:'14px'}}>Fill out payment details to generate journal entry</td></tr>
                  ) : journalLines.map((j,i) => (
                    <tr key={i}>
                      <td style={{fontWeight:600, paddingLeft: j.credit > 0 ? 28 : 8}}>{j.account}</td>
                      <td style={{textAlign:'right',color:j.debit>0?'#15803d':'#94a3b8'}}>{j.debit>0?fmt(j.debit):'—'}</td>
                      <td style={{textAlign:'right',color:j.credit>0?'#dc2626':'#94a3b8'}}>{j.credit>0?fmt(j.credit):'—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{background:'#e2e8f0'}}>
                    <td style={{fontWeight:900,fontSize:11,textTransform:'uppercase',letterSpacing:'.05em'}}>Total</td>
                    <td style={{textAlign:'right',fontWeight:900}}>{fmt(jDebit)}</td>
                    <td style={{textAlign:'right',fontWeight:900}}>{fmt(jCredit)}</td>
                  </tr>
                  {Math.abs(jDebit-jCredit)>0.01&&<tr><td colSpan={3} style={{color:'#dc2626',fontSize:11,fontWeight:700,textAlign:'right'}}>⚠ Entry is not balanced ({fmt(Math.abs(jDebit-jCredit))} difference)</td></tr>}
                </tfoot>
              </table>
            </div>
            <div className="modal-f">
              <button className="btn btn-ghost" onClick={()=>setShowModal(false)}>Cancel</button>
              {!(editing && ['For Verification','Verified','For Approval','Approved','For Disbursement'].includes(editing.status)) && (
                <button className="btn btn-ghost" onClick={()=>saveVoucher('Draft')} disabled={saving}>Save Draft</button>
              )}
              <button className="btn btn-primary" onClick={()=>saveVoucher('For Verification')} disabled={saving}>
                {saving ? 'Saving…' : (editing && ['For Verification','Verified','For Approval','Approved','For Disbursement'].includes(editing.status) ? 'Save & Re-submit' : 'Submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Modal */}
      {viewModal && (() => {
        const v         = viewModal;
        const vLines    = v.lines || [];
        const totalAmt  = vLines.reduce((s,l) => s + (Number(l.amount)||0), 0);
        const typeLabel = VOUCHER_TYPES.find(t => t.value === v.voucherType)?.label || v.voucherType || 'Voucher';
        const vSs       = STATUS_STYLES[v.status] || STATUS_STYLES['Pending'];
        const fromAcct  = accounts.find(a => a.code === v.paymentFromAccountCode || a.id === v.paymentFromAccountCode);
        const STEPS     = ['Pending','For Verification','Verified','For Approval','Approved','Paid'];
        const stepIdx   = STEPS.indexOf(v.status);
        const jeLines   = previewJe?.lines || [];
        const jeTotalDr = jeLines.reduce((s,l) => s + (l.debit  || 0), 0);
        const jeTotalCr = jeLines.reduce((s,l) => s + (l.credit || 0), 0);
        const jeStatus  = previewJe?.status;
        const jeId      = previewJe?.jeId || previewJe?.id;

        return (
          <div className="backdrop" onClick={() => setViewModal(null)}>
            <div style={{ width:'min(860px,98vw)', maxHeight:'92vh', background:'#fff', borderRadius:16, display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 24px 64px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 20px', borderBottom:'1px solid #e5e7eb', background:'#f8fafc', flexShrink:0 }}>
                <span style={{ fontFamily:'monospace', fontWeight:900, fontSize:15 }}>{v.voucherId || v.id}</span>
                <span className="pill" style={{ background:vSs.background, borderColor:vSs.borderColor, color:vSs.color }}>{v.status || 'Pending'}</span>
                <span style={{ fontSize:11, color:'#64748b', marginLeft:2 }}>{typeLabel}</span>
                <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
                  <button className="btn btn-ghost btn-sm" style={{ fontSize:12 }}
                    onClick={() => setPdfModal({ ...v, _autoDownload: true })}>⬇ Download PDF</button>
                  {canEdit(v) && (
                    <button className="btn btn-ghost btn-sm" style={{ fontSize:12 }}
                      onClick={() => { setViewModal(null); openEdit(v); }}>✎ Edit</button>
                  )}
                  <button style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#94a3b8', lineHeight:1 }} onClick={() => setViewModal(null)}>✕</button>
                </div>
              </div>

              <div style={{ overflowY:'auto', flex:1, padding:'18px 20px' }}>

                {/* Approval progress */}
                <div style={{ marginBottom:18 }}>
                  <div style={{ position:'relative' }}>
                    <div style={{ position:'absolute', top:10, left:`${100/STEPS.length/2}%`, right:`${100/STEPS.length/2}%`, height:2, background:'#e2e8f0', zIndex:0 }} />
                    {stepIdx > 0 && (
                      <div style={{ position:'absolute', top:10, left:`${100/STEPS.length/2}%`, width:`calc(${stepIdx/(STEPS.length-1)} * (100% - ${100/STEPS.length}%))`, height:2, background:'#22c55e', zIndex:1, transition:'width .3s' }} />
                    )}
                    <div style={{ display:'flex', position:'relative', zIndex:2 }}>
                      {STEPS.map((s, i) => {
                        const done    = stepIdx > i || v.status === 'Paid';
                        const current = stepIdx === i;
                        const bg = done ? '#22c55e' : current ? '#f97316' : '#e2e8f0';
                        const tc = done || current ? '#fff' : '#94a3b8';
                        return (
                          <div key={s} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center' }}>
                            <div style={{ width:22, height:22, borderRadius:'50%', background:bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, color:tc }}>
                              {done ? '✓' : i + 1}
                            </div>
                            <div style={{ fontSize:9, marginTop:4, fontWeight: current ? 800 : 500, color: current ? '#f97316' : '#64748b', whiteSpace:'nowrap', textAlign:'center' }}>{s}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Voucher info grid */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:16, background:'#f8fafc', border:'1px solid #e5e7eb', borderRadius:10, padding:'12px 14px' }}>
                  <div>
                    <div style={{ fontSize:9, fontWeight:800, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Date</div>
                    <div style={{ fontWeight:700, fontSize:13 }}>{v.preparationDate || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:9, fontWeight:800, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Payee</div>
                    <div style={{ fontWeight:700, fontSize:13 }}>{v.contactSummary || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:9, fontWeight:800, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Total Amount</div>
                    <div style={{ fontWeight:900, fontSize:15, color:'#0b1220' }}>{fmt(v.totalAmount ?? totalAmt)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:9, fontWeight:800, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Purpose</div>
                    <div style={{ fontSize:12, color:'#374151' }}>{v.purposeCategory || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize:9, fontWeight:800, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Payment From</div>
                    <div style={{ fontSize:12, color:'#374151' }}>{fromAcct ? `${fromAcct.code} — ${fromAcct.name}` : (v.paymentFromAccountCode || '—')}</div>
                  </div>
                  {v.notes && (
                    <div style={{ gridColumn:'1/-1' }}>
                      <div style={{ fontSize:9, fontWeight:800, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Notes</div>
                      <div style={{ fontSize:12, color:'#374151' }}>{v.notes}</div>
                    </div>
                  )}
                </div>

                {/* Payment lines */}
                {vLines.length > 0 && (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:11, fontWeight:800, color:'#0b1220', marginBottom:6, textTransform:'uppercase', letterSpacing:'.05em' }}>Payment Details</div>
                    <div style={{ border:'1px solid #e5e7eb', borderRadius:10, overflow:'hidden' }}>
                      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                        <thead><tr style={{ background:'#f8fafc' }}>
                          <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Contact</th>
                          <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Expense Acct</th>
                          <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Description</th>
                          <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Tax Rate</th>
                          <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'right', textTransform:'uppercase' }}>Amount</th>
                          <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'right', textTransform:'uppercase' }}>Tax</th>
                        </tr></thead>
                        <tbody>
                          {vLines.map((l, i) => (
                            <tr key={i} style={{ borderTop:'1px solid #f1f5f9' }}>
                              <td style={{ padding:'7px 10px' }}>{l.contact || '—'}</td>
                              <td style={{ padding:'7px 10px', fontSize:12 }}>{accounts.find(a => a.code === l.expenseAccountCode || a.id === l.expenseAccountCode)?.name || l.expenseAccountCode || '—'}</td>
                              <td style={{ padding:'7px 10px', color:'#64748b' }}>{l.description || '—'}</td>
                              <td style={{ padding:'7px 10px', fontSize:11, color:'#374151' }}>
                                {l.taxType && l.taxType !== 'N/A' ? (l.taxRate > 0 ? `${l.taxType} ${l.taxRate}%` : l.taxType) : '—'}
                              </td>
                              <td style={{ padding:'7px 10px', textAlign:'right', fontWeight:700 }}>{fmt(l.amount)}</td>
                              <td style={{ padding:'7px 10px', textAlign:'right', fontSize:11, color:'#64748b' }}>{l.taxAmt > 0 ? fmt(l.taxAmt) : '—'}</td>
                            </tr>
                          ))}
                          <tr style={{ borderTop:'2px solid #e5e7eb', background:'#f8fafc' }}>
                            <td colSpan={4} style={{ padding:'7px 10px', fontWeight:800, textAlign:'right', fontSize:11, color:'#64748b' }}>GROSS TOTAL</td>
                            <td style={{ padding:'7px 10px', textAlign:'right', fontWeight:900, fontSize:13 }}>{fmt(v.totalAmount ?? totalAmt)}</td>
                            <td />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Journal Entry section */}
                {(v.linkedJeId || previewJe) && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:800, color:'#0b1220', marginBottom:6, textTransform:'uppercase', letterSpacing:'.05em', display:'flex', alignItems:'center', gap:8 }}>
                      Journal Entry
                      {jeId && <span style={{ fontFamily:'monospace', fontWeight:700, fontSize:11, padding:'2px 8px', borderRadius:6, background:'#eff6ff', color:'#1e40af', border:'1px solid #bfdbfe' }}>{jeId}</span>}
                      {jeStatus && (
                        <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20,
                          background: jeStatus === 'Posted' ? '#d1fae5' : jeStatus === 'For Clearing' ? '#fffbeb' : '#f1f5f9',
                          color:      jeStatus === 'Posted' ? '#065f46' : jeStatus === 'For Clearing' ? '#92400e' : '#64748b',
                          border:     jeStatus === 'Posted' ? '1px solid #a7f3d0' : jeStatus === 'For Clearing' ? '1px solid #fde68a' : '1px solid #e2e8f0',
                        }}>{jeStatus}</span>
                      )}
                      {!previewJe && v.linkedJeId && <span style={{ fontSize:11, color:'#94a3b8', fontWeight:400 }}>Loading…</span>}
                    </div>
                    {jeLines.length > 0 && (
                      <div style={{ border:'1px solid #e5e7eb', borderRadius:10, overflow:'hidden' }}>
                        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                          <thead><tr style={{ background:'#f8fafc' }}>
                            <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Account Code</th>
                            <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Account Name</th>
                            <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'left', textTransform:'uppercase' }}>Description</th>
                            <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'right', textTransform:'uppercase' }}>Debit</th>
                            <th style={{ padding:'7px 10px', fontWeight:800, fontSize:10, color:'#64748b', textAlign:'right', textTransform:'uppercase' }}>Credit</th>
                          </tr></thead>
                          <tbody>
                            {jeLines.map((l, i) => (
                              <tr key={i} style={{ borderTop:'1px solid #f1f5f9' }}>
                                <td style={{ padding:'7px 10px', fontFamily:'monospace', fontSize:11, color:'#475569' }}>{l.accountCode || '—'}</td>
                                <td style={{ padding:'7px 10px', fontWeight:600, color:'#0f172a', paddingLeft: l.debit === 0 ? 24 : 10 }}>{l.accountName || '—'}</td>
                                <td style={{ padding:'7px 10px', color:'#94a3b8', fontSize:11 }}>{l.description || ''}</td>
                                <td style={{ padding:'7px 10px', textAlign:'right', fontWeight:700, color: l.debit > 0 ? '#15803d' : '#d1d5db' }}>{l.debit > 0 ? fmt(l.debit) : '—'}</td>
                                <td style={{ padding:'7px 10px', textAlign:'right', fontWeight:700, color: l.credit > 0 ? '#1d4ed8' : '#d1d5db' }}>{l.credit > 0 ? fmt(l.credit) : '—'}</td>
                              </tr>
                            ))}
                            <tr style={{ borderTop:'2px solid #e5e7eb', background:'#f8fafc' }}>
                              <td colSpan={3} style={{ padding:'7px 10px', fontWeight:800, textAlign:'right', fontSize:11, color:'#64748b' }}>Total</td>
                              <td style={{ padding:'7px 10px', textAlign:'right', fontWeight:900, fontSize:13, color:'#15803d' }}>{fmt(jeTotalDr)}</td>
                              <td style={{ padding:'7px 10px', textAlign:'right', fontWeight:900, fontSize:13, color:'#1d4ed8' }}>{fmt(jeTotalCr)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

              </div>

              {/* Footer */}
              <div style={{ display:'flex', gap:8, alignItems:'center', padding:'12px 20px', borderTop:'1px solid #e5e7eb', background:'#fff', flexShrink:0, flexWrap:'wrap' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => duplicate(v)}>Duplicate</button>
                {v.status === 'Pending' && (
                  <button className="btn btn-ghost btn-sm" style={{ color:'#c2410c', borderColor:'#fed7aa' }}
                    onClick={async () => {
                      try {
                        await transitionVoucher(v.id, 'for_verification');
                        setViewModal(prev => prev ? { ...prev, status: 'For Verification' } : null);
                        showToast('Voucher re-submitted for verification.');
                        await loadVouchers();
                      } catch (e) {
                        showToast(e instanceof ApiError ? e.detail : e.message);
                      }
                    }}>
                    Re-submit for Verification
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" style={{ marginLeft:'auto' }} onClick={() => setViewModal(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmModal && (
        <div className="backdrop" onClick={() => setConfirmModal(null)}>
          <div style={{width:'min(400px,98vw)',background:'#fff',borderRadius:16,overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,.25)'}} onClick={e=>e.stopPropagation()}>
            <div style={{padding:'14px 18px',borderBottom:'1px solid #e5e7eb',background:'#f8fafc',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <strong style={{fontSize:14,fontWeight:900,color:'#0b1220'}}>Confirm Action</strong>
              <button className="btn btn-ghost btn-sm" onClick={()=>setConfirmModal(null)}>✕</button>
            </div>
            <div style={{padding:'18px'}}>
              <p style={{margin:0,fontSize:14,color:'#0b1220',lineHeight:1.5}}>{confirmModal.message}</p>
            </div>
            <div style={{display:'flex',justifyContent:'flex-end',gap:10,padding:'12px 18px',borderTop:'1px solid #e5e7eb'}}>
              <button className="btn btn-ghost" onClick={()=>setConfirmModal(null)}>Cancel</button>
              <button className="btn btn-primary" style={{background:'#dc2626'}} onClick={()=>{confirmModal.onConfirm();setConfirmModal(null);}}>Confirm</button>
            </div>
          </div>
        </div>
      )}
      {/* New Account Modal — extracted to NewAccountModal.jsx (Track B B4).
          Was two byte-identical inline copies referencing undefined ACCT_TYPES /
          ACCT_SUBTYPES; both are replaced by this single tested component. */}
      <NewAccountModal
        modal={newAcctModal}
        onChange={setNewAcctModal}
        accounts={accounts}
        onCancel={() => setNewAcctModal(null)}
        onSave={handleSaveNewAcct}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
