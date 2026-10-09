/**
 * File type by content, not by name (PRD A1.1). The same check runs in the
 * browser before upload and on the server after it, so it works on plain bytes.
 */

export type DocKind = "pdf" | "docx";

export type SniffResult =
  | { ok: true; kind: DocKind }
  | { ok: false; code: "unsupported_type" | "legacy_or_encrypted_word"; message: string };

const NOT_SUPPORTED = "This isn't a PDF or Word file.";

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** File names in a ZIP, read from its central directory. Null if the bytes aren't a readable ZIP. */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  // The end-of-central-directory record sits in the last 64 KB.
  const floor = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) return null;
    const nameLength = u16(bytes, at + 28);
    names.push(ascii(bytes, at + 46, nameLength));
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
  }
  return names;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function sniff(name: string, bytes: Uint8Array): SniffResult {
  const ext = extensionOf(name);
  if (ext !== "pdf" && ext !== "docx") {
    return { ok: false, code: "unsupported_type", message: NOT_SUPPORTED };
  }

  if (ext === "pdf") {
    // The header may be preceded by a few junk bytes, but must be near the start.
    return ascii(bytes, 0, 1024).includes("%PDF-")
      ? { ok: true, kind: "pdf" }
      : { ok: false, code: "unsupported_type", message: NOT_SUPPORTED };
  }

  // Password-protected .docx files and old .doc files are OLE containers, not ZIPs.
  if (u32(bytes, 0) === 0xe011cfd0) {
    return {
      ok: false,
      code: "legacy_or_encrypted_word",
      message:
        "This Word file is password-protected or in the old .doc format. Remove the password or save it as .docx, then upload again.",
    };
  }
  if (u32(bytes, 0) !== 0x04034b50) {
    return { ok: false, code: "unsupported_type", message: NOT_SUPPORTED };
  }
  const names = zipEntryNames(bytes);
  return names?.includes("word/document.xml")
    ? { ok: true, kind: "docx" }
    : { ok: false, code: "unsupported_type", message: NOT_SUPPORTED };
}
