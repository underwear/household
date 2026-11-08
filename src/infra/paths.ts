import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configFile: string;
  stateDir: string;
  socket: string;
  eventLog: string;
  /** SQLite: messages to pets, channel state. */
  database: string;
  /** The values of the keys the pets run on (and the agent API's secret), mounted read-only into the gateway. */
  gatewaySecretsDir: string;
  /** Household's CA and interception certificates. The CA key never leaves this dir. */
  tlsDir: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const configDir = env.HOUSEHOLD_CONFIG_DIR ?? join(homedir(), ".config", "household");
  const stateDir = env.HOUSEHOLD_STATE_DIR ?? join(homedir(), ".local", "state", "household");
  return {
    configFile: join(configDir, "household.yaml"),
    stateDir,
    socket: join(stateDir, "household.sock"),
    eventLog: join(stateDir, "events.jsonl"),
    database: join(stateDir, "household.db"),
    gatewaySecretsDir: join(stateDir, "gateway-secrets"),
    tlsDir: join(stateDir, "tls"),
  };
}
