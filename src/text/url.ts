// SPDX-License-Identifier: AGPL-3.0-or-later

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ALPHABETIC_TLD = /^[a-z]{2,}$/;
const MAX_HOST_CHARS = 253;
const MAX_LABEL_CHARS = 63;

/**
 * Whether Discord will take a link button to this host. Discord answers 400 for a host without a real top-level domain
 * (`https://mysite`, `https://example`, `https://a.b`), so only an IPv4 literal or a dotted name of lower-case
 * `[a-z0-9-]` labels ending in a letters-only label of two or more letters (or a punycode `xn--` label) passes.
 * `hostname` is `URL.hostname`, which is already lower-cased and punycoded.
 */
export function hasDeliverableHost(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOST_CHARS) return false;
  const octets = IPV4.exec(hostname);
  if (octets !== null) return octets.every((part, i) => i === 0 || Number(part) <= 255);
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length > MAX_LABEL_CHARS || !LABEL.test(label)) return false;
  }
  const last = labels[labels.length - 1]!;
  return ALPHABETIC_TLD.test(last) || (last.startsWith('xn--') && last.length > 4);
}
