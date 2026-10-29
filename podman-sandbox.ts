import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { parseEgressAllowlist, startManagedEgressProxy, type ManagedEgressProxy } from "./egress-proxy.ts";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

/**
 * Route Pi's normal file/search tools to a rootless Podman container.
 *
 * Usage:
 *   pi -e ./podman-sandbox.ts
 *   pi -e ./podman-sandbox.ts --sandbox-image debian:stable-slim
 *
 * Only the project directory is mounted. The container is kept for the
 * duration of the Pi session, so installations survive between commands.
 */

/**
 * This extension narrows host exposure for coding tools by combining a guarded
 * project view with rootless container execution. The writable project mount is
 * intentional: file changes must persist, so this is containment rather than a
 * complete hostile-code sandbox.
 */
const EMBEDDED_DOCKERFILE = `FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

# setpriv clears inherited and ambient capabilities before ordinary commands.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
       bash ca-certificates coreutils findutils file git nftables python3 python-is-python3 ripgrep util-linux \\
    && rm -rf /var/lib/apt/lists/*
`;

// pkg_add takes one name or a list so a batch of packages costs one derived-image
// rebuild instead of one tool call per package.
const pkgAddSchema = Type.Union([
  Type.String({ minLength: 1, description: "Base Debian package name to add, without any version or release qualifier" }),
  Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Base Debian package names to add together in a single image build",
  }),
]);

const packageSchema = Type.Union([
  Type.Object({ list: Type.Literal(true) }),
  Type.Object({ pkg_add: pkgAddSchema }),
]);

// Strict Debian package base name: starts with a lowercase alphanumeric, ends
// with a lowercase alphanumeric or '+' (real names such as `g++`), and uses
// only '+', '-', '.' in between. Version (`pkg=1.2`) and release (`pkg/stable`)
// qualifiers are rejected rather than stripped, and trailing separators such
// as `curl-` are rejected because no such package can exist. Checked against
// the local APT name index: every one of its names matches this pattern.
const PACKAGE_BASE_NAME = /^(?:[a-z0-9]|[a-z0-9][a-z0-9+.-]*[a-z0-9+])$/;

function invalidPackageNameReason(name: string): string {
  if (/[=/]/.test(name)) return "version and release qualifiers are not accepted";
  if (/[.+-]$/.test(name)) return "a package name must end with a lowercase letter, digit, or '+'";
  return "expected a lowercase Debian package base name";
}

const searchSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "Regex or literal text to find in project files" }),
  path: Type.Optional(Type.String({ description: "Project-relative file or directory to search" })),
  glob: Type.Optional(Type.String({ description: "File glob filter, for example '*.ts'" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat query as literal text instead of a regular expression" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Match without case sensitivity" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum result lines to return (default 50)" })),
});

const searchOutputSchema = Type.Object({
  matches: Type.Array(Type.Object({ path: Type.String(), line: Type.Integer(), text: Type.String() })),
  truncated: Type.Boolean(),
});

type SearchInput = Static<typeof searchSchema>;
type SearchMatch = { path: string; line: number; text: string };
type ProjectPackageState = { packages: string[]; upgraded: boolean };

const EMPTY_PACKAGE_STATE: ProjectPackageState = { packages: [], upgraded: false };

type RunOptions = {
  // One options record keeps process controls aligned with a single Podman call.
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  maxOutputBytes?: number;
  outputFiles?: { stdoutPath: string; stderrPath: string };
  proxyEnv?: Record<string, string>;
};

async function countLines(filePath: string): Promise<number> {
  let count = 0;
  for await (const chunk of fsSync.createReadStream(filePath)) {
    for (const byte of chunk) {
      if (byte === 10) count++;
    }
  }
  return count;
}

async function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  const input = fsSync.createReadStream(filePath);
  const reader = createInterface({ input, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of reader) {
      lines.push(line);
      if (lines.length >= maxLines) {
        reader.close();
        break;
      }
    }
    return lines;
  } finally {
    reader.close();
    input.destroy();
  }
}

