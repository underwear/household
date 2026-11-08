/** Every command is bounded: one that wedges must not wedge its caller (the daemon). */
const TIMEOUT_MS = 60_000;

export type RunOptions = { timeoutMs?: number; stdin?: string | Uint8Array; signal?: AbortSignal; env?: Record<string, string> };

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
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      signal,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const killed = signal?.aborted ? "cancelled" : proc.signalCode === "SIGKILL" ? `timed out after ${timeoutMs} ms` : "";
  return { ok: code === 0, stdout: stdout.trim(), stderr: (stderr.trim() || killed).trim() };
}


/** Opens a URL in the default browser (`open` on macOS, `xdg-open` elsewhere); false when that failed. */
export async function openInBrowser(url: string): Promise<boolean> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return (await runCommand([opener, url], { timeoutMs: 10_000 })).ok;
}
