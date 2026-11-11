import { SlackBot, SlackChannel, isSlackBotToken, isSlackAppToken } from "../channel-adapters/slack";
import { isBotToken, TelegramBot, TelegramChannel } from "../channel-adapters/telegram";
import type { Channel } from "../core/channel";
import { channelKey, channelName, defaultPet, petPlaceKey } from "../core/channels";
import type { EventLog } from "../infra/event-log";
import type { KeyValueStore } from "../infra/sqlite-store";
import type { OpenChannels, Opened } from "./chat";
import { knownChannelKinds } from "./kinds";

export interface ChannelDeps {
  state: KeyValueStore;
  events: EventLog;
  /** Bot API base URL; the real one when absent. */
  telegramApi?: string;
}

/**
 * Opens the channels the houses' configs list, by house and channel key, on every reload: a channel whose
 * connection is what it was (its house, kind, chat and bot token) is the same instance as before; one that is new
 * or changed (another bot, its token rotated) is a new one, not started; one that cannot open says why.
 * A bot has one poller (two would take each other's updates), shared by the channels of its house and kept while
 * any of them is open. A bot serves one house: one that holds it keeps it; one nobody holds goes to the first house
 * in the config that names it, whatever its token. One token per bot: another token of a bot (a rotation half
 * done) is refused, so a bot is never polled twice. Bot tokens stay in the daemon: never the gateway's or a pet's.
 * A new kind of channel is one more branch.
 */
