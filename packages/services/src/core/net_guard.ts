// Pure SSRF helpers for the URL importer. Kept Electron-free and side-effect-free
// so they unit-test without a network: the main process layers DNS resolution and
// the actual fetch on top (see apps/desktop/src/main/index.ts → assertPublicUrl).

import net from 'node:net';

// True for any IPv4/IPv6 literal in the loopback, private, link-local, or
// unique-local space — the ranges an SSRF would target (including the cloud
// metadata endpoint 169.254.169.254). Unknown/garbage input is treated as
// "not provably public" → false here, but callers reject unresolved hosts
// separately, so a bad string can't slip a fetch through.
export function isPrivateIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').trim();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127) return true;            // this-host / loopback
    if (a === 10) return true;                         // private
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a === 169 && b === 254) return true;           // link-local (cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;        // loopback / unspecified
    if (v.startsWith('fe80')) return true;             // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}

// True for hostnames that resolve to the local machine or an internal network by
// name (before DNS) — these should be refused without even resolving them.
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  );
}
