import { render, screen } from '../../setup/testUtils';
import { describe, it, expect, vi } from 'vitest';
import ProtectedRoute from '../../../components/ProtectedRoute';
import { useAuth } from '../../../contexts/AuthContext';
import * as ReactRouterDom from 'react-router-dom';

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Navigate: vi.fn(({ to }) => <div data-testid="navigate">Redirecting to {to}</div>),
    Outlet: vi.fn(() => <div data-testid="outlet">Protected Content</div>),
  };
});

describe('ProtectedRoute', () => {
  it('should render Outlet when authenticated', () => {
    vi.mocked(useAuth).mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
      userEmail: null,
      userRole: null,
      userRoles: [],
      userName: null,
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isOwnerOrAdmin: false,
      isManager: false,
      isFieldCrew: false,
      isCustomer: false,
      login: vi.fn(),
      signup: vi.fn(),
      logout: vi.fn(),
    });

    render(<ProtectedRoute />);

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });

  it('should redirect to /login when not authenticated', () => {
    vi.mocked(useAuth).mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      userEmail: null,
      userRole: null,
      userRoles: [],
      userName: null,
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isOwnerOrAdmin: false,
      isManager: false,
      isFieldCrew: false,
      isCustomer: false,
      login: vi.fn(),
      signup: vi.fn(),
      logout: vi.fn(),
    });

    render(<ProtectedRoute />);

    expect(screen.getByTestId('navigate')).toBeInTheDocument();
    expect(screen.getByText('Redirecting to /login')).toBeInTheDocument();
  });

  it('should use replace navigation', () => {
    vi.mocked(useAuth).mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      userEmail: null,
      userRole: null,
      userRoles: [],
      userName: null,
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isOwnerOrAdmin: false,
      isManager: false,
      isFieldCrew: false,
      isCustomer: false,
      login: vi.fn(),
      signup: vi.fn(),
      logout: vi.fn(),
    });

    render(<ProtectedRoute />);

    const navigateCalls = vi.mocked(ReactRouterDom.Navigate).mock.calls;
    expect(navigateCalls.length).toBeGreaterThan(0);
    expect(navigateCalls[0][0]).toEqual(
      expect.objectContaining({
        to: '/login',
        replace: true,
      })
    );
  });
});