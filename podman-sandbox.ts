import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const EMBEDDED_DOCKERFILE = `FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
       bash ca-certificates coreutils findutils file git ripgrep \\
    && rm -rf /var/lib/apt/lists/*
`;

const packageSchema = Type.Union([
  Type.Object({ list: Type.Literal(true) }),
  Type.Object({ pkg_add: Type.String({ minLength: 1 }) }),
]);

type RunOptions = {
  cwd?: string;
  user?: string;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
};

function runPodman(args: string[], options: RunOptions = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd });
    const chunks: Buffer[] = [];
    let timedOut = false;
    const onChunk = (data: Buffer) => {
      chunks.push(data);
      options.onData?.(data);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout * 1000) : undefined;
    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new Error("sandbox command aborted"));
      else if (timedOut) reject(new Error(`sandbox command timed out after ${options.timeout}s`));
      else resolve({ code, output: Buffer.concat(chunks).toString() });
    });
  });
}

function runPodmanInput(args: string[], input: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("podman", args, { stdio: ["pipe", "pipe", "pipe"], cwd });
    let error = "";
    child.stderr.on("data", (data) => { error += data.toString(); });
    child.stdout.resume();
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`podman build failed (${code}): ${error}`)));
    child.stdin.end(input);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&");
  return new RegExp(`^${escaped.replaceAll("**", ".*").replaceAll("*", "[^/]*").replaceAll("?", ".")}$`);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function makeGuard(root: string) {
  const realRoot = path.resolve(root);
  const check = async (input: string, allowMissing: boolean): Promise<string> => {
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
  pi.registerFlag("sandbox-image", { description: "Podman image for sandbox tools", type: "string" });
  const hostCwd = path.resolve(process.cwd());
  const guard = makeGuard(hostCwd);
  const container = `pi-sandbox-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : 1000;
  let image = "";
  const defaultImage = `localhost/pi-sandbox:${crypto.createHash("sha256").update(EMBEDDED_DOCKERFILE).digest("hex").slice(0, 16)}`;
  let started = false;
  let starting: Promise<void> | undefined;

  async function ensureImage() {
    if (image) return;
    image = defaultImage;
    const exists = await runPodman(["image", "exists", image]);
    if (exists.code !== 0) await runPodmanInput(["build", "--tag", image, "--file", "-", hostCwd], EMBEDDED_DOCKERFILE, hostCwd);
  }

  async function ensureContainer() {
    if (started) return;
    await ensureImage();
    if (starting) return starting;
    starting = (async () => {
      await runPodman([
        "run", "-d", "--name", container,
        "--volume", `${hostCwd}:${hostCwd}:rw`,
        "--userns=keep-id", "--user", `${hostUid}:${hostGid}`,
        "--workdir", hostCwd,
        "--cap-drop=ALL",
        "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE",
        "--security-opt=no-new-privileges",
        "--pids-limit=512", image, "sleep", "infinity",
      ]);
      started = true;
    })();
    try { await starting; } finally { starting = undefined; }
  }

  const exec = async (command: string, options: RunOptions = {}) => {
    await ensureContainer();
    return runPodman([
      "exec", ...(options.user ? ["--user", options.user] : []), "--workdir", options.cwd ?? hostCwd, container,
      "sh", "-lc", command,
    ], options);
  };

  const readOps: ReadOperations = {
    readFile: async (p) => fs.readFile(await guard.existing(p)),
    access: async (p) => { await fs.access(await guard.existing(p), 4); },
    detectImageMimeType: async (p) => {
      const checked = await guard.existing(p);
      await ensureContainer();
      const result = await runPodman(["exec", "--workdir", hostCwd, container, "file", "--mime-type", "-b", checked]);
      const mime = result.output.trim();
      return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
    },
  };

  const writeOps: WriteOperations = {
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
    isDirectory: async (p) => (await fs.stat(await guard.existing(p))).isDirectory(),
    readFile: async (p) => fs.readFile(await guard.existing(p), "utf8"),
  };
  const findOps: FindOperations = {
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
      const result = await exec(command, { ...options, cwd: checkedCwd });
      return { exitCode: result.code };
    },
  };

  pi.registerTool({ ...createReadTool(hostCwd, { operations: readOps }) });
  pi.registerTool({ ...createWriteTool(hostCwd, { operations: writeOps }) });
  pi.registerTool({ ...createEditTool(hostCwd, { operations: editOps }) });
  pi.registerTool({ ...createLsTool(hostCwd, { operations: lsOps }) });
  pi.registerTool({ ...createGrepTool(hostCwd, { operations: grepOps }) });
  pi.registerTool({ ...createFindTool(hostCwd, { operations: findOps }) });
  pi.registerTool({ ...createBashTool(hostCwd, { operations: bashOps, exposeSessionEnvironment: false }) });

  pi.registerTool({
    name: "sandbox",
    label: "Sandbox package manager",
    description: "Inspect or modify sandbox-owned Debian packages. Use list to show packages explicitly added through this tool, or pkg_add to install one package. APT metadata is refreshed automatically for installs.",
    parameters: packageSchema,
    async execute(_id, input, signal, onUpdate) {
      let command: string;
      let user: string | undefined;
      if ("list" in input) {
        command = "sort -u /tmp/pi-sandbox-explicit-packages 2>/dev/null || true";
      } else {
        if (!/^[a-z0-9][a-z0-9+.-]*$/.test(input.pkg_add)) {
          throw new Error("pkg_add accepts Debian package names only");
        }
        const quoted = `'${input.pkg_add.replaceAll("'", "'\\''")}'`;
        // Refresh metadata transparently before every installation. Track only
        // packages explicitly requested through this tool, not dependencies.
        command = `apt-get update && apt-get install --no-remove -y --no-install-recommends ${quoted} && touch /tmp/pi-sandbox-explicit-packages && chmod 0644 /tmp/pi-sandbox-explicit-packages && { grep -qxF ${quoted} /tmp/pi-sandbox-explicit-packages || echo ${quoted} >> /tmp/pi-sandbox-explicit-packages; }`;
        user = "0";
      }
      const result = await exec(command, { cwd: hostCwd, user, signal, onData: onUpdate ? (d) => onUpdate({ content: [{ type: "text", text: d.toString() }], details: undefined }) : undefined });
      return { content: [{ type: "text", text: result.output }], details: { exitCode: result.code }, isError: result.code !== 0 };
    },
  });

  pi.registerCommand("sandbox", {
    description: "Manage the Podman sandbox (refresh, upgrade, add, remove, list)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const operation = parts.shift();
      const packageName = parts.shift();
      if (parts.length > 0 || !operation || (operation !== "list" && !packageName)) {
        ctx.ui.notify("Usage: /sandbox list|refresh|upgrade|add <package>|remove <package>", "warning");
        return;
      }
      if (packageName && !/^[a-z0-9][a-z0-9+.-]*$/.test(packageName)) {
        ctx.ui.notify("Invalid Debian package name", "error");
        return;
      }
      const quoted = packageName ? shellQuote(packageName) : "";
      const commands: Record<string, { command: string; user?: string }> = {
        list: { command: "sort -u /tmp/pi-sandbox-explicit-packages 2>/dev/null || true" },
        refresh: { command: "apt-get update", user: "0" },
        upgrade: { command: "apt-get update && apt-get upgrade -y", user: "0" },
        add: { command: `apt-get update && apt-get install --no-remove -y --no-install-recommends ${quoted} && touch /tmp/pi-sandbox-explicit-packages && chmod 0644 /tmp/pi-sandbox-explicit-packages && { grep -qxF ${quoted} /tmp/pi-sandbox-explicit-packages || echo ${quoted} >> /tmp/pi-sandbox-explicit-packages; }`, user: "0" },
        remove: { command: `apt-get remove -y ${quoted} && (grep -vxF ${quoted} /tmp/pi-sandbox-explicit-packages > /tmp/pi-sandbox-explicit-packages.new 2>/dev/null || true) && (test -f /tmp/pi-sandbox-explicit-packages.new && mv /tmp/pi-sandbox-explicit-packages.new /tmp/pi-sandbox-explicit-packages || true)`, user: "0" },
      };
      const selected = commands[operation];
      if (!selected) {
        ctx.ui.notify("Unknown sandbox operation", "warning");
        return;
      }
      try {
        const result = await exec(selected.command, { cwd: hostCwd, user: selected.user });
        const output = result.output.trim();
        if (result.code !== 0) throw new Error(output || `exit code ${result.code}`);
        ctx.ui.notify(output ? output.slice(-2000) : `${operation} completed`, "info");
      } catch (error) {
        ctx.ui.notify(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    image = String(pi.getFlag("sandbox-image") ?? "");
    ctx.ui.notify(`Podman sandbox image: ${image || defaultImage}`, "info");
  });
  pi.on("session_shutdown", async () => {
    if (started) await runPodman(["rm", "-f", container]).catch(() => undefined);
  });
}
