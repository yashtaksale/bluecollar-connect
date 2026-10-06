import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';
import Home from './pages/Home';
import Register from './pages/Register';
import RegisterPro from './pages/RegisterPro';
import Login from './pages/Login';
import CustomerDashboard from './pages/CustomerDashboard';
import ProviderDashboard from './pages/ProviderDashboard';
import FindService from './pages/FindService';
import JobRoom from './pages/JobRoom';
import MyJobs from './pages/MyJobs';
import NotFound from './pages/NotFound';
import NotificationBell from './components/NotificationBell';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import { AUTH_EVENT, getUsername, getUserRole, isAuthenticated, logout } from './api/client';

/* ─── Header ─── */
const Header = () => {
  const navigate = useNavigate();
  const [session, setSession] = useState(() => ({
    loggedIn: isAuthenticated(),
    username: getUsername() || '',
    role: getUserRole(),
  }));
  const [scrolled, setScrolled] = useState(false);

  const syncSession = useCallback(() => {
    setSession({
      loggedIn: isAuthenticated(),
      username: getUsername() || '',
      role: getUserRole(),
    });
  }, []);

  // This effect previously had *no dependency array*, so it re-read
  // localStorage and called two setState functions after every single render.
  // Now it subscribes: AUTH_EVENT covers login/logout in this tab, `storage`
  // covers the same happening in another one.
  useEffect(() => {
    window.addEventListener(AUTH_EVENT, syncSession);
    window.addEventListener('storage', syncSession);
    return () => {
      window.removeEventListener(AUTH_EVENT, syncSession);
      window.removeEventListener('storage', syncSession);
    };
  }, [syncSession]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleLogout = async () => {
    // Blacklists the refresh token server-side before clearing local state;
    // clearing localStorage alone left the token usable for another 7 days.
    await logout();
    toast.success('See you soon! 👋');
    navigate('/');
  };

  const dashboardPath = session.role === 'SERVICE_PROVIDER' ? '/provider' : '/customer';

  return (
    <nav
      style={{
        background: scrolled ? 'rgba(253, 250, 244, 0.92)' : 'rgba(253, 250, 244, 0.75)',
        backdropFilter: 'blur(16px)',
        borderBottom: scrolled ? '1.5px solid rgba(180,160,130,0.18)' : '1.5px solid transparent',
        boxShadow: scrolled ? '0 2px 20px rgba(100,80,50,0.08)' : 'none',
        transition: 'all 0.3s ease',
      }}
      className="sticky top-0 z-50"
    >
      <div className="max-w-6xl mx-auto px-6">
        <div className="flex justify-between items-center h-[68px]">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2.5 group">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shadow-sm"
              style={{ background: 'linear-gradient(135deg, var(--sage) 0%, var(--sage-dark) 100%)' }}
            >
              <span style={{ fontSize: '1rem' }}>🏡</span>
            </div>
            <span style={{ fontFamily: 'Lora, serif', fontWeight: 600, fontSize: '1.2rem', color: 'var(--text-dark)' }}>
              Blue<span style={{ color: 'var(--sage-dark)' }}>Collar</span>
            </span>
          </Link>

          {/* Right */}
          <div className="flex items-center gap-3">
            {session.loggedIn ? (
              <>
                <Link
                  to={dashboardPath}
                  className="text-sm font-semibold px-3 py-2 rounded-xl transition-all hidden sm:inline"
                  style={{ color: 'var(--text-mid)' }}
                  onMouseEnter={e => { e.target.style.background = 'var(--sand)'; }}
                  onMouseLeave={e => { e.target.style.background = 'transparent'; }}
                >
                  Dashboard
                </Link>
                <Link
                  to="/jobs"
                  className="text-sm font-semibold px-3 py-2 rounded-xl transition-all"
                  style={{ color: 'var(--text-mid)' }}
                  onMouseEnter={e => { e.target.style.background = 'var(--sand)'; }}
                  onMouseLeave={e => { e.target.style.background = 'transparent'; }}
                >
                  My Jobs
                </Link>
                <NotificationBell />
                <span
                  className="text-sm hidden sm:inline px-3 py-1 rounded-full"
                  style={{ background: 'var(--sage-light)', color: 'var(--sage-dark)', fontWeight: 600 }}
                >
                  👋 {session.username}
                </span>
                <button
                  onClick={handleLogout}
                  className="text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                  style={{ background: 'var(--warm-200)', color: '#8a5030' }}
                  onMouseEnter={e => { e.target.style.background = 'var(--terra-light)'; }}
                  onMouseLeave={e => { e.target.style.background = 'var(--warm-200)'; }}
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                  style={{ color: 'var(--text-mid)' }}
                  onMouseEnter={e => { e.target.style.background = 'var(--sand)'; }}
                  onMouseLeave={e => { e.target.style.background = 'transparent'; }}
                >
                  Sign In
                </Link>
                <Link to="/register" className="btn-primary text-sm" style={{ padding: '0.55rem 1.2rem' }}>
                  Get Started →
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
};

/* ─── App ─── */
function App() {
  return (
    <Router>
      <div className="min-h-screen" style={{ background: 'var(--cream)' }}>
        <Header />
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 3500,
            style: {
              borderRadius: '14px',
              background: '#2D2A24',
              color: '#FDFAF4',
              fontSize: '14px',
              fontFamily: 'Nunito, sans-serif',
              fontWeight: '600',
              padding: '12px 20px',
              boxShadow: '0 8px 32px rgba(45,42,36,0.25)',
            },
          }}
        />
        <ErrorBoundary>
          <Routes>
            {/* Public */}
            <Route path="/" element={<Home />} />
            <Route path="/register" element={<Register />} />
            <Route path="/register/pro" element={<RegisterPro />} />
            <Route path="/login" element={<Login />} />

            {/* Customer-only */}
            <Route path="/customer" element={
              <ProtectedRoute role="CUSTOMER"><CustomerDashboard /></ProtectedRoute>
            } />
            <Route path="/find/:category" element={
              <ProtectedRoute role="CUSTOMER"><FindService /></ProtectedRoute>
            } />

            {/* Provider-only */}
            <Route path="/provider" element={
              <ProtectedRoute role="SERVICE_PROVIDER"><ProviderDashboard /></ProtectedRoute>
            } />

            {/* Either role, must be signed in */}
            <Route path="/jobs" element={
              <ProtectedRoute><MyJobs /></ProtectedRoute>
            } />
            <Route path="/job/:jobId" element={
              <ProtectedRoute><JobRoom /></ProtectedRoute>
            } />

            {/* Legacy aliases — kept so old links and bookmarks still resolve. */}
            <Route path="/customer-dashboard" element={<Navigate to="/customer" replace />} />
            <Route path="/provider-dashboard" element={<Navigate to="/provider" replace />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </Router>
  );
}

export default App;
