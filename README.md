# influence-api

The API behind [Influence](https://influence.darkshift.cloud), by Darkshift: the beacon and influencer registry,
live readings from the phone, the seek target ("find Kunal"), a live event stream for the map, and the same actions
as MCP tools. One file, `server.js`, no dependencies (Node 22). Infrared builds it with Paketo buildpacks and runs
`npm start`.

    npm start            # http://localhost:8080

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
