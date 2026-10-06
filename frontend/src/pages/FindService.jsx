import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import toast from 'react-hot-toast';

const StarRating = ({ rating, size = 'text-sm' }) => {
  const fullStars = Math.floor(rating);
  const hasHalf = rating - fullStars >= 0.5;
  const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0);
  return (
    <span className={`inline-flex items-center ${size}`}>
      {[...Array(fullStars)].map((_, i) => <span key={`f${i}`} className="text-yellow-400">★</span>)}
      {hasHalf && <span className="text-yellow-400">★</span>}
      {[...Array(emptyStars)].map((_, i) => <span key={`e${i}`} className="text-gray-300">★</span>)}
    </span>
  );
};

const FindService = () => {
  const { category } = useParams();
  const navigate = useNavigate();
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchError, setSearchError] = useState(null);
  const [locationStatus, setLocationStatus] = useState('detecting'); // detecting, ready, denied
  const [userLocation, setUserLocation] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [bookingInProgress, setBookingInProgress] = useState(false);
  const [expandedReviews, setExpandedReviews] = useState(null);
  const [sortBy, setSortBy] = useState('rating'); // rating, distance

  const DEMO_LOCATIONS = [
    { name: 'Mumbai, IN', lat: 19.0760, lng: 72.8777 },
    { name: 'New York, US', lat: 40.7128, lng: -74.0060 },
    { name: 'London, UK', lat: 51.5074, lng: -0.1278 },
  ];

  const [statusMsg, setStatusMsg] = useState('Detecting location...');

  const fetchIpLocation = async () => {
    try {
      setStatusMsg('📡 Connecting to local network lookup...');
      // Proxied through our own backend so the browser never makes a plaintext
      // third-party request. The proxy answers 503 (not 200 + status:"fail")
      // when the lookup fails, so a bad result lands in catch() instead of
      // silently leaving locationStatus stuck on 'detecting'.
      const { data } = await api.get('/location/');

      if (data.status === 'success' && data.lat && data.lon) {
        setStatusMsg(`✅ Found you in ${data.city}!`);
        setUserLocation({
          lat: data.lat,
          lng: data.lon,
          // The proxy returns ip-api's `regionName`; reading `region` here
          // rendered "Mumbai, undefined".
          name: [data.city, data.regionName].filter(Boolean).join(', '),
        });
        setLocationStatus('ready');
      } else {
        throw new Error('Location unavailable');
      }
    } catch (err) {
      setStatusMsg('❌ Automatic tracking failed. Please pick a city below:');
      setLocationStatus('denied');
    }
  };

  // Step 1: Detect location using browser Geolocation API
  useEffect(() => {
    const detect = async () => {
      // Browsers block GPS on HTTP. 
      // Only try GPS if we are on HTTPS or localhost
      const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      
      if (navigator.geolocation && isSecure) {
        setStatusMsg('🛰️ Requesting GPS access...');
        navigator.geolocation.getCurrentPosition(
          (position) => {
            setStatusMsg('✅ GPS connected!');
            setUserLocation({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
            });
            setLocationStatus('ready');
          },
          (error) => {
            console.warn("GPS failed, trying IP lookup:", error.message);
            fetchIpLocation();
          },
          { enableHighAccuracy: true, timeout: 5000 }
        );
      } else {
        setStatusMsg('🔒 GPS blocked by browser (HTTP). Switching to IP-track...');
        fetchIpLocation();
      }
    };
    
    detect();
  }, []);

  const handleManualLocation = (loc) => {
    setUserLocation(loc);
    setLocationStatus('ready');
    setLoading(true); // Trigger re-fetch
  };

  // Step 2: Fetch providers sorted by rating once location is ready
  useEffect(() => {
    if (locationStatus !== 'ready' || !userLocation) return;

    const controller = new AbortController();

    const fetchProviders = async () => {
      setLoading(true);
      setSearchError(null);
      try {
        // Must go through the `api` client: /api/search/ now requires
        // authentication, so a bare fetch() (no Authorization header) 401s.
        const { data } = await api.get('/search/', {
          params: { category, lat: userLocation.lat, lng: userLocation.lng },
          signal: controller.signal,
        });
        setProviders(data.results || []);
      } catch (err) {
        if (controller.signal.aborted) return;
        setProviders([]);
        setSearchError(
          err.response?.data?.error || 'Could not load professionals. Please try again.'
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchProviders();
    return () => controller.abort();
  }, [category, locationStatus, userLocation]);

  // Step 3: Book a specific provider
  const handleBook = async (provider) => {
    const token = localStorage.getItem('access_token');
    if (!token) {
      toast.error('Please log in to book a service.');
      navigate('/login');
      return;
    }

    setBookingInProgress(true);
    setSelectedProvider(provider.id);

    try {
      const res = await api.post('/book/', {
        provider_id: provider.id,
        service_type: category,
        description: `Looking for a ${category.replace('_', ' ').toLowerCase()} service`,
        lat: userLocation.lat,
        lng: userLocation.lng,
      });

      toast.success(`Booking request sent to ${provider.username}!`);
      navigate(`/job/${res.data.job_id}`);
    } catch (err) {
      console.error(err);
      // 401 is handled by the api client (refresh-then-retry, or redirect on
      // refresh failure), so anything landing here is a real booking failure.
      const msg = err.response?.data?.error || 'Connection error. Please try again.';
      toast.error(msg);
      setBookingInProgress(false);
      setSelectedProvider(null);
    }
  };

  const displayCategory = category.replace(/_/g, ' ');

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-800 to-indigo-600 text-white">
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <h1 className="text-3xl font-extrabold capitalize">{displayCategory}s near you</h1>
            
            {/* Sort Toggle */}
            {!loading && providers.length > 0 && (
              <div className="flex bg-indigo-900/40 p-1 rounded-xl border border-indigo-400/20 self-start md:self-center">
                <button 
                  onClick={() => setSortBy('rating')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${sortBy === 'rating' ? 'bg-indigo-500 text-white shadow-lg' : 'text-indigo-200 hover:text-white'}`}
                >
                  TOP RATED
                </button>
                <button 
                  onClick={() => setSortBy('distance')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${sortBy === 'distance' ? 'bg-indigo-500 text-white shadow-lg' : 'text-indigo-200 hover:text-white'}`}
                >
                  NEAREST
                </button>
              </div>
            )}
          </div>
          <p className="mt-2 text-indigo-100 font-medium flex items-center gap-2">
            <span>{statusMsg}</span>
            {locationStatus === 'detecting' && (
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-300 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-100"></span>
              </span>
            )}
          </p>
          <p className="mt-2 text-xs text-indigo-200">
            {!loading && `${providers.length} professional${providers.length !== 1 ? 's' : ''} found — sorted by ${sortBy}`}
          </p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6">
        {/* Manual Location Override (for Mobile/HTTP) */}
        {locationStatus === 'denied' && (
          <div className="mb-6 bg-amber-50 border-2 border-amber-200 rounded-2xl p-5 shadow-sm animate-fade-in-up">
            <div className="flex items-start gap-4">
              <div className="text-2xl">🤖</div>
              <div className="flex-1">
                <h3 className="text-sm font-bold text-amber-900">
                  {userLocation?.name ? `Auto-detected: ${userLocation.name}` : 'GPS Blocked (using HTTP)'}
                </h3>
                <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                  {userLocation?.name 
                    ? "We've automatically detected your area via your IP address. If this is wrong, you can pick a different city below:" 
                    : "Browsers block GPS on non-secure sites. Please select your working area manually:"}
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {DEMO_LOCATIONS.map((loc) => (
                    <button
                      key={loc.name}
                      onClick={() => handleManualLocation(loc)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-all ${
                        userLocation?.name === loc.name 
                          ? 'bg-amber-500 border-amber-500 text-white' 
                          : 'bg-white border-amber-200 text-amber-700 hover:border-amber-400'
                      }`}
                    >
                      {loc.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {(locationStatus === 'detecting' || (loading && locationStatus === 'ready')) && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative">
              <div className="w-20 h-20 border-4 border-indigo-200 rounded-full animate-ping absolute"></div>
              <div className="w-20 h-20 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <p className="mt-6 text-gray-500 font-medium">
              {locationStatus === 'detecting' ? 'Getting your GPS location...' : 'Loading nearby pros...'}
            </p>
          </div>
        )}

        {/* Search failed */}
        {!loading && searchError && (
          <div className="text-center py-16 bg-white rounded-2xl border border-red-100 shadow-sm">
            <div className="text-5xl mb-3">⚠️</div>
            <h3 className="text-lg font-bold text-gray-800">Something went wrong</h3>
            <p className="text-gray-500 mt-2 text-sm px-6">{searchError}</p>
            <button
              onClick={() => setUserLocation({ ...userLocation })}
              className="mt-6 bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition"
            >
              Try again
            </button>
          </div>
        )}

        {/* No results */}
        {!loading && !searchError && locationStatus === 'ready' && providers.length === 0 && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">😔</div>
            <h3 className="text-xl font-bold text-gray-800">No {displayCategory}s found nearby</h3>
            <p className="text-gray-500 mt-2">Try again later or expand your search area.</p>
            <button
              onClick={() => navigate('/customer')}
              className="mt-6 bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition"
            >
              Back to Dashboard
            </button>
          </div>
        )}

        {/* Provider List — ranked by reviews */}
        {!loading && providers.length > 0 && (
          <div className="space-y-4">
            {[...providers].sort((a, b) => {
              if (sortBy === 'rating') return b.avg_rating - a.avg_rating;
              // distance_km is null when the provider has no saved location —
              // NaN from `null - null` makes the whole sort non-deterministic.
              const da = a.distance_km ?? Infinity;
              const db = b.distance_km ?? Infinity;
              return da - db;
            }).map((p, idx) => (
              <div
                key={p.id}
                className={`bg-white rounded-xl shadow-sm border transition-all hover:shadow-md ${
                  selectedProvider === p.id ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-gray-200'
                }`}
              >
                <div className="p-5">
                  {/* Top row: rank badge + name + rating */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      {/* Rank Badge */}
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${
                          idx === 0
                            ? 'bg-yellow-500'
                            : idx === 1
                            ? 'bg-gray-400'
                            : idx === 2
                            ? 'bg-amber-700'
                            : 'bg-indigo-400'
                        }`}
                      >
                        #{idx + 1}
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-slate-900 group-hover:text-sky-600 transition-colors">
                          {p.username}
                          {p.top_rated && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 uppercase tracking-wider">
                              Top Rated
                            </span>
                          )}
                        </h3>
                        <div className="flex items-center gap-3 mt-1">
                          <StarRating rating={p.avg_rating} />
                          <span className="text-xs text-slate-400 font-medium whitespace-nowrap">
                            ({p.review_count} reviews)
                          </span>
                        </div>
                        <p className="text-sm text-gray-500 capitalize">{p.category}</p>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="flex items-center gap-1">
                        <span className="text-2xl font-black text-indigo-600">₹{p.hourly_rate}</span>
                        <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">/ hr</span>
                      </div>
                      <div className="flex items-center gap-1 justify-end mt-1">
                        <StarRating rating={p.avg_rating} size="text-sm" />
                        <span className="text-sm font-bold text-slate-700 ml-1">{p.avg_rating}</span>
                      </div>
                    </div>
                  </div>

                  {/* Details row */}
                  <div className="mt-3 flex flex-wrap gap-3 text-sm text-gray-600">
                    {p.distance_km != null && (
                      <span className="bg-sky-50 text-sky-700 px-2 py-1 rounded-md font-medium">
                        📍 {p.distance_km} km away
                      </span>
                    )}
                    {p.years_experience > 0 && (
                      <span className="bg-green-50 text-green-700 px-2 py-1 rounded-md font-medium">
                        🛠️ {p.years_experience} yrs exp
                      </span>
                    )}
                    {p.jobs_completed > 0 && (
                      <span className="bg-purple-50 text-purple-700 px-2 py-1 rounded-md font-medium">
                        ✅ {p.jobs_completed} jobs done
                      </span>
                    )}
                  </div>

                  {/* Bio */}
                  <p className="mt-3 text-sm text-gray-600 leading-relaxed">{p.bio}</p>

                  {/* Reviews preview */}
                  {p.recent_reviews && p.recent_reviews.length > 0 && (
                    <div className="mt-3">
                      <button
                        onClick={() => setExpandedReviews(expandedReviews === p.id ? null : p.id)}
                        className="text-sm text-indigo-600 font-medium hover:text-indigo-800"
                      >
                        {expandedReviews === p.id ? 'Hide reviews ▲' : `Show reviews ▼`}
                      </button>
                      {expandedReviews === p.id && (
                        <div className="mt-2 space-y-2">
                          {p.recent_reviews.map((rev, idx) => (
                            <div key={idx} className="bg-gray-50 p-3 rounded-lg border border-gray-100 text-sm">
                              <div className="flex justify-between items-center mb-1">
                                <span className="font-medium text-gray-800">{rev.customer}</span>
                                <div className="flex items-center gap-1">
                                  <StarRating rating={rev.rating} />
                                  <span className="text-gray-400 text-xs ml-1">{rev.date}</span>
                                </div>
                              </div>
                              {rev.comment && <p className="text-gray-600">{rev.comment}</p>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Book button */}
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <button
                      onClick={() => handleBook(p)}
                      disabled={bookingInProgress}
                      className={`w-full py-4 rounded-xl font-bold text-sm transition-all shadow-lg ${
                        selectedProvider === p.id && bookingInProgress
                          ? 'bg-indigo-400 text-white cursor-not-allowed'
                          : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-indigo-100'
                      }`}
                    >
                      {selectedProvider === p.id && bookingInProgress ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Sending Request...
                        </span>
                      ) : (
                        `Request Professional`
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default FindService;
