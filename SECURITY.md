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

The 0.4.0 candidate resolves and validates all destination addresses before each
request, redirect and retry. A dedicated Undici dispatcher pins socket lookup to
that validated snapshot, preserving the original Host header, TLS SNI and
certificate verification. No second DNS lookup can substitute a private address.
Mixed public/private answers fail closed; DNS waiting shares the request timeout.
Each dispatcher is destroyed after the response body, including failures.

`FETCH_ALLOW_PRIVATE_NETWORK=true` deliberately disables this public-address
boundary for explicitly configured internal sites. Host allowlisting still
applies. Keep private-network egress restrictions as defence in depth: address
classification is not a universal guarantee about unusual network routing,
operator-configured NAT or the trustworthiness of public website content.

The HTTP transport trusts no proxy unless the operator lists one in `HTTP_TRUST_PROXY`, and the client IP is used only for the inbound per-IP request limit, never for access control or any other decision. Write IPv4 trust entries in plain IPv4 form or with a full prefix (advisory GHSA-jqcg-44mw-7w3h in `proxy-addr` concerns short-prefix IPv4-mapped IPv6 subnets). The lockfile resolves `proxy-addr` 2.0.8 and `npm audit --omit=dev` reports no critical advisories.

The server respects `robots.txt`, but operators remain responsible for source
terms, applicable law and authorization for any private or authenticated use.
