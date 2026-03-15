import { useState, useRef, useCallback, useEffect } from "react";

/* ─── CONSTANTS ─────────────────────────────────────────────────────────────── */
const PIPELINE_STEPS = [
  { id: "parse", icon: "⬡", label: "Document Parsing", desc: "Extracting text & images from both PDFs" },
  { id: "extract", icon: "◈", label: "Observation Extraction", desc: "AI identifies structured findings" },
  { id: "map", icon: "◎", label: "Image Mapping", desc: "Matching images to observations" },
  { id: "reason", icon: "⬟", label: "Cross-Doc Reasoning", desc: "Merging inspection + thermal findings" },
  { id: "validate", icon: "◇", label: "Validation Layer", desc: "Detecting conflicts & missing data" },
  { id: "generate", icon: "★", label: "DDR Generation", desc: "Generating client-ready report" },
];

const SEV = {
  Critical: { bg: "#fef2f2", text: "#991b1b", dot: "#ef4444", bar: "#ef4444" },
  High: { bg: "#fff7ed", text: "#9a3412", dot: "#f97316", bar: "#f97316" },
  Medium: { bg: "#fefce8", text: "#92400e", dot: "#eab308", bar: "#eab308" },
  Low: { bg: "#f0fdf4", text: "#166534", dot: "#22c55e", bar: "#22c55e" },
};

/* ─── PDF PARSER ─────────────────────────────────────────────────────────────── */
async function parsePDF(file) {
  if (typeof window.pdfjsLib === "undefined") {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        res();
      };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const pdf = await window.pdfjsLib.getDocument({ data: e.target.result }).promise;
        let fullText = "";
        const pages = [];
        const images = [];
        let imgIdx = 0;

        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          const txt = tc.items.map((i) => i.str).join(" ");
          fullText += `\n[Page ${p}]\n${txt}`;
          pages.push({ page: p, text: txt });

          const vp = page.getViewport({ scale: 1.4 });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width;
          canvas.height = vp.height;
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, viewport: vp }).promise;

          const ops = await page.getOperatorList();
          const hasImg = ops.fnArray.some(
            (fn) =>
              fn === window.pdfjsLib.OPS.paintImageXObject ||
              fn === window.pdfjsLib.OPS.paintInlineImageXObject
          );

          if (hasImg) {
            imgIdx++;
            images.push({
              image_id: `img${imgIdx}`,
              page: p,
              base64: canvas.toDataURL("image/jpeg", 0.72),
              context: txt.slice(0, 300),
            });
          }
        }
        resolve({ text: fullText, pages, images, numPages: pdf.numPages });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* ─── AI HELPERS ─────────────────────────────────────────────────────────────── */
async function claude(apiKey, system, user, maxTokens = 4096) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error?.message || `API ${r.status}`);
  }
  const d = await r.json();
  return d.content[0].text;
}

function parseJSON(raw) {
  const c = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const a = c.indexOf("{"), b = c.indexOf("[");
  let start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
  if (start === -1) throw new Error("No JSON");
  const sub = c.slice(start);
  const open = sub[0], close = open === "{" ? "}" : "]";
  let depth = 0, end = -1;
  for (let i = 0; i < sub.length; i++) {
    if (sub[i] === open) depth++;
    else if (sub[i] === close && --depth === 0) { end = i; break; }
  }
  return JSON.parse(end !== -1 ? sub.slice(0, end + 1) : sub);
}

/* ─── PIPELINE STAGES ────────────────────────────────────────────────────────── */
async function stepExtract(apiKey, iText, tText) {
  const raw = await claude(
    apiKey,
    "You are a property inspection analyst. Return ONLY valid JSON array, no markdown.",
    `Extract all structured observations from these two reports.

INSPECTION REPORT:
${iText.slice(0, 5500)}

THERMAL REPORT:
${tText.slice(0, 3500)}

Return JSON array, each item:
{"observation_id":"obs1","area":"","issue_description":"","temperature_reading":"Not Available","evidence":"","source":"inspection|thermal|both","page_reference":"","severity":"Critical|High|Medium|Low","severity_reasoning":""}

Rules: only extract facts present in the text. Use "Not Available" for missing data. Extract 5–15 observations.`
  );
  return parseJSON(raw);
}

