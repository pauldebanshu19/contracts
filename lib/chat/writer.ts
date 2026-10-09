import {
  citeMarker,
  type AgentStep,
  type AnswerMode,
  type AnswerStatus,
  type CitationDTO,
  type Coverage,
  type MessageStatus,
  type StreamEvent,
} from "../types";



export interface AnswerSnapshot {
  content: string;
  status: MessageStatus;
  mode: AnswerMode;
  answerStatus: AnswerStatus | null;
  coverage: Coverage | null;
  steps: AgentStep[];
  error: string | null;
  citations: CitationDTO[];
  /** What the model wrote inside each quote, by ordinal. Stored for audit, never shown. */
  modelQuotes: Record<number, string>;
}

export interface AnswerSink {
  /** Send to the browser. Must not throw if the browser has gone away. */
  emit(event: StreamEvent): void;
  /** Save the answer as it stands. */
  persist(snapshot: AnswerSnapshot): Promise<void>;
}

const PERSIST_EVERY_MS = 400;

export class AnswerWriter {
  private content = "";
  private readonly citations = new Map<number, CitationDTO>();
  private readonly modelQuotes = new Map<number, string>();
  private readonly pending = new Set<number>();
  private steps: AgentStep[] = [];
  private nextOrdinal = 0;
  private nextStep = 0;
  private lastPersist = 0;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly sink: AnswerSink,
    private mode: AnswerMode = "targeted",
  ) {}

  get currentMode(): AnswerMode {
    return this.mode;
  }

  /** Set before anything has been written. Use reset() to replace an answer already under way. */
  setMode(mode: AnswerMode): void {
    this.mode = mode;
  }

  get verifiedCount(): number {
    let count = 0;
    for (const citation of this.citations.values()) if (citation.verified) count++;
    return count;
  }

  get citationCount(): number {
    return this.citations.size;
  }

  get text_(): string {
    return this.content;
  }

  text(text: string): void {
    // An answer shouldn't open with the blank line that follows the status tag.
    const out = this.content ? text : text.trimStart();
    if (!out) return;
    this.content += out;
    this.sink.emit({ type: "text", text: out });
    this.touch();
  }

  /** A quote has started. The browser shows "Checking quote…" until it is resolved. */
  openCite(): number {
    const ordinal = this.nextOrdinal++;
    this.pending.add(ordinal);
    this.content += citeMarker(ordinal);
    this.sink.emit({ type: "cite_pending", ordinal });
    return ordinal;
  }

  resolveCite(ordinal: number, { modelQuote, ...citation }: Omit<CitationDTO, "ordinal"> & { modelQuote?: string }): void {
    const full: CitationDTO = { ...citation, ordinal };
    if (modelQuote !== undefined) this.modelQuotes.set(ordinal, modelQuote);
    this.pending.delete(ordinal);
    this.citations.set(ordinal, full);
    this.sink.emit({ type: "citation", citation: full });
    this.touch();
  }

  dropCite(ordinal: number): void {
    this.pending.delete(ordinal);
    this.content = this.content.replace(citeMarker(ordinal), "");
    this.sink.emit({ type: "cite_drop", ordinal });
  }

  /** A progress line; not part of the saved answer. */
  status(message: string): void {
    this.sink.emit({ type: "status", message });
  }

  startStep(tool: string, label: string): AgentStep {
    const step: AgentStep = { id: this.nextStep++, tool, label, status: "running" };
    this.steps.push(step);
    this.sink.emit({ type: "step", step });
    this.touch();
    return step;
  }

  endStep(step: AgentStep, update: Partial<Pick<AgentStep, "label" | "detail" | "status">>): void {
    Object.assign(step, { status: "done" }, update);
    this.sink.emit({ type: "step", step: { ...step } });
    this.touch();
  }

  
  reset(mode: AnswerMode): void {
    this.content = "";
    this.citations.clear();
    this.modelQuotes.clear();
    this.pending.clear();
    this.mode = mode;
    this.sink.emit({ type: "reset", mode });
    this.touch();
  }

  private snapshot(status: MessageStatus, extra: Partial<AnswerSnapshot> = {}): AnswerSnapshot {
    let content = this.content;
    // A quote that never resolved must not leave a marker behind.
    for (const ordinal of this.pending) content = content.replace(citeMarker(ordinal), "");
    return {
      content,
      status,
      mode: this.mode,
      answerStatus: null,
      coverage: null,
      steps: this.steps.map((s) => ({ ...s })),
      error: null,
      citations: [...this.citations.values()].sort((a, b) => a.ordinal - b.ordinal),
      modelQuotes: Object.fromEntries(this.modelQuotes),
      ...extra,
    };
  }

  private touch(): void {
    if (this.finished) return;
    const now = Date.now();
    if (now - this.lastPersist < PERSIST_EVERY_MS) return;
    this.lastPersist = now;
    const snapshot = this.snapshot("streaming");
    // Writes are chained so a slow one can't land after a newer one.
    this.chain = this.chain.then(() => this.sink.persist(snapshot)).catch((e) => console.error("[chat] persist:", e));
  }

  async finish(result: {
    status: MessageStatus;
    answerStatus: AnswerStatus | null;
    coverage: Coverage | null;
    error?: string | null;
  }): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const ordinal of [...this.pending]) this.dropCite(ordinal);
    for (const step of this.steps) if (step.status === "running") step.status = result.status === "complete" ? "done" : "error";

    if (result.coverage) this.sink.emit({ type: "coverage", coverage: result.coverage });
    if (result.error) this.sink.emit({ type: "error", message: result.error });

    const snapshot = this.snapshot(result.status, {
      answerStatus: result.answerStatus,
      coverage: result.coverage,
      error: result.error ?? null,
    });
    await this.chain;
    await this.sink.persist(snapshot);
    this.sink.emit({ type: "done", status: result.status, answerStatus: result.answerStatus });
  }
}
