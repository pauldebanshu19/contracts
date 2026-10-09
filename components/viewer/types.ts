export interface ViewerTarget {
  documentId: string;
  matches: { segments: { start: number; end: number }[] }[];
  
  primary: number;
  /** The verified quote, used only if the rendered text doesn't line up with the stored text. */
  displayText?: string;
  /** Changes on every click, so clicking the same quote again re-scrolls to it. */
  key: string;
}

export interface ViewMeta {
  id: string;
  name: string;
  kind: "pdf" | "docx";
  pageCount: number | null;
  unreadablePages: number[];
  html: string | null;
  textLength: number;
  pageLengths: number[];
  itemCounts: number[];
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
