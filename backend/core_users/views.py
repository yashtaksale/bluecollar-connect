import ipaddress
import logging
from zoneinfo import ZoneInfo

import requests
from django.conf import settings
from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.measure import D
from django.db import transaction
from django.db.models import Avg, Count, F, Q, Window
from django.db.models.functions import RowNumber
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import generics, permissions
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from .models import JobRequest, Notification, Review, ServiceProviderProfile, User
from .permissions import IsCustomer, IsJobParticipant, IsProvider
from .serializers import (
    JobRequestSerializer,
    ProviderProfileSerializer,
    RegisterSerializer,
    UserSerializer,
    validate_lat_lng,
)

logger = logging.getLogger('core_users')

MAX_DESCRIPTION_LENGTH = 2000
MAX_NOTES_LENGTH = 1000
MAX_COMMENT_LENGTH = 2000
SEARCH_RADIUS_KM = 50
MAX_SEARCH_RESULTS = 50
LEAD_RADIUS_BOUNDS = (1.0, 200.0)


def _display_tz():
    return ZoneInfo(settings.DISPLAY_TIME_ZONE)


def _format_schedule(dt):
    """'Tue 14 Oct 2025, 3:30 PM' in the user-facing timezone."""
    return timezone.localtime(dt, _display_tz()).strftime('%a %d %b %Y, %I:%M %p').replace(' 0', ' ')


# ─────────────────────────── Auth ───────────────────────────

class LoginSerializer(TokenObtainPairSerializer):
    """Adds the caller's identity to the token response.

    The frontend needs `role` to decide which dashboard to show. It used to
    infer this from whatever the user had picked on the login form, which
    silently disagreed with the server whenever the two differed.
    """

    def validate(self, attrs):
        data = super().validate(attrs)
        data['user'] = {
            'id': self.user.id,
            'username': self.user.username,
            'email': self.user.email,
            'role': self.user.role,
        }
        return data


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer
    # Credential stuffing protection: 10 attempts/min per IP.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'


class RegisterView(generics.CreateAPIView):
    queryset = User.objects.all()
    serializer_class = RegisterSerializer
    permission_classes = (permissions.AllowAny,)
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'register'


class LogoutView(APIView):
    """
    POST /api/logout/ — blacklist the caller's refresh token.

    Clearing localStorage alone left the refresh token valid for its full 7-day
    lifetime, so a copy taken before logout still worked. With
    `token_blacklist` installed this is a real server-side revocation.

    AllowAny is deliberate: possession of the refresh token *is* the
    authorization, and logout has to work when the access token has already
    expired — which is exactly when a user is most likely to be logging out.
    """

    permission_classes = (permissions.AllowAny,)

    def post(self, request):
        refresh = request.data.get('refresh')
        if not refresh:
            return Response({'error': 'refresh token is required.'}, status=400)
        try:
            RefreshToken(refresh).blacklist()
        except TokenError:
            # Already expired or already blacklisted — the goal is met either way.
            pass
        return Response({'status': 'logged_out'})


class UserProfileView(generics.RetrieveAPIView):
    serializer_class = UserSerializer
    permission_classes = (permissions.IsAuthenticated,)

    def get_object(self):
        return self.request.user


# ────────────────────── Provider search ─────────────────────

