from django.contrib import admin
from .models import User, CustomerProfile, ServiceProviderProfile, WorkGalleryImage, JobRequest, Review

@admin.register(User)
class UserAdmin(admin.ModelAdmin):
    list_display = ('username', 'email', 'role')
    list_filter = ('role',)

@admin.register(ServiceProviderProfile)
class ServiceProviderProfileAdmin(admin.ModelAdmin):
    list_display = ('user', 'category', 'is_active', 'jobs_completed', 'years_experience')
    list_filter = ('category', 'is_active')

@admin.register(JobRequest)
class JobRequestAdmin(admin.ModelAdmin):
    list_display = ('id', 'service_type', 'status', 'customer', 'provider', 'agreed_price', 'created_at')
    list_filter = ('status', 'service_type')

@admin.register(Review)
class ReviewAdmin(admin.ModelAdmin):
    list_display = ('job', 'provider', 'customer', 'rating', 'created_at')
    list_filter = ('rating',)

admin.site.register(CustomerProfile)
admin.site.register(WorkGalleryImage)
