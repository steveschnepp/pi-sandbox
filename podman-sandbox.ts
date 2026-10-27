import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Type, type Static } from "typebox";
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

/**
 * This extension narrows host exposure for coding tools by combining a guarded
 * project view with rootless container execution. The writable project mount is
 * intentional: file changes must persist, so this is containment rather than a
 * complete hostile-code sandbox.
 */
const EMBEDDED_DOCKERFILE = `FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

# setpriv is the boundary between the container's APT capabilities and ordinary
# non-root commands, which must not inherit DAC_OVERRIDE or package privileges.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
       bash ca-certificates coreutils findutils file git ripgrep util-linux \\
    && rm -rf /var/lib/apt/lists/*
`;

const packageSchema = Type.Union([
  Type.Object({ list: Type.Literal(true) }),
  Type.Object({ pkg_add: Type.String({ minLength: 1 }) }),
]);

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

type RunOptions = {
  // One options record keeps process controls aligned with a single Podman call.
  cwd?: string;
  user?: string;
  env?: NodeJS.ProcessEnv;
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  maxOutputBytes?: number;
};

function runPodman(args: string[], options: RunOptions = {}): Promise<{ code: number | null; output: string; truncated: boolean }> {
  // This is the sole process boundary for sandbox work; collecting stdout and
  // stderr together keeps failures actionable, while onData supports tool updates.
  return new Promise((resolve, reject) => {
    const child = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd });
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
      else resolve({ code, output: Buffer.concat(chunks).toString(), truncated });
    });
  });
}

function shellQuote(value: string): string {
  // Values reach a shell only at a few fixed command sites; quoting preserves
  // package names and paths as data rather than allowing them to become syntax.
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  const verbose = Boolean(pi.getFlag("sandbox-verbose")) || process.argv.includes("--verbose");
  const logVerbose = (message: string) => {
    if (verbose) process.stderr.write(`[podman-sandbox] ${message}\n`);
  };
  const hostCwd = path.resolve(process.cwd());
  const guard = makeGuard(hostCwd);
  // A per-process name prevents concurrent Pi sessions from sharing mutable
  // package state or accidentally removing one another's containers.
  const container = `pi-sandbox-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : 1000;
  let image = "";
  let customImage = false;
  // Changing the embedded build recipe changes the tag, so an old local image
  // cannot masquerade as the current security/runtime contract.
  const defaultImage = `localhost/pi-sandbox:${crypto.createHash("sha256").update(EMBEDDED_DOCKERFILE).digest("hex").slice(0, 16)}`;
  let podmanChecked = false;
  let started = false;
  let starting: Promise<void> | undefined;

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

  async function ensureImage() {
    // A caller-selected image must already exist; only the extension-owned
    // recipe is built automatically so a typo cannot trigger an implicit pull.
    await checkPodman();
    if (!image) image = defaultImage;
    const exists = await runPodman(["image", "exists", image], { timeout: 30 });
    if (exists.code === 0) {
      logVerbose(`sandbox image is available: ${image}`);
      return;
    }
    if (exists.code !== 1) throw new Error(`podman image exists failed (${exists.code}): ${exists.output.trim()}`);
    if (customImage) throw new Error(`sandbox image not found locally: ${image}`);

    const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sandbox-image-"));
    const containerfile = path.join(buildDir, "Containerfile");
    try {
      // A real Containerfile avoids Podman's /dev/stdin dependency, which is
      // unavailable in some service/RPC launch environments.
      logVerbose(`building embedded sandbox image: ${image}`);
      await fs.writeFile(containerfile, EMBEDDED_DOCKERFILE);
      const built = await runPodman(["build", "--tag", image, "--file", containerfile, hostCwd], { cwd: hostCwd, timeout: 600 });
      if (built.code !== 0) throw new Error(`podman build failed (${built.code}): ${built.output.trim()}`);
      logVerbose(`embedded sandbox image built: ${image}`);
    } finally {
      await fs.rm(buildDir, { recursive: true, force: true });
    }
  }

  async function ensureContainer() {
    if (started) return;
    await ensureImage();
    if (starting) return starting;
    logVerbose(`starting container ${container} as ${hostUid}:${hostGid} with project mount ${hostCwd}`);
    starting = (async () => {
      const result = await runPodman([
        "run", "-d", "--name", container,
        "--volume", `${hostCwd}:${hostCwd}:rw`,
        "--userns=keep-id", "--user", `${hostUid}:${hostGid}`,
        "--workdir", hostCwd,
        "--cap-drop=ALL",
        // APT's helper transitions need this small set, but it must not flow
        // into ordinary command processes; exec() clears it before user code.
        "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE",
        "--security-opt=no-new-privileges",
        "--pids-limit=512", image, "sleep", "infinity",
      ]);
      if (result.code !== 0) throw new Error(`podman run failed (${result.code}): ${result.output.trim()}`);
      started = true;
      logVerbose(`container is ready: ${container}`);
    })();
    try { await starting; } finally { starting = undefined; }
  }

  const exec = async (command: string, options: RunOptions = {}) => {
    await ensureContainer();
    // Package maintenance is the only caller that requests container root.
    // Ordinary tool commands have their capability sets cleared before the
    // user-controlled shell starts, because Podman exec inherits container caps.
    const execution = options.user
      ? ["sh", "-lc", command]
      : ["setpriv", "--inh-caps=-all", "--ambient-caps=-all", "--", "sh", "-lc", command];
    logVerbose(`executing sandbox command as ${options.user ? `container user ${options.user}` : "mapped user with capabilities cleared"} in ${options.cwd ?? hostCwd}`);
    return runPodman([
      "exec", ...(options.user ? ["--user", options.user] : []), "--workdir", options.cwd ?? hostCwd, container,
      ...execution,
    ], options);
  };

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
      const result = await exec(command, { ...options, cwd: checkedCwd });
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
    description: `${bashTool.description} For source text lookup, use search; shell grep/rg commands are discouraged.`,
    promptGuidelines: [
      "Use the native search tool for source text lookup instead of running grep, rg, or ripgrep in bash.",
    ],
  });

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
        // Restrict the model to additive Debian package names. Running this
        // command as namespace root is deliberate; uninstall/upgrade remain
        // user-only slash commands because they mutate the base environment.
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
    // Maintenance actions that can alter package state remain user initiated,
    // separate from the narrower model-callable additive package interface.
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
        remove: { command: `apt-get purge -y ${quoted} && apt-get autoremove --purge -y && (grep -vxF ${quoted} /tmp/pi-sandbox-explicit-packages > /tmp/pi-sandbox-explicit-packages.new 2>/dev/null || true) && (test -f /tmp/pi-sandbox-explicit-packages.new && mv /tmp/pi-sandbox-explicit-packages.new /tmp/pi-sandbox-explicit-packages || true)`, user: "0" },
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
    // Fail visibly before the first tool call if rootless Podman is unavailable,
    // and build the extension-owned image at startup rather than lazily failing
    // after the model has already requested sandbox work.
    image = String(pi.getFlag("sandbox-image") ?? "");
    customImage = Boolean(image);
    try {
      await checkPodman();
      await ensureImage();
      await ensureImage();
      ctx.ui.notify(`Podman sandbox ready: ${image || defaultImage}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logVerbose(`startup failed: ${message}`);
      ctx.ui.notify(`Podman sandbox startup failed: ${message}`, "error");
    }
  });
  pi.on("session_shutdown", async () => {
    if (started) {
      logVerbose(`removing session container: ${container}`);
      await runPodman(["rm", "-f", container]).catch(() => undefined);
    }
  });
}
