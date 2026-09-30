# Verification report: linked-sms-realtime-v1

- GMweb `npm run check`: PASS.
- GMweb `npm test`: PASS, 495 tests, 0 failures.
- GMweb `npm run generate:openapi`: PASS, 127 paths, version 0.19.28.
- PWA `npm --prefix web run build`: PASS.
- GMweb `npm run verify:artifacts`: PASS, API/PWA version 0.19.28.
- Source-order deletion rollback, delayed upload, snapshot propagation:
  PASS in the event-store integration test.
- Android Gradle unit tests and APK build: NOT RUN; no Android SDK is installed
  or configured on this workstation. JDK 21 is available.
- Real dual-SIM send, primary-phone sync, and phone-to-browser latency
  percentiles: NOT VERIFIED. No customer SMS was used as test material.
- Production deployment: NOT RUN.

The user subsequently authorized committing and pushing main and building
Android through a GitHub tag/release workflow. Android CI and real-device
acceptance remain open at the time of this report; their outcomes must be
recorded separately rather than inferred from the GMweb tests.
