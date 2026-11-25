#!/usr/bin/env bash
# Stop serving govroll when the Google Cloud project's monthly cost goes over a
# limit (default $0, i.e. any charge at all).
#
#   Cloud Billing budget --> Pub/Sub topic --> billing-kill-switch (Cloud Run)
#                                               sets govroll's ingress to
#                                               internal-only, and reopens it
#                                               when a new month starts at $0
#
# See infra/billing-kill-switch/main.py. Safe to re-run: it updates what exists.
#
# Usage (from the repo root, gcloud signed in as a project owner who can also
# manage budgets on the billing account):
#   GCP_PROJECT=<project-id> BILLING_ACCOUNT=<billing-account-id> \
#     scripts/setup-billing-kill-switch.sh
# Options: COST_LIMIT=<dollars> (default 0); DRY_RUN=1 to only validate stops
# without applying them; ENFORCE_FROM=YYYY-MM-DD to validate only for budget
# months that start before that date (for installing it mid-month).
#
# The howellandgibbs.com org forbids IAM members outside the domain
# (constraints/iam.allowedPolicyMemberDomains), which includes Cloud Billing's
# publisher billing-budget-alert@system.gserviceaccount.com. Step 3 stops with
# the one-time exception commands if that grant is missing. Grants made during
# an exception stay after the org policy is restored.
#
# Resume by hand before the month ends (the next notification stops it again
# unless COST_LIMIT is raised first):
#   gcloud run services update govroll --region us-west1 --ingress all \
#     --remove-labels billing-kill-switch
set -euo pipefail

PROJECT="${GCP_PROJECT:?Set GCP_PROJECT to the Google Cloud project id}"
BILLING="${BILLING_ACCOUNT:?Set BILLING_ACCOUNT to the billing account id}"
REGION="${GCP_REGION:-us-west1}"
LIMIT="${COST_LIMIT:-0}"
DRY_RUN="${DRY_RUN:-0}"
ENFORCE_FROM="${ENFORCE_FROM:-}"
TARGET="govroll"
NAME="billing-kill-switch"
SA="${NAME}@${PROJECT}.iam.gserviceaccount.com"
SOURCE="$(dirname "$0")/../infra/billing-kill-switch/main.py"

gc() { gcloud --project "$PROJECT" --quiet "$@"; }

gc services enable pubsub.googleapis.com billingbudgets.googleapis.com

# 1. The kill switch's identity. It may read and update only the govroll
#    service, and act as govroll's runtime service account, which Cloud Run
#    checks on every service update. Nothing is granted at the project level.
gc iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gc iam service-accounts create "$NAME" --display-name "Billing kill switch (govroll)"
RUNTIME_SA="$(gc run services describe "$TARGET" --region "$REGION" \
  --format 'value(spec.template.spec.serviceAccountName)')"
gc run services add-iam-policy-binding "$TARGET" --region "$REGION" \
  --member "serviceAccount:$SA" --role roles/run.developer >/dev/null
gc iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null

# 2. The service: the stock python image (no build, nothing stored in Artifact
#    Registry) running main.py, passed in through an env var. Internal ingress
#    plus the IAM check: only Pub/Sub in this project can reach it.
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 -I - "$SOURCE" "$WORK/env.yaml" "$PROJECT" "$REGION" "$TARGET" "$LIMIT" "$DRY_RUN" "$ENFORCE_FROM" <<'EOF'
import datetime, json, sys
source, out, project, region, target, limit, dry_run, enforce_from = sys.argv[1:9]
if enforce_from:
    datetime.date.fromisoformat(enforce_from)  # fail early on a typo
env = {
    "KILL_SWITCH_SOURCE": open(source).read(),
    "TARGET_PROJECT": project,
    "TARGET_REGION": region,
    "TARGET_SERVICE": target,
    "COST_LIMIT": str(float(limit)),
    "DRY_RUN": "1" if dry_run == "1" else "0",
    "ENFORCE_FROM": enforce_from,
}
with open(out, "w") as f:
    for k, v in env.items():
        f.write(f"{k}: {json.dumps(v)}\n")
