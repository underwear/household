import type { ChannelKindSpec, PlatformSpec, FieldCheck } from "../../core/channels";
import { HouseholdError } from "../../core/errors";
import { SlackWebApi, SlackError } from "./api";

export const isSlackOwner = (id: string) => /^T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(id);
export const isSlackChat = (id: string) => /^T[A-Z0-9]+:D[A-Z0-9]+$/.test(id);
export const isSlackBotToken = (token: string) => /^xoxb-[A-Za-z0-9-]{20,}$/.test(token);
export const isSlackAppToken = (token: string) => /^xapp-[A-Za-z0-9-]{20,}$/.test(token);
export const slack: PlatformSpec = {
  platform: "slack", label: "Slack",
  icon: { viewBox: "0 0 24 24", d: "M8 2a2 2 0 0 1 2 2v6H4a2 2 0 0 1 0-4h2V4a2 2 0 0 1 2-2zm14 6a2 2 0 0 1-2 2h-6V4a2 2 0 0 1 4 0v2h2a2 2 0 0 1 2 2zM16 22a2 2 0 0 1-2-2v-6h6a2 2 0 0 1 0 4h-2v2a2 2 0 0 1-2 2zM2 16a2 2 0 0 1 2-2h6v6a2 2 0 0 1-4 0v-2H4a2 2 0 0 1-2-2z" },
  ownerId: { label: "Slack workspace:user", placeholder: "T0123456789:U0123456789", hint: "Workspace ID and member ID, separated by a colon. Identity is scoped to this workspace." },
  valid: isSlackOwner,
};
export const slackPrivate: ChannelKindSpec = {
  kind: "slack-private", platform: "slack", audience: "private", label: "Slack Bot DM",
  description: "Talk to the default bot directly in Messages. Other placed bots and temporary helpers use separate threads.",
  chat: { key: "chat", label: "Workspace:DM", placeholder: "T0123456789:D0123456789", mono: true, hint: "The admin connects your bot DM automatically from your Slack member ID." },
  fields: [
    { key: "token", label: "Bot token", placeholder: "xoxb-…", mono: true, wide: true, hint: "OAuth & Permissions → Bot User OAuth Token. Kept on the host." },
    { key: "appToken", label: "Socket Mode app token", placeholder: "xapp-…", mono: true, wide: true, hint: "Basic Information → App-Level Tokens, with connections:write. No public server needed." },
  ],
  replyFormat: { name: "slack-mrkdwn", instructions: "Use Slack mrkdwn: *bold*, _italic_, ~strike~, `code`, triple-backtick code blocks, <https://example.com|label> links, and > quotes. Escape literal &, < and > as &amp;, &lt; and &gt;. Use short paragraphs and lists, not Markdown tables. Do not use @here/@channel mentions. Buttons and file captions are plain text." },
};
export interface SlackIdentity { team_id: string; user_id: string; bot_id?: string; user?: string; }
export function slackTokenCheck(apiBase?: string): FieldCheck {
  const known = new Map<string, SlackIdentity>();
  return {
    async accept(raw) {
      const value = raw.trim();
      if (!isSlackBotToken(value)) throw new HouseholdError("Expected a Slack bot token (xoxb-…).");
      const identity = await new SlackWebApi(value, apiBase).call<SlackIdentity>("auth.test");
      if (!identity.bot_id || !/^T[A-Z0-9]+$/.test(identity.team_id)) throw new HouseholdError("This must be a workspace bot token.");
      known.set(value, identity);
      return { value, identity: `${identity.team_id}:${identity.bot_id}`, shown: `@${identity.user ?? "Household"}` };
    },
    async identify(value) {
      if (!isSlackBotToken(value)) return undefined;
      let me = known.get(value);
      try { me ??= await new SlackWebApi(value, apiBase).call<SlackIdentity>("auth.test"); }
      catch (error) {
        if (error instanceof SlackError && ["invalid_auth", "token_revoked", "account_inactive"].includes(error.code)) return undefined;
        throw error;
      }
      if (!me.bot_id) return undefined;
      known.set(value, me);
      return `${me.team_id}:${me.bot_id}`;
    },
    identityOf: value => { const me = known.get(value); return me ? `${me.team_id}:${me.bot_id}` : undefined; },
    describe: value => isSlackBotToken(value) ? `@${known.get(value)?.user ?? "Slack bot"}` : null,
  };
}
export const slackAppTokenCheck: FieldCheck = {
  async accept(raw) {
    const value = raw.trim();
    if (!isSlackAppToken(value)) throw new HouseholdError("Expected a Slack app-level token (xapp-…) with connections:write.");
    return { value, identity: value.split("-").slice(0, 3).join("-"), shown: "Socket Mode" };
  },
  identityOf: () => undefined,
  describe: value => isSlackAppToken(value) ? "Socket Mode" : null,
};
