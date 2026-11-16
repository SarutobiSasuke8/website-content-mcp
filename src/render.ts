/**
 * Optional page rendering for sites that build their content with script.
 *
 * Off by default and never required to install or run the server. The default
 * renderer loads `playwright-core` only when a page asks for rendering, drives
 * a browser that is already installed on the machine (Chrome or Edge), uses a
 * fresh profile with no cookies, no logins and no saved state, blocks every
 * request to a host outside the allowlist, and stops at a hard timeout. The
 * caller has already checked the allowlist and robots.txt for the page itself
 * and waits its turn in the per-host rate limit before calling.
 */

export interface RenderRequest {
  url: string;
  timeoutMs: number;
  userAgent: string;
  /** Whether a sub-request (script, data call) may be made. Anything else is aborted. */
  allowRequest: (url: string) => boolean;
}

export interface RenderedPage {
  html: string;
  finalUrl: string;
}

export interface PageRenderer {
  render(request: RenderRequest): Promise<RenderedPage>;
  close?(): Promise<void>;
}

export class RenderUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RenderUnavailableError";
  }
}

// The few parts of the Playwright API that are used, so the dependency stays optional and untyped here.
interface PwRoute { request(): { url(): string; resourceType(): string }; continue(): Promise<void>; abort(): Promise<void> }
interface PwPage { goto(url: string, options: { timeout: number; waitUntil: string }): Promise<unknown>; content(): Promise<string>; url(): string; waitForTimeout(ms: number): Promise<void> }
interface PwContext { route(pattern: string, handler: (route: PwRoute) => Promise<void>): Promise<void>; newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwBrowser { newContext(options: Record<string, unknown>): Promise<PwContext>; close(): Promise<void> }
interface PwModule { chromium: { launch(options: Record<string, unknown>): Promise<PwBrowser> } }

const BLOCKED_TYPES = new Set(["image", "media", "font"]);
const SETTLE_MS = 1_500;

/**
 * A renderer backed by the optional `playwright-core` package and a locally
 * installed Chrome or Edge. Throws {@link RenderUnavailableError} with a plain
 * explanation when either is missing, so the caller can mark the page
 * "rendered content unavailable" instead of storing a broken shell.
 */
export async function createPlaywrightRenderer(): Promise<PageRenderer> {
  const moduleName = "playwright-core";
  let pw: PwModule;
  try {
    pw = (await import(moduleName)) as PwModule;
  } catch {
    throw new RenderUnavailableError("Rendering needs the optional package playwright-core, which is not installed (npm install playwright-core).");
  }
  let browser: PwBrowser | undefined;
  const errors: string[] = [];
  for (const channel of ["chrome", "msedge"]) {
    try {
      browser = await pw.chromium.launch({ channel, headless: true });
      break;
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message.split("\n")[0] ?? "failed" : "failed"}`);
    }
  }
  if (!browser) throw new RenderUnavailableError(`No Chrome or Edge browser could be started (${errors.join("; ")}).`);
  const launched = browser;

  return {
    async render(request) {
      // A new, empty context per page: no cookies, no storage, no saved logins, no service workers, no downloads.
      const context = await launched.newContext({
        userAgent: request.userAgent,
        acceptDownloads: false,
        serviceWorkers: "block",
        javaScriptEnabled: true,
        permissions: [],
        ignoreHTTPSErrors: false,
      });
      try {
        await context.route("**/*", async (route) => {
          const { url, resourceType } = { url: route.request().url(), resourceType: route.request().resourceType() };
          if (BLOCKED_TYPES.has(resourceType) || !request.allowRequest(url)) await route.abort();
          else await route.continue();
        });
        const page = await context.newPage();
        await page.goto(request.url, { timeout: request.timeoutMs, waitUntil: "networkidle" });
        await page.waitForTimeout(SETTLE_MS);
        return { html: await page.content(), finalUrl: page.url() };
      } catch (error) {
        throw new RenderUnavailableError(`The page could not be rendered: ${error instanceof Error ? error.message.split("\n")[0] ?? "unknown error" : "unknown error"}`);
      } finally {
        await context.close().catch(() => undefined);
      }
    },
    async close() {
      await launched.close().catch(() => undefined);
    },
  };
}
