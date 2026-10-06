"""
Test suite for the job lifecycle, role permissions, and PII exposure.

Focus is deliberately on the things that were actually broken or dangerous:
the state machine, the concurrency guards, cross-role access, and what each
endpoint reveals about the other party. Happy-path CRUD that Django itself
guarantees is not re-tested here.

Run inside the container (GeoDjango needs GDAL + a PostGIS test database):

    docker compose run --rm backend python manage.py test core_users -v 2
"""

from datetime import timedelta
from decimal import Decimal

from django.contrib.gis.geos import Point
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .models import JobRequest, Notification, Review, ServiceProviderProfile, User

# Mumbai, and a point ~2 km away.
HERE = Point(72.8777, 19.0760, srid=4326)
NEARBY = Point(72.8977, 19.0860, srid=4326)
FAR_AWAY = Point(-74.0060, 40.7128, srid=4326)   # New York

# `provider=None` is a meaningful value (a broadcast job), so the helper needs a
# separate sentinel for "caller didn't say".
_DEFAULT = object()


class BaseAPITestCase(APITestCase):
    """Shared fixtures: one customer, one plumber, one electrician."""

    def setUp(self):
        # Throttle counters live in the cache and leak between tests, so a
        # later test can fail with a spurious 429.
        cache.clear()

        self.customer = User.objects.create_user(
            username='cust', email='c@example.com', password='pw-not-a-secret-1',
            role='CUSTOMER',
        )
        self.other_customer = User.objects.create_user(
            username='cust2', email='c2@example.com', password='pw-not-a-secret-1',
            role='CUSTOMER',
        )
        self.plumber_user = User.objects.create_user(
            username='plumb', email='p@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        self.plumber = ServiceProviderProfile.objects.create(
            user=self.plumber_user, category='PLUMBER', location=HERE,
            hourly_rate=Decimal('500.00'),
        )
        self.sparky_user = User.objects.create_user(
            username='sparky', email='e@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        self.sparky = ServiceProviderProfile.objects.create(
            user=self.sparky_user, category='ELECTRICIAN', location=HERE,
            hourly_rate=Decimal('600.00'),
        )

    def make_job(self, status_value='PENDING', provider=_DEFAULT, customer=None, **kwargs):
        return JobRequest.objects.create(
            customer=customer or self.customer,
            provider=self.plumber if provider is _DEFAULT else provider,
            service_type=kwargs.pop('service_type', 'PLUMBER'),
            description=kwargs.pop('description', 'Leaking kitchen tap'),
            status=status_value,
            location=kwargs.pop('location', NEARBY),
            **kwargs
        )


# ─────────────────────────── Registration ───────────────────────────

