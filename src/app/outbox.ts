import { posix } from "node:path";
import type { OutgoingAttachment } from "../core/attachment";
import type { PetIdentity } from "../infra/agent-api";
import type { McpTool } from "../infra/mcp-server";
import type { PetOutboxFiles } from "../infra/pet-outbox";
import type { Chat } from "./chat";
import { petVolume } from "./pet-plane";

/**
 * Explicit sends only: writing a file never publishes it. The authenticated pet owns both home and destination.
 * `homeOf` names a home kept elsewhere (a scout's, in its run's storage): its files and the home's name there.
 */
export function outboxTool(files: Pick<PetOutboxFiles, "read">, chat: Pick<Chat, "sendAttachment">,
  log: { info(text: string): void; error(text: string): void },
  homeOf?: (house: string, pet: string) => { files: Pick<PetOutboxFiles, "read">; volume: string } | undefined): McpTool<PetIdentity> {
  return {
    name: "send_file",
    description: "Send a finished file from your ~/.household/outbox to your human, in the chosen place or current request place. Create the directory with mkdir -p first. path is relative to that directory; symlinks are refused. kind: document (default, original file), photo (inline image), voice (voice message, OGG/Opus, MP3 or M4A). Prepare the media yourself; this tool does not generate speech or convert formats. Telegram limits: photo 10 MB, other files 50 MB; caption 1024 characters. Files remain until you delete them. Returns message id and channel as reply does. A failed/timeout upload may have reached the chat: check before retrying.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", description: "Relative path inside ~/.household/outbox, e.g. report.pdf or speech.ogg" },
      kind: { type: "string", enum: ["document", "photo", "voice", "video"], default: "document", description: "document (a file), photo (an inline image, at most 10 MB), voice (prepared audio as a voice message) or video (MP4, H.264 + AAC, played in the chat; at most 50 MB)" },
      caption: { type: "string", maxLength: 1024, description: "Optional plain text caption" },
      place: { type: "string", description: "Destination place.id; defaults to the current request place. Do not combine with channel." },
      channel: { type: "string", description: "Legacy Household channel id; prefer place. Omitted destination inherits the current request place" },
    } },
    async call({ house, pet }, args, signal) {
      if (typeof args.path !== "string" || !args.path || args.path.length > 1024 || /[\x00-\x1f\x7f]/.test(args.path)) throw new Error("path must be a relative file path inside ~/.household/outbox");
      const kind = args.kind ?? "document";
      if (kind !== "document" && kind !== "photo" && kind !== "voice" && kind !== "video") throw new Error("kind must be document, photo, voice or video");
      if (args.caption !== undefined && (typeof args.caption !== "string" || args.caption.length > 1024)) throw new Error("caption must be text up to 1024 characters");
      if (args.channel !== undefined && typeof args.channel !== "string") throw new Error("channel must be a Household channel id");
      if (args.place !== undefined && typeof args.place !== "string") throw new Error("place must be a Household place id");
      if (args.place !== undefined && args.channel !== undefined) throw new Error("Pass place or channel, not both");
      try {
        const home = homeOf?.(house, pet);
        const bytes = await (home?.files ?? files).read(home?.volume ?? petVolume(house, pet), args.path, (kind === "photo" ? 10 : 50) * 1024 * 1024);
        const attachment: OutgoingAttachment = { kind, bytes, name: posix.basename(args.path), caption: args.caption as string | undefined };
        signal?.throwIfAborted();
        const sent = await chat.sendAttachment(house, pet, attachment, args.channel as string | undefined, signal, args.place as string | undefined);
        log.info(`bot ${house}/${pet}: sent ${kind} (${bytes.length} bytes), message ${sent.id} in ${sent.channel}`);
        return JSON.stringify(sent);
      } catch (error) {
        log.error(`bot ${house}/${pet}: outgoing ${kind} failed`);
        throw error;
      }
    },
  };
}
