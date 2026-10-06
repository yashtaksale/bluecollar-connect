from decimal import Decimal, InvalidOperation

from django.contrib.auth.password_validation import validate_password
from django.contrib.gis.geos import Point
from rest_framework import serializers

from .models import CustomerProfile, JobRequest, Review, ServiceProviderProfile, User

# Rough sanity bounds. Anything outside these is a client bug, not a location.
LAT_RANGE = (-90.0, 90.0)
LNG_RANGE = (-180.0, 180.0)
MAX_HOURLY_RATE = Decimal('100000.00')


def validate_lat_lng(lat, lng):
    """Return a Point, or raise ValidationError. Shared by every geo endpoint."""
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        raise serializers.ValidationError('lat and lng must be numbers.')
    if not (LAT_RANGE[0] <= lat_f <= LAT_RANGE[1]):
        raise serializers.ValidationError(f'lat must be between {LAT_RANGE[0]} and {LAT_RANGE[1]}.')
    if not (LNG_RANGE[0] <= lng_f <= LNG_RANGE[1]):
        raise serializers.ValidationError(f'lng must be between {LNG_RANGE[0]} and {LNG_RANGE[1]}.')
    return Point(lng_f, lat_f, srid=4326)


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'role', 'date_joined')
        read_only_fields = fields


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, required=True, validators=[validate_password])
    role = serializers.ChoiceField(choices=User.ROLE_CHOICES)
    category = serializers.ChoiceField(choices=ServiceProviderProfile.CATEGORY_CHOICES, required=False)
    lat = serializers.FloatField(required=False, allow_null=True)
    lng = serializers.FloatField(required=False, allow_null=True)

    class Meta:
        model = User
        fields = ('username', 'password', 'email', 'role', 'category', 'lat', 'lng')
        extra_kwargs = {
            'email': {'required': True, 'allow_blank': False},
        }

    def validate(self, attrs):
        if attrs.get('role') == 'SERVICE_PROVIDER' and not attrs.get('category'):
            # This used to silently default to PLUMBER, so an electrician who
            # missed the dropdown was registered — and listed — as a plumber.
            raise serializers.ValidationError(
                {'category': 'Service providers must choose a service category.'}
            )

        lat, lng = attrs.get('lat'), attrs.get('lng')
        if (lat is None) != (lng is None):
            raise serializers.ValidationError('lat and lng must be provided together.')
        if lat is not None:
            validate_lat_lng(lat, lng)
        return attrs

    def create(self, validated_data):
        role = validated_data['role']
        category = validated_data.pop('category', None)
        lat = validated_data.pop('lat', None)
        lng = validated_data.pop('lng', None)

        user = User.objects.create_user(
            username=validated_data['username'],
            email=validated_data.get('email', ''),
            password=validated_data['password'],
            role=role,
        )

        if role == 'CUSTOMER':
            CustomerProfile.objects.create(user=user)
        else:
            location = validate_lat_lng(lat, lng) if lat is not None else None
            ServiceProviderProfile.objects.create(
                user=user,
                category=category,
                location=location,
            )
        return user


class ProviderProfileSerializer(serializers.ModelSerializer):
    """
    Read + partial-update of the logged-in provider's own profile.

    Replaces a hand-rolled chain of `if 'field' in request.data` blocks that did
    unguarded `int()` / `float()` casts — a non-numeric value there produced a
    500 rather than a 400.
    """

    lat = serializers.FloatField(write_only=True, required=False, allow_null=True)
    lng = serializers.FloatField(write_only=True, required=False, allow_null=True)

    avg_rating = serializers.FloatField(source='average_rating', read_only=True)
    total_reviews = serializers.IntegerField(read_only=True)
    jobs_completed = serializers.IntegerField(read_only=True)
    category_display = serializers.CharField(source='get_category_display', read_only=True)
    username = serializers.CharField(source='user.username', read_only=True)
    hourly_rate = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal('0.00'))
    has_location = serializers.SerializerMethodField()
    latitude = serializers.SerializerMethodField()
    longitude = serializers.SerializerMethodField()

    class Meta:
        model = ServiceProviderProfile
        fields = (
            'username', 'category', 'category_display', 'bio', 'is_active',
            'years_experience', 'hourly_rate',
            'jobs_completed', 'avg_rating', 'total_reviews',
            'has_location', 'latitude', 'longitude',
            'lat', 'lng',
        )

    def get_has_location(self, obj):
        return obj.location is not None

    def get_latitude(self, obj):
        return obj.location.y if obj.location else None

    def get_longitude(self, obj):
        return obj.location.x if obj.location else None

    def validate_bio(self, value):
        if value and len(value) > 2000:
            raise serializers.ValidationError('Bio must be 2000 characters or fewer.')
        return value

    def validate_years_experience(self, value):
        if value > 70:
            raise serializers.ValidationError('Years of experience looks unrealistic.')
        return value

    def validate_hourly_rate(self, value):
        try:
            value = Decimal(value)
        except (InvalidOperation, TypeError):
            raise serializers.ValidationError('Hourly rate must be a number.')
        if value > MAX_HOURLY_RATE:
            raise serializers.ValidationError(f'Hourly rate must be at most ₹{MAX_HOURLY_RATE}.')
        return value

    def validate(self, attrs):
        lat, lng = attrs.get('lat'), attrs.get('lng')
        if (lat is None) != (lng is None):
            raise serializers.ValidationError('lat and lng must be provided together.')
        return attrs

    def update(self, instance, validated_data):
        lat = validated_data.pop('lat', None)
        lng = validated_data.pop('lng', None)
        if lat is not None and lng is not None:
            instance.location = validate_lat_lng(lat, lng)
        return super().update(instance, validated_data)