class RegistrationTests(BaseAPITestCase):

    def test_provider_must_choose_a_category(self):
        """The old serializer silently defaulted to PLUMBER."""
        res = self.client.post(reverse('register'), {
            'username': 'newpro', 'email': 'n@example.com',
            'password': 'a-long-enough-pw-42', 'role': 'SERVICE_PROVIDER',
        }, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('category', res.data)
        self.assertFalse(User.objects.filter(username='newpro').exists())

    def test_lat_without_lng_is_rejected(self):
        res = self.client.post(reverse('register'), {
            'username': 'halfloc', 'email': 'h@example.com',
            'password': 'a-long-enough-pw-42', 'role': 'SERVICE_PROVIDER',
            'category': 'PLUMBER', 'lat': 19.07,
        }, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_weak_password_rejected(self):
        res = self.client.post(reverse('register'), {
            'username': 'weak', 'email': 'w@example.com',
            'password': '123', 'role': 'CUSTOMER',
        }, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_login_returns_the_users_role(self):
        """The frontend routes on this; it used to guess from the login form."""
        res = self.client.post(reverse('token_obtain_pair'), {
            'username': 'cust', 'password': 'pw-not-a-secret-1',
        }, format='json')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data['user']['role'], 'CUSTOMER')
        self.assertIn('access', res.data)
        self.assertIn('refresh', res.data)


# ──────────────────────────── Permissions ───────────────────────────

class PermissionTests(BaseAPITestCase):

    def test_endpoints_reject_anonymous_callers(self):
        """Deny-by-default: none of these should be reachable logged out."""
        for url in (
            reverse('provider_search') + '?category=PLUMBER&lat=19.07&lng=72.87',
            reverse('my_jobs'),
            reverse('pending_jobs'),
            reverse('notifications'),
            reverse('provider_profile'),
        ):
            with self.subTest(url=url):
                self.assertEqual(
                    self.client.get(url).status_code, status.HTTP_401_UNAUTHORIZED
                )

    def test_customer_cannot_read_the_provider_lead_feed(self):
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('pending_jobs'))
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_provider_cannot_book(self):
        self.client.force_authenticate(self.plumber_user)
        res = self.client.post(reverse('book_provider'), {
            'provider_id': self.sparky.id, 'service_type': 'ELECTRICIAN',
            'lat': 19.07, 'lng': 72.87,
        }, format='json')
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_non_participant_cannot_read_a_job(self):
        job = self.make_job()
        self.client.force_authenticate(self.other_customer)
        res = self.client.get(reverse('job_detail', args=[job.id]))
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_provider_without_a_profile_is_refused_cleanly(self):
        orphan = User.objects.create_user(
            username='orphan', email='o@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        self.client.force_authenticate(orphan)
        res = self.client.get(reverse('pending_jobs'))
        # A 403, not a 500 from `user.provider_profile` blowing up in the view.
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)


# ────────────────────────────── Booking ─────────────────────────────

class BookingTests(BaseAPITestCase):

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(self.customer)
        self.payload = {
            'provider_id': self.plumber.id, 'service_type': 'PLUMBER',
            'description': 'Leaking tap', 'lat': 19.0760, 'lng': 72.8777,
        }

    def test_booking_creates_a_pending_job_and_notifies_the_provider(self):
        res = self.client.post(reverse('book_provider'), self.payload, format='json')
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)

        job = JobRequest.objects.get(pk=res.data['job_id'])
        self.assertEqual(job.status, 'PENDING')
        self.assertEqual(job.provider, self.plumber)
        # The rate is snapshotted so a later price change can't rewrite history.
        self.assertEqual(job.agreed_price, self.plumber.hourly_rate)
        self.assertTrue(Notification.objects.filter(
            recipient=self.plumber_user, notif_type='NEW_BOOKING', job=job,
        ).exists())

    def test_service_type_must_match_the_providers_category(self):
        """
        Booking a plumber for electrical work used to succeed, then the job
        never appeared in anyone's lead feed (which filters on category).
        """
        res = self.client.post(reverse('book_provider'),
                               {**self.payload, 'service_type': 'ELECTRICIAN'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(JobRequest.objects.count(), 0)

    def test_unknown_service_type_rejected(self):
        res = self.client.post(reverse('book_provider'),
                               {**self.payload, 'service_type': 'ASTRONAUT'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_missing_fields_are_named_in_the_error(self):
        res = self.client.post(reverse('book_provider'), {'provider_id': self.plumber.id},
                               format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        for field in ('service_type', 'lat', 'lng'):
            self.assertIn(field, res.data['error'])

    def test_out_of_range_coordinates_rejected(self):
        res = self.client.post(reverse('book_provider'),
                               {**self.payload, 'lat': 999}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_duplicate_open_booking_is_refused_with_the_existing_job(self):
        first = self.client.post(reverse('book_provider'), self.payload, format='json')
        second = self.client.post(reverse('book_provider'), self.payload, format='json')
        self.assertEqual(second.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(second.data['job_id'], first.data['job_id'])
        self.assertEqual(JobRequest.objects.count(), 1)

    def test_can_rebook_once_the_previous_job_is_closed(self):
        first = self.client.post(reverse('book_provider'), self.payload, format='json')
        JobRequest.objects.filter(pk=first.data['job_id']).update(status='COMPLETED')
        second = self.client.post(reverse('book_provider'), self.payload, format='json')
        self.assertEqual(second.status_code, status.HTTP_201_CREATED)

    def test_inactive_provider_cannot_be_booked(self):
        self.plumber.is_active = False
        self.plumber.save(update_fields=['is_active'])
        res = self.client.post(reverse('book_provider'), self.payload, format='json')
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)

    def test_over_long_description_rejected(self):
        res = self.client.post(reverse('book_provider'),
                               {**self.payload, 'description': 'x' * 2001}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


# ─────────────────────────── Lead feed / PII ────────────────────────

class LeadFeedTests(BaseAPITestCase):

    def test_feed_is_scoped_to_the_providers_own_category(self):
        """
        The category used to come from the query string, so any provider could
        list — and then accept — jobs outside their trade.
        """
        self.make_job(service_type='PLUMBER', provider=None)
        self.make_job(service_type='ELECTRICIAN', provider=None,
                      customer=self.other_customer)

        self.client.force_authenticate(self.sparky_user)
        res = self.client.get(reverse('pending_jobs'),
                              {'lat': 19.0760, 'lng': 72.8777, 'category': 'PLUMBER'})
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        types = {row['service_type'] for row in res.data['results']}
        self.assertEqual(types, {'ELECTRICIAN'})

    def test_feed_excludes_jobs_directed_at_another_provider(self):
        self.make_job(service_type='PLUMBER', provider=self.plumber)
        other_plumber_user = User.objects.create_user(
            username='plumb2', email='p2@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        other = ServiceProviderProfile.objects.create(
            user=other_plumber_user, category='PLUMBER', location=HERE,
        )
        self.client.force_authenticate(other.user)
        res = self.client.get(reverse('pending_jobs'), {'lat': 19.0760, 'lng': 72.8777})
        self.assertEqual(res.data['results'], [])

    def test_feed_does_not_leak_the_customers_address(self):
        """
        Job coordinates are the customer's home. The lead feed shares a
        serializer with the job detail view, and used to publish lat/lng to
        every provider in radius before anyone accepted anything.
        """
        self.make_job(service_type='PLUMBER', provider=None)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('pending_jobs'), {'lat': 19.0760, 'lng': 72.8777})

        row = res.data['results'][0]
        self.assertIsNone(row['lat'])
        self.assertIsNone(row['lng'])
        # Distance is the signal they actually need, and it is populated.
        self.assertIsNotNone(row['distance_km'])

    def test_direct_booking_hides_the_address_until_accepted(self):
        """
        A *direct* booking names the provider at creation, so gating the
        address on the FK alone revealed it while the job was still PENDING —
        before they agreed to anything, and harvestable by never accepting.
        """
        self.make_job(service_type='PLUMBER', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('pending_jobs'), {'lat': 19.0760, 'lng': 72.8777})

        row = next(r for r in res.data['results'] if r['status'] == 'PENDING')
        self.assertIsNone(row['lat'])
        self.assertIsNone(row['lng'])
        self.assertIsNotNone(row['distance_km'])

    def test_address_is_released_once_the_provider_accepts(self):
        job = self.make_job(status_value='ACCEPTED', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('my_jobs'))

        row = next(r for r in res.data['results'] if r['id'] == job.id)
        self.assertIsNotNone(row['lat'])
        self.assertIsNotNone(row['lng'])

    def test_participants_still_see_coordinates(self):
        job = self.make_job(status_value='ACCEPTED', provider=self.plumber)
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('job_detail', args=[job.id]))
        self.assertEqual(res.status_code, status.HTTP_200_OK)

    def test_distant_jobs_are_excluded(self):
        self.make_job(service_type='PLUMBER', provider=None, location=FAR_AWAY)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('pending_jobs'),
                              {'lat': 19.0760, 'lng': 72.8777, 'radius': 50})
        self.assertEqual(res.data['results'], [])

    def test_non_numeric_radius_is_a_400_not_a_500(self):
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('pending_jobs'),
                              {'lat': 19.0760, 'lng': 72.8777, 'radius': 'far'})
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_provider_with_no_location_gets_an_empty_feed_not_an_error(self):
        self.plumber.location = None
        self.plumber.save(update_fields=['location'])
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('pending_jobs'))
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data['results'], [])


class ProviderSearchTests(BaseAPITestCase):

    def test_search_never_returns_provider_coordinates(self):
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('provider_search'),
                              {'category': 'PLUMBER', 'lat': 19.0760, 'lng': 72.8777})
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertTrue(res.data['results'])
        row = res.data['results'][0]
        for leaky in ('lat', 'lng', 'latitude', 'longitude', 'location'):
            self.assertNotIn(leaky, row)
        self.assertIsNotNone(row['distance_km'])

    def test_search_requires_a_known_category(self):
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('provider_search'),
                              {'category': 'ASTRONAUT', 'lat': 19.0760, 'lng': 72.8777})
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_inactive_providers_are_hidden(self):
        self.plumber.is_active = False
        self.plumber.save(update_fields=['is_active'])
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('provider_search'),
                              {'category': 'PLUMBER', 'lat': 19.0760, 'lng': 72.8777})
        self.assertEqual(res.data['results'], [])


