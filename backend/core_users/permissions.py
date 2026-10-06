"""
Role-aware permission classes.

Previously every view only checked `IsAuthenticated`, so a customer could hit
provider endpoints (and vice versa) and got a confusing 400/500 from deep
inside the view instead of a clean 403. These make the role requirement part
of the view's contract.
"""

from rest_framework import permissions

from .models import ServiceProviderProfile


class IsCustomer(permissions.BasePermission):
    """Only users registered as customers."""

    message = 'Only customer accounts can do this.'

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.role == 'CUSTOMER'
        )


class IsProvider(permissions.BasePermission):
    """
    Only users registered as service providers *and* who actually have a
    provider profile — the profile is what every provider endpoint operates on,
    so a missing one is a permission problem, not a 500 waiting to happen.
    """

    message = 'Only service provider accounts with a completed profile can do this.'

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated and user.role == 'SERVICE_PROVIDER'):
            return False
        try:
            # Cached on the request for the view to reuse.
            request.provider_profile = user.provider_profile
        except ServiceProviderProfile.DoesNotExist:
            self.message = 'Your provider profile is missing. Please contact support.'
            return False
        return True


class IsJobParticipant(permissions.BasePermission):
    """Object-level: only the job's customer or its assigned provider."""

    message = 'You do not have permission to view this job.'

    def has_object_permission(self, request, view, obj):
        user = request.user
        if obj.customer_id == user.id:
            return True
        return bool(obj.provider and obj.provider.user_id == user.id)
