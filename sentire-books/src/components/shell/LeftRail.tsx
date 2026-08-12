import * as React from 'react';
import { useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Plus, Home, BarChart3,
  Wallet, Calculator, FileText, Settings2, Users,
} from 'lucide-react';
import { cn } from '../../lib/utils';

// ─── Module group definitions ─────────────────────────────────────────────────
const GROUPS = [
  {
    id: 'disbursement',
    label: 'Disbursement',
    icon: Wallet,
    items: [
      { label: 'Vouchers',           path: '/vouchers' },
      { label: 'Approvals',          path: '/approvals' },
      { label: 'Weekly Projections', path: '/projections' },
      { label: 'Payment Schedule',   path: '/pay-schedule' },
      { label: 'Disbursements',      path: '/disbursements' },
      { label: 'Check Registry',     path: '/checks' },
    ],
  },
  {
    id: 'accountant',
    label: 'Accountant',
    icon: Calculator,
    items: [
      { label: 'Journal',              path: '/journal' },
      { label: 'Bank',                 path: '/bank' },
      { label: 'Chart of Accounts',    path: '/coa' },
      { label: 'Tax',                  path: '/tax' },
    ],
  },
  {
    id: 'billing',
    label: 'Billing',
    icon: FileText,
    items: [
      { label: 'Billing Book',      path: '/billing' },
      { label: 'Service Invoices',  path: '/invoices' },
      { label: 'Issue Invoice',     path: '/invoices/new' },
      { label: 'Collections',       path: '/collections' },
      { label: 'Record Collection', path: '/collections/new' },
    ],
  },
] as const;

type GroupId = (typeof GROUPS)[number]['id'];

// ─── Simple icon-only rail button ─────────────────────────────────────────────
interface RailItemProps {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

function RailItem({ icon: Icon, label, active, onClick }: RailItemProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        'relative flex flex-col items-center justify-center gap-0.5 w-full h-16 px-1 transition-colors outline-none',
        active
          ? 'text-[#F97316]'
          : 'text-[#6B7280] hover:text-[#1F2937] hover:bg-[#F3F4F6]',
      )}
    >
      {active && (
        <span className="absolute left-0 top-3 bottom-3 w-[3px] bg-[#F97316] rounded-r-full" />
      )}
      <Icon size={22} strokeWidth={active ? 2.2 : 1.75} aria-hidden="true" />
      <span className="text-[11px] font-semibold leading-none tracking-tight mt-0.5">
        {label}
      </span>
    </button>
  );
}

// ─── Group button with hover flyout ───────────────────────────────────────────
interface GroupButtonProps {
  group: (typeof GROUPS)[number];
  active: boolean;
  onEnter: (el: HTMLElement) => void;
  onLeave: () => void;
}

function GroupButton({ group, active, onEnter, onLeave }: GroupButtonProps) {
  const Icon = group.icon;
  return (
    <button
      title={group.label}
      onMouseEnter={(e) => onEnter(e.currentTarget)}
      onMouseLeave={onLeave}
      className={cn(
        'relative flex flex-col items-center justify-center gap-0.5 w-full h-16 px-1 transition-colors outline-none',
        active
          ? 'text-[#F97316]'
          : 'text-[#6B7280] hover:text-[#1F2937] hover:bg-[#F3F4F6]',
      )}
    >
      {active && (
        <span className="absolute left-0 top-3 bottom-3 w-[3px] bg-[#F97316] rounded-r-full" />
      )}
      <Icon size={22} strokeWidth={active ? 2.2 : 1.75} aria-hidden="true" />
      <span className="text-[11px] font-semibold leading-none tracking-tight mt-0.5">
        {group.label}
      </span>
    </button>
  );
}

// ─── LeftRail ─────────────────────────────────────────────────────────────────
export interface LeftRailProps {
  onCreateClick: () => void;
}

export function LeftRail({ onCreateClick }: LeftRailProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const p = location.pathname;

  const [flyout, setFlyout] = useState<{ groupId: GroupId; top: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const is = (route: string, exact = false) =>
    exact ? p === route : p === route || p.startsWith(route + '/');

  const isGroupActive = (group: (typeof GROUPS)[number]) =>
    group.items.some(item => is(item.path));

  function openFlyout(groupId: GroupId, el: HTMLElement) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const rect = el.getBoundingClientRect();
    setFlyout({ groupId, top: rect.top });
  }

  function scheduleClose() {
    closeTimer.current = setTimeout(() => setFlyout(null), 120);
  }

  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }

  const activeGroup = flyout ? GROUPS.find(g => g.id === flyout.groupId) ?? null : null;

  return (
    <>
      <aside className="w-[80px] shrink-0 flex flex-col items-center bg-white border-r border-[#E5E7EB] z-20">

        {/* ── Top: Create / Home / Reports ──────────────────────────────── */}
        <div className="w-full flex flex-col pt-1">
          <RailItem icon={Plus} label="Create" onClick={onCreateClick} />
          <RailItem
            icon={Home}
            label="Home"
            active={is('/dashboard', true)}
            onClick={() => navigate('/dashboard')}
          />
          <RailItem
            icon={BarChart3}
            label="Reports"
            active={location.pathname.startsWith('/reports')}
            onClick={() => navigate('/reports')}
          />
        </div>

        {/* ── Divider ───────────────────────────────────────────────────── */}
        <div className="w-10 h-px bg-[#E5E7EB] my-1 flex-shrink-0" />

        {/* ── Module groups ─────────────────────────────────────────────── */}
        <div className="w-full flex flex-col">
          {GROUPS.map(grp => (
            <GroupButton
              key={grp.id}
              group={grp}
              active={isGroupActive(grp)}
              onEnter={(el) => openFlyout(grp.id, el)}
              onLeave={scheduleClose}
            />
          ))}
          <RailItem
            icon={Users}
            label="Contacts"
            active={is('/contacts')}
            onClick={() => navigate('/contacts')}
          />
        </div>

        <div className="flex-1" />
      </aside>

      {/* ── Hover flyout panel (fixed so it escapes aside bounds) ─────── */}
      {flyout && activeGroup && (
        <div
          role="menu"
          className="fixed z-50 bg-white border border-[#E5E7EB] shadow-lg rounded-r-xl overflow-hidden"
          style={{ left: 80, top: flyout.top, width: 180 }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {/* Group header */}
          <div className="px-3 pt-2.5 pb-1.5 border-b border-[#F3F4F6]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[#9CA3AF]">
              {activeGroup.label}
            </p>
          </div>

          {/* Sub-items */}
          <div className="py-0.5">
            {activeGroup.items.map(item => (
              <button
                key={item.path}
                role="menuitem"
                onClick={() => { navigate(item.path); setFlyout(null); }}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-[13px] transition-colors',
                  is(item.path)
                    ? 'text-[#F97316] font-semibold bg-[#FFF7ED]'
                    : 'text-[#374151] hover:bg-[#F9FAFB] hover:text-[#111827]',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}


