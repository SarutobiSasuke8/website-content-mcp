import type { ContentService } from "./service.js";

/**
 * Periodically refresh bounded windows of discoverable pages for HTTP search.
 * A cursor prevents every pass from revisiting only the first `limit` pages.
 */
export class HttpRefreshScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private offset = 0;

  public constructor(
    private readonly service: ContentService,
    private readonly limit: number,
    private readonly intervalMs: number,
    private readonly log: (message: string) => void = (message) => process.stdout.write(`${message}\n`),
  ) {}

  public start(): void {
    if (this.limit <= 0) return;
    void this.run("Startup");
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.run("Scheduled"), this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async run(label: string): Promise<void> {
    if (this.running) {
      this.log(`${label} cache refresh skipped: previous pass is still running`);
      return;
    }
    this.running = true;
    try {
      const result = await this.service.refresh(this.limit, false, this.offset);
      const failed = result.failed.length;
      this.log(
        `${label} cache refresh complete: requested=${result.requested} fetched=${result.fetched} revalidated=${result.revalidated} skipped=${result.skipped} failed=${failed} last_refresh_at=${this.service.lastRefreshAt ?? "unknown"}`,
      );
      this.offset = result.requested < this.limit ? 0 : this.offset + this.limit;
    } catch (error) {
      this.log(`${label} cache refresh failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.running = false;
    }
  }
}
