// Shared by new-database initialization and the first provider settings form.
// Existing configurations and legacy API updates retain their saved cadence.
export const PROVIDER_TIMING_DEFAULTS = Object.freeze({
  timeoutMilliseconds: 8000,
  safetyLagSeconds: 10,
  scanIntervalSeconds: 60,
  activeScanIntervalSeconds: 8,
  maximumSuccessAgeSeconds: 120,
});