async function stepMapImages(apiKey, observations, iImgs, tImgs) {
  const allImgs = [...iImgs, ...tImgs];
  if (!allImgs.length) return observations.map((o) => ({ ...o, images: [] }));
  const imgInfo = allImgs.map((img) => ({ id: img.image_id, page: img.page, source: img.source || "unknown", ctx: img.context?.slice(0, 120) }));
  const raw = await claude(
    apiKey,
    "You are mapping PDF images to observations. Return ONLY valid JSON array.",
    `Match images to observations by page proximity and context.

OBSERVATIONS:
${JSON.stringify(observations.map((o) => ({ id: o.observation_id, area: o.area, page: o.page_reference, src: o.source })))}

IMAGES:
${JSON.stringify(imgInfo)}

Return: [{"observation_id":"obs1","image_ids":["img1"]}]
Use empty array if no match.`,
    2048
  );
  const mappings = parseJSON(raw);
  const imgMap = Object.fromEntries(allImgs.map((i) => [i.image_id, i]));
  return observations.map((obs) => {
    const m = mappings.find((x) => x.observation_id === obs.observation_id);
    return { ...obs, images: (m?.image_ids || []).map((id) => imgMap[id]).filter(Boolean) };
  });
}

async function stepReason(apiKey, observations) {
  const raw = await claude(
    apiKey,
    "You are a property diagnostic expert. Merge and analyse findings. Return ONLY valid JSON array.",
    `Merge these observations into comprehensive cross-referenced findings.

${JSON.stringify(observations.map((o) => ({ id: o.observation_id, area: o.area, issue: o.issue_description, temp: o.temperature_reading, evidence: o.evidence, source: o.source, severity: o.severity })))}

Return JSON array:
[{"merged_id":"m1","area":"","combined_issue":"","inspection_evidence":"","thermal_evidence":"","temperature_reading":"Not Available","severity":"Critical|High|Medium|Low","severity_reasoning":"","source_ids":[],"probable_root_cause":"","recommended_action":""}]

Merge same-area observations, remove duplicates, keep all evidence.`
  );
  return parseJSON(raw);
}

async function stepValidate(apiKey, merged) {
  const raw = await claude(
    apiKey,
    "You are a validation expert. Return ONLY valid JSON.",
    `Validate these merged findings for conflicts and gaps.

${JSON.stringify(merged)}

Return:
{"conflicts":[{"id":"m1","area":"","description":"","inspection_says":"","thermal_says":""}],"missing_info":[{"id":"m1","area":"","missing":[],"impact":""}],"quality_score":75,"notes":""}`,
    2048
  );
  return parseJSON(raw);
}

async function stepGenerateDDR(apiKey, merged, validation) {
  const raw = await claude(
    apiKey,
    "You are a professional property diagnostic report writer. Generate comprehensive reports. Return ONLY valid JSON.",
    `Generate a full Detailed Diagnostic Report from this data.

MERGED FINDINGS:
${JSON.stringify(merged)}

VALIDATION:
${JSON.stringify(validation)}

Return JSON:
{
  "property_issue_summary":"2-3 paragraphs for client",
  "overall_severity":"Critical|High|Medium|Low",
  "total_issues":0,
  "critical_count":0,"high_count":0,"medium_count":0,"low_count":0,
  "area_observations":[{"merged_id":"","area":"","combined_issue":"","inspection_evidence":"","thermal_evidence":"","temperature_reading":"","severity":"","severity_reasoning":"","probable_root_cause":"","recommended_action":"","source_ids":[]}],
  "root_causes":[""],
  "severity_assessment":"paragraph",
  "recommended_actions":[""],
  "additional_notes":"",
  "missing_information":[""],
  "report_date":"${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}"
}`,
    6000
  );
  return parseJSON(raw);
}

/* ─── SMALL COMPONENTS ───────────────────────────────────────────────────────── */
function Badge({ label, color = "#6b7280" }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 9px", borderRadius: 99,
      fontSize: 11, fontWeight: 600, letterSpacing: .4,
      background: color + "22", color, border: `1px solid ${color}44`,
    }}>{label}</span>
  );
}

