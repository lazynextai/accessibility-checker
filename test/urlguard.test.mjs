// SSRF guard — product twin of platform worker/src/urlguard.ts (monorepo
// PR #127). Mirrors the platform vector set so the two implementations can't
// drift: dotted, IPv4-mapped IPv6, WHATWG-normalized hex, 6to4, NAT64,
// loopback/link-local/ULA/CGNAT/multicast, and internal TLD hostnames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicHttpUrl } from '../src/urlguard.js';

const BLOCKED = [
  // scheme/host that is not http(s)
  'file:///etc/passwd',
  'ftp://example.com/doc',
  'gopher://example.com/x',
  'data:text/html,<x>',
  'javascript:alert(1)',
  // internal hostnames
  'http://localhost/x',
  'http://metadata.internal/latest/meta-data',
  'http://api.internal/query',
  'http://host.local/doc',
  // dotted IPv4
  'http://10.0.0.1/x',
  'http://172.16.5.5/x',
  'http://172.31.255.255/x',
  'http://192.168.1.1/x',
  'http://127.0.0.1/x',
  'http://169.254.169.254/latest/meta-data', // cloud metadata
  'http://100.64.0.1/x', // CGNAT
  'http://224.0.0.1/x', // multicast
  'http://0.0.0.0/x',
  // IPv6
  'http://[::1]/x',
  'http://[fe80::1]/x',
  'http://[fc00::1]/',
  'http://[fd00::1]/',
  'http://[fe90::1]/', // fe80::/10, not just fe80::
  'http://[fec0::1]/',
  'http://[ff02::1]/',
  'http://[::]/',
  // IPv4-mapped IPv6 (metadata vector)
  'http://[::ffff:169.254.169.254]/latest/meta-data', // EC2 metadata via v4-mapped
  'http://[::ffff:10.0.0.1]/x',
  'http://[::ffff:127.0.0.1]/x',
  // WHATWG-normalized hex forms (the URL parser rewrites these before any
  // host check — they must be classified as the metadata/private hosts the
  // dotted forms are)
  'http://[::ffff:a9fe:a9fe]/latest/meta-data', // [::ffff:169.254.169.254]
  'http://[::ffff:7f00:1]/', // [::ffff:127.0.0.1]
  'http://[::ffff:a00:1]/', // [::ffff:10.0.0.1]
  'http://[::a9fe:a9fe]/', // [::169.254.169.254] compatible
  'http://[2002:a9fe:a9fe::]/', // 6to4 embedding
  'http://[64:ff9b::a9fe:a9fe]/', // NAT64 embedding
];

const ALLOWED = [
  'https://example.com/doc.html',
  'http://example.com/plain.txt',
  'https://sub.domain.co.uk/a?b=c#frag',
  'https://checker.lazynext.com/report.html',
  'http://[2606:4700:4700::1111]/', // public IPv6
  'http://[2001:4860:4860::8888]/',
  'http://[::ffff:8.8.8.8]/', // public via v4-mapped
  'http://[2002:0808:0808::]/', // 6to4 of a public IP
  'http://[64:ff9b::808:808]/', // NAT64 of a public IP
];

test('guard blocks private/link-local/metadata/IPv6-embedding hosts', () => {
  for (const url of BLOCKED) {
    assert.equal(isPublicHttpUrl(url), false, url);
  }
});

test('guard accepts public http(s) URLs and public IPv6 embeddings', () => {
  for (const url of ALLOWED) {
    assert.equal(isPublicHttpUrl(url), true, url);
  }
});

test('guard rejects malformed/garbage input without throwing', () => {
  for (const bad of ['', null, undefined, 42, 'not a url', 'http://', 'https://', 'http://[::ffff:', 'http://169.254.256.1/x']) {
    assert.equal(isPublicHttpUrl(bad), false, String(bad));
  }
});