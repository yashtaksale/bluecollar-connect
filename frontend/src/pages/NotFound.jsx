import React from 'react';
import { Link } from 'react-router-dom';
import { isAuthenticated, getUserRole } from '../api/client';

/**
 * 404 catch-all. Previously an unknown URL rendered the header over an empty
 * white body, which looked identical to a page that had failed to load.
 */
const NotFound = () => {
  const role = getUserRole();
  const home = !isAuthenticated()
    ? '/'
    : role === 'SERVICE_PROVIDER'
    ? '/provider'
    : '/customer';

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4">🧭</div>
        <h1 style={{ fontFamily: 'Lora, serif', fontWeight: 600, fontSize: '1.6rem', color: 'var(--text-dark)' }}>
          This page doesn't exist
        </h1>
        <p className="mt-3 text-sm" style={{ color: 'var(--text-soft)' }}>
          The link may be out of date, or the job you're after was removed.
        </p>
        <div className="flex items-center justify-center gap-3 mt-7">
          <Link to={home} className="btn-primary text-sm" style={{ padding: '0.6rem 1.4rem' }}>
            Go to {isAuthenticated() ? 'dashboard' : 'home'}
          </Link>
          {isAuthenticated() && (
            <Link
              to="/jobs"
              className="text-sm font-semibold px-4 py-2.5 rounded-xl"
              style={{ background: 'var(--sand)', color: 'var(--text-mid)' }}
            >
              My jobs
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default NotFound;
