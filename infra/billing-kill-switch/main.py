"""Billing kill switch: stop serving govroll once the project costs money.

A Cloud Billing budget publishes the Google Cloud project's month-to-date cost
to a Pub/Sub topic several times a day, and a push subscription delivers each
notification here. When the cost is over COST_LIMIT (dollars, default 0: any
charge at all), this sets the govroll Cloud Run service's ingress to
internal-only. The public site, the govroll.com domain mappings and the run.app
URL all stop answering, so no more request-driven cost can build up.

When a later notification shows the cost back at or under the limit (a new
budget month starts at $0), it reopens ingress, but only if this kill switch
was what closed it: it marks the service with the label `billing-kill-switch`.

Billing data trails real usage by hours, so this bounds the overshoot rather
than guaranteeing exactly $0.

Standard library only, so it runs on the stock python image with no build step
and no stored container image (both of which could cost money themselves).
Deployed by scripts/setup-billing-kill-switch.sh. With DRY_RUN=1 it asks the
Cloud Run API to validate each change without applying it. ENFORCE_FROM
(YYYY-MM-DD) does the same for budget months that start before that date, so
the switch can be installed mid-month without acting on spend from before it.
"""

import base64
import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

TARGET = "https://run.googleapis.com/v2/projects/{}/locations/{}/services/{}".format(
    os.environ["TARGET_PROJECT"],
    os.environ["TARGET_REGION"],
    os.environ["TARGET_SERVICE"],
)
LIMIT = float(os.environ.get("COST_LIMIT", "0"))
DRY_RUN = os.environ.get("DRY_RUN") == "1"
ENFORCE_FROM = os.environ.get("ENFORCE_FROM", "")
LABEL = "billing-kill-switch"
INTERNAL = "INGRESS_TRAFFIC_INTERNAL_ONLY"
PUBLIC = "INGRESS_TRAFFIC_ALL"
TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/"
    "instance/service-accounts/default/token"
)


def log(severity, message, **fields):
    print(json.dumps({"severity": severity, "message": message, **fields}), flush=True)


def access_token():
    req = urllib.request.Request(TOKEN_URL, headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.load(res)["access_token"]


def run_api(method, query="", body=None):
    req = urllib.request.Request(
        TARGET + query,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + access_token(),
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def decide(cost, ingress, labels):
    """Return "stop", "resume" or None for this cost and service state."""
    if cost > LIMIT:
        return "stop" if ingress != INTERNAL else None
    if labels.get(LABEL) == "stopped":
        return "resume"
    return None


def enforcing(notification):
    """False in dry-run mode, or for a budget month before ENFORCE_FROM."""
    if DRY_RUN:
        return False
    start = str(notification.get("costIntervalStart") or "")[:10]
    return not ENFORCE_FROM or start >= ENFORCE_FROM


def apply(service, action, validate_only):
    labels = dict(service.get("labels") or {})
    if action == "stop":
        labels[LABEL] = "stopped"
        service["ingress"] = INTERNAL
    else:
        labels.pop(LABEL, None)
        service["ingress"] = PUBLIC
    service["labels"] = labels
    # The whole service goes back with only these two fields changed, and the
    # update mask limits the write to them. The etag from the read makes the
    # write fail instead of clobbering a deploy that landed in between.
    query = "?updateMask=ingress,labels"
    if validate_only:
        query += "&validateOnly=true"
    run_api("PATCH", query, service)


def handle(notification):
    cost = float(notification["costAmount"])
    live = enforcing(notification)
    service = run_api("GET")
    action = decide(cost, service.get("ingress"), service.get("labels") or {})
    fields = {
        "costAmount": cost,
        "limit": LIMIT,
        "budgetAmount": notification.get("budgetAmount"),
        "costIntervalStart": notification.get("costIntervalStart"),
        "ingress": service.get("ingress"),
        "action": action,
        "dryRun": not live,
    }
    if action is None:
        log("INFO", "cost {:.2f} vs limit {:.2f}: no change".format(cost, LIMIT), **fields)
        return
    apply(service, action, validate_only=not live)
    verb = {"stop": "stopped serving", "resume": "resumed serving"}[action]
    if not live:
        verb = "dry run, validated: would have " + verb
    log("WARNING", "cost {:.2f} vs limit {:.2f}: {}".format(cost, LIMIT, verb), **fields)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            envelope = json.loads(self.rfile.read(length))
            notification = json.loads(base64.b64decode(envelope["message"]["data"]))
            float(notification["costAmount"])
        except Exception as exc:  # noqa: BLE001 - malformed input, not ours to retry
            # Acknowledge it: Pub/Sub would otherwise redeliver it forever.
            log("ERROR", "ignored malformed notification: {!r}".format(exc))
            self.send_response(204)
            self.end_headers()
            return
        try:
            handle(notification)
        except Exception as exc:  # noqa: BLE001 - report and let Pub/Sub retry
            detail = exc.read().decode(errors="replace") if hasattr(exc, "read") else ""
            log("ERROR", "kill switch failed: {!r} {}".format(exc, detail))
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass  # Cloud Run already logs each request.


if __name__ == "__main__":
    log(
        "INFO",
        "billing kill switch ready",
        limit=LIMIT,
        dryRun=DRY_RUN,
        enforceFrom=ENFORCE_FROM,
        target=TARGET,
    )
    HTTPServer(("", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
