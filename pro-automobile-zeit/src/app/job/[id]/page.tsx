"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { ensureAdmin } from "../../lib/admin";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null; // open | done
  created_at?: string | null;
  closed_at?: string | null;

  vin?: string | null;
  checklist?: any; // jsonb
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
  name: string;
  path: string;
  signedUrl?: string;
};

const WORKERS = ["Esteban", "Eron", "Jeremie", "Tsvetan", "Mensel"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt"];

const BUCKET = "job-photos";
const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

const CHECKLIST_KEYS = [
  { key: "probefahrt", label: "Probefahrt gemacht" },
  { key: "fluids", label: "Öl-/Flüssigkeiten geprüft" },
  { key: "errors", label: "Fehler ausgelesen/gelöscht" },
  { key: "wheels", label: "Radmuttern kontrolliert" },
  { key: "cleanup", label: "Fahrzeug sauber / Werkstatt sauber" },
  { key: "invoice", label: "Rechnung erstellt" },
  { key: "handover", label: "Schlüssel / Abgabe erfolgt" },
];

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

function fmtHM(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  // VIN
  const [vin, setVin] = useState("");
  const [scanOpen, setScanOpen] = useState(false);

  // checklist
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});

  // signature
  const [signName, setSignName] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  // camera scanning
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanLoopRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const done = (job?.status || "open") === "done";

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  async function loadJobAndEntries() {
    setMsg("");

    const { data: j, error: je } = await supabase.from("jobs").select("*").eq("id", jobId).single();
    if (je) setMsg(je.message);

    const jj = (j as any) as Job | null;
    setJob(jj);

    setVin(jj?.vin || "");
    setChecklist((jj?.checklist as any) || {});

    const { data: e, error: ee } = await supabase
      .from("time_entries")
      .select("*")
      .eq("job_id", jobId)
      .order("start_ts", { ascending: false });

    if (ee) setMsg(ee.message);
    const arr = ((e || []) as any) as Entry[];
    setEntries(arr);

    const running = arr.find((x) => x.worker === worker && !x.end_ts);
    setRunningId(running?.id || null);
  }

  async function loadPhotos() {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(jobId, { limit: 200, sortBy: { column: "name", order: "desc" } });

    if (error) return;

    const items: PhotoItem[] = (data || [])
      .filter((x) => x.name && !x.name.endsWith("/"))
      .map((x) => ({ name: x.name, path: `${jobId}/${x.name}` }));

    const withUrls: PhotoItem[] = [];
    for (const it of items) {
      const { data: s } = await supabase.storage.from(BUCKET).createSignedUrl(it.path, 60 * 60);
      withUrls.push({ ...it, signedUrl: s?.signedUrl || undefined });
    }
    setPhotos(withUrls);
  }

  useEffect(() => {
    // letzte Auswahl merken
    const lastWorker = localStorage.getItem("proauto_last_worker");
    const lastTask = localStorage.getItem("proauto_last_task");
    if (lastWorker && WORKERS.includes(lastWorker)) setWorker(lastWorker);
    if (lastTask && TASKS.includes(lastTask)) setTask(lastTask);

    loadJobAndEntries();
    loadPhotos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("proauto_last_worker", worker);
  }, [worker]);

  useEffect(() => {
    localStorage.setItem("proauto_last_task", task);
  }, [task]);

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

  async function checkRunningOtherJob(w: string) {
    const { data, error } = await supabase
      .from("time_entries")
      .select("id, job_id")
      .eq("worker", w)
      .is("end_ts", null)
      .limit(1);

    if (error) return { ok: true, otherJobId: null as string | null };

    const r = (data || [])[0] as any;
    if (!r) return { ok: true, otherJobId: null as string | null };

    if (r.job_id && r.job_id !== jobId) {
      return { ok: false, otherJobId: r.job_id as string };
    }
    return { ok: true, otherJobId: null as string | null };
  }

  async function startFor(w: string, t: string) {
    if (done) return setMsg("Auftrag ist abgeschlossen (gesperrt).");

    const chk = await checkRunningOtherJob(w);
    if (!chk.ok && chk.otherJobId) {
      setMsg(`⚠️ ${w} läuft bereits auf einem anderen Auftrag.`);
      const go = confirm(`⚠️ ${w} läuft auf einem anderen Auftrag.\n\nDorthin wechseln?`);
      if (go) window.location.href = `/job/${chk.otherJobId}`;
      return;
    }

    const existing = entries.find((e) => e.worker === w && !e.end_ts);
    if (existing) return setMsg(`${w} läuft bereits…`);

    const { data, error } = await supabase
      .from("time_entries")
      .insert({ job_id: jobId, worker: w, task: t })
      .select("id")
      .single();

    if (error) return setMsg(error.message);

    setWorker(w);
    setTask(t);
    setRunningId(data.id);
    setMsg(`✅ ${w} läuft…`);
    await loadJobAndEntries();
  }

  async function stop() {
    if (!runningId) return;
    const { error } = await supabase.from("time_entries").update({ end_ts: new Date().toISOString() }).eq("id", runningId);
    if (error) return setMsg(error.message);

    setRunningId(null);
    setMsg("🛑 gestoppt");
    await loadJobAndEntries();
  }

  async function closeJobChef() {
    if (!ensureAdmin(ADMIN_PIN)) return;
    const ok = confirm("Auftrag wirklich abschliessen? Danach ist Start/Stop gesperrt.");
    if (!ok) return;

    const nowIso = new Date().toISOString();
    await supabase.from("time_entries").update({ end_ts: nowIso }).eq("job_id", jobId).is("end_ts", null);

    const { error } = await supabase.from("jobs").update({ status: "done", closed_at: nowIso }).eq("id", jobId);
    if (error) return setMsg(error.message);

    setMsg("✅ Auftrag abgeschlossen");
    await loadJobAndEntries();
  }

  async function reopenJobChef() {
    if (!ensureAdmin(ADMIN_PIN)) return;
    const { error } = await supabase.from("jobs").update({ status: "open", closed_at: null }).eq("id", jobId);
    if (error) return setMsg(error.message);

    setMsg("🔓 Auftrag wieder offen");
    await loadJobAndEntries();
  }

  async function saveVin() {
    const v = vin.trim().toUpperCase();
    if (v && v.length !== 17) {
      const ok = confirm("VIN ist nicht 17 Zeichen. Trotzdem speichern?");
      if (!ok) return;
    }
    const { error } = await supabase.from("jobs").update({ vin: v || null }).eq("id", jobId);
    if (error) return setMsg(error.message);
    setMsg("✅ VIN gespeichert");
    await loadJobAndEntries();
  }

  async function saveChecklist(next: Record<string, boolean>) {
    const { error } = await supabase.from("jobs").update({ checklist: next }).eq("id", jobId);
    if (error) return setMsg(error.message);
    setMsg("✅ Checkliste gespeichert");
    await loadJobAndEntries();
  }

  function toggleChecklist(key: string) {
    const next = { ...(checklist || {}) };
    next[key] = !next[key];
    setChecklist(next);
    saveChecklist(next);
  }

  async function uploadPhoto(file: File) {
    if (!file) return;
    setMsg("⏳ Foto wird hochgeladen…");

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const fname = `${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(16).slice(2)}.${ext}`;
    const path = `${jobId}/${fname}`;

    const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "image/jpeg",
    });
    if (error) return setMsg(`❌ Upload Fehler: ${error.message}`);

    setMsg("📸 Foto gespeichert");
    await loadPhotos();
  }

  async function deletePhotoChef(p: PhotoItem) {
    if (!ensureAdmin(ADMIN_PIN)) return;
    const { error } = await supabase.storage.from(BUCKET).remove([p.path]);
    if (error) return setMsg(`❌ Löschen fehlgeschlagen: ${error.message}`);
    setMsg("🗑️ Foto gelöscht");
    await loadPhotos();
  }

  // ---- Signature pad
  function canvasSizeFix() {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(rect.width * dpr);
    c.height = Math.floor(200 * dpr);
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(0, 0, rect.width, 200);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
    }
  }

  useEffect(() => {
    canvasSizeFix();
  }, []);

  function getPos(e: any) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return { x, y };
  }

  function startDraw(e: any) {
    drawing.current = true;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.preventDefault?.();
  }

  function moveDraw(e: any) {
    if (!drawing.current) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    e.preventDefault?.();
  }

  function endDraw() {
    drawing.current = false;
  }

  function clearSignature() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const rect = c.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, 200);
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(0, 0, rect.width, 200);
    setMsg("Unterschrift gelöscht (lokal).");
  }

  async function saveSignatureChef() {
    if (!ensureAdmin(ADMIN_PIN)) return;

    if (!signName.trim()) {
      alert("Bitte Name für Unterschrift eingeben.");
      return;
    }

    const c = canvasRef.current;
    if (!c) return;
    const dataUrl = c.toDataURL("image/png");
    const res = await fetch(dataUrl);
    const blob = await res.blob();

    const path = `${jobId}/signature.png`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
      cacheControl: "3600",
      upsert: true,
      contentType: "image/png",
    });
    if (error) return setMsg(`❌ Signatur Upload Fehler: ${error.message}`);

    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
    const signedUrl = signed?.signedUrl || null;

    const { error: e2 } = await supabase
      .from("jobs")
      .update({
        signature_url: signedUrl,
        signature_name: signName.trim(),
        signature_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (e2) return setMsg(e2.message);

    setMsg("✅ Unterschrift gespeichert");
    await loadJobAndEntries();
    await loadPhotos();
  }

  // ---- VIN scan
  async function openScan() {
    setScanOpen(true);
    setMsg("");
    setTimeout(() => startScanLoop(), 150);
  }

  async function startScanLoop() {
    try {
      if (!videoRef.current) return;

      // @ts-ignore
      const hasBD = typeof window !== "undefined" && "BarcodeDetector" in window;
      if (!hasBD) {
        alert("VIN-Scan wird auf diesem Gerät/Browser nicht unterstützt. Bitte VIN manuell eingeben.");
        setScanOpen(false);
        return;
      }

      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      videoRef.current.srcObject = streamRef.current;
      await videoRef.current.play();

      // @ts-ignore
      const detector = new window.BarcodeDetector({
        formats: ["code_128", "code_39", "qr_code", "ean_13", "ean_8"],
      });

      const loop = async () => {
        if (!videoRef.current) return;
        try {
          // @ts-ignore
          const codes = await detector.detect(videoRef.current);
          if (codes && codes.length > 0) {
            const raw = (codes[0].rawValue || "").toString().trim().toUpperCase();
            if (raw.length >= 10) {
              setVin(raw.slice(0, 17));
              stopScan();
              setScanOpen(false);
              setMsg("✅ Scan erkannt – VIN übernehmen & speichern.");
              return;
            }
          }
        } catch {}
        scanLoopRef.current = window.requestAnimationFrame(loop);
      };

      scanLoopRef.current = window.requestAnimationFrame(loop);
    } catch (e: any) {
      alert("Kamera Fehler: " + (e?.message || "Unbekannt"));
      setScanOpen(false);
      stopScan();
    }
  }

  function stopScan() {
    if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
    scanLoopRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  useEffect(() => {
    return () => stopScan();
  }, []);

  // ---- PDF (Chef)
  async function exportPdfChef() {
    if (!ensureAdmin(ADMIN_PIN)) return;
    if (!job) return;

    setMsg("⏳ PDF wird erstellt…");

    const jsPDFMod = await import("jspdf");
    const autoTableMod = await import("jspdf-autotable");
    const jsPDF = (jsPDFMod as any).jsPDF;
    const autoTable = (autoTableMod as any).default;

    const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });

    try {
      const logoDataUrl = await urlToDataUrl("/logo.png");
      doc.addImage(logoDataUrl, "PNG", 14, 10, 18, 18);
    } catch {}

    doc.setFontSize(16);
    doc.text("Pro Automobile – Rapport", 36, 18);

    doc.setFontSize(10);
    const infoLines = [
      `Auftrag: ${job.title}`,
      `Kunde: ${job.customer || ""}`,
      `Fahrzeug: ${job.vehicle || ""}`,
      `Kontrollschild: ${job.plate || ""}`,
      `VIN: ${job.vin || ""}`,
      `Status: ${(job.status || "open") === "done" ? "Abgeschlossen" : "Offen"}`,
      job.closed_at ? `Abgeschlossen: ${toLocal(job.closed_at)}` : "",
    ].filter(Boolean);

    let y = 32;
    for (const line of infoLines) {
      doc.text(line, 14, y);
      y += 5;
    }

    const body = entries
      .slice()
      .reverse()
      .map((e) => {
        const min = durationMinutes(e.start_ts, e.end_ts);
        return [e.worker, e.task || "", toLocal(e.start_ts), e.end_ts ? toLocal(e.end_ts) : "läuft…", String(min), fmtHM(min)];
      });

    autoTable(doc, {
      startY: y + 2,
      head: [["Mitarbeiter", "Tätigkeit", "Start", "Ende", "Min", "Dauer"]],
      body: body.length ? body : [["-", "-", "-", "-", "-", "-"]],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [20, 20, 20] },
    });

    const afterTableY = (doc as any).lastAutoTable?.finalY || 120;

    doc.setFontSize(12);
    doc.text("Checkliste", 14, afterTableY + 10);
    doc.setFontSize(10);
    let cy = afterTableY + 16;
    for (const it of CHECKLIST_KEYS) {
      const val = !!(checklist || {})[it.key];
      doc.text(`${val ? "☑" : "☐"} ${it.label}`, 14, cy);
      cy += 5;
      if (cy > 270) break;
    }

    const photoCandidates = photos
      .filter((p) => p.signedUrl)
      .filter((p) => !p.name.toLowerCase().includes("signature"))
      .slice(0, 6);

    if (photoCandidates.length > 0) {
      doc.setFontSize(12);
      doc.text("Fotos (Auszug)", 14, cy + 6);
      cy += 12;

      let x = 14;
      let rowH = 0;

      for (const p of photoCandidates) {
        try {
          const dataUrl = await urlToDataUrl(p.signedUrl!);
          const w = 40;
          const h = 30;
          doc.addImage(dataUrl, "JPEG", x, cy, w, h);
          rowH = Math.max(rowH, h);
          x += w + 6;
          if (x > 160) {
            x = 14;
            cy += rowH + 8;
            rowH = 0;
          }
        } catch {}
      }
      cy += rowH + 8;
    }

    if (job.signature_url && job.signature_name) {
      doc.setFontSize(12);
      doc.text("Unterschrift", 14, cy + 6);
      cy += 10;

      try {
        const sigData = await urlToDataUrl(job.signature_url);
        doc.addImage(sigData, "PNG", 14, cy, 70, 24);
      } catch {}

      doc.setFontSize(10);
      doc.text(`${job.signature_name} · ${job.signature_at ? toLocal(job.signature_at) : ""}`, 90, cy + 14);
      cy += 30;
    }

    const totalMin = totals.total;
    doc.setFontSize(12);
    doc.text(`TOTAL: ${fmtHM(totalMin)} (${totalMin} min)`, 14, Math.min(cy + 6, 285));

    const fileName = `rapport_${(job.plate || "ohne-kennzeichen").replace(/\s+/g, "_")}_${jobId}.pdf`;
    doc.save(fileName);

    setMsg("✅ PDF erstellt");
  }

  async function refreshAll() {
    await loadJobAndEntries();
    await loadPhotos();
    setMsg("Aktualisiert");
  }

  return (
    <div className="container">
      <a href="/" style={{ textDecoration: "none", color: "inherit", opacity: 0.85 }}>
        ← zurück
      </a>

      <div className="card">
        <div className="row">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className="logoWrap">
              <img src="/logo.png" alt="Pro Automobile" />
            </div>
            <div>
              <div className="h1">{job?.title || "Auftrag"}</div>
              <div className="muted">{[job?.customer, job?.vehicle, job?.plate].filter(Boolean).join(" · ")}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {msg}
              </div>
            </div>
          </div>

          <span className={"badge " + (done ? "badgeDone" : "")}>
            <span className="badgeDot" />
            {done ? "Abgeschlossen" : "Offen"}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <div className="h2">QR-Link (Auftrag scannen)</div>
            <div className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>
              {jobLink}
            </div>
          </div>
          <img src={qrUrl} alt="QR" style={{ width: 140, height: 140, borderRadius: 16 }} />
        </div>
      </div>

      <div className="card">
        <div className="h2">Quick Start (1 Klick)</div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <select className="select" value={task} onChange={(e) => setTask(e.target.value)}>
            {TASKS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn btnDark" onClick={refreshAll}>
            Aktualisieren
          </button>
        </div>

        <div className="grid3" style={{ marginTop: 10 }}>
          {WORKERS.map((w) => (
            <button key={w} className="btn btnPrimary" disabled={done} onClick={() => startFor(w, task)}>
              {w} START
            </button>
          ))}
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDark" onClick={stop} disabled={!runningId}>
            Stop (aktueller Mitarbeiter)
          </button>
          <button className="btn btnDanger" onClick={closeJobChef} disabled={done}>
            Auftrag abschliessen (Chef)
          </button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDark" onClick={reopenJobChef} disabled={!done}>
            Auftrag entsperren (Chef)
          </button>
          <button className="btn btnDark" onClick={exportPdfChef}>
            PDF Rapport (Chef)
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <div className="h2">VIN</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Manuell eintragen oder scannen (wenn Browser unterstützt).
            </div>
          </div>
          <button className="btn btnDark" style={{ width: 180 }} onClick={openScan}>
            VIN scannen
          </button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <input className="input" placeholder="VIN (17 Zeichen)" value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} />
          <button className="btn btnPrimary" onClick={saveVin}>
            VIN speichern
          </button>
        </div>
      </div>

      <div className="card">
        <div className="h2">Checkliste Kontrolle / Abgabe</div>
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {CHECKLIST_KEYS.map((it) => (
            <label key={it.key} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="checkbox" checked={!!checklist?.[it.key]} onChange={() => toggleChecklist(it.key)} style={{ width: 20, height: 20 }} />
              <span>{it.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <div className="h2">Fotos / Schäden</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Bucket ist privat: App zeigt Fotos via Signed-Links.
            </div>
          </div>

          <label className="btn btnPrimary" style={{ width: 220, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            📸 Foto hinzufügen
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPhoto(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>

        {photos.filter((p) => !p.name.toLowerCase().includes("signature")).length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Noch keine Fotos.
          </div>
        ) : (
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
            {photos
              .filter((p) => !p.name.toLowerCase().includes("signature"))
              .map((p) => (
                <div key={p.path} style={{ borderRadius: 16, overflow: "hidden", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <a href={p.signedUrl || "#"} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                    <img src={p.signedUrl || ""} alt={p.name} style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }} />
                  </a>
                  <div style={{ padding: 10, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <div className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <button className="btn btnDark" style={{ padding: "8px 10px" }} onClick={() => deletePhotoChef(p)}>
                      🗑️ (Chef)
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h2">Unterschrift (Chef)</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Nur Chef kann speichern. Wird im PDF angezeigt.
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <input className="input" placeholder="Name (z.B. Kunde)" value={signName} onChange={(e) => setSignName(e.target.value)} />
          <button className="btn btnPrimary" onClick={saveSignatureChef}>
            Unterschrift speichern (Chef)
          </button>
        </div>

        <div style={{ marginTop: 10, border: "1px solid rgba(255,255,255,.10)", borderRadius: 16, overflow: "hidden" }}>
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: 200, display: "block", background: "rgba(255,255,255,0.02)" }}
            onMouseDown={startDraw}
            onMouseMove={moveDraw}
            onMouseUp={endDraw}
            onMouseLeave={endDraw}
            onTouchStart={startDraw}
            onTouchMove={moveDraw}
            onTouchEnd={endDraw}
          />
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDark" onClick={clearSignature}>
            Clear
          </button>
          <button className="btn btnDark" onClick={refreshAll}>
            Reload
          </button>
        </div>

        {job?.signature_name && (
          <div className="muted" style={{ marginTop: 10 }}>
            ✅ Gespeichert: <b>{job.signature_name}</b> {job.signature_at ? `· ${toLocal(job.signature_at)}` : ""}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h2">Rapport</div>
        <div style={{ marginTop: 8 }}>
          <b>Total:</b> {fmtHM(totals.total)}
        </div>

        <div style={{ marginTop: 8 }}>
          {Object.entries(totals.perWorker).map(([w, m]) => (
            <div key={w} className="muted">
              {w}: {fmtHM(m)}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Mitarbeiter</th>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Tätigkeit</th>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Start</th>
                <th style={{ textAlign: "left", padding: 8, opacity: 0.7 }}>Ende</th>
                <th style={{ textAlign: "right", padding: 8, opacity: 0.7 }}>Min</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  <td style={{ padding: 8 }}>{e.worker}</td>
                  <td style={{ padding: 8 }}>{e.task || ""}</td>
                  <td style={{ padding: 8 }}>{toLocal(e.start_ts)}</td>
                  <td style={{ padding: 8 }}>{e.end_ts ? toLocal(e.end_ts) : <b>läuft…</b>}</td>
                  <td style={{ padding: 8, textAlign: "right" }}>{durationMinutes(e.start_ts, e.end_ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {scanOpen && (
        <div className="modalBack" onClick={() => { setScanOpen(false); stopScan(); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <div className="h2">VIN Scan</div>
              <button className="btn btnDark" style={{ width: 140 }} onClick={() => { setScanOpen(false); stopScan(); }}>
                Schliessen
              </button>
            </div>

            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Halte Kamera auf VIN Barcode / QR / Code128 (wenn vorhanden). Wenn dein Gerät das nicht kann → VIN manuell.
            </div>

            <div style={{ marginTop: 10, borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,.10)" }}>
              <video ref={videoRef} style={{ width: "100%", display: "block" }} playsInline />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