class ProviderSearchView(APIView):
    """
    Search active providers in a category, best-rated first.

    Requires authentication: this returns provider names, rates and distance,
    which is exactly the dataset a competitor would want to scrape.
    """

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        category = request.query_params.get('category')
        lat = request.query_params.get('lat')
        lng = request.query_params.get('lng')

        if not all([category, lat, lng]):
            return Response({'error': 'category, lat, and lng are required parameters.'}, status=400)

        valid_categories = dict(ServiceProviderProfile.CATEGORY_CHOICES)
        if category not in valid_categories:
            return Response(
                {'error': f"Unknown category '{category}'. Valid options: {', '.join(valid_categories)}."},
                status=400,
            )

        user_location = validate_lat_lng(lat, lng)   # raises a clean 400

        providers = ServiceProviderProfile.objects.filter(
            category=category,
            is_active=True,
            location__distance_lte=(user_location, D(km=SEARCH_RADIUS_KM)),
        ).select_related('user').annotate(
            distance=Distance('location', user_location),
            # `distinct=True` here averaged the *distinct rating values*, so a
            # provider rated [5,5,5,1] scored 3.0 instead of 4.0. Only one
            # multi-valued join is present, so there is no fan-out to dedupe.
            avg_rating=Avg('reviews__rating'),
            review_count=Count('reviews', distinct=True),
        ).order_by(
            # Postgres sorts NULLs first on DESC, which ranked brand-new
            # providers with no reviews *above* every 5-star provider.
            F('avg_rating').desc(nulls_last=True),
            'distance',
        )[:MAX_SEARCH_RESULTS]

        provider_list = list(providers)
        provider_ids = [p.id for p in provider_list]

        # Top 3 most recent reviews per provider, in one query.
        ranked_reviews = Review.objects.filter(provider_id__in=provider_ids).annotate(
            rn=Window(
                expression=RowNumber(),
                partition_by=[F('provider_id')],
                order_by=F('created_at').desc(),
            )
        )
        top_reviews = Review.objects.filter(
            id__in=ranked_reviews.filter(rn__lte=3).values('id')
        ).select_related('customer').order_by('provider_id', '-created_at')

        reviews_by_provider = {}
        for review in top_reviews:
            reviews_by_provider.setdefault(review.provider_id, []).append({
                'customer': review.customer.username,
                'rating': review.rating,
                'comment': review.comment,
                'date': review.created_at.strftime('%b %d, %Y'),
            })

        results = []
        for rank, p in enumerate(provider_list, start=1):
            avg = round(p.avg_rating, 1) if p.avg_rating else 0.0
            results.append({
                'rank': rank,
                'id': p.id,
                'username': p.user.username,
                'category': p.get_category_display(),
                'bio': p.bio or 'No bio provided.',
                'years_experience': p.years_experience,
                'jobs_completed': p.jobs_completed,
                'avg_rating': avg,
                'review_count': p.review_count,
                'top_rated': avg >= 4.5 and p.review_count >= 1,
                'hourly_rate': str(p.hourly_rate),
                # Distance only. Publishing a provider's exact home coordinates
                # to anyone who can hit this endpoint was a privacy leak.
                # Test `is not None`, not truthiness: Distance(km=0) is falsy, so
                # a provider at the exact search point reported "unknown" instead
                # of 0.0 — the *closest* match was the one that looked broken.
                'distance_km': round(p.distance.km, 2) if p.distance is not None else None,
                'recent_reviews': reviews_by_provider.get(p.id, []),
            })

        return Response({'results': results, 'total': len(results)})


# ──────────────────────── Job lifecycle ─────────────────────

