import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sandboxExtension from "../podman-sandbox.ts";

// This adapter captures the exact AgentTool instances registered by production
// code. A scripted test command can invoke those callbacks without a provider,
// while still exercising the same host guards and Podman operation closures.
const tools = new Map<string, any>();
// Lifecycle events are forwarded so the tested extension performs real startup
// image validation/build and its normal container cleanup on RPC shutdown.
const innerEvents = new Map<string, Function[]>();
let approvalDecision = false;
const approvalPrompts: { title: string; message: string }[] = [];
let restartInnerSession: (() => Promise<void>) | undefined;
let currentTestContext: any;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function tool(name: string, input: unknown, cwd = process.cwd()): Promise<any> {
  const selected = tools.get(name);
  assert(selected, `sandbox tool not registered: ${name}`);
  return selected.execute(`security-${name}`, input, undefined, undefined, { cwd });
}

async function expectDenied(name: string, input: unknown, outsidePath: string, cwd = process.cwd()) {
  // Different Pi tools can reject before reaching their operation callback;
  // either outcome is safe if it prevents external content from being returned.
  try {
    const result = await tool(name, input, cwd);
    const rendered = JSON.stringify(result);
    const canary = process.env.PI_SANDBOX_HOST_CANARY;
    if (canary) assert(!rendered.includes(canary), `${name} returned the host canary`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const canary = process.env.PI_SANDBOX_HOST_CANARY;
    if (canary) assert(!message.includes(canary), `${name} error exposed the host canary`);
    assert(
      message.includes("path escapes project directory") || message.startsWith("Path not found:"),
      `${name} failed for the wrong reason: ${message}`,
    );
    return;
  }
  throw new Error(`${name} unexpectedly accepted outside-project path ${outsidePath}`);
}

async function snapshot(file: string) {
  const [content, stat] = await Promise.all([fs.readFile(file), fs.stat(file, { bigint: true })]);
  return {
    content: content.toString("base64"),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

async function unchanged(file: string, before: Awaited<ReturnType<typeof snapshot>>, label: string) {
  assert(JSON.stringify(await snapshot(file)) === JSON.stringify(before), `${label} changed an outside host file`);
}

async function expectDeniedAndUnchanged(
  name: string,
  input: unknown,
  outsidePath: string,
  file: string,
  before: Awaited<ReturnType<typeof snapshot>>,
  label: string,
) {
  let failure: unknown;
  try {
    await expectDenied(name, input, outsidePath);
  } catch (error) {
    failure = error;
  }
  await unchanged(file, before, label);
  if (failure) throw failure;
}

function skipped(reason: string): Error {
  return Object.assign(new Error(reason), { securityTestSkipped: true });
}

async function bash(command: string, cwd = process.cwd(), timeout = 20) {
  const result = await tool("bash", { command, timeout }, cwd);
  const formattedOutput = String(result.structuredContent.output);
  const extract = (stream: "stdout" | "stderr") => {
    const match = formattedOutput.match(new RegExp(`(?:^|\\n)\\[${stream}\\]\\n([\\s\\S]*?)(?=\\n\\[(?:stdout|stderr)\\]|\\n\\[exit code = )`));
    return match?.[1] ?? "";
  };
  return {
    output: extract("stdout"),
    stderr: extract("stderr"),
    formattedOutput,
    exit_code: result.structuredContent.exit_code as number,
  };
}

export default function (pi: ExtensionAPI) {
  // Lifecycle events and user-only maintenance commands are forwarded so the
  // test harness can exercise real reset/package behavior through RPC.
  const bridge = {
    registerFlag: (name: string, options: any) => pi.registerFlag(name as any, options),
    getFlag: (name: string) => pi.getFlag(name as any),
    registerTool: (definition: any) => {
      tools.set(definition.name, definition);
      // Registering the same definitions in this Pi session lets the harness
      // verify real active/hidden exposure rather than metadata in isolation.
      pi.registerTool(definition);
    },
    registerCommand: (name: string, options: any) => pi.registerCommand(name as any, options),
    appendEntry: (customType: string, data: unknown) => pi.appendEntry(customType, data),
    on: (event: string, handler: Function) => {
      const handlers = innerEvents.get(event) ?? [];
      handlers.push(handler);
      innerEvents.set(event, handlers);
    },
  };
  sandboxExtension(bridge as unknown as ExtensionAPI);

  pi.on("session_start", async (event, ctx) => {
    const ui = new Proxy(ctx.ui, {
      get(target, property, receiver) {
        if (property === "confirm") return async (title: string, message: string) => {
          approvalPrompts.push({ title, message });
          return approvalDecision;
        };
        return Reflect.get(target, property, receiver);
      },
    });
    const testContext = new Proxy(ctx, {
      get(target, property, receiver) {
        if (property === "hasUI") return true;
        if (property === "ui") return ui;
        return Reflect.get(target, property, receiver);
      },
    });
    restartInnerSession = async () => {
      for (const handler of innerEvents.get("session_start") ?? []) await handler(event, testContext);
    };
    currentTestContext = testContext;
    await restartInnerSession();
  });
  pi.on("session_shutdown", async () => {
    for (const handler of innerEvents.get("session_shutdown") ?? []) await handler();
  });

  pi.registerCommand("sandbox-security-test", {
    description: "Run security-boundary tests for the Podman sandbox tools",
    handler: async (_args, ctx) => {
      // Every check records its own result so one failure does not hide evidence
      // from the remaining independent boundary tests.
      const results: { name: string; passed: boolean; skipped?: boolean; detail?: string }[] = [];
      let outsideDir = "";
      let outsideTmpDir = "";
      let outsideFile = "";
      const hostCanary = process.env.PI_SANDBOX_HOST_CANARY;
      const fixtureId = process.env.PI_SANDBOX_FIXTURE_ID;
      assert(hostCanary && /^[a-f0-9]{32}$/.test(hostCanary), "host-canary token was not provided by the RPC harness");
      assert(fixtureId && /^[a-f0-9]{16}$/.test(fixtureId), "fixture identifier was not provided by the RPC harness");
      const insideDir = path.join(process.cwd(), `security-test-${process.pid}-${fixtureId}`);
      // The host-only fixture is a sibling of the project, outside the bind mount
      // and on the same filesystem for the hard-link probe where supported.
      const insideFile = path.join(insideDir, "written-by-sandbox.txt");
      const manyMatchesFile = path.join(insideDir, "many-matches.txt");
      const symlinkPath = path.join(insideDir, "outside-link.txt");
      const parentSymlinkPath = path.join(insideDir, "outside-parent");
      const containerSymlinkPath = path.join(insideDir, "container-created-outside-link.txt");
      const containerHardlinkPath = path.join(insideDir, "container-created-hardlink.txt");
      const sentinel = `HOST_SECRET_${hostCanary}`;
      const projectMarker = `sandbox-write-${process.pid}`;
      const record = async (name: string, test: () => Promise<void | string>) => {
        try {
          const detail = await test();
          results.push({ name, passed: true, ...(typeof detail === "string" ? { detail } : {}) });
        } catch (error) {
          const isSkipped = Boolean((error as any)?.securityTestSkipped);
          results.push({
            name,
            passed: false,
            ...(isSkipped ? { skipped: true } : {}),
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        if (process.env.PI_SANDBOX_SECURITY_VERBOSE === "1") {
          const result = results[results.length - 1];
          const marker = result.skipped ? "SKIP" : result.passed ? "PASS" : "FAIL";
          const detail = result.detail ? `: ${result.detail}` : "";
          ctx.ui.notify(`SECURITY_TEST_PROGRESS:${marker}:${name}${detail}`, result.passed ? "info" : "warning");
        }
      };

      try {
        outsideDir = process.env.PI_SANDBOX_SECURITY_OUTSIDE ?? "";
        outsideTmpDir = process.env.PI_SANDBOX_SECURITY_TMP ?? "";
        assert(outsideDir && outsideTmpDir, "RPC harness did not provide disposable host fixture directories");
        assert(!isInside(process.cwd(), outsideDir) && !isInside(process.cwd(), outsideTmpDir), "host fixtures must be outside the project");
        await fs.mkdir(outsideDir);
        await fs.mkdir(outsideTmpDir);
        outsideFile = path.join(outsideDir, "host-only-secret.txt");
        const tmpSecretFile = path.join(outsideTmpDir, "tmp-host-secret.txt");
        const outsideWriteFile = path.join(outsideDir, "write-target.txt");
        const outsideSecretDir = path.join(outsideDir, "secret-directory");
        await fs.mkdir(outsideSecretDir);
        await fs.writeFile(outsideFile, sentinel, { mode: 0o600 });
        await fs.writeFile(tmpSecretFile, sentinel, { mode: 0o600 });
        await fs.writeFile(outsideWriteFile, "outside-original", { mode: 0o600 });
        await fs.mkdir(insideDir, { recursive: true });
        await fs.symlink(outsideFile, symlinkPath);
        await fs.symlink(outsideDir, parentSymlinkPath);
        const outsideSnapshot = await snapshot(outsideFile);
        const tmpSnapshot = await snapshot(tmpSecretFile);
        const writeSnapshot = await snapshot(outsideWriteFile);

        // Direct, relative-traversal, and symlink paths all target the same
        // unique host canary so accidental disclosure is detectable.
        await record("read rejects an absolute path outside the project without leaking contents", async () => {
          await expectDenied("read", { path: outsideFile }, outsideFile);
        });
        await record("read rejects relative traversal outside the project", async () => {
          const traversal = path.relative(process.cwd(), outsideFile);
          await expectDenied("read", { path: traversal }, traversal);
        });
        await record("write rejects an absolute outside path without modifying the host file", async () => {
          await expectDeniedAndUnchanged("write", { path: outsideWriteFile, content: "overwrite-attempt" }, outsideWriteFile, outsideWriteFile, writeSnapshot, "absolute write");
        });
        await record("write rejects relative traversal without modifying the host file", async () => {
          const traversal = path.relative(process.cwd(), outsideWriteFile);
          await expectDeniedAndUnchanged("write", { path: traversal, content: "overwrite-attempt" }, traversal, outsideWriteFile, writeSnapshot, "traversal write");
        });
        await record("edit rejects an absolute outside path without modifying the host file", async () => {
          await expectDeniedAndUnchanged("edit", { path: outsideWriteFile, edits: [{ oldText: "outside-original", newText: "overwrite-attempt" }] }, outsideWriteFile, outsideWriteFile, writeSnapshot, "absolute edit");
        });
        await record("read rejects a host file under the system temporary directory without leaking contents", async () => {
          await expectDenied("read", { path: tmpSecretFile }, tmpSecretFile);
        });
        await record("write rejects a host file under the system temporary directory without modifying it", async () => {
          await expectDeniedAndUnchanged("write", { path: tmpSecretFile, content: "tmp-overwrite" }, tmpSecretFile, tmpSecretFile, tmpSnapshot, "temporary-directory write");
        });
        await record("write rejects a new file outside the project via relative traversal", async () => {
          const target = path.relative(process.cwd(), path.join(outsideDir, "new-traversal-target.txt"));
          let failure: unknown;
          try {
            await expectDenied("write", { path: target, content: "outside-create-attempt" }, target);
          } catch (error) {
            failure = error;
          }
          const created = await fs.stat(path.join(outsideDir, "new-traversal-target.txt")).then(() => true, () => false);
          assert(!created, "write created a host file through relative traversal");
          if (failure) throw failure;
        });
        await record("write rejects a missing child beneath an outside-pointing parent symlink", async () => {
          const target = path.join(parentSymlinkPath, "new-child.txt");
          let failure: unknown;
          try {
            await expectDenied("write", { path: target, content: "outside-create-attempt" }, target);
          } catch (error) {
            failure = error;
          }
          const created = await fs.stat(path.join(outsideDir, "new-child.txt")).then(() => true, () => false);
          assert(!created, "write created a host file through parent symlink");
          if (failure) throw failure;
        });
        await record("read rejects a symlink escaping the project", async () => {
          await expectDenied("read", { path: symlinkPath }, symlinkPath);
        });
        await record("write rejects a symlink escaping the project without modifying the target", async () => {
          await expectDeniedAndUnchanged("write", { path: symlinkPath, content: "overwrite-attempt" }, symlinkPath, outsideFile, outsideSnapshot, "symlink write");
        });
        await record("edit rejects a symlink escaping the project without modifying the target", async () => {
          await expectDeniedAndUnchanged("edit", { path: symlinkPath, edits: [{ oldText: sentinel, newText: "overwrite-attempt" }] }, symlinkPath, outsideFile, outsideSnapshot, "symlink edit");
        });
        await record("ls rejects a project symlink to an outside directory", async () => {
          await expectDenied("ls", { path: parentSymlinkPath }, parentSymlinkPath);
        });
        await record("hidden legacy grep callback rejects outside roots", async () => {
          await expectDenied("grep", { pattern: hostCanary, path: outsideDir, literal: true }, outsideDir);
        });
        await record("hidden legacy grep callback rejects a symlink to an outside root", async () => {
          await expectDenied("grep", { pattern: hostCanary, path: parentSymlinkPath, literal: true }, parentSymlinkPath);
        });

        await record("native search is available and legacy grep is hidden", async () => {
          const search = tools.get("search");
          const grep = tools.get("grep");
          assert(search && grep, "search and legacy grep definitions were not registered");
          assert(grep.exposure === "hidden", `legacy grep exposure is ${grep.exposure ?? "default"}`);
          const activeTools = pi.getActiveTools();
          assert(activeTools.includes("search"), "native search is not active for the model");
          assert(!activeTools.includes("grep"), "legacy grep remains model-visible");
          assert(search.description.includes("grep/rg") && search.promptGuidelines.some((line: string) => line.includes("instead of")), "search guidance does not discourage shell grep/rg");
        });
        await record("search rejects an outside-project root", async () => {
          await expectDenied("search", { query: sentinel, path: outsideDir }, outsideDir);
        });
        await record("search rejects a project symlink to an outside root", async () => {
          await expectDenied("search", { query: sentinel, path: parentSymlinkPath }, parentSymlinkPath);
        });
        await record("find rejects an outside-project search root", async () => {
          await expectDenied("find", { pattern: "*", path: outsideDir }, outsideDir);
        });
        await record("find rejects a project symlink to an outside root", async () => {
          await expectDenied("find", { pattern: "*", path: parentSymlinkPath }, parentSymlinkPath);
        });
        // A rejected cwd proves commands cannot change their execution root to
        // a host directory even though command text itself is user-controlled.
        await record("bash rejects an outside-project working directory", async () => {
          try {
            await bash("pwd", outsideDir);
          } catch {
            return;
          }
          throw new Error("bash accepted an outside-project working directory");
        });
        await record("bash rejects a project symlink as its working directory", async () => {
          try {
            await bash("pwd", parentSymlinkPath);
          } catch {
            return;
          }
          throw new Error("bash accepted a symlink to an outside working directory");
        });
        // Namespace identity and an unmounted sentinel test the host boundary;
        // file ownership confirms that legitimate project edits still persist.
        // A real command invocation guards against regressions where container
        // startup appears ready but the model-facing bash operation still fails.
        await record("bash tool executes a simple date command", async () => {
          const result = await bash("date -u +%Y-%m-%d");
          assert(result.exit_code === 0 && /^\d{4}-\d{2}-\d{2}$/.test(result.output.trim()), `date failed: ${result.output}`);
        });
        await record("bash inlines small streams and deletes their .out files", async () => {
          const sessionPrefix = `session-${String(ctx.sessionManager.getSessionId()).replace(/[^A-Za-z0-9_-]/g, "_")}-`;
          const outputDir = path.join(process.cwd(), ".out");
          const listFiles = async () => (await fs.readdir(outputDir)).filter((name) => name.startsWith(sessionPrefix)).sort();
          const before = await listFiles();
          assert((await fs.readFile(path.join(outputDir, ".gitignore"), "utf8")) === "*\n", ".out/.gitignore did not ignore generated logs");
          const result = await bash("printf small-out; printf small-err >&2");
          const after = await listFiles();
          assert(result.exit_code === 0, `small-output command failed: ${result.formattedOutput}`);
          assert(result.output === "small-out" && result.stderr === "small-err", `small streams were not fully inlined: ${result.formattedOutput}`);
          assert(JSON.stringify(before) === JSON.stringify(after), "small-output host files were retained");
        });
        await record("bash omits headers for empty stdout and stderr", async () => {
          const result = await bash("true");
          assert(result.formattedOutput === "[exit code = 0]", `empty command returned unexpected output: ${result.formattedOutput}`);
        });
        await record("bash previews 128 lines and saves complete stdout and stderr in readable project .out files", async () => {
          const result = await tool("bash", {
            command: `i=1; while [ "$i" -le 4530 ]; do printf 'stdout-%s\\n' "$i"; printf 'stderr-%s\\n' "$i" >&2; i=$((i + 1)); done; exit 213`,
            timeout: 30,
          });
          const summary = String(result.structuredContent.output);
          assert(result.structuredContent.exit_code === 213, `bash exit code was not preserved: ${result.structuredContent.exit_code}`);
          const stdoutMatch = summary.match(/^\[\.\.\. full 4530 lines output to (.+\.out)\]$/m);
          const stderrMatch = summary.match(/^\[\.\.\. full 4530 lines output to (.+\.err)\]$/m);
          assert(stdoutMatch && stderrMatch, `full-output markers missing: ${summary}`);
          assert(path.dirname(stdoutMatch[1]) === path.join(process.cwd(), ".out") && path.dirname(stderrMatch[1]) === path.join(process.cwd(), ".out"), "full-output files were not written below project .out/");
          assert(summary.startsWith(`[stdout]\n${Array.from({ length: 128 }, (_, index) => `stdout-${index + 1}`).join("\n")}\n`), "stdout preview did not contain exactly the first 128 lines");
          assert(summary.includes(`[stderr]\n${Array.from({ length: 128 }, (_, index) => `stderr-${index + 1}`).join("\n")}\n`), "stderr preview did not contain exactly the first 128 lines");
          assert(!summary.includes("stdout-129") && !summary.includes("stderr-129"), "the preview included output beyond 128 lines");
          assert(summary.endsWith("[exit code = 213]"), `exit code missing from summary: ${summary}`);
          try {
            const [stdout, stderr] = await Promise.all([fs.readFile(stdoutMatch[1], "utf8"), fs.readFile(stderrMatch[1], "utf8")]);
            assert(stdout.startsWith("stdout-1\n") && stdout.endsWith("stdout-4530\n"), "stdout file did not contain the complete output");
            assert(stderr.startsWith("stderr-1\n") && stderr.endsWith("stderr-4530\n"), "stderr file did not contain the complete output");
            const [readStdout, readStderr] = await Promise.all([
              tool("read", { path: stdoutMatch[1], offset: 4530, limit: 1 }),
              tool("read", { path: stderrMatch[1], offset: 4530, limit: 1 }),
            ]);
            assert(JSON.stringify(readStdout).includes("stdout-4530"), "Pi read tool could not open retained stdout output");
            assert(JSON.stringify(readStderr).includes("stderr-4530"), "Pi read tool could not open retained stderr output");
          } finally {
            await Promise.all([fs.rm(stdoutMatch[1], { force: true }), fs.rm(stderrMatch[1], { force: true })]);
          }
        });
        await record("container runs as the mapped non-root agent user", async () => {
          const result = await bash("printf '%s:%s' \"$(id -u)\" \"$(id -g)\"");
          assert(result.exit_code === 0, `id failed: ${result.output}`);
          assert(result.output.trim() === `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, `unexpected container identity: ${result.output.trim()}`);
        });
        await record("container cannot read an unmounted host sentinel", async () => {
          const result = await bash(`if test -r ${quote(outsideFile)}; then cat ${quote(outsideFile)}; exit 41; else echo isolated; fi`);
          assert(result.exit_code === 0 && result.output.trim() === "isolated", "container could access an unmounted host canary");
        });
        await record("container cannot read a host canary under /tmp", async () => {
          const result = await bash(`if test -r ${quote(tmpSecretFile)}; then cat ${quote(tmpSecretFile)}; exit 41; else echo isolated; fi`);
          assert(result.exit_code === 0 && result.output.trim() === "isolated", "container could access the host /tmp canary");
        });
        await record("container cannot create a hard link to an unmounted host canary", async () => {
          const result = await bash(`ln -- ${quote(outsideFile)} ${quote(containerHardlinkPath)}`);
          assert(result.exit_code !== 0, "container created a hard link to an outside host file");
          assert(!(await fs.lstat(containerHardlinkPath).then(() => true, () => false)), "host canary hard-link alias appeared in the project");
          await unchanged(outsideFile, outsideSnapshot, "container hard-link attempt");
        });
        await record("container-created symlink cannot read an unmounted host file", async () => {
          const link = await bash(`ln -s -- ${quote(outsideFile)} ${quote(containerSymlinkPath)}`);
          assert(link.exit_code === 0, `container could not create the symlink fixture: ${link.output}`);
          const result = await bash(`cat ${quote(containerSymlinkPath)}`);
          assert(result.exit_code !== 0, "container followed its symlink to a host file");
          assert(!result.output.includes(hostCanary), "container disclosed the host canary through its symlink");
          await unchanged(outsideFile, outsideSnapshot, "container-created symlink read");
        });
        await record("container-created symlink cannot modify an unmounted host file", async () => {
          const result = await bash(`printf symlink-overwrite > ${quote(containerSymlinkPath)}`);
          assert(result.exit_code !== 0, "container modified a host file through its symlink");
          await unchanged(outsideFile, outsideSnapshot, "container-created symlink write");
        });
        await record("container writes project files with host-agent ownership", async () => {
          const result = await bash(`printf ${quote(projectMarker)} > ${quote(insideFile)} && stat -c '%u:%g' ${quote(insideFile)}`);
          assert(result.exit_code === 0, `project write failed: ${result.output}`);
          assert((await fs.readFile(insideFile, "utf8")) === projectMarker, "project write not visible on host");
          const stat = await fs.stat(insideFile);
          assert(stat.uid === (process.getuid?.() ?? 1000) && stat.gid === (process.getgid?.() ?? 1000), `wrong host ownership: ${stat.uid}:${stat.gid}`);
        });
        await record("Bash rootfs is read-only while project and temporary mounts remain writable", async () => {
          const result = await bash("options=$(findmnt -n -o OPTIONS /); case \",$options,\" in *,ro,*) ;; *) exit 31;; esac; temp=/tmp/pi-sandbox-readonly-$$; printf ok > \"$temp\" && test \"$(cat \"$temp\")\" = ok && rm \"$temp\" && printf readonly");
          assert(result.exit_code === 0 && result.output.trim() === "readonly", `read-only rootfs assertion failed: ${result.formattedOutput}`);
        });
        await record("mapped-user direct TCP egress is rejected promptly", async () => {
          const server = net.createServer();
          const connection = new Promise<void>((resolve) => server.once("connection", (socket) => {
            socket.destroy();
            resolve();
          }));
          try {
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "0.0.0.0", () => {
                server.off("error", reject);
                resolve();
              });
            });
            const address = server.address();
            assert(address && typeof address !== "string", "test receiver did not bind a TCP port");
            const startedAt = Date.now();
            const result = await bash(`timeout 6 bash -c 'printf bypass > /dev/tcp/host.containers.internal/${address.port}'`, process.cwd(), 10);
            const elapsedMs = Date.now() - startedAt;
            assert(result.exit_code !== 0, "mapped bash user reached a direct host TCP destination");
            assert(elapsedMs < 5000, `direct egress was dropped until timeout instead of rejected (${elapsedMs}ms)`);
            const accepted = await Promise.race([
              connection.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
            ]);
            assert(!accepted, "host receiver accepted direct egress from mapped bash");
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        });
        await record("sandbox proxy asks before denying an unlisted hostname/port pair", async () => {
          const command = `bash -c 'proxy_user=\${HTTP_PROXY#http://}; proxy_user=\${proxy_user%%@*}; proxy_port=\${HTTP_PROXY##*:}; auth=$(printf "%s:" "$proxy_user" | base64 -w 0); exec 3<>/dev/tcp/host.containers.internal/$proxy_port; printf "GET http://unlisted.invalid/ HTTP/1.1\\r\\nHost: unlisted.invalid\\r\\nProxy-Authorization: Basic %s\\r\\nConnection: close\\r\\n\\r\\n" "$auth" >&3; IFS= read -r status <&3; printf "%s\\n" "$status"; case "$status" in "HTTP/1.1 403"*) exit 0;; *) exit 42;; esac'`;
          const result = await bash(command, process.cwd(), 10);
          assert(result.exit_code === 0 && result.output.trim().startsWith("HTTP/1.1 403"), `proxy did not deny the unlisted DNS destination: ${result.formattedOutput}`);
          const prompt = approvalPrompts.at(-1);
          assert(prompt?.title === "Allow unlisted.invalid:80?" && prompt.message === "", "approval prompt asked for more than the detected hostname and port");
          assert(!ctx.sessionManager.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === "sandbox-egress-allow" && entry.data?.hostname === "unlisted.invalid" && entry.data?.port === 80), "denied hostname/port pair was persisted to the session branch");
        });
        await record("approved proxy hostname/port is persisted to the active session branch", async () => {
          approvalDecision = true;
          try {
            const command = `bash -c 'proxy_user=\${HTTP_PROXY#http://}; proxy_user=\${proxy_user%%@*}; proxy_port=\${HTTP_PROXY##*:}; auth=$(printf "%s:" "$proxy_user" | base64 -w 0); exec 3<>/dev/tcp/host.containers.internal/$proxy_port; printf "GET http://approved.invalid/ HTTP/1.1\\r\\nHost: approved.invalid\\r\\nProxy-Authorization: Basic %s\\r\\nConnection: close\\r\\n\\r\\n" "$auth" >&3; IFS= read -r status <&3; printf "%s\\n" "$status"; case "$status" in "HTTP/1.1 502"*) exit 0;; *) exit 42;; esac'`;
            const result = await bash(command, process.cwd(), 10);
            assert(result.exit_code === 0 && result.output.trim().startsWith("HTTP/1.1 502"), `approved hostname did not pass the allowlist gate to DNS resolution: ${result.formattedOutput}`);
          } finally {
            approvalDecision = false;
          }
          const prompt = approvalPrompts.at(-1);
          assert(prompt?.title === "Allow approved.invalid:80?" && prompt.message === "", "approval prompt asked for more than the detected hostname and port");
          const approvals = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "sandbox-egress-allow" && entry.data?.hostname === "approved.invalid" && entry.data?.port === 80);
          assert(approvals.length === 1, `approval was not stored exactly once for approved.invalid:80 in the active session branch: ${approvals.length}`);
          assert(restartInnerSession, "test adapter could not replay session startup");
          const promptsBeforeRestore = approvalPrompts.length;
          await restartInnerSession();
          const retryCommand = `bash -c 'proxy_user=\${HTTP_PROXY#http://}; proxy_user=\${proxy_user%%@*}; proxy_port=\${HTTP_PROXY##*:}; auth=$(printf "%s:" "$proxy_user" | base64 -w 0); exec 3<>/dev/tcp/host.containers.internal/$proxy_port; printf "GET http://approved.invalid/ HTTP/1.1\\r\\nHost: approved.invalid\\r\\nProxy-Authorization: Basic %s\\r\\nConnection: close\\r\\n\\r\\n" "$auth" >&3; IFS= read -r status <&3; printf "%s\\n" "$status"; case "$status" in "HTTP/1.1 502"*) exit 0;; *) exit 42;; esac'`;
          const restored = await bash(retryCommand, process.cwd(), 10);
          assert(restored.exit_code === 0 && restored.output.trim().startsWith("HTTP/1.1 502"), `restored hostname did not pass the allowlist gate: ${restored.formattedOutput}`);
          assert(approvalPrompts.length === promptsBeforeRestore, "session startup did not restore the branch approval");

          const alternateBranchManager = new Proxy(currentTestContext.sessionManager, {
            get(target, property) {
              if (property === "getBranch") return () => target.getBranch().filter((entry: any) => !(entry.type === "custom" && entry.customType === "sandbox-egress-allow" && entry.data?.hostname === "approved.invalid" && entry.data?.port === 80));
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const alternateBranchContext = new Proxy(currentTestContext, {
            get(target, property, receiver) {
              if (property === "sessionManager") return alternateBranchManager;
              return Reflect.get(target, property, receiver);
            },
          });
          for (const handler of innerEvents.get("session_tree") ?? []) {
            await handler({ type: "session_tree", newLeafId: "alternate-branch", oldLeafId: ctx.sessionManager.getLeafId() }, alternateBranchContext);
          }
          const promptsBeforeAlternateBranch = approvalPrompts.length;
          const branchDenied = await bash(retryCommand, process.cwd(), 10);
          assert(branchDenied.exit_code === 42 && branchDenied.output.trim().startsWith("HTTP/1.1 403"), `approval leaked into a branch without its custom entry: ${branchDenied.formattedOutput}`);
          assert(approvalPrompts.length === promptsBeforeAlternateBranch + 1, "branch without the approval did not request confirmation again");
          await restartInnerSession();
          const branchRestored = await bash(retryCommand, process.cwd(), 10);
          assert(branchRestored.exit_code === 0 && branchRestored.output.trim().startsWith("HTTP/1.1 502"), `returning to the approved branch did not restore access: ${branchRestored.formattedOutput}`);

          const promptsBeforeHttps = approvalPrompts.length;
          const httpsCommand = `bash -c 'proxy_user=\${HTTP_PROXY#http://}; proxy_user=\${proxy_user%%@*}; proxy_port=\${HTTP_PROXY##*:}; auth=$(printf "%s:" "$proxy_user" | base64 -w 0); exec 3<>/dev/tcp/host.containers.internal/$proxy_port; printf "CONNECT approved.invalid:443 HTTP/1.1\\r\\nHost: approved.invalid:443\\r\\nProxy-Authorization: Basic %s\\r\\nConnection: close\\r\\n\\r\\n" "$auth" >&3; IFS= read -r status <&3; printf "%s\\n" "$status"; case "$status" in "HTTP/1.1 403"*) exit 0;; *) exit 42;; esac'`;
          const httpsDenied = await bash(httpsCommand, process.cwd(), 10);
          assert(httpsDenied.exit_code === 0 && httpsDenied.output.trim().startsWith("HTTP/1.1 403"), `HTTP/80 approval incorrectly allowed HTTPS/443: ${httpsDenied.formattedOutput}`);
          assert(approvalPrompts.length === promptsBeforeHttps + 1, "HTTPS/443 did not require its own approval");
          const httpsPrompt = approvalPrompts.at(-1);
          assert(httpsPrompt?.title === "Allow approved.invalid:443?" && httpsPrompt.message === "", "HTTPS prompt included anything beyond the detected hostname and port");
        });
        // Structured matches let callers consume results without reparsing prose.
        await record("search returns structured project matches", async () => {
          const searchPath = path.relative(process.cwd(), insideDir);
          const result = await tool("search", { query: projectMarker, path: searchPath, literal: true, limit: 10 });
          const matches = result.structuredContent.matches as { path: string; line: number; text: string }[];
          assert(!result.structuredContent.truncated, "small fixture search unexpectedly truncated");
          assert(matches.some((match) => match.text.includes(projectMarker) && match.path.endsWith("written-by-sandbox.txt")), `native search omitted the project fixture: ${JSON.stringify(result.structuredContent)} / ${JSON.stringify(result.content)}`);
        });
        await record("search result count is bounded for model context", async () => {
          await fs.writeFile(manyMatchesFile, "repeat\nrepeat\nrepeat\n");
          const searchPath = path.relative(process.cwd(), insideDir);
          const result = await tool("search", { query: "repeat", path: searchPath, literal: true, limit: 1 });
          assert(result.structuredContent.matches.length === 1, "search exceeded the requested match limit");
          assert(result.structuredContent.truncated, "search did not report omitted matches");
        });
        // NET_ADMIN belongs only to extension-owned startup firewall setup.
        // Verify Bash has NNP set, no effective capabilities, and unchanged IDs.
        await record("ordinary sandbox commands cannot change uid, retain capabilities, or write dpkg state", async () => {
          const result = await bash("cap=$(awk '/^CapEff:/{print $2}' /proc/self/status); nnp=$(awk '/^NoNewPrivs:/{print $2}' /proc/self/status); test \"$cap\" = 0000000000000000 && test \"$nnp\" = 1 && test \"$(id -ru)\" = \"$(id -u)\" && test ! -w /var/lib/dpkg/status && printf '%s:%s' \"$cap\" \"$nnp\"");
          assert(result.exit_code === 0, `ordinary command retained UID transition capability or dpkg access: ${result.output}`);
        });
        await record("package tool builds an APT image for curl and makes it available to Bash", async () => {
          const install = await tool("sandbox", { pkg_add: "curl" });
          assert(install.details?.exitCode === 0 && !install.isError, `sandbox.pkg_add curl failed: ${JSON.stringify(install.content)}`);
          const fixtureId = process.env.PI_SANDBOX_FIXTURE_ID;
          if (fixtureId) assert(String(install.details.image).startsWith(`localhost/pi-sandbox-${fixtureId}-apt:`), `package image escaped the isolated test namespace: ${install.details.image}`);
          const verify = await bash("curl --version");
          assert(verify.exit_code === 0 && verify.output.startsWith("curl "), `curl was not available after pkg_add: ${verify.formattedOutput}`);
        });
        await record("package tool accepts a list of packages in one build", async () => {
          const install = await tool("sandbox", { pkg_add: ["procps", "netbase"] });
          assert(install.details?.exitCode === 0 && !install.isError, `sandbox.pkg_add list failed: ${JSON.stringify(install.content)}`);
          const verify = await bash("dpkg-query -W -f='${Package}\\n' procps netbase");
          const listed = verify.output.split("\n").map((line) => line.trim()).filter(Boolean);
          assert(verify.exit_code === 0 && listed.includes("procps") && listed.includes("netbase"), `list packages were not installed by one pkg_add call: ${verify.formattedOutput}`);
        });
        await record("package tool validates every name in a list before execution", async () => {
          try {
            await tool("sandbox", { pkg_add: ["procps", `coreutils; touch ${outsideFile}`] });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            assert(message.includes("pkg_add accepts Debian package names only"), `package tool rejected a list for the wrong reason: ${message}`);
            assert((await fs.readFile(outsideFile, "utf8")) === sentinel, "host sentinel changed by package-list injection");
            return;
          }
          throw new Error("package tool accepted shell syntax in a package list");
        });
        await record("package tool rejects shell syntax before execution", async () => {
          try {
            await tool("sandbox", { pkg_add: `coreutils; touch ${outsideFile}` });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            assert(message.includes("pkg_add accepts Debian package names only"), `package tool rejected input for the wrong reason: ${message}`);
            assert((await fs.readFile(outsideFile, "utf8")) === sentinel, "host sentinel changed by package-name injection");
            return;
          }
          throw new Error("package tool accepted shell syntax");
        });
        await record("package tool rejects version and release qualifiers", async () => {
          for (const qualified of ["curl=8.0", "git/stable"]) {
            try {
              await tool("sandbox", { pkg_add: qualified });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              assert(message.includes("pkg_add accepts Debian package names only"), `package tool rejected ${qualified} for the wrong reason: ${message}`);
              assert(message.includes("version and release qualifiers are not accepted"), `package tool did not explain the qualifier rule for ${qualified}: ${message}`);
              continue;
            }
            throw new Error(`package tool accepted version-qualified input ${qualified}`);
          }
        });
        await record("package tool accepts a space separated package string like a CLI", async () => {
          const install = await tool("sandbox", { pkg_add: "ed bsdextrautils" });
          assert(install.details?.exitCode === 0 && !install.isError, `space separated pkg_add failed: ${JSON.stringify(install.content)}`);
          const verify = await bash("dpkg-query -W -f='${Package}\\n' ed bsdextrautils");
          const listed = verify.output.split("\n").map((line) => line.trim()).filter(Boolean);
          assert(verify.exit_code === 0 && listed.includes("ed") && listed.includes("bsdextrautils"), `space separated names were not installed: ${verify.formattedOutput}`);
        });
        await record("package tool names every rejected entry and the reason", async () => {
          const bad = ["curl git=1.0", ["curl", "git/stable"]];
          for (const pkg_add of bad) {
            const offender = String(pkg_add).includes("=") ? "git=1.0" : "git/stable";
            try {
              await tool("sandbox", { pkg_add });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              assert(message.includes("pkg_add accepts Debian package names only"), `package tool rejected ${JSON.stringify(pkg_add)} for the wrong reason: ${message}`);
              assert(message.includes(offender), `package tool did not name the rejected entry ${offender}: ${message}`);
              assert(message.includes("version and release qualifiers are not accepted"), `package tool did not explain why ${offender} was rejected: ${message}`);
              continue;
            }
            throw new Error(`package tool accepted mixed valid/invalid input ${JSON.stringify(pkg_add)}`);
          }
        });
      } finally {
        // Test fixtures are host-side resources and must not survive successful
        // runs or failed assertions.
        if (insideDir) await fs.rm(insideDir, { recursive: true, force: true });
        if (outsideTmpDir) await fs.rm(outsideTmpDir, { recursive: true, force: true });
        if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true });
      }

      const passed = results.filter((item) => item.passed).length;
      const skippedCount = results.filter((item) => item.skipped).length;
      const failed = results.length - passed - skippedCount;
      // One machine-readable notification lets the RPC harness report all test
      // evidence and return nonzero if any boundary check failed.
      const summary = { passed, failed, skipped: skippedCount, total: results.length, results };
      ctx.ui.notify(`SECURITY_TEST_RESULTS:${JSON.stringify(summary)}`, failed === 0 ? "info" : "error");
    },
  });
}