function SevBadge({ sev }) {
  const s = SEV[sev] || SEV.Medium;
  return <Badge label={sev || "Unknown"} color={s.dot} />;
}

function SourceBadge({ src }) {
  const map = { inspection: "#2563eb", thermal: "#7c3aed", both: "#d97706" };
  return <Badge label={src || "N/A"} color={map[src] || "#6b7280"} />;
}

function Pill({ children, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 16px", borderRadius: 99, border: "none", cursor: "pointer",
      fontSize: 13, fontWeight: 500, transition: "all .15s",
      background: active ? "#1c1917" : "transparent",
      color: active ? "#fff" : "#78716c",
    }}>{children}</button>
  );
}

function StatCard({ value, label, color = "#1c1917" }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14,
      padding: "20px 24px",
    }}>
      <div style={{ fontSize: 36, fontWeight: 700, fontFamily: "'Playfair Display',serif", color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: "#a8a29e", marginTop: 6 }}>{label}</div>
    </div>
  );
}

function SevBar({ label, count, total, color }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4, color: "#44403c" }}>
        <span>{label}</span><span style={{ fontWeight: 600, color }}>{count}</span>
      </div>
      <div style={{ height: 6, background: "#f5f5f4", borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 99, transition: "width .8s ease" }} />
      </div>
    </div>
  );
}

function UploadZone({ label, subtitle, file, onFile, icon }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div
      onClick={() => ref.current.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f?.type === "application/pdf") onFile(f);
      }}
      style={{
        border: `2px dashed ${file ? "#16a34a" : drag ? "#d97706" : "#d6d3d1"}`,
        borderRadius: 16, padding: "36px 24px", textAlign: "center",
        cursor: "pointer", transition: "all .2s",
        background: file ? "#f0fdf4" : drag ? "#fffbeb" : "#fafaf9",
      }}
    >
      <input ref={ref} type="file" accept=".pdf" style={{ display: "none" }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: 28, marginBottom: 10 }}>{file ? "✓" : icon}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: "#1c1917", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, color: "#78716c" }}>{subtitle}</div>
      {file && (
        <div style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 6, background: "#16a34a", color: "#fff", padding: "5px 14px", borderRadius: 99, fontSize: 12, fontWeight: 600 }}>
          {file.name.slice(0, 32)}{file.name.length > 32 ? "…" : ""}
        </div>
      )}
    </div>
  );
}

