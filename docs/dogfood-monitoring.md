# Dogfood monitoring

The repository includes a deliberately small snapshot-and-diff runner for
proving monitoring value without turning the MCP server into a scheduler or
alerting product.

The runner:

- discovers a bounded number of pages per configured site;
- fetches them through the same robots-aware, rate-limited content service;
- stores hashes, validators, extraction quality and warnings, not page bodies;
- labels a first observation as `baseline`, then reports `unchanged` or
  `changed` on later runs;
- writes both JSON evidence and a readable Markdown report.

Run the owned-site proof set from a source checkout:

```bash
npm run dogfood
npm run dogfood
```

The first run establishes baselines. The second proves unchanged-page handling
and conditional revalidation. Local evidence is written beneath
`.dogfood-data/`, which is gitignored.

After version 0.4.0 is published, the packaged CLI can run the bundled owned
site proof set directly:

```bash
npx -y -p @sarutobi-sasuke/website-content-mcp website-content-dogfood
```

Use another configuration or evidence directory when needed:

```bash
npm run dogfood -- --config dogfood/owned-sites.json --data-dir .dogfood-data
```

This is a validation harness, not a production monitor. A production workflow
still needs an external scheduler, durable backup/retention, alert routing,
access policy and a human-review boundary for consequential claims.
