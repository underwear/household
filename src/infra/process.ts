/** Every command is bounded: one that wedges must not wedge its caller (the daemon). */
const TIMEOUT_MS = 60_000;

export type RunOptions = { timeoutMs?: number; stdin?: string | Uint8Array; signal?: AbortSignal; env?: Record<string, string> };

type CommandProcess = {
  stdout: ReadableStream<Uint8Array> | number | null | undefined;
  stderr: ReadableStream<Uint8Array> | number | null | undefined;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
};

/** A command's deadline includes draining its pipes: a detached descendant can keep them open after it exits. */
export async function collectCommand(
  child: CommandProcess,
  { timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ ok: boolean; stdout: string; stderr: string; code?: number }> {
  const output = { stdout: "", stderr: "" };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const read = async (key: keyof typeof output) => {
    const stream = child[key];
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output[key] += decoder.decode(value, { stream: true });
      }
      output[key] += decoder.decode();
    } finally { reader.releaseLock(); }
  };
  let interrupted = false;
  let interrupt!: (reason: string) => void;
  const stopped = new Promise<Awaited<ReturnType<typeof collectCommand>>>((resolve) => {
    interrupt = (reason) => {
      if (interrupted) return;
      interrupted = true;
      resolve({ ok: false, ...output, stderr: output.stderr || reason });
      // Kill only the CLI, not its detached VM processes. Closing our readers does not wait for their EOF.
      try { child.kill("SIGKILL"); } catch { /* The CLI may already have exited. */ }
      for (const reader of readers) void reader.cancel().catch(() => {});
    };
  });
  const completed = Promise.all([read("stdout"), read("stderr"), child.exited])
    .then(([, , code]) => ({ ok: code === 0 && !interrupted, ...output, code }))
    .catch((error) => {
      interrupt((error as Error).message);
      return stopped;
    });
  const abort = () => interrupt("cancelled");
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => interrupt(`timed out after ${timeoutMs} ms`), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try { return await Promise.race([completed, stopped]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Runs a command to its end, killed after `timeoutMs` or when `signal` aborts. Never throws: a command that
 * cannot start fails with the reason in `stderr`.
 */
export async function runCommand(
  command: string[],
  { timeoutMs = TIMEOUT_MS, stdin, signal, env }: RunOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let proc;
  try {
    proc = Bun.spawn(command, {
      stdin: stdin === undefined ? "ignore" : typeof stdin === "string" ? new Blob([stdin]) : stdin,
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL",
      signal,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message };
  }
  const result = await collectCommand(proc, { timeoutMs, signal });
  return { ok: result.ok, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}


/** Opens a URL in the default browser (`open` on macOS, `xdg-open` elsewhere); false when that failed. */
export async function openInBrowser(url: string): Promise<boolean> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return (await runCommand([opener, url], { timeoutMs: 10_000 })).ok;
}
