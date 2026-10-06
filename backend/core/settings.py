"""
Django settings for the BlueCollar Connect backend.

Configuration is environment-driven. Nothing secret is committed: every value
that differs between dev and production comes from the environment (or a local
`.env` file — see `.env.example`). The defaults are safe-by-default, so a
missing variable degrades to the *secure* behaviour rather than the convenient
one, and production refuses to boot without an explicit secret key.
"""

from datetime import timedelta
from pathlib import Path

import environ
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DJANGO_DEBUG=(bool, False),
    DJANGO_ALLOWED_HOSTS=(list, []),
    DJANGO_CORS_ALLOWED_ORIGINS=(list, []),
    POSTGRES_DB=(str, 'bluecollar_connect'),
    POSTGRES_USER=(str, 'postgres'),
    POSTGRES_PASSWORD=(str, ''),
    POSTGRES_HOST=(str, 'localhost'),
    POSTGRES_PORT=(str, '5432'),
    ACCESS_TOKEN_MINUTES=(int, 60),
    REFRESH_TOKEN_DAYS=(int, 7),
)

# Optional local overrides. Never commit this file.
env_file = BASE_DIR / '.env'
if env_file.exists():
    environ.Env.read_env(env_file)


# ─────────────────────────── Core ───────────────────────────

DEBUG = env('DJANGO_DEBUG')

# In production a real key MUST be supplied. In development we fall back to a
# throwaway so a fresh clone runs without setup — but the fallback is never
# reachable with DEBUG=False.
SECRET_KEY = env('DJANGO_SECRET_KEY', default='')
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = 'django-insecure-dev-only-do-not-use-in-production'
    else:
        raise ImproperlyConfigured(
            'DJANGO_SECRET_KEY must be set when DEBUG is False. '
            'Generate one with: python -c "from django.core.management.utils '
            'import get_random_secret_key; print(get_random_secret_key())"'
        )

ALLOWED_HOSTS = env('DJANGO_ALLOWED_HOSTS')
if not ALLOWED_HOSTS:
    if DEBUG:
        # Local dev is reached over localhost, the compose service name, and a
        # LAN IP when testing from a phone (see README).
        ALLOWED_HOSTS = ['*']
    else:
        raise ImproperlyConfigured('DJANGO_ALLOWED_HOSTS must be set when DEBUG is False.')


INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.gis',

    # Third-party
    'rest_framework',
    'rest_framework_simplejwt',
    # Enables server-side revocation of refresh tokens on logout / rotation.
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',

    # Local apps
    'core_users',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'


# ───────────────────────── Database ─────────────────────────

DATABASES = {
    'default': {
        'ENGINE': 'django.contrib.gis.db.backends.postgis',
        'NAME': env('POSTGRES_DB'),
        'USER': env('POSTGRES_USER'),
        'PASSWORD': env('POSTGRES_PASSWORD'),
        'HOST': env('POSTGRES_HOST'),
        'PORT': env('POSTGRES_PORT'),
        # Reuse connections instead of reconnecting on every request.
        'CONN_MAX_AGE': 60,
    }
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'


# ─────────────────────── Authentication ─────────────────────

AUTH_USER_MODEL = 'core_users.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

SIMPLE_JWT = {
    # SimpleJWT's default is 5 minutes, which silently ejected users mid-flow.
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=env('ACCESS_TOKEN_MINUTES')),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=env('REFRESH_TOKEN_DAYS')),
    'ROTATE_REFRESH_TOKENS': True,
    # With token_blacklist installed, a rotated or logged-out refresh token is
    # revoked server-side rather than staying valid until natural expiry.
    'BLACKLIST_AFTER_ROTATION': True,
    'UPDATE_LAST_LOGIN': True,
}


# ────────────────────── REST framework ──────────────────────

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    # Deny by default. Endpoints that are genuinely public (register, login,
    # token refresh, IP geolocation) opt in explicitly with AllowAny.
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_THROTTLE_CLASSES': (
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
    ),
    'DEFAULT_THROTTLE_RATES': {
        'anon': '120/hour',
        'user': '2000/hour',
        # Tight scopes for the endpoints worth brute-forcing or abusing.
        'login': '10/min',
        'register': '5/hour',
        'location': '30/hour',
        'booking': '30/hour',
        'review': '20/hour',
    },
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
    'EXCEPTION_HANDLER': 'core_users.exceptions.api_exception_handler',
}


# ──────────────────────────── CORS ──────────────────────────

CORS_ALLOWED_ORIGINS = env('DJANGO_CORS_ALLOWED_ORIGINS')
if not CORS_ALLOWED_ORIGINS and DEBUG:
    CORS_ALLOWED_ORIGINS = [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
    ]
    # Vite served over a LAN IP when testing from a phone.
    CORS_ALLOWED_ORIGIN_REGEXES = [r'^http://192\.168\.\d{1,3}\.\d{1,3}:5173$']

CORS_ALLOW_CREDENTIALS = False


# ──────────────────── Internationalization ──────────────────

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

# Timezone used to interpret naive datetimes submitted by clients (e.g. the
# value of an <input type="datetime-local">, which carries no offset).
DISPLAY_TIME_ZONE = env('DISPLAY_TIME_ZONE', default='Asia/Kolkata')


# ─────────────────────── Static / media ─────────────────────

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_STORAGE = 'whitenoise.storage.CompressedManifestStaticFilesStorage'

MEDIA_URL = 'media/'
MEDIA_ROOT = BASE_DIR / 'media'

# Cap uploads so a large multipart body can't exhaust memory.
DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024   # 5 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024


# ───────────────────── Production hardening ─────────────────

if not DEBUG:
    SECURE_SSL_REDIRECT = env.bool('DJANGO_SECURE_SSL_REDIRECT', default=True)
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = 'same-origin'
    X_FRAME_OPTIONS = 'DENY'


# ────────────────────────── Logging ─────────────────────────

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {name} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'verbose',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
    'loggers': {
        'django.request': {
            'handlers': ['console'],
            'level': 'ERROR',
            'propagate': False,
        },
        'core_users': {
            'handlers': ['console'],
            'level': 'DEBUG' if DEBUG else 'INFO',
            'propagate': False,
        },
    },
}
