import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const blocked = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) blocked.addSubnet(network, prefix, "ipv6");

function mappedIpv4(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return match?.[1];
}

/** Whether an address is suitable for the default public-web fetch policy. */
export function isPublicAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return isIP(mapped) === 4 && !blocked.check(mapped, "ipv4");

  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return !blocked.check(address, "ipv6");
  return false;
}

const defaultResolver: AddressResolver = async (hostname) =>
  await lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve a destination before fetching and reject special/private networks.
 * Host allowlisting remains a separate first boundary; this closes the common
 * case where an allowed hostname resolves to a local or metadata address.
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  resolver: AddressResolver = defaultResolver,
): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) destinations are permitted.");
  }

  // URL.hostname retains brackets for IPv6 literals; dns.lookup does not accept them.
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily > 0
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);

  if (addresses.length === 0) {
    throw new Error(`Refusing outbound request because '${url.hostname}' did not resolve.`);
  }

  for (const resolved of addresses) {
    if (!isPublicAddress(resolved.address)) {
      throw new Error(
        `Refusing outbound request because '${url.hostname}' resolves to a private or special-use address.`,
      );
    }
  }
}
