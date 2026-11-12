import { join } from "node:path";
import { dedicatedAuthRoot } from "./codex-auth-backup";
import { SUBSCRIPTION_PREFIX } from "../agent-adapters/codex-app-server/auth";
import { startCodexRefresh } from "../agent-adapters/codex-app-server/host-auth";
import { SIGNIN_PREFIX } from "../agent-adapters/claude-code-tmux/signin";
import type { ClaudeRefreshOptions } from "./claude-signins";
import type { AgentKey } from "../core/keys";
import { writeSecrets } from "../infra/secrets";
import type { PlacedPet } from "./agents";
import { keySecret } from "./gateway";
import { petKeys } from "./keys";
import type { House } from "../core/household";

/** A reload stages credentials before publishing policy; failed reloads keep the previous watcher. */
export class SubscriptionKeys {
  private current?: { stop(): void };

  constructor(
    private readonly directory: string,
    private readonly configFile: string,
    private readonly log: (text: string) => void,
    private readonly refresh = startCodexRefresh,
    /** Claude sign-ins' keeper (`startClaudeRefresh` with its store and VMs); none: such keys stay without a token. */
    private readonly claude?: (options: ClaudeRefreshOptions) => Promise<{ stop(): void }>,
  ) {}

  async prepare(placed: PlacedPet[], keys: AgentKey[], houses: readonly Pick<House, "name" | "secrets">[] = []) {
    const used = new Set(placed.map(({ key }) => key));
    const subscriptions = keys.filter(({ name, value }) => used.has(name) && value.startsWith(SUBSCRIPTION_PREFIX));
    const signins = keys.filter(({ name, value }) => used.has(name) && value.startsWith(SIGNIN_PREFIX));
    const tokens = new Map<string, string>();
    let active = false;
    const managed = [...subscriptions, ...signins];
    const publish = () => writeSecrets(this.directory, Object.fromEntries(managed.map(({ name }) => [keySecret(name), tokens.get(name) ?? ""])));
    const onToken = (name: string, token: string | undefined) => {
      if (token) tokens.set(name, token);
      else tokens.delete(name);
      if (active) publish();
    };
    const claude = signins.length && this.claude ? await this.claude({ keys: signins, log: this.log, onToken }) : undefined;
    const codex = await this.refresh({
      keys: subscriptions.map((key) => ({ ...key, home: join(dedicatedAuthRoot(this.configFile), key.name) })),
      log: this.log,
      onToken,
    }).catch((error) => { claude?.stop(); throw error; });
    const next = { stop() { codex.stop(); claude?.stop(); } };
    try {
      const credentials = petKeys(placed, keys, tokens, houses);
      return {
        credentials,
        commit: () => {
          this.current?.stop();
          this.current = next;
          active = true;
          if (managed.length) publish(); // includes any refresh completed while policy was being applied
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
