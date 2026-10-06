import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import toast from 'react-hot-toast';

/* ─── Notification type → emoji & color mapping ─── */
const NOTIF_META = {
  NEW_BOOKING:    { emoji: '🎉', accent: 'var(--sky-deep)',    bg: '#daeef6' },
  JOB_ACCEPTED:   { emoji: '🙌', accent: 'var(--sage-dark)',   bg: 'var(--sage-light)' },
  BOOKING_CONFIRMED: { emoji: '📅', accent: '#065f46',         bg: '#d1fae5' },
  JOB_COMPLETED:  { emoji: '🎊', accent: '#065f46',            bg: '#d1fae5' },
  JOB_CANCELLED:  { emoji: '🚫', accent: '#9f1239',            bg: '#ffe4e6' },
  NEW_REVIEW:     { emoji: '⭐', accent: '#92600a',            bg: '#fef3c7' },
};

const NotificationBell = () => {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef(null);
  const lastSeenIdRef = useRef(0); // Track highest seen ID to avoid toast spam

  const token = localStorage.getItem('access_token');

  const fetchNotifications = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.get('/notifications/');
      const { notifications: notifs, unread_count } = res.data;

      // Detect NEW notifications (IDs we haven't seen yet) for toast alerts
      if (lastSeenIdRef.current > 0 && notifs.length > 0) {
        const newNotifs = notifs.filter(n => n.id > lastSeenIdRef.current && !n.is_read);
        newNotifs.forEach(n => {
          const meta = NOTIF_META[n.type] || { emoji: '🔔' };
          toast(n.title, {
            icon: meta.emoji,
            style: {
              borderLeft: `4px solid ${meta.accent || 'var(--sage)'}`,
            },
          });
        });
      }

      // Update the highest seen ID
      if (notifs.length > 0) {
        const maxId = Math.max(...notifs.map(n => n.id));
        if (maxId > lastSeenIdRef.current) {
          lastSeenIdRef.current = maxId;
        }
      }

      setNotifications(notifs);
      setUnreadCount(unread_count);
    } catch (err) {
      // Token expired or invalid — silently fail
      if (err.response?.status === 401) return;
    }
  }, [token]);

  // Poll every 5 seconds
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 5000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMarkAllRead = async () => {
    setLoading(true);
    try {
      await api.post('/notifications/read-all/', {});
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleNotificationClick = async (notif) => {
    // Mark as read
    if (!notif.is_read) {
      try {
        await api.patch(`/notifications/${notif.id}/read/`, {});
        setNotifications(prev =>
          prev.map(n => n.id === notif.id ? { ...n, is_read: true } : n)
        );
        setUnreadCount(prev => Math.max(0, prev - 1));
      } catch (err) {
        console.error(err);
      }
    }

    // Navigate to job if available
    if (notif.job_id) {
      navigate(`/job/${notif.job_id}`);
      setIsOpen(false);
    }
  };

  if (!token) return null;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative w-10 h-10 rounded-xl flex items-center justify-center transition-all"
        style={{
          background: isOpen ? 'var(--sage-light)' : 'transparent',
          color: 'var(--text-mid)',
        }}
        onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = 'var(--sand)'; }}
        onMouseLeave={e => { if (!isOpen) e.currentTarget.style.background = 'transparent'; }}
        aria-label="Notifications"
      >
        {/* Bell SVG */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center text-white font-800 animate-bounce"
            style={{
              background: 'linear-gradient(135deg, var(--terracotta), #c0613a)',
              fontSize: '0.6rem',
              minWidth: '18px',
              height: '18px',
              borderRadius: '999px',
              padding: '0 4px',
              boxShadow: '0 2px 8px rgba(212, 114, 74, 0.5)',
              animation: 'none',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-80 sm:w-96 overflow-hidden animate-fade-in-up"
          style={{
            background: 'white',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-float)',
            border: '1.5px solid rgba(180, 160, 130, 0.18)',
            zIndex: 100,
            maxHeight: '480px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-3.5"
            style={{ borderBottom: '1.5px solid var(--sand)', flexShrink: 0 }}
          >
            <div className="flex items-center gap-2">
              <h3 style={{ fontFamily: 'Lora, serif', fontWeight: 600, fontSize: '1.05rem', color: 'var(--text-dark)' }}>
                Notifications
              </h3>
              {unreadCount > 0 && (
                <span className="pill pill-terra" style={{ fontSize: '0.7rem' }}>
                  {unreadCount} new
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                disabled={loading}
                className="text-xs font-700 transition-colors"
                style={{ color: 'var(--sage-dark)', opacity: loading ? 0.5 : 1 }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification List */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <span className="text-4xl mb-3">🔔</span>
                <p className="text-sm font-600" style={{ color: 'var(--text-soft)' }}>
                  No notifications yet
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-soft)' }}>
                  You'll see alerts when customers book or respond
                </p>
              </div>
            ) : (
              notifications.map((notif, idx) => {
                const meta = NOTIF_META[notif.type] || { emoji: '🔔', accent: 'var(--text-mid)', bg: 'var(--sand)' };
                return (
                  <div
                    key={notif.id}
                    onClick={() => handleNotificationClick(notif)}
                    className="flex items-start gap-3 px-5 py-3.5 cursor-pointer transition-all"
                    style={{
                      background: notif.is_read ? 'transparent' : 'var(--warm-100)',
                      borderBottom: '1px solid var(--sand)',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--sand)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = notif.is_read ? 'transparent' : 'var(--warm-100)'; }}
                  >
                    {/* Icon */}
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: meta.bg }}
                    >
                      <span style={{ fontSize: '1rem' }}>{meta.emoji}</span>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className="text-sm leading-snug"
                          style={{
                            color: 'var(--text-dark)',
                            fontWeight: notif.is_read ? 500 : 700,
                          }}
                        >
                          {notif.title}
                        </p>
                        {!notif.is_read && (
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
                            style={{ background: 'var(--terracotta)' }}
                          />
                        )}
                      </div>
                      <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-soft)' }}>
                        {notif.message}
                      </p>
                      <p className="text-xs mt-1 font-600" style={{ color: meta.accent }}>
                        {notif.time_ago}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
