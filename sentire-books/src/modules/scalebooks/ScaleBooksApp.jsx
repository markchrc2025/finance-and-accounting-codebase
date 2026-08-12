import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { getSettings } from '../../lib/api.js';

import DashboardPage       from './DashboardPage.jsx';
import VouchersPage        from './vouchers/VouchersPage.jsx';
import JournalPage         from './journal/JournalPage.jsx';
import COAPage             from './coa/COAPage.jsx';
import BankPage            from './bank/BankPage.jsx';
import BillingPage         from './billing/BillingPage.jsx';
import BillingClientPage   from './billing/BillingClientPage.jsx';
import ContactsPage        from './contacts/ContactsPage.jsx';
import ApprovalsPage       from './approvals/ApprovalsPage.jsx';
import ProjectionsPage     from './projections/ProjectionsPage.jsx';
import PaymentSchedulePage from './schedule/PaymentSchedulePage.jsx';
import DisbursementsPage   from './disbursements/DisbursementsPage.jsx';
import CheckRegistryPage   from './checks/CheckRegistryPage.jsx';
import TaxPage             from './tax/TaxPage.jsx';
import FinancialPage       from './financial/FinancialPage.jsx';
import FixedAssetsPage     from './assets/FixedAssetsPage.jsx';
import ServiceInvoicesPage from './invoices/ServiceInvoicesPage.jsx';
import InvoiceIssuancePage from './invoices/InvoiceIssuancePage.jsx';
import CollectionsPage     from './collections/CollectionsPage.jsx';
import CollectionsPostingPage from './collections/CollectionsPostingPage.jsx';
import SettingsPage        from './settings/SettingsPage.jsx';
import UserProfilePage     from './settings/UserProfilePage.jsx';
import ReportBuilderPage   from './reports/ReportBuilderPage';
import ReportsLandingPage  from './reports/ReportsLandingPage';

import { PermissionsProvider, usePermissions } from '../../contexts/PermissionsContext.jsx';
import { isDeferredModule } from '../../config/deferredModules.js';
import AccessDenied from '../../components/AccessDenied.jsx';
import { LeftRail } from '../../components/shell/LeftRail.tsx';
import { TopBar } from '../../components/shell/TopBar.tsx';
import { CreateFlyout } from '../../components/shell/CreateFlyout.jsx';
import { CommandPalette } from '../../components/shell/CommandPalette.jsx';
import { useApprovalCount } from '../../hooks/useApprovalCount.js';

// ── Component ─────────────────────────────────────────────
export default function ScaleBooksApp() {
  return (
    <PermissionsProvider>
      <ScaleBooksAppInner />
    </PermissionsProvider>
  );
}

// ── Route-level permission guard ──────────────────────────
function ModuleGuard({ module: moduleName, children }) {
  const { hasAccess, loading } = usePermissions();
  // Deferred modules (M0.5) are unreachable even by direct URL. The route stays
  // registered so the code is exercised by the build, not deleted.
  if (isDeferredModule(moduleName)) return <AccessDenied module={moduleName} />;
  if (loading) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'#94a3b8', fontFamily:'Inter,sans-serif', fontSize:13 }}>
        Checking permissions…
      </div>
    );
  }
  if (!hasAccess(moduleName)) return <AccessDenied module={moduleName} />;
  return children;
}

