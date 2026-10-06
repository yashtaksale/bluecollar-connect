import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import { saveSession } from '../api/client';
import toast from 'react-hot-toast';

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // One round trip: /api/login/ now returns the user block alongside the
      // tokens, so the second GET /user/me/ purely to learn the role is gone.
      const { data } = await axios.post('/api/login/', {
        username: formData.username,
        password: formData.password,
      });

      const role = data.user?.role;
      saveSession({
        access: data.access,
        refresh: data.refresh,
        role,
        username: data.user?.username || formData.username,
      });

      toast.success(`Welcome back, ${data.user?.username || formData.username}! 👋`);

      // If a guard bounced them here, send them back to where they were going.
      const intended = location.state?.from?.pathname;
      const home = role === 'SERVICE_PROVIDER' ? '/provider' : '/customer';
      navigate(intended && intended !== '/login' ? intended : home, { replace: true });
    } catch (err) {
      const data = err.response?.data;
      const msg =
        data?.detail ||
        data?.error ||
        (err.response?.status === 429
          ? 'Too many attempts. Please wait a minute and try again.'
          : 'Invalid username or password.');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-72px)] flex items-center justify-center p-6 animate-fade-in-up">
      <div className="card max-w-md w-full p-8">
        <div className="text-center mb-6">
          <h2 className="text-3xl font-extrabold text-slate-900">Welcome back</h2>
          <p className="mt-2 text-sm text-slate-500">Sign in to your BlueCollar Connect account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Username</label>
            <input
              name="username"
              type="text"
              required
              className="input-field"
              placeholder="Your username"
              value={formData.username}
              onChange={handleChange}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Password</label>
            <input
              name="password"
              type="password"
              required
              className="input-field"
              placeholder="Your password"
              value={formData.password}
              onChange={handleChange}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full btn-primary ${loading ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Signing in...
              </span>
            ) : 'Sign In'}
          </button>

          <p className="text-sm text-center text-slate-500">
            Don't have an account?{' '}
            <Link to="/register" className="text-sky-600 font-medium hover:text-sky-700">Create one</Link>
          </p>
        </form>
      </div>
    </div>
  );
};

export default Login;