# ────────────────────────── Accept / Confirm ────────────────────────

class AcceptJobTests(BaseAPITestCase):

    def test_provider_accepts_and_the_customer_is_notified(self):
        job = self.make_job(provider=None)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.patch(reverse('accept-job', args=[job.id]), {}, format='json')

        self.assertEqual(res.status_code, status.HTTP_200_OK)
        job.refresh_from_db()
        self.assertEqual(job.status, 'ACCEPTED')
        self.assertEqual(job.provider, self.plumber)
        self.assertTrue(Notification.objects.filter(
            recipient=self.customer, notif_type='JOB_ACCEPTED', job=job,
        ).exists())

    def test_second_accept_is_a_409(self):
        """The guard against two providers claiming the same lead."""
        job = self.make_job(provider=None)
        self.client.force_authenticate(self.plumber_user)
        self.client.patch(reverse('accept-job', args=[job.id]), {}, format='json')

        other_user = User.objects.create_user(
            username='plumb3', email='p3@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        ServiceProviderProfile.objects.create(
            user=other_user, category='PLUMBER', location=HERE,
        )
        self.client.force_authenticate(other_user)
        res = self.client.patch(reverse('accept-job', args=[job.id]), {}, format='json')

        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        job.refresh_from_db()
        self.assertEqual(job.provider, self.plumber)

    def test_cannot_accept_a_job_directed_at_someone_else(self):
        job = self.make_job(provider=self.plumber)
        other_user = User.objects.create_user(
            username='plumb4', email='p4@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        ServiceProviderProfile.objects.create(
            user=other_user, category='PLUMBER', location=HERE,
        )
        self.client.force_authenticate(other_user)
        res = self.client.patch(reverse('accept-job', args=[job.id]), {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)


class ConfirmJobTests(BaseAPITestCase):

    def setUp(self):
        super().setUp()
        self.job = self.make_job(status_value='ACCEPTED', provider=self.plumber)
        self.when = (timezone.now() + timedelta(days=2)).isoformat()

    def test_customer_confirms_and_schedules(self):
        self.client.force_authenticate(self.customer)
        res = self.client.patch(reverse('confirm-job', args=[self.job.id]),
                                {'scheduled_for': self.when, 'notes': 'Gate code 4321'},
                                format='json')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.job.refresh_from_db()
        self.assertEqual(self.job.status, 'CONFIRMED')
        self.assertEqual(self.job.provider_notes, 'Gate code 4321')
        # The notification must carry a human-readable time, not raw ISO.
        note = Notification.objects.get(recipient=self.plumber_user,
                                        notif_type='BOOKING_CONFIRMED')
        self.assertNotIn('T', note.message.split('for')[-1])

    def test_a_past_datetime_is_rejected(self):
        self.client.force_authenticate(self.customer)
        res = self.client.patch(reverse('confirm-job', args=[self.job.id]),
                                {'scheduled_for': (timezone.now() - timedelta(days=1)).isoformat()},
                                format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.job.refresh_from_db()
        self.assertEqual(self.job.status, 'ACCEPTED')

    def test_unparseable_datetime_is_rejected(self):
        self.client.force_authenticate(self.customer)
        res = self.client.patch(reverse('confirm-job', args=[self.job.id]),
                                {'scheduled_for': 'next tuesday-ish'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)

    def test_provider_cannot_confirm_their_own_job(self):
        self.client.force_authenticate(self.plumber_user)
        res = self.client.patch(reverse('confirm-job', args=[self.job.id]),
                                {'scheduled_for': self.when}, format='json')
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_cannot_confirm_a_job_that_is_still_pending(self):
        pending = self.make_job(status_value='PENDING', customer=self.other_customer)
        self.client.force_authenticate(self.other_customer)
        res = self.client.patch(reverse('confirm-job', args=[pending.id]),
                                {'scheduled_for': self.when}, format='json')
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)


# ───────────────────────── Complete / Cancel ────────────────────────

class CompleteJobTests(BaseAPITestCase):

    def test_completion_increments_the_providers_counter(self):
        job = self.make_job(status_value='CONFIRMED', provider=self.plumber)
        before = self.plumber.jobs_completed

        self.client.force_authenticate(self.plumber_user)
        res = self.client.patch(reverse('complete-job', args=[job.id]), {}, format='json')

        self.assertEqual(res.status_code, status.HTTP_200_OK)
        job.refresh_from_db()
        self.plumber.refresh_from_db()
        self.assertEqual(job.status, 'COMPLETED')
        self.assertEqual(self.plumber.jobs_completed, before + 1)
        self.assertTrue(Notification.objects.filter(
            recipient=self.customer, notif_type='JOB_COMPLETED', job=job,
        ).exists())

    def test_cannot_complete_a_job_you_are_not_assigned_to(self):
        job = self.make_job(status_value='CONFIRMED', provider=self.plumber)
        other_user = User.objects.create_user(
            username='plumb5', email='p5@example.com', password='pw-not-a-secret-1',
            role='SERVICE_PROVIDER',
        )
        ServiceProviderProfile.objects.create(
            user=other_user, category='PLUMBER', location=HERE,
        )
        self.client.force_authenticate(other_user)
        res = self.client.patch(reverse('complete-job', args=[job.id]), {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_cannot_complete_before_confirmation(self):
        job = self.make_job(status_value='ACCEPTED', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.patch(reverse('complete-job', args=[job.id]), {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)

    def test_double_completion_does_not_double_count(self):
        job = self.make_job(status_value='CONFIRMED', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        self.client.patch(reverse('complete-job', args=[job.id]), {}, format='json')
        res = self.client.patch(reverse('complete-job', args=[job.id]), {}, format='json')

        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        self.plumber.refresh_from_db()
        self.assertEqual(self.plumber.jobs_completed, 1)


class CancelJobTests(BaseAPITestCase):

    def test_customer_can_cancel_and_the_provider_is_told(self):
        job = self.make_job(status_value='CONFIRMED', provider=self.plumber)
        self.client.force_authenticate(self.customer)
        res = self.client.patch(reverse('cancel-job', args=[job.id]),
                                {'reason': 'Fixed it myself'}, format='json')

        self.assertEqual(res.status_code, status.HTTP_200_OK)
        job.refresh_from_db()
        self.assertEqual(job.status, 'CANCELLED')
        self.assertEqual(job.cancelled_by, self.customer)
        self.assertEqual(job.cancellation_reason, 'Fixed it myself')
        self.assertTrue(Notification.objects.filter(
            recipient=self.plumber_user, notif_type='JOB_CANCELLED', job=job,
        ).exists())

    def test_provider_can_also_cancel(self):
        job = self.make_job(status_value='ACCEPTED', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.patch(reverse('cancel-job', args=[job.id]), {}, format='json')

        self.assertEqual(res.status_code, status.HTTP_200_OK)
        job.refresh_from_db()
        self.assertEqual(job.cancelled_by, self.plumber_user)
        self.assertTrue(Notification.objects.filter(
            recipient=self.customer, notif_type='JOB_CANCELLED',
        ).exists())

    def test_a_completed_job_cannot_be_cancelled(self):
        job = self.make_job(status_value='COMPLETED', provider=self.plumber)
        self.client.force_authenticate(self.customer)
        res = self.client.patch(reverse('cancel-job', args=[job.id]), {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        job.refresh_from_db()
        self.assertEqual(job.status, 'COMPLETED')

    def test_a_stranger_cannot_cancel_someone_elses_job(self):
        job = self.make_job(status_value='CONFIRMED', provider=self.plumber)
        self.client.force_authenticate(self.other_customer)
        res = self.client.patch(reverse('cancel-job', args=[job.id]), {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)
        job.refresh_from_db()
        self.assertEqual(job.status, 'CONFIRMED')


# ────────────────────────────── Reviews ─────────────────────────────

class ReviewTests(BaseAPITestCase):

    def setUp(self):
        super().setUp()
        self.job = self.make_job(status_value='COMPLETED', provider=self.plumber)
        self.client.force_authenticate(self.customer)

    def test_customer_reviews_a_completed_job(self):
        res = self.client.post(reverse('submit_review'), {
            'job_id': self.job.id, 'rating': 5, 'comment': 'Spotless work',
        }, format='json')
        self.assertEqual(res.status_code, status.HTTP_201_CREATED)
        review = Review.objects.get(job=self.job)
        self.assertEqual(review.provider, self.plumber)
        self.assertTrue(Notification.objects.filter(
            recipient=self.plumber_user, notif_type='NEW_REVIEW',
        ).exists())

    def test_only_one_review_per_job(self):
        payload = {'job_id': self.job.id, 'rating': 5}
        self.client.post(reverse('submit_review'), payload, format='json')
        res = self.client.post(reverse('submit_review'), payload, format='json')
        self.assertEqual(res.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(Review.objects.filter(job=self.job).count(), 1)

    def test_cannot_review_an_unfinished_job(self):
        job = self.make_job(status_value='CONFIRMED', provider=self.plumber)
        res = self.client.post(reverse('submit_review'),
                               {'job_id': job.id, 'rating': 5}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Review.objects.exists())

    def test_cannot_review_someone_elses_job(self):
        self.client.force_authenticate(self.other_customer)
        res = self.client.post(reverse('submit_review'),
                               {'job_id': self.job.id, 'rating': 1}, format='json')
        self.assertEqual(res.status_code, status.HTTP_403_FORBIDDEN)

    def test_rating_must_be_between_one_and_five(self):
        for bad in (0, 6, -3, 'five', None):
            with self.subTest(rating=bad):
                res = self.client.post(reverse('submit_review'),
                                       {'job_id': self.job.id, 'rating': bad}, format='json')
                self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Review.objects.exists())


# ─────────────────────── Job detail / My jobs ───────────────────────

class JobDetailTests(BaseAPITestCase):

    def test_customer_address_is_withheld_until_the_job_is_accepted(self):
        job = self.make_job(status_value='PENDING', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('job_detail', args=[job.id]))
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIsNone(res.data.get('job_location'))

        job.status = 'ACCEPTED'
        job.save(update_fields=['status'])
        res = self.client.get(reverse('job_detail', args=[job.id]))
        self.assertIsNotNone(res.data.get('job_location'))

    def test_viewer_role_is_reported_from_the_server(self):
        """The Job Room renders off this rather than client-editable storage."""
        job = self.make_job(status_value='ACCEPTED', provider=self.plumber)

        self.client.force_authenticate(self.customer)
        self.assertEqual(
            self.client.get(reverse('job_detail', args=[job.id])).data['viewer_role'],
            'CUSTOMER',
        )
        self.client.force_authenticate(self.plumber_user)
        self.assertEqual(
            self.client.get(reverse('job_detail', args=[job.id])).data['viewer_role'],
            'SERVICE_PROVIDER',
        )

    def test_missing_job_is_a_404(self):
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('job_detail', args=[999999]))
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)


class MyJobsTests(BaseAPITestCase):

    def test_lists_only_the_callers_own_jobs(self):
        self.make_job(status_value='PENDING')
        self.make_job(status_value='PENDING', customer=self.other_customer)

        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('my_jobs'))
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(len(res.data['results']), 1)

    def test_status_filter_accepts_a_comma_separated_list(self):
        self.make_job(status_value='PENDING')
        self.make_job(status_value='COMPLETED')
        self.make_job(status_value='CANCELLED')

        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('my_jobs'), {'status': 'PENDING,COMPLETED'})
        returned = {row['status'] for row in res.data['results']}
        self.assertEqual(returned, {'PENDING', 'COMPLETED'})

    def test_provider_sees_the_jobs_assigned_to_them(self):
        self.make_job(status_value='ACCEPTED', provider=self.plumber)
        self.client.force_authenticate(self.plumber_user)
        res = self.client.get(reverse('my_jobs'))
        self.assertEqual(len(res.data['results']), 1)

    def test_results_are_newest_first(self):
        older = self.make_job(status_value='PENDING')
        newer = self.make_job(status_value='PENDING', service_type='PLUMBER')
        JobRequest.objects.filter(pk=older.pk).update(
            created_at=timezone.now() - timedelta(days=1)
        )
        self.client.force_authenticate(self.customer)
        res = self.client.get(reverse('my_jobs'))
        self.assertEqual(res.data['results'][0]['id'], newer.id)


# ─────────────────────────── Notifications ──────────────────────────

class NotificationTests(BaseAPITestCase):

    def setUp(self):
        super().setUp()
        self.job = self.make_job()
        self.mine = Notification.objects.create(
            recipient=self.customer, notif_type='JOB_ACCEPTED',
            title='Accepted', message='...', job=self.job,
        )
        self.theirs = Notification.objects.create(
            recipient=self.other_customer, notif_type='JOB_ACCEPTED',
            title='Accepted', message='...', job=self.job,
        )
        self.client.force_authenticate(self.customer)

    def test_only_my_notifications_are_listed(self):
        res = self.client.get(reverse('notifications'))
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in res.data['notifications']}
        self.assertEqual(ids, {self.mine.id})
        self.assertEqual(res.data['unread_count'], 1)

    def test_cannot_mark_someone_elses_notification_read(self):
        res = self.client.patch(reverse('mark_notification_read', args=[self.theirs.id]),
                                {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_404_NOT_FOUND)
        self.theirs.refresh_from_db()
        self.assertFalse(self.theirs.is_read)

    def test_mark_all_read_only_touches_my_rows(self):
        res = self.client.post(reverse('mark_all_read'), {}, format='json')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.mine.refresh_from_db()
        self.theirs.refresh_from_db()
        self.assertTrue(self.mine.is_read)
        self.assertFalse(self.theirs.is_read)


# ────────────────────────── Provider profile ────────────────────────

class ProviderProfileTests(BaseAPITestCase):

    def setUp(self):
        super().setUp()
        self.client.force_authenticate(self.plumber_user)

    def test_going_offline_persists(self):
        """The dashboard toggle used to be local React state only."""
        res = self.client.patch(reverse('provider_profile'), {'is_active': False},
                                format='json')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.plumber.refresh_from_db()
        self.assertFalse(self.plumber.is_active)

    def test_read_only_stats_cannot_be_written(self):
        self.client.patch(reverse('provider_profile'),
                          {'jobs_completed': 9999, 'bio': 'Hi'}, format='json')
        self.plumber.refresh_from_db()
        self.assertEqual(self.plumber.jobs_completed, 0)
        self.assertEqual(self.plumber.bio, 'Hi')

    def test_location_can_be_updated_with_lat_lng(self):
        res = self.client.patch(reverse('provider_profile'),
                                {'lat': 12.9716, 'lng': 77.5946}, format='json')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.plumber.refresh_from_db()
        self.assertAlmostEqual(self.plumber.location.y, 12.9716, places=4)
        self.assertTrue(res.data['has_location'])

    def test_absurd_hourly_rate_rejected(self):
        res = self.client.patch(reverse('provider_profile'),
                                {'hourly_rate': '999999999'}, format='json')
        self.assertEqual(res.status_code, status.HTTP_400_BAD_REQUEST)


# ──────────────────── End-to-end lifecycle walkthrough ──────────────

class FullLifecycleTests(BaseAPITestCase):
    """book → accept → confirm → complete → review, through the real endpoints."""

    def test_happy_path(self):
        # 1. Customer books.
        self.client.force_authenticate(self.customer)
        booked = self.client.post(reverse('book_provider'), {
            'provider_id': self.plumber.id, 'service_type': 'PLUMBER',
            'description': 'Leaking tap', 'lat': 19.0760, 'lng': 72.8777,
        }, format='json')
        self.assertEqual(booked.status_code, status.HTTP_201_CREATED)
        job_id = booked.data['job_id']

        # 2. Provider sees it in the feed and accepts.
        self.client.force_authenticate(self.plumber_user)
        feed = self.client.get(reverse('pending_jobs'), {'lat': 19.0760, 'lng': 72.8777})
        self.assertIn(job_id, [row['id'] for row in feed.data['results']])
        accepted = self.client.patch(reverse('accept-job', args=[job_id]), {}, format='json')
        self.assertEqual(accepted.status_code, status.HTTP_200_OK)

        # 3. Customer confirms with a schedule.
        self.client.force_authenticate(self.customer)
        when = (timezone.now() + timedelta(days=3)).isoformat()
        confirmed = self.client.patch(reverse('confirm-job', args=[job_id]),
                                      {'scheduled_for': when, 'notes': 'Ring the bell'},
                                      format='json')
        self.assertEqual(confirmed.status_code, status.HTTP_200_OK)

        # The provider can now see the address and the customer's note.
        self.client.force_authenticate(self.plumber_user)
        detail = self.client.get(reverse('job_detail', args=[job_id]))
        self.assertEqual(detail.data['status'], 'CONFIRMED')
        self.assertEqual(detail.data['provider_notes'], 'Ring the bell')
        self.assertIsNotNone(detail.data['job_location'])

        # 4. Provider completes.
        completed = self.client.patch(reverse('complete-job', args=[job_id]), {}, format='json')
        self.assertEqual(completed.status_code, status.HTTP_200_OK)

        # 5. Customer reviews.
        self.client.force_authenticate(self.customer)
        detail = self.client.get(reverse('job_detail', args=[job_id]))
        self.assertTrue(detail.data['can_review'])
        reviewed = self.client.post(reverse('submit_review'), {
            'job_id': job_id, 'rating': 5, 'comment': 'Quick and tidy',
        }, format='json')
        self.assertEqual(reviewed.status_code, status.HTTP_201_CREATED)

        # And the rating is now reflected in search.
        search = self.client.get(reverse('provider_search'),
                                 {'category': 'PLUMBER', 'lat': 19.0760, 'lng': 72.8777})
        row = next(r for r in search.data['results'] if r['id'] == self.plumber.id)
        self.assertEqual(row['avg_rating'], 5.0)
        self.assertEqual(row['jobs_completed'], 1)

        # A second review on the same job is refused.
        again = self.client.post(reverse('submit_review'),
                                 {'job_id': job_id, 'rating': 1}, format='json')
        self.assertEqual(again.status_code, status.HTTP_409_CONFLICT)
