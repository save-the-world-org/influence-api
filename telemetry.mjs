// Telemetry, loaded before the server (`node --import ./telemetry.mjs server.js`): OpenTelemetry's Node
// auto-instrumentation sends traces and metrics over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set (the zone sets
// Dash0's, with its token in OTEL_EXPORTER_OTLP_HEADERS as a secret), and nothing happens otherwise, so a local run
// needs no collector. A failure here never stops the API: it starts without telemetry and says so.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== 'true') {
  try {
    await import('@opentelemetry/auto-instrumentations-node/register')
    console.log(`telemetry on: ${process.env.OTEL_SERVICE_NAME || 'influence-api'} to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`)
  } catch (e) {
    console.warn(`telemetry off: ${e.message}`)
  }
}
