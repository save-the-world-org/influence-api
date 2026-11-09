# influence-api

The API behind [Hero Goggles](https://hero-goggles.darkshift.cloud) (formerly Influence), by Darkshift: the beacon and influencer registry,
live readings from the phone, the seek target ("find Kunal"), a live event stream for the map, and the same actions
as MCP tools. One file, `server.js`, no dependencies (Node 22). Infrared builds it with Paketo buildpacks and runs
`npm start`.

    npm start            # http://localhost:8080
    npm test             # node --test: server.js as real processes, restarted against a fake Elasticsearch, and with none

| Route | What |
|---|---|
| `GET /healthz` | ok, the version, whether Elasticsearch is set |
| `GET /api/state` | everything the map draws: influencers, beacons with their last reading and estimated position, seekers, targets |
| `GET /api/events` | the same as Server-Sent Events, `event: state`, on every change |
| `GET, POST /api/influencers`, `PUT, DELETE /api/influencers/:id` | the registry; an influencer edits their own profile with their profile key |
| `GET, POST /api/beacons`, `PUT, DELETE /api/beacons/:id` | beacons, each mapped to an influencer or to nobody (`influencerId: null`) |
| `POST /api/readings` | from the phone: `{seekerId, beaconId or hardwareId, distance, azimuthDeg, heading, lat, lon}` |
| `POST /api/seekers/:id` | a phone's GPS position and compass heading |
| `GET, PUT, DELETE /api/target?seeker=phone` | who the phone seeks: `PUT {"name": "Kunal"}` |
| `GET /api/search?q=` | search, on Elasticsearch when `ES_URL` is set |
| `POST /api/demo` | `{"on": true}` walks made-up readings around the venue |
| `POST /mcp` | MCP over streamable HTTP (stateless): `find_influencer`, `where_is`, `list_influencers`, `search`, `register_*`, `map_beacon` |

Settings, all optional: `WRITE_KEY` (registry writes need `Authorization: Bearer <key>` when set), `PROFILE_SECRET`
(derives each influencer's profile key), `ES_URL` and `ES_AUTH` (Elasticsearch).

## State

With `ES_URL` set, what the map and the phone need survives a deploy or a restart:

- **The registry**, influencers and beacons, in the indices `influence-influencers` and `influence-beacons`: written on
  every change, loaded at start.
- **The seek targets**, who each seeker is finding, in `seek-targets`, one document per seeker id: written when set,
  deleted when cleared, loaded at start after the registry. The index sits outside the `influence-*` and `kubecon-*`
  patterns search runs over, so a target never shows up as a result.
- **The seed**, `registry.seed.json` in git: the hackathon's influencers and beacons (registry fields only, never a
  key). At start it fills only those Elasticsearch does not have, so a restart never undoes an influencer's own edits.

Writes to one document go out in the order they were made, and a SIGTERM waits for those still on their way. A write
that fails is logged and never fails the request; with Elasticsearch unreachable at start, the API starts on the seed
and says so. Readings and each seeker's position stay in memory only: the phone sends readings twice a second, so fresh
ones arrive within a second of a restart. Without `ES_URL` everything lives in memory, and a restart starts from the
seed.

## Keys

`scripts/set-keys.sh` sets `WRITE_KEY` and `PROFILE_SECRET` on the zone as secret env through Infrared's API, with the
token `ir` saved for google-cp-saas-v1, and prints neither. Only `WRITE_KEY` goes to the clipboard, for 1Password and for
the registry page. Running it again rotates both. The API restarts once with the new values, and each influencer's
profile link changes, so share the links again. The workspace's `accounts/infrared-google-cp-saas-v1.yaml` records both
and when they are due.

## Telemetry

`telemetry.mjs` loads OpenTelemetry's Node auto-instrumentation before the server when `OTEL_EXPORTER_OTLP_ENDPOINT` is
set: every request becomes a trace, with HTTP metrics, sent over OTLP. On google-cp-saas-v1 the zone sends to Dash0
(region us-west-2, dataset `default`): plain env `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_PROTOCOL` and the exporters, and the token in the secret `OTEL_EXPORTER_OTLP_HEADERS`, never in git.
Without the endpoint nothing is loaded.