class BookProviderView(APIView):
    """Customer books a specific provider. Creates the PENDING job."""

    permission_classes = (IsCustomer,)
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'booking'

    def post(self, request):
        provider_id = request.data.get('provider_id')
        service_type = request.data.get('service_type')
        description = (request.data.get('description') or '').strip()
        lat = request.data.get('lat')
        lng = request.data.get('lng')

        missing = [
            name for name, value in
            (('provider_id', provider_id), ('service_type', service_type), ('lat', lat), ('lng', lng))
            if value in (None, '')
        ]
        if missing:
            return Response({'error': f"Missing required field(s): {', '.join(missing)}."}, status=400)

        if len(description) > MAX_DESCRIPTION_LENGTH:
            return Response(
                {'error': f'Description must be {MAX_DESCRIPTION_LENGTH} characters or fewer.'},
                status=400,
            )

        if service_type not in dict(ServiceProviderProfile.CATEGORY_CHOICES):
            return Response({'error': f"Unknown service_type '{service_type}'."}, status=400)

        location = validate_lat_lng(lat, lng)

        try:
            provider = ServiceProviderProfile.objects.select_related('user').get(
                id=provider_id, is_active=True
            )
        except (ServiceProviderProfile.DoesNotExist, ValueError, TypeError):
            return Response({'error': 'Provider not found or currently unavailable.'}, status=404)

        # A plumber cannot be booked for an electrical job. Without this check
        # the job was created but never showed up in any provider's lead feed
        # (which filters on the provider's own category), so it silently died.
        if service_type != provider.category:
            return Response(
                {'error': f'{provider.user.username} offers {provider.get_category_display()}, '
                          f'not {dict(ServiceProviderProfile.CATEGORY_CHOICES)[service_type]}.'},
                status=400,
            )

        if provider.user_id == request.user.id:
            return Response({'error': 'You cannot book yourself.'}, status=400)

        duplicate = JobRequest.objects.filter(
            customer=request.user,
            provider=provider,
            status__in=JobRequest.ACTIVE_STATUSES,
        ).first()
        if duplicate:
            return Response(
                {'error': 'You already have an open job with this provider.',
                 'job_id': duplicate.id},
                status=409,
            )

        with transaction.atomic():
            job = JobRequest.objects.create(
                customer=request.user,
                provider=provider,
                service_type=service_type,
                description=description or f'Booking {provider.get_category_display()} service',
                status='PENDING',
                location=location,
                # Snapshot the rate so a later price change can't rewrite history.
                agreed_price=provider.hourly_rate,
            )
            Notification.objects.create(
                recipient=provider.user,
                notif_type='NEW_BOOKING',
                title='New Booking Request! 🎉',
                message=(f'{request.user.username} wants to book your '
                         f'{provider.get_category_display()} service at ₹{provider.hourly_rate}/hr.'),
                job=job,
            )

        return Response({
            'status': 'Booking requested',
            'job_id': job.id,
            'provider': provider.user.username,
            'hourly_rate': str(provider.hourly_rate),
        }, status=201)


class JobDetailView(APIView):
    """GET /api/jobs/<pk>/ — polled by the Job Room to track status."""

    permission_classes = (permissions.IsAuthenticated, IsJobParticipant)

    def get(self, request, pk):
        try:
            job = JobRequest.objects.select_related(
                'customer', 'provider__user', 'cancelled_by'
            ).get(pk=pk)
        except JobRequest.DoesNotExist:
            return Response({'error': 'Job not found.'}, status=404)

        self.check_object_permissions(request, job)

        is_customer = job.customer_id == request.user.id
        provider_data = None
        if job.provider:
            provider_data = {
                'id': job.provider.id,
                'username': job.provider.user.username,
                'category': job.provider.get_category_display(),
                'avg_rating': job.provider.average_rating,
                'total_reviews': job.provider.total_reviews,
                'jobs_completed': job.provider.jobs_completed,
                'hourly_rate': str(job.provider.hourly_rate),
            }

        payload = {
            'id': job.id,
            'status': job.status,
            'status_display': job.get_status_display(),
            'service_type': job.service_type,
            'service_type_display': job.get_service_type_display(),
            'description': job.description,
            'agreed_price': str(job.agreed_price) if job.agreed_price else None,
            'scheduled_for': job.scheduled_for.isoformat() if job.scheduled_for else None,
            'provider': provider_data,
            # The provider had no idea who they were working for.
            'customer': {'username': job.customer.username},
            'has_review': hasattr(job, 'review'),
            'can_review': is_customer and job.status == 'COMPLETED' and not hasattr(job, 'review'),
            'provider_notes': job.provider_notes or '',
            'cancellation_reason': job.cancellation_reason or '',
            'cancelled_by': job.cancelled_by.username if job.cancelled_by else None,
            'created_at': job.created_at.strftime('%b %d, %Y %H:%M'),
            'viewer_role': 'CUSTOMER' if is_customer else 'SERVICE_PROVIDER',
        }

        # The job site's coordinates are the customer's address. Only reveal
        # them to the assigned provider, and only once the job is live.
        if not is_customer and job.status in ('ACCEPTED', 'CONFIRMED', 'COMPLETED') and job.location:
            payload['job_location'] = {'lat': job.location.y, 'lng': job.location.x}

        return Response(payload)


