/** Give clients time to reuse a socket between MCP initialise and first calls. */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** Leave one second beyond keepAliveTimeout plus Node 22's default 1-second buffer. */
export const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEP_ALIVE_TIMEOUT_MS + 2_000;
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;
