# Instrumentation and dashboards

Every pull request that adds or changes a route, a feature or a background job must also:

1. **Trace it.** The new code path runs inside an OpenTelemetry span with a stable, lower-case name that says what it
   does (`influence.find`, `influence.reading.ingest`), with the attributes a person would filter by (the influencer's
   id, the beacon's hardware id, the seeker id) and never a secret, a key or a person's email address.
2. **Measure its outcome.** A counter for how often it happens and how often it fails, and a histogram for how long it
   takes when time matters, named `influence_<what>_<unit>` (`influence_readings_total`,
   `influence_find_duration_seconds`).
3. **Show it.** Change the Product's dashboard file in `dashboards/` (Perses YAML, which Dash0 reads) in the same pull
   request: a panel for each new measure, beside the panels it relates to.
4. **Log what a person needs at 3 a.m.** One structured line per failure with the span's trace id, never one per success.

A pull request that adds behaviour without these is not ready: say which of the four is missing and what to add.
