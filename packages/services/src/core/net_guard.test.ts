import { describe, expect, it } from 'vitest';
import { isPrivateIp, isBlockedHostname } from './net_guard';

describe('isPrivateIp', () => {
  it('flags IPv4 loopback, private, and CGNAT ranges', () => {
    for (const ip of ['127.0.0.1', '127.5.5.5', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it('flags the cloud-metadata link-local address', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it('flags IPv6 loopback, link-local, unique-local, and v4-mapped private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '[::1]']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it('allows public IPv6 and treats non-IP input as not-private', () => {
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost and internal TLDs (case/trailing-dot insensitive)', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', 'db.local', 'svc.internal', 'localhost.']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });

  it('allows ordinary public hostnames', () => {
    for (const h of ['example.com', 'www.medium.com', 'localhostx.com', 'notlocal.org']) {
      expect(isBlockedHostname(h)).toBe(false);
    }
  });
});
