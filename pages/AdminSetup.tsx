import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { showToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';

const AdminSetup: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/bootstrap-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, firstName, lastName })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to create admin');
      }
      showToast('Admin account created', { type: 'success', message: 'Signing you in…' });
      const ok = await login(email, password);
      if (ok) {
        // Go to User Management so you can approve accounts
        navigate('/user-management');
      } else {
        navigate('/');
      }
    } catch (err) {
      showToast('Admin setup failed', { type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md bg-white shadow rounded-lg p-6 border border-slate-200">
        <h1 className="text-xl font-semibold text-slate-900 mb-1">Set up admin account</h1>
        <p className="text-sm text-slate-600 mb-4">
          Create the first admin (Owner) so you can sign in and approve pending accounts.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              placeholder="you@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">First name</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                placeholder="Jane"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Last name</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                placeholder="Doe"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              placeholder="At least 8 characters"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center px-4 py-2 rounded-md bg-cyan-600 text-white font-medium shadow hover:bg-cyan-700 disabled:opacity-60 transition"
          >
            {submitting ? 'Creating…' : 'Create admin and sign in'}
          </button>
          <p className="text-xs text-slate-500 mt-2">
            If users already exist, this may be disabled unless your server sets ENABLE_ADMIN_BOOTSTRAP=true.
          </p>
        </form>
      </div>
    </div>
  );
};

export default AdminSetup;