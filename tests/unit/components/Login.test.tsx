import { render, screen, fireEvent } from '../../setup/testUtils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from '../../../pages/Login';
import { useAuth } from '../../../contexts/AuthContext';

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

describe('Login', () => {
  const mockLogin = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
      login: mockLogin,
      signup: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('should render login buttons', () => {
    render(<Login />);

    expect(screen.getByText('TreePro AI')).toBeInTheDocument();
    expect(screen.getByText('Professional Tree Service Management')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign In/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign Up/i })).toBeInTheDocument();
  });

  it('should call login function when sign in clicked', () => {
    render(<Login />);

    const signInButton = screen.getByRole('button', { name: /Sign In/i });
    fireEvent.click(signInButton);

    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('should call login function when sign up clicked', () => {
    render(<Login />);

    const signUpButton = screen.getByRole('button', { name: /Sign Up/i });
    fireEvent.click(signUpButton);

    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  it('should display authentication information', () => {
    render(<Login />);

    expect(screen.getByText(/Sign in or create an account to get started/i)).toBeInTheDocument();
    expect(screen.getByText(/Choose from multiple sign-in options/i)).toBeInTheDocument();
  });
});