export function openChannels({ state, events, telegramApi }: ChannelDeps): OpenChannels {
  /** The last call's channels by `house/key`, with the token they run on; bots by token; bot id → its house. */
  let channels = new Map<string, { token: string; channel: Channel }>();
  let bots = new Map<string, TelegramBot>();
  let held = new Map<string, string>();
  let slackBots = new Map<string, SlackBot>();
  const slackIdentities = new Map<string, SlackBot>();
  /** Problems already logged, by `house/key`: a reload logs only what is new. */
  let logged = new Map<string, string>();
  return (houses) => {
    const opened = new Map<string, Map<string, Opened>>();
    const [nextChannels, nextBots, nextHeld, nextLogged] = [new Map<string, { token: string; channel: Channel }>(), new Map<string, TelegramBot>(), new Map<string, string>(), new Map<string, string>()];
    const nextSlackBots = new Map<string, SlackBot>();
    const slackHeld = new Map<string, string>();
    const slackApps = new Map<string, string>();
    // What is not a bot token (a key pasted by mistake, …) is never sent to Telegram.
    const wanted = houses.flatMap((house) =>
      house.channels.map((config) => ({ house, config, token: isBotToken(config.token) ? config.token : undefined })),
    );
    // A bot's house: the one holding it, while it still names it; else the first that does.
    const idOf = (token: string) => token.split(":")[0]!;
    for (const { house, token } of wanted) {
      if (!token || nextHeld.has(idOf(token))) continue;
      const holder = held.get(idOf(token));
      const keeps = holder !== undefined && wanted.some((other) => other.house.name === holder && other.token && idOf(other.token) === idOf(token));
      nextHeld.set(idOf(token), keeps ? holder : house.name);
    }
    /** Bot id → the token its channels run on (the first one its house names). */
    const tokens = new Map<string, string>();
    const telegramChats = new Set<string>();
    for (const { house, config, token } of wanted) {
      const results = opened.get(house.name) ?? opened.set(house.name, new Map()).get(house.name)!;
      const key = channelKey(config);
      const name = `${house.name}/${key}`;
      const refuse = (problem: string) => {
        results.set(key, { problem });
        nextLogged.set(name, problem);
        if (logged.get(name) !== problem) events.error(`workspace ${house.name}, channel ${channelName(knownChannelKinds(), config)}: ${problem}; no chat there until a reload finds it fixed`);
      };
      switch (config.kind) {
        case "slack-private": {
          if (!isSlackBotToken(config.token) || !config.appToken || !isSlackAppToken(config.appToken)) {
            refuse("Slack requires a bot token (xoxb-…) and Socket Mode app token (xapp-…)");
            continue;
          }
          const holder = slackHeld.get(config.token);
          if (holder && holder !== house.name) { refuse(`its Slack bot is house ${holder}'s`); continue; }
          slackHeld.set(config.token, house.name);
          const connection = `${config.token}:${config.appToken}`;
          // App-level sockets distribute events across all sockets of that app. This prototype supports
          // one workspace installation per app, so competing token pairs must fail visibly.
          const appIdentity = config.appToken.split("-").slice(0, 3).join("-");
          const appConnection = slackApps.get(appIdentity);
          if (appConnection && appConnection !== connection) {
            refuse("this Slack app already uses another token pair; use one workspace installation and one token pair per app"); continue;
          }
          slackApps.set(appIdentity, connection);
          // A single installation must not open competing sockets with two app tokens.
          if ([...nextSlackBots.keys()].some(key => key.startsWith(`${config.token}:`) && key !== connection)) {
            refuse("one Socket Mode app token is required across this bot's channels"); continue;
          }
          const bot = nextSlackBots.get(connection) ?? slackBots.get(connection) ?? new SlackBot({ token: config.token, appToken: config.appToken, state, log: events,
            claimIdentity(identity, claimant) {
              const current = slackIdentities.get(identity);
              if (current && current !== claimant) throw new Error("This Slack bot is already connected: one bot serves one workspace, with one token pair");
              slackIdentities.set(identity, claimant);
            },
            releaseIdentity(claimant) { for (const [identity, current] of slackIdentities) if (current === claimant) slackIdentities.delete(identity); },
          });
          nextSlackBots.set(connection, bot);
          const before = channels.get(name);
          const channel = before?.token === connection ? before.channel : new SlackChannel(bot, config.chat);
          const main = defaultPet(config);
          (channel as SlackChannel).setMainPlace(main ? petPlaceKey(main, key) : undefined);
          nextChannels.set(name, { token: connection, channel });
          results.set(key, { channel });
          break;
        }
        case "telegram-dm":
        case "telegram-group":
        case "telegram-private": {
          if (!token) {
            refuse("its token is not a bot token (one looks like 123456789:AAH4x…, from @BotFather)");
            continue;
          }
          const id = idOf(token);
          if (nextHeld.get(id) !== house.name) {
            refuse(`its bot is house ${nextHeld.get(id)}'s, and a bot serves one house`);
            continue;
          }
          if (tokens.has(id) && tokens.get(id) !== token) {
            refuse("its token is another token of a bot this house already runs: one token per bot");
            continue;
          }
          const address = `${id}/${config.chat}`;
          if (telegramChats.has(address)) {
            refuse("this Telegram chat is already connected; choose either ordinary DM or threaded mode");
            continue;
          }
          telegramChats.add(address);
          tokens.set(id, token);
          const bot = nextBots.get(token) ?? bots.get(token) ?? new TelegramBot({ name: `house ${house.name}`, token, state, log: events, apiBase: telegramApi });
          nextBots.set(token, bot);
          const before = channels.get(name);
          // One channel per kind and chat in a house (the config's rule), so a chat is one bot's once.
          const channel = before?.token === token ? before.channel : new TelegramChannel(bot, Number(config.chat), `house ${house.name} ${channelName(knownChannelKinds(), config)}`, config.kind === "telegram-group" ? "group" : config.kind === "telegram-dm" ? "dm" : "private");
          const primary = house.pets.filter(pet => config.pets.includes(pet.name) && !pet.sideworker && !pet.scout);
          (channel as TelegramChannel).setSoloPlace(primary.length === 1 ? petPlaceKey(primary[0]!.name, key) : undefined);
          nextChannels.set(name, { token, channel });
          results.set(key, { channel });
        }
      }
    }
    for (const house of houses) if (!opened.has(house.name)) opened.set(house.name, new Map());
    slackBots = nextSlackBots;
    [channels, bots, held, logged] = [nextChannels, nextBots, nextHeld, nextLogged];
    return opened;
  };
}
