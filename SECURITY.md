# Security policy

## Supported versions

Security fixes are applied to the latest published minor version.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
**Security → Report a vulnerability** flow for this repository. Do not include
credentials, private page content, cookies or access tokens in a public issue.

Useful reports include the affected version, configuration, reproduction steps,
impact and whether a reverse proxy or other network control was present.

## Deployment boundary

This server is designed for public website content and is scoped to configured
hosts. It is not an authentication bypass or general-purpose proxy. Keep the
HTTP transport bound to loopback behind a TLS reverse proxy, apply edge rate
limits, and leave `HTTP_ALLOW_REFRESH=false` for anonymous deployments.

The server respects `robots.txt`, but operators remain responsible for source
terms, applicable law and authorization for any private or authenticated use.
