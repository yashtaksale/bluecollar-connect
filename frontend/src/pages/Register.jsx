import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { saveSession } from '../api/client';
import toast from 'react-hot-toast';

const Register = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    username: '',
    email: '',
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
      await axios.post('/api/register/', {
        username: formData.username,
        email: formData.email,
        password: formData.password,
        role: 'CUSTOMER',
      });

      const loginRes = await axios.post('/api/login/', {
        username: formData.username,
        password: formData.password,
      });

      saveSession({
        access: loginRes.data.access,
        refresh: loginRes.data.refresh,
        role: loginRes.data.user?.role || 'CUSTOMER',
        username: loginRes.data.user?.username || formData.username,
      });

      toast.success('Welcome to BlueCollar Connect! 🎉');
      navigate('/customer', { replace: true });
    } catch (err) {
      const data = err.response?.data;
      let msg = 'Registration failed. Please try again.';
      if (data && typeof data === 'object') {
        const errors = [];
        for (const [, messages] of Object.entries(data)) {
          if (Array.isArray(messages)) {
            errors.push(...messages);
          } else if (typeof messages === 'string') {
            errors.push(messages);
          }
        }
        if (errors.length > 0) msg = errors.join(' ');
      }
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-72px)] flex items-center justify-center p-6 animate-fade-in-up">
      <div className="card max-w-md w-full p-8">
        <div className="text-center mb-6">
          <h2 className="text-3xl font-extrabold text-slate-900">Create Account</h2>
          <p className="mt-2 text-sm text-slate-500">
            Find skilled professionals near you instantly
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Username</label>
            <input
              name="username"
              type="text"
              required
              className="input-field"
              placeholder="Choose a username"
              value={formData.username}
              onChange={handleChange}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Email</label>
            <input
              name="email"
              type="email"
              required
              className="input-field"
              placeholder="your@email.com"
              value={formData.email}
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
              placeholder="Min. 8 characters"
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
                Creating account...
              </span>
            ) : 'Create Account'}
          </button>

          <p className="text-sm text-center text-slate-500">
            Already have an account?{' '}
            <Link to="/login" className="text-sky-600 font-medium hover:text-sky-700">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
};

export default Register;
