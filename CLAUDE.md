# Claude Notes

## Data Safety

Use synthetic/demo data only. Do not put real patient data or PHI into OpenMRS,
OpenKairo, fixtures, logs, screenshots, audit artifacts, or generated test inputs.

## Live Demo Targets

This repo demos two live targets. Future docs, tests, workflow changes, and manual
validation steps must preserve and verify both flows.

### OpenMRS O2

- Default app URL: `https://o2.openmrs.org/openmrs/login.htm`
- Default username: `admin`
- Default password: `Admin123`
- Default location: `Registration Desk`
- Default concurrency: `1`

Use the OpenMRS O2 Reference Application as the default. OpenMRS O3 may render a
blank SPA and should not be the default target.

### OpenKairo

- Default app URL: `https://ehr-app-five.vercel.app`
- Default username: `reception@demo.com`
- Default password: `Demo123!`
- Default concurrency: `1`

## Verification

Before claiming workflow, docs, or target behavior changes are complete, verify
that both OpenMRS O2 and OpenKairo live demo flows still work with synthetic/demo
data only.
