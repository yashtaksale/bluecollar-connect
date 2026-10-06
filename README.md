# BlueCollar Connect 🏡

A location-aware marketplace connecting local service providers (plumbers,
electricians, painters, cleaners, appliance technicians, pest controllers) with
customers nearby.

Customers search by trade and distance, book a pro, agree a time, and review the
work. Providers get a live feed of open jobs within their radius and their own
trade, and manage their availability, rate, and working location.

---

## 🚀 Getting started

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS) or
  [Docker Compose](https://docs.docker.com/compose/install/) (Linux).
- Nothing else. Python, Node, GDAL and PostGIS all live inside the containers.

### One-step setup

```bash
docker compose up --build
```

This will:
1. Spin up **PostGIS** (PostgreSQL 15 + PostGIS 3.3) and wait for a real readiness probe.
2. Build and start the **Django** backend, running migrations on boot.
3. Start the **Vite + React** frontend.

Then open [http://localhost:5173](http://localhost:5173).

### Configuration

Every secret and environment-specific value is read from the environment. Copy
the template and edit as needed — Compose picks `.env` up automatically:

```bash
cp .env.example .env
```

With no `.env` the stack still boots using the development fallbacks in
`docker-compose.yml`. Those fallbacks are **only** reachable while
`DJANGO_DEBUG=True`: with `DEBUG=False` the app refuses to start without an
explicit `DJANGO_SECRET_KEY` and `DJANGO_ALLOWED_HOSTS`.

| Variable | Purpose | Dev default |
| --- | --- | --- |
| `DJANGO_DEBUG` | Debug mode | `True` |
| `DJANGO_SECRET_KEY` | Signing key — **required** when `DEBUG=False` | throwaway dev key |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated hosts — **required** when `DEBUG=False` | `*` |
| `DJANGO_CORS_ALLOWED_ORIGINS` | Comma-separated browser origins | localhost:5173 |
| `DISPLAY_TIME_ZONE` | Timezone used to interpret and render appointment times | `Asia/Kolkata` |
| `ACCESS_TOKEN_MINUTES` / `REFRESH_TOKEN_DAYS` | JWT lifetimes | `60` / `7` |
| `POSTGRES_*` | Database connection | see `.env.example` |

---

## 🧪 Tests

```bash
docker compose run --rm backend python manage.py test core_users -v 2
```

The suite covers the parts worth protecting: the job state machine, the
concurrency guards on accept/complete/review, role-based access, and what each
endpoint reveals about the other party. It must run in the container — GeoDjango
needs GDAL and the test database needs the PostGIS extension.

To confirm the models and migrations agree:

```bash
docker compose run --rm backend python manage.py makemigrations --check --dry-run
```

### End-to-end smoke test

With the stack already running (`docker compose up`), this drives a real
customer and provider through the whole lifecycle over HTTP — register, search,
book, accept, confirm, complete, review, refresh, logout:

```bash
docker compose exec backend python e2e_walkthrough.py
```

Unlike the unit suite it hits the running containers and the real database, so
it also exercises routing, JWT issuance and the applied migration state. It
creates uniquely-named throwaway accounts on each run. Note that registration
is rate-limited to 5/hour per IP: if you run it repeatedly you'll hit a `429`,
and `docker compose restart backend` clears the in-memory throttle counters.

---

## 🌐 Mobile / LAN access

- **Local PC**: [http://localhost:5173](http://localhost:5173)
- **Phone on the same Wi-Fi**: `http://<YOUR_PC_IP>:5173`

On Windows you may need to open the port (**PowerShell as Administrator**):

```powershell
New-NetFirewallRule -DisplayName "Vite Mobile Access" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
```

Find your address with `ipconfig` (look for **IPv4 Address**).

> Browser GPS is only available on `https://` or `localhost`, so over plain HTTP
> on a phone the app falls back to a server-side IP lookup (`/api/location/`),
> and providers can set their working location manually.

---

## 🏗️ Tech stack

- **Frontend**: React 19, Vite, React Router 7, Tailwind CSS, axios, react-hot-toast, Lottie.
- **Backend**: Django 6, Django REST Framework, GeoDjango (PostGIS), SimpleJWT.
- **Infrastructure**: Docker & Docker Compose.

Django 6 requires Python 3.12+; the backend image pins `python:3.12-slim`.

---

## 🔄 The job lifecycle

```
        customer books                provider accepts
  ─────────────────────────►  PENDING ─────────────────────►  ACCEPTED
                                 │                               │
                                 │                               │ customer picks a time
                                 │                               ▼
                                 │                           CONFIRMED
                                 │                               │
                                 │                               │ provider marks done
                                 │                               ▼
                                 │                           COMPLETED ──► review (once)
                                 ▼
                  either party cancels, any time before COMPLETED
                                 │
                                 ▼
                             CANCELLED
```

Every transition is guarded server-side inside `transaction.atomic()` with
`select_for_update()`, so a status is only ever changed from the exact state it
is allowed to move from. Two providers racing for the same lead is a `409` for
the loser, not a silent overwrite.

Each transition also creates a `Notification` for the counterpart; the bell in
the header polls for these.

---

## 🔐 Security notes

- **Deny by default.** DRF's default permission is `IsAuthenticated`; genuinely
  public endpoints (register, login, refresh, IP geolocation) opt in to
  `AllowAny` explicitly. Role-specific endpoints add `IsCustomer` / `IsProvider`,
  and per-job endpoints add object-level `IsJobParticipant`.
- **Location is PII.** Provider search returns distance, never coordinates. The
  provider lead feed likewise shows distance only — a job's coordinates are the
  customer's home address, and are revealed to the assigned provider only once
  the job is `ACCEPTED` or later. Being *named* on a job is not enough: a direct
  booking sets the provider while the job is still `PENDING`, so the address is
  gated on status as well as identity.
- **Rate limits** on the endpoints worth abusing: login `10/min`, register
  `5/hour`, booking `30/hour`, review `20/hour`, geolocation `30/hour`.
- **Real logout.** Refresh tokens are rotated and blacklisted server-side, so
  clearing browser storage isn't the only thing standing between a stolen token
  and an account.
- **Jobs are built server-side** from validated input. There is no endpoint that
  accepts a client-supplied `status`, `provider`, or `agreed_price`.
- `X-Forwarded-For` is attacker-controlled, so the geolocation proxy only uses it
  after the value parses as a public IP address.

---

## 📁 Project structure

```
backend/
  core/            Django project — settings, URLs, WSGI/ASGI
  core_users/      The whole domain: models, serializers, views, permissions, tests
  Dockerfile
frontend/
  src/api/         axios client, JWT refresh interceptor, session helpers
  src/components/  NotificationBell, ProtectedRoute, ErrorBoundary
  src/pages/       Home, Login, Register, dashboards, FindService, JobRoom, MyJobs
docker-compose.yml
.env.example
```

### API surface

| Method | Path | Who |
| --- | --- | --- |
| `POST` | `/api/register/` | anyone |
| `POST` | `/api/login/` · `/api/login/refresh/` · `/api/logout/` | anyone |
| `GET` | `/api/user/me/` | authenticated |
| `GET`/`PATCH` | `/api/provider/profile/` | provider |
| `GET` | `/api/search/` | authenticated |
| `POST` | `/api/book/` | customer |
| `GET` | `/api/jobs/mine/` | authenticated |
| `GET` | `/api/jobs/pending/` | provider |
| `GET` | `/api/jobs/<id>/` | job participant |
| `PATCH` | `/api/jobs/<id>/accept/` | provider |
| `PATCH` | `/api/jobs/<id>/confirm/` | customer |
| `PATCH` | `/api/jobs/<id>/complete/` | provider |
| `PATCH` | `/api/jobs/<id>/cancel/` | job participant |
| `POST` | `/api/reviews/` | customer |
| `GET` | `/api/notifications/` | authenticated |
| `PATCH` | `/api/notifications/<id>/read/` | authenticated |
| `POST` | `/api/notifications/read-all/` | authenticated |
| `GET` | `/api/location/` | anyone |

List endpoints are paginated (`PAGE_SIZE=20`) and return `{count, next, previous, results}`.
`/api/notifications/` is the exception — it returns `{notifications, unread_count}`.
