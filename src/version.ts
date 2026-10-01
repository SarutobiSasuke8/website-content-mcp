/**
 * Runtime version advertised over MCP and in the default User-Agent.
 *
 * The release workflow verifies this value against package.json so protocol,
 * package and registry versions cannot silently drift.
 */
export const PACKAGE_VERSION = "0.4.0";
