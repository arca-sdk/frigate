const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * A go2rtc WebRTC candidate to suggest for this Frigate server: the IPv4
 * address the browser reached it at, which other devices on the network can
 * usually reach too. Undefined for loopback addresses, which only work on the
 * server itself, and for host names, which may not resolve inside the
 * container.
 */
export function suggestedWebRTCCandidate(hostname: string): string | undefined {
  if (!IPV4.test(hostname) || hostname.startsWith("127.")) {
    return undefined;
  }

  return `${hostname}:8555`;
}
