import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import SpinnerIcon from '../components/icons/SpinnerIcon';

type AuthMode = 'signin' | 'signup' | 'admin';

const Login: React.FC = () => {
  const { login, signUp, isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate('/');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (mode !== 'signin' && password !== confirmPassword) {
      setError('Passwords must match.');
      return;
    }

    setSubmitting(true);

    try {
      if (mode === 'signin') {
        await login(email, password);
      } else {
        await signUp(email, password, { role: mode === 'admin' ? 'admin' : 'user' });
      }
      navigate('/');
    } catch (err: any) {
      const message = err?.message || 'Unable to authenticate. Please try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-gray-900 via-brand-gray-800 to-brand-gray-950 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="flex flex-col items-center">
          <img src="/logo.jpg" alt="TreePro AI" className="h-32 w-32 rounded-full shadow-lg shadow-brand-cyan-500/50 ring-4 ring-brand-cyan-500/30" />
          <h2 className="mt-6 text-center text-4xl font-extrabold text-white">
            TreePro AI
          </h2>
          <p className="mt-2 text-center text-sm text-brand-gray-300">
            Professional Tree Service Management
          </p>
        </div>

        <div className="mt-8 space-y-4 bg-white p-8 rounded-lg shadow-lg">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-lg font-semibold text-brand-gray-900">
              {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Create admin account'}
            </h3>
            <div className="flex items-center space-x-2 text-xs">
              <button
                type="button"
                onClick={() => setMode('signin')}
                className={`px-2 py-1 rounded ${mode === 'signin' ? 'bg-brand-cyan-100 text-brand-cyan-700' : 'text-brand-gray-500'}`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setMode('signup')}
                className={`px-2 py-1 rounded ${mode === 'signup' ? 'bg-brand-cyan-100 text-brand-cyan-700' : 'text-brand-gray-500'}`}
              >
                Sign up
              </button>
              <button
                type="button"
                onClick={() => setMode('admin')}
                className={`px-2 py-1 rounded ${mode === 'admin' ? 'bg-brand-cyan-100 text-brand-cyan-700' : 'text-brand-gray-500'}`}
              >
                Admin
              </button>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-brand-gray-700">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-brand-gray-200 placeholder-brand-gray-400 text-brand-gray-900 focus:outline-none focus:ring-brand-cyan-500 focus:border-brand-cyan-500 focus:z-10 sm:text-sm"
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-brand-gray-700">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-brand-gray-200 placeholder-brand-gray-400 text-brand-gray-900 focus:outline-none focus:ring-brand-cyan-500 focus:border-brand-cyan-500 focus:z-10 sm:text-sm"
                placeholder="••••••••"
              />
            </div>

            {mode !== 'signin' && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-brand-gray-700">Confirm password</label>
                <input
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="appearance-none rounded-md relative block w-full px-3 py-2 border border-brand-gray-200 placeholder-brand-gray-400 text-brand-gray-900 focus:outline-none focus:ring-brand-cyan-500 focus:border-brand-cyan-500 focus:z-10 sm:text-sm"
                  placeholder="••••••••"
                />
              </div>
            )}

            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 border border-red-200">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="group relative w-full flex justify-center items-center space-x-2 py-3 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-brand-cyan-600 hover:bg-brand-cyan-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-cyan-500 transition-colors disabled:opacity-70"
            >
              {submitting && <SpinnerIcon className="w-4 h-4 animate-spin text-white" />}
              <span>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Create admin account'}</span>
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-xs text-brand-gray-500">
              Authentication is handled by Supabase. Accounts created with the Admin option will be tagged with role=admin in user metadata.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
