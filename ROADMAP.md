# Roadmap

## Validation sweep, 2026-10-01

- [x] Repeat the staged candidate's Windows checks: 47 passing tests and 1 opt-in live test skipped before the IPv6 regression was added.
- [x] Run the 26-page owned-site baseline and repeat: no fetch failures; the repeat is unchanged with 1 metadata-only page.
- [x] Classify bracketed IPv6 URL literals without sending them to DNS lookup; cover loopback and mapped private addresses.
- [x] Resolve the packaged dogfood CLI's default configuration relative to its installed module, while keeping custom config and evidence paths relative to the caller.
- [ ] Bind public-address validation to the actual socket connection before claiming protection against hostile DNS rebinding. Current checks are a DNS preflight only; see SECURITY.md.
- [ ] Complete release review and the 30-day operational record. Two runs on one day do not satisfy that gate.

Near-term items for website-content-mcp, roughly in order.

## 1. Publish the MCP Registry entry

`server.json` already declares `io.github.SarutobiSasuke8/website-content-mcp`
against the official registry schema, but the entry has never been published.
The sibling project jobscout-mcp is registered, so the account-level setup is
proven. Remaining work: run `mcp-publisher` against this repo's `server.json`
(the GitHub auth step for `mcp-publisher login` has to be done by the owner).

## 2. Automate registry publish in the release workflow

Once the entry exists, extend `.github/workflows/release.yml` to publish the
updated `server.json` to the MCP Registry after the npm publish succeeds, so
the registry version can never drift from npm. The workflow already verifies
that `server.json` matches `package.json` before publishing.

## 3. Keep the astraeus.ie reference deployment verified

The public read-only reference deployment at `https://mcp.astraeus.ie/mcp` is
live. Keep it in the release verification set and document the public endpoint
as the reference implementation after each deployed package upgrade.

## 4. Complete the owned-site dogfood proof

The repository now includes `npm run dogfood`, a bounded snapshot-and-diff
validation harness, and `docs/dogfood-monitoring.md`. Run the owned-site set for
30 days and retain evidence of meaningful changes, false changes, extraction
failures and decisions influenced before commissioning a production scheduler
or making monitoring claims.
