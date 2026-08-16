"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function WatchWait({
  detail,
  sessionName,
  watchPath,
}: {
  detail: string;
  sessionName: string;
  watchPath: string;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule() {
      timer = setTimeout(() => {
        if (cancelled) return;
        if (document.visibilityState === "visible") router.refresh();
        schedule();
      }, 5_000);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") router.refresh();
    }

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return (
    <div className="card">
      <h1>{sessionName}</h1>
      <p className="muted" aria-live="polite">
        {detail}
      </p>
      <div className="actions">
        <a className="button-link" href={watchPath}>
          Check now
        </a>
        <a className="button-link secondary-button" href="/">
          Sessions
        </a>
      </div>
    </div>
  );
}