function PipelineTrack({ steps, status }) {
  return (
    <div style={{ border: "1px solid #e7e5e4", borderRadius: 16, overflow: "hidden", background: "#fff" }}>
      {PIPELINE_STEPS.map((step, i) => {
        const s = status[step.id];
        const isActive = s === "active";
        const isDone = s === "done";
        const isErr = s === "error";
        return (
          <div key={step.id} style={{
            display: "flex", alignItems: "center", gap: 16, padding: "16px 24px",
            borderBottom: i < PIPELINE_STEPS.length - 1 ? "1px solid #f5f5f4" : "none",
            background: isActive ? "#fffbeb" : isDone ? "#f0fdf4" : isErr ? "#fef2f2" : "transparent",
            transition: "background .3s",
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: isDone || isErr ? 16 : 14, fontWeight: 700,
              background: isDone ? "#16a34a" : isErr ? "#dc2626" : isActive ? "#d97706" : "#f5f5f4",
              color: isDone || isErr || isActive ? "#fff" : "#a8a29e",
              animation: isActive ? "spin .9s linear infinite" : "none",
            }}>
              {isDone ? "✓" : isErr ? "✗" : isActive ? "◌" : step.icon}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#1c1917" }}>{step.label}</div>
              <div style={{ fontSize: 12, color: "#78716c", marginTop: 1 }}>{step.desc}</div>
              {isActive && (
                <div style={{ marginTop: 8, height: 3, background: "#fde68a", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: "60%", height: "100%", background: "#d97706", borderRadius: 99, animation: "progress 1.4s ease-in-out infinite" }} />
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, color: isDone ? "#16a34a" : isErr ? "#dc2626" : isActive ? "#d97706" : "#a8a29e" }}>
              {isDone ? "Complete" : isErr ? "Error" : isActive ? "Running…" : "Waiting"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ImageThumb({ src, page }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        onClick={() => setOpen(true)}
        style={{ width: 110, height: 80, borderRadius: 8, overflow: "hidden", border: "1px solid #e7e5e4", cursor: "zoom-in", flexShrink: 0, position: "relative" }}
      >
        <img src={src} alt={`p.${page}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div style={{ position: "absolute", bottom: 2, right: 4, fontSize: 9, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,.5)", borderRadius: 4, padding: "1px 4px" }}>p.{page}</div>
      </div>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <img src={src} alt="full" style={{ maxWidth: "88vw", maxHeight: "88vh", borderRadius: 12 }} />
        </div>
      )}
    </>
  );
}

function ObsCard({ obs, allImages }) {
  const [open, setOpen] = useState(false);
  const sev = SEV[obs.severity] || SEV.Medium;

  const imgs = (obs.resolvedImages || obs.images || allImages || []).slice(0,6);

  return (
    <div style={{ border: "1px solid #e7e5e4", borderRadius: 14, overflow: "hidden", marginBottom: 14, background: "#fff" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ padding: "14px 20px", background: "#fafaf9", borderBottom: "1px solid #f5f5f4", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: sev.dot, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: "#1c1917" }}>
            {obs.area}
            {obs.flat_number && ` – ${obs.flat_number}`}
          </span>       <SourceBadge src={obs.source || "both"} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SevBadge sev={obs.severity} />
          <span style={{ color: "#a8a29e", fontSize: 16 }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "18px 20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14 }}>
            {[
              ["Issue", obs.combined_issue || obs.issue_description],
              ["Temperature", obs.temperature_reading || "Not Available"],
              ["Inspection Evidence", obs.inspection_evidence || obs.evidence || "Not Available"],
              ["Thermal Evidence", obs.thermal_evidence || "Not Available"],
            ].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#a8a29e", marginBottom: 3 }}>{k}</div>
                <div style={{ fontSize: 13, color: "#44403c", lineHeight: 1.6 }}>{v}</div>
              </div>
            ))}
          </div>

          {obs.severity_reasoning && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#a8a29e", marginBottom: 3 }}>Severity Reasoning</div>
              <div style={{ fontSize: 13, color: "#78716c" }}>{obs.severity_reasoning}</div>
            </div>
          )}

          {obs.probable_root_cause && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#a8a29e", marginBottom: 3 }}>Root Cause</div>
              <div style={{ fontSize: 13, color: "#44403c" }}>{obs.probable_root_cause}</div>
            </div>
          )}

          {obs.recommended_action && (
            <div style={{ marginBottom: 14, padding: "10px 14px", background: "#fff7ed", borderRadius: 8, borderLeft: "3px solid #d97706" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#d97706", marginBottom: 3 }}>Recommended Action</div>
              <div style={{ fontSize: 13, color: "#1c1917" }}>{obs.recommended_action}</div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#a8a29e", marginBottom: 8 }}>Evidence Images</div>
            {imgs.length > 0 ? (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px,1fr))",
                gap: 10
              }}>
              {imgs.map((img, i) => (
  <div key={i} style={{ textAlign: "center" }}>
    <ImageThumb
      src={`http://localhost:5000/api/ddr/image/${img.id}`}
      page={img.page}
    />

                    <div style={{
                      fontSize: 10,
                      color: "#78716c",
                      marginTop: 4
                    }}>
                     Photo {img.id || i + 1}
                    </div>
                  </div>
                ))}

              </div>
            ) : (
              <div style={{ width: 110, height: 80, background: "#f5f5f4", border: "1px dashed #d6d3d1", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 18, color: "#a8a29e" }}>🖼</span>
                <span style={{ fontSize: 9, color: "#a8a29e", fontWeight: 600 }}>Not Available</span>
              </div>
            )}
            {/* ✅ ADD HERE */}
            {obs.page_reference && (
              <div style={{
                fontSize: 11,
                color: "#a8a29e",
                marginTop: 6
              }}>
                Source Page: {obs.page_reference}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── PAGES ──────────────────────────────────────────────────────────────────── */
function DashboardPage({ report, onNav }) {
  if (!report) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "70vh", gap: 16 }}>
      <div style={{ fontSize: 64 }}>🏗</div>
      <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 28, color: "#1c1917" }}>No Report Yet</div>
      <div style={{ fontSize: 14, color: "#78716c", marginBottom: 8 }}>Upload your inspection and thermal PDFs to begin</div>
      <button onClick={() => onNav("upload")} style={{ padding: "12px 28px", background: "#1c1917", color: "#fff", border: "none", borderRadius: 99, fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
        Upload Reports →
      </button>
    </div>
  );

  const ddr = report?.ddr || {};
const validation = report?.validation || {};
const allImages = report?.allImages || [];
const total = ddr?.total_issues || ddr?.area_observations?.length || 0;
  return (
    <div>
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 30, color: "#1c1917", marginBottom: 4 }}>Diagnostic Overview</div>
        <div style={{ fontSize: 13, color: "#78716c" }}>Generated {ddr.report_date} · <span style={{ fontWeight: 600, color: SEV[ddr.overall_severity]?.dot }}>{ddr.overall_severity} Severity</span></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 28 }}>
        <StatCard value={total} label="Total Issues" />
        <StatCard value={ddr.critical_count || 0} label="Critical" color="#ef4444" />
        <StatCard value={ddr.high_count || 0} label="High Priority" color="#f97316" />
        <StatCard value={ddr.recommended_actions?.length || 0} label="Actions" color="#16a34a" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
        <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 16, color: "#1c1917" }}>Severity Distribution</div>
          {["Critical", "High", "Medium", "Low"].map((s) => (
            <SevBar key={s} label={s} count={ddr[`${s.toLowerCase()}_count`] || 0} total={total || 1} color={SEV[s]?.bar} />
          ))}
        </div>

        <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: "#1c1917" }}>Data Quality</div>
          {validation?.quality_score !== undefined && (
            <>
              <div style={{ fontSize: 48, fontFamily: "'Playfair Display',serif", color: "#1c1917", lineHeight: 1 }}>{validation.quality_score}<span style={{ fontSize: 18, color: "#a8a29e" }}>%</span></div>
              <div style={{ fontSize: 12, color: "#78716c", marginTop: 4, marginBottom: 16 }}>Overall data quality score</div>
              <div style={{ height: 6, background: "#f5f5f4", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ width: `${validation.quality_score}%`, height: "100%", background: validation.quality_score > 70 ? "#16a34a" : "#d97706", borderRadius: 99 }} />
              </div>
            </>
          )}
          <div style={{ marginTop: 16, fontSize: 12, color: "#78716c" }}>
            <span style={{ fontWeight: 600, color: "#dc2626" }}>{validation?.conflicts?.length || 0}</span> conflicts · <span style={{ fontWeight: 600, color: "#d97706" }}>{validation?.missing_info?.length || 0}</span> gaps detected
          </div>
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: "#1c1917" }}>Executive Summary</div>
        <p style={{ fontSize: 14, lineHeight: 1.8, color: "#57534e", margin: 0 }}>{ddr.property_issue_summary}</p>
        <button onClick={() => onNav("report")} style={{ marginTop: 16, padding: "10px 22px", background: "#1c1917", color: "#fff", border: "none", borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          View Full Report →
        </button>
      </div>
    </div>
  );
}

