// netlify/functions/flodesk.js
//
// Receives the quiz result, creates/updates the subscriber in Flodesk,
// and adds her to the segment for her saboteur (segments are what trigger
// your Flodesk emails). The API key lives in Netlify env vars, never here.
//
// SETUP (once):
//   1. Netlify (THIS site) > Site configuration > Environment variables >
//      add  FLODESK_API_KEY  = your Flodesk API key.  Then redeploy.
//   2. Flodesk > create a segment for each saboteur, named exactly:
//         Saboteur Quiz – Numbing Out
//         Saboteur Quiz – Distractor
//         Saboteur Quiz – Defeatist
//         Saboteur Quiz – Rebel
//         Saboteur Quiz – Inner Mean Girl
//         Saboteur Quiz – Avoider
//   3. (Optional) Flodesk > create custom fields  saboteur, pathway,
//      second_saboteur, top_score  to store the extra data. If they don't
//      exist the subscriber is STILL saved — the fields are just skipped.

const FLODESK_API = "https://api.flodesk.com/v1";

let segmentCache = null; // cached for the life of the function instance

function authHeader() {
  const key = process.env.FLODESK_API_KEY;
  if (!key) throw new Error("FLODESK_API_KEY is not set in Netlify env vars");
  return "Basic " + Buffer.from(key + ":").toString("base64"); // Flodesk = API key as username
}

async function getSegments() {
  if (segmentCache) return segmentCache;
  const res = await fetch(`${FLODESK_API}/segments?per_page=100`, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`segments lookup failed: ${res.status}`);
  const json = await res.json();
  const list = json.data || [];
  segmentCache = {};
  for (const s of list) segmentCache[s.name.trim()] = s.id;
  return segmentCache;
}

// Tolerates dash/whitespace differences so "Saboteur Quiz – Rebel" (en dash)
// still matches "Saboteur Quiz - Rebel" (hyphen).
function findSegmentId(segments, wanted) {
  const norm = (s) => s.toLowerCase().replace(/[\u2013\u2014-]/g, "-").replace(/\s+/g, " ").trim();
  const target = norm(wanted);
  for (const [name, id] of Object.entries(segments)) {
    if (norm(name) === target) return id;
  }
  return null;
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "Method not allowed" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { email, first_name, saboteur, segment, pathway, second_saboteur, top_score } = body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Valid email required" }) };
  }

  try {
    // Resolve the saboteur's segment id by name.
    let segmentId = null;
    if (segment) {
      try {
        const segs = await getSegments();
        segmentId = findSegmentId(segs, segment);
        if (!segmentId) console.error(`No Flodesk segment matching "${segment}". Known:`, Object.keys(segs));
      } catch (e) { console.error("segment lookup error:", e.message); }
    }

    const base = {
      email,
      ...(first_name ? { first_name } : {}),
      ...(segmentId ? { segment_ids: [segmentId] } : {}),
    };

    const postSubscriber = (payload) => fetch(`${FLODESK_API}/subscribers`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Try WITH custom fields. If Flodesk rejects them (a field not created
    // yet), retry WITHOUT them so the subscriber + segment are never lost.
    let res = await postSubscriber({
      ...base,
      custom_fields: {
        saboteur: saboteur || "",
        pathway: pathway || "",
        second_saboteur: second_saboteur || "",
        top_score: top_score || "",
      },
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("create failed, retrying without custom fields:", res.status, detail);
      res = await postSubscriber(base);
    }

    if (!res.ok) {
      const detail = await res.text();
      console.error("subscriber create failed (final):", res.status, detail);
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Subscriber create failed", detail }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("flodesk function error:", err.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