class MyJobsListView(generics.ListAPIView):
    """
    GET /api/jobs/mine/[?status=PENDING] — every job belonging to the caller.

    Without this, a job was only reachable via the URL you happened to be on
    when you created it: navigating away lost it permanently.
    """

    serializer_class = JobRequestSerializer
    permission_classes = (permissions.IsAuthenticated,)

    def get_queryset(self):
        user = self.request.user
        base = JobRequest.objects.select_related('customer', 'provider__user')

        if user.role == 'SERVICE_PROVIDER':
            queryset = base.filter(provider__user=user)
        else:
            queryset = base.filter(customer=user)

        requested = self.request.query_params.get('status')
        if requested:
            wanted = [s.strip().upper() for s in requested.split(',') if s.strip()]
            valid = set(dict(JobRequest.STATUS_CHOICES))
            unknown = [s for s in wanted if s not in valid]
            if unknown:
                # Silently returning everything on a typo hides the bug.
                raise ValidationError({'status': f"Unknown status: {', '.join(unknown)}."})
            queryset = queryset.filter(status__in=wanted)

        return queryset


class PendingJobListView(generics.ListAPIView):
    """GET /api/jobs/pending/ — the provider's live lead feed."""

    serializer_class = JobRequestSerializer
    permission_classes = (IsProvider,)

    def get_queryset(self):
        provider = self.request.provider_profile   # guaranteed by IsProvider
        params = self.request.query_params

        # Prefer the coordinates the client reports (GPS/IP), fall back to the
        # provider's saved working location.
        lat, lng = params.get('lat'), params.get('lng')
        if lat not in (None, '') and lng not in (None, ''):
            origin = validate_lat_lng(lat, lng)
        elif provider.location:
            origin = provider.location
        else:
            # Nothing to measure from — an empty feed beats a 500.
            return JobRequest.objects.none()

        # The category comes from the provider's own profile, never from the
        # query string. Trusting the param let any provider list — and then
        # accept — jobs outside their trade.
        try:
            radius_km = float(params.get('radius', 100))
        except (TypeError, ValueError):
            raise ValidationError({'radius': 'radius must be a number (kilometres).'})
        radius_km = min(max(radius_km, LEAD_RADIUS_BOUNDS[0]), LEAD_RADIUS_BOUNDS[1])

        queryset = JobRequest.objects.select_related('customer', 'provider__user').filter(
            status='PENDING',
            service_type=provider.category,
            location__distance_lte=(origin, D(km=radius_km)),
        ).filter(
            # Broadcast jobs, or jobs booked directly with this provider.
            Q(provider__isnull=True) | Q(provider=provider)
        )

        return queryset.annotate(distance=Distance('location', origin)).order_by('distance')


class AcceptJobView(APIView):
    """Provider claims a PENDING job."""

    permission_classes = (IsProvider,)

    def patch(self, request, pk):
        provider = request.provider_profile

        with transaction.atomic():
            # select_for_update inside the transaction is what makes the
            # status='PENDING' predicate a real guard against double-accept:
            # the second transaction blocks, then re-evaluates and finds nothing.
            job = JobRequest.objects.select_for_update().filter(pk=pk, status='PENDING').first()
            if job is None:
                return Response({'error': 'This job is no longer available.'}, status=409)

            if job.provider_id and job.provider_id != provider.id:
                return Response({'error': 'This job is assigned to another provider.'}, status=403)

            if job.service_type != provider.category:
                return Response(
                    {'error': f'This is a {job.get_service_type_display()} job — '
                              f'you are registered for {provider.get_category_display()}.'},
                    status=403,
                )

            if job.customer_id == request.user.id:
                return Response({'error': 'You cannot accept your own job.'}, status=400)

            job.provider = provider
            job.status = 'ACCEPTED'
            job.save(update_fields=['provider', 'status', 'updated_at'])

            Notification.objects.create(
                recipient=job.customer,
                notif_type='JOB_ACCEPTED',
                title='Provider is Interested! 🙌',
                message=(f'{provider.user.username} is interested in your request. '
                         f'Choose a time to confirm your booking.'),
                job=job,
            )

        return Response({'status': 'Job Accepted', 'job_id': job.id})


