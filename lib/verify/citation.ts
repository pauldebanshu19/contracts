import type { Segment } from "../text/normalize";
import { verifyQuote, type QuoteMatch, type VerifiableDoc } from "./quote";


export interface CitationDoc {
  id: string;
  alias: string;
  name: string;
  doc: VerifiableDoc;
  /** Text ranges the model was given from this document. */
  preferred: Segment[];
}

export type CitationReason = "empty" | "too_short" | "not_found" | "unknown_document" | "wrong_document";

export interface CitationResult {
  verified: boolean;
  reason?: CitationReason;
  /** Shown to the user for unverified quotes. */
  reasonText?: string;
  /** The document the quote was checked against, when one could be resolved. */
  documentId: string | null;
  alias: string | null;
  modelQuote: string;
  displayText: string;
  matches: QuoteMatch[];
  primary: number;
}

function resolve(alias: string | null, docs: CitationDoc[]): CitationDoc | null {
  if (docs.length === 1) return docs[0];
  if (!alias) return null;
  const wanted = alias.trim().toUpperCase();
  return (
    docs.find((d) => d.alias.toUpperCase() === wanted) ??
    docs.find((d) => d.name.trim().toUpperCase() === wanted) ??
    null
  );
}

export function verifyCitation(alias: string | null, quote: string, docs: CitationDoc[]): CitationResult {
  const target = resolve(alias, docs);
  const single = docs.length === 1;

  if (!target) {
    return {
      verified: false,
      reason: "unknown_document",
      reasonText: alias
        ? `Unverified: "${alias}" isn't one of the documents in this chat`
        : "Unverified: the quote doesn't say which document it is from",
      documentId: null,
      alias,
      modelQuote: quote,
      displayText: quote.trim(),
      matches: [],
      primary: -1,
    };
  }

  const result = verifyQuote(quote, target.doc, { preferred: target.preferred });
  const base = {
    documentId: target.id,
    alias: target.alias,
    modelQuote: quote,
    displayText: result.displayText,
    matches: result.matches,
    primary: result.primary,
  };
  if (result.verified) return { verified: true, ...base };

  if (result.reason === "too_short" || result.reason === "empty") {
    return { verified: false, reason: result.reason, reasonText: "Unverified: too short to verify", ...base };
  }

  if (!single) {
    const elsewhere = docs.find((d) => d !== target && verifyQuote(quote, d.doc).verified);
    if (elsewhere) {
      return {
        verified: false,
        reason: "wrong_document",
        reasonText: `Not in ${target.name} (appears in ${elsewhere.name})`,
        ...base,
      };
    }
  }

  return {
    verified: false,
    reason: "not_found",
    reasonText: single ? "Unverified: not found in this document" : `Unverified: not found in ${target.name}`,
    ...base,
  };
}
