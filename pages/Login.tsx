import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../src/integrations/supabase/client';
import { Button, FormInput } from '../components/ui';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
        alert('Check your email for the confirmation link!');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        navigate('/dashboard');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-8 p-8 bg-white rounded-lg shadow">
        <h2 className="text-center text-3xl font-extrabold text-gray-900">
          {mode === 'signin' ? 'Sign in to TreePro' : 'Create an Account'}
        </h2>
        
        {error && <div className="p-3 text-sm text-red-600 bg-red-50 rounded">{error}</div>}

        <form className="mt-8 space-y-6" onSubmit={handleAuth}>
          <FormInput
            label="Email address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <FormInput
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Processing...' : mode === 'signin' ? 'Sign In' : 'Sign Up'}
          </Button>
        </form>

        <div className="text-center text-sm">
          <button 
            onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            className="text-blue-600 hover:underline"
          >
            {mode === 'signin' ? 'Need an account? Sign Up' : 'Already have an account? Sign In'}
          </button>
        </div>
      </div>
    </div>
  );
}