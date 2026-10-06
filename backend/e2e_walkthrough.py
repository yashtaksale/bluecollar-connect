"""End-to-end smoke test against a *running* stack over real HTTP.

Not a substitute for the unit suite (`manage.py test core_users`) — that runs
against a throwaway database with the test client. This drives the actual
container through the actual network, so it also proves routing, CORS-adjacent
config, JWT issuance and the migration state of the real database are sound.

    docker compose exec backend python e2e_walkthrough.py
"""

import json
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta

BASE = 'http://localhost:8000/api'
# Mumbai. Customer and provider are ~1.5 km apart so the lead feed has a real
# distance to compute rather than a degenerate zero.
CUST_LAT, CUST_LNG = 19.0760, 72.8777
PROV_LAT, PROV_LNG = 19.0850, 72.8800

PASSWORD = 'Str0ng!Passw0rd42'
_stamp = uuid.uuid4().hex[:8]
CUSTOMER = f'e2e_cust_{_stamp}'
PROVIDER = f'e2e_prov_{_stamp}'

_passed, _failed = 0, 0


def call(method, path, body=None, token=None, expect=None):
    url = f'{BASE}{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            code, raw = res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read().decode()
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {'_raw': raw[:400]}
    if expect is not None and code != expect:
        raise AssertionError(f'{method} {path} -> {code} (wanted {expect}): {payload}')
    return code, payload


def check(label, condition, detail=''):
    global _passed, _failed
    if condition:
        _passed += 1
        print(f'  PASS  {label}')
    else:
        _failed += 1
        print(f'  FAIL  {label} {detail}')


def step(n, title):
    print(f'\n[{n}] {title}')


print('=' * 68)
print('BlueCollar Connect — end-to-end lifecycle over HTTP')
print('=' * 68)

step(1, 'Register a customer and a provider')
call('POST', '/register/', {
    'username': CUSTOMER, 'password': PASSWORD, 'password2': PASSWORD,
    'email': f'{CUSTOMER}@example.com', 'role': 'CUSTOMER',
    'lat': CUST_LAT, 'lng': CUST_LNG,
}, expect=201)
call('POST', '/register/', {
    'username': PROVIDER, 'password': PASSWORD, 'password2': PASSWORD,
    'email': f'{PROVIDER}@example.com', 'role': 'SERVICE_PROVIDER', 'category': 'PLUMBER',
    'lat': PROV_LAT, 'lng': PROV_LNG,
}, expect=201)
check('both accounts created', True)

step(2, 'Log in as each and read the role off the response')
_, cust_login = call('POST', '/login/', {'username': CUSTOMER, 'password': PASSWORD}, expect=200)
_, prov_login = call('POST', '/login/', {'username': PROVIDER, 'password': PASSWORD}, expect=200)
ctok = cust_login['access']
ptok = prov_login['access']
check('login returns a user block with the role',
      cust_login.get('user', {}).get('role') == 'CUSTOMER',
      f"got {cust_login.get('user')}")
check('provider role is reported too',
      prov_login.get('user', {}).get('role') == 'SERVICE_PROVIDER')

step(3, 'Customer searches for a plumber')
_, search = call('GET', f'/search/?category=PLUMBER&lat={CUST_LAT}&lng={CUST_LNG}', token=ctok, expect=200)
mine = [r for r in search['results'] if r['username'] == PROVIDER]
check('our provider is discoverable', len(mine) == 1, f"{len(search['results'])} results")
row = mine[0]
check('search reports a distance', row.get('distance_km') is not None, f"distance_km={row.get('distance_km')}")
check('search leaks no coordinates',
      not any(k in row for k in ('lat', 'lng', 'latitude', 'longitude', 'location')),
      f'keys={sorted(row)}')
provider_id = row['id']

step(4, 'Customer books that provider  ->  PENDING')
_, booking = call('POST', '/book/', {
    'provider_id': provider_id, 'service_type': 'PLUMBER',
    'description': 'Kitchen sink is leaking under the cabinet.',
    'lat': CUST_LAT, 'lng': CUST_LNG,
}, token=ctok, expect=201)
job_id = booking.get('job_id') or booking.get('id')
check('job created', job_id is not None, str(booking))

_, detail = call('GET', f'/jobs/{job_id}/', token=ctok, expect=200)
check('status is PENDING', detail['status'] == 'PENDING', detail['status'])
check('customer sees viewer_role=CUSTOMER', detail.get('viewer_role') == 'CUSTOMER')

step(5, 'Provider is notified and sees the lead')
_, notifs = call('GET', '/notifications/', token=ptok, expect=200)
booking_notes = [n for n in notifs['notifications'] if n['type'] == 'NEW_BOOKING']
check('provider got a NEW_BOOKING notification', len(booking_notes) >= 1)
check('unread_count reflects it', notifs['unread_count'] >= 1, str(notifs['unread_count']))

_, feed = call('GET', '/jobs/pending/', token=ptok, expect=200)
lead = next((j for j in feed['results'] if j['id'] == job_id), None)
check('job appears in the lead feed', lead is not None)
if lead:
    check('lead shows distance_km', lead.get('distance_km') is not None, f"{lead.get('distance_km')}")
    check("lead hides the customer's address before accept",
          lead.get('lat') is None and lead.get('lng') is None,
          f"lat={lead.get('lat')} lng={lead.get('lng')}")

