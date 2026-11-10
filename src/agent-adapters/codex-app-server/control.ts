// Called only through docker exec, inside this pet. No TCP listener or host socket.
const SOCKET = "/tmp/household-codex.sock";
const FAILURE = "/tmp/household-codex.failure"; // the bridge's failureFileFor(SOCKET)
const action = process.argv[2];
if (!["status", "send", "interrupt", "models"].includes(action ?? "")) process.exit(1);
try {
  const body = action === "send" ? await Bun.stdin.text() : undefined;
  const response = await fetch(`http://household/${action}`, { unix: SOCKET, method: "POST", ...(body ? { body, headers: { "content-type": "application/json" } } : {}), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) process.exit(1);
  console.log(await response.text());
} catch {
  // A bridge that failed has closed its socket; its status is the reason it left behind.
  if (action === "status") {
    const failure = await Bun.file(FAILURE).json().then(saved => saved?.failure, () => undefined);
    if (typeof failure === "string") { console.log(JSON.stringify({ ready: false, failure: failure.slice(0, 400) })); process.exit(0); }
  }
  process.exit(1);
}
export {};
