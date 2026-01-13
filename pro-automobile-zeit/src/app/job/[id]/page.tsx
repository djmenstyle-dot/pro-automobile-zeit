"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ensureAdmin, promptAdminPin } from "../../lib/admin";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null;
  created_at?: string | null;
  closed_at?: string | null;

  // Unterschrift (wir unterstützen beides: path (neu) & url (alt))
  signature_path?: string | null;
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

type PhotoItem = { path: string; name: string; url: string };

const WORKERS = ["Esteban", "Eron", "Jeremie", "Tsvetan", "Mensel"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt", "Sonstiges"];

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

/** Lädt Bild als DataURL und konvertiert stabil zu JPEG (fix für PNG-Probleme in jsPDF) */
async function imageUrlToJpegDataUrl(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bild konnte nicht geladen werden (${res.status})`);
  const blob = await res.blob();

  // decode -> canvas -> jpeg
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) throw new Error("Bild konnte nicht dekodiert werden (kaputt?)");

  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas Fehler");

  ctx.drawImage(bmp, 0, 0);
  // JPEG ist stabil in jsPDF
  return canvas.toDataURL("image/jpeg", 0.88);
}

/** Signed URL helper */
async function signedUrl(bucket: string, path: string, seconds: number) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, seconds);
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error("Keine Signed URL");
  return data.signedUrl;
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  // Chef PIN (Frontend Check für "Chef-Modus")
  const adminPinEnv = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  // Fotos
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [busyPdf, setBusyPdf] = useState(false);

  // Unterschrift Canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [signName, setSignName] = useState("");
  const [signBusy, setSignBusy] = useState(false);

  const done = (job?.status || "open") === "done";

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  const requiredPhotos = useMemo(() => {
    const ausweis = photos.find((p) => p.name.toLowerCase().startsWith("ausweis_"));
    const km = photos.find((p) => p.name.toLowerCase().startsWith("km_"));
    return {
      ausweis,
      km,
      ok: !!ausweis && !!km,
    };
  }, [photos]);

  const damagePhotos = useMemo(() => photos.filter((p) => p.name.toLowerCase().startsWith("schaden_")), [photos]);

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
      try {
        const url = await signedUrl(BUCKET, path, 60 * 60 * 24 * 30); // 30 Tage, wird immer neu erzeugt
        out.push({ path, name: it.name, url });
      } catch (e) {
        // falls ein einzelnes Bild spinnt, App soll trotzdem laufen
        console.warn("signed url fail for", path);
      }
    }

    setPhotos(out);
  }

  async function uploadPhoto(file: File, kind: "ausweis" | "km" | "schaden") {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg";

    const prefix = `${kind}_`;
    const filename = `${prefix}${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
    const path = `${jobId}/${filename}`;

    const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "image/jpeg",
    });

    if (error) {
      alert("Upload Fehler: " + error.message);
      return;
    }

    await refreshPhotos();
  }

  async function deletePhoto(path: string) {
    if (!ensureAdmin(adminPinEnv)) return;

    const ok = confirm("Foto wirklich löschen?");
    if (!ok) return;

    const pin = promptAdminPin();
    if (!pin) return;

    const res = await fetch("/api/storage/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket: BUCKET, path, pin }),
    });

    const json = await res.json().catch(() => ({} as any));
    if (!res.ok || !json?.ok) {
      alert("Löschen fehlgeschlagen: " + (json?.error || res.statusText));
      return;
    }

    await refreshPhotos();
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
    setMsg("");

    if (!requiredPhotos.ok) {
      if (!requiredPhotos.km) return setMsg("❗ Abschluss nicht möglich: Kilometer Foto fehlt.");
      if (!requiredPhotos.ausweis) return setMsg("❗ Abschluss nicht möglich: Fahrzeugausweis Foto fehlt.");
      return setMsg("❗ Pflicht-Fotos fehlen.");
    }

    const now = new Date().toISOString();

    await supabase.from("time_entries").update({ end_ts: now }).eq("job_id", jobId).is("end_ts", null);
    await supabase.from("jobs").update({ status: "done", closed_at: now }).eq("id", jobId);

    setMsg("✅ Auftrag abgeschlossen");
    await load();
  }

  async function reopenJobChef() {
    if (!ensureAdmin(adminPinEnv)) return;

    const ok = confirm("Auftrag wieder öffnen?");
    if (!ok) return;

    const now = new Date().toISOString();
    await supabase.from("jobs").update({ status: "open", closed_at: null }).eq("id", jobId);

    setMsg(`🔓 Wieder geöffnet (${toLocal(now)})`);
    await load();
  }

  function exportCsv() {
    if (!job) return;

    const header = [
      "job_title",
      "customer",
      "vehicle",
      "plate",
      "job_status",
      "worker",
      "task",
      "start",
      "end",
      "duration_min",
    ].join(",");

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
    if (!ensureAdmin(adminPinEnv)) return;
    if (!job) return;

    try {
      setBusyPdf(true);

      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "pt", format: "a4" });

      const margin = 40;
      let y = 46;

      // Header + Logo (robust)
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
        if (y > 700) {
          doc.addPage();
          y = 40;
        }
      }

      async function addImageBlock(title: string, url?: string) {
        if (!url) return;
        if (y > 620) {
          doc.addPage();
          y = 40;
        }

        doc.setFontSize(12);
        doc.text(title, margin, y);
        y += 10;

        // stabil: konvertiere zu JPEG
        const jpegDataUrl = await imageUrlToJpegDataUrl(url);
        doc.addImage(jpegDataUrl, "JPEG", margin, y + 6, 515, 240);
        y += 260;
      }

      // Pflichtbilder
      await addImageBlock("Kilometerstand Foto", requiredPhotos.km?.url);
      await addImageBlock("Fahrzeugausweis Foto", requiredPhotos.ausweis?.url);

      // Unterschrift: immer frisch signieren (path bevorzugt)
      let sigUrl: string | null = null;
      if (job.signature_path) {
        try {
          sigUrl = await signedUrl(BUCKET, job.signature_path, 60 * 60 * 24 * 30);
        } catch {
          sigUrl = null;
        }
      } else if (job.signature_url) {
        sigUrl = job.signature_url; // fallback alt
      }

      if (sigUrl) {
        if (y > 640) {
          doc.addPage();
          y = 40;
        }
        doc.setFontSize(12);
        doc.text("Unterschrift", margin, y);
        y += 10;

        // Signature ebenfalls stabil als JPEG rein
        const sigJpeg = await imageUrlToJpegDataUrl(sigUrl);
        doc.addImage(sigJpeg, "JPEG", margin, y + 6, 260, 120);
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
    if (!ensureAdmin(adminPinEnv)) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl || dataUrl.length < 100) return alert("Unterschrift fehlt.");

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

      const now = new Date().toISOString();

      // Wir versuchen signature_path (besser). Wenn Column nicht existiert, fallback auf signature_url.
      const tryPath = await supabase
        .from("jobs")
        .update({
          signature_path: path,
          signature_name: (signName || "").trim() || null,
          signature_at: now,
        } as any)
        .eq("id", jobId);

      if (tryPath.error) {
        // fallback alt: store signed url (aber wir nehmen lange)
        const url = await signedUrl(BUCKET, path, 60 * 60 * 24 * 365 * 5); // 5 Jahre
        const fallback = await supabase
          .from("jobs")
          .update({
            signature_url: url,
            signature_name: (signName || "").trim() || null,
            signature_at: now,
          } as any)
          .eq("id", jobId);

        if (fallback.error) throw new Error(fallback.error.message);
      }

      alert("✅ Unterschrift gespeichert");
      await load();
    } catch (e: any) {
      alert("Unterschrift Fehler: " + (e?.message || String(e)));
    } finally {
      setSignBusy(false);
    }
  }

  // Canvas Drawing
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

    const down = (e: any) => {
      drawing = true;
      const p = getPos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };
    const move = (e: any) => {
      if (!drawing) return;
      const p = getPos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    };
    const up = () => {
      drawing = false;
    };

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

  // Logo fallback
  const [logoSrc, setLogoSrc] = useState("/icons/logo.png");

  return (
    <div>
      <a href="/" style={{ textDecoration: "none" }}>← zurück</a>

      <div className="card">
        <div className="row rowTop">
          <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
            <div className="logoWrap">
              <img
                src={logoSrc}
                alt="Pro Automobile"
                onError={() => setLogoSrc("/icons/logo.svg")}
                style={{ width: 42, height: 42, objectFit: "contain" }}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted truncate">{[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {done ? `✅ Abgeschlossen: ${toLocal(job?.closed_at || null)}` : `🟠 Offen (erstellt: ${toLocal(job?.created_at || null)})`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill">
              <span className="dot" style={{ background: requiredPhotos.ok ? "#30d158" : "#ff453a" }} />
              Pflicht-Fotos: {requiredPhotos.ok ? "OK" : "fehlt"}
            </span>
            {done ? (
              <button className="btn btnDark" onClick={reopenJobChef}>🔓 Wieder öffnen (Chef)</button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row rowTop">
          <div style={{ minWidth: 0 }}>
            <div className="h2">QR-Link (Auftrag scannen)</div>
            <div className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>{jobLink}</div>
          </div>
          <img src={qrUrl} alt="QR" style={{ width: 140, height: 140, borderRadius: 16 }} />
        </div>
      </div>

      {/* Pflicht-Fotos */}
      <div className="card">
        <div className="h2">Fahrzeugausweis / Kilometer (Pflicht)</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Ohne diese Fotos kann der Auftrag nicht abgeschlossen werden.
        </div>

        <div className="grid2" style={{ marginTop: 12 }}>
          <div className="miniCard">
            <div className="row rowTop">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>Fahrzeugausweis Foto</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {requiredPhotos.ausweis ? `✅ vorhanden: ${requiredPhotos.ausweis.name}` : "❗ noch kein Foto"}
                </div>
              </div>
              {requiredPhotos.ausweis ? (
                <button className="btn" onClick={() => window.open(requiredPhotos.ausweis!.url, "_blank")}>Öffnen</button>
              ) : null}
            </div>

            <label className="btn btnPrimary" style={{ cursor: "pointer", marginTop: 10, width: "100%" }}>
              Ausweis Foto aufnehmen
              <input
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  await uploadPhoto(file, "ausweis");
                }}
              />
            </label>
          </div>

          <div className="miniCard">
            <div className="row rowTop">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>Kilometerstand Foto</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {requiredPhotos.km ? `✅ vorhanden: ${requiredPhotos.km.name}` : "❗ noch kein Foto"}
                </div>
              </div>
              {requiredPhotos.km ? (
                <button className="btn" onClick={() => window.open(requiredPhotos.km!.url, "_blank")}>Öffnen</button>
              ) : null}
            </div>

            <label className="btn btnPrimary" style={{ cursor: "pointer", marginTop: 10, width: "100%" }}>
              KM Foto aufnehmen
              <input
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  await uploadPhoto(file, "km");
                }}
              />
            </label>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span className="pill">
            <span className="dot" style={{ background: requiredPhotos.ausweis ? "#30d158" : "#ff453a" }} />
            Ausweis: {requiredPhotos.ausweis ? "OK" : "fehlt"}
          </span>
          <span className="pill">
            <span className="dot" style={{ background: requiredPhotos.km ? "#30d158" : "#ff453a" }} />
            KM: {requiredPhotos.km ? "OK" : "fehlt"}
          </span>
        </div>
      </div>

      {/* Start/Stop */}
      <div className="card">
        <div className="row rowTop">
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
          <button className="btn btnDanger" onClick={closeJob} disabled={done}>
            Auftrag abschliessen ✅
          </button>
          <button className="btn" onClick={exportCsv}>CSV Rapport</button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn" onClick={exportPdfChef} disabled={busyPdf}>
            {busyPdf ? "PDF…" : "Rapport als PDF (Chef)"}
          </button>
          <div className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
            PDF enthält Pflicht-Fotos + Unterschrift (wenn gespeichert).
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

      {/* Schadenfotos */}
      <div className="card">
        <div className="row rowTop">
          <div>
            <div className="h2">Schadenfotos</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Löschen ist Chef-geschützt.
            </div>
          </div>

          <label className="btn btnPrimary" style={{ cursor: "pointer" }}>
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
                await uploadPhoto(file, "schaden");
              }}
            />
          </label>
        </div>

        {damagePhotos.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>Noch keine Schadenfotos.</div>
        ) : (
          <div className="photoGrid">
            {damagePhotos.map((p) => (
              <div key={p.path} className="photoCard">
                <a href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} alt="Foto" className="photoImg" />
                </a>

                <div className="photoMeta">
                  <div className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>{p.name}</div>
                  <div className="row" style={{ marginTop: 8, gap: 8 }}>
                    <button className="btn" onClick={() => window.open(p.url, "_blank")}>Öffnen</button>
                    <button className="btn btnDanger" onClick={() => deletePhoto(p.path)}>Löschen</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unterschrift */}
      <div className="card">
        <div className="h2">Unterschrift (Chef)</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Wird im PDF übernommen, sobald gespeichert.
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            className="input"
            value={signName}
            onChange={(e) => setSignName(e.target.value)}
            placeholder="Name (optional)"
            style={{ minWidth: 220 }}
          />
          <button
            className="btn"
            onClick={() => {
              const c = canvasRef.current;
              if (!c) return;
              const ctx = c.getContext("2d");
              if (!ctx) return;
              ctx.clearRect(0, 0, c.width, c.height);
            }}
          >
            Löschen
          </button>
          <button className="btn btnPrimary" onClick={saveSignature} disabled={signBusy}>
            {signBusy ? "Speichert…" : "Unterschrift speichern"}
          </button>
        </div>

        <div className="signWrap">
          <canvas ref={canvasRef} width={700} height={220} className="signCanvas" />
        </div>

        {/* Anzeige: wir benutzen vorhandene signature_url als fallback (alt) */}
        {job?.signature_url ? (
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 12 }}>Gespeicherte Unterschrift:</div>
            <img src={job.signature_url} alt="Unterschrift" style={{ marginTop: 6, width: 260, borderRadius: 12 }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
