from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from .views import (
    AcceptJobView,
    BookProviderView,
    CancelJobView,
    CompleteJobView,
    ConfirmJobView,
    JobDetailView,
    LocationProxyView,
    LoginView,
    LogoutView,
    MarkAllReadView,
    MarkNotificationReadView,
    MyJobsListView,
    NotificationListView,
    PendingJobListView,
    ProviderProfileUpdateView,
    ProviderSearchView,
    RegisterView,
    SubmitReviewView,
    UserProfileView,
)

urlpatterns = [
    # ─── Auth ───
    path('register/', RegisterView.as_view(), name='register'),
    path('login/', LoginView.as_view(), name='token_obtain_pair'),
    path('login/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('logout/', LogoutView.as_view(), name='logout'),
    path('user/me/', UserProfileView.as_view(), name='user_profile'),

    # ─── Providers ───
    path('provider/profile/', ProviderProfileUpdateView.as_view(), name='provider_profile'),
    path('search/', ProviderSearchView.as_view(), name='provider_search'),

    # ─── Jobs ───
    path('book/', BookProviderView.as_view(), name='book_provider'),
    path('jobs/mine/', MyJobsListView.as_view(), name='my_jobs'),
    path('jobs/pending/', PendingJobListView.as_view(), name='pending_jobs'),
    path('jobs/<int:pk>/', JobDetailView.as_view(), name='job_detail'),
    path('jobs/<int:pk>/accept/', AcceptJobView.as_view(), name='accept-job'),
    path('jobs/<int:pk>/confirm/', ConfirmJobView.as_view(), name='confirm-job'),
    path('jobs/<int:pk>/complete/', CompleteJobView.as_view(), name='complete-job'),
    path('jobs/<int:pk>/cancel/', CancelJobView.as_view(), name='cancel-job'),

    # NOTE: `jobs/request/` (CreateJobRequestView) was removed. It exposed a
    # ModelSerializer with `fields = '__all__'`, so a client could POST
    # `status: "COMPLETED"` against any provider and then review that fabricated
    # job — unlimited rating manipulation against the app's core ranking signal.
    # Booking now goes exclusively through `book/`, which builds the row
    # server-side.

    # ─── Reviews ───
    path('reviews/', SubmitReviewView.as_view(), name='submit_review'),

    # ─── Notifications ───
    path('notifications/', NotificationListView.as_view(), name='notifications'),
    path('notifications/<int:pk>/read/', MarkNotificationReadView.as_view(), name='mark_notification_read'),
    path('notifications/read-all/', MarkAllReadView.as_view(), name='mark_all_read'),

    # ─── Misc ───
    path('location/', LocationProxyView.as_view(), name='location_proxy'),
]
