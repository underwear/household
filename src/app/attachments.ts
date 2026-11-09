import { posix } from "node:path";
import { fetched, inboxFileName, INBOX_DAYS, INBOX_DIR, type Attachment } from "../core/attachment";
import { DownloadRefused } from "../core/channel";
import type { Message } from "../core/message";
import type { PetInboxFiles } from "../infra/pet-inbox";
import { petVolume } from "./pet-plane";

export interface FetchTiming {
  /** The waits before each new try of a download that failed passingly: one try more than there are waits. */
  retriesMs: number[];
  /** How long one try may take (Telegram's 20 MB over a slow line, too). */
  attemptMs: number;
}

export const FETCH_TIMING: FetchTiming = { retriesMs: [2_000, 10_000, 30_000], attemptMs: 120_000 };

/** The bytes of a file a message came with, from the channel of its place; `DownloadRefused` when they never will come. */
export type Download = (house: string, place: string | undefined, attachment: Attachment, signal: AbortSignal) => Promise<Uint8Array>;

type Log = { info(message: string): void; error(message: string): void };

/**
 * The files of a person's message, brought into its pet's inbox (`INBOX_DIR`, a directory per day) before the
 * pet gets the message: Delivery asks, off the channel's poller, so a slow or failed download holds nothing but
 * that message (and those behind it). A file that does not come is the pet's to know: it gets why.
 */
export class AttachmentFetcher {
  constructor(
    private readonly download: Download,
    private readonly files: Pick<PetInboxFiles, "save">,
    private readonly log: Log,
    /** The day's directory is the date in Household's timezone. */
    private readonly timezone: () => string,
    private readonly timing: FetchTiming = FETCH_TIMING,
  ) {}

  /**
   * The message's files, each with its `path` as the pet sees it (`home`: its home in the VM) or why it `failed`;
   * one fetched before stays as it is. Never throws.
   */
  async fetch(house: string, pet: string, home: string, message: Message): Promise<Attachment[]> {
    const event = message.header?.event;
    const id = event && "id" in event ? event.id : String(message.id);
    const result: Attachment[] = [];
    for (const attachment of message.attachments ?? []) {
      result.push(fetched(attachment) ? attachment : await this.one(house, pet, home, id, message.place, attachment));
    }
    return result;
  }

  private async one(house: string, pet: string, home: string, id: string, place: string | undefined, attachment: Attachment): Promise<Attachment> {
    const name = `bot ${house}/${pet}: ${attachment.kind} of ${id}`;
    let bytes: Uint8Array;
    try {
      bytes = await this.downloaded(house, place, attachment);
    } catch (error) {
      this.log.error(`${name} not downloaded: ${(error as Error).message}`);
      return { ...attachment, failed: `not downloaded: ${(error as Error).message}` };
    }
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: this.timezone(), dateStyle: "short" }).format(Date.now());
    try {
      const saved = await this.files.save(petVolume(house, pet), day, inboxFileName(id, attachment), bytes);
      this.log.info(`${name} saved to ${saved}`);
      return { ...attachment, path: posix.join(home, saved) };
    } catch (error) {
      this.log.error(`${name} not saved: ${(error as Error).message}`);
      return { ...attachment, failed: `not downloaded: could not write to ~/${INBOX_DIR} (${(error as Error).message})` };
    }
  }

  /** Tries again after a passing failure (the network, the channel not open yet, Telegram's own trouble), never after a refusal. */
  private async downloaded(house: string, place: string | undefined, attachment: Attachment): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.download(house, place, attachment, AbortSignal.timeout(this.timing.attemptMs));
      } catch (error) {
        const wait = this.timing.retriesMs[attempt];
        if (error instanceof DownloadRefused || wait === undefined) throw error;
        await Bun.sleep(wait);
      }
    }
  }
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Household's side of the inboxes' retention: now and every `everyMs`, what is older than INBOX_DAYS goes from
 * every pet's inbox. Returns how to stop it.
 */
export function sweepInboxes(files: Pick<PetInboxFiles, "sweep">, log: Log, everyMs = 6 * 60 * 60_000): () => void {
  const sweep = () =>
    files.sweep(new Date(Date.now() - INBOX_DAYS * DAY_MS)).then(
      (removed) => removed > 0 && log.info(`inboxes: ${removed} file(s) older than ${INBOX_DAYS} days deleted`),
      (error) => log.error(`inboxes: not swept (${(error as Error).message})`),
    );
  void sweep();
  const timer = setInterval(() => void sweep(), everyMs);
  return () => clearInterval(timer);
}