EOF
gc run deploy "$NAME" --region "$REGION" \
  --image docker.io/library/python:3.12-slim \
  --command python3 \
  --args='-I,-c,import os; exec(os.environ["KILL_SWITCH_SOURCE"])' \
  --env-vars-file "$WORK/env.yaml" \
  --service-account "$SA" \
  --ingress internal \
  --no-allow-unauthenticated \
  --cpu 1 --memory 256Mi --concurrency 1 \
  --min-instances 0 --max-instances 1 --timeout 60
URL="$(gc run services describe "$NAME" --region "$REGION" --format 'value(status.url)')"
gc run services add-iam-policy-binding "$NAME" --region "$REGION" \
  --member "serviceAccount:$SA" --role roles/run.invoker >/dev/null

# 3. Topic, and a push subscription that calls the service as the kill
#    switch's service account. Budgets publish as billing-budget-alert@.
gc pubsub topics describe "$NAME" >/dev/null 2>&1 || gc pubsub topics create "$NAME"
PUBLISHER="billing-budget-alert@system.gserviceaccount.com"
# Never re-write the topic policy once the grant exists: with the org policy
# back in force, any write that still contains the publisher is rejected.
if ! gc pubsub topics get-iam-policy "$NAME" --format json | grep -q "$PUBLISHER"; then
  if ! gc pubsub topics add-iam-policy-binding "$NAME" \
    --member "serviceAccount:$PUBLISHER" --role roles/pubsub.publisher >/dev/null; then
    cat >&2 <<EOF

The org policy rejected $PUBLISHER as the topic's publisher.
As an org policy admin, lift it on this project only, grant, and restore it:

  printf 'name: projects/$PROJECT/policies/iam.allowedPolicyMemberDomains\nspec:\n  rules:\n  - allowAll: true\n' > /tmp/drs-exception.yaml
  gcloud org-policies set-policy /tmp/drs-exception.yaml
  # wait a minute or two for it to take effect, then:
  gcloud pubsub topics add-iam-policy-binding $NAME --project $PROJECT \\
    --member serviceAccount:$PUBLISHER --role roles/pubsub.publisher
  gcloud org-policies delete iam.allowedPolicyMemberDomains --project $PROJECT

Then re-run this script.
EOF
    exit 1
  fi
fi
SUB_ARGS=(--push-endpoint "$URL" --push-auth-service-account "$SA" --ack-deadline 60)
if gc pubsub subscriptions describe "$NAME-push" >/dev/null 2>&1; then
  gc pubsub subscriptions update "$NAME-push" "${SUB_ARGS[@]}"
else
  gc pubsub subscriptions create "$NAME-push" --topic "$NAME" "${SUB_ARGS[@]}"
fi

# 4. The budget, scoped to this project only (the billing account is shared).
#    Cost is net of credits: free-tier usage is applied as a credit, so it must
#    not count. Email alerts go to the billing admins at the first cent.
BUDGET_ARGS=(
  --display-name "govroll kill switch"
  --budget-amount "$(python3 -c "print(max(float('$LIMIT'), 0.01))")USD"
  --calendar-period month
  --credit-types-treatment include-all-credits
  --notifications-rule-pubsub-topic "projects/$PROJECT/topics/$NAME"
  --filter-projects "projects/$PROJECT"
)
BUDGET="$(gcloud billing budgets list --billing-account "$BILLING" \
  --billing-project "$PROJECT" \
  --filter 'displayName="govroll kill switch"' --format 'value(name)' | head -1)"
if [ -n "$BUDGET" ]; then
  gcloud billing budgets update "$BUDGET" --billing-project "$PROJECT" "${BUDGET_ARGS[@]}"
else
  gcloud billing budgets create --billing-account "$BILLING" --billing-project "$PROJECT" \
    "${BUDGET_ARGS[@]}" --threshold-rule percent=1.0
fi

echo "Kill switch ready: limit \$$LIMIT, dry run $DRY_RUN, $URL"
