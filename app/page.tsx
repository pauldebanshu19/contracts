import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { Spinner } from "@/components/ui";

export default function Home() {
  return (
    // The shell reads the URL's search params, which are only known in the browser.
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-text-2">
          <Spinner /> <span className="ml-2 text-sm">Loading…</span>
        </div>
      }
    >
      <AppShell />
    </Suspense>
  );
}
