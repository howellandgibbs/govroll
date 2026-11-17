#!/usr/bin/env bash
# Set or rotate the secret env vars on the govroll Cloud Run service.
#
# Usage:  GCP_PROJECT=<project-id> scripts/set-cloud-run-secrets.sh [NAME ...]
#
# Prompts for each value without echoing it, merges the answers into the
# service's existing environment (anything left blank keeps its current
# value), and deploys a new revision. Values never touch shell history or
# command-line arguments.
set -euo pipefail

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
REGION="${GCP_REGION:-us-west1}"
SERVICE="govroll"

if [ "$#" -gt 0 ]; then
  NAMES=("$@")
else
  # Vercel stores these as write-only "sensitive" vars, so they could not be
  # copied over automatically. DATABASE_URL: Supabase > Connect > Transaction
  # pooler (port 6543). DIRECT_URL is only used by the Prisma CLI, not the app.
  NAMES=(DATABASE_URL ANTHROPIC_API_KEY OPENAI_API_KEY RESEND_API_KEY VOYAGE_API_KEY)
fi

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format=json > "$WORK/service.json"

: > "$WORK/answers"
for name in "${NAMES[@]}"; do
  read -r -s -p "$name (blank = keep current): " value
  echo
  if [ -n "$value" ]; then
    printf '%s\0%s\0' "$name" "$value" >> "$WORK/answers"
  fi
done

python3 -I - "$WORK/service.json" "$WORK/answers" "$WORK/env.yaml" <<'EOF'
import json, sys
service, answers, out = sys.argv[1:4]
env = {}
for e in json.load(open(service))["spec"]["template"]["spec"]["containers"][0].get("env", []):
    if "value" in e:
        env[e["name"]] = e["value"]
parts = open(answers, "rb").read().split(b"\0")[:-1]
changed = []
for name, value in zip(parts[::2], parts[1::2]):
    env[name.decode()] = value.decode()
    changed.append(name.decode())
with open(out, "w") as f:
    for k, v in sorted(env.items()):
        f.write(f"{k}: {json.dumps(v)}\n")
print("Updating:", ", ".join(changed) if changed else "(nothing)")
EOF

gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --env-vars-file "$WORK/env.yaml" --quiet
