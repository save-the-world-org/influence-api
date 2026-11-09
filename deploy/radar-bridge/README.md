# Radar bridge

Turns each Hero Goggles distance alert into a Kubernetes Event on `deployment/influence-api` in
`influence-api-production`, so Skyhook Radar's timeline shows it. One manifest, `radar-bridge.yaml`:

- in `save-the-world-radar`: the ServiceAccount `radar-bridge`, the ConfigMap `radar-bridge` holding `bridge.mjs`,
  and a one-replica Deployment running it on `node:22-alpine` (requests 20m and 64Mi, limit 128Mi);
- in `influence-api-production`: the Role `radar-bridge-events` (`create` and `patch` on `events`, core and
  `events.k8s.io`) and its RoleBinding to that ServiceAccount.

`bridge.mjs` polls `GET ${API}/api/alerts?limit=20` every 2 s, with `API=https://influence-api.darkshift.cloud` (the
org's network fence blocks the in-cluster Service from this namespace). Each alert it has not seen becomes a core/v1
Event through `https://kubernetes.default.svc` with the mounted token and CA: reason `HeroCloser`, `HeroFound`,
`HeroFarther` or `HeroLost`, type `Warning` for lost and `Normal` otherwise, the alert's message plus
" (seeker <id>)", source `influence-radar-bridge`. Each Event is named after its alert, so a post repeated after a
restart is a 409, never a second Event, and a restart skips alerts from over a minute before it started. After every
poll it posts `{mirrored, lastEvent}` to `POST ${API}/api/integrations/radar`, which `GET /api/integrations` shows to
`/live/`. Errors only log.

## Apply

    kubectl --context google-cp-saas-v1 apply -f deploy/radar-bridge/radar-bridge.yaml
    kubectl --context google-cp-saas-v1 -n save-the-world-radar logs deploy/radar-bridge -f
    kubectl --context google-cp-saas-v1 -n influence-api-production get events --field-selector source=influence-radar-bridge

It needs: both namespaces to exist already (the manifest creates neither); egress from `save-the-world-radar` to
`influence-api.darkshift.cloud:443` and to the Kubernetes API; `node:22-alpine` pullable from Docker Hub; and an
influence-api with `GET /api/alerts`. Without the alerts route the bridge only logs a 404 every 2 s.

## Remove

    kubectl --context google-cp-saas-v1 delete -f deploy/radar-bridge/radar-bridge.yaml
