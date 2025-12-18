import React, { createContext, useState, useContext, ReactNode, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '../services/supabaseClient';

interface User {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_image_url: string | null;
  created_at: string;
  updated_at: string;
  role?: string | null;
}

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User | null;
  userEmail: string | null;
  userRole: string | null;
  userRoles: string[];
  userName: string | null;
  hasAnyRole: (roles?: string[]) => boolean;
  login: (email: string, password: string) => Promise<boolean>;
  signUp: (email: string, password: string, options?: { role?: string }) => Promise<boolean>;
  logout: () => Promise<void>;
}

const fallbackUser: User = {
  id: 'local-admin',
  email: 'owner@treepro.ai',
  first_name: 'TreePro',
  last_name: 'Owner',
  profile_image_url: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  role: 'admin',
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const mapSupabaseUser = (supabaseUser: any): User => {
  if (!supabaseUser) return fallbackUser;

  const meta = supabaseUser.user_metadata || {};
  const appMeta = supabaseUser.app_metadata || {};

  return {
    id: supabaseUser.id,
    email: supabaseUser.email,
    first_name: meta.first_name || meta.firstName || null,
    last_name: meta.last_name || meta.lastName || null,
    profile_image_url: meta.avatar_url || null,
    created_at: supabaseUser.created_at,
    updated_at: supabaseUser.updated_at || supabaseUser.created_at,
    role: appMeta.role || meta.role || 'user',
  };
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;

    const initializeAuth = async () => {
      try {
        if (!isSupabaseConfigured || !supabase) {
          setUser(fallbackUser);
          setIsAuthenticated(true);
          return;
        }

        const { data, error } = await supabase.auth.getSession();

        if (error) {
          console.error('Auth session check failed:', error);
          setIsAuthenticated(false);
          setUser(null);
        } else if (data.session?.user) {
          setUser(mapSupabaseUser(data.session.user));
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
          setUser(null);
        }

        const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
          if (!isMounted) return;
          if (session?.user) {
            setUser(mapSupabaseUser(session.user));
            setIsAuthenticated(true);
          } else {
            setUser(null);
            setIsAuthenticated(false);
          }
        });
        unsubscribe = () => authListener?.subscription.unsubscribe();
      } catch (error) {
        console.error('Auth initialization failed:', error);
        setIsAuthenticated(false);
        setUser(null);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    initializeAuth();

    return () => {
      isMounted = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  const login = async (email: string, password: string): Promise<boolean> => {
    if (!isSupabaseConfigured || !supabase) {
      setUser(fallbackUser);
      setIsAuthenticated(true);
      return true;
    }

    const { error, data } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      throw error;
    }
    if (data.session?.user) {
      setUser(mapSupabaseUser(data.session.user));
      setIsAuthenticated(true);
      return true;
    }
    return false;
  };

  const signUp = async (email: string, password: string, options?: { role?: string }): Promise<boolean> => {
    if (!isSupabaseConfigured || !supabase) {
      setUser(fallbackUser);
      setIsAuthenticated(true);
      return true;
    }

    const { error, data } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: {
          role: options?.role || 'user',
        },
      },
    });

    if (error) {
      throw error;
    }

    if (data.session?.user) {
      setUser(mapSupabaseUser(data.session.user));
      setIsAuthenticated(true);
      return true;
    }

    return false;
  };

  const logout = async () => {
    if (isSupabaseConfigured && supabase) {
      await supabase.auth.signOut();
    }
    setUser(null);
    setIsAuthenticated(false);
  };

  const userName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email || 'User' : null;
  const userEmail = user?.email || null;
  const userRole = user?.role || 'owner';
  const userRoles = userRole ? [userRole] : [];

  const hasAnyRole = (roles?: string[]): boolean => {
    if (!roles || roles.length === 0) return true;
    if (userRoles.length === 0) return false;
    return roles.some((r) => userRoles.includes(r));
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        user,
        userEmail,
        userRole,
        userRoles,
        userName,
        hasAnyRole,
        login,
        signUp,
        logout,
      }}
    >
      {!isLoading && children}
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
