#!/usr/bin/env bash
# Build the production image and deploy it to Google Cloud Run.
#
# Merges to main deploy themselves through .github/workflows/deploy.yml once
# CI passes; this script is the manual fallback. Keep the two sets of
# `gcloud run deploy` flags in sync, and never add --ingress to either (the
# spend kill switch stops the site through ingress).
#
# Usage (from the repo root, gcloud signed in, Docker running):
#   GCP_PROJECT=<project-id> scripts/deploy-cloud-run.sh
#
# The three NEXT_PUBLIC_* values must be in the environment: they are inlined
# into the browser bundle at build time (public values, not secrets). Runtime
# secrets live in the Cloud Run service configuration and are left untouched
# by redeploys.
set -euo pipefail

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}" # next to Supabase (AWS us-west-2, Oregon)
SERVICE="govroll"
REPO="govroll"
: "${NEXT_PUBLIC_SUPABASE_URL:?}"
: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?}"
: "${NEXT_PUBLIC_GOOGLE_CLIENT_ID:?}"

TAG="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!scripts' || echo -dirty)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/web:${TAG}"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# Cloud Run runs linux/amd64; build for it explicitly (this Mac is arm64).
docker buildx build \
  --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_SUPABASE_URL \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY \
  --build-arg NEXT_PUBLIC_GOOGLE_CLIENT_ID \
  -t "$IMAGE" \
  --push \
  .

# Request-based billing (CPU only while a request is in flight) keeps a normal
# month inside the free tier. --max-instances caps the cost of a crawler surge;
# --timeout covers the 300s cron routes (ingest workflow curls with 310s).
#
# Public access is a one-time service setting, not a flag here: the
# howellandgibbs.com Workspace org forbids the usual `allUsers` invoker grant
# (domain-restricted sharing), so the service was made public with
# `gcloud run services update govroll --no-invoker-iam-check`, which redeploys
# keep.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --port 8080 \
  --cpu 1 \
  --memory 1Gi \
  --concurrency 40 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 300

echo "Deployed $IMAGE"
