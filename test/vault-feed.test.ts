import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWatcher } from "../scripts/watcher/run.js";
import { taskText, writeVaultFeed } from "../scripts/watcher/vault.js";
import { parseWatchlist } from "../scripts/watcher/watchlist.js";

import type { FetchRecord } from "../src/types.js";

const page = (price: string, extra = "") => `<html><head><title>Pricing</title></head><body><main><h1>Pricing</h1>
<p>Plans for every team, billed monthly with nothing hidden anywhere on this page at all.</p>
<div><h3>Starter</h3><p>${price} per month</p><a class="btn" href="/go">Start now</a></div>${extra}</main></body></html>`;

class Fetcher {
  public body = page("€49");
  public status = 200;
  public fetch(url: string): Promise<FetchRecord> {
    const fetchedAt = new Date().toISOString();
    if (url.endsWith("/robots.txt")) return Promise.resolve({ url, status: 404, body: "", fetchedAt });
    return Promise.resolve({ url, status: this.status, body: this.status === 200 ? this.body : "", contentType: "text/html", fetchedAt });
  }
}

const watchlist = parseWatchlist([
  { url: "https://rival.test/pricing", label: "Rival pricing", "why-it-matters": "Price anchor.", kind: "competitor", project: "Astraeus Business Solutions" },
]);

const INBOX_HEAD = "---\ntype: task-page\nrole: inbox\n---\n\n# Inbox\n\n- [ ] Existing task #task #inbox [project:: Vault Management]";

async function withVault(run: (ctx: { vault: string; out: string; fetcher: Fetcher }) => Promise<void>, inbox = INBOX_HEAD): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wcm-vault-"));
  try {
    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, "Tasks"), { recursive: true });
    await writeFile(path.join(vault, "Tasks", "Inbox.md"), inbox);
    await run({ vault, out: path.join(root, "out"), fetcher: new Fetcher() });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function twoRuns(fetcher: Fetcher, out: string, change: (fetcher: Fetcher) => void, now = new Date("2026-11-14T08:00:00Z")) {
  const opts = { watchlist, outputDir: out, fetcher, minIntervalMs: 0 };
  await runWatcher(opts);
  change(fetcher);
  return runWatcher({ ...opts, now });
}

