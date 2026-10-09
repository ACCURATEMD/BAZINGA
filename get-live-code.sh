#!/bin/bash
# Saves the BAZINGA code that was live before the 2026-10-09 deploy into
# ~/bazinga-live.zip, taken from the Cloud Run revision that was running then.
# Run it in Cloud Shell:  bash get-live-code.sh [cutoff-time]
#
# It only reads: it lists the service's revisions and Hosting releases, pulls the
# old revision's container image, and copies the app folder out of it. Nothing
# in Cloud Run, Hosting or Firestore is changed. node_modules, the client data
# files (changes*.json, closed_jobs*.json) and anything that looks like a key or
# .env file are left out of the zip.
set -euo pipefail

PROJECT=bazingaopens
REGION=us-central1
SERVICE=bazinga-app
CUTOFF=${1:-2026-10-09T01:16:00Z}   # newest revision created before this
OUT=~/bazinga-live

echo "== Cloud Run revisions (newest first) =="
gcloud run revisions list --service "$SERVICE" --region "$REGION" --project "$PROJECT" \
    --format='table(metadata.name,metadata.creationTimestamp)' --limit=8
echo
echo "== Traffic now =="
gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
    --format='value(status.traffic)' | tr ';' '\n'
echo

echo "== Hosting releases (newest first) =="
TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
    "https://firebasehosting.googleapis.com/v1beta1/sites/$PROJECT/channels/live/releases?pageSize=5" |
    python3 -c '
import json, sys
for r in json.load(sys.stdin).get("releases", []):
    print(r.get("releaseTime", ""), r.get("type", ""), r.get("version", {}).get("name", "").split("/")[-1], r.get("message", ""))
' || echo "(could not list Hosting releases)"
echo

REV=$(gcloud run revisions list --service "$SERVICE" --region "$REGION" --project "$PROJECT" \
    --format='value(metadata.name,metadata.creationTimestamp)' |
    awk -v c="$CUTOFF" '$2 < c' | sort -k2 | tail -1 | awk '{print $1}')
if [ -z "$REV" ]; then echo "No revision was created before $CUTOFF."; exit 1; fi
IMG=$(gcloud run revisions describe "$REV" --region "$REGION" --project "$PROJECT" --format='value(status.imageDigest)')
echo "== Copying the code from $REV =="
echo "$IMG"

gcloud auth configure-docker "${IMG%%/*}" --quiet >/dev/null 2>&1
docker pull -q "$IMG" >/dev/null
CID=$(docker create "$IMG")
WD=""
for d in "$(docker inspect -f '{{.Config.WorkingDir}}' "$IMG")" /app /workspace /usr/src/app; do
    if [ -n "$d" ] && [ "$d" != "/" ] && docker cp "$CID:$d/server.js" - >/dev/null 2>&1; then WD=$d; break; fi
done
if [ -z "$WD" ]; then docker rm "$CID" >/dev/null; echo "Could not find server.js in the image."; exit 1; fi
rm -rf "$OUT" && mkdir -p "$OUT"
docker cp "$CID:$WD/." "$OUT/"
docker rm "$CID" >/dev/null

rm -rf "$OUT/node_modules"
find "$OUT" \( -name 'changes*.json' -o -name 'closed_jobs*.json' -o -iname '*key*.json' \
    -o -iname '*credential*' -o -iname '*service-account*' -o -name '.env*' \) -exec rm -rf {} + 2>/dev/null || true
echo "$REV  $IMG" > "$OUT/LIVE-REVISION.txt"
curl -s "https://$PROJECT.web.app/" -o "$OUT/page-live-now.html" || true

rm -f ~/bazinga-live.zip
(cd ~ && zip -qr bazinga-live.zip bazinga-live)
echo
echo "Files saved:"
(cd "$OUT" && find . -type f | grep -v '/node_modules/' | sort | head -60)
echo
echo "Done: ~/bazinga-live.zip. Download it with:  cloudshell download ~/bazinga-live.zip"
