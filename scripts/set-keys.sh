#!/usr/bin/env bash
# Sets (and rotates: run it again) influence-api's two keys as secret env on its zone in save-the-world-org (google-cp-saas-v1), through Infrared's
# API with the token `ir` saved. Run it yourself; it prints no key.
#   WRITE_KEY       makes changes to the registry (influencers, beacons, the demo walk) need it. Goes to your clipboard:
#                   keep it in 1Password, and paste it into /live/#/registry the first time that page asks.
#   PROFILE_SECRET  makes each influencer's own-page key stable across restarts. Nobody needs to know it.
# Readings, "find Kunal", search and the map stay open, so the phone, the glasses and agents need no key.
# The API restarts once with the new values; its profile links change then, so share them after this runs.
set -euo pipefail
config=~/.config/infrared/google-cp-saas-v1.yaml
url=https://infrared.darkshift.io/api/v1/orgs/save-the-world-org/products/influence-api/zones/influence-api-production/env

WK=$(openssl rand -hex 24)
PS=$(openssl rand -hex 32)
export WK PS

# The values travel by environment and pipes only: never an argument, never a file.
jq -n '{env: [{name: "ES_URL", value: "http://elasticsearch.save-the-world-search.svc:9200"}],
        secrets: [{name: "WRITE_KEY", value: env.WK}, {name: "PROFILE_SECRET", value: env.PS}]}' |
  curl -sS --fail-with-body -X PUT -H @<(yq -r '"Authorization: Bearer " + .token' "$config") \
    -H 'content-type: application/json' --data @- "$url" |
  jq '{zone, env: [.env[].name], secrets: [.secrets[]? | .name]}'

printf '%s' "$WK" | pbcopy
unset WK PS
echo "WRITE_KEY is on your clipboard. Save it in 1Password now (for example 'influence-api write key'), before you copy anything else."
