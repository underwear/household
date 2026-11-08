import { join } from "node:path";
import { dedicatedAuthRoot } from "./codex-auth-backup";
import { SUBSCRIPTION_PREFIX } from "../agent-adapters/codex-app-server/auth";
import { startCodexRefresh } from "../agent-adapters/codex-app-server/host-auth";
import type { AgentKey } from "../core/keys";
import { writeSecrets } from "../infra/secrets";
import type { PlacedPet } from "./agents";
import { keySecret } from "./gateway";
import { petKeys } from "./keys";
import type { Secret } from "../core/secrets";

/** A reload stages credentials before publishing policy; failed reloads keep the previous watcher. */
export class SubscriptionKeys {
  private current?: { stop(): void };

  constructor(
    private readonly directory: string,
    private readonly configFile: string,
    private readonly log: (text: string) => void,
    private readonly refresh = startCodexRefresh,
  ) {}

  async prepare(placed: PlacedPet[], keys: AgentKey[], secrets: readonly Secret[] = []) {
    const used = new Set(placed.map(({ key }) => key));
    const subscriptions = keys.filter(({ name, value }) => used.has(name) && value.startsWith(SUBSCRIPTION_PREFIX));
    const tokens = new Map<string, string>();
    let active = false;
    const publish = () => writeSecrets(this.directory, Object.fromEntries(subscriptions.map(({ name }) => [keySecret(name), tokens.get(name) ?? ""])));
    const next = await this.refresh({
      keys: subscriptions.map((key) => ({ ...key, home: join(dedicatedAuthRoot(this.configFile), key.name) })),
      log: this.log,
      onToken: (name, token) => {
        if (token) tokens.set(name, token);
        else tokens.delete(name);
        if (active) publish();
      },
    });
    try {
      const credentials = petKeys(placed, keys, tokens, secrets);
      return {
        credentials,
        commit: () => {
          this.current?.stop();
          this.current = next;
          active = true;
          if (subscriptions.length) publish(); // includes any refresh completed while policy was being applied
        },
        cancel: () => next.stop(),
      };
    } catch (error) {
      next.stop();
      throw error;
    }
  }

  stop(): void { this.current?.stop(); }
}
