"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null;
  created_at?: string;
  closed_at?: string | null;
};

type Entry = {
  id: string;
  job_id: string;
  worker: string;
  task: string | null;
  start_ts: string;
  end_ts: string | null;
};

const WORKERS = ["Esteban", "Eron", "Jeremie", "Tsvetan", "Mensel"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt"];

const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

function askPin(): boolean {
  if (!ADMIN_PIN) {
    alert("Admin PIN fehlt. In Vercel Env Var NEXT_PUBLIC_ADMIN_PIN setzen.");
    return false;
  }
  const p = window.prompt("Admin PIN eingeben:");
  return (p || "").trim() === ADMIN_PIN;
}

function toLocal(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("de-CH");
}

function durationMinutes(start: string, end?: string | null) {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  return Math.max(0, Math.round((e - s) / 60000));
}

function fmtMin(min: number) {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}min`;
}

function fmtHM(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  const done = (job?.status || "open") === "done";

  async function load() {
    const { data: j } = await supabase.from("jobs").select("*").eq("id", jobId).single();
    setJob((j as any) || null);

    const { data: e } = await supabase
      .from("time_entries")
      .select("*")
      .eq("job_id", jobId)
      .order("start_ts", { ascending: false });

    const arr = ((e || []) as any) as Entry[];
    setEntries(arr);

    const running = arr.find((x) => x.worker === worker && !x.end_ts);
    setRunningId(running?.id || null);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const running = entries.find((x) => x.worker === worker && !x.end_ts);
    setRunningId(running?.id || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker]);

  const totals = useMemo(() => {
    let total = 0;
    const perWorker: Record<string, number> = {};
    for (const e of entries) {
      const min = durationMinutes(e.start_ts, e.end_ts);
      total += min;
      perWorker[e.worker] = (perWorker[e.worker] || 0) + min;
    }
    return { total, perWorker };
  }, [entries]);

  // ✅ Warnung: Mitarbeiter läuft evtl. auf anderem Auftrag
  async function checkRunningOtherJob() {
    const { data, error } = await supabase
      .from("time_entries")
      .select("id, job_id, start_ts, task")
      .eq("worker", worker)
      .is("end_ts", null)
      .limit(1);

    if (error) {
      console.log(error.message);
      return { ok: true, otherJobId: null as string | null };
    }

    const r = (data || [])[0] as any;
    if (!r) return { ok: true, otherJobId: null as string | null };

    // läuft auf anderem Job?
    if (r.job_id && r.job_id !== jobId) {
      return { ok: false, otherJobId: r.job_id as string };
    }

    return { ok: true, otherJobId: null as string | null };
  }

  async function start() {
    if (done) return setMsg("Auftrag ist abgeschlossen.");

    // ✅ Warnung wenn auf anderem Auftrag läuft
    const chk = await checkRunningOtherJob();
    if (!chk.ok && chk.otherJobId) {
      setMsg(`⚠️ ${worker} läuft bereits auf einem anderen Auftrag. Bitte zuerst stoppen!`);
      const go = window.confirm(`⚠️ ${worker} läuft bereits auf einem anderen Auftrag.\n\nDorthin wechseln?`);
      if (go) window.location.href = `/job/${chk.otherJobId}`;
      return;
    }

    const existing = entries.find((e) => e.worker === worker && !e.end_ts);
    if (existing) return setMsg("Läuft bereits…");

    const { data, error } = await supabase
      .from("time_entries")
      .insert({ job_id: jobId, worker, task })
      .select("id")
      .single();

    if (error) return setMsg(error.message);

    setRunningId(data.id);
    setMsg("✅ läuft…");
    await load();
  }

  async function stop() {
    if (!runningId) return;
    const { error } = await supabase
      .from("time_entries")
      .update({ end_ts: new Date().toISOString() })
      .eq("id", runningId);

    if (error) return setMsg(error.message);

    setRunningId(null);
    setMsg("🛑 gestoppt");
    await load();
  }

  async function closeJob() {
    if (!job) return;
    const nowIso = new Date().toISOString();

    // stoppe alles was läuft
    await supabase.from("time_entries").update({ end_ts: nowIso }).eq("job_id", jobId).is("end_ts", null);

    // ✅ Abschlusszeit speichern für Sortierung
    await supabase.from("jobs").update({ status: "done", closed_at: nowIso }).eq("id", jobId);

    setMsg("✅ Auftrag abgeschlossen");
    await load();
  }

  async function deleteJobAdmin() {
    if (!askPin()) return;
    const ok = window.confirm("Wirklich diesen Auftrag löschen? (inkl. Zeiten)");
    if (!ok) return;

    const { error: e1 } = await supabase.from("time_entries").delete().eq("job_id", jobId);
    if (e1) return alert(e1.message);

    const { error: e2 } = await supabase.from("jobs").delete().eq("id", jobId);
    if (e2) return alert(e2.message);

    alert("✅ Auftrag gelöscht");
    window.location.href = "/";
  }

  async function exportXlsx() {
    if (!job) return;

    const XLSX = await import("xlsx");
    const now = new Date();
    const datum = now.toLocaleString("de-CH");

    const rows = entries
      .slice()
      .reverse()
      .map((e) => {
        const min = durationMinutes(e.start_ts, e.end_ts);
        return {
          Mitarbeiter: e.worker,
          Tätigkeit: e.task || "",
          Start: new Date(e.start_ts).toLocaleString("de-CH"),
          Ende: e.end_ts ? new Date(e.end_ts).toLocaleString("de-CH") : "läuft…",
          Minuten: min,
          Dauer: fmtHM(min),
        };
      });

    const totalMin = entries.reduce((acc, e) => acc + durationMinutes(e.start_ts, e.end_ts), 0);
    const perWorker: Record<string, number> = {};
    for (const e of entries) {
      const m = durationMinutes(e.start_ts, e.end_ts);
      perWorker[e.worker] = (perWorker[e.worker] || 0) + m;
    }

    const aoa: any[][] = [];
    aoa.push([`Pro Automobile – Rapport`, "", "", "", "", ""]);
    aoa.push([`Erstellt: ${datum}`, "", "", "", "", ""]);
    aoa.push(["", "", "", "", "", ""]);
    aoa.push(["Auftrag", job.title, "", "", "", ""]);
    aoa.push(["Kunde", job.customer || "", "", "", "", ""]);
    aoa.push(["Fahrzeug", job.vehicle || "", "", "", "", ""]);
    aoa.push(["Kontrollschild", job.plate || "", "", "", "", ""]);
    aoa.push(["Status", job.status || "open", "", "", "", ""]);
    if (job.closed_at) aoa.push(["Abgeschlossen", new Date(job.closed_at).toLocaleString("de-CH"), "", "", "", ""]);
    aoa.push(["", "", "", "", "", ""]);

    aoa.push(["Mitarbeiter", "Tätigkeit", "Start", "Ende", "Minuten", "Dauer"]);
    for (const r of rows) aoa.push([r.Mitarbeiter, r.Tätigkeit, r.Start, r.Ende, r.Minuten, r.Dauer]);

    aoa.push(["", "", "", "", "", ""]);
    aoa.push(["TOTAL", "", "", "", totalMin, fmtHM(totalMin)]);
    Object.entries(perWorker).forEach(([w, m]) => aoa.push([`TOTAL ${w}`, "", "", "", m, fmtHM(m)]));

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    (ws as any)["!cols"] = [
      { wch: 14 },
      { wch: 18 },
      { wch: 20 },
      { wch: 20 },
      { wch: 10 },
      { wch: 12 }
    ];

    (ws as any)["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Rapport");

    const fileName = `rapport_${(job.plate || "ohne-kennzeichen").replace(/\s+/g, "_")}_${jobId}.xlsx`;

    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ✅ PDF nur Admin PIN
  async function exportPdfAdmin() {
    if (!askPin()) return;
    if (!job) return;

    const jsPDFMod = await import("jspdf");
    const autoTableMod = await import("jspdf-autotable");

    const jsPDF = (jsPDFMod as any).jsPDF;
    const autoTable = (autoTableMod as any).default;

    const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });

    const title = "Pro Automobile – Rapport";
    doc.setFontSize(16);
    doc.text(title, 14, 16);

    doc.setFontSize(10);
    const info = [
      `Auftrag: ${job.title}`,
      `Kunde: ${job.customer || ""}`,
      `Fahrzeug: ${job.vehicle || ""}`,
      `Kontrollschild: ${job.plate || ""}`,
      `Status: ${job.status || "open"}`,
      job.closed_at ? `Abgeschlossen: ${new Date(job.closed_at).toLocaleString("de-CH")}` : ""
    ].filter(Boolean);

    let y = 22;
    info.forEach((line) => {
      doc.text(line, 14, y);
      y += 5;
    });

    const body = entries
      .slice()
      .reverse()
      .map((e) => {
        const min = durationMinutes(e.start_ts, e.end_ts);
        return [
          e.worker,
          e.task || "",
          new Date(e.start_ts).toLocaleString("de-CH"),
          e.end_ts ? new Date(e.end_ts).toLocaleString("de-CH") : "läuft…",
          String(min),
          fmtHM(min),
        ];
      });

    autoTable(doc, {
      startY: y + 2,
      head: [["Mitarbeiter", "Tätigkeit", "Start", "Ende", "Minuten", "Dauer"]],
      body,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [20, 20, 20] }
    });

    const totalMin = entries.reduce((acc, e) => acc + durationMinutes(e.start_ts, e.end_ts), 0);
    const perWorker: Record<string, number> = {};
    for (const e of entries) {
      const m = durationMinutes(e.start_ts, e.end_ts);
      perWorker[e.worker] = (perWorker[e.worker] || 0) + m;
    }

    const endY = (doc as any).lastAutoTable?.finalY || 260;
    doc.setFontSize(11);
    doc.text(`TOTAL: ${fmtHM(totalMin)} (${totalMin} min)`, 14, endY + 10);

    let yy = endY + 16;
    doc.setFontSize(10);
    Object.entries(perWorker).forEach(([w, m]) => {
      doc.text(`${w}: ${fmtHM(m)} (${m} min)`, 14, yy);
      yy += 5;
    });

    const fileName = `rapport_${(job.plate || "ohne-kennzeichen").replace(/\s+/g, "_")}_${jobId}.pdf`;
    doc.save(fileName);
  }

  return (
    <div>
      <a href="/" style={{ textDecoration: "none" }}>← zurück</a>

      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img src="/logo.png" alt="Pro Automobile" />
            </div>
            <div>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted">{[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <div className="h2">QR-Link (Auftrag scannen)</div>
            <div className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>{jobLink}</div>
          </div>
          <img src={qrUrl} alt="QR" style={{ width: 140, height: 140, borderRadius: 16 }} />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="h2">Start / Stop</div>
          <div className="muted" style={{ fontSize: 12 }}>{msg}</div>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <select className="select" value={worker} onChange={(e) => setWorker(e.target.value)}>
            {WORKERS.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>

          <select className="select" value={task} onChange={(e) => setTask(e.target.value)}>
            {TASKS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnPrimary" onClick={start} disabled={!!runningId || done}>Start</button>
          <button className="btn btnDark" onClick={stop} disabled={!runningId}>Stop</button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDanger" onClick={closeJob} disabled={done}>Auftrag abschliessen ✅</button>
          <button className="btn" onClick={exportXlsx}>Rapport (Excel .xlsx)</button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDark" onClick={load}>Aktualisieren</button>
          <button className="btn btnDark" onClick={exportPdfAdmin}>Rapport (PDF – Admin PIN)</button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDanger" onClick={deleteJobAdmin}>Auftrag löschen (Admin PIN)</button>
          <button className="btn btnDark" onClick={() => alert("Tipp: PDF ist nur für Admin. Excel dürfen alle.")}>
            Hilfe
          </button>
        </div>
      </div>

      <div className="card">
        <div className="h2">Rapport</div>
        <div style={{ marginTop: 8 }}>
          <b>Total:</b> {fmtMin(totals.total)}
        </div>

        {Object.entries(totals.perWorker).map(([w, m]) => (
          <div key={w}>{w}: {fmtMin(m)}</div>
        ))}

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Mitarbeiter</th>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Tätigkeit</th>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Start</th>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Ende</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ padding: 8 }}>{e.worker}</td>
                  <td style={{ padding: 8 }}>{e.task || ""}</td>
                  <td style={{ padding: 8 }}>{toLocal(e.start_ts)}</td>
                  <td style={{ padding: 8 }}>{e.end_ts ? toLocal(e.end_ts) : <b>läuft…</b>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