class ReviewSerializer(serializers.ModelSerializer):
    customer_username = serializers.CharField(source='customer.username', read_only=True)

    class Meta:
        model = Review
        fields = ('id', 'job', 'provider', 'customer_username', 'rating', 'comment', 'created_at')
        # Every one of these is derived server-side from the job being reviewed.
        read_only_fields = ('id', 'job', 'provider', 'customer_username', 'created_at')


class JobRequestSerializer(serializers.ModelSerializer):
    """
    Read-only projection of a job. Deliberately **not** used for writes: it
        used to be `fields = '__all__'` behind a CreateAPIView, which let a
        client set `status`, `provider`, and `agreed_price` directly.
    Job creation now goes through BookProviderView, which builds the row
    server-side from validated input.
    """

    distance_km = serializers.SerializerMethodField()
    lat = serializers.SerializerMethodField()
    lng = serializers.SerializerMethodField()
    customer_username = serializers.CharField(source='customer.username', read_only=True)
    provider_username = serializers.SerializerMethodField()
    provider_hourly_rate = serializers.SerializerMethodField()
    service_type_display = serializers.CharField(source='get_service_type_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = JobRequest
        fields = (
            'id', 'status', 'status_display', 'service_type', 'service_type_display',
            'description', 'agreed_price', 'scheduled_for', 'provider_notes',
            'cancellation_reason', 'created_at', 'updated_at',
            'customer_username', 'provider_username', 'provider_hourly_rate',
            'lat', 'lng', 'distance_km',
        )
        read_only_fields = fields

    def get_distance_km(self, obj):
        # `distance` is a GeoDjango Distance object from the queryset annotation.
        # The old code declared a plain FloatField named `distance_km` that
        # nothing ever populated, so this was always null.
        distance = getattr(obj, 'distance', None)
        return round(distance.km, 2) if distance is not None else None

    def _may_see_address(self, obj):
        """True for the customer, or the provider once the job is really theirs.

        The customer owns the address, so they always see it. For the provider
        it is not enough to be named on the row: a *direct* booking sets
        `provider` at creation, while the job is still PENDING and they have
        not agreed to anything. Gating on the FK alone therefore handed over
        the customer's home address the moment a lead appeared in the feed —
        and a provider could harvest addresses by never accepting. Release it
        on assignment, matching JobDetailView.
        """
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is None or not user.is_authenticated:
            return False
        if obj.customer_id == user.id:
            return True
        is_assigned = bool(obj.provider_id and obj.provider.user_id == user.id)
        return is_assigned and obj.status in ('ACCEPTED', 'CONFIRMED', 'COMPLETED')

    # A job's coordinates are the customer's home address. The pending-lead
    # feed uses this same serializer, so publishing them unconditionally handed
    # the exact address of every open job to every provider in the radius,
    # before anyone accepted anything. Distance is the signal they actually
    # need; the address is revealed on assignment (see JobDetailView).
    def get_lat(self, obj):
        return obj.location.y if (obj.location and self._may_see_address(obj)) else None

    def get_lng(self, obj):
        return obj.location.x if (obj.location and self._may_see_address(obj)) else None

    def get_provider_username(self, obj):
        return obj.provider.user.username if obj.provider else None

    def get_provider_hourly_rate(self, obj):
        return str(obj.provider.hourly_rate) if obj.provider else None
