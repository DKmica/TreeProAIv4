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
    const success = await login(email, password);
    if (success) {
      navigate('/');
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
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
            className="w-full inline-flex items-center justify-center px-4 py-2 rounded-md bg-cyan-600 text-white font-medium shadow hover:bg-cyan-700 transition"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;