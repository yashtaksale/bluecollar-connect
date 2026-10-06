# syntax = docker/dockerfile:1.4

ARG PYTHON_VERSION=3.12-slim
FROM python:${PYTHON_VERSION} AS base

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        libpq-dev \
        nodejs \
        npm \
        && rm -rf /var/lib/apt/lists/*

# Create a non-root user
USER root
RUN useradd --create-home --uid 1000 appuser
WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-install-rar --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ /app/backend_source/
WORKDIR /app/backend_source

# Build frontend
COPY frontend/ /app/frontend_source/
WORKDIR /app/frontend_source
RUN npm install && npm run build
WORKDIR /app/backend_source

# Copy built frontend to static directory
RUN mkdir -p /app/frontend_dist && cp -r /app/frontend_source/dist/* /app/frontend_dist/

# Collect static files
RUN python manage.py collectstatic --noinput

# Change to non-root user
USER appuser

EXPOSE 8000

# Default command (can be overridden)
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