step(6, 'Provider accepts  ->  ACCEPTED')
call('PATCH', f'/jobs/{job_id}/accept/', {}, token=ptok, expect=200)
_, detail = call('GET', f'/jobs/{job_id}/', token=ptok, expect=200)
check('status is ACCEPTED', detail['status'] == 'ACCEPTED', detail['status'])
check('provider is attached', detail.get('provider') is not None)
# JobDetailView nests the address under `job_location`, and only sends it to
# the assigned provider once the job is ACCEPTED or later.
check('address released to the assigned provider once accepted',
      detail.get('job_location', {}).get('lat') is not None,
      f"job_location={detail.get('job_location')}")

code, _ = call('PATCH', f'/jobs/{job_id}/accept/', {}, token=ptok)
check('a second accept is refused (no double-accept)', code == 409, f'got {code}')

_, cnotifs = call('GET', '/notifications/', token=ctok, expect=200)
check('customer notified of the accept',
      any(n['type'] == 'JOB_ACCEPTED' for n in cnotifs['notifications']))

step(7, 'Customer confirms a time  ->  CONFIRMED')
when = (datetime.now() + timedelta(days=2)).replace(hour=10, minute=30, second=0, microsecond=0)
call('PATCH', f'/jobs/{job_id}/confirm/', {
    'scheduled_for': when.strftime('%Y-%m-%dT%H:%M'),
    'notes': 'Gate code is 4321, please ring the upper bell.',
}, token=ctok, expect=200)
_, detail = call('GET', f'/jobs/{job_id}/', token=ctok, expect=200)
check('status is CONFIRMED', detail['status'] == 'CONFIRMED', detail['status'])
check('provider_notes stored and returned',
      'Gate code' in (detail.get('provider_notes') or ''),
      repr(detail.get('provider_notes')))

_, pnotifs = call('GET', '/notifications/', token=ptok, expect=200)
confirmed = [n for n in pnotifs['notifications'] if n['type'] == 'BOOKING_CONFIRMED']
check('provider notified of the confirmation', len(confirmed) >= 1)
if confirmed:
    msg = confirmed[0]['message']
    check('scheduled time is human-readable, not raw ISO',
          'T' not in msg.split('on')[-1], msg)
    print(f'        message: {msg}')

step(8, 'Provider completes  ->  COMPLETED')
_, before = call('GET', '/provider/profile/', token=ptok, expect=200)
call('PATCH', f'/jobs/{job_id}/complete/', {}, token=ptok, expect=200)
_, detail = call('GET', f'/jobs/{job_id}/', token=ctok, expect=200)
check('status is COMPLETED', detail['status'] == 'COMPLETED', detail['status'])
_, after = call('GET', '/provider/profile/', token=ptok, expect=200)
check('jobs_completed incremented exactly once',
      after['jobs_completed'] == before['jobs_completed'] + 1,
      f"{before['jobs_completed']} -> {after['jobs_completed']}")

step(9, 'Customer leaves a review')
check('job is flagged reviewable', detail.get('can_review') is True, str(detail.get('can_review')))
call('POST', '/reviews/', {'job_id': job_id, 'rating': 5,
                           'comment': 'Fast, tidy, and explained the fix.'},
     token=ctok, expect=201)
code, _ = call('POST', '/reviews/', {'job_id': job_id, 'rating': 1, 'comment': 'duplicate'}, token=ctok)
check('a second review on the same job is refused', code == 409, f'got {code}')

_, search2 = call('GET', f'/search/?category=PLUMBER&lat={CUST_LAT}&lng={CUST_LNG}', token=ctok, expect=200)
updated = next((r for r in search2['results'] if r['username'] == PROVIDER), None)
check('rating is reflected in search', updated and updated['avg_rating'] == 5.0,
      str(updated and updated['avg_rating']))
check('completed job counted in search', updated and updated['jobs_completed'] >= 1)

step(10, 'JWT refresh and real logout')
_, refreshed = call('POST', '/login/refresh/', {'refresh': cust_login['refresh']}, expect=200)
check('refresh returns a new access token', 'access' in refreshed)
new_refresh = refreshed.get('refresh', cust_login['refresh'])
call('POST', '/logout/', {'refresh': new_refresh}, token=refreshed['access'], expect=200)
code, _ = call('POST', '/login/refresh/', {'refresh': new_refresh})
check('blacklisted refresh token is rejected after logout', code == 401, f'got {code}')

step(11, 'Authorization spot-checks')
code, _ = call('GET', f'/jobs/{job_id}/')
check('anonymous cannot read a job', code == 401, f'got {code}')
code, _ = call('GET', '/jobs/pending/', token=ctok)
check('customer cannot read the provider lead feed', code == 403, f'got {code}')
code, _ = call('POST', '/book/', {'provider_id': provider_id, 'service_type': 'PLUMBER',
                                  'lat': CUST_LAT, 'lng': CUST_LNG}, token=ptok)
check('provider cannot book', code == 403, f'got {code}')

print('\n' + '=' * 68)
print(f'  {_passed} passed, {_failed} failed')
print('=' * 68)
sys.exit(1 if _failed else 0)