class ConfirmJobView(APIView):
    """Customer finalises an ACCEPTED job by picking a time."""

    permission_classes = (IsCustomer,)

    def patch(self, request, pk):
        scheduled_for = request.data.get('scheduled_for')
        notes = (request.data.get('notes') or '').strip()

        if not scheduled_for:
            return Response({'error': 'scheduled_for is required.'}, status=400)

        if len(notes) > MAX_NOTES_LENGTH:
            return Response({'error': f'Notes must be {MAX_NOTES_LENGTH} characters or fewer.'}, status=400)

        parsed = parse_datetime(str(scheduled_for))
        if parsed is None:
            return Response(
                {'error': 'Invalid scheduled_for format. Expected an ISO 8601 datetime.'},
                status=400,
            )

        # <input type="datetime-local"> submits no UTC offset. Previously that
        # naive value was stored as-is under USE_TZ=True, so Django interpreted
        # it as UTC and every appointment was off by the local offset (5h30m for
        # IST). Interpret naive input in the configured display timezone.
        if timezone.is_naive(parsed):
            parsed = timezone.make_aware(parsed, _display_tz())

        if parsed <= timezone.now():
            return Response({'error': 'Please choose a time in the future.'}, status=400)

        with transaction.atomic():
            # No select_related here: `provider` is nullable, so joining it
            # would make Postgres reject "FOR UPDATE ... nullable side of an
            # outer join". The related rows are fetched lazily below.
            job = JobRequest.objects.select_for_update().filter(
                pk=pk, status='ACCEPTED', customer=request.user
            ).first()
            if job is None:
                return Response(
                    {'error': 'This job is not waiting for confirmation. Refresh and try again.'},
                    status=409,
                )

            job.scheduled_for = parsed
            job.provider_notes = notes
            job.status = 'CONFIRMED'
            job.save(update_fields=['scheduled_for', 'provider_notes', 'status', 'updated_at'])

            if job.provider:
                Notification.objects.create(
                    recipient=job.provider.user,
                    notif_type='BOOKING_CONFIRMED',
                    title='Booking Finalized! ✅',
                    # Was interpolating the raw ISO string into user-facing copy.
                    message=(f'{request.user.username} confirmed the booking for '
                             f'{_format_schedule(parsed)}.'),
                    job=job,
                )

        return Response({
            'status': 'Booking Confirmed',
            'job_id': job.id,
            'scheduled_for': parsed.isoformat(),
            'scheduled_for_display': _format_schedule(parsed),
        })


class CompleteJobView(APIView):
    """Provider marks a CONFIRMED job as COMPLETED."""

    permission_classes = (IsProvider,)

    def patch(self, request, pk):
        provider = request.provider_profile

        with transaction.atomic():
            job = JobRequest.objects.select_for_update().filter(
                pk=pk, status='CONFIRMED'
            ).first()
            if job is None:
                return Response(
                    {'error': 'This job is not in a confirmed state.'},
                    status=409,
                )

            if job.provider_id != provider.id:
                return Response({'error': 'You are not assigned to this job.'}, status=403)

            job.status = 'COMPLETED'
            job.save(update_fields=['status', 'updated_at'])

            # Was `provider.jobs_completed += 1; provider.save()` — a
            # read-modify-write that lost increments when a provider completed
            # two jobs at once. F() pushes the arithmetic into the UPDATE.
            ServiceProviderProfile.objects.filter(pk=provider.pk).update(
                jobs_completed=F('jobs_completed') + 1
            )

            Notification.objects.create(
                recipient=job.customer,
                notif_type='JOB_COMPLETED',
                title='Job Completed! 🎊',
                message=(f'{provider.user.username} marked your '
                         f'{job.get_service_type_display()} job as complete. Leave a review!'),
                job=job,
            )

        return Response({
            'status': 'Job Completed',
            'job_id': job.id,
            'message': 'Customer can now leave a review.',
        })


