"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ensureAdmin } from "../../lib/admin";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null;
  created_at?: string | null;
  closed_at?: string | null;

  km_photo_path?: string | null;
  ausweis_photo_path?: string | null;

  signature_path?: string | null; // <- NEU (SQL oben!)
  signature_url?: string | null;  // preview signed url
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

type PhotoItem = { path: string; name: string; url: string };

const WORKERS = ["Esteban", "Eron", "Jeremie", "Tsvetan", "Mensel"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt", "Sonstiges"];

const BUCKET = "job-photos";

function toLocal(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("de-CH");
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

function baseNameFromPath(path: string) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * PDF-FIX: Bilder NICHT via Signed-URL fetchen.
 * Stattdessen: Storage.download(path) -> Blob -> Canvas -> JPEG dataURL.
 * Das verhindert "400" und "corrupt PNG".
 */
async function downloadPathAsJpegDataUrl(storagePath: string, quality = 0.9): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Bild konnte nicht geladen werden: ${error?.message || "download failed"}`);

  const blob = data;
  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Bild konnte nicht dekodiert werden"));
      i.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas nicht verfügbar");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;
  const adminPin = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [busyPdf, setBusyPdf] = useState(false);

  // Pflicht-Fotos (Variante B)
  const [kmFile, setKmFile] = useState<File | null>(null);
  const [ausweisFile, setAusweisFile] = useState<File | null>(null);
  const [savingKm, setSavingKm] = useState(false);
  const [savingAusweis, setSavingAusweis] = useState(false);

  // Unterschrift
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [signName, setSignName] = useState("");
  const [signBusy, setSignBusy] = useState(false);

  const done = (job?.status || "open") === "done";

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  async function refreshPhotos() {
    const { data, error } = await supabase.storage.from(BUCKET).list(jobId, {
      limit: 200,
      sortBy: { column: "created_at", order: "desc" },
    });

    if (error) {
      console.warn("photo list error:", error.message);
      setPhotos([]);
      return;
    }

    const items = (data || []).filter((x) => x.name && x.name !== ".emptyFolderPlaceholder");
    const out: PhotoItem[] = [];

    for (const it of items) {
      const path = `${jobId}/${it.name}`;
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
      if (signed?.signedUrl) out.push({ path, name: it.name, url: signed.signedUrl });
    }

    setPhotos(out);
  }

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

    await refreshPhotos();
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
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

  const requiredOk = useMemo(() => {
    const hasKm = !!job?.km_photo_path || photos.some((p) => p.name.toLowerCase().startsWith("km_"));
    const hasAusweis = !!job?.ausweis_photo_path || photos.some((p) => p.name.toLowerCase().startsWith("ausweis_"));
    return { hasKm, hasAusweis, ok: hasKm && hasAusweis };
  }, [job?.km_photo_path, job?.ausweis_photo_path, photos]);

  function makeSafeFilename(kind: "km" | "ausweis" | "schaden", original: string) {
    const ext = (original.split(".").pop() || "jpg").toLowerCase();
    const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg";
    return `${kind}_${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
  }

  async function uploadPhoto(file: File, kind: "km" | "ausweis" | "schaden") {
    const filename = makeSafeFilename(kind, file.name);
    const path = `${jobId}/${filename}`;

    const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "image/jpeg",
    });

    if (error) {
      alert("Upload Fehler: " + error.message);
      return null;
    }

    return path;
  }

  async function saveRequired(kind: "km" | "ausweis") {
    if (kind === "km") {
      if (!kmFile) return alert("Bitte zuerst ein KM-Foto auswählen.");
      setSavingKm(true);
      try {
        const path = await uploadPhoto(kmFile, "km");
        if (!path) return;

        const { error: upErr } = await supabase.from("jobs").update({ km_photo_path: path }).eq("id", jobId);
        if (upErr) alert("DB Update Fehler: " + upErr.message);

        setKmFile(null);
        await load();
      } finally {
        setSavingKm(false);
      }
    } else {
      if (!ausweisFile) return alert("Bitte zuerst ein Ausweis-Foto auswählen.");
      setSavingAusweis(true);
      try {
        const path = await uploadPhoto(ausweisFile, "ausweis");
        if (!path) return;

        const { error: upErr } = await supabase.from("jobs").update({ ausweis_photo_path: path }).eq("id", jobId);
        if (upErr) alert("DB Update Fehler: " + upErr.message);

        setAusweisFile(null);
        await load();
      } finally {
        setSavingAusweis(false);
      }
    }
  }

  function pickPhotoByStoredPathOrPrefix(kind: "km" | "ausweis") {
    const stored = kind === "km" ? job?.km_photo_path : job?.ausweis_photo_path;
    if (stored) {
      const found = photos.find((p) => p.path === stored);
      if (found) return found;
    }
    const pref = kind === "km" ? "km_" : "ausweis_";
    return photos.find((p) => p.name.toLowerCase().startsWith(pref)) || null;
  }

  const kmPhoto = pickPhotoByStoredPathOrPrefix("km");
  const ausweisPhoto = pickPhotoByStoredPathOrPrefix("ausweis");

  const damagePhotos = useMemo(() => photos.filter((p) => p.name.toLowerCase().startsWith("schaden_")), [photos]);

  async function deletePhoto(path: string) {
    if (!ensureAdmin(adminPin)) return;
    const ok = confirm("Foto wirklich löschen?");
    if (!ok) return;

    // Pflichtfelder leeren, falls nötig
    const patch: any = {};
    if (job?.km_photo_path === path) patch.km_photo_path = null;
    if (job?.ausweis_photo_path === path) patch.ausweis_photo_path = null;
    if (job?.signature_path === path) patch.signature_path = null;

    if (Object.keys(patch).length > 0) {
      const { error: upErr } = await supabase.from("jobs").update(patch).eq("id", jobId);
      if (upErr) console.warn("jobs patch warning:", upErr.message);
    }

    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) return alert("Löschen fehlgeschlagen: " + error.message);

    await load();
  }

  async function start() {
    if (done) return setMsg("Auftrag ist abgeschlossen.");
    const existing = entries.find((e) => e.worker === worker && !e.end_ts);
    if (existing) return setMsg("Läuft bereits…");

    const { data, error } = await supabase.from("time_entries").insert({ job_id: jobId, worker, task }).select("id").single();
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

  async function closeJob() {
    setMsg("");
    if (!requiredOk.hasKm) return setMsg("❗ Abschluss nicht möglich: Kilometer Foto fehlt.");
    if (!requiredOk.hasAusweis) return setMsg("❗ Abschluss nicht möglich: Fahrzeugausweis Foto fehlt.");

    const now = new Date().toISOString();
    await supabase.from("time_entries").update({ end_ts: now }).eq("job_id", jobId).is("end_ts", null);
    await supabase.from("jobs").update({ status: "done", closed_at: now }).eq("id", jobId);

    setMsg("✅ Auftrag abgeschlossen");
    await load();
  }

  async function reopenJobChef() {
    if (!ensureAdmin(adminPin)) return;
    const ok = confirm("Auftrag wirklich wieder öffnen?");
    if (!ok) return;

    await supabase.from("jobs").update({ status: "open", closed_at: null }).eq("id", jobId);
    setMsg("🔓 Auftrag wieder geöffnet");
    await load();
  }

  function exportCsv() {
    if (!job) return;

    const header = ["job_title", "customer", "vehicle", "plate", "job_status", "worker", "task", "start", "end", "duration_min"].join(",");

    const rows = entries
      .slice()
      .reverse()
      .map((e) => {
        const dur = durationMinutes(e.start_ts, e.end_ts);
        const cols = [
          job.title,
          job.customer || "",
          job.vehicle || "",
          job.plate || "",
          job.status || "open",
          e.worker,
          e.task || "",
          e.start_ts,
          e.end_ts || "",
          String(dur),
        ].map((x) => JSON.stringify(x));
        return cols.join(",");
      });

    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `rapport_${(job.plate || "ohne-kennzeichen").replace(/\s+/g, "_")}_${jobId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportPdfChef() {
    if (!ensureAdmin(adminPin)) return;
    if (!job) return;

    try {
      setBusyPdf(true);
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "pt", format: "a4" });

      const margin = 40;
      let y = 46;

      doc.setFontSize(16);
      doc.text("Pro Automobile – Rapport", margin, y);
      y += 18;

      doc.setFontSize(10);
      doc.text(`Auftrag: ${job.title}`, margin, y); y += 14;
      doc.text(`Kunde: ${job.customer || "-"}`, margin, y); y += 14;
      doc.text(`Fahrzeug: ${job.vehicle || "-"}`, margin, y); y += 14;
      doc.text(`Kontrollschild: ${job.plate || "-"}`, margin, y); y += 14;
      doc.text(`Status: ${job.status || "open"}`, margin, y); y += 14;
      doc.text(`Erstellt: ${toLocal(job.created_at || null)}`, margin, y); y += 14;
      doc.text(`Abgeschlossen: ${toLocal(job.closed_at || null)}`, margin, y); y += 18;

      doc.setFontSize(11);
      doc.text(`Total: ${fmtMin(totals.total)}`, margin, y);
      y += 18;

      doc.setFontSize(10);
      doc.text("Mitarbeiter / Tätigkeit / Start / Ende / Dauer", margin, y);
      y += 12;

      const lines = entries
        .slice()
        .reverse()
        .map((e) => {
          const dur = durationMinutes(e.start_ts, e.end_ts);
          return `${e.worker} | ${e.task || "-"} | ${toLocal(e.start_ts)} | ${e.end_ts ? toLocal(e.end_ts) : "läuft…"} | ${fmtMin(dur)}`;
        });

      for (const line of lines) {
        const chunks = doc.splitTextToSize(line, 515);
        doc.text(chunks, margin, y);
        y += chunks.length * 12;
        if (y > 700) { doc.addPage(); y = 40; }
      }

      const addImageBlockFromPath = async (title: string, storagePath?: string | null) => {
        if (!storagePath) return;
        if (y > 620) { doc.addPage(); y = 40; }

        doc.setFontSize(12);
        doc.text(title, margin, y);
        y += 10;

        const jpegDataUrl = await downloadPathAsJpegDataUrl(storagePath, 0.9);
        doc.addImage(jpegDataUrl, "JPEG", margin, y + 6, 515, 240);
        y += 260;
      };

      // Pflichtbilder: aus DB path, fallback auf gefundenes Photo
      await addImageBlockFromPath("Kilometerstand Foto", job.km_photo_path || kmPhoto?.path || null);
      await addImageBlockFromPath("Fahrzeugausweis Foto", job.ausweis_photo_path || ausweisPhoto?.path || null);

      // Unterschrift
      if (job.signature_path) {
        if (y > 640) { doc.addPage(); y = 40; }
        doc.setFontSize(12);
        doc.text("Unterschrift", margin, y);
        y += 10;

        const sigJpg = await downloadPathAsJpegDataUrl(job.signature_path, 0.92);
        doc.addImage(sigJpg, "JPEG", margin, y + 6, 260, 120);
        y += 140;

        doc.setFontSize(10);
        doc.text(`Name: ${job.signature_name || "-"}`, margin, y); y += 14;
        doc.text(`Zeit: ${toLocal(job.signature_at || null)}`, margin, y); y += 14;
      }

      doc.save(`rapport_${(job.plate || "ohne-kennzeichen").replace(/\s+/g, "_")}_${jobId}.pdf`);
    } catch (e: any) {
      alert("PDF Fehler: " + (e?.message || String(e)));
    } finally {
      setBusyPdf(false);
    }
  }

  async function saveSignature() {
    if (!job) return;
    if (!ensureAdmin(adminPin)) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl || dataUrl.length < 200) return alert("Unterschrift fehlt.");

    setSignBusy(true);
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const filename = `signature_${Date.now()}.png`;
      const path = `${jobId}/${filename}`;

      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
        cacheControl: "3600",
        upsert: true,
        contentType: "image/png",
      });
      if (error) throw new Error(error.message);

      // Signed URL nur für Preview (nicht fürs PDF!)
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
      const signedUrl = signed?.signedUrl || null;

      const now = new Date().toISOString();
      const { error: upErr } = await supabase
        .from("jobs")
        .update({
          signature_path: path,
          signature_url: signedUrl,
          signature_name: (signName || "").trim() || null,
          signature_at: now,
        })
        .eq("id", jobId);

      if (upErr) throw new Error(upErr.message);

      alert("✅ Unterschrift gespeichert");
      await load();
    } catch (e: any) {
      alert("Unterschrift Fehler: " + (e?.message || String(e)));
    } finally {
      setSignBusy(false);
    }
  }

  // Canvas draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffffff";

    let drawing = false;

    const getPos = (e: any) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches?.[0]?.clientX ?? e.clientX;
      const clientY = e.touches?.[0]?.clientY ?? e.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const down = (e: any) => { drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    const move = (e: any) => { if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
    const up = () => { drawing = false; };

    canvas.addEventListener("mousedown", down);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);

    canvas.addEventListener("touchstart", down, { passive: true } as any);
    canvas.addEventListener("touchmove", move, { passive: true } as any);
    window.addEventListener("touchend", up);

    return () => {
      canvas.removeEventListener("mousedown", down);
      canvas.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);

      canvas.removeEventListener("touchstart", down as any);
      canvas.removeEventListener("touchmove", move as any);
      window.removeEventListener("touchend", up);
    };
  }, []);

  return (
    <div>
      <a href="/" style={{ textDecoration: "none" }}>← zurück</a>

      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img
                src={`/icons/logo.png?v=1`}
                alt="Pro Automobile"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).src = `/logo.png?v=1`;
                }}
              />
            </div>
            <div>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted">{[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {done ? `✅ Abgeschlossen: ${toLocal(job?.closed_at || null)}` : `🟠 Offen (erstellt: ${toLocal(job?.created_at || null)})`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="pill">
              <span className="dot" style={{ background: requiredOk.ok ? "#30d158" : "#ff453a" }} />
              Pflicht-Fotos: {requiredOk.ok ? "OK" : "fehlt"}
            </span>
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
          <button className="btn" onClick={exportCsv}>CSV Rapport</button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn" onClick={exportPdfChef} disabled={busyPdf}>
            {busyPdf ? "PDF…" : "Rapport als PDF (Chef)"}
          </button>
          <button className="btn" onClick={reopenJobChef} disabled={!done}>🔓 Wieder öffnen (Chef)</button>
        </div>
      </div>

      <div className="card">
        <div className="h2">Fahrzeugausweis / Kilometer (Pflicht)</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Ohne diese Fotos kann der Auftrag nicht abgeschlossen werden.
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <div style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div>
                <b>KM Foto</b>
                <div className="muted" style={{ fontSize: 12 }}>
                  {kmPhoto ? `✅ vorhanden: ${baseNameFromPath(kmPhoto.path)}` : "Noch kein Foto vorhanden."}
                </div>
              </div>

              {kmPhoto ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" onClick={() => window.open(kmPhoto.url, "_blank")}>Öffnen</button>
                  <button className="btn btnDanger" onClick={() => deletePhoto(kmPhoto.path)}>Löschen</button>
                </div>
              ) : null}
            </div>

            {!kmPhoto && (
              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input type="file" accept="image/*" capture="environment" onChange={(e) => setKmFile(e.target.files?.[0] || null)} />
                <button className="btn btnPrimary" onClick={() => saveRequired("km")} disabled={savingKm}>
                  {savingKm ? "Speichert…" : "📸 KM Foto speichern"}
                </button>
              </div>
            )}
          </div>

          <div style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div>
                <b>Fahrzeugausweis Foto</b>
                <div className="muted" style={{ fontSize: 12 }}>
                  {ausweisPhoto ? `✅ vorhanden: ${baseNameFromPath(ausweisPhoto.path)}` : "Noch kein Foto vorhanden."}
                </div>
              </div>

              {ausweisPhoto ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn" onClick={() => window.open(ausweisPhoto.url, "_blank")}>Öffnen</button>
                  <button className="btn btnDanger" onClick={() => deletePhoto(ausweisPhoto.path)}>Löschen</button>
                </div>
              ) : null}
            </div>

            {!ausweisPhoto && (
              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input type="file" accept="image/*" capture="environment" onChange={(e) => setAusweisFile(e.target.files?.[0] || null)} />
                <button className="btn btnPrimary" onClick={() => saveRequired("ausweis")} disabled={savingAusweis}>
                  {savingAusweis ? "Speichert…" : "📸 Ausweis Foto speichern"}
                </button>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span className="pill">
              <span className="dot" style={{ background: requiredOk.hasAusweis ? "#30d158" : "#ff453a" }} />
              Ausweis: {requiredOk.hasAusweis ? "OK" : "fehlt"}
            </span>
            <span className="pill">
              <span className="dot" style={{ background: requiredOk.hasKm ? "#30d158" : "#ff453a" }} />
              KM: {requiredOk.hasKm ? "OK" : "fehlt"}
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="h2">Schadenfotos</div>

        <label className="btn btnPrimary" style={{ cursor: "pointer", marginTop: 10 }}>
          Schaden-Foto hinzufügen
          <input
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const path = await uploadPhoto(file, "schaden");
              if (!path) return;
              await load();
            }}
          />
        </label>

        {damagePhotos.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>Noch keine Schadenfotos.</div>
        ) : (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
            {damagePhotos.map((p) => (
              <div key={p.path} style={{ borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)" }}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} alt="Schadenfoto" style={{ width: "100%", height: 130, objectFit: "cover", display: "block" }} />
                </a>
                <div style={{ padding: 8 }}>
                  <div className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>{p.name}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="btn" onClick={() => window.open(p.url, "_blank")}>Öffnen</button>
                    <button className="btn btnDanger" onClick={() => deletePhoto(p.path)}>Löschen</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h2">Unterschrift (Chef)</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Wird im PDF übernommen, sobald gespeichert.</div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input className="input" value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Name (optional)" style={{ minWidth: 220 }} />

          <button className="btn" onClick={() => {
            const c = canvasRef.current;
            if (!c) return;
            const ctx = c.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, c.width, c.height);
          }}>
            Löschen
          </button>

          <button className="btn btnPrimary" onClick={saveSignature} disabled={signBusy}>
            {signBusy ? "Speichert…" : "Unterschrift speichern"}
          </button>
        </div>

        <div style={{ marginTop: 12, borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)" }}>
          <canvas ref={canvasRef} width={700} height={220} style={{ width: "100%", height: 180, background: "rgba(255,255,255,0.03)" }} />
        </div>

        {job?.signature_url && (
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12 }}>Gespeicherte Unterschrift:</div>
            <img src={job.signature_url} alt="Unterschrift" style={{ marginTop: 6, width: 260, borderRadius: 12 }} />
          </div>
        )}
      </div>
    </div>
  );
}
