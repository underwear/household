// Called only through docker exec, inside this pet. No TCP listener or host socket.
const action = process.argv[2];
if (!["status", "send", "interrupt", "models"].includes(action ?? "")) process.exit(1);
try {
  const body = action === "send" ? await Bun.stdin.text() : undefined;
  const response = await fetch(`http://household/${action}`, { unix: "/tmp/household-codex.sock", method: "POST", ...(body ? { body, headers: { "content-type": "application/json" } } : {}), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) process.exit(1);
  console.log(await response.text());
} catch { process.exit(1); }
export {};
