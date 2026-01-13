"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ensureAdmin, promptAdminPin, isAdmin, logoutAdmin } from "../../lib/admin";

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

type PhotoItem = {
  path: string;
  name: string;
  url: string;
};

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

async function fetchAsDataUrl(url: string): Promise<{ dataUrl: string; kind: "PNG" | "JPEG" }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bild konnte nicht geladen werden (${res.status})`);
  const blob = await res.blob();
  const mime = (blob.type || "").toLowerCase();
  const kind: "PNG" | "JPEG" = mime.includes("png") ? "PNG" : "JPEG";

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Bild konnte nicht gelesen werden"));
    r.readAsDataURL(blob);
  });

  return { dataUrl, kind };
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  // Chef PIN aus ENV (Frontend)
  const adminPinEnv = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [busyPdf, setBusyPdf] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [signName, setSignName] = useState("");
  const [signBusy, setSignBusy] = useState(false);

  const done = (job?.status || "open") === "done";

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  const ausweisPhotos = useMemo(() => photos.filter((p) => p.name.toLowerCase().startsWith("ausweis_")), [photos]);
  const kmPhotos = useMemo(() => photos.filter((p) => p.name.toLowerCase().startsWith("km_")), [photos]);
  const damagePhotos = useMemo(() => photos.filter((p) => p.name.toLowerCase().startsWith("schaden_")), [photos]);

  const requiredOk = useMemo(() => {
    const hasAusweis = ausweisPhotos.length > 0;
    const hasKm = kmPhotos.length > 0;
    return { hasAusweis, hasKm, ok: hasAusweis && hasKm };
  }, [ausweisPhotos, kmPhotos]);

  const refreshPhotos = async () => {
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

    // Parallel statt langsam nacheinander -> fühlt sich “weniger laden” an
    const signed = await Promise.all(
      items.map(async (it) => {
        const path = `${jobId}/${it.name}`;
        const { data: s } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
        if (!s?.signedUrl) return null;
        return { path, name: it.name, url: s.signedUrl } as PhotoItem;
      })
    );

    setPhotos(signed.filter(Boolean) as PhotoItem[]);
  };

  const uploadPhoto = async (file: File, kind: "ausweis" | "km" | "schaden") => {
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
  };

  const deletePhoto = async (path: string) => {
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
  };

  const load = async () => {
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
  };

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

  const start = async () => {
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
  };

  const stop = async () => {
    if (!runningId) return;
    const { error } = await supabase.from("time_entries").update({ end_ts: new Date().toISOString() }).eq("id", runningId);
    if (error) return setMsg(error.message);

    setRunningId(null);
    setMsg("🛑 gestoppt");
    await load();
  };

  const closeJob = async () => {
    setMsg("");

    if (!requiredOk.hasKm) return setMsg("❗ Abschluss nicht möglich: Kilometer Foto fehlt.");
    if (!requiredOk.hasAusweis) return setMsg("❗ Abschluss nicht möglich: Fahrzeugausweis Foto fehlt.");

    const now = new Date().toISOString();

    await supabase.from("time_entries").update({ end_ts: now }).eq("job_id", jobId).is("end_ts", null);
    await supabase.from("jobs").update({ status: "done", closed_at: now }).eq("id", jobId);

    setMsg("✅ Auftrag abgeschlossen");
    await load();
  };

  const exportPdfChef = async () => {
    if (!ensureAdmin(adminPinEnv)) return;
    if (!job) return;

    try {
      setBusyPdf(true);

      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "pt", format: "a4" });

      const margin = 40;
      const pageW = 595;
      const usableW = pageW - margin * 2;

      let y = 46;

      // Kopf
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

      // ✅ Schwarzer Balken “Rapport Übersicht”
      const barH = 22;
      doc.setFillColor(0, 0, 0);
      doc.rect(margin, y, usableW, barH, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(12);
      doc.text("Rapport – Übersicht", margin + 10, y + 15);
      doc.setTextColor(0, 0, 0);
      y += barH + 12;

      // Totale
      doc.setFontSize(11);
      doc.text(`Total: ${fmtMin(totals.total)}`, margin, y);
      y += 16;

      doc.setFontSize(10);
      Object.entries(totals.perWorker).forEach(([w, m]) => {
        doc.text(`${w}: ${fmtMin(m)}`, margin, y);
        y += 12;
      });
      y += 10;

      // ✅ Tabelle (klar + schön)
      const col = {
        worker: margin,
        task: margin + 120,
        start: margin + 270,
        end: margin + 400,
        min: margin + 510,
      };

      // Header black bar
      if (y > 720) { doc.addPage(); y = 40; }
      doc.setFillColor(0, 0, 0);
      doc.rect(margin, y, usableW, 20, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(10);
      doc.text("Mitarbeiter", col.worker + 6, y + 14);
      doc.text("Tätigkeit", col.task + 6, y + 14);
      doc.text("Start", col.start + 6, y + 14);
      doc.text("Ende", col.end + 6, y + 14);
      doc.text("Min", col.min + 6, y + 14);
      doc.setTextColor(0, 0, 0);
      y += 26;

      const rows = entries.slice().reverse(); // chronologisch

      rows.forEach((e) => {
        if (y > 760) { doc.addPage(); y = 40; }

        const dur = durationMinutes(e.start_ts, e.end_ts);
        const start = toLocal(e.start_ts);
        const end = e.end_ts ? toLocal(e.end_ts) : "läuft…";

        doc.setFontSize(9);
        doc.text(String(e.worker || ""), col.worker + 6, y);
        doc.text(String(e.task || "-"), col.task + 6, y);
        doc.text(start, col.start + 6, y);
        doc.text(end, col.end + 6, y);
        doc.text(String(dur), col.min + 6, y);

        y += 14;
      });

      y += 10;

      // ✅ Fotos (KM & Ausweis)
      const addImageBlock = async (title: string, url?: string) => {
        if (!url) return;
        if (y > 620) { doc.addPage(); y = 40; }

        // Titelbar black
        doc.setFillColor(0, 0, 0);
        doc.rect(margin, y, usableW, 18, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.text(title, margin + 10, y + 13);
        doc.setTextColor(0, 0, 0);
        y += 24;

        const { dataUrl, kind } = await fetchAsDataUrl(url);

        // Bildbox max (h 260)
        doc.addImage(dataUrl, kind, margin, y, usableW, 260);
        y += 270;
      };

      const km = kmPhotos[0];
      const ausweis = ausweisPhotos[0];
      await addImageBlock("Kilometerstand Foto", km?.url);
      await addImageBlock("Fahrzeugausweis Foto", ausweis?.url);

      // ✅ Unterschrift im PDF (wenn vorhanden)
      if (job.signature_url) {
        if (y > 680) { doc.addPage(); y = 40; }

        doc.setFillColor(0, 0, 0);
        doc.rect(margin, y, usableW, 18, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(11);
        doc.text("Unterschrift", margin + 10, y + 13);
        doc.setTextColor(0, 0, 0);
        y += 24;

        const { dataUrl, kind } = await fetchAsDataUrl(job.signature_url);
        doc.addImage(dataUrl, kind, margin, y, 260, 120);
        y += 130;

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
  };

  const saveSignature = async () => {
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
  };

  // ✅ Canvas Draw: Schwarz auf Weiss
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Hintergrund weiss
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

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

  const chefActive = typeof window !== "undefined" ? isAdmin() : false;

  // Kleine helper zum Clear (weiss füllen, nicht transparent)
  const clearSignature = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
  };

  return (
    <div
      style={{
        maxWidth: 1200,
        margin: "0 auto",
        padding: "16px 16px 80px",
        boxSizing: "border-box",
      }}
    >
      <a href="/" style={{ textDecoration: "none" }}>← zurück</a>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 260, flex: "1 1 420px" }}>
            <div className="logoWrap">
              <img
                src="/icons/logo.png"
                alt="Pro Automobile"
                loading="eager"
                onError={(e) => {
                  // ✅ verhindert Endlosschleife
                  (e.currentTarget as any).onerror = null;
                  (e.currentTarget as any).src = "/icons/logo.svg";
                }}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {done ? `✅ Abgeschlossen: ${toLocal(job?.closed_at || null)}` : `🟠 Offen (erstellt: ${toLocal(job?.created_at || null)})`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flex: "1 1 260px" }}>
            <span className="pill">
              <span className="dot" style={{ background: requiredOk.ok ? "var(--ok)" : "var(--bad)" }} />
              Pflicht-Fotos: {requiredOk.ok ? "OK" : "fehlt"}
            </span>

            <button
              className="btn"
              onClick={() => {
                if (!chefActive) ensureAdmin(adminPinEnv);
                else { logoutAdmin(); alert("Chef-Modus deaktiviert"); }
              }}
            >
              {chefActive ? "Chef-Modus aus" : "Chef-Modus"}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div style={{ minWidth: 260, flex: "1 1 520px" }}>
            <div className="h2">QR-Link (Auftrag scannen)</div>
            <div className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>{jobLink}</div>
          </div>
          <img
            src={qrUrl}
            alt="QR"
            style={{ width: 140, height: 140, borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)" }}
          />
        </div>
      </div>

      <div className="card">
        <div className="h2">Fahrzeugausweis / Kilometer (Pflicht)</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Ohne diese Fotos kann der Auftrag <b>nicht</b> abgeschlossen werden.
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label className="btn btnPrimary" style={{ cursor: "pointer" }}>
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

          <label className="btn btnPrimary" style={{ cursor: "pointer" }}>
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

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span className="pill">
            <span className="dot" style={{ background: requiredOk.hasAusweis ? "var(--ok)" : "var(--bad)" }} />
            Ausweis: {requiredOk.hasAusweis ? "OK" : "fehlt"}
          </span>
          <span className="pill">
            <span className="dot" style={{ background: requiredOk.hasKm ? "var(--ok)" : "var(--bad)" }} />
            KM: {requiredOk.hasKm ? "OK" : "fehlt"}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="h2">Start / Stop</div>

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
          <button className="btn" onClick={exportPdfChef} disabled={busyPdf}>{busyPdf ? "PDF…" : "Rapport als PDF (Chef)"}</button>
        </div>

        {msg && <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>{msg}</div>}
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
              await uploadPhoto(file, "schaden");
            }}
          />
        </label>

        {damagePhotos.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>Noch keine Schadenfotos.</div>
        ) : (
          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            {damagePhotos.map((p) => (
              <div
                key={p.path}
                style={{
                  borderRadius: 16,
                  overflow: "hidden",
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.18)",
                }}
              >
                <a href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} alt="Foto" style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }} />
                </a>

                <div style={{ padding: 10 }}>
                  <div className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>{p.name}</div>

                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
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

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            className="input"
            value={signName}
            onChange={(e) => setSignName(e.target.value)}
            placeholder="Name (optional)"
            style={{ minWidth: 220, flex: 1 }}
          />
          <button className="btn" onClick={clearSignature}>Löschen</button>
          <button className="btn btnPrimary" onClick={saveSignature} disabled={signBusy}>
            {signBusy ? "Speichert…" : "Unterschrift speichern"}
          </button>
        </div>

        <div style={{ marginTop: 12, borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)" }}>
          <canvas
            ref={canvasRef}
            width={900}
            height={240}
            style={{
              width: "100%",
              height: 190,
              background: "#ffffff",
              display: "block",
            }}
          />
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