function UploadPage({ onProcess, processing }) {

  const [iFile, setIFile] = useState(null);
  const [tFile, setTFile] = useState(null);

  const canRun = iFile && tFile && !processing;

  return (
    <div>

      <div style={{ marginBottom: 32 }}>
        <div style={{
          fontFamily: "'Playfair Display',serif",
          fontSize: 30,
          color: "#1c1917",
          marginBottom: 4
        }}>
          Upload Reports
        </div>

        <div style={{ fontSize: 13, color: "#78716c" }}>
          Upload both PDFs to run the full diagnostic pipeline
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 20,
        marginBottom: 24
      }}>

        <div>
          <div style={{
            fontWeight: 600,
            fontSize: 13,
            color: "#44403c",
            marginBottom: 8
          }}>
            Inspection Report
          </div>

          <UploadZone
            label="Drop Inspection PDF"
            subtitle="Drag & drop or click to browse"
            file={iFile}
            onFile={setIFile}
            icon="🔍"
          />
        </div>

        <div>
          <div style={{
            fontWeight: 600,
            fontSize: 13,
            color: "#44403c",
            marginBottom: 8
          }}>
            Thermal Imaging Report
          </div>

          <UploadZone
            label="Drop Thermal PDF"
            subtitle="Drag & drop or click to browse"
            file={tFile}
            onFile={setTFile}
            icon="🌡"
          />
        </div>

      </div>

      <button
        disabled={!canRun}
        onClick={() => onProcess(iFile, tFile)}
        style={{
          padding: "14px 32px",
          background: canRun ? "#1c1917" : "#d6d3d1",
          color: "#fff",
          border: "none",
          borderRadius: 99,
          fontWeight: 700,
          fontSize: 15,
          cursor: canRun ? "pointer" : "not-allowed",
          transition: "background .2s"
        }}
      >
        {processing ? "⏳ Processing…" : "⚡ Run Analysis Pipeline"}
      </button>

      {!canRun && !processing && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#a8a29e" }}>
          {!iFile ? "Upload the inspection report" : "Upload the thermal report"}
        </div>
      )}

    </div>
  );
}

