# Roadmap

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

## 3. Deployed reference instance for astraeus.ie

Stand up a public reference deployment serving `https://astraeus.ie` using
`deploy/website-content-mcp@.service` and `deploy/nginx.conf.example`, and run
the verification checklist in `docs/production-deployment.md` end to end
against it. This gives the README a live, linkable example instance.

## 4. Document pairing with a scheduler/snapshot workflow

The README names scheduling, snapshots, diffs and alerts as out of scope: this
server is the content-access layer only. Add a short guide (or example repo)
showing how to pair it with a scheduler and snapshot store to build the
monitoring workflows the README alludes to, without widening this server's own
scope.
