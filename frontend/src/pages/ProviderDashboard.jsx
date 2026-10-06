import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api, { getUsername } from '../api/client';
import toast from 'react-hot-toast';
import Lottie from 'lottie-react';

const categories = [
  { value: 'PLUMBER', label: '🔧 Plumber' },
  { value: 'PAINTER', label: '🎨 Painter' },
  { value: 'ELECTRICIAN', label: '⚡ Electrician' },
  { value: 'CLEANING', label: '🧹 Cleaning' },
  { value: 'APPLIANCE_REPAIR', label: '🔩 Appliance Repair' },
  { value: 'PEST_CONTROL', label: '🐛 Pest Control' },
];

import { workerAnimation } from '../assets/animations';

const errorFrom = (err, fallback) => {
  const data = err?.response?.data;
  if (data && typeof data === 'object') {
    if (data.error || data.detail) return data.error || data.detail;
    const fieldErrors = Object.entries(data)
      .map(([field, val]) => `${field}: ${Array.isArray(val) ? val.join(' ') : val}`);
    if (fieldErrors.length) return fieldErrors.join(' | ');
  }
  return fallback;
};

const ProviderDashboard = () => {
  const navigate = useNavigate();
  const username = getUsername() || 'Pro';
  const mascotAnim = workerAnimation;

  const [isActive, setIsActive] = useState(true);
  const [togglingActive, setTogglingActive] = useState(false);
  const [liveJobs, setLiveJobs] = useState([]);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [acceptingId, setAcceptingId] = useState(null);

  // Populated from GET /provider/profile/ on mount. Until that resolves we
  // hold no category, so leads are never fetched for a guessed one.
  const [profile, setProfile] = useState({
    category: '',
    bio: '',
    years_experience: 0,
    jobs_completed: 0,
    avg_rating: 0,
    total_reviews: 0,
    hourly_rate: '0.00',
    is_active: true,
    has_location: false,
    latitude: null,
    longitude: null,
  });

  const [editForm, setEditForm] = useState({ ...profile });

  // Where we look for leads: the saved working location if there is one,
  // otherwise a coarse IP lookup. There is deliberately no hardcoded fallback
  // — the old code silently searched New York for everyone whose lookup failed.
  const [coords, setCoords] = useState(null);
  const [locationStatus, setLocationStatus] = useState('detecting'); // detecting | ready | denied

  // Load the real provider profile (category drives which leads we poll for).
  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await api.get('/provider/profile/');
        setProfile(prev => ({ ...prev, ...res.data }));
        setIsActive(res.data.is_active !== false);
      } catch (err) {
        toast.error(errorFrom(err, 'Could not load your profile.'));
      } finally {
        setProfileLoaded(true);
      }
    };
    fetchProfile();
  }, []);

  useEffect(() => {
    if (!profileLoaded) return;

    // The saved working location is authoritative — it's the one customers
    // search against, so leads should be scoped to the same point.
    if (profile.has_location && profile.latitude != null && profile.longitude != null) {
      setCoords({ lat: profile.latitude, lng: profile.longitude });
      setLocationStatus('ready');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/location/');
        if (cancelled) return;
        if (data.status === 'success' && data.lat && data.lon) {
          setCoords({ lat: data.lat, lng: data.lon });
          setLocationStatus('ready');
        } else {
          // Previously only a thrown network error set 'denied', so any
          // non-success body left the UI spinning on 'detecting' forever.
          setLocationStatus('denied');
        }
      } catch {
        if (!cancelled) setLocationStatus('denied');
      }
    })();
    return () => { cancelled = true; };
  }, [profileLoaded, profile.has_location, profile.latitude, profile.longitude]);

  // Fetch live leads
  useEffect(() => {
    if (!isActive || locationStatus !== 'ready' || !coords || !profileLoaded || !profile.category) return;

    let cancelled = false;
    const fetchLeads = async () => {
      try {
        // `category` is deliberately not sent: the server derives it from the
        // caller's own profile, so a provider can't poach another trade's leads.
        const res = await api.get('/jobs/pending/', {
          params: { lat: coords.lat, lng: coords.lng, radius: 100 },
        });
        if (cancelled) return;
        setLiveJobs(res.data.results || (Array.isArray(res.data) ? res.data : []));
      } catch {
        /* transient poll failure — keep showing the last known leads */
      }
    };

    fetchLeads();
    const interval = setInterval(fetchLeads, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isActive, profile.category, coords, locationStatus, profileLoaded]);

  const handleToggleActive = useCallback(async () => {
    if (togglingActive) return;
    const next = !isActive;
    setIsActive(next);           // optimistic
    setTogglingActive(true);
    try {
      // This toggle used to be local state only: a provider who went "Offline"
      // still showed up in every customer's search results.
      const { data } = await api.patch('/provider/profile/', { is_active: next });
      setProfile(prev => ({ ...prev, ...data }));
      toast.success(next ? "You're online — leads incoming." : "You're offline and hidden from search.");
    } catch (err) {
      setIsActive(!next);        // revert; the server is the source of truth
      toast.error(errorFrom(err, 'Could not change your status.'));
    } finally {
      setTogglingActive(false);
    }
  }, [isActive, togglingActive]);

  const handleAcceptJob = async (jobId) => {
    if (acceptingId) return;
    setAcceptingId(jobId);
    try {
      await api.patch(`/jobs/${jobId}/accept/`, {});
      toast.success('Job accepted! Opening job hub...');
      navigate(`/job/${jobId}`);
    } catch (err) {
      // 409 = another provider got there first. Drop it from the list so the
      // same dead lead isn't sitting there waiting to be clicked again.
      if (err.response?.status === 409) {
        setLiveJobs(prev => prev.filter(j => j.id !== jobId));
      }
      toast.error(errorFrom(err, 'Could not accept this job.'));
    } finally {
      setAcceptingId(null);
    }
  };

  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      const res = await api.patch('/provider/profile/', editForm);
      // Trust the server's echo of the saved values rather than assuming the
      // local form went through untouched.
      setProfile(prev => ({ ...prev, ...res.data }));
      if (res.data?.is_active !== undefined) setIsActive(res.data.is_active);
      setIsEditing(false);
      toast.success('Profile updated! ✅');
    } catch (err) {
      // Previously this reported success on failure and kept the local edits,
      // so a rejected save looked identical to a successful one.
      toast.error(errorFrom(err, 'Could not save your profile. Please try again.'));
      // Stay in edit mode so the user's input isn't silently discarded.
    } finally {
      setSaving(false);
    }
  };

  const categoryLabel = categories.find(c => c.value === profile.category)?.label || profile.category;
  const categoryName = categoryLabel.replace(/^\S+\s/, '');

  return (
    <div className="max-w-4xl mx-auto py-8 px-6 animate-fade-in-up">
      {/* Welcome with mascot */}
      <div className="card p-6 mb-6 flex items-center gap-6">
        <div className="w-24 h-24 flex-shrink-0">
          {mascotAnim ? (
            <Lottie animationData={mascotAnim} loop autoplay className="w-full h-full" />
          ) : (
            <div className="w-full h-full bg-sky-50 rounded-2xl flex items-center justify-center animate-float">
              <span className="text-4xl">👷</span>
            </div>
          )}
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-extrabold text-slate-900">
            Welcome back, {username}!
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Your dashboard for managing your profile, reviewing leads, and growing your business.
          </p>
          <Link to="/jobs" className="inline-block mt-2 text-sm font-semibold text-sky-600 hover:text-sky-700">
            View my jobs →
          </Link>
        </div>
        {/* Active toggle */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <button
            onClick={handleToggleActive}
            disabled={togglingActive || !profileLoaded}
            aria-label={isActive ? 'Go offline' : 'Go online'}
            className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full border-2 border-transparent cursor-pointer transition-colors disabled:opacity-50 ${isActive ? 'bg-emerald-500' : 'bg-slate-300'
              }`}
          >
            <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transform transition ${isActive ? 'translate-x-5' : 'translate-x-0'
              }`} />
          </button>
          <span className={`text-xs font-medium ${isActive ? 'text-emerald-600' : 'text-slate-400'}`}>
            {isActive ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* No working location set — customers search by distance, so this
          provider is invisible until they fix it. */}
      {profileLoaded && !profile.has_location && (
        <div className="mb-6 bg-amber-50 border-2 border-amber-200 rounded-2xl p-5 flex items-start gap-4">
          <div className="text-2xl">📍</div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-amber-900">No working location set</h3>
            <p className="text-xs text-amber-700 mt-1 leading-relaxed">
              Customers find pros by distance. Until you save a location you won't
              appear in anyone's search results.
            </p>
            <button
              onClick={() => { setEditForm({ ...profile }); setIsEditing(true); }}
              className="mt-3 bg-amber-500 text-white text-xs font-bold px-4 py-2 rounded-lg hover:bg-amber-600 transition-all"
            >
              Set it now
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Profile Card — 2 cols */}
        <div className="lg:col-span-2 card p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-slate-800">Your Profile</h2>
            {!isEditing && profileLoaded && (
              <button
                onClick={() => { setEditForm({ ...profile }); setIsEditing(true); }}
                className="text-sm text-sky-600 font-medium hover:text-sky-700"
              >
                Edit
              </button>
            )}
          </div>

          {isEditing ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Category</label>
                <select
                  value={editForm.category}
                  onChange={(e) => setEditForm(prev => ({ ...prev, category: e.target.value }))}
                  className="input-field"
                >
                  {categories.map(cat => (
                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Bio</label>
                <textarea
                  value={editForm.bio}
                  onChange={(e) => setEditForm(prev => ({ ...prev, bio: e.target.value }))}
                  rows={4}
                  maxLength={2000}
                  className="input-field resize-none"
                  placeholder="Tell customers about your experience..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Years of Experience</label>
                <input
                  type="number"
                  min="0"
                  max="70"
                  value={editForm.years_experience}
                  onChange={(e) => setEditForm(prev => ({ ...prev, years_experience: parseInt(e.target.value) || 0 }))}
                  className="input-field"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!navigator.geolocation) {
                    return toast.error('This browser has no GPS support.');
                  }
                  navigator.geolocation.getCurrentPosition(
                    (pos) => {
                      setEditForm(prev => ({ ...prev, lat: pos.coords.latitude, lng: pos.coords.longitude }));
                      toast.success('Location captured from GPS! 📍 Save to apply.');
                    },
                    // The failure path was missing entirely: denying the prompt
                    // did nothing at all and the button just sat there.
                    (err) => toast.error(
                      err.code === err.PERMISSION_DENIED
                        ? 'Location permission denied. Allow it in your browser settings.'
                        : "Couldn't read your GPS position."
                    ),
                    { enableHighAccuracy: true, timeout: 8000 }
                  );
                }}
                className="w-full bg-slate-50 text-slate-700 font-bold text-xs py-2 rounded-lg border-2 border-dashed border-slate-200 hover:border-sky-300 transition-all mb-2"
              >
                📍 {editForm.lat ? 'Location Captured' : profile.has_location ? 'Update Working Location (GPS)' : 'Set Working Location (GPS)'}
              </button>
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                <label className="block text-sm font-bold text-slate-700 mb-2">Hourly Rate (₹/hr)</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-lg">₹</span>
                  <input
                    type="number"
                    min="0"
                    value={editForm.hourly_rate}
                    onChange={(e) => setEditForm({ ...editForm, hourly_rate: e.target.value })}
                    className="w-full pl-10 pr-4 py-3 bg-white border-2 border-slate-200 rounded-xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all font-bold text-lg"
                    placeholder="0.00"
                  />
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">Top-rated pros earn more! ⭐</p>
                {parseFloat(editForm.hourly_rate) > 800 && profile.avg_rating < 4.0 && (
                  <p className="text-[10px] text-amber-600 mt-1 font-bold">
                    ⚠️ Hint: Your rate is higher than average for your rating. Consider lowering it to attract more customers.
                  </p>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSaveProfile}
                  disabled={saving}
                  className="flex-1 btn-primary text-sm !py-2.5 disabled:opacity-60"
                >
                  {saving ? 'Saving...' : 'Save Profile'}
                </button>
                <button
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                  className="flex-1 btn-outline text-sm !py-2.5 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : !profileLoaded ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-12 bg-slate-100 rounded-xl" />
              <div className="h-3 bg-slate-100 rounded w-3/4" />
              <div className="h-3 bg-slate-100 rounded w-1/2" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-sky-100 rounded-xl flex items-center justify-center text-xl">
                  {categoryLabel.split(' ')[0]}
                </div>
                <div>
                  <p className="font-semibold text-slate-800">{categoryName}</p>
                  <p className="text-xs text-slate-400">{profile.years_experience} years experience</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="bg-amber-50 text-amber-700 px-2 py-1 rounded-md font-semibold">
                  ⭐ {profile.avg_rating} ({profile.total_reviews} reviews)
                </span>
                <span className="bg-purple-50 text-purple-700 px-2 py-1 rounded-md font-semibold">
                  ✅ {profile.jobs_completed} jobs done
                </span>
                <span className="bg-emerald-50 text-emerald-700 px-2 py-1 rounded-md font-semibold">
                  ₹{profile.hourly_rate}/hr
                </span>
              </div>
              <div>
                <p className="text-sm text-slate-600 leading-relaxed">
                  {profile.bio || <span className="text-slate-400 italic">No bio yet — add one so customers know what you do.</span>}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Live Jobs — 3 cols */}
        <div className="lg:col-span-3 card p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-slate-800">
              Live Jobs Nearby
              {isActive && <span className="inline-block ml-2 w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>}
            </h2>
            {liveJobs.length > 0 && (
              <span className="text-xs font-bold text-slate-400">{liveJobs.length} open</span>
            )}
          </div>

          {!isActive ? (
            <div className="bg-slate-50 rounded-xl p-8 text-center">
              <p className="text-slate-400 text-sm">You're currently offline. Toggle your status to see live jobs.</p>
            </div>
          ) : liveJobs.length === 0 ? (
            <div className="bg-slate-50 rounded-xl p-8 text-center border-2 border-dashed border-slate-200">
              <div className="text-4xl mb-3 animate-float">📡</div>
              <p className="text-slate-500 font-medium">
                {!profileLoaded
                  ? 'Loading your profile...'
                  : !profile.category
                  ? 'No speciality set on your profile yet.'
                  : locationStatus === 'denied'
                  ? "We couldn't work out where you are. Set a working location on your profile."
                  : locationStatus !== 'ready'
                  ? 'Waiting for your location...'
                  : `Scanning for ${categoryName.toLowerCase()} jobs nearby...`}
              </p>
              <p className="text-slate-400 text-sm mt-1">New leads appear automatically.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {liveJobs.map(job => (
                <div key={job.id} className="bg-slate-50 rounded-xl p-4 flex items-center justify-between gap-3 hover:bg-sky-50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">
                      {job.service_type_display || `Job #${job.id}`}
                      {job.distance_km != null && (
                        <span className="ml-2 text-xs font-bold text-sky-600">{job.distance_km} km</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {job.description || 'No description provided.'}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      #{job.id}{job.customer_username ? ` • ${job.customer_username}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => handleAcceptJob(job.id)}
                    disabled={acceptingId !== null}
                    className="bg-emerald-600 text-white font-semibold text-sm py-2 px-5 rounded-xl hover:bg-emerald-700 transition-all shadow-sm disabled:opacity-50 whitespace-nowrap"
                  >
                    {acceptingId === job.id ? 'Accepting...' : 'Accept'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProviderDashboard;
