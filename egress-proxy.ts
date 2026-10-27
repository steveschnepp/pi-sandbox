import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { domainToASCII } from "node:url";

type ResolvedAddress = { address: string; family: number };
type Destination = { hostname: string; port: number; address: ResolvedAddress };

export type ManagedEgressProxy = {
  port: number;
  token: string;
  auditLogPath: string;
  close: () => Promise<void>;
};

function inCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  const family = isIP(address);
  if (family !== isIP(network)) return false;
  const prefix = Number(prefixText);
  if (family === 4) {
    const toNumber = (value: string) => value.split(".").reduce((sum, part) => (sum << 8n) | BigInt(part), 0n);
    const shift = 32n - BigInt(prefix);
    return (toNumber(address) >> shift) === (toNumber(network) >> shift);
  }
  if (family === 6) {
    const toNumber = (value: string) => {
      let normalized = value.toLowerCase().split("%")[0];
      if (normalized.includes(".")) {
        const separator = normalized.lastIndexOf(":");
        const octets = normalized.slice(separator + 1).split(".").map(Number);
        const high = ((octets[0] << 8) | octets[1]).toString(16);
        const low = ((octets[2] << 8) | octets[3]).toString(16);
        normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
      }
      const halves = normalized.split("::");
      const left = halves[0] ? halves[0].split(":") : [];
      const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
      const expanded = halves.length > 1
        ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
        : left;
      if (expanded.length !== 8) return 0n;
      return expanded.reduce((sum, part) => (sum << 16n) | BigInt(`0x${part || "0"}`), 0n);
    };
    const shift = 128n - BigInt(prefix);
    return (toNumber(address) >> shift) === (toNumber(network) >> shift);
  }
  return false;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const blocked = [
      "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
      "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
      "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    ];
    return !blocked.some((cidr) => inCidr(address, cidr));
  }
  if (family === 6) {
    // Only global-unicast space is eligible. Exclude documentation, unique-local,
    // link-local, multicast, transition, and mapped IPv4 ranges.
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
    return inCidr(normalized, "2000::/3") && ![
      "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20",
    ].some((cidr) => inCidr(normalized, cidr));
  }
  return false;
}

function normalizeHostname(hostname: string): string {
  const ascii = domainToASCII(hostname.replace(/\.$/, "").toLowerCase());
  if (!ascii || ascii.length > 253 || isIP(ascii)) throw new Error("proxy destinations must be DNS hostnames");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(ascii)) {
    throw new Error("invalid DNS hostname");
  }
  return ascii;
}

function allowlistKey(hostname: string, port: number): string {
  return `${hostname}:${port}`;
}

export function parseEgressAllowlist(raw: string): Set<string> {
  const destinations = new Set<string>();
  for (const value of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = value.lastIndexOf(":");
    const hostnameText = separator >= 0 ? value.slice(0, separator) : value;
    const portText = separator >= 0 ? value.slice(separator + 1) : "443";
    if (hostnameText.includes(":") || !/^(?:80|443)$/.test(portText)) {
      throw new Error("allowlist entries must be DNS hostnames with optional :80 or :443 ports");
    }
    const hostname = normalizeHostname(hostnameText);
    destinations.add(allowlistKey(hostname, Number(portText)));
  }
  return destinations;
}

function parseAuthority(authority: string, defaultPort: number): { hostname: string; port: number } {
  const parsed = new URL(`http://${authority}`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("invalid proxy authority");
  }
  return { hostname: normalizeHostname(parsed.hostname), port: Number(parsed.port || defaultPort) };
}

