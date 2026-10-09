export type IngestErrorCode =
  | "unsupported_type"
  | "too_large"
  | "encrypted"
  | "corrupt"
  | "needs_ocr"
  | "empty"
  | "internal";

/** A failure with a message written for the person who uploaded the file. */
export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IngestError";
  }
}

export const NEEDS_OCR_MESSAGE =
  "This PDF is scanned images, so there's no text to read. Upload a text-based PDF or run OCR first.";
