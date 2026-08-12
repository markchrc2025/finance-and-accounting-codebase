// Track B B3 — the two new revenue screens must be reachable from the nav.
//
// The invoice issuance screen (/invoices/new) and the collections posting screen
// (/collections/new) are otherwise reachable only by typing the URL. This proves
// the Billing group in the left rail exposes both.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LeftRail } from './LeftRail.tsx';

function LocationProbe() {
  return <div data-testid="loc">{useLocation().pathname}</div>;
}

describe('LeftRail nav wiring (B3)', () => {
  it('exposes Issue Invoice and Record Collection under the Billing group', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LeftRail onCreateClick={() => {}} />
      </MemoryRouter>,
    );

    // Open the Billing flyout (hover the group button).
    await user.hover(screen.getByRole('button', { name: /Billing/i }));

    const issue = await screen.findByRole('menuitem', {
      name: 'Issue Invoice',
    });
    const collect = await screen.findByRole('menuitem', {
      name: 'Record Collection',
    });
    expect(issue).toBeInTheDocument();
    expect(collect).toBeInTheDocument();
  });

  it('navigates to /invoices/new when Issue Invoice is clicked', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <LeftRail onCreateClick={() => {}} />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.hover(screen.getByRole('button', { name: /Billing/i }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Record Collection' }),
    );
    expect(screen.getByTestId('loc')).toHaveTextContent('/collections/new');
  });
});
