/**
 * Every user-facing string in the desktop shell, in one place so it can be
 * translated later. The Frigate UI itself comes from each server and is
 * translated there.
 */
export const strings = {
  appName: "Frigate",
  menu: {
    file: "File",
    servers: "Servers",
    window: "Window",
  },
  list: {
    title: "Servers",
    empty: "Add a Frigate server to get started.",
    open: "Open",
    connecting: "Connecting…",
    remove: "Remove",
    removeConfirm: (name: string) =>
      `Remove ${name}? You'll need to sign in again if you add it back.`,
    notEncrypted: "Not encrypted",
    noLogin: "No sign-in required",
    noLoginHint:
      "Anyone who can reach this server can use it. Turn on authentication in Frigate.",
    trustedCertificate: "Trusted certificate",
  },
  add: {
    title: "Add a server",
    urlLabel: "Address",
    urlPlaceholder: "frigate.local or https://frigate.example.com",
    urlHint:
      "An address without a port uses Frigate's sign-in port, 8971. Never use port 5000.",
    nameLabel: "Name",
    namePlaceholder: "Optional",
    submit: "Add server",
    checking: "Checking…",
  },
  rejections: {
    invalid_url: "That isn't a valid address.",
    unsupported_scheme: "The address must start with http:// or https://.",
    internal_port:
      "That's Frigate's internal port, which skips sign-in and gives everyone admin access. Use the sign-in port (8971 by default).",
    not_frigate: "There's no Frigate server at that address.",
    duplicate: "That server is already in the list.",
  },
  redirected: (address: string) =>
    `The server sent the app to ${address}. Add that address instead.`,
  unreachable: (error: string) => `Couldn't connect to the server (${error}).`,
  certificate: {
    untrustedTitle: "This server's certificate isn't trusted by your system",
    untrustedBody:
      "Frigate creates its own certificate unless you give it one. If this is your server, check that the fingerprint matches before trusting it. The app will only accept this exact certificate for this server.",
    changedTitle: "This server's certificate has changed",
    changedBody:
      "The certificate doesn't match the one you trusted before. This happens when Frigate creates a new certificate, but it can also mean someone is intercepting the connection. Only trust it if you know why it changed.",
    fingerprint: "Fingerprint",
    subject: "Issued to",
    issuer: "Issued by",
    validity: "Valid",
    validityRange: (start: string, end: string) => `${start} to ${end}`,
    trust: "Trust this certificate",
    cancel: "Cancel",
    restartRequired:
      "The app already turned this certificate down while the server was open. Restart the app to connect with it.",
    restart: "Restart",
  },
};