function runPodman(args: string[], options: RunOptions = {}): Promise<{ code: number | null; output: string; truncated: boolean }> {
  // Bash output files are opened by the host and passed as Podman's stdout/stderr
  // file descriptors, so command output never enters Pi's process or context.
  return new Promise((resolve, reject) => {
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    try {
      if (options.outputFiles) {
        stdoutFd = fsSync.openSync(options.outputFiles.stdoutPath, "wx", 0o600);
        stderrFd = fsSync.openSync(options.outputFiles.stderrPath, "wx", 0o600);
      }
    } catch (error) {
      if (stdoutFd !== undefined) fsSync.closeSync(stdoutFd);
      reject(error);
      return;
    }
    const closeOutputFiles = () => {
      if (stdoutFd !== undefined) {
        fsSync.closeSync(stdoutFd);
        stdoutFd = undefined;
      }
      if (stderrFd !== undefined) {
        fsSync.closeSync(stderrFd);
        stderrFd = undefined;
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("podman", args, {
        stdio: options.outputFiles ? ["ignore", stdoutFd!, stderrFd!] : ["ignore", "pipe", "pipe"],
        cwd: options.cwd,
      });
    } catch (error) {
      closeOutputFiles();
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let timedOut = false;
    let truncated = false;
    let outputBytes = 0;
    const onChunk = (data: Buffer) => {
      const remaining = options.maxOutputBytes === undefined ? data.length : Math.max(0, options.maxOutputBytes - outputBytes);
      const captured = data.subarray(0, remaining);
      if (captured.length) {
        chunks.push(captured);
        outputBytes += captured.length;
        options.onData?.(captured);
      }
      if (captured.length < data.length && !truncated) {
        truncated = true;
        child.kill("SIGTERM");
      }
    };
    if (!options.outputFiles) {
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
    }
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout * 1000) : undefined;
    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      closeOutputFiles();
      reject(error);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      closeOutputFiles();
      void (async () => {
        let output = Buffer.concat(chunks).toString();
        if (options.outputFiles) {
          const [stdoutLines, stderrLines, stdoutPreview, stderrPreview] = await Promise.all([
            countLines(options.outputFiles.stdoutPath),
            countLines(options.outputFiles.stderrPath),
            readFirstLines(options.outputFiles.stdoutPath, 129),
            readFirstLines(options.outputFiles.stderrPath, 129),
          ]);
          const section = (label: string, preview: string[], total: number, filePath: string) => {
            if (total === 0 && preview.length === 0) return "";
            const visible = [`[${label}]`, ...preview.slice(0, 128)];
            if (total > 128 || preview.length > 128) visible.push(`[... full ${total} lines output to ${filePath}]`);
            return visible.join("\n");
          };
          if (stdoutLines <= 128 && stdoutPreview.length <= 128) await fs.rm(options.outputFiles.stdoutPath, { force: true });
          if (stderrLines <= 128 && stderrPreview.length <= 128) await fs.rm(options.outputFiles.stderrPath, { force: true });
          const sections = [
            section("stdout", stdoutPreview, stdoutLines, options.outputFiles.stdoutPath),
            section("stderr", stderrPreview, stderrLines, options.outputFiles.stderrPath),
          ].filter(Boolean);
          output = `${sections.length ? `${sections.join("\n")}\n` : ""}[exit code = ${code}]`;
          options.onData?.(Buffer.from(output));
        }
        if (options.signal?.aborted) reject(new Error("sandbox command aborted"));
        else if (timedOut) reject(new Error(`sandbox command timed out after ${options.timeout}s`));
        else resolve({ code, output, truncated });
      })().catch(reject);
    });
  });
}

