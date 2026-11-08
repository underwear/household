import { HouseholdError } from "../../core/errors";
import { SlackWebApi, type SlackApi } from "./api";
import type { SlackIdentity } from "./kind";

/** Host-only onboarding. Re-resolve on save; never trust a browser-supplied owner/DM pair. */
export async function resolveSlackDm(token: string, member: string, api: SlackApi = new SlackWebApi(token)) {
  const user = member.trim();
  if (!/^[UW][A-Z0-9]+$/.test(user)) throw new HouseholdError("Copy your member ID from your Slack profile → More → Copy member ID (starts with U or W).");
  const me = await api.call<SlackIdentity>("auth.test");
  if (!me.bot_id || !/^T[A-Z0-9]+$/.test(me.team_id)) throw new HouseholdError("Use a workspace bot token.");
  if (user === me.user_id) throw new HouseholdError("Use your own member ID, not the bot's.");
  const { channel } = await api.call<{ channel?: { id?: string; user?: string; is_im?: boolean } }>("conversations.open", { users: user, return_im: true });
  if (!channel?.id || !/^D[A-Z0-9]+$/.test(channel.id) || channel.user !== user || channel.is_im !== true) throw new HouseholdError("Slack did not return a personal bot DM for this member.");
  return { chat: `${me.team_id}:${channel.id}`, owner: `${me.team_id}:${user}`, url: `https://app.slack.com/client/${me.team_id}/${channel.id}` };
}