function ProcessingPage({ pipeStatus, log, error }) {
  const logRef = useRef();
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 30, color: "#1c1917", marginBottom: 4 }}>Analysis Pipeline</div>
        <div style={{ fontSize: 13, color: "#78716c" }}>Processing your documents through 6 AI stages</div>
      </div>

      <PipelineTrack steps={PIPELINE_STEPS} status={pipeStatus} />

      {error && (
        <div style={{ marginTop: 16, padding: "14px 18px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, fontSize: 13, color: "#991b1b" }}>
          <strong>Pipeline Error:</strong> {error}
        </div>
      )}

      {log.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 12, letterSpacing: .8, textTransform: "uppercase", color: "#a8a29e", marginBottom: 8 }}>Processing Log</div>
          <div
            ref={logRef}
            style={{ background: "#1c1917", borderRadius: 10, padding: "14px 16px", maxHeight: 200, overflowY: "auto", fontFamily: "monospace", fontSize: 12, lineHeight: 1.8, color: "#d6d3d1" }}
          >
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportPage({ report, onNav }) {
  const [tab, setTab] = useState("report");

  if (!report) return (
    <div style={{ textAlign: "center", padding: "80px 24px" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
      <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, marginBottom: 8 }}>No Report Available</div>
      <button onClick={() => onNav("upload")} style={{ padding: "10px 22px", background: "#1c1917", color: "#fff", border: "none", borderRadius: 99, fontWeight: 600, cursor: "pointer" }}>Upload Reports</button>
    </div>
  );

  const { ddr = {}, validation = {}, allImages = [] } = report || {};

  const imgMap = {};
  (allImages || []).forEach((img) => { imgMap[img.image_id] = img; });

  const obsWithImgs = (ddr?.area_observations || []).map((obs) => ({
    ...obs,
    resolvedImages: obs.images || []
  }));

  const tabs = [
    { id: "report", label: "Full Report" },
    { id: "obs", label: `Observations (${obsWithImgs.length})` },
    { id: "actions", label: "Actions" },
    { id: "issues", label: "Conflicts & Gaps" },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 30, color: "#1c1917", marginBottom: 4 }}>Detailed Diagnostic Report</div>
          <div style={{ fontSize: 13, color: "#78716c" }}>{ddr.report_date} · <SevBadge sev={ddr.overall_severity} /></div>
        </div>
        <button onClick={() => window.print()} style={{ padding: "9px 20px", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#44403c" }}>🖨 Print</button>
      </div>

      <div style={{ display: "flex", gap: 4, background: "#f5f5f4", padding: 4, borderRadius: 99, width: "fit-content", marginBottom: 28 }}>
        {tabs.map((t) => <Pill key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Pill>)}
      </div>

      {/* ── FULL REPORT / SUMMARY ── */}
      {(tab === "report" || tab === "obs") && (
        <>
          {tab === "report" && (
            <section style={{ marginBottom: 36 }}>
              <SectionHead num={1} title="Property Issue Summary" />
              <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: 24 }}>
                <p style={{ fontSize: 14, lineHeight: 1.85, color: "#57534e", margin: 0 }}>{ddr.property_issue_summary}</p>
              </div>
            </section>
          )}

          <section style={{ marginBottom: 36 }}>
            <SectionHead num={tab === "report" ? 2 : 1} title="Area-wise Observations" />
            {obsWithImgs.length === 0
              ? <div style={{ padding: 20, color: "#78716c", fontSize: 14 }}>No observations found.</div>
              : obsWithImgs.map((obs, i) => <ObsCard key={i} obs={obs} allImages={allImages} />)
            }
          </section>
        </>
      )}

      {/* ── ACTIONS ── */}
      {(tab === "report" || tab === "actions") && (
        <>
          {tab === "report" && (
            <section style={{ marginBottom: 36 }}>
              <SectionHead num={3} title="Probable Root Causes" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(ddr.root_causes || []).map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 16px", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10, fontSize: 14 }}>
                    <span style={{ color: "#d97706", fontWeight: 700 }}>→</span>
                    <span style={{ color: "#44403c" }}>{c}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tab === "report" && (
            <section style={{ marginBottom: 36 }}>
              <SectionHead num={4} title="Severity Assessment" />
              <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: 24 }}>
                <p style={{ fontSize: 14, lineHeight: 1.85, color: "#57534e", margin: 0 }}>{ddr.severity_assessment}</p>
              </div>
            </section>
          )}

          <section style={{ marginBottom: 36 }}>
            <SectionHead num={tab === "report" ? 5 : 1} title="Recommended Actions" />
            <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {(Array.isArray(ddr.recommended_actions) ? ddr.recommended_actions : []).map((a, i) => (
                <li key={i} style={{ display: "flex", gap: 14, padding: "12px 16px", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10, marginBottom: 8, fontSize: 14, color: "#44403c", alignItems: "flex-start" }}>
                  <span style={{ width: 24, height: 24, background: "#d97706", color: "#fff", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                  {a}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      {/* ── ISSUES ── */}
      {(tab === "report" || tab === "issues") && (
        <>
          {tab === "report" && ddr.additional_notes && (
            <section style={{ marginBottom: 36 }}>
              <SectionHead num={6} title="Additional Notes" />
              <div style={{ background: "#fff", border: "1px solid #e7e5e4", borderRadius: 14, padding: 24 }}>
                <p style={{ fontSize: 14, lineHeight: 1.8, color: "#78716c", margin: 0 }}>{ddr.additional_notes}</p>
              </div>
            </section>
          )}

          <section style={{ marginBottom: 36 }}>
            <SectionHead num={tab === "report" ? 7 : 1} title="Missing or Unclear Information" />
            {(ddr.missing_information || []).length === 0
              ? <div style={{ padding: "12px 16px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 13, color: "#166534" }}>✓ No significant missing information detected.</div>
              : <div style={{ padding: "14px 18px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: "#92400e", marginBottom: 8, textTransform: "uppercase", letterSpacing: .8 }}>⚠ Missing Information</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {(ddr?.missing_information || []).map((m, i) => <li key={i} style={{ fontSize: 13, color: "#78350f", marginBottom: 4 }}>{m}</li>)}
                </ul>
              </div>
            }

            {validation?.conflicts?.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#1c1917", marginBottom: 10 }}>⚡ Detected Conflicts</div>
                {validation.conflicts.map((c, i) => (
                  <div key={i} style={{ padding: "14px 16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#991b1b", marginBottom: 4 }}>{c.area}</div>
                    <div style={{ fontSize: 13, color: "#7f1d1d", marginBottom: 6 }}>{c.description || c.conflict_description}</div>
                    {c.inspection_says && <div style={{ fontSize: 12, color: "#991b1b" }}><strong>Inspection:</strong> {c.inspection_says}</div>}
                    {c.thermal_says && <div style={{ fontSize: 12, color: "#991b1b" }}><strong>Thermal:</strong> {c.thermal_says}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SectionHead({ num, title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, paddingBottom: 12, borderBottom: "2px solid #e7e5e4" }}>
      <div style={{ width: 28, height: 28, background: "#1c1917", color: "#fff", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{num}</div>
      <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, color: "#1c1917" }}>{title}</div>
    </div>
  );
}

/* ─── APP ────────────────────────────────────────────────────────────────────── */
export default function App() {
  const [page, setPage] = useState("dashboard");
  //const [apiKey, setApiKey] = useState("");
  const [report, setReport] = useState(null);
  const [pipeStatus, setPipeStatus] = useState({});
  const [pipeLog, setPipeLog] = useState([]);
  const [pipeError, setPipeError] = useState(null);
  const [processing, setProcessing] = useState(false);

  const log = useCallback((msg) => setPipeLog((p) => [...p, `[${new Date().toLocaleTimeString()}] ${msg}`]), []);
  const setStep = useCallback((id, s) => setPipeStatus((p) => ({ ...p, [id]: s })), []);
  const markError = useCallback((id) => setPipeStatus((p) => {
    const n = { ...p };
    Object.keys(n).forEach((k) => { if (n[k] === "active") n[k] = "error"; });
    n[id] = "error";
    return n;
  }), []);

  const runPipeline = useCallback(async (iFile, tFile) => {

    setProcessing(true);
    setPage("processing");
    setPipeStatus({});
    setPipeLog([]);
    setPipeError(null);

    try {

      setStep("parse", "active");
      log("Uploading PDFs to backend...");

      const formData = new FormData();
      formData.append("inspection", iFile);
      formData.append("thermal", tFile);

      const response = await fetch("http://localhost:5000/api/ddr/process", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error("Backend processing failed");
      }

      const data = await response.json();

      setStep("parse", "done");
      setStep("extract", "done");
      setStep("map", "done");
      setStep("reason", "done");
      setStep("validate", "done");
      setStep("generate", "done");

      setReport({
        ddr: data.report || data.ddr,
        validation: data.validation,
        allImages: data.images || []
      });

      log("DDR report generated successfully");

      setTimeout(() => {
        setPage("report");
        setProcessing(false);
      }, 800);

    } catch (err) {

      const msg = err.message || "Unknown error";
      setPipeError(msg);
      log(`ERROR: ${msg}`);
      markError("");
      setProcessing(false);

    }

  }, [log, setStep, markError]);


  const NAV = [
    { id: "dashboard", icon: "⊞", label: "Dashboard" },
    { id: "upload", icon: "↑", label: "Upload" },
    { id: "processing", icon: "⟳", label: "Processing" },
    { id: "report", icon: "📄", label: "DDR Report" },
  ];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Lato:wght@300;400;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Lato', sans-serif; background: #f5f5f4; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes progress {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(0); }
          100% { transform: translateX(100%); }
        }
        @media print {
          .no-print { display: none !important; }
          .sidebar { display: none !important; }
        }
      `}</style>

      <div style={{ display: "flex", minHeight: "100vh" }}>

        {/* SIDEBAR */}
        <div className="sidebar no-print">
          ...
        </div>

        {/* MAIN */}
        <div style={{ flex: 1 }}>
          <div style={{ maxWidth: 960, margin: "0 auto", padding: "40px 40px" }}>

            {page === "dashboard" && (
              <DashboardPage report={report} onNav={setPage} />
            )}

            {page === "upload" && (
              <UploadPage onProcess={runPipeline} processing={processing} />
            )}

            {page === "processing" && (
              <ProcessingPage
                pipeStatus={pipeStatus}
                log={pipeLog}
                error={pipeError}
              />
            )}

            {page === "report" && (
              <ReportPage report={report} onNav={setPage} />
            )}

          </div>
        </div>

      </div>

    </>
  );
}