void test("a changed run writes one dated append-only note and one task per material change", async () => {
  await withVault(async ({ vault, out, fetcher }) => {
    const run = await twoRuns(fetcher, out, (f) => { f.body = page("€59", '<a class="btn" href="/demo">Book a demo</a>'); });
    const feed = await writeVaultFeed(run, { vaultDir: vault });

    const note = path.join(vault, "Portfolio", "Dev", "MCP Servers", "Watcher Output", "2026-11-14 Watcher Report.md");
    assert.equal(feed.notePath, note);
    const text = await readFile(note, "utf8");
    assert.match(text, /^---\ntype: watcher-report\nmutability: append-only\nrun-date: 2026-11-14\nsource:\n\x20{2}- "https:\/\/rival\.test\/pricing"\n/u);

    const inbox = await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8");
    assert.ok(inbox.startsWith(INBOX_HEAD), "existing inbox content is untouched");
    const added = inbox.slice(INBOX_HEAD.length).split("\n").filter((line) => line.startsWith("- [ ]"));
    assert.equal(added.length, 2, "one price change and one new button");
    for (const line of added) {
      assert.match(line, /#task #inbox$/u);
      assert.match(line, /\[project:: Astraeus Business Solutions\]/u);
      assert.match(line, /\[created:: 2026-11-14\]/u);
      assert.match(line, /\[watcher:: [0-9a-f]{10}\]/u);
      assert.doesNotMatch(line, /#next/u);
    }
    assert.match(inbox, /## Website watcher changes, 2026-11-14\n\nSource: \[\[Portfolio\/Dev\/MCP Servers\/Watcher Output\/2026-11-14 Watcher Report\]\]/u);
    assert.ok(added.some((line) => line.includes("€49/month to €59/month")));
  });
});

void test("nothing is written when no page changed, and the same change is never added twice", async () => {
  await withVault(async ({ vault, out, fetcher }) => {
    const opts = { watchlist, outputDir: out, fetcher, minIntervalMs: 0 };
    const baseline = await runWatcher(opts);
    const quiet = await writeVaultFeed(baseline, { vaultDir: vault });
    assert.equal(quiet.notePath, undefined);
    assert.equal((await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8")), INBOX_HEAD);
    assert.equal(await readdir(path.join(vault, "Portfolio")).catch(() => "absent"), "absent");

    fetcher.body = page("€59");
    const changed = await runWatcher({ ...opts, now: new Date("2026-11-14T08:00:00Z") });
    await writeVaultFeed(changed, { vaultDir: vault });
    const once = await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8");
    const again = await writeVaultFeed(changed, { vaultDir: vault });
    const twice = await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8");
    assert.equal(twice, once, "an already-recorded change adds no duplicate task lines");
    assert.deepEqual(again.tasks, []);
    assert.ok(again.notePath?.endsWith("2026-11-14 Watcher Report 2.md"), "a second note gets a numbered name rather than overwriting");
  });
});

void test("dry run reports what would be written and writes nothing", async () => {
  await withVault(async ({ vault, out, fetcher }) => {
    const run = await twoRuns(fetcher, out, (f) => { f.body = page("€59"); });
    const feed = await writeVaultFeed(run, { vaultDir: vault, dryRun: true });
    assert.ok(feed.messages.some((message) => message.includes("would write")));
    assert.equal(await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8"), INBOX_HEAD);
    assert.deepEqual(await readdir(vault), ["Tasks"]);
  });
});

void test("page removal creates a task; the inbox keeps its CRLF line endings", async () => {
  await withVault(async ({ vault, out, fetcher }) => {
    const run = await twoRuns(fetcher, out, (f) => { f.status = 404; });
    await writeVaultFeed(run, { vaultDir: vault });
    const inbox = await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8");
    assert.match(inbox, /Page removed: it now returns HTTP 404/u);
    assert.ok(!/(?<!\r)\n/u.test(inbox), "every line ending is CRLF");
  }, INBOX_HEAD.replace(/\n/gu, "\r\n") + "\r\n");
});

void test("a folder that does not look like the vault is refused before anything is written", async () => {
  await withVault(async ({ vault, out, fetcher }) => {
    const run = await twoRuns(fetcher, out, (f) => { f.body = page("€59"); });
    const notAVault = path.join(path.dirname(vault), "elsewhere");
    await mkdir(notAVault);
    await assert.rejects(() => writeVaultFeed(run, { vaultDir: notAVault }), /does not look like the vault/u);
    assert.deepEqual(await readdir(notAVault), []);
  });
});

void test("text from a page cannot add tags, fields or links to a task line", async () => {
  assert.equal(taskText("Book now #next [[Evil]] [project:: Gryps]\nsecond line"), "Book now next ((Evil)) (project: Gryps) second line");
  await withVault(async ({ vault, out, fetcher }) => {
    const run = await twoRuns(fetcher, out, (f) => {
      f.body = page("€49", '<a class="btn" href="/x">Buy #next [[Evil]] [project:: Gryps]</a>');
    });
    await writeVaultFeed(run, { vaultDir: vault });
    const inbox = await readFile(path.join(vault, "Tasks", "Inbox.md"), "utf8");
    const task = inbox.split("\n").find((line) => line.includes("Buy next")) ?? "";
    assert.ok(task, "the button change produced a task");
    assert.doesNotMatch(task, /#next|\[\[|\[project:: Gryps\]/u);
    assert.match(task, / #task #inbox$/u);
  });
});

void test("the vault feed never creates or touches Business/Companies", async () => {
  await withVault(async ({ vault, out, fetcher }) => {
    const run = await twoRuns(fetcher, out, (f) => { f.body = page("€59"); });
    await writeVaultFeed(run, { vaultDir: vault });
    assert.equal(await readdir(path.join(vault, "Business")).catch(() => "absent"), "absent");
  });
});