class CancelJobView(APIView):
    """
    PATCH /api/jobs/<pk>/cancel/ — either party withdraws before completion.

    The CANCELLED status existed in the model from the start but nothing could
    ever set it, so a mistaken booking stayed live forever.
    """

    permission_classes = (permissions.IsAuthenticated, IsJobParticipant)

    def patch(self, request, pk):
        reason = (request.data.get('reason') or '').strip()
        if len(reason) > MAX_NOTES_LENGTH:
            return Response({'error': f'Reason must be {MAX_NOTES_LENGTH} characters or fewer.'}, status=400)

        with transaction.atomic():
            job = JobRequest.objects.select_for_update().filter(pk=pk).first()
            if job is None:
                return Response({'error': 'Job not found.'}, status=404)

            self.check_object_permissions(request, job)

            if job.status not in JobRequest.CANCELLABLE_STATUSES:
                return Response(
                    {'error': f'A {job.get_status_display().lower()} job cannot be cancelled.'},
                    status=409,
                )

            is_customer = job.customer_id == request.user.id
            job.status = 'CANCELLED'
            job.cancelled_by = request.user
            job.cancellation_reason = reason
            job.save(update_fields=['status', 'cancelled_by', 'cancellation_reason', 'updated_at'])

            # Tell the other party — whoever that is.
            counterpart = (job.provider.user if job.provider else None) if is_customer else job.customer
            if counterpart and counterpart.id != request.user.id:
                Notification.objects.create(
                    recipient=counterpart,
                    notif_type='JOB_CANCELLED',
                    title='Job Cancelled',
                    message=(f'{request.user.username} cancelled the '
                             f'{job.get_service_type_display()} job'
                             + (f': {reason}' if reason else '.')),
                    job=job,
                )

        return Response({'status': 'Job Cancelled', 'job_id': job.id})


class SubmitReviewView(APIView):
    """Customer reviews a COMPLETED job. One review per job."""

    permission_classes = (IsCustomer,)
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'review'

    def post(self, request):
        job_id = request.data.get('job_id')
        rating = request.data.get('rating')
        comment = (request.data.get('comment') or '').strip()

        if not job_id or rating is None:
            return Response({'error': 'job_id and rating are required.'}, status=400)

        try:
            job_id = int(job_id)
        except (ValueError, TypeError):
            return Response({'error': 'job_id must be a number.'}, status=400)

        try:
            rating = int(rating)
        except (ValueError, TypeError):
            return Response({'error': 'Rating must be an integer between 1 and 5.'}, status=400)
        if not 1 <= rating <= 5:
            return Response({'error': 'Rating must be an integer between 1 and 5.'}, status=400)

        if len(comment) > MAX_COMMENT_LENGTH:
            return Response({'error': f'Comment must be {MAX_COMMENT_LENGTH} characters or fewer.'}, status=400)

        with transaction.atomic():
            # Lock the job so two concurrent submissions can't both pass the
            # "no review yet" check.
            job = JobRequest.objects.select_for_update().filter(pk=job_id).first()
            if job is None:
                return Response({'error': 'Job not found.'}, status=404)

            if job.customer_id != request.user.id:
                return Response({'error': 'Only the customer can leave a review.'}, status=403)

            if job.status != 'COMPLETED':
                return Response({'error': 'Reviews can only be submitted for completed jobs.'}, status=400)

            if not job.provider:
                return Response({'error': 'No provider assigned to this job.'}, status=400)

            if Review.objects.filter(job=job).exists():
                return Response({'error': 'A review has already been submitted for this job.'}, status=409)

            review = Review.objects.create(
                job=job,
                provider=job.provider,
                customer=request.user,
                rating=rating,
                comment=comment,
            )

            Notification.objects.create(
                recipient=job.provider.user,
                notif_type='NEW_REVIEW',
                title=f'New {rating}★ Review! ⭐',
                message=(f'{request.user.username} left a {rating}-star review on your '
                         f'{job.get_service_type_display()} job.'),
                job=job,
            )

        return Response({
            'status': 'Review submitted',
            'review_id': review.id,
            'avg_rating': job.provider.average_rating,
            'total_reviews': job.provider.total_reviews,
        }, status=201)


# ─────────────────────── Provider profile ───────────────────

class ProviderProfileUpdateView(generics.RetrieveUpdateAPIView):
    """
    GET/PATCH /api/provider/profile/ — the logged-in provider's own profile.

    Validation now lives in ProviderProfileSerializer; the previous hand-rolled
    version did unguarded int()/float() casts (500 on bad input) and had no way
    to change `is_active`, which is why the dashboard's Online/Offline toggle
    was purely cosmetic.
    """

    serializer_class = ProviderProfileSerializer
    permission_classes = (IsProvider,)

    def get_object(self):
        return self.request.provider_profile


