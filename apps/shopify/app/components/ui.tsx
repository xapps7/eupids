// Small client helpers shared by admin screens.
import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";

export const SEVERITY_TONE = { error: "critical", warning: "warning", info: "info" } as const;

export const RULE_LABEL: Record<string, string> = {
  "R-MPID-01": "SKU missing",
  "R-MPID-02": "SKU duplicated",
  "R-NSPID-01": "Manufacturer code missing",
  "R-NSPID-02": "Manufacturer code = SKU",
  "R-NSPID-03": "Own brand",
  "R-NSPID-04": "Manufacturer code invalid",
  "R-NSPID-05": "Non-Latin characters",
  "R-SPID-01": "Barcode missing",
  "R-SPID-02": "Barcode wrong length",
  "R-SPID-03": "Barcode check digit wrong",
  "R-SPID-04": "Barcode not real",
  "R-SPID-05": "Internal code, not a barcode",
  "R-SPID-06": "Barcode on another product",
  "R-SPID-07": "Barcode and “none” both set",
  "R-HS-01": "HS code missing",
  "R-HS-02": "HS code format",
  "R-COO-01": "Origin missing",
};

export function toast(message: string, isError = false) {
  const sh = (globalThis as any).shopify;
  if (sh?.toast?.show) sh.toast.show(message, { isError });
  else console.log(`[toast] ${message}`);
}

/**
 * Download a CSV from an app route. Uses fetch so App Bridge adds the session token
 * inside the Shopify admin iframe.
 */
export async function downloadFile(url: string, fallbackName: string) {
  const res = await fetch(url);
  if (!res.ok) {
    toast("Download failed. Try again.", true);
    return;
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function csvResponse(body: string, filename: string) {
  return new Response("﻿" + body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Poll the loader while something runs in the background (scan, job). */
export function usePolling(active: boolean, ms = 2500) {
  const { revalidate, state } = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => state === "idle" && revalidate(), ms);
    return () => clearInterval(t);
  }, [active, ms, revalidate, state]);
}

export type JobView = { id: string; status: string; total: number; done: number; failed: number; type: string };

/** Progress banner for a background job (FR-08). */
export function JobProgress({ jobId, onDone }: { jobId: string; onDone?: (j: JobView) => void }) {
  const fetcher = useFetcher<{ job: JobView | null }>();
  const doneRef = useRef(false);
  useEffect(() => {
    fetcher.load(`/app/jobs/${jobId}`);
    const t = setInterval(() => fetcher.load(`/app/jobs/${jobId}`), 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  const job = fetcher.data?.job;
  useEffect(() => {
    if (job && (job.status === "complete" || job.status === "failed") && !doneRef.current) {
      doneRef.current = true;
      onDone?.(job);
    }
  }, [job, onDone]);
  if (!job) return <s-banner tone="info" heading="Starting…" />;
  const finished = job.status === "complete";
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 100;
  return (
    <s-banner tone={job.status === "failed" ? "critical" : finished ? (job.failed ? "warning" : "success") : "info"}
      heading={job.status === "failed" ? "This action stopped" : finished ? `Done: ${job.done - job.failed} saved${job.failed ? `, ${job.failed} failed` : ""}` : `Working… ${job.done} of ${job.total} (${pct}%)`}>
      {finished && job.failed > 0 && (
        <s-button variant="tertiary" onClick={() => downloadFile(`/app/jobs/${job.id}/failures`, "failures.csv")}>
          Download failures CSV
        </s-button>
      )}
    </s-banner>
  );
}

/** Mirror a Polaris field's value into React state (works with web-component events). */
export function fieldValue(e: Event | { currentTarget: unknown }): string {
  const t = (e as any).currentTarget ?? (e as any).target;
  return String(t?.value ?? "");
}

export function useFlag(initial = false) {
  const [v, set] = useState(initial);
  return [v, () => set((x) => !x), set] as const;
}

export function daysLeft(now = new Date()) {
  const ms = Date.UTC(2026, 10, 1) - now.getTime();
  return ms <= 0 ? null : Math.ceil(ms / 86_400_000);
}

export const DISCLAIMER = "PID Ready checks your data. It is not legal or customs advice.";
