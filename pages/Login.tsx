import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { showToast } from '../components/ui/Toast';

const DEV_EMAIL = 'dakoenig4@gmail.com';
const DEV_PASSWORD = '12Tree45';

const Login: React.FC = () => {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.PROD) return;
    if (seededRef.current) return;
    seededRef.current = true;

    // Dev-only: attempt to create or update the user so we can sign in
    fetch('/api/auth/dev-create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD, role: 'owner' })
    })
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text();
          throw new Error(msg || 'Failed to seed dev user');
        }
        return res.json();
      })
      .then(() => {
        setEmail(DEV_EMAIL);
        setPassword(DEV_PASSWORD);
        showToast('Dev user is ready. You can sign in now.', { type: 'success' });
      })
      .catch(() => {
        // Non-fatal in dev
      });
  }, []);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const success = await login(email, password);
    setSubmitting(false);
    if (success) {
      navigate('/');
    } else {
      showToast('Sign-in failed', { type: 'error', message: 'Please check your email and password.' });
    }
  };

  const handleCreateOwnerAndSignin = async () => {
    if (seeding || submitting) return;
    if (!email || !password) {
      showToast('Enter email and password first', { type: 'error', message: 'Please provide email and password to create your owner account.' });
      return;
    }
    setSeeding(true);
    try {
      const res = await fetch('/api/auth/dev-create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, role: 'owner' })
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || 'Failed to create owner');
      }
      showToast('Owner account created/approved', { type: 'success' });
      // Auto-sign in with the just-created credentials
      const ok = await login(email, password);
      if (ok) {
        navigate('/');
      } else {
        showToast('Sign-in failed after creating account', { type: 'error' });
      }
    } catch (err) {
      showToast('Unable to create owner', { type: 'error', message: 'The server may not allow dev seeding. Ask an admin to enable it.' });
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md bg-white shadow rounded-lg p-6 border border-slate-200">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">Sign in</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 caret-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 caret-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
            {!import.meta.env.PROD && (
              <p className="text-xs text-slate-500 mt-1">
                Dev tip: Pre-seeded user is {DEV_EMAIL} / {DEV_PASSWORD}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center px-4 py-2 rounded-md bg-cyan-600 text-white font-medium shadow hover:bg-cyan-700 disabled:opacity-60 transition"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="mt-3">
            <button
              type="button"
              onClick={handleCreateOwnerAndSignin}
              disabled={seeding || submitting}
              className="w-full inline-flex items-center justify-center px-4 py-2 rounded-md border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-60 transition"
            >
              {seeding ? 'Creating account…' : 'Create owner and sign in'}
            </button>
            <p className="text-xs text-slate-500 mt-2">
              If sign-in fails with "Invalid user", use this to create an owner account with the email/password above.
            </p>
            <div className="mt-3 text-center">
              <a
                href="/admin-setup"
                className="text-sm text-cyan-700 hover:text-cyan-800 underline"
              >
                Set up admin account instead
              </a>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;