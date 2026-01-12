"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { durationMinutes, fmtMin, toLocal } from "../../../lib/format";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string;
  created_at: string;
};

type Entry = {
  id: string;
  job_id: string;
  worker: string;
  task: string | null;
  start_ts: string;
  end_ts: string | null;
};

const WORKERS = ["M1", "M2", "M3", "M4"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt", "Reinigung", "Abgabe"];

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);

  const [runningEntryId, setRunningEntryId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  async function load() {
    const { data: j, error: je } = await supabase.from("jobs").select("*").eq("id", jobId).single();
    if (je) {
      setStatus(je.message);
      return;
    }
    setJob(j as any);

    const { data: e, error: ee } = await supabase
      .from("time_entries")
      .select("*")
      .eq("job_id", jobId)
      .order("start_ts", { ascending: false });

    if (ee) {
      setStatus(ee.message);
      return;
    }
    const arr = (e || []) as any as Entry[];
    setEntries(arr);

    const running = arr.find((x) => x.worker === worker && !x.end_ts);
    setRunningEntryId(running ? running.id : null);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // when worker changes, update running status
    const running = entries.find((x) => x.worker === worker && !x.end_ts);
    setRunningEntryId(running ? running.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker]);

  const totals = useMemo(() => {
    const perWorker: Record<string, number> = {};
    let total = 0;
    for (const e of entries) {
      const min = durationMinutes(e.start_ts, e.end_ts);
      total += min;
      perWorker[e.worker] = (perWorker[e.worker] || 0) + min;
    }
    return { total, perWorker };
  }, [entries]);

  async function start() {
    const already = entries.find((e) => e.worker === worker && !e.end_ts);
    if (already) {
      setRunningEntryId(already.id);
      setStatus("Läuft bereits…");
      return;
    }

    const { data, error } = await supabase
      .from("time_entries")
      .insert({ job_id: jobId, worker, task })
      .select("id")
      .single();

    if (error) {
      setStatus(error.message);
      return;
    }
    setRunningEntryId(data.id);
    setStatus("✅ läuft…");
    await load();
  }

  async function stop() {
    if (!runningEntryId) {
      setStatus("Kein laufender Timer.");
      return;
    }

    const { error } = await supabase
      .from("time_entries")
      .update({ end_ts: new Date().toISOString() })
      .eq("id", runningEntryId);

    if (error) {
      setStatus(error.message);
      return;
    }

    setRunningEntryId(null);
    setStatus("🛑 gestoppt");
    await load();
  }

  function exportCsv() {
    const header = ["worker", "task", "start", "end", "duration_min"].join(",");
    const rows = entries
      .slice()
      .reverse()
      .map((e) => {
        const dur = durationMinutes(e.start_ts, e.end_ts);
        return [JSON.stringify(e.worker), JSON.stringify(e.task || ""), JSON.stringify(e.start_ts), JSON.stringify(e.end_ts || ""), dur].join(",");
      });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auftrag_${jobId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <a href="/" style={{ color: "#111" }}>
        ← zurück
      </a>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
        <img
          src="/logo.svg"
          alt="Pro Automobile"
          style={{ width: 56, height: 56, borderRadius: 12, objectFit: "contain", background: "#fff", border: "1px solid #eee", padding: 6 }}
        />
        <div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>{job?.title || "Auftrag"}</div>
          <div style={{ color: "#666" }}>{[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}</div>
        </div>
      </div>

      <div style={card()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 800 }}>QR-Link (Auftrag scannen)</div>
            <div style={{ color: "#666", fontSize: 13, wordBreak: "break-all" }}>{jobLink}</div>
          </div>
          <img src={qrUrl} alt="QR" style={{ width: 120, height: 120, borderRadius: 12, border: "1px solid #eee" }} />
        </div>
      </div>

      <div style={card()}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Start / Stop</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <select value={worker} onChange={(e) => setWorker(e.target.value)} style={inp()}>
            {WORKERS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>

          <select value={task} onChange={(e) => setTask(e.target.value)} style={inp()}>
            {TASKS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
          <button onClick={start} disabled={!!runningEntryId} style={btn(!!runningEntryId)}>
            Start
          </button>
          <button onClick={stop} disabled={!runningEntryId} style={btn(!runningEntryId)}>
            Stop
          </button>
        </div>

        <div style={{ color: "#666", marginTop: 8 }}>{status}</div>
      </div>

      <div style={card()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ fontWeight: 900 }}>Rapport</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={load} style={btn(false)}>
              Aktualisieren
            </button>
            <button onClick={exportCsv} style={btn(false)}>
              CSV
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div>
            <b>Total:</b> {fmtMin(totals.total)}
          </div>
          {Object.entries(totals.perWorker).map(([w, m]) => (
            <div key={w}>
              {w}: {fmtMin(m)}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th()}>Mitarbeiter</th>
                <th style={th()}>Tätigkeit</th>
                <th style={th()}>Start</th>
                <th style={th()}>Ende</th>
                <th style={th()}>Dauer</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const dur = durationMinutes(e.start_ts, e.end_ts);
                return (
                  <tr key={e.id}>
                    <td style={td()}>{e.worker}</td>
                    <td style={td()}>{e.task || ""}</td>
                    <td style={td()}>{toLocal(e.start_ts)}</td>
                    <td style={td()}>{e.end_ts ? toLocal(e.end_ts) : <b>läuft…</b>}</td>
                    <td style={td()}>{fmtMin(dur)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ color: "#666", fontSize: 12 }}>
        Installation auf Samsung: Chrome öffnen → ⋮ → <b>App installieren</b>.
      </div>
    </div>
  );
}

function card(): React.CSSProperties {
  return { border: "1px solid #e5e5e5", borderRadius: 16, padding: 14, margin: "12px 0" };
}
function inp(): React.CSSProperties {
  return { width: "100%", padding: 12, fontSize: 16, borderRadius: 12, border: "1px solid #ddd" };
}
function btn(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: 12,
    fontSize: 16,
    borderRadius: 12,
    border: "1px solid #111",
    background: disabled ? "#f2f2f2" : "#111",
    color: disabled ? "#999" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer"
  };
}
function th(): React.CSSProperties {
  return { textAlign: "left", borderBottom: "1px solid #eee", padding: 8, fontSize: 13 };
}
function td(): React.CSSProperties {
  return { borderBottom: "1px solid #f2f2f2", padding: 8, fontSize: 13 };
}