function shellQuote(value: string): string {
  // Values reach a shell only at a few fixed command sites; quoting preserves
  // package names and paths as data rather than allowing them to become syntax.
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

function globToRegex(pattern: string): RegExp {
  // find returns every path; filtering here preserves Pi's familiar glob
  // interface without handing traversal to a host-side search process.
  const escaped = pattern.replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&");
  return new RegExp(`^${escaped.replaceAll("**", ".*").replaceAll("*", "[^/]*").replaceAll("?", ".")}$`);
}

function inside(root: string, candidate: string): boolean {
  // Prefix checks alone confuse sibling names (for example /work and /worker).
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function makeGuard(root: string) {
  // Resolve symlinks before deciding whether the host-side file APIs may touch
  // a path. This narrows traversal escapes but does not remove TOCTOU races.
  const realRoot = path.resolve(root);
  const check = async (input: string, allowMissing: boolean): Promise<string> => {
    // New destinations have no realpath yet, so their existing parent is the
    // strongest stable boundary that can be checked before creating the file.
    const absolute = path.resolve(input);
    let resolved: string;
    try {
      resolved = await fs.realpath(absolute);
    } catch (error: any) {
      if (!allowMissing || (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")) throw error;
      const parent = await fs.realpath(path.dirname(absolute));
      resolved = path.join(parent, path.basename(absolute));
    }
    if (!inside(realRoot, resolved)) throw new Error(`path escapes project directory: ${input}`);
    return resolved;
  };
  return {
    existing: (p: string) => check(p, false),
    writable: (p: string) => check(p, true),
    directory: async (p: string) => {
      const checked = await check(p, false);
      const stat = await fs.stat(checked);
      if (!stat.isDirectory()) throw new Error(`not a directory: ${p}`);
      return checked;
    },
  };
}

export default function (pi: ExtensionAPI) {
  // CLI selection is explicit so a project cannot silently load a sandbox that
  // changes where its tools execute. Verbose traces avoid logging user commands.
  pi.registerFlag("sandbox-image", { description: "Podman image for sandbox tools", type: "string" });
  pi.registerFlag("sandbox-verbose", { description: "Log Podman sandbox startup and execution milestones", type: "boolean" });
  pi.registerFlag("sandbox-egress-allow", { description: "Comma-separated DNS destinations allowed through the bash proxy (hostname defaults to :443; use hostname:80 for HTTP)", type: "string" });
  const verbose = Boolean(pi.getFlag("sandbox-verbose")) || process.argv.includes("--verbose");
  const logVerbose = (message: string) => {
    if (verbose) process.stderr.write(`[podman-sandbox] ${message}\n`);
  };
  const hostCwd = path.resolve(process.cwd());
  const outputDirectory = path.join(hostCwd, ".out");
  const guard = makeGuard(hostCwd);
  async function prepareOutputDirectory(): Promise<string> {
    await fs.mkdir(outputDirectory, { recursive: true });
    const outputStat = await fs.lstat(outputDirectory);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("project .out path must be a real directory");
    const checked = await guard.directory(outputDirectory);
    try {
      await fs.writeFile(path.join(checked, ".gitignore"), "*\n", { flag: "wx", mode: 0o644 });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    return checked;
  }
  // Each Pi session owns its own container; the project label and path hash
  // make it recognizable without sharing container-local filesystem state.
  const projectLabel = path.basename(hostCwd).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32) || "project";
  const projectHash = crypto.createHash("sha256").update(hostCwd).digest("hex").slice(0, 8);
  const packageProjectId = process.env.PI_SANDBOX_PACKAGE_PROJECT_ID?.replace(/[^A-Za-z0-9_-]/g, "_") || projectHash;
  const container = `pi-sandbox-${projectLabel}-${projectHash}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const packageStateRoot = process.env.PI_SANDBOX_PACKAGE_STATE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "pi-sandbox", "projects", packageProjectId);
  const packageStatePath = path.join(packageStateRoot, "packages.json");
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : 1000;
  let packageState: ProjectPackageState = { ...EMPTY_PACKAGE_STATE };
  let image = "";
  let runtimeImage = "";
  let customImage = false;
  let sessionId = crypto.randomUUID();
  let lastBashCommandId = 0;
  let egressAllowlist = new Set<string>();
  let approveEgressHost: (hostname: string, port: number) => Promise<boolean> = async () => false;
  const pendingEgressApprovals = new Map<string, Promise<boolean>>();
  let managedProxy: ManagedEgressProxy | undefined;
  const nextBashCommandId = () => {
    lastBashCommandId = Math.max(Date.now(), lastBashCommandId + 1);
    return lastBashCommandId;
  };
  // The base tag is derived only from the embedded recipe. Project-specific
  // APT layers are separately tagged from the base and complete package state.
  const defaultImage = `localhost/pi-sandbox:${crypto.createHash("sha256").update(EMBEDDED_DOCKERFILE).digest("hex").slice(0, 16)}`;
  let podmanChecked = false;
  let started = false;
  let starting: Promise<void> | undefined;
  let resetting: Promise<void> | undefined;
  let proxyStarting: Promise<ManagedEgressProxy> | undefined;

  async function checkPodman() {
    // Rootless Podman is a prerequisite, not a best-effort optimization: a
    // rootful daemon changes the host impact of every later container action.
    if (podmanChecked) return;
    const result = await runPodman(["info", "--format", "{{.Host.Security.Rootless}}"], { timeout: 30 });
    if (result.code !== 0) throw new Error(`Podman is unavailable: ${result.output.trim() || `exit code ${result.code}`}`);
    if (result.output.trim() !== "true") throw new Error("Podman must be configured for rootless operation");
    podmanChecked = true;
    logVerbose("rootless Podman is available");
  }

  async function readPackageState(): Promise<ProjectPackageState> {
    try {
      const parsed = JSON.parse(await fs.readFile(packageStatePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.packages)) throw new Error("invalid package manifest");
      const packages = [...new Set(parsed.packages)];
      if (packages.some((name) => typeof name !== "string" || !PACKAGE_BASE_NAME.test(name))) {
        throw new Error("package manifest contains an invalid Debian package name");
      }
      return { packages: packages.sort(), upgraded: parsed.upgraded === true };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { ...EMPTY_PACKAGE_STATE };
      throw new Error(`could not read project package state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function writePackageState(state: ProjectPackageState): Promise<void> {
    await fs.mkdir(packageStateRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(packageStateRoot, `packages-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, packageStatePath);
  }

  async function buildImage(tag: string, recipe: string, buildArgs: string[] = [], noCache = false): Promise<void> {
    const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sandbox-image-"));
    const containerfile = path.join(buildDir, "Containerfile");
    try {
      await fs.writeFile(containerfile, recipe);
      const built = await runPodman(["build", ...(noCache ? ["--no-cache"] : []), "--tag", tag, ...buildArgs, "--file", containerfile, buildDir], {
        cwd: hostCwd,
        timeout: 600,
      });
      if (built.code !== 0) throw new Error(`podman build failed (${built.code}): ${built.output.trim()}`);
    } finally {
      await fs.rm(buildDir, { recursive: true, force: true });
    }
  }

  async function ensureBaseImage(): Promise<void> {
    await checkPodman();
    if (!image) image = defaultImage;
    const exists = await runPodman(["image", "exists", image], { timeout: 30 });
    if (exists.code === 0) {
      logVerbose(`base image is available: ${image}`);
      return;
    }
    if (exists.code !== 1) throw new Error(`podman image exists failed (${exists.code}): ${exists.output.trim()}`);
    if (customImage) throw new Error(`sandbox base image not found locally: ${image}`);

    logVerbose(`building embedded base image: ${image}`);
    await buildImage(image, EMBEDDED_DOCKERFILE);
    logVerbose(`embedded base image built: ${image}`);
  }

  function projectUpgradeImageTag(state: ProjectPackageState): string | undefined {
    if (!state.upgraded) return undefined;
    const key = crypto.createHash("sha256").update(JSON.stringify({ base: image, projectId: packageProjectId, upgraded: true })).digest("hex").slice(0, 16);
    return `localhost/pi-sandbox-${packageProjectId}-upgrade:${key}`;
  }

  function projectPackageImageTag(parentImage: string, state: ProjectPackageState): string | undefined {
    if (state.packages.length === 0) return undefined;
    const key = crypto.createHash("sha256").update(JSON.stringify({ parent: parentImage, projectId: packageProjectId, packages: state.packages })).digest("hex").slice(0, 16);
    return `localhost/pi-sandbox-${packageProjectId}-apt:${key}`;
  }

  async function deriveProjectImage(
    state: ProjectPackageState,
    options: { forceRefresh?: boolean; forceUpgrade?: boolean } = {},
  ): Promise<string> {
    let parentImage = image;
    if (state.upgraded) {
      const upgradeImage = projectUpgradeImageTag(state)!;
      const exists = await runPodman(["image", "exists", upgradeImage], { timeout: 30 });
      if (exists.code === 0 && !options.forceUpgrade) {
        logVerbose(`project upgrade image is available: ${upgradeImage}`);
      } else if (exists.code === 0 || exists.code === 1) {
        const recipe = `ARG BASE_IMAGE
FROM \${BASE_IMAGE}
RUN apt-get update \\
    && apt-get upgrade -y \\
    && rm -rf /var/lib/apt/lists/*
`;
        logVerbose(`building project upgrade image: ${upgradeImage}`);
        await buildImage(upgradeImage, recipe, ["--build-arg", `BASE_IMAGE=${image}`], options.forceUpgrade);
      } else {
        throw new Error(`podman image exists failed (${exists.code}): ${exists.output.trim()}`);
      }
      parentImage = upgradeImage;
    }

    const packageImage = projectPackageImageTag(parentImage, state);
    if (!packageImage) return parentImage;
    const exists = await runPodman(["image", "exists", packageImage], { timeout: 30 });
    if (exists.code === 0 && !options.forceRefresh && !options.forceUpgrade) {
      logVerbose(`project APT image is available: ${packageImage}`);
      return packageImage;
    }
    if (exists.code !== 0 && exists.code !== 1) throw new Error(`podman image exists failed (${exists.code}): ${exists.output.trim()}`);

    const aptPackages = state.packages.map(shellQuote).join(" ");
    const install = ` && apt-get install --no-remove -y --no-install-recommends ${aptPackages}`;
    const recipe = `ARG BASE_IMAGE
FROM \${BASE_IMAGE}
RUN apt-get update${install} \\
    && rm -rf /var/lib/apt/lists/*
`;
    logVerbose(`building project APT image from the full explicit package list: ${packageImage}`);
    await buildImage(packageImage, recipe, ["--build-arg", `BASE_IMAGE=${parentImage}`], options.forceRefresh || options.forceUpgrade);
    return packageImage;
  }

  async function ensureImage(): Promise<void> {
    await ensureBaseImage();
    runtimeImage = await deriveProjectImage(packageState);
    logVerbose(`session image is ready: ${runtimeImage}`);
  }

  async function preparePackageState(
    next: ProjectPackageState,
    options: { forceRefresh?: boolean; forceUpgrade?: boolean } = {},
  ): Promise<void> {
    if (resetting) await resetting;
    if (starting) await starting.catch(() => undefined);
    await ensureBaseImage();
    const nextRuntimeImage = await deriveProjectImage(next, options);
    const changed = JSON.stringify(next) !== JSON.stringify(packageState);
    if (started && (changed || options.forceRefresh || options.forceUpgrade)) {
      const removed = await runPodman(["rm", "-f", container], { timeout: 30 });
      if (removed.code !== 0) throw new Error(`podman rm -f failed (${removed.code}): ${removed.output.trim()}`);
      started = false;
    }
    if (changed) await writePackageState(next);
    packageState = next;
    runtimeImage = nextRuntimeImage;
    logVerbose(`project package state updated: ${packageState.packages.join(", ") || "(no explicit packages)"}`);
  }

  async function mutatePackageState(
    update: (current: ProjectPackageState) => ProjectPackageState,
    options: { forceRefresh?: boolean; forceUpgrade?: boolean } = {},
  ): Promise<ProjectPackageState> {
    // The package manifest is host-side and never mounted into the sandbox.
    // Atomic replacement avoids partial state; cross-process lost updates are
    // accepted for this local development tool, while APT receives the full list.
    packageState = await readPackageState();
    const next = update(packageState);
    next.packages = [...new Set(next.packages)].sort();
    await preparePackageState(next, options);
    return next;
  }

  function restoreEgressAllowlist(ctx: ExtensionContext): void {
    egressAllowlist.clear();
    for (const hostname of parseEgressAllowlist(String(pi.getFlag("sandbox-egress-allow") ?? ""))) egressAllowlist.add(hostname);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "sandbox-egress-allow") continue;
      const data = entry.data as { hostname?: unknown; port?: unknown } | undefined;
      if (typeof data?.hostname !== "string") continue;
      const port = data.port === undefined ? 443 : data.port;
      if (typeof port !== "number" || (port !== 80 && port !== 443)) continue;
      try {
        const restored = parseEgressAllowlist(`${data.hostname}:${port}`);
        if (restored.size === 1) egressAllowlist.add([...restored][0]);
      } catch {
        logVerbose("ignored invalid sandbox egress approval in session history");
      }
    }
  }

  async function requestEgressApproval(hostname: string, port: number, ctx: ExtensionContext): Promise<boolean> {
    const destination = `${hostname}:${port}`;
    if (egressAllowlist.has(destination)) return true;
    const pending = pendingEgressApprovals.get(destination);
    if (pending) return pending;

    const approval = (async () => {
      if (!ctx.hasUI || (port !== 80 && port !== 443)) return false;
      let normalized: string;
      try {
        normalized = [...parseEgressAllowlist(`${hostname}:${port}`)][0];
      } catch {
        return false;
      }
      if (normalized !== destination) return false;
      const approvalBranchLeaf = ctx.sessionManager.getLeafId();
      const approved = await ctx.ui.confirm(`Allow ${destination}?`, "");
      if (!approved || ctx.sessionManager.getLeafId() !== approvalBranchLeaf) return false;
      if (egressAllowlist.has(destination)) return true;
      pi.appendEntry("sandbox-egress-allow", { hostname, port });
      egressAllowlist.add(destination);
      ctx.ui.notify(`Allowed ${destination} for this session branch`, "info");
      logVerbose(`session branch approved proxy destination ${destination}`);
      return true;
    })();
    pendingEgressApprovals.set(destination, approval);
    try {
      return await approval;
    } finally {
      if (pendingEgressApprovals.get(destination) === approval) pendingEgressApprovals.delete(destination);
    }
  }

  async function ensureProxy(): Promise<ManagedEgressProxy> {
    if (managedProxy) return managedProxy;
    if (!proxyStarting) {
      proxyStarting = startManagedEgressProxy(egressAllowlist, sessionId, (hostname, port) => approveEgressHost(hostname, port));
    }
    try {
      managedProxy = await proxyStarting;
      logVerbose(`HTTP egress proxy is listening on port ${managedProxy.port}; audit log: ${managedProxy.auditLogPath}`);
      return managedProxy;
    } finally {
      proxyStarting = undefined;
    }
  }

  async function ensureContainer() {
    if (resetting) await resetting;
    if (started) return;
    if (starting) return starting;
    starting = (async () => {
      await ensureImage();
      const proxy = await ensureProxy();
      logVerbose(`starting container ${container} as ${hostUid}:${hostGid} with project mount ${hostCwd}`);
      const result = await runPodman([
        "run", "-d", "--name", container,
        "--volume", `${hostCwd}:${hostCwd}:rw`,
        "--userns=keep-id", "--user", `${hostUid}:${hostGid}`,
        "--workdir", hostCwd,
        "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev",
        "--tmpfs", "/var/tmp:rw,nosuid,nodev",
        "--tmpfs", "/run:rw,nosuid,nodev",
        "--cap-drop=ALL",
        // NET_ADMIN is used only by extension-owned startup code to install the
        // namespace firewall; Bash runs as the mapped unprivileged UID.
        "--cap-add=NET_ADMIN",
        // PR_SET_NO_NEW_PRIVS makes SUID/SGID bits and file capabilities unable
        // to grant new privilege to any exec'd command in the container.
        "--security-opt=no-new-privileges",
        "--pids-limit=512", runtimeImage, "sleep", "infinity",
      ]);
      if (result.code !== 0) throw new Error(`podman run failed (${result.code}): ${result.output.trim()}`);
      try {
        const gatewayResult = await runPodman(["exec", "--user", "0", container, "getent", "ahostsv4", "host.containers.internal"]);
        const gateway = gatewayResult.output.trim().split(/\s+/)[0];
        if (gatewayResult.code !== 0 || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(gateway)) {
          throw new Error(`could not resolve the container host gateway: ${gatewayResult.output.trim()}`);
        }
        const firewall = [
          "nft add table inet pi_sandbox_egress",
          "nft 'add chain inet pi_sandbox_egress output { type filter hook output priority 0; policy drop; }'",
          "nft add rule inet pi_sandbox_egress output oifname lo accept",
          "nft add rule inet pi_sandbox_egress output ct state established,related accept",
          "nft add rule inet pi_sandbox_egress output meta skuid 0 accept",
          "nft add rule inet pi_sandbox_egress output meta skuid 42 accept",
          `nft add rule inet pi_sandbox_egress output ip daddr ${gateway} tcp dport ${proxy.port} accept`,
          "nft add rule inet pi_sandbox_egress output reject with icmpx type admin-prohibited",
        ].join(" && ");
        const installed = await runPodman(["exec", "--user", "0", container, "sh", "-lc", firewall]);
        if (installed.code !== 0) throw new Error(`failed to install sandbox egress policy (${installed.code}): ${installed.output.trim()}`);
      } catch (error) {
        await runPodman(["rm", "-f", container]).catch(() => undefined);
        throw error;
      }
      started = true;
      logVerbose(`container is ready with direct egress restricted to APT identities and the HTTP proxy: ${container}`);
    })();
    try { await starting; } finally { starting = undefined; }
  }

  const exec = async (command: string, options: RunOptions = {}) => {
    await ensureContainer();
    const proxyEnvironment = Object.entries(options.proxyEnv ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
    const execution = ["setpriv", "--inh-caps=-all", "--ambient-caps=-all", "--", "sh", "-lc", command];
    logVerbose(`executing sandbox command as mapped user with capabilities cleared in ${options.cwd ?? hostCwd}`);
    return runPodman([
      "exec", "--user", `${hostUid}:${hostGid}`, ...proxyEnvironment, "--workdir", options.cwd ?? hostCwd, container,
      ...execution,
    ], options);
  };

  async function resetSandboxState() {
    if (resetting) return resetting;
    resetting = (async () => {
      if (starting) await starting.catch(() => undefined);
      await ensureBaseImage();
      const currentState = await readPackageState();
      if (started) {
        logVerbose(`resetting sandbox container: ${container}`);
        const removed = await runPodman(["rm", "-f", container], { timeout: 30 });
        if (removed.code !== 0) throw new Error(`podman rm -f failed (${removed.code}): ${removed.output.trim()}`);
        started = false;
      }

      const imageList = await runPodman(["images", "--format", "{{.Repository}}:{{.Tag}}"], { timeout: 30 });
      if (imageList.code !== 0) throw new Error(`podman images failed (${imageList.code}): ${imageList.output.trim()}`);
      const derivedPrefixes = [
        `localhost/pi-sandbox-${packageProjectId}-apt:`,
        `localhost/pi-sandbox-${packageProjectId}-upgrade:`,
      ];
      const derivedImages = imageList.output.split("\n").filter((tag) => derivedPrefixes.some((prefix) => tag.startsWith(prefix)));
      for (const tag of derivedImages) {
        const removed = await runPodman(["rmi", tag], { timeout: 60 });
        if (removed.code !== 0) throw new Error(`podman rmi ${tag} failed (${removed.code}): ${removed.output.trim()}`);
      }
      packageState = currentState;
      runtimeImage = await deriveProjectImage(packageState);
      logVerbose(`sandbox reset rebuilt project image ${runtimeImage} from retained base ${image} and the full package list`);
    })();
    const operation = resetting;
    try {
      await operation;
    } finally {
      if (resetting === operation) resetting = undefined;
    }
  }

  async function sandboxContainerSize(): Promise<string> {
    if (started) {
      const inspected = await runPodman([
        "container", "inspect", "--size", "--format", "{{.SizeRootFs}} {{.SizeRw}}", container,
      ], { timeout: 30 });
      if (inspected.code !== 0) {
        throw new Error(`could not inspect started sandbox container size: ${inspected.output.trim() || `exit code ${inspected.code}`}`);
      }
      const match = inspected.output.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) throw new Error(`could not parse sandbox container size: ${inspected.output.trim()}`);
      const rootFsBytes = Number(match[1]);
      const writableBytes = Number(match[2]);
      if (!Number.isFinite(rootFsBytes) || !Number.isFinite(writableBytes)) {
        throw new Error(`sandbox container size is not a finite byte count: ${inspected.output.trim()}`);
      }
      return `${formatBytes(rootFsBytes)} rootfs; ${formatBytes(writableBytes)} writable layer (project mount excluded)`;
    }
    const inspectedImage = await runPodman(["image", "inspect", "--format", "{{.Size}}", runtimeImage], { timeout: 30 });
    const bytes = Number(inspectedImage.output.trim());
    if (inspectedImage.code !== 0 || !Number.isFinite(bytes)) {
      throw new Error(`could not inspect sandbox image size: ${inspectedImage.output.trim()}`);
    }
    return `${formatBytes(bytes)} image; container not started`;
  }

  async function sandboxTrafficStats() {
    const stats = { http: 0, https: 0, denied: 0, bytesUp: 0, bytesDown: 0 };
    if (!managedProxy) return stats;
    const text = await fs.readFile(managedProxy.auditLogPath, "utf8").catch(() => "");
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record.method === "CONNECT") stats.https++;
        else stats.http++;
        if (!record.allowed) stats.denied++;
        stats.bytesUp += Number(record.bytesUp) || 0;
        stats.bytesDown += Number(record.bytesDown) || 0;
      } catch {
        // A partially appended final audit line is omitted until the next status refresh.
      }
    }
    return stats;
  }

  async function sandboxStatsLines(verbose: boolean): Promise<string[]> {
    await ensureImage();
    packageState = await readPackageState();
    const [containerSize, traffic] = await Promise.all([sandboxContainerSize(), sandboxTrafficStats()]);
    const destinations = [...egressAllowlist].sort();
    const lines = [
      `Installed packages: ${packageState.packages.length}`,
      `Allowed destinations: ${destinations.length}`,
      `Pod container size: ${containerSize}`,
      `Intercepted traffic: ${traffic.http} HTTP, ${traffic.https} HTTPS CONNECT; ${traffic.denied} denied; ${formatBytes(traffic.bytesUp)} up / ${formatBytes(traffic.bytesDown)} down`,
    ];
    if (verbose) {
      lines.splice(1, 0, `  ${packageState.packages.length ? packageState.packages.join(", ") : "(none)"}`);
      lines.splice(3, 0, `  ${destinations.length ? destinations.join(", ") : "(none)"}`);
    }
    return lines;
  }

  const readOps: ReadOperations = {
    // Host file APIs preserve Pi's normal file semantics, so every path must
    // pass the project guard immediately before each operation.
    readFile: async (p) => fs.readFile(await guard.existing(p)),
    access: async (p) => { await fs.access(await guard.existing(p), 4); },
    detectImageMimeType: async (p) => {
      const checked = await guard.existing(p);
      // Image decoding support belongs to the container image rather than host
      // utility discovery, and the guard ensures this path is project-owned.
      const mimeResult = await exec(`file --mime-type -b ${shellQuote(checked)}`, { cwd: hostCwd });
      const mime = mimeResult.output.trim();
      return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
    },
  };

  const writeOps: WriteOperations = {
    // File mutation stays host-native for Pi compatibility; the guard is the
    // boundary that keeps those host privileges scoped to this project tree.
    writeFile: async (p, content) => {
      const checked = await guard.writable(p);
      await fs.writeFile(checked, content);
    },
    mkdir: async (p) => { await fs.mkdir(await guard.writable(p), { recursive: true }); },
  };
  const editOps: EditOperations = {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
  const lsOps: LsOperations = {
    exists: async (p) => { try { await guard.existing(p); return true; } catch { return false; } },
    stat: async (p) => fs.stat(await guard.existing(p)),
    readdir: async (p) => fs.readdir(await guard.directory(p)),
  };
  const grepOps: GrepOperations = {
    // Pi's built-in grep still owns traversal; these callbacks protect paths it
    // asks us to read, but do not make its traversal container-backed.
    isDirectory: async (p) => (await fs.stat(await guard.existing(p))).isDirectory(),
    readFile: async (p) => fs.readFile(await guard.existing(p), "utf8"),
  };
  const findOps: FindOperations = {
    // find traversal happens in the container; local filtering keeps returned
    // paths within the project API's expected root.
    exists: async (p) => { try { await guard.existing(p); return true; } catch { return false; } },
    glob: async (pattern, cwd, options) => {
      await guard.directory(cwd);
      const result = await exec("find . -print", { cwd, timeout: 30 });
      const matcher = globToRegex(pattern);
      return result.output.split("\n").filter(Boolean)
        .map((p) => path.resolve(cwd, p))
        .filter((p) => inside(hostCwd, path.resolve(p)))
        .filter((p) => matcher.test(path.relative(cwd, p)))
        .slice(0, options.limit);
    },
  };
  const bashOps: BashOperations = {
    exec: async (command, cwd, options) => {
      const checkedCwd = await guard.directory(cwd);
      const proxy = await ensureProxy();
      const proxyUrl = `http://${proxy.token}@host.containers.internal:${proxy.port}`;
      const commandOutputDirectory = await prepareOutputDirectory();
      const commandId = nextBashCommandId();
      const result = await exec(command, {
        ...options,
        cwd: checkedCwd,
        proxyEnv: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          ALL_PROXY: "",
          all_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
        },
        outputFiles: {
          stdoutPath: path.join(commandOutputDirectory, `session-${sessionId}-${commandId}.out`),
          stderrPath: path.join(commandOutputDirectory, `session-${sessionId}-${commandId}.err`),
        },
      });
      return { exitCode: result.code };
    },
  };

  // Search is a read-only native tool rather than an instruction to construct a
  // shell command. This keeps path validation, output bounds, and match framing
  // in one implementation and gives the model compact path/line results.
  const searchTool = {
    name: "search",
    label: "Search",
    description: "Search text in project files with regex or literal matching. Prefer this tool over bash grep/rg or the legacy grep tool: shell search is discouraged because its output is less bounded and less structured.",
    promptSnippet: "Search project text and return bounded path/line matches",
    promptGuidelines: [
      "Use search instead of invoking grep, rg, ripgrep, or similar text-search commands through bash.",
      "Search results are bounded; narrow the path or glob when more matches are needed.",
    ],
    parameters: searchSchema,
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id: string, input: SearchInput, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }) {
      const searchRoot = path.resolve(ctx?.cwd ?? hostCwd, input.path ?? ".");
      const checkedPath = await guard.existing(searchRoot);
      const limit = input.limit ?? 50;
      const args = ["rg", "--json", "--line-number", "--color=never", "--no-follow", "--max-columns=400", "--max-columns-preview"];
      if (input.literal) args.push("--fixed-strings");
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.glob) args.push("--glob", shellQuote(input.glob));
      args.push(shellQuote(input.query), shellQuote(checkedPath));

      // A byte cap protects memory even when one regex matches a huge tree;
      // the per-call match limit separately protects model context size.
      const result = await exec(args.join(" "), {
        cwd: hostCwd,
        signal,
        timeout: 30,
        maxOutputBytes: 1024 * 1024,
      });
      if (result.code !== 0 && result.code !== 1 && !result.truncated) {
        throw new Error(`search failed (${result.code}): ${result.output.trim()}`);
      }

      const matches: SearchMatch[] = [];
      let truncated = result.truncated;
      for (const line of result.output.split("\n")) {
        if (!line) continue;
        let record: any;
        try {
          record = JSON.parse(line);
        } catch (error) {
          // A byte cap can stop inside one JSON event; complete preceding
          // records remain useful, but malformed uncapped output is a failure.
          if (result.truncated) {
            truncated = true;
            break;
          }
          throw new Error(`search returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (record.type !== "match") continue;
        if (matches.length >= limit) {
          truncated = true;
          continue;
        }
        const rawPath = record.data.path.text ?? Buffer.from(record.data.path.bytes, "base64").toString("utf8");
        const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(checkedPath, rawPath);
        const relativePath = path.relative(hostCwd, absolutePath) || path.basename(absolutePath);
        const rawText = record.data.lines.text ?? Buffer.from(record.data.lines.bytes, "base64").toString("utf8");
        matches.push({
          path: relativePath,
          line: record.data.line_number,
          text: rawText.replace(/\r?\n$/, ""),
        });
      }

      const output = matches.length
        ? matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")
        : "No matches found";
      const notice = truncated ? "\n\n[Results truncated. Narrow the search path or glob for more matches.]" : "";
      return {
        content: [{ type: "text", text: `${output}${notice}` }],
        details: { matchCount: matches.length, truncated },
        structuredContent: { matches, truncated },
      };
    },
  };

  pi.registerTool({ ...searchTool });
  // Reusing Pi's factories retains its public schemas/renderers while replacing
  // the actual filesystem and process operations that cross the trust boundary.
  pi.registerTool({ ...createReadTool(hostCwd, { operations: readOps }) });
  pi.registerTool({ ...createWriteTool(hostCwd, { operations: writeOps }) });
  pi.registerTool({ ...createEditTool(hostCwd, { operations: editOps }) });
  pi.registerTool({ ...createLsTool(hostCwd, { operations: lsOps }) });
  const legacyGrep = createGrepTool(hostCwd, { operations: grepOps });
  // Replacing the same built-in name with hidden exposure withdraws grep from
  // the model-visible tools instead of leaving a second search path enabled.
  pi.registerTool({
    ...legacyGrep,
    description: "Deprecated and hidden. Use the native search tool instead of grep, rg, or similar shell commands.",
    exposure: "hidden",
  });
  pi.registerTool({ ...createFindTool(hostCwd, { operations: findOps }) });
  const bashTool = createBashTool(hostCwd, { operations: bashOps, exposeSessionEnvironment: false });
  pi.registerTool({
    ...bashTool,
    description: "Execute a bash command inside the Podman sandbox. Stdout and stderr are saved under the ignored project .out/ directory and can be opened with the read tool. The result shows up to 128 lines per stream, with the full file path and line count when longer, plus the exit code. Use search instead of shell grep/rg for source lookup.",
    promptGuidelines: [
      "Use the native search tool for source text lookup instead of running grep, rg, or ripgrep in bash.",
    ],
  });

  pi.registerTool({
    name: "sandbox",
    label: "Sandbox package manager",
    description: "Inspect the per-project explicit Debian package list or add one package or a list of packages in a single build. Package changes rebuild a derived image from the full package list, leaving the shared base image unchanged.",
    parameters: packageSchema,
    async execute(_id, input) {
      if ("list" in input) {
        packageState = await readPackageState();
        const text = packageState.packages.length ? packageState.packages.join("\n") : "No explicitly added packages";
        return { content: [{ type: "text", text }], details: { packages: packageState.packages } };
      }
      const requested = Array.isArray(input.pkg_add) ? input.pkg_add : [input.pkg_add];
      const invalid = requested.find((name) => !PACKAGE_BASE_NAME.test(name));
      if (invalid !== undefined) {
        throw new Error(`pkg_add accepts Debian package names only: ${invalid} (${invalidPackageNameReason(invalid)})`);
      }
      const names = [...new Set(requested)];
      const summary = names.length === 1 ? `Added ${names[0]}` : `Added ${names.length} packages (${names.join(", ")})`;
      try {
        await mutatePackageState((current) => ({
          ...current,
          packages: [...current.packages, ...names],
        }));
        return {
          content: [{ type: "text", text: `${summary} to the project APT image. The next sandbox command will use the updated image.` }],
          details: { exitCode: 0, packages: packageState.packages, image: runtimeImage },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { exitCode: 1 }, isError: true };
      }
    },
  });

  pi.registerCommand("sandbox", {
    // Maintenance actions that can alter package state remain user initiated,
    // separate from the narrower model-callable additive package interface.
    description: "Manage the Podman sandbox (status, list, refresh, upgrade, add, remove, reset)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const operation = parts.shift() ?? "status";
      // add takes a list so one user command can request several packages and
      // share a single rebuild; the other package operations stay single-name.
      const takesList = operation === "add";
      const needsPackage = takesList || operation === "remove";
      const packageNames = needsPackage ? (takesList ? parts : parts.slice(0, 1)) : [];
      const packageName = packageNames[0];
      const unexpected = takesList ? [] : parts.slice(1);
      if (unexpected.length > 0 || (needsPackage && packageNames.length === 0) || (!needsPackage && parts.length > 0)) {
        ctx.ui.notify("Usage: /sandbox [status|list|refresh|upgrade|add <package...>|remove <package>|reset]", "warning");
        return;
      }
      const invalidName = packageNames.find((name) => !PACKAGE_BASE_NAME.test(name));
      if (invalidName !== undefined) {
        ctx.ui.notify(`Invalid Debian package name: ${invalidName} (${invalidPackageNameReason(invalidName)})`, "error");
        return;
      }
      if (operation === "reset") {
        try {
          await resetSandboxState();
          ctx.ui.notify("reset completed; the project container and derived APT image were rebuilt from the retained base and complete package list", "info");
        } catch (error) {
          ctx.ui.notify(`reset failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      try {
        if (operation === "status") {
          const stats = await sandboxStatsLines(false);
          ctx.ui.notify([
            "Podman sandbox commands:",
            "  /sandbox          show this help and quick stats",
            "  /sandbox status   show this help and quick stats",
            "  /sandbox list     show detailed package, destination, size, and traffic status",
            "  /sandbox refresh  rebuild explicit packages from current repositories",
            "  /sandbox upgrade  upgrade the project sandbox image",
            "  /sandbox add <package...>  add one or more Debian packages",
            "  /sandbox remove <package> remove an explicit package",
            "  /sandbox reset    rebuild this project's sandbox from its base and package list",
            "",
            "Sandbox stats:",
            ...stats,
          ].join("\n"), "info");
          return;
        }
        if (operation === "list") {
          await ensureContainer();
          const stats = await sandboxStatsLines(true);
          ctx.ui.notify(`list completed:\n${stats.join("\n")}`, "info");
          return;
        }
        if (operation === "refresh") {
          packageState = await readPackageState();
          if (packageState.packages.length === 0) {
            ctx.ui.notify("No explicit APT packages to refresh", "info");
            return;
          }
          await preparePackageState(packageState, { forceRefresh: true });
          ctx.ui.notify("refresh completed; the complete package list was reinstalled in the derived image", "info");
          return;
        }
        if (operation === "upgrade") {
          await mutatePackageState((current) => ({ ...current, upgraded: true }), { forceUpgrade: true });
          ctx.ui.notify("upgrade completed; the project upgrade and APT layers were rebuilt", "info");
          return;
        }
        if (operation === "add") {
          await mutatePackageState((current) => ({ ...current, packages: [...current.packages, ...packageNames] }));
          const added = packageNames.length === 1
            ? `${packageName} is in the project APT image`
            : `${packageNames.length} packages are in the project APT image (${packageNames.join(", ")})`;
          ctx.ui.notify(`add completed; ${added}`, "info");
          return;
        }
        if (operation === "remove") {
          packageState = await readPackageState();
          if (!packageState.packages.includes(packageName!)) {
            ctx.ui.notify(`${packageName} is not in the explicit project package list`, "warning");
            return;
          }
          await mutatePackageState((current) => ({ ...current, packages: current.packages.filter((name) => name !== packageName) }));
          ctx.ui.notify(`remove completed; ${packageName} is absent from the rebuilt project APT image`, "info");
          return;
        }
        ctx.ui.notify("Unknown sandbox operation", "warning");
      } catch (error) {
        ctx.ui.notify(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Fail visibly before the first tool call if rootless Podman is unavailable,
    // and build the extension-owned image at startup rather than lazily failing
    // after the model has already requested sandbox work.
    image = String(pi.getFlag("sandbox-image") ?? "");
    customImage = Boolean(image);
    try {
      sessionId = String(ctx.sessionManager.getSessionId() ?? sessionId).replace(/[^A-Za-z0-9_-]/g, "_");
      restoreEgressAllowlist(ctx);
      approveEgressHost = (hostname, port) => requestEgressApproval(hostname, port, ctx);
      packageState = await readPackageState();
      await checkPodman();
      await ensureImage();
      await ensureProxy();
      ctx.ui.notify(`Podman sandbox ready: ${runtimeImage || image || defaultImage}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logVerbose(`startup failed: ${message}`);
      ctx.ui.notify(`Podman sandbox startup failed: ${message}`, "error");
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    restoreEgressAllowlist(ctx);
    approveEgressHost = (hostname, port) => requestEgressApproval(hostname, port, ctx);
  });
  pi.on("session_shutdown", async () => {
    if (started) {
      logVerbose(`removing session container: ${container}`);
      await runPodman(["rm", "-f", container]).catch(() => undefined);
    }
    if (managedProxy) {
      await managedProxy.close();
      managedProxy = undefined;
    }
  });
}
