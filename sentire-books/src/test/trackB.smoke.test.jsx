// Track B — portal smoke test.
//
// Proves two things that a placeholder assertion cannot:
//   1. The whole app shell boots without throwing — <App/> wires BrowserRouter,
//      AuthProvider, AuthGuard and the route table together. With no stored
//      session token, AuthProvider resolves to `anon` with NO network call, the
//      guard redirects to /login, and the real LoginPage renders.
//   2. A real leaf component (StatusPill) mounts and renders its content.
//
// If any provider, route, or import in that chain is broken, test (1) throws and
// the gate goes red — which is exactly what CI must catch for front-end changes.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App.jsx';
import { StatusPill } from '../components/common/StatusPill.jsx';

describe('portal smoke', () => {
  beforeEach(() => {
    // Guarantee the anonymous path: no token → LoginPage, no backend needed.
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('boots the app shell to the login screen without throwing', async () => {
    render(<App />);

    // The real LoginPage — brand + email field — proves the provider/router
    // chain mounted end to end.
    expect(await screen.findByText('Sentire Books')).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText('you@company.com'),
    ).toBeInTheDocument();
  });

  it('mounts a real component (StatusPill) and renders its status', () => {
    render(<StatusPill status="paid" />);
    expect(screen.getByText('paid')).toBeInTheDocument();
  });
});
