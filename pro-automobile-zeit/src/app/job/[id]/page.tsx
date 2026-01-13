"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ensureAdmin } from "../../lib/admin";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null; // open | done
  created_at?: string | null;
  closed_at?: string | null;

  km_photo_url?: string | null;
  signature_url?: string | null;
  signature_name?: string | null;
  signature_at?: string | null;
};

type Entry = {
  id: string;
  job_id: string;
  worker: string;
  task: string | null;
  start_ts: string;
  end_ts: string | null;
};

type PhotoItem = {
  id: string;
  job_id: string;
  url: string;
  created_at?: string | null;
};

const WORKERS = ["Esteban", "Eron", "Jeremie", "Tsvetan", "Mensel"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt"];
const BUCKET = "job-photos";

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

async function uploadToBucket(path: string, file: File) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    cacheControl: "3600",
    contentType: file.type,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const [kmFile, setKmFile] = useState<File | null>(null);
  const [damageFile, setDamageFile] = useState<File | null>(null);

  // signature
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sigName, setSigName] = useState("");

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

    const { data: p } = await supabase
      .from("job_photos")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false });

    setPhotos(((p || []) as any) as PhotoItem[]);
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

  async function start() {
    if (done) return setMsg("Auftrag ist abgeschlossen.");

    // Warnung wenn Mitarbeiter noch auf anderem Auftrag läuft
    const { data: runningOther } = await supabase
      .from("time_entries")
      .select("id, job_id")
      .eq("worker", worker)
      .is("end_ts", null);

    if (runningOther && runningOther.some((x: any) => x.job_id !== jobId)) {
      alert(`⚠️ Achtung: ${worker} läuft noch auf einem anderen Auftrag!`);
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
    const { error } = await supabase.from("time_entries").update({ end_ts: new Date().toISOString() }).eq("id", runningId);
    if (error) return setMsg(error.message);

    setRunningId(null);
    setMsg("🛑 gestoppt");
    await load();
  }

  async function uploadKmPhoto() {
    if (!kmFile) return alert("Bitte KM/Fahrzeugausweis Foto auswählen.");

    const path = `jobs/${jobId}/km_${Date.now()}_${kmFile.name}`;
    const publicUrl = await uploadToBucket(path, kmFile);

    await supabase.from("jobs").update({ km_photo_url: publicUrl }).eq("id", jobId);
    setKmFile(null);
    setMsg("✅ KM Foto gespeichert");
    await load();
  }

  async function uploadDamagePhoto() {
    if (!damageFile) return alert("Bitte Foto auswählen.");

    const path = `jobs/${jobId}/damage_${Date.now()}_${damageFile.name}`;
    const publicUrl = await uploadToBucket(path, damageFile);

    await supabase.from("job_photos").insert({ job_id: jobId, url: publicUrl });
    setDamageFile(null);
    setMsg("✅ Foto gespeichert");
    await load();
  }

  async function deleteDamagePhoto(p: PhotoItem) {
    if (!ensureAdmin(ADMIN_PIN)) return;

    if (!confirm("Foto wirklich löschen?")) return;

    // only remove row, file stays in storage (kann man später mit cleanup löschen)
    await supabase.from("job_photos").delete().eq("id", p.id);
    setMsg("🗑️ Foto gelöscht");
    await load();
  }

  // SIGNATURE
  function clearSignature() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
  }

  function canvasToBlob(): Promise<Blob | null> {
    const c = canvasRef.current;
    if (!c) return Promise.resolve(null);
    return new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }

  async function saveSignature() {
    if (!sigName.trim()) return alert("Bitte Name eingeben.");

    const blob = await canvasToBlob();
    if (!blob) return alert("Signatur fehlt.");

    const file = new File([blob], `signature_${jobId}.png`, { type: "image/png" });
    const path = `jobs/${jobId}/signature_${Date.now()}.png`;
    const url = await uploadToBucket(path, file);

    await supabase
      .from("jobs")
      .update({
        signature_url: url,
        signature_name: sigName.trim(),
        signature_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    setMsg("✅ Unterschrift gespeichert");
    await load();
  }

  async function closeJob() {
    if (done) return;

    // Pflicht: KM Foto
    if (!job?.km_photo_url) {
      alert("❌ Du musst zuerst ein Foto vom Fahrzeugausweis/Kilometer machen.");
      return;
    }

    const now = new Date().toISOString();

    // stop all running entries
    await supabase.from("time_entries").update({ end_ts: now }).eq("job_id", jobId).is("end_ts", null);

    await supabase.from("jobs").update({ status: "done", closed_at: now }).eq("id", jobId);

    setMsg("✅ Auftrag abgeschlossen");
    await load();
  }

  async function reopenJob() {
    if (!ensureAdmin(ADMIN_PIN)) return;

    if (!confirm("Auftrag wieder entsperren?")) return;

    await supabase.from("jobs").update({ status: "open", closed_at: null }).eq("id", jobId);
    setMsg("🔓 Auftrag wieder geöffnet");
    await load();
  }

  async function exportPdf() {
    if (!ensureAdmin(ADMIN_PIN)) return;
    if (!job) return;

    const doc = new jsPDF();

    doc.setFontSize(16);
    doc.text("Pro Automobile - Rapport", 14, 18);

    doc.setFontSize(11);
    doc.text(`Auftrag: ${job.title}`, 14, 28);
    doc.text(`Kunde: ${job.customer || "-"}`, 14, 35);
    doc.text(`Fahrzeug: ${job.vehicle || "-"}`, 14, 42);
    doc.text(`Kontrollschild: ${job.plate || "-"}`, 14, 49);
    doc.text(`Status: ${job.status || "open"}`, 14, 56);

    doc.text(`Total: ${fmtMin(totals.total)}`, 14, 66);

    const rows = entries
      .slice()
      .reverse()
      .map((e) => [
        e.worker,
        e.task || "",
        toLocal(e.start_ts),
        e.end_ts ? toLocal(e.end_ts) : "läuft…",
        fmtMin(durationMinutes(e.start_ts, e.end_ts)),
      ]);

    autoTable(doc, {
      startY: 74,
      head: [["Mitarbeiter", "Tätigkeit", "Start", "Ende", "Dauer"]],
      body: rows,
    });

    let y = (doc as any).lastAutoTable?.finalY ? (doc as any).lastAutoTable.finalY + 8 : 140;

    if (job.signature_name) {
      doc.text(`Unterschrift: ${job.signature_name}`, 14, y);
      y += 8;
      doc.text(`Zeit: ${toLocal(job.signature_at)}`, 14, y);
      y += 8;
    }

    doc.save(`rapport_${(job.plate || "ohne-kennzeichen").replace(/\s+/g, "_")}_${jobId}.pdf`);
  }

  // draw signature
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    c.width = 800;
    c.height = 220;

    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.lineWidth = 3;
    ctx.lineCap = "round";

    let drawing = false;

    const getPos = (e: any) => {
      const r = c.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x, y };
    };

    const startDraw = (e: any) => {
      drawing = true;
      const p = getPos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };

    const moveDraw = (e: any) => {
      if (!drawing) return;
      e.preventDefault();
      const p = getPos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    };

    const endDraw = () => {
      drawing = false;
    };

    c.addEventListener("mousedown", startDraw);
    c.addEventListener("mousemove", moveDraw);
    window.addEventListener("mouseup", endDraw);

    c.addEventListener("touchstart", startDraw, { passive: false });
    c.addEventListener("touchmove", moveDraw, { passive: false });
    window.addEventListener("touchend", endDraw);

    return () => {
      c.removeEventListener("mousedown", startDraw);
      c.removeEventListener("mousemove", moveDraw);
      window.removeEventListener("mouseup", endDraw);
      c.removeEventListener("touchstart", startDraw);
      c.removeEventListener("touchmove", moveDraw);
      window.removeEventListener("touchend", endDraw);
    };
  }, []);

  return (
    <div>
      <a href="/" style={{ textDecoration: "none" }}>← zurück</a>

      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img src="/icons/logo.png" alt="Pro Automobile" />
            </div>
            <div>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted">
                {[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
          <div>
            {done ? <span className="pill pillDone">Abgeschlossen</span> : <span className="pill pillOpen">Offen</span>}
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
          <button className="btn" onClick={reopenJob} disabled={!done}>🔓 Wieder öffnen (Chef)</button>
        </div>

        <div style={{ marginTop: 10 }}>
          <button className="btn btnPrimary" onClick={exportPdf}>
            📄 Rapport als PDF (Chef)
          </button>
        </div>
      </div>

      {/* KM Foto Pflicht */}
      <div className="card">
        <div className="h2">Fahrzeugausweis / Kilometer (Pflicht)</div>
        <div className="muted">Ohne dieses Foto kann der Auftrag nicht abgeschlossen werden.</div>

        {job?.km_photo_url ? (
          <div style={{ marginTop: 10 }}>
            <img src={job.km_photo_url} style={{ width: "100%", borderRadius: 14 }} />
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 10 }}>Noch kein Foto vorhanden.</div>
        )}

        <div style={{ marginTop: 10 }}>
          <input type="file" accept="image/*" capture="environment" onChange={(e) => setKmFile(e.target.files?.[0] || null)} />
          <button className="btn btnPrimary" style={{ marginTop: 8 }} onClick={uploadKmPhoto}>📸 KM Foto speichern</button>
        </div>
      </div>

      {/* Schäden */}
      <div className="card">
        <div className="h2">Schadenfotos</div>

        <div style={{ marginTop: 10 }}>
          <input type="file" accept="image/*" capture="environment" onChange={(e) => setDamageFile(e.target.files?.[0] || null)} />
          <button className="btn btnPrimary" style={{ marginTop: 8 }} onClick={uploadDamagePhoto}>📸 Foto speichern</button>
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {photos.map((p) => (
            <div key={p.id} className="card" style={{ padding: 10 }}>
              <img src={p.url} style={{ width: "100%", borderRadius: 14 }} />
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{toLocal(p.created_at)}</div>
              <button className="btn btnDanger" style={{ marginTop: 8 }} onClick={() => deleteDamagePhoto(p)}>
                🗑️ Foto löschen (Chef)
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Unterschrift */}
      <div className="card">
        <div className="h2">Unterschrift</div>
        <div className="muted">Wird in PDF übernommen.</div>

        {job?.signature_url ? (
          <div style={{ marginTop: 10 }}>
            <div className="muted">Vorhanden: {job.signature_name} ({toLocal(job.signature_at)})</div>
            <img src={job.signature_url} style={{ width: "100%", borderRadius: 14, marginTop: 6 }} />
          </div>
        ) : null}

        <div style={{ marginTop: 10 }}>
          <input className="select" placeholder="Name (z.B. Kunde)" value={sigName} onChange={(e) => setSigName(e.target.value)} />

          <div style={{ marginTop: 8, borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)" }}>
            <canvas ref={canvasRef} style={{ width: "100%", background: "#fff" }} />
          </div>

          <div className="grid2" style={{ marginTop: 8 }}>
            <button className="btn btnDark" onClick={clearSignature}>✏️ Neu</button>
            <button className="btn btnPrimary" onClick={saveSignature}>✅ Speichern</button>
          </div>
        </div>
      </div>

      {/* Rapport */}
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
