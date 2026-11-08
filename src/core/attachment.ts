import { clean } from "./header";
import { ATTACHMENTS_TAG, block, tagFreeJson } from "./tags";

/** The channel's handle on a file a message came with: opaque, only its channel downloads by it (Telegram: a file id). */
export type FileRef = string & { readonly __brand: "FileRef" };

/** What a file is, in Household's words: `video-note` is a round video message. */
export type AttachmentKind = "photo" | "document" | "voice" | "audio" | "video" | "video-note" | "animation" | "sticker";

/**
 * A file a person's message came with, as its channel describes it: `name` and `mime` as the sender's app gave
 * them (never trusted as a path), `size` in bytes, `duration` in seconds, `emoji`: what a sticker stands for.
 * Household fills in what it made of it, exactly one of: `path`, where the pet finds it in its VM, or `failed`,
 * why it is not there. A file with neither is not fetched yet.
 */
export interface Attachment {
  kind: AttachmentKind;
  file: FileRef;
  name?: string;
  mime?: string;
  size?: number;
  duration?: number;
  emoji?: string;
  path?: string;
  failed?: string;
}

/** Where Household keeps what came for a pet, in its home: one directory per day, deleted after INBOX_DAYS. */
export const INBOX_DIR = ".household/inbox";
export const INBOX_DAYS = 3;

export const fetched = (attachment: Attachment) => attachment.path !== undefined || attachment.failed !== undefined;

/** An extension for files whose name has none. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav", "audio/flac": "flac",
  "application/x-tgsticker": "tgs", "application/pdf": "pdf", "application/zip": "zip", "text/plain": "txt",
};

/** A piece of a name kept in a file name: letters, digits, `-` and `_` only, runs of anything else as one `_`. */
const safe = (text: string, max: number) =>
  [...text.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^[_-]+|[_-]+$/g, "")].slice(0, max).join("");

/**
 * The file's name in the inbox: `<message id>-<name>.<extension>`. Built by Household from the sender's name
 * (its last part only, its characters cut to the safe ones), so no name can climb out of the inbox or hide as a
 * dot file; the kind stands in for a name there is none of. The extension is the name's own, or the MIME type's.
 */
export function inboxFileName(message: string, attachment: Attachment): string {
  const given = (attachment.name ?? "").split(/[/\\]/).pop()!;
  const dot = given.lastIndexOf(".");
  const own = dot > 0 ? given.slice(dot + 1).toLowerCase() : "";
  const extension = /^[a-z0-9]{1,10}$/.test(own) ? own : EXTENSIONS[attachment.mime?.toLowerCase() ?? ""] ?? "bin";
  const stem = [...(safe(dot > 0 ? given.slice(0, dot) : given, 60) || attachment.kind)];
  const prefix = `${safe(message, 20) || "message"}-`;
  // Storage bounds names in UTF-8 bytes, not code points. Keep whole characters and the extension.
  const encoder = new TextEncoder();
  while (encoder.encode(`${prefix}${stem.join("")}.${extension}`).length > 200) stem.pop();
  return `${prefix}${stem.join("")}.${extension}`;
}

/** A message's text as records and notices show it: its files named first, by kind (`(photo) caption`). */
export const withFiles = (text: string, attachments: readonly Attachment[] = []) =>
  attachments.length === 0 ? text : [`(${attachments.map(({ kind }) => kind).join(", ")})`, text].filter(Boolean).join(" ");

/**
 * The files of a message as the pet gets them, after its content: one line of JSON each (`tagFreeJson`), the
 * sender's words cleaned as a header's are; where it is (`path`) or why it is not (`failed`).
 */
export function attachmentsBlock(attachments: readonly Attachment[]): string {
  const lines = attachments.map(({ kind, name, mime, size, duration, emoji, path, failed }) =>
    tagFreeJson({
      kind,
      ...(name === undefined ? {} : { name: clean(name) }),
      ...(mime === undefined ? {} : { mime: clean(mime) }),
      ...(size === undefined ? {} : { size }),
      ...(duration === undefined ? {} : { duration }),
      ...(emoji === undefined ? {} : { emoji: clean(emoji) }),
      ...(path === undefined ? {} : { path }),
      ...(failed === undefined ? {} : { failed }),
    }),
  );
  return block(ATTACHMENTS_TAG, lines, { count: attachments.length });
}

/** A file the pet explicitly sends to its channel; bytes come from its own outbox. */
export interface OutgoingAttachment {
  /** How it shows: a file, an inline image, a voice message, or a video that plays in the chat. */
  kind: "document" | "photo" | "voice" | "video";
  name: string;
  bytes: Uint8Array;
  caption?: string;
  mime?: string;
}
