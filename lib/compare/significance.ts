import type { Significance } from "../db/schema";
import type { ClausePair } from "./align";



export const SIGNIFICANCE_ORDER: Significance[] = ["cosmetic", "low", "medium", "high"];

export function rank(s: Significance): number {
  return SIGNIFICANCE_ORDER.indexOf(s);
}

export function maxSignificance(a: Significance, b: Significance): Significance {
  return rank(a) >= rank(b) ? a : b;
}

export interface Floor {
  floor: Significance;
  reasons: string[];
}

const CURRENCY = "(?:AED|USD|EUR|GBP|SAR|QAR|KWD|BHD|OMR|INR|CHF|JPY|CNY|US\\$|\\$|€|£|Dhs?\\.?)";
const AMOUNT = new RegExp(
  `${CURRENCY}\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:million|billion|thousand|m|bn|k)\\b)?|\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:million|billion)?\\s?(?:${CURRENCY.slice(3, -1)}|dirhams?|dollars?|euros?|pounds?)\\b`,
  "gi",
);
const PERCENT = /\b\d+(?:\.\d+)?\s?(?:%|per\s?cent\b|percent\b)/gi;
const NUMBER_WORD = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety|hundred)";
const DURATION = new RegExp(
  `\\b${NUMBER_WORD}(?:\\s*\\(\\d+\\))?\\s*(?:business\\s+|working\\s+|calendar\\s+|clear\\s+)?(?:days?|weeks?|months?|years?|hours?)\\b`,
  "gi",
);
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = new RegExp(
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+\\d{4}\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b`,
  "gi",
);
const MODAL = /\b(?:shall not|shall|may not|may|must not|must|will not|will|is not entitled to|is entitled to|need not)\b/gi;
const PARTY =
  /\b(?:Supplier|Customer|Client|Contractor|Subcontractor|Provider|Licensor|Licensee|Landlord|Tenant|Lessor|Lessee|Buyer|Seller|Purchaser|Vendor|Employer|Employee|Lender|Borrower|Guarantor|Agent|Consultant|Distributor)\b/g;
const LIABILITY = /\b(?:liab\w*|indemn\w*|limitation of liability|aggregate cap|consequential|hold harmless)\b/i;
const MONEY_TOPIC = /\b(?:fees?|price|payment|payable|charges?|rent|invoice|interest|penalt\w*|liquidated damages)\b/i;

function collect(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((m) => m.replace(/\s+/g, " ").trim().toLowerCase()).sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function describe(kind: string, a: string[], b: string[]): string {
  const removed = a.filter((v) => !b.includes(v));
  const added = b.filter((v) => !a.includes(v));
  if (removed.length && added.length) return `${kind} changed: ${removed.join(", ")} → ${added.join(", ")}`;
  if (added.length) return `${kind} added: ${added.join(", ")}`;
  if (removed.length) return `${kind} removed: ${removed.join(", ")}`;
  return `${kind} changed`;
}

export function significanceFloor(pair: ClausePair): Floor {
  const a = pair.a?.body ?? "";
  const b = pair.b?.body ?? "";
  const both = `${pair.a?.heading ?? ""} ${pair.b?.heading ?? ""} ${a} ${b}`;

  if (pair.type === "unchanged") return { floor: "cosmetic", reasons: [] };
  if (pair.type === "cosmetic") return { floor: "cosmetic", reasons: ["Formatting or punctuation only"] };
  if (pair.type === "moved" && pair.a && pair.b && pair.a.body.replace(/\s+/g, " ") === pair.b.body.replace(/\s+/g, " ")) {
    const where = pair.relocated
      ? `Moved${pair.renumbered ? ` from ${pair.a.number || "the start"} to ${pair.b.number}` : ""}, wording unchanged`
      : `Renumbered from ${pair.a.number} to ${pair.b.number}`;
    return { floor: "cosmetic", reasons: [where] };
  }

  if (pair.type === "added" || pair.type === "removed") {
    const text = a || b;
    const reasons = [pair.type === "added" ? "New clause" : "Clause deleted"];
    if (LIABILITY.test(both)) return { floor: "high", reasons: [...reasons, "Concerns liability"] };
    if (collect(text, AMOUNT).length) return { floor: "high", reasons: [...reasons, "Contains an amount"] };
    return { floor: "medium", reasons };
  }

  // Modified (or moved and modified): what kind of words changed?
  const reasons: string[] = [];
  let floor: Significance = "low";
  const raise = (to: Significance, reason: string) => {
    floor = maxSignificance(floor, to);
    reasons.push(reason);
  };

  const amounts = [collect(a, AMOUNT), collect(b, AMOUNT)];
  if (!sameList(amounts[0], amounts[1])) raise("high", describe("Amount", amounts[0], amounts[1]));

  const percents = [collect(a, PERCENT), collect(b, PERCENT)];
  if (!sameList(percents[0], percents[1])) raise(MONEY_TOPIC.test(both) ? "high" : "medium", describe("Percentage", percents[0], percents[1]));

  const durations = [collect(a, DURATION), collect(b, DURATION)];
  if (!sameList(durations[0], durations[1])) raise("medium", describe("Time period", durations[0], durations[1]));

  const dates = [collect(a, DATE), collect(b, DATE)];
  if (!sameList(dates[0], dates[1])) raise("medium", describe("Date", dates[0], dates[1]));

  const modals = [collect(a, MODAL), collect(b, MODAL)];
  if (!sameList(modals[0], modals[1])) raise("medium", describe("Obligation wording", modals[0], modals[1]));

  const parties = [collect(a, PARTY), collect(b, PARTY)];
  if (!sameList([...new Set(parties[0])], [...new Set(parties[1])])) raise("medium", describe("Party", [...new Set(parties[0])], [...new Set(parties[1])]));

  // Any real change to a liability clause matters, even without a number changing.
  if (LIABILITY.test(both)) raise("high", "Liability clause changed");
  if (pair.relocated) reasons.push("Moved to a different place");
  return { floor, reasons };
}
