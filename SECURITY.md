# Security policy

## Supported versions

Security fixes are made on the latest `main` revision. Operators should update
to the newest release or commit before reporting an issue that may already be
fixed.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository (the
**Security** tab, then **Report a vulnerability**). Do not open a public issue
or include secrets, access tokens, phone numbers, message content, production
addresses, or private keys in logs or screenshots.

Include the affected version/commit, impact, minimal reproduction steps, and
any safe evidence needed to validate the report. Please allow maintainers time
to investigate and coordinate a fix before public disclosure.

## Deployment secrets

Never commit `.env`, API tokens, project-key plaintext, TLS private keys,
pairing artifacts, database files, or release evidence. Use a dedicated,
IP-allowlisted, least-privilege project key for each external consumer.
