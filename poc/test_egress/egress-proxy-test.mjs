import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { parseEgressAllowlist, startManagedEgressProxy } from "../../egress-proxy.ts";

function httpProbe(port, token, target, authorized = true) {
  return new Promise((resolve, reject) => {
    const headers = { Host: new URL(target).host };
    if (authorized) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: target,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end();
  });
}

function connectProbe(port, token, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    socket.setTimeout(3000, () => socket.destroy(new Error("CONNECT probe timed out")));
    socket.on("connect", () => socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`${token}:`).toString("base64")}\r\n\r\n`,
    ));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks).toString();
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", (error) => {
      if (error.code === "ECONNRESET" && chunks.length) {
        resolve(Buffer.concat(chunks).toString());
      } else {
        reject(error);
      }
    });
  });
}

async function waitForAudit(path, count) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const text = await fs.readFile(path, "utf8");
    const records = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (records.length >= count) return records;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${count} audit records`);
}

const allowlist = parseEgressAllowlist("Example.COM.,example.com");
assert.deepEqual([...allowlist], ["example.com"]);
assert.throws(() => parseEgressAllowlist("127.0.0.1"), /DNS hostnames/);

const proxy = await startManagedEgressProxy(parseEgressAllowlist("allowed.example"), `poc-${process.pid}`);
try {
  const unauthenticated = await httpProbe(proxy.port, proxy.token, "http://allowed.example/", false);
  assert.equal(unauthenticated.status, 407, "proxy must require authentication");

  const deniedHost = await httpProbe(proxy.port, proxy.token, "http://blocked.example/");
  assert.equal(deniedHost.status, 403, "non-allowlisted host must be rejected");
  assert.match(deniedHost.body, /not allowlisted/);

  const deniedIp = await httpProbe(proxy.port, proxy.token, "http://127.0.0.1/");
  assert.equal(deniedIp.status, 403, "IP-literal destinations must be rejected");
  assert.match(deniedIp.body, /DNS hostnames/);

  const deniedPort = await httpProbe(proxy.port, proxy.token, "http://allowed.example:8080/");
  assert.equal(deniedPort.status, 403, "ports other than 80/443 must be rejected");
  assert.match(deniedPort.body, /plain HTTP is permitted only on port 80/);

  const deniedConnect = await connectProbe(proxy.port, proxy.token, "blocked.example:443");
  assert.match(deniedConnect, /^HTTP\/1\.1 403 Forbidden\r\n/);

  const records = await waitForAudit(proxy.auditLogPath, 5);
  assert.equal(records.length, 5);
  assert.equal(records[0].allowed, false);
  assert.equal(records[0].reason, "proxy authentication required");
  assert.equal(records[1].host, "blocked.example");
  assert.equal(records[1].allowed, false);
  assert.equal(records[2].allowed, false);
  assert.equal(records[3].host, "allowed.example");
  assert.equal(records[3].port, 8080);
  assert.equal(records[3].allowed, false);
  assert.equal(records[4].method, "CONNECT");
  assert.equal(records[4].host, "blocked.example");
  assert.equal(records[4].allowed, false);

  const approvalAllowlist = new Set();
  const approvalRequests = [];
  const approvalProxy = await startManagedEgressProxy(approvalAllowlist, `approval-poc-${process.pid}`, async (hostname, port) => {
    approvalRequests.push({ hostname, port });
    if (hostname !== "approved.invalid") return false;
    approvalAllowlist.add(hostname);
    return true;
  });
  try {
    const canceled = await httpProbe(approvalProxy.port, approvalProxy.token, "http://canceled.invalid/");
    assert.equal(canceled.status, 403, "canceled approval must remain denied");

    const approved = await httpProbe(approvalProxy.port, approvalProxy.token, "http://approved.invalid/");
    assert.equal(approved.status, 502, "approval should pass the allowlist gate and proceed to DNS resolution");
    assert.match(approved.body, /destination DNS lookup failed:/);
    assert(approvalAllowlist.has("approved.invalid"), "approval callback must add the normalized hostname");
    assert.deepEqual(approvalRequests, [
      { hostname: "canceled.invalid", port: 80 },
      { hostname: "approved.invalid", port: 80 },
    ]);
  } finally {
    await approvalProxy.close();
    await fs.rm(approvalProxy.auditLogPath, { force: true });
  }

  console.log("proxy allowlist, approval callback, authentication, port policy, CONNECT rejection, and audit PoC passed");
} finally {
  await proxy.close();
  await fs.rm(proxy.auditLogPath, { force: true });
}
