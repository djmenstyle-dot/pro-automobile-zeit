"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";

type Job = {
  id: string;
  title: string;
  customer: string | null;
  vehicle: string | null;
  plate: string | null;
  status: string | null; // "open" | "done"
  created_at?: string | null;
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

type PhotoItem = {
  name: string;
  path: string; // jobId/name
  signedUrl?: string;
};

const WORKERS = ["Esteban", "Eron", "Jeremie", "Tsvetan", "Mensel"];
const TASKS = ["Service", "Diagnose", "Bremsen", "Reifen", "MFK", "Elektrik", "Klima", "Probefahrt"];

const BUCKET = "job-photos";

// ⚠️ Hinweis: NEXT_PUBLIC_* ist im Frontend sichtbar. Für „richtig sicher“ müsste das über eine Server-Route laufen.
// Für eure super-einfache PIN-Variante ok:
const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

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
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h ${m} min`;
}

function safeText(s?: string | null) {
  return (s || "").trim();
}

function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, "");
}

function isAdminPinOk(pin: string) {
  if (!ADMIN_PIN) return false;
  return pin === ADMIN_PIN;
}

export default function JobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;

  const [job, setJob] = useState<Job | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [worker, setWorker] = useState(WORKERS[0]);
  const [task, setTask] = useState(TASKS[0]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  // Fotos
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);

  const done = (job?.status || "open") === "done";

  const jobLink = useMemo(() => (typeof window !== "undefined" ? window.location.href : ""), []);
  const qrUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(jobLink)}`,
    [jobLink]
  );

  const subtitle = useMemo(() => {
    const parts = [job?.customer, job?.vehicle, job?.plate].filter(Boolean) as string[];
    return parts.join(" · ");
  }, [job]);

  async function loadJobAndEntries() {
    setMsg("");

    const { data: j, error: je } = await supabase.from("jobs").select("*").eq("id", jobId).single();
    if (je) setMsg(je.message);
    setJob((j as any) || null);

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
    // Listet die Objekte im Ordner jobId/
    const { data, error } = await supabase.storage.from(BUCKET).list(jobId, { limit: 100, sortBy: { column: "name", order: "desc" } });
    if (error) {
      // Nicht nerven – nur wenn wirklich nötig
      return;
    }

    const items: PhotoItem[] = (data || [])
      .filter((x) => x.name && !x.name.endsWith("/"))
      .map((x) => ({
        name: x.name,
        path: `${jobId}/${x.name}`,
      }));

    // Signed URLs (1h)
    const withUrls: PhotoItem[] = [];
    for (const it of items) {
      const { data: s } = await supabase.storage.from(BUCKET).createSignedUrl(it.path, 60 * 60);
      withUrls.push({ ...it, signedUrl: s?.signedUrl || undefined });
    }

    setPhotos(withUrls);
  }

  useEffect(() => {
    loadJobAndEntries();
    loadPhotos();
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

    // Prüfe ob dieser Mitarbeiter irgendwo anders noch „läuft“
    const { data: otherRunning, error } = await supabase
      .from("time_entries")
      .select("id, job_id")
      .eq("worker", worker)
      .is("end_ts", null)
      .limit(1);

    if (error) return setMsg(error.message);

    const r = (otherRunning || [])[0] as any;
    if (r && r.job_id && r.job_id !== jobId) {
      const ok = window.confirm(
        `⚠️ Achtung: ${worker} läuft noch auf einem ANDEREN Auftrag.\n\nWillst du trotzdem auf diesem Auftrag starten? (Das kann Fehler geben)`
      );
      if (!ok) return;
    }

    // Prüfe ob schon im aktuellen Auftrag läuft
    const existing = entries.find((e) => e.worker === worker && !e.end_ts);
    if (existing) return setMsg("Läuft bereits…");

    const { data, error: ie } = await supabase
      .from("time_entries")
      .insert({ job_id: jobId, worker, task })
      .select("id")
      .single();

    if (ie) return setMsg(ie.message);

    setRunningId(data.id);
    setMsg("✅ läuft…");
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

  async function closeJob() {
    if (!job) return;

    const ok = window.confirm("Auftrag wirklich abschliessen? Danach ist Start/Stop gesperrt.");
    if (!ok) return;

    const now = new Date().toISOString();

    // stoppe alles was läuft
    await supabase.from("time_entries").update({ end_ts: now }).eq("job_id", jobId).is("end_ts", null);

    // status + closed_at
    const { error } = await supabase.from("jobs").update({ status: "done", closed_at: now }).eq("id", jobId);
    if (error) return setMsg(error.message);

    setMsg("✅ Auftrag abgeschlossen");
    await loadJobAndEntries();
  }

  async function reopenJobAdmin() {
    if (!job) return;
    const pin = window.prompt("Admin PIN eingeben, um Auftrag wieder zu entsperren:");
    if (!pin) return;

    if (!isAdminPinOk(pin)) {
      setMsg("❌ Falscher PIN");
      return;
    }

    const { error } = await supabase.from("jobs").update({ status: "open", closed_at: null }).eq("id", jobId);
    if (error) return setMsg(error.message);

    setMsg("🔓 Auftrag wieder geöffnet");
    await loadJobAndEntries();
  }

  function exportCsvBetter() {
    if (!job) return;

    // Excel DE/CH mag oft ; als Trennzeichen
    const header = [
      "Auftrag",
      "Kunde",
      "Fahrzeug",
      "Kontrollschild",
      "Status",
      "Mitarbeiter",
      "Tätigkeit",
      "Start (lokal)",
      "Ende (lokal)",
      "Dauer (min)",
    ].join(";");

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
          toLocal(e.start_ts),
          e.end_ts ? toLocal(e.end_ts) : "läuft…",
          String(dur),
        ].map((x) => `"${String(x).replace(/"/g, '""')}"`);
        return cols.join(";");
      });

    // BOM + sep=; damit Excel sauber öffnet
    const csv = "\uFEFF" + "sep=;\n" + [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `rapport_${(job.plate || "ohne-kontrollschild").replace(/\s+/g, "_")}_${jobId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPdfAdmin() {
    const pin = window.prompt("Admin PIN für PDF Rapport:");
    if (!pin) return;
    if (!isAdminPinOk(pin)) {
      setMsg("❌ Falscher PIN");
      return;
    }

    // Simple: Druckansicht öffnen -> „Als PDF speichern“
    const w = window.open("", "_blank");
    if (!w) return;

    const title = job?.title || "Rapport";
    const plate = job?.plate || "";
    const customer = job?.customer || "";
    const vehicle = job?.vehicle || "";

    const rows = entries
      .slice()
      .reverse()
      .map((e) => {
        const dur = durationMinutes(e.start_ts, e.end_ts);
        return `
          <tr>
            <td>${e.worker}</td>
            <td>${e.task || ""}</td>
            <td>${toLocal(e.start_ts)}</td>
            <td>${e.end_ts ? toLocal(e.end_ts) : "läuft…"}</td>
            <td style="text-align:right">${dur}</td>
          </tr>
        `;
      })
      .join("");

    w.document.write(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${title} – Rapport</title>
          <style>
            body{font-family:Arial, sans-serif; padding:24px;}
            h1{margin:0 0 8px 0;}
            .meta{color:#444; margin-bottom:16px;}
            table{width:100%; border-collapse:collapse; margin-top:12px;}
            th,td{border:1px solid #ddd; padding:8px; font-size:12px;}
            th{background:#f4f4f4; text-align:left;}
            .totals{margin-top:12px; font-size:13px;}
            .right{text-align:right;}
          </style>
        </head>
        <body>
          <h1>${title}</h1>
          <div class="meta">
            <div><b>Kunde:</b> ${customer || "-"}</div>
            <div><b>Fahrzeug:</b> ${vehicle || "-"}</div>
            <div><b>Kontrollschild:</b> ${plate || "-"}</div>
            <div><b>Status:</b> ${(job?.status || "open") === "done" ? "Abgeschlossen" : "Offen"}</div>
            <div><b>Erstellt:</b> ${job?.created_at ? toLocal(job.created_at) : "-"}</div>
            <div><b>Abgeschlossen:</b> ${job?.closed_at ? toLocal(job.closed_at) : "-"}</div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Tätigkeit</th>
                <th>Start</th>
                <th>Ende</th>
                <th class="right">Min</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="5">Keine Einträge</td></tr>`}
            </tbody>
          </table>

          <div class="totals">
            <b>Total:</b> ${fmtMin(totals.total)}
            <div style="margin-top:6px">
              ${Object.entries(totals.perWorker)
                .map(([w2, m]) => `<div>${w2}: ${fmtMin(m)}</div>`)
                .join("")}
            </div>
          </div>

          <script>
            window.onload = () => window.print();
          </script>
        </body>
      </html>
    `);

    w.document.close();
  }

  async function uploadPhoto(file: File) {
    if (!file) return;
    setPhotoBusy(true);
    setMsg("");

    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const safeExt = ext.replace(/[^a-z0-9]/g, "") || "jpg";
      const fname = `${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(16).slice(2)}.${safeExt}`;
      const path = `${jobId}/${fname}`;

      const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || "image/jpeg",
      });

      if (error) {
        setMsg(`❌ Foto Upload Fehler: ${error.message}`);
        return;
      }

      setMsg("📸 Foto gespeichert");
      await loadPhotos();
    } finally {
      setPhotoBusy(false);
    }
  }

  async function deletePhotoAdmin(p: PhotoItem) {
    const pin = window.prompt("Admin PIN zum Löschen:");
    if (!pin) return;
    if (!isAdminPinOk(pin)) {
      setMsg("❌ Falscher PIN");
      return;
    }

    const { error } = await supabase.storage.from(BUCKET).remove([p.path]);
    if (error) {
      setMsg(`❌ Löschen fehlgeschlagen: ${error.message}`);
      return;
    }
    setMsg("🗑️ Foto gelöscht");
    await loadPhotos();
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 14 }}>
      <a href="/" style={{ textDecoration: "none", color: "inherit", opacity: 0.85 }}>
        ← zurück
      </a>

      {/* Header */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: "rgba(255,255,255,0.08)",
                display: "grid",
                placeItems: "center",
                overflow: "hidden",
              }}
            >
              {/* Logo sichtbar (falls PNG/SVG) */}
              <img src="/logo.png" alt="Pro Automobile" style={{ width: 44, height: 44, objectFit: "contain" }} />
            </div>

            <div style={{ minWidth: 0 }}>
              <div className="h1" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 520 }}>
                  {job?.title || "Auftrag"}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 999,
                    background: done ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)",
                    border: done ? "1px solid rgba(34,197,94,0.35)" : "1px solid rgba(239,68,68,0.35)",
                    color: done ? "#86efac" : "#fecaca",
                  }}
                >
                  {done ? "Abgeschlossen" : "Offen"}
                </span>
              </div>

              <div className="muted" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {subtitle || "—"}
              </div>

              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                {msg ? msg : done ? "Start/Stop gesperrt (Auftrag abgeschlossen)." : "Bereit."}
              </div>
            </div>
          </div>

          {/* QR */}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div style={{ textAlign: "right" }}>
              <div className="muted" style={{ fontSize: 12 }}>
                QR-Link (scannen)
              </div>
              <div className="muted" style={{ fontSize: 11, maxWidth: 220, wordBreak: "break-all", opacity: 0.65 }}>
                {jobLink}
              </div>
            </div>
            <img src={qrUrl} alt="QR" style={{ width: 108, height: 108, borderRadius: 16 }} />
          </div>
        </div>
      </div>

      {/* Start/Stop */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row">
          <div className="h2">Start / Stop</div>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
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

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnPrimary" onClick={start} disabled={!!runningId || done}>
            Start
          </button>
          <button className="btn btnDark" onClick={stop} disabled={!runningId}>
            Stop
          </button>
        </div>

        {/* Buttons Block */}
        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn btnDanger" onClick={closeJob} disabled={done}>
            Auftrag abschliessen ✅
          </button>
          <button className="btn" onClick={exportCsvBetter}>
            CSV Rapport (Excel sauber)
          </button>
        </div>

        <div className="grid2" style={{ marginTop: 10 }}>
          <button className="btn" onClick={reopenJobAdmin} disabled={!done}>
            🔓 Auftrag entsperren (Admin PIN)
          </button>
          <button className="btn" onClick={exportPdfAdmin}>
            🧾 PDF Rapport (Admin PIN)
          </button>
        </div>
      </div>

      {/* Fotos */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div className="h2">Fotos (Schäden)</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Foto machen / hochladen → wird beim Auftrag gespeichert.
            </div>
          </div>

          <label
            className="btn"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              cursor: photoBusy ? "not-allowed" : "pointer",
              opacity: photoBusy ? 0.7 : 1,
            }}
          >
            📸 Foto hinzufügen
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              disabled={photoBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPhoto(f);
                // reset input
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>

        {photos.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>
            Noch keine Fotos.
          </div>
        ) : (
          <div
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: 12,
            }}
          >
            {photos.map((p) => (
              <div
                key={p.path}
                style={{
                  borderRadius: 16,
                  overflow: "hidden",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <a href={p.signedUrl || "#"} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                  <img
                    src={p.signedUrl || ""}
                    alt={p.name}
                    style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }}
                  />
                </a>
                <div style={{ padding: 10, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <div className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </div>
                  <button className="btn" style={{ padding: "8px 10px" }} onClick={() => deletePhotoAdmin(p)}>
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rapport */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div className="h2">Rapport</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              <b>Total:</b> {fmtMin(totals.total)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {Object.entries(totals.perWorker).map(([w, m]) => (
                <div key={w}>
                  {w}: {fmtMin(m)}
                </div>
              ))}
            </div>
          </div>

          <button className="btn" onClick={loadJobAndEntries}>
            Aktualisieren
          </button>
        </div>

        <div style={{ marginTop: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 10, opacity: 0.7 }}>Mitarbeiter</th>
                <th style={{ textAlign: "left", padding: 10, opacity: 0.7 }}>Tätigkeit</th>
                <th style={{ textAlign: "left", padding: 10, opacity: 0.7 }}>Start</th>
                <th style={{ textAlign: "left", padding: 10, opacity: 0.7 }}>Ende</th>
                <th style={{ textAlign: "right", padding: 10, opacity: 0.7 }}>Min</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 10, opacity: 0.7 }}>
                    Keine Einträge
                  </td>
                </tr>
              ) : (
                entries.map((e) => (
                  <tr key={e.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={{ padding: 10 }}>{e.worker}</td>
                    <td style={{ padding: 10 }}>{e.task || ""}</td>
                    <td style={{ padding: 10 }}>{toLocal(e.start_ts)}</td>
                    <td style={{ padding: 10 }}>{e.end_ts ? toLocal(e.end_ts) : <b>läuft…</b>}</td>
                    <td style={{ padding: 10, textAlign: "right" }}>{durationMinutes(e.start_ts, e.end_ts)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="muted" style={{ marginTop: 12, fontSize: 12, opacity: 0.75 }}>
          Tipp: Auf Samsung Chrome → ⋮ → <b>„Zum Startbildschirm“</b> (App installieren). <br />
          Auf iPhone Safari → <b>Teilen</b> → <b>„Zum Home-Bildschirm“</b>.
        </div>
      </div>
    </div>
  );
}
