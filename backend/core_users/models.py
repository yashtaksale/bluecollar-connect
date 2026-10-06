from django.contrib.auth.models import AbstractUser
from django.contrib.gis.db import models

class User(AbstractUser):
    ROLE_CHOICES = (
        ('CUSTOMER', 'Customer'),
        ('SERVICE_PROVIDER', 'Service Provider'),
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES)

    def __str__(self):
        return f"{self.username} - {self.get_role_display()}"

class CustomerProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='customer_profile')
    # Additional customer fields like default location can be added here
    
    def __str__(self):
        return f"Customer: {self.user.username}"

class ServiceProviderProfile(models.Model):
    CATEGORY_CHOICES = (
        ('PLUMBER', 'Plumber'),
        ('PAINTER', 'Painter'),
        ('ELECTRICIAN', 'Electrician'),
        ('CLEANING', 'Cleaning'),
        ('APPLIANCE_REPAIR', 'Appliance Repair'),
        ('PEST_CONTROL', 'Pest Control'),
    )
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='provider_profile')
    category = models.CharField(max_length=50, choices=CATEGORY_CHOICES)
    bio = models.TextField(blank=True, null=True)
    is_active = models.BooleanField(default=True)
    location = models.PointField(null=True, blank=True, srid=4326)
    years_experience = models.PositiveIntegerField(default=0)
    jobs_completed = models.PositiveIntegerField(default=0)
    hourly_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0.00)

    @property
    def average_rating(self):
        from django.db.models import Avg
        avg = self.reviews.aggregate(avg=Avg('rating'))['avg']
        return round(avg, 1) if avg else 0.0

    @property
    def total_reviews(self):
        return self.reviews.count()

    class Meta:
        indexes = [
            # Provider search always filters on both of these.
            models.Index(fields=['category', 'is_active'], name='provider_cat_active_idx'),
        ]

    def __str__(self):
        return f"Provider: {self.user.username} - {self.get_category_display()}"

class WorkGalleryImage(models.Model):
    provider = models.ForeignKey(ServiceProviderProfile, on_delete=models.CASCADE, related_name='gallery_images')
    image = models.ImageField(upload_to='work_gallery/')
    caption = models.CharField(max_length=255, blank=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"Gallery Image for {self.provider.user.username}"


class JobRequest(models.Model):
    STATUS_CHOICES = (
        ('PENDING', 'Pending (Request Sent)'),
        ('ACCEPTED', 'Accepted (Provider Interested)'),
        ('CONFIRMED', 'Confirmed (Scheduled)'),
        ('COMPLETED', 'Completed'),
        ('CANCELLED', 'Cancelled'),
    )
    # Statuses a job can still be cancelled from.
    CANCELLABLE_STATUSES = ('PENDING', 'ACCEPTED', 'CONFIRMED')
    # Statuses that count as "this customer already has a live job with this
    # provider" — used to reject duplicate bookings.
    ACTIVE_STATUSES = ('PENDING', 'ACCEPTED', 'CONFIRMED')

    customer = models.ForeignKey(User, on_delete=models.CASCADE, related_name='requested_jobs')
    provider = models.ForeignKey(ServiceProviderProfile, null=True, blank=True, on_delete=models.SET_NULL, related_name='assigned_jobs')
    service_type = models.CharField(max_length=50, choices=ServiceProviderProfile.CATEGORY_CHOICES)
    description = models.TextField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='PENDING')
    agreed_price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    location = models.PointField(srid=4326)
    scheduled_for = models.DateTimeField(null=True, blank=True)
    provider_notes = models.TextField(blank=True, null=True)
    cancelled_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name='cancelled_jobs',
        help_text='Who cancelled the job, when status is CANCELLED.',
    )
    cancellation_reason = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # A deterministic default order — required for stable pagination, and
        # newest-first is what every list in the UI wants anyway.
        ordering = ['-created_at']
        indexes = [
            # The lead feed filters on status + service_type on every poll.
            models.Index(fields=['status', 'service_type'], name='job_status_service_idx'),
            models.Index(fields=['customer', '-created_at'], name='job_customer_recent_idx'),
            models.Index(fields=['provider', '-created_at'], name='job_provider_recent_idx'),
        ]

    def __str__(self):
        return f"Job {self.id} - {self.service_type} ({self.status})"



class Review(models.Model):
    """OneToOne with JobRequest — review can only be submitted after job is COMPLETED."""
    job = models.OneToOneField(JobRequest, on_delete=models.CASCADE, related_name='review')
    provider = models.ForeignKey(ServiceProviderProfile, on_delete=models.CASCADE, related_name='reviews')
    customer = models.ForeignKey(User, on_delete=models.CASCADE, related_name='given_reviews')
    rating = models.PositiveSmallIntegerField()  # 1-5
    comment = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Review {self.rating}★ for {self.provider.user.username} by {self.customer.username}"


class Notification(models.Model):
    NOTIF_TYPES = (
        ('NEW_BOOKING',    'New Booking Request'),
        ('JOB_ACCEPTED',   'Job Accepted'),
        ('BOOKING_CONFIRMED', 'Booking Confirmed'),
        ('JOB_COMPLETED',  'Job Completed'),
        ('JOB_CANCELLED',  'Job Cancelled'),
        ('NEW_REVIEW',     'New Review'),
    )
    recipient = models.ForeignKey(User, on_delete=models.CASCADE, related_name='notifications')
    notif_type = models.CharField(max_length=20, choices=NOTIF_TYPES)
    title = models.CharField(max_length=200)
    message = models.TextField()
    job = models.ForeignKey(JobRequest, null=True, blank=True, on_delete=models.CASCADE, related_name='notifications')
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            # The bell polls "my unread notifications" every 5 seconds.
            models.Index(fields=['recipient', 'is_read'], name='notif_recipient_read_idx'),
        ]

    def __str__(self):
        return f"[{self.notif_type}] → {self.recipient.username}: {self.title}"