# ───────────────────────── Notifications ────────────────────

class NotificationListView(APIView):
    """GET /api/notifications/ — the caller's notifications plus unread count."""

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        queryset = Notification.objects.filter(recipient=request.user)
        notifications = list(queryset[:50])
        unread_count = queryset.filter(is_read=False).count()

        now = timezone.now()
        data = [{
            'id': n.id,
            'type': n.notif_type,
            'title': n.title,
            'message': n.message,
            'job_id': n.job_id,
            'is_read': n.is_read,
            'created_at': n.created_at.strftime('%b %d, %Y %H:%M'),
            'time_ago': self._time_ago(n.created_at, now),
        } for n in notifications]

        return Response({'notifications': data, 'unread_count': unread_count})

    @staticmethod
    def _time_ago(dt, now):
        seconds = (now - dt).total_seconds()
        if seconds < 60:
            return 'just now'
        if seconds < 3600:
            return f'{int(seconds // 60)}m ago'
        if seconds < 86400:
            return f'{int(seconds // 3600)}h ago'
        return f'{int(seconds // 86400)}d ago'


class MarkNotificationReadView(APIView):
    """PATCH /api/notifications/<pk>/read/"""

    permission_classes = (permissions.IsAuthenticated,)

    def patch(self, request, pk):
        updated = Notification.objects.filter(
            pk=pk, recipient=request.user, is_read=False
        ).update(is_read=True)
        if not updated and not Notification.objects.filter(pk=pk, recipient=request.user).exists():
            return Response({'error': 'Notification not found.'}, status=404)
        return Response({'status': 'marked_read'})


class MarkAllReadView(APIView):
    """POST /api/notifications/read-all/"""

    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request):
        count = Notification.objects.filter(
            recipient=request.user, is_read=False
        ).update(is_read=True)
        return Response({'status': 'all_read', 'count': count})


# ──────────────────────── Location proxy ────────────────────

class LocationProxyView(APIView):
    """
    GET /api/location/ — coarse IP geolocation, proxied so the browser never
    makes a plaintext third-party request from an HTTPS page.
    """

    permission_classes = (permissions.AllowAny,)
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'location'

    # Only these fields are forwarded to the client.
    ALLOWED_FIELDS = ('status', 'lat', 'lon', 'city', 'regionName', 'country', 'timezone')

    def _client_ip(self, request):
        """
        Resolve a public client IP, or None.

        X-Forwarded-For is attacker-controlled. It was previously interpolated
        straight into the upstream URL; now it must parse as a global (non
        private/loopback/reserved) address before we use it.
        """
        candidates = []
        forwarded = request.META.get('HTTP_X_FORWARDED_FOR')
        if forwarded:
            candidates.extend(part.strip() for part in forwarded.split(','))
        candidates.append(request.META.get('REMOTE_ADDR'))

        for candidate in candidates:
            if not candidate:
                continue
            try:
                ip = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            if ip.is_global:
                return str(ip)
        return None

    def get(self, request):
        client_ip = self._client_ip(request)
        # No IP → ip-api geolocates the *server's* public IP, which is the right
        # behaviour in local dev.
        url = f'https://ip-api.com/json/{client_ip}' if client_ip else 'https://ip-api.com/json/'

        try:
            upstream = requests.get(
                url,
                timeout=5,
                params={'fields': ','.join(self.ALLOWED_FIELDS)},
            )
            upstream.raise_for_status()
            payload = upstream.json()
        except (requests.RequestException, ValueError):
            logger.warning('IP geolocation lookup failed', exc_info=True)
            return Response({'status': 'fail', 'error': 'Failed to fetch location.'}, status=503)

        if not isinstance(payload, dict) or payload.get('status') != 'success':
            return Response({'status': 'fail', 'error': 'Location unavailable.'}, status=503)

        return Response({key: payload.get(key) for key in self.ALLOWED_FIELDS})
