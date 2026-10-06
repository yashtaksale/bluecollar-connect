"""
Project-wide DRF exception handling.

Two jobs:

1. Give every error a consistent shape. The frontend reads `error` first and
   falls back to `detail`; DRF natively returns `detail` for some failures and a
   bare field-error dict for others, so clients had to guess. We normalise to
   always include `error` alongside the original payload.

2. Never leak internals. An unhandled exception previously surfaced as an HTML
   traceback page (DEBUG=True) or a bare 500 with no JSON body, which broke
   client-side error parsing. Now it's logged server-side with full context and
   returned as a plain JSON 500.
"""

import logging

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.http import Http404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

logger = logging.getLogger('core_users')


def _flatten(detail):
    """Turn DRF's nested error structures into one readable sentence."""
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        parts = [_flatten(item) for item in detail]
        return ' '.join(p for p in parts if p)
    if isinstance(detail, dict):
        parts = []
        for field, value in detail.items():
            flat = _flatten(value)
            if not flat:
                continue
            parts.append(flat if field in ('detail', 'non_field_errors') else f'{field}: {flat}')
        return ' | '.join(parts)
    return str(detail)


def api_exception_handler(exc, context):
    # Map a couple of common non-DRF exceptions onto proper API responses
    # instead of letting them become 500s.
    if isinstance(exc, DjangoValidationError):
        return Response(
            {'error': _flatten(getattr(exc, 'message_dict', None) or list(exc.messages))},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if isinstance(exc, IntegrityError):
        logger.warning('IntegrityError in %s: %s', context.get('view'), exc)
        return Response(
            {'error': 'That conflicts with existing data. Please refresh and try again.'},
            status=status.HTTP_409_CONFLICT,
        )

    response = drf_exception_handler(exc, context)

    if response is None:
        # Genuinely unexpected. Log it with the view for triage, tell the client
        # nothing about our internals.
        view = context.get('view')
        request = context.get('request')
        logger.exception(
            'Unhandled exception in %s (%s %s)',
            view.__class__.__name__ if view else 'unknown view',
            getattr(request, 'method', '?'),
            getattr(request, 'path', '?'),
        )
        return Response(
            {'error': 'Something went wrong on our end. Please try again.'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    if isinstance(exc, Http404):
        response.data = {'error': 'Not found.'}
        return response

    if isinstance(response.data, dict):
        # Preserve the original keys (clients may read per-field errors) but
        # guarantee a human-readable `error` is always present.
        if 'error' not in response.data:
            response.data['error'] = _flatten(response.data)
    else:
        response.data = {'error': _flatten(response.data)}

    return response