// ── Inner app (needs PermissionsProvider in tree) ─────────
function ScaleBooksAppInner() {
  const [createFlyoutOpen,  setCreateFlyoutOpen]  = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [profile, setProfile] = useState({ companyName: '', logoUrl: '' });
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const approvalCount = useApprovalCount();

  const userEmail = session?.user?.email || '';
  const userName  = session?.user?.fullName || (userEmail ? userEmail.split('@')[0] : '');

  // Company branding (name + logo) from org settings — loaded once.
  useEffect(() => {
    getSettings()
      .then(s => {
        const p = s?.profile || {};
        setProfile({ companyName: p.companyName || '', logoUrl: p.logoUrl || '' });
      })
      .catch(() => {});
  }, []);

  function handleSignOut() {
    signOut();
  }

  return (
    <div className="flex flex-col h-screen w-screen">
      <TopBar
        companyName={profile.companyName}
        userName={userName || undefined}
        userEmail={userEmail || undefined}
        logoUrl={profile.logoUrl}
        onSignOut={handleSignOut}
        approvalCount={approvalCount}
        onApprovalsClick={() => navigate('/approvals')}
        onSearchClick={() => setCommandPaletteOpen(true)}
        onSettingsClick={() => navigate('/settings')}
        onProfileClick={() => navigate('/profile')}
      />
      <div className="flex flex-1 overflow-hidden">
        <LeftRail onCreateClick={() => setCreateFlyoutOpen(true)} />
        <main className="flex-1 overflow-auto bg-[#F9FAFB]">
          <Routes>
            {/* Dashboard — always accessible */}
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />

            {/* Disbursement */}
            <Route path="vouchers/*"    element={<ModuleGuard module="Vouchers"><VouchersPage /></ModuleGuard>} />
            <Route path="approvals"     element={<ModuleGuard module="Approvals"><ApprovalsPage /></ModuleGuard>} />
            <Route path="projections"   element={<ModuleGuard module="Weekly Projections"><ProjectionsPage /></ModuleGuard>} />
            <Route path="pay-schedule"  element={<ModuleGuard module="Payment Schedule"><PaymentSchedulePage /></ModuleGuard>} />
            <Route path="disbursements" element={<ModuleGuard module="Disbursements"><DisbursementsPage /></ModuleGuard>} />
            <Route path="checks"        element={<ModuleGuard module="Check Registry"><CheckRegistryPage /></ModuleGuard>} />

            {/* Accountant */}
            <Route path="journal"   element={<ModuleGuard module="Journal"><JournalPage /></ModuleGuard>} />
            <Route path="bank"      element={<ModuleGuard module="Bank"><BankPage /></ModuleGuard>} />
            <Route path="coa"       element={<ModuleGuard module="Chart of Accounts"><COAPage /></ModuleGuard>} />
            <Route path="tax"       element={<ModuleGuard module="Tax"><TaxPage /></ModuleGuard>} />
            <Route path="financial" element={<ModuleGuard module="Financial Management"><FinancialPage /></ModuleGuard>} />
            <Route path="assets"    element={<ModuleGuard module="Fixed Assets"><FixedAssetsPage /></ModuleGuard>} />

            {/* Billing & AR */}
            <Route path="billing"           element={<ModuleGuard module="Billing Book"><BillingPage /></ModuleGuard>} />
            <Route path="billing/:clientId" element={<ModuleGuard module="Billing Book"><BillingClientPage /></ModuleGuard>} />
            <Route path="invoices"          element={<ModuleGuard module="Service Invoices"><ServiceInvoicesPage /></ModuleGuard>} />
            <Route path="invoices/new"      element={<ModuleGuard module="Service Invoices"><InvoiceIssuancePage /></ModuleGuard>} />
            <Route path="collections"       element={<ModuleGuard module="Collections"><CollectionsPage /></ModuleGuard>} />
            <Route path="collections/new"   element={<ModuleGuard module="Collections"><CollectionsPostingPage /></ModuleGuard>} />

            {/* Reports */}
            <Route path="reports"              element={<ModuleGuard module="Reports"><ReportsLandingPage /></ModuleGuard>} />
            <Route path="reports/builder/:type" element={<ModuleGuard module="Reports"><ReportBuilderPage /></ModuleGuard>} />

            {/* System */}
            <Route path="contacts" element={<ModuleGuard module="Contacts"><ContactsPage /></ModuleGuard>} />
            <Route path="settings" element={<ModuleGuard module="Settings"><SettingsPage /></ModuleGuard>} />
            <Route path="profile"  element={<UserProfilePage />} />

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
      <CreateFlyout open={createFlyoutOpen} onClose={() => setCreateFlyoutOpen(false)} />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
    </div>
  );
}
