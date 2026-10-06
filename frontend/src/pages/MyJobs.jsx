import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { getUserRole } from '../api/client';

/**
 * My Jobs — the list that was missing entirely.
 *
 * Before this page a job was only reachable via the URL you happened to be on
 * when you created it. Navigating away, refreshing, or logging in on another
 * device lost it permanently: there was no index of your own work anywhere in
 * the app.
 */

const STATUS_META = {
  PENDING:   { label: 'Waiting for provider', emoji: '⏳', bg: '#fef3c7', fg: '#92600a' },
  ACCEPTED:  { label: 'Accepted',             emoji: '🙌', bg: '#daeef6', fg: '#0b5a76' },
  CONFIRMED: { label: 'Scheduled',            emoji: '📅', bg: '#d1fae5', fg: '#065f46' },
  COMPLETED: { label: 'Completed',            emoji: '🎊', bg: '#e6efe4', fg: '#3f6b3a' },
  CANCELLED: { label: 'Cancelled',            emoji: '🚫', bg: '#ffe4e6', fg: '#9f1239' },
};

const TABS = [
  { key: 'active',    label: 'Active',    query: 'PENDING,ACCEPTED,CONFIRMED' },
  { key: 'completed', label: 'Completed', query: 'COMPLETED' },
  { key: 'cancelled', label: 'Cancelled', query: 'CANCELLED' },
  { key: 'all',       label: 'All',       query: null },
];

const formatDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit',
  });
};

const MyJobs = () => {
  const navigate = useNavigate();
  const isProvider = getUserRole() === 'SERVICE_PROVIDER';

  const [tab, setTab] = useState('active');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchJobs = useCallback(async (signal) => {
    setLoading(true);
    setError(null);
    try {
      const active = TABS.find(t => t.key === tab);
      const { data } = await api.get('/jobs/mine/', {
        params: active?.query ? { status: active.query } : undefined,
        signal,
      });
      // The endpoint is paginated (PAGE_SIZE 20), so the rows live under
      // `results`. Older unpaginated shapes returned a bare array.
      setJobs(Array.isArray(data) ? data : data.results || []);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err.response?.data?.error || 'Could not load your jobs.');
      setJobs([]);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    const controller = new AbortController();
    fetchJobs(controller.signal);
    return () => controller.abort();
  }, [fetchJobs]);

  return (
    <div className="max-w-3xl mx-auto px-5 py-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 style={{ fontFamily: 'Lora, serif', fontWeight: 600, fontSize: '1.8rem', color: 'var(--text-dark)' }}>
            My jobs
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-soft)' }}>
            {isProvider ? 'Every job you’ve accepted.' : 'Everything you’ve booked.'}
          </p>
        </div>
        <button
          onClick={() => navigate(isProvider ? '/provider' : '/customer')}
          className="text-sm font-semibold px-4 py-2 rounded-xl"
          style={{ background: 'var(--sand)', color: 'var(--text-mid)' }}
        >
          ← Dashboard
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mt-6 p-1 rounded-2xl overflow-x-auto" style={{ background: 'var(--sand)' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2 rounded-xl text-sm font-700 whitespace-nowrap transition-all"
            style={{
              background: tab === t.key ? 'white' : 'transparent',
              color: tab === t.key ? 'var(--text-dark)' : 'var(--text-soft)',
              boxShadow: tab === t.key ? '0 1px 6px rgba(100,80,50,0.10)' : 'none',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="mt-6">
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-12 h-12 border-4 rounded-full animate-spin"
                 style={{ borderColor: 'var(--sand)', borderTopColor: 'var(--sage-dark)' }} />
            <p className="mt-4 text-sm" style={{ color: 'var(--text-soft)' }}>Loading your jobs…</p>
          </div>
        )}

        {!loading && error && (
          <div className="text-center py-16 rounded-2xl" style={{ background: 'white', border: '1.5px solid #fecdd3' }}>
            <div className="text-4xl mb-3">⚠️</div>
            <p className="font-700" style={{ color: 'var(--text-dark)' }}>{error}</p>
            <button onClick={() => fetchJobs()} className="btn-primary mt-5 text-sm" style={{ padding: '0.55rem 1.3rem' }}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">📭</div>
            <h3 className="font-700 text-lg" style={{ color: 'var(--text-dark)' }}>Nothing here yet</h3>
            <p className="text-sm mt-2" style={{ color: 'var(--text-soft)' }}>
              {isProvider
                ? 'Accepted jobs will show up here.'
                : 'Book a professional and the job will appear here.'}
            </p>
            {!isProvider && (
              <Link to="/customer" className="btn-primary inline-block mt-6 text-sm" style={{ padding: '0.6rem 1.4rem' }}>
                Find a professional
              </Link>
            )}
          </div>
        )}

        {!loading && !error && jobs.length > 0 && (
          <div className="space-y-3">
            {jobs.map(job => {
              const meta = STATUS_META[job.status] || { label: job.status_display, emoji: '📋', bg: 'var(--sand)', fg: 'var(--text-mid)' };
              const counterpart = isProvider ? job.customer_username : job.provider_username;
              const scheduled = formatDate(job.scheduled_for);

              return (
                <Link
                  key={job.id}
                  to={`/job/${job.id}`}
                  className="block p-5 transition-all"
                  style={{
                    background: 'white',
                    borderRadius: 'var(--radius)',
                    border: '1.5px solid rgba(180, 160, 130, 0.18)',
                    boxShadow: '0 1px 3px rgba(100,80,50,0.05)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-float)'; }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(100,80,50,0.05)'; }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-700 capitalize" style={{ color: 'var(--text-dark)' }}>
                        {job.service_type_display}
                      </h3>
                      <p className="text-sm mt-0.5" style={{ color: 'var(--text-soft)' }}>
                        {counterpart
                          ? `${isProvider ? 'For' : 'With'} ${counterpart}`
                          : 'Waiting for a professional to accept'}
                      </p>
                    </div>
                    <span
                      className="text-xs font-700 px-3 py-1.5 rounded-full whitespace-nowrap"
                      style={{ background: meta.bg, color: meta.fg }}
                    >
                      {meta.emoji} {meta.label}
                    </span>
                  </div>

                  {job.description && (
                    <p className="text-sm mt-3 line-clamp-2" style={{ color: 'var(--text-mid)' }}>
                      {job.description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs" style={{ color: 'var(--text-soft)' }}>
                    <span>#{job.id}</span>
                    {scheduled && <span>📅 {scheduled}</span>}
                    {job.agreed_price && <span>₹{job.agreed_price}</span>}
                    {job.status === 'CANCELLED' && job.cancellation_reason && (
                      <span style={{ color: '#9f1239' }}>“{job.cancellation_reason}”</span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default MyJobs;
