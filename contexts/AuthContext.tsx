import React, { createContext, useState, useContext, ReactNode, useEffect } from 'react';
import { showToast } from '../components/ui/Toast';

interface User {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_image_url: string | null;
  status: string;
  roles: string[];
  created_at: string;
  updated_at: string;
}

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 100,
  admin: 90,
  manager: 70,
  sales: 50,
  scheduler: 50,
  foreman: 40,
  laborer: 30,
  crew: 30,
  crew_member: 30,
  customer: 10,
};

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User | null;
  userEmail: string | null;
  userRole: string | null;
  userRoles: string[];
  userName: string | null;
  hasRole: (role: string) => boolean;
  hasAnyRole: (roles: string[]) => boolean;
  isOwnerOrAdmin: boolean;
  isManager: boolean;
  isFieldCrew: boolean;
  isCustomer: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  signup: (options: { email: string; password: string; firstName?: string; lastName?: string }) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/user', {
          credentials: 'include',
        });
        
        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
          setIsAuthenticated(true);
        } else {
          setUser(null);
          setIsAuthenticated(false);
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        setUser(null);
        setIsAuthenticated(false);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  const login = async (email: string, password: string) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password })
    });

    if (response.ok) {
      const userData = await response.json();
      setUser(userData);
      setIsAuthenticated(true);
      showToast('Signed in successfully', { type: 'success' });
      return true;
    }
    
    const msg = await response.text();
    showToast('Sign-in failed', { type: 'error', message: msg || 'Invalid email or password.' });
    return false;
  };

  const signup = async ({ email, password, firstName, lastName }: { email: string; password: string; firstName?: string; lastName?: string }) => {
    const response = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password, firstName, lastName })
    });

    if (response.ok) {
      const userData = await response.json();
      setUser(userData);
      setIsAuthenticated(true);
      showToast('Account created and signed in', { type: 'success' });
      return true;
    }
    
    const msg = await response.text();
    showToast('Sign-up failed', { type: 'error', message: msg || 'Unable to create account.' });
    return false;
  };

  const logout = async () => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
    setUser(null);
    setIsAuthenticated(false);
  };

  const userName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email || 'User' : null;
  const userEmail = user?.email || null;
  const userRoles = user?.roles || [];
  
  const userRole = userRoles.length > 0 
    ? userRoles.reduce((highest, role) => {
        const currentLevel = ROLE_HIERARCHY[role] || 0;
        const highestLevel = ROLE_HIERARCHY[highest] || 0;
        return currentLevel > highestLevel ? role : highest;
      }, userRoles[0])
    : null;

  const hasRole = (role: string): boolean => userRoles.includes(role);
  const hasAnyRole = (roles: string[]): boolean => roles.some(role => userRoles.includes(role));
  
  const isOwnerOrAdmin = hasAnyRole(['owner', 'admin']);
  const isManager = hasAnyRole(['owner', 'admin', 'manager']);
  const isFieldCrew = hasAnyRole(['foreman', 'laborer', 'crew', 'crew_member']);
  const isCustomer = hasRole('customer') && userRoles.length === 1;

  return (
    <AuthContext.Provider value={{ 
      isAuthenticated, 
      isLoading, 
      user, 
      userEmail, 
      userRole, 
      userRoles,
      userName, 
      hasRole,
      hasAnyRole,
      isOwnerOrAdmin,
      isManager,
      isFieldCrew,
      isCustomer,
      login, 
      signup, 
      logout 
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};