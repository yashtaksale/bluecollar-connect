import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated, getUserRole } from '../api/client';

/**
 * Route guard.
 *
 * Every authenticated page was previously reachable by typing its URL while
 * logged out — the page mounted, fired its API calls, got a wall of 401s and
 * rendered a broken shell. Worse, a customer could open /provider-dashboard
 * and a provider could open /customer-dashboard.
 *
 * `role` is optional: omit it to require only that someone is signed in.
 * The attempted path is preserved in location state so Login can bounce the
 * user back to where they were headed.
 */
const DASHBOARD_FOR = {
  SERVICE_PROVIDER: '/provider',
  CUSTOMER: '/customer',
};

const ProtectedRoute = ({ role, children }) => {
  const location = useLocation();

  if (!isAuthenticated()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (role) {
    const actual = getUserRole();
    if (actual && actual !== role) {
      // Signed in, just on the wrong side of the app — send them home rather
      // than to a login screen they don't need.
      return <Navigate to={DASHBOARD_FOR[actual] || '/'} replace />;
    }
  }

  return children;
};

export default ProtectedRoute;
