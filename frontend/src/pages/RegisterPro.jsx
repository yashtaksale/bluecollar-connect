import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { saveSession } from '../api/client';
import toast from 'react-hot-toast';

const CATEGORIES = [
  { value: 'PLUMBER', label: 'Plumber', emoji: '🔧' },
  { value: 'PAINTER', label: 'Painter', emoji: '🎨' },
  { value: 'ELECTRICIAN', label: 'Electrician', emoji: '⚡' },
  { value: 'CLEANING', label: 'Cleaning', emoji: '🧹' },
  { value: 'APPLIANCE_REPAIR', label: 'Appliance Repair', emoji: '🔩' },
  { value: 'PEST_CONTROL', label: 'Pest Control', emoji: '🐛' },
];

const DEMO_LOCATIONS = [
  { name: 'Mumbai, IN', lat: 19.0760, lng: 72.8777 },
  { name: 'New York, US', lat: 40.7128, lng: -74.0060 },
  { name: 'London, UK', lat: 51.5074, lng: -0.1278 },
];

const RegisterPro = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    category: 'PLUMBER',
    lat: null,
    lng: null,
    locationName: null,
  });

  // Detect location (GPS if available, IP fallback)
  useEffect(() => {
    const detectLocation = async () => {
      const isSecure = window.location.protocol === 'https:'
        || window.location.hostname === 'localhost'
        || window.location.hostname === '127.0.0.1';

      if (navigator.geolocation && isSecure) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setFormData(prev => ({
              ...prev,
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            }));
          },
          () => fetchIpLocation()
        );
      } else {
        fetchIpLocation();
      }
    };

    detectLocation();
  }, []);

  const fetchIpLocation = async () => {
    try {
      const res = await fetch('/api/location/');
      const data = await res.json();
      if (data.status === 'success' && data.lat && data.lon) {
        setFormData(prev => ({
          ...prev,
          lat: data.lat,
          lng: data.lon,
          locationName: [data.city, data.regionName].filter(Boolean).join(', '),
        }));
      }
    } catch {
      // location detection failed; user can pick manually
    }
  };

  const handleManualLocation = (loc) => {
    setFormData(prev => ({ ...prev, lat: loc.lat, lng: loc.lng, locationName: loc.name }));
  };

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
        role: 'SERVICE_PROVIDER',
        category: formData.category,
        lat: formData.lat,
        lng: formData.lng,
      });

      const loginRes = await axios.post('/api/login/', {
        username: formData.username,
        password: formData.password,
      });

      saveSession({
        access: loginRes.data.access,
        refresh: loginRes.data.refresh,
        role: loginRes.data.user?.role || 'SERVICE_PROVIDER',
        username: loginRes.data.user?.username || formData.username,
      });

      toast.success('Welcome to BlueCollar Connect! 🎉');
      navigate('/provider', { replace: true });
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
          <h2 className="text-3xl font-extrabold text-slate-900">Join as a Pro</h2>
          <p className="mt-2 text-sm text-slate-500">
            Start accepting jobs and earning in your area
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

          {/* Trade / Speciality selector */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">
              What service do you provide?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setFormData(prev => ({ ...prev, category: cat.value }))}
                  className={`py-2.5 px-3 rounded-xl font-medium text-sm border-2 transition-all flex items-center gap-2 ${
                    formData.category === cat.value
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 text-slate-500 hover:border-slate-300'
                  }`}
                >
                  <span>{cat.emoji}</span>
                  <span>{cat.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">
              {formData.locationName
                ? `📍 Working in: ${formData.locationName}`
                : 'Working Location'}
            </label>
            <p className="text-[10px] text-slate-500 mb-2 leading-tight font-medium">
              {formData.locationName
                ? 'If this is wrong, pick a city below.'
                : 'GPS may be blocked on mobile. Pick a city below if needed.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {DEMO_LOCATIONS.map((loc) => (
                <button
                  key={loc.name}
                  type="button"
                  onClick={() => handleManualLocation(loc)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-all ${
                    formData.lat === loc.lat
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {loc.name}
                </button>
              ))}
            </div>
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

export default RegisterPro;
