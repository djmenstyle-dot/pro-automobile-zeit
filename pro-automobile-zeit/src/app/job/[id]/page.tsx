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

function extOf(name: string) {
  const p = name.toLowerCase().split(".");
  return p.length > 1 ? p[p.length - 1] : "";
}

async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bild konnte nicht geladen werden (${res.status})`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("FileReader error"));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  // nur EIN env key benutzen
  const adminPinEnv = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const [jobLink, setJobLink] = useState("");
  const qrUrl = useMemo(() => {
    if (!jobLink) return "";
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`;
  }, [jobLink]);

  // Fotos
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [busyPdf, setBusyPdf] = useState(false);

  // Unterschrift
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [signName, setSignName] = useState("");
  const [signBusy, setSignBusy] = useState(false);

  const done = (job?.status || "open") === "done";

  const requiredOk = useMemo(() => {
    const lower = photos.map((p) => p.name.toLowerCase());
    const hasAusweis = lower.some((n) => n.startsWith("ausweis_"));
    const hasKm = lower.some((n) => n.startsWith("km_"));
    return { hasAusweis, hasKm, ok: hasAusweis && hasKm };
  }, [photos]);

  const damagePhotos = useMemo(() => photos.filter((p) => p.name.toLowerCase().startsWith("schaden_")), [photos]);

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

    // Signed URLs (1 Woche)
    for (const it of items) {
      const path = `${jobId}/${it.name}`;
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
      if (signed?.signedUrl) out.push({ path, name: it.name, url: signed.signedUrl });
    }

    setPhotos(out);
  }

  async function uploadPhoto(file: File, kind: "ausweis" | "km" | "schaden") {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const safeExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg";

    const filename = `${kind}_${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
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
    // Chef-Mode + PIN
    if (!ensureAdmin(adminPinEnv)) return;

    const ok = confirm("Foto wirklich löschen?");
    if (!ok) return;

    const pin = promptAdminPin(adminPinEnv);
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
    // Job-Link erst nach mount setzen (verhindert “komisches Laden”)
    setJobLink(window.location.href);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const running = entries.find((x) => x.worker === worker && !x.end_ts);
    setRunningId(running?.id || null);
  }, [worker, entries]);

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

  function exportCsv() {
    if (!job) return;

    const header = ["job_title", "customer", "vehicle", "plate", "job_status", "worker", "task", "start", "end", "duration_min"].join(",");

    const rows = entries
      .slice()
      .reverse()
      .map((e) => {
        const dur = durationMinutes(e.start_ts, e.end_ts);
        const cols = [job.title, job.customer || "", job.vehicle || "", job.plate || "", job.status || "open", e.worker, e.task || "", e.start_ts, e.end_ts || "", String(dur)].map((x) =>
          JSON.stringify(x)
        );
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
      await import("jspdf-autotable");

      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const margin = 40;
      let y = 46;

      // Titel
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text("Pro Automobile – Rapport", margin, y);
      y += 18;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(`Auftrag: ${job.title}`, margin, y);
      y += 14;
      doc.text(`Kunde: ${job.customer || "-"}`, margin, y);
      y += 14;
      doc.text(`Fahrzeug: ${job.vehicle || "-"}`, margin, y);
      y += 14;
      doc.text(`Kontrollschild: ${job.plate || "-"}`, margin, y);
      y += 14;
      doc.text(`Status: ${job.status || "open"}`, margin, y);
      y += 14;
      doc.text(`Erstellt: ${toLocal(job.created_at || null)}`, margin, y);
      y += 14;
      doc.text(`Abgeschlossen: ${toLocal(job.closed_at || null)}`, margin, y);
      y += 16;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(`Total: ${fmtMin(totals.total)}`, margin, y);
      y += 10;

      // Tabelle (schwarzer Balken)
      const rows = entries
        .slice()
        .reverse()
        .map((e) => {
          const dur = durationMinutes(e.start_ts, e.end_ts);
          return [e.worker, e.task || "-", toLocal(e.start_ts), e.end_ts ? toLocal(e.end_ts) : "läuft…", fmtMin(dur)];
        });

      (doc as any).autoTable({
        startY: y + 10,
        head: [["Mitarbeiter", "Tätigkeit", "Start", "Ende", "Dauer"]],
        body: rows,
        styles: { font: "helvetica", fontSize: 9, cellPadding: 5 },
        headStyles: { fillColor: [0, 0, 0], textColor: 255 },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        margin: { left: margin, right: margin },
      });

      y = (doc as any).lastAutoTable.finalY + 20;

      // Pflichtbilder (frisch signen, damit kein 400)
      const km = photos.find((p) => p.name.toLowerCase().startsWith("km_"));
      const ausweis = photos.find((p) => p.name.toLowerCase().startsWith("ausweis_"));

      const signedUrlHelper = async (path: string, seconds: number) => {
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
        if (error) throw new Error(error.message);
        if (!data?.signedUrl) throw new Error("Keine Signed URL");
        return data.signedUrl;
      };

      const addImageBlock = async (title: string, photo?: PhotoItem) => {
        if (!photo) return;
        if (y > 620) {
          doc.addPage();
          y = 40;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text(title, margin, y);
        y += 10;

        const freshUrl = await signedUrlHelper(photo.path, 60 * 30); // 30min
        const dataUrl = await fetchAsDataUrl(freshUrl);

        // Typ wählen (PNG/JPEG) damit kein "corrupt PNG"
        const e = extOf(photo.name);
        const imgType = e === "png" ? "PNG" : "JPEG";

        // Bildbox
        doc.addImage(dataUrl, imgType, margin, y + 6, 515, 240);
        y += 260;
      };

      await addImageBlock("Kilometerstand Foto", km);
      await addImageBlock("Fahrzeugausweis Foto", ausweis);

      // Unterschrift (schwarz auf weiss)
      if (job.signature_url) {
        if (y > 640) {
          doc.addPage();
          y = 40;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("Unterschrift", margin, y);
        y += 10;

        const sigDataUrl = await fetchAsDataUrl(job.signature_url);

        // weisser Hintergrund Block
        doc.setFillColor(255, 255, 255);
        doc.rect(margin, y + 6, 260, 120, "F");

        doc.addImage(sigDataUrl, "PNG", margin, y + 6, 260, 120);
        y += 140;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.text(`Name: ${job.signature_name || "-"}`, margin, y);
        y += 14;
        doc.text(`Zeit: ${toLocal(job.signature_at || null)}`, margin, y);
        y += 14;
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

      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30);
      const signedUrl = signed?.signedUrl;

      const now = new Date().toISOString();
      const { error: upErr } = await supabase
        .from("jobs")
        .update({
          signature_url: signedUrl || null,
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

  // Canvas Draw: schwarz auf weiss
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Hintergrund weiss
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Stift schwarz
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#000000";

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

  const logoFallbackRef = useRef(false);

  return (
    <div className="pageWrap">
      <a href="/" className="backLink">
        ← zurück
      </a>

      {/* Header */}
      <div className="card">
        <div className="rowWrap">
          <div className="titleBlock">
            <div className="logoWrap">
              <img
                src="/icons/logo.png"
                alt="Pro Automobile"
                onError={(e) => {
                  // einmal fallback versuchen
                  if (logoFallbackRef.current) return;
                  logoFallbackRef.current = true;
                  (e.currentTarget as HTMLImageElement).src = "/icons/logo.svg";
                }}
              />
            </div>

            <div>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted">{[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}</div>
              <div className="muted small">
                {done ? `✅ Abgeschlossen: ${toLocal(job?.closed_at || null)}` : `🟠 Offen (erstellt: ${toLocal(job?.created_at || null)})`}
              </div>
            </div>
          </div>

          <div className="rightPills">
            <span className="pill">
              <span className="dot" style={{ background: requiredOk.ok ? "#30d158" : "#ff453a" }} />
              Pflicht-Fotos: {requiredOk.ok ? "OK" : "fehlt"}
            </span>
          </div>
        </div>
      </div>

      {/* QR */}
      <div className="card">
        <div className="rowWrap">
          <div className="flex1">
            <div className="h2">QR-Link (Auftrag scannen)</div>
            <div className="muted small break">{jobLink}</div>
          </div>

          {qrUrl ? <img src={qrUrl} alt="QR" className="qr" /> : null}
        </div>
      </div>

      {/* Pflicht-Fotos */}
      <div className="card">
        <div className="h2">Fahrzeugausweis / Kilometer (Pflicht)</div>
        <div className="muted small">Ohne diese Fotos kann der Auftrag nicht abgeschlossen werden.</div>

        <div className="btnRow">
          <label className="btn btnPrimary">
            Fahrzeugausweis Foto hinzufügen
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

          <label className="btn btnPrimary">
            Kilometerstand Foto hinzufügen
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

        <div className="pillRow">
          <span className="pill">
            <span className="dot" style={{ background: requiredOk.hasAusweis ? "#30d158" : "#ff453a" }} />
            Ausweis: {requiredOk.hasAusweis ? "OK" : "fehlt"}
          </span>
          <span className="pill">
            <span className="dot" style={{ background: requiredOk.hasKm ? "#30d158" : "#ff453a" }} />
            KM: {requiredOk.hasKm ? "OK" : "fehlt"}
          </span>
        </div>

        <div className="miniList">
          {photos
            .filter((p) => p.name.toLowerCase().startsWith("ausweis_") || p.name.toLowerCase().startsWith("km_"))
            .map((p) => (
              <div key={p.path} className="miniRow">
                <div className="muted small break">✓ {p.name}</div>
                <button className="btn" onClick={() => window.open(p.url, "_blank")}>
                  Öffnen
                </button>
              </div>
            ))}
        </div>
      </div>

      {/* Start/Stop */}
      <div className="card">
        <div className="rowWrap">
          <div className="h2">Start / Stop</div>
          <div className="muted small">{msg}</div>
        </div>

        <div className="grid2">
          <select className="select" value={worker} onChange={(e) => setWorker(e.target.value)}>
            {WORKERS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>

          <select className="select" value={task} onChange={(e) => setTask(e.target.value)}>
            {TASKS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="grid2">
          <button className="btn btnPrimary" onClick={start} disabled={!!runningId || done}>
            Start
          </button>
          <button className="btn btnDark" onClick={stop} disabled={!runningId}>
            Stop
          </button>
        </div>

        <div className="grid2">
          <button className="btn btnDanger" onClick={closeJob} disabled={done}>
            Auftrag abschliessen ✅
          </button>
          <button className="btn" onClick={exportCsv}>
            CSV Rapport
          </button>
        </div>

        <div className="grid2">
          <button className="btn" onClick={exportPdfChef} disabled={busyPdf}>
            {busyPdf ? "PDF…" : "Rapport als PDF (Chef)"}
          </button>
          <div className="muted small centerY">PDF enthält Tabelle + KM/Ausweis + Unterschrift</div>
        </div>
      </div>

      {/* Rapport */}
      <div className="card">
        <div className="h2">Rapport</div>
        <div className="muted small">Total: {fmtMin(totals.total)}</div>

        <div className="miniList">
          {Object.entries(totals.perWorker).map(([w, m]) => (
            <div key={w} className="muted small">
              {w}: {fmtMin(m)}
            </div>
          ))}
        </div>

        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Tätigkeit</th>
                <th>Start</th>
                <th>Ende</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.worker}</td>
                  <td>{e.task || ""}</td>
                  <td>{toLocal(e.start_ts)}</td>
                  <td>{e.end_ts ? toLocal(e.end_ts) : <b>läuft…</b>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Schadenfotos */}
      <div className="card">
        <div className="rowWrap">
          <div>
            <div className="h2">Schadenfotos</div>
            <div className="muted small">Löschen ist Chef-geschützt.</div>
          </div>

          <label className="btn btnPrimary">
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
          <div className="muted small" style={{ marginTop: 10 }}>
            Noch keine Schadenfotos.
          </div>
        ) : (
          <div className="photoGrid">
            {damagePhotos.map((p) => (
              <div key={p.path} className="photoCard">
                <a href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} alt="Foto" className="photoImg" />
                </a>

                <div className="photoMeta">
                  <div className="muted small break">{p.name}</div>
                  <div className="btnRowTight">
                    <button className="btn" onClick={() => window.open(p.url, "_blank")}>
                      Öffnen
                    </button>
                    <button className="btn btnDanger" onClick={() => deletePhoto(p.path)}>
                      Löschen
                    </button>
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
        <div className="muted small">Wird im PDF übernommen, sobald gespeichert.</div>

        <div className="btnRow">
          <input className="input" value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Name (optional)" />

          <button
            className="btn"
            onClick={() => {
              const c = canvasRef.current;
              if (!c) return;
              const ctx = c.getContext("2d");
              if (!ctx) return;
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, c.width, c.height);
            }}
          >
            Löschen
          </button>

          <button className="btn btnPrimary" onClick={saveSignature} disabled={signBusy}>
            {signBusy ? "Speichert…" : "Unterschrift speichern"}
          </button>
        </div>

        <div className="sigBox">
          <canvas ref={canvasRef} width={700} height={220} className="sigCanvas" />
        </div>

        {job?.signature_url && (
          <div style={{ marginTop: 12 }}>
            <div className="muted small">Gespeicherte Unterschrift:</div>
            <img src={job.signature_url} alt="Unterschrift" style={{ marginTop: 6, width: 260, borderRadius: 12, background: "#fff" }} />
          </div>
        )}
      </div>
    </div>
  );
}