function rejectedStatus(message: string): number {
  if (message === "proxy authentication required") return 407;
  if (message.startsWith("destination DNS lookup failed:") || message === "destination did not resolve to a public address") return 502;
  return 403;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers["proxy-authorization"];
  if (typeof supplied !== "string") return false;
  const expected = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
  const actualBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function cleanRequestHeaders(headers: IncomingMessage["headers"], host: string): Record<string, string | string[] | undefined> {
  const result = { ...headers } as Record<string, string | string[] | undefined>;
  for (const name of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) {
    delete result[name];
  }
  result.host = host;
  return result;
}

async function resolveDestination(
  hostname: string,
  port: number,
  allowlist: Set<string>,
  onDenied?: (hostname: string, port: number) => Promise<boolean>,
): Promise<Destination> {
  if (port !== 80 && port !== 443) throw new Error("proxy permits only ports 80 and 443");
  const key = allowlistKey(hostname, port);
  if (!allowlist.has(key)) {
    const approved = await onDenied?.(hostname, port);
    if (!approved || !allowlist.has(key)) throw new Error("destination hostname and port are not allowlisted");
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`destination DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const address = addresses.find((candidate) => isPublicAddress(candidate.address));
  if (!address) throw new Error("destination did not resolve to a public address");
  return { hostname, port, address };
}

function requestHost(destination: Destination): string {
  return destination.port === 80 || destination.port === 443
    ? destination.hostname
    : `${destination.hostname}:${destination.port}`;
}

export async function startManagedEgressProxy(
  allowlist: Set<string>,
  sessionId: string,
  onDenied?: (hostname: string, port: number) => Promise<boolean>,
): Promise<ManagedEgressProxy> {
  const token = crypto.randomBytes(24).toString("hex");
  const auditLogPath = path.join(os.tmpdir(), `session-${sessionId}-egress-${crypto.randomUUID()}.jsonl`);
  await fs.writeFile(auditLogPath, "", { flag: "wx", mode: 0o600 });
  const sockets = new Set<Socket>();
  const server: Server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const audit = (record: Record<string, unknown>) => {
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`;
    void fs.appendFile(auditLogPath, line, { encoding: "utf8" }).catch(() => undefined);
  };
  const rejectHttp = (response: ServerResponse, status: number, message: string) => {
    response.writeHead(status, { "content-type": "text/plain", connection: "close" });
    response.end(`${message}\n`);
  };

  server.on("request", (request, response) => {
    void (async () => {
      let destination: Destination | undefined;
      let requestedHost: string | undefined;
      let requestedPort: number | undefined;
      let bytesUp = 0;
      let bytesDown = 0;
      let audited = false;
      const finishAudit = (record: Record<string, unknown> = {}) => {
        if (audited) return;
        audited = true;
        audit({ method: request.method, host: destination?.hostname ?? requestedHost, port: destination?.port ?? requestedPort, allowed: Boolean(destination), bytesUp, bytesDown, ...record });
      };
      try {
        if (!isAuthorized(request, token)) throw new Error("proxy authentication required");
        const target = new URL(request.url ?? "");
        if (target.protocol !== "http:" || target.username || target.password) throw new Error("only absolute-form HTTP requests are supported");
        const hostname = normalizeHostname(target.hostname);
        const port = Number(target.port || 80);
        requestedHost = hostname;
        requestedPort = port;
        if (port !== 80) throw new Error("plain HTTP is permitted only on port 80");
        destination = await resolveDestination(hostname, port, allowlist, onDenied);
        const upstream = httpRequest({
          hostname: destination.address.address,
          family: destination.address.family,
          port: destination.port,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: cleanRequestHeaders(request.headers, requestHost(destination)),
        }, (upstreamResponse) => {
          upstreamResponse.on("data", (chunk: Buffer) => { bytesDown += chunk.length; });
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        });
        request.on("data", (chunk: Buffer) => { bytesUp += chunk.length; });
        upstream.on("error", (error) => {
          finishAudit({ allowed: true, error: error.message });
          if (!response.headersSent) rejectHttp(response, 502, "upstream connection failed");
          else response.destroy(error);
        });
        request.pipe(upstream);
        response.once("finish", () => finishAudit({ allowed: true }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishAudit({ allowed: false, reason: message });
        rejectHttp(response, rejectedStatus(message), message);
      }
    })();
  });

  server.on("connect", (request, client, head) => {
    void (async () => {
      let destination: Destination | undefined;
      let requestedHost: string | undefined;
      let requestedPort: number | undefined;
      let upstream: Socket | undefined;
      let bytesUp = head.length;
      let bytesDown = 0;
      let audited = false;
      const finishAudit = (error?: string) => {
        if (audited) return;
        audited = true;
        audit({ method: "CONNECT", host: destination?.hostname ?? requestedHost, port: destination?.port ?? requestedPort, allowed: Boolean(destination), error, bytesUp, bytesDown });
      };
      try {
        if (!isAuthorized(request, token)) throw new Error("proxy authentication required");
        const target = parseAuthority(request.url ?? "", 443);
        requestedHost = target.hostname;
        requestedPort = target.port;
        if (target.port !== 443) throw new Error("CONNECT is permitted only on port 443");
        destination = await resolveDestination(target.hostname, target.port, allowlist, onDenied);
        upstream = connect({ host: destination.address.address, family: destination.address.family, port: destination.port });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream!));
        upstream.once("error", (error) => {
          finishAudit(error.message);
          if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: pi-sandbox\r\n\r\n");
          if (head.length) upstream!.write(head);
          client.on("data", (chunk: Buffer) => { bytesUp += chunk.length; });
          upstream!.on("data", (chunk: Buffer) => { bytesDown += chunk.length; });
          client.pipe(upstream!);
          upstream!.pipe(client);
        });
        client.once("close", () => { finishAudit(); upstream?.destroy(); });
        upstream.once("close", () => { finishAudit(); client.destroy(); });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishAudit(message);
        const status = rejectedStatus(message);
        const statusLine = status === 407 ? "407 Proxy Authentication Required" : status === 502 ? "502 Bad Gateway" : "403 Forbidden";
        if (!client.destroyed) client.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("egress proxy did not bind a TCP port");

  return {
    port: address.port,
    token,
    auditLogPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
