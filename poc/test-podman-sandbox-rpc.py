#!/usr/bin/env python3
"""Run a provider-free smoke check or security suite through Pi's JSONL RPC protocol.

The security mode loads a test extension that directly invokes the sandbox's
registered tool callbacks; RPC's built-in bash command is intentionally avoided
because it uses Pi's host-local shell backend instead of the replacement tool.
"""

from __future__ import annotations

import argparse
import json
import os
import selectors
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTENSION = PROJECT_ROOT / "podman-sandbox.ts"
SCRATCH = PROJECT_ROOT / "scratch"


class RpcProcess:
    """Own the byte-framed RPC stream so events and command replies cannot be confused."""

    def __init__(self, process: subprocess.Popen[bytes], verbose: bool = False, redactions: tuple[str, ...] = ()):
        assert process.stdout is not None
        self.process = process
        self.verbose = verbose
        self.redactions = redactions
        self.selector = selectors.DefaultSelector()
        self.selector.register(process.stdout, selectors.EVENT_READ)
        self.buffer = bytearray()
        # Extension notifications can arrive before the correlated prompt
        # response, so retain records rather than relying on one event order.
        self.records: list[dict[str, Any]] = []

    def send(self, record: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        payload = json.dumps(record, ensure_ascii=True, separators=(",", ":")).encode("utf-8") + b"\n"
        self.process.stdin.write(payload)
        self.process.stdin.flush()

    def read_record(self, deadline: float) -> dict[str, Any]:
        # RPC is JSON Lines: only LF ends a record; decoding whole records avoids
        # splitting valid JSON strings on Unicode line-separator characters.
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.buffer[:newline]).removesuffix(b"\r")
                del self.buffer[: newline + 1]
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise RuntimeError(f"RPC record is not an object: {record!r}")
                self.records.append(record)
                if self.verbose:
                    rendered = json.dumps(record, ensure_ascii=True)
                    for secret in self.redactions:
                        rendered = rendered.replace(secret, "[REDACTED]")
                    print(f"[rpc] {rendered}", file=sys.stderr)
                return record

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out waiting for a Pi RPC record")
            if not self.selector.select(remaining):
                raise TimeoutError("timed out waiting for a Pi RPC record")

            assert self.process.stdout is not None
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(f"Pi RPC exited unexpectedly (status {self.process.poll()})")
            self.buffer.extend(chunk)

    def wait_response(self, request_id: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            record = self.read_record(deadline)
            if record.get("type") == "extension_error":
                raise RuntimeError(f"Pi extension error: {record}")
            if record.get("type") == "response" and record.get("id") == request_id:
                if not record.get("success"):
                    raise RuntimeError(f"RPC {record.get('command')} failed: {record.get('error')}")
                return record

    def wait_for_startup(self, timeout: float) -> str:
        for record in self.records:
            notice = self._startup_notice(record)
            if notice is not None:
                return notice

        deadline = time.monotonic() + timeout
        while True:
            record = self.read_record(deadline)
            notice = self._startup_notice(record)
            if notice is not None:
                return notice

    @staticmethod
    def _startup_notice(record: dict[str, Any]) -> str | None:
        if record.get("type") == "extension_error":
            raise RuntimeError(f"Pi extension error: {record}")
        if record.get("type") != "extension_ui_request" or record.get("method") != "notify":
            return None
        message = str(record.get("message", ""))
        if message.startswith("Podman sandbox startup failed:"):
            raise RuntimeError(message)
        return message if message.startswith("Podman sandbox ready:") else None

    def wait_for_notice(self, prefix: str, timeout: float) -> str:
        for record in self.records:
            notice = self._matching_notice(record, prefix)
            if notice is not None:
                return notice

        deadline = time.monotonic() + timeout
        while True:
            record = self.read_record(deadline)
            notice = self._matching_notice(record, prefix)
            if notice is not None:
                return notice

    @staticmethod
    def _matching_notice(record: dict[str, Any], prefix: str) -> str | None:
        if record.get("type") == "extension_error":
            raise RuntimeError(f"Pi extension error: {record}")
        if record.get("type") != "extension_ui_request" or record.get("method") != "notify":
            return None
        message = str(record.get("message", ""))
        if message.startswith("list failed:"):
            raise RuntimeError(f"sandbox list operation failed: {message}")
        return message if message.startswith(prefix) else None


def parse_args() -> argparse.Namespace:
    # The same runner provides a cheap startup smoke check and the opt-in suite
    # that exercises security properties through the real extension callbacks.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", default=os.environ.get("PI_BIN", "pi"), help="Pi executable (default: PI_BIN or pi)")
    parser.add_argument("--security", action="store_true", help="run the security suite against registered sandbox tools")
    parser.add_argument("--verbose", action="store_true", help="print RPC records and Pi diagnostics to stderr")
    parser.add_argument("--image", help="use an existing Podman image instead of building the embedded image")
    parser.add_argument("--timeout", type=float, default=240, help="timeout in seconds per RPC operation (default: 240)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pi_path = shutil.which(args.pi)
    if pi_path is None:
        print(f"error: Pi executable not found: {args.pi}", file=sys.stderr)
        return 2
    if args.timeout <= 0:
        print("error: --timeout must be greater than zero", file=sys.stderr)
        return 2

    SCRATCH.mkdir(exist_ok=True)
    stderr_file = tempfile.NamedTemporaryFile(
        mode="w+b", prefix="podman-sandbox-rpc-", suffix=".stderr.log", dir=SCRATCH, delete=False
    )
    stderr_path = Path(stderr_file.name)
    # No persisted session or automatically discovered extensions are allowed:
    # repeatability matters more than inheriting a developer's Pi environment.
    extension = PROJECT_ROOT / "poc" / "podman-sandbox-security-test.ts" if args.security else EXTENSION
    command = [
        pi_path,
        "--mode", "rpc",
        "--no-session",
        "--no-extensions",
        "--extension", str(extension),
        "--name", "podman-sandbox-security-test" if args.security else "podman-sandbox-rpc-test",
    ]
    if args.image:
        command.extend(["--sandbox-image", args.image])
    if args.verbose:
        # Pi's diagnostics and the extension's milestone logs share the
        # harness's opt-in verbose switch.
        command.append("--verbose")

    process_env = os.environ.copy()
    host_canary = secrets.token_hex(16) if args.security else None
    fixture_id = secrets.token_hex(8) if args.security else None
    security_outside = PROJECT_ROOT.parent / f".pi-sandbox-security-outside-{fixture_id}" if fixture_id else None
    security_tmp = Path(tempfile.gettempdir()) / f"pi-sandbox-security-tmp-{fixture_id}" if fixture_id else None
    if host_canary:
        process_env["PI_SANDBOX_HOST_CANARY"] = host_canary
    if fixture_id:
        process_env["PI_SANDBOX_FIXTURE_ID"] = fixture_id
    if security_outside and security_tmp:
        process_env["PI_SANDBOX_SECURITY_OUTSIDE"] = str(security_outside)
        process_env["PI_SANDBOX_SECURITY_TMP"] = str(security_tmp)
    if args.verbose:
        process_env["PI_SANDBOX_SECURITY_VERBOSE"] = "1"

    process: subprocess.Popen[bytes] | None = None
    rpc: RpcProcess | None = None
    failed = False
    try:
        # A separate process group lets timeout cleanup reap Pi and its helpers
        # without sending termination signals to the user's shell/session.
        process = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            bufsize=0,
            start_new_session=True,
            env=process_env,
        )
        rpc = RpcProcess(process, verbose=args.verbose, redactions=(host_canary,) if host_canary else ())

        rpc.send({"id": "rpc-test-commands", "type": "get_commands"})
        commands_response = rpc.wait_response("rpc-test-commands", args.timeout)
        commands = commands_response.get("data", {}).get("commands", [])
        expected_command = "sandbox-security-test" if args.security else "sandbox"
        if not any(item.get("name") == expected_command and item.get("source") == "extension" for item in commands):
            raise RuntimeError(f"the expected extension command was not registered: /{expected_command}")

        startup = rpc.wait_for_startup(args.timeout)
        print(f"PASS: {startup}")
        prompt_command = "/sandbox-security-test" if args.security else "/sandbox list"
        request_id = "rpc-test-security" if args.security else "rpc-test-sandbox-list"
        rpc.send({"id": request_id, "type": "prompt", "message": prompt_command})
        prompt_response = rpc.wait_response(request_id, args.timeout)
        disposition = prompt_response.get("data", {}).get("disposition")
        if disposition != "handled":
            raise RuntimeError(f"expected {prompt_command} to be handled by the extension, got {disposition!r}")
        if args.security:
            notice = rpc.wait_for_notice("SECURITY_TEST_RESULTS:", args.timeout)
            report = json.loads(notice.removeprefix("SECURITY_TEST_RESULTS:"))
            for result in report.get("results", []):
                marker = "SKIP" if result.get("skipped") else "PASS" if result.get("passed") else "FAIL"
                detail = f": {result['detail']}" if result.get("detail") else ""
                if host_canary:
                    detail = detail.replace(host_canary, "[REDACTED]")
                print(f"{marker}: {result.get('name')}{detail}")
            passed = report.get("passed", 0)
            failed_count = report.get("failed", report.get("total", 0) - passed)
            skipped = report.get("skipped", 0)
            print(f"Security tests: {passed} passed, {failed_count} failed, {skipped} skipped")
            if failed_count:
                failed = True
        else:
            rpc.wait_for_notice("list completed", args.timeout)
            print("PASS: RPC loaded the extension, registered /sandbox, and completed /sandbox list in the Podman sandbox.")
    except (OSError, RuntimeError, TimeoutError, json.JSONDecodeError) as error:
        failed = True
        print(f"FAIL: {error}", file=sys.stderr)
    except KeyboardInterrupt:
        failed = True
        print("FAIL: interrupted; shutting down Pi RPC", file=sys.stderr)
    finally:
        # Shutdown closes stdin so Pi runs normal extension cleanup. Escalation
        # is confined to the subprocess group if graceful teardown hangs.
        if process is not None:
            if process.stdin is not None and not process.stdin.closed:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        stderr_file.close()
        if rpc is not None:
            rpc.selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()
        if security_outside:
            shutil.rmtree(security_outside, ignore_errors=True)
        if security_tmp:
            shutil.rmtree(security_tmp, ignore_errors=True)
        if process is not None and fixture_id:
            shutil.rmtree(PROJECT_ROOT / f"security-test-{process.pid}-{fixture_id}", ignore_errors=True)

    stderr_contents = stderr_path.read_text(errors="replace") if stderr_path.exists() else ""
    protocol_contents = json.dumps(rpc.records, ensure_ascii=True) if rpc is not None else ""
    if host_canary and (host_canary in stderr_contents or host_canary in protocol_contents):
        failed = True
        print("FAIL: host canary appeared in Pi RPC output or stderr; occurrences were redacted", file=sys.stderr)
    if host_canary and host_canary in stderr_contents:
        stderr_contents = stderr_contents.replace(host_canary, "[REDACTED]")
        stderr_path.write_text(stderr_contents)
    if args.verbose and stderr_contents:
        print("[pi stderr]", file=sys.stderr)
        print(stderr_contents, file=sys.stderr, end="" if stderr_contents.endswith("\n") else "\n")

    if failed:
        if rpc is not None and rpc.records and not args.verbose:
            print("RPC records received:", file=sys.stderr)
            for record in rpc.records[-20:]:
                print(json.dumps(record, ensure_ascii=True).replace(host_canary, "[REDACTED]") if host_canary else json.dumps(record, ensure_ascii=True), file=sys.stderr)
        if stderr_contents:
            if not args.verbose:
                print(f"Pi stderr log: {stderr_path}", file=sys.stderr)
            if not args.verbose:
                print(stderr_contents, file=sys.stderr, end="")
        stderr_path.unlink(missing_ok=True)
        return 1

    stderr_path.unlink(missing_ok=True)
    return 0


def handle_interrupt(_signum: int, _frame: Any) -> None:
    # Convert signals into the same cleanup path used for protocol failures.
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_interrupt)
    signal.signal(signal.SIGTERM, handle_interrupt)
    raise SystemExit(main())
