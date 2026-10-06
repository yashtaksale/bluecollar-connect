import axios from 'axios';

/**
 * Shared axios instance for all authenticated API calls.
 *
 * Attaches the access token on every request, and transparently refreshes it
 * once on a 401 before retrying the original request. Only if the refresh
 * itself fails do we clear the session and send the user to /login.
 */
const api = axios.create({ baseURL: '/api' });

/**
 * Broadcast whenever the stored session changes.
 *
 * The Header used to re-read localStorage on *every* render (a useEffect with
 * no dependency array), which is both a render loop and still wrong across
 * tabs. Components now subscribe to this event instead.
 */
export const AUTH_EVENT = 'bcc:auth-change';

const emitAuthChange = () => {
  window.dispatchEvent(new Event(AUTH_EVENT));
};

export const getAccessToken = () => localStorage.getItem('access_token');
export const getRefreshToken = () => localStorage.getItem('refresh_token');
export const getUserRole = () => localStorage.getItem('user_role');
export const getUsername = () => localStorage.getItem('username');
export const isAuthenticated = () => !!getAccessToken();

export const saveSession = ({ access, refresh, role, username }) => {
  if (access) localStorage.setItem('access_token', access);
  if (refresh) localStorage.setItem('refresh_token', refresh);
  if (role) localStorage.setItem('user_role', role);
  if (username) localStorage.setItem('username', username);
  emitAuthChange();
};

export const clearSession = () => {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user_role');
  localStorage.removeItem('username');
  emitAuthChange();
};

/**
 * Full logout: blacklist the refresh token server-side, then drop local state.
 *
 * Clearing localStorage alone left the refresh token valid for its whole
 * 7-day lifetime — anyone who had copied it stayed logged in after "Logout".
 * The network call is best-effort: a failure must never trap the user in a
 * session they asked to end.
 */
export const logout = async () => {
  const refresh = getRefreshToken();
  if (refresh) {
    try {
      // Bare axios, not `api`: an already-expired access token would make the
      // response interceptor attempt a refresh and, on failure, hard-redirect
      // to /login — the wrong destination for a deliberate logout.
      await axios.post('/api/logout/', { refresh });
    } catch {
      /* already expired, blacklisted, or offline — local clear still applies */
    }
  }
  clearSession();
};

const redirectToLogin = () => {
  clearSession();
  // Avoid a redirect loop if we're already sitting on the login page.
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
};

/* ─── Request: attach the current access token ─── */
api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/* ─── Response: refresh once on 401, then retry ─── */

// While a refresh is in flight, park any other 401s here instead of firing
// N parallel refresh calls (the 5s pollers would otherwise stampede).
let isRefreshing = false;
let pendingQueue = [];

const flushQueue = (error, token = null) => {
  pendingQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token);
  });
  pendingQueue = [];
};

/**
 * Exchange the stored refresh token for a new access token.
 * Uses bare axios, not `api`, so this call can never re-enter this interceptor.
 */
const refreshAccessToken = async () => {
  const refresh = getRefreshToken();
  if (!refresh) throw new Error('No refresh token stored');

  const res = await axios.post('/api/login/refresh/', { refresh });

  const newAccess = res.data?.access;
  if (!newAccess) throw new Error('Refresh response contained no access token');
  localStorage.setItem('access_token', newAccess);

  // ROTATE_REFRESH_TOKENS is on server-side, so a new refresh token comes back
  // with each refresh. Persist it or the next refresh will use a stale one.
  if (res.data?.refresh) {
    localStorage.setItem('refresh_token', res.data.refresh);
  }

  return newAccess;
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;

    // Only handle 401s we haven't already retried once.
    if (response?.status !== 401 || !config || config._retry) {
      return Promise.reject(error);
    }

    // No refresh token means there's nothing to recover with.
    if (!getRefreshToken()) {
      redirectToLogin();
      return Promise.reject(error);
    }

    config._retry = true;

    // A refresh is already running — wait for it, then retry with the new token.
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        pendingQueue.push({
          resolve: (token) => {
            config.headers.Authorization = `Bearer ${token}`;
            resolve(api(config));
          },
          reject,
        });
      });
    }

    isRefreshing = true;
    try {
      const newAccess = await refreshAccessToken();
      flushQueue(null, newAccess);
      config.headers.Authorization = `Bearer ${newAccess}`;
      return api(config);
    } catch (refreshError) {
      // Refresh genuinely failed (expired/invalid) — now it's a real logout.
      flushQueue(refreshError);
      redirectToLogin();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
