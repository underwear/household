#!/usr/bin/env bun
/** Open the owner's DM and optionally attach it to a house. Credentials never enter argv or output. */
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { SlackWebApi } from "../src/channel-adapters/slack/api";
import { isSlackAppToken, slackTokenCheck } from "../src/channel-adapters/slack/kind";
import { ConfigStore } from "../src/infra/config-store";
import { resolvePaths } from "../src/infra/paths";
import { callControl } from "../src/infra/control-socket";
import { channelChecks, checkFields } from "../src/app/channel-fields";
import { knownChannelKinds } from "../src/app/kinds";

try {
  const { values } = parseArgs({ options: { credentials: { type: "string" }, user: { type: "string" }, house: { type: "string" }, pets: { type: "string" }, apply: { type: "boolean" } } });
  if (!values.user || !/^[UW][A-Z0-9]+$/.test(values.user)) throw new Error("Usage: bun scripts/slack-setup.ts --credentials /private/slack.json --user U… [--house work --pets sibling --apply]");
  let credentials: { botToken?: string; appToken?: string };
  if (values.credentials) {
    const mode = (await stat(values.credentials)).mode & 0o777;
    if (mode & 0o077) throw new Error("Credentials file must be private (chmod 600).");
    credentials = await Bun.file(values.credentials).json();
  } else credentials = { botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN };
  const { botToken, appToken } = credentials;
  if (!botToken || !appToken || !isSlackAppToken(appToken)) throw new Error("Provide botToken (xoxb) and appToken (xapp) in the private JSON file or SLACK_BOT_TOKEN / SLACK_APP_TOKEN environment variables.");
  const accepted = await slackTokenCheck().accept(botToken);
  const team = accepted.identity.split(":")[0]!;
  const api = new SlackWebApi(botToken);
  const { channel } = await api.call<{ channel: { id: string; user?: string; is_im?: boolean } }>("conversations.open", { users: values.user, return_im: true });
  if (!/^D[A-Z0-9]+$/.test(channel.id) || channel.user !== values.user || !channel.is_im) throw new Error("Slack did not return the requested one-to-one DM.");
  const chat = `${team}:${channel.id}`, owner = `${team}:${values.user}`;
  if (values.apply) {
    if (!values.house || !values.pets) throw new Error("--apply requires --house and --pets");
    const paths = resolvePaths();
    const daemon = await callControl<{ status: number; body: { channelKinds?: { kind: string }[] } }>(paths.socket, "/api", { method: "GET", path: "/api/me" });
    if (daemon && !daemon.body.channelKinds?.some(kind => kind.kind === "slack-private")) throw new Error("The running daemon has no Slack adapter. Restart Household from this checkout before applying the channel.");
    const config = new ConfigStore(paths.configFile);
    const household = await config.load();
    const house = household.houses.find(house => house.name === values.house);
    if (!house) throw new Error("House not found");
    const pets = values.pets.split(",").map(value => value.trim()).filter(Boolean);
    if (!pets.length || pets.some(pet => !house.pets.some(existing => existing.name === pet))) throw new Error("Choose existing pets of that house");
    const { own, also } = await checkFields(knownChannelKinds(), channelChecks(), "slack-private", { token: botToken, appToken }, { household, house: house.name, chat });
    if (!house.people.owners.some(person => person.platform === "slack" && person.id === owner)) await config.addOwner(house.name, "slack", owner);
    if (house.channels.some(channel => channel.kind === "slack-private" && channel.chat === chat)) await config.updateChannel(house.name, chat, { ...own, pets, default: pets.length > 1 ? pets[0] : null }, also);
    else await config.addChannel(house.name, { kind: "slack-private", chat, ...own, pets, default: pets.length > 1 ? pets[0] : undefined, name: "Slack" }, also);
    const reloaded = await callControl(paths.socket, "/reload");
    console.log(reloaded ? "Saved. Daemon reload requested." : "Saved. Start Household to connect.");
  }
  console.log(`Slack owner: ${owner}\nSlack chat: ${chat}\nOpen: https://app.slack.com/client/${team}/${channel.id}`);
} catch (error) {
  // Neither credential contents nor SDK request objects are logged.
  console.error(error instanceof SyntaxError ? "Invalid credentials JSON" : (error as Error).message);
  process.exitCode = 1;
}
