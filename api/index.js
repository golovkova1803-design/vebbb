const SOUNDCLOUD_HOME = "https://soundcloud.com/";
const API_V2_BASE = "https://api-v2.soundcloud.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let cachedClientId = null;

async function getClientId(forceRefresh = false) {
  if (cachedClientId && !forceRefresh) {
    return cachedClientId;
  }

  const homeResp = await fetch(SOUNDCLOUD_HOME, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!homeResp.ok) {
    throw new Error(`Unable to reach SoundCloud (${homeResp.status})`);
  }

  const html = await homeResp.text();
  let scriptUrls = [];
  const tagRegex = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    scriptUrls.push(match[1]);
  }

  if (scriptUrls.length === 0) {
    const fallbackRegex = /(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"\s>]+\.js)/g;
    while ((match = fallbackRegex.exec(html)) !== null) {
      scriptUrls.push(match[1]);
    }
  }

  for (let i = scriptUrls.length - 1; i >= 0; i--) {
    try {
      const jsResp = await fetch(scriptUrls[i], {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      });
      if (!jsResp.ok) continue;
      const jsText = await jsResp.text();
      const idMatch =
        jsText.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/) ||
        jsText.match(/client_id=([a-zA-Z0-9]{32})/);
      if (idMatch) {
        cachedClientId = idMatch[1];
        return cachedClientId;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Failed to extract SoundCloud client_id from web bundles");
}

async function requestV2(url, params = {}, retryOnAuth = true) {
  let clientId = await getClientId();
  const target = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      target.searchParams.set(k, String(v));
    }
  }
  target.searchParams.set("client_id", clientId);

  let resp = await fetch(target.toString(), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  if ((resp.status === 401 || resp.status === 403) && retryOnAuth) {
    clientId = await getClientId(true);
    target.searchParams.set("client_id", clientId);
    resp = await fetch(target.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  }

  if (!resp.ok) {
    const err = new Error(`SoundCloud API error (${resp.status})`);
    err.status = resp.status;
    throw err;
  }

  return resp.json();
}

function normalizeTrack(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const transcodings = raw.media?.transcodings || [];
  if (!transcodings.length) return null;

  const user = raw.user || {};
  const artwork = raw.artwork_url || user.avatar_url || "";

  return {
    id: raw.id,
    title: raw.title || "Untitled",
    duration: raw.duration || 0,
    artwork_url: artwork,
    playback_count: raw.playback_count || 0,
    likes_count: raw.likes_count || 0,
    genre: raw.genre || "",
    tag_list: raw.tag_list || "",
    permalink_url: raw.permalink_url || "",
    track_authorization: raw.track_authorization || "",
    user: {
      id: user.id,
      username: user.username || "Unknown Artist",
      permalink: user.permalink || "",
      avatar_url: user.avatar_url || "",
    },
    media: {
      transcodings,
    },
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const parsedUrl = new URL(req.url, "https://localhost");
    const routeParam = parsedUrl.searchParams.get("route");
    const route = routeParam
      ? `/${routeParam.replace(/^\/+/, "")}`
      : parsedUrl.pathname.replace(/^\/api/, "") || "/";

    if (route === "/health") {
      const clientId = await getClientId();
      return res.status(200).json({ status: "ok", client_id_cached: Boolean(clientId) });
    }

    if (route === "/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim();
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 20)));
      if (!q) return res.status(400).json({ detail: "Query parameter q is required" });

      const data = await requestV2(`${API_V2_BASE}/search/tracks`, { q, limit, offset: 0 });
      const collection = (data.collection || []).map(normalizeTrack).filter(Boolean);
      return res.status(200).json({ collection });
    }

    if (route === "/user/likes") {
      const rawUsername = (parsedUrl.searchParams.get("username") || "").trim().replace(/^@/, "");
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 40)));
      if (!rawUsername) return res.status(400).json({ detail: "username is required" });

      const profileUrl =
        rawUsername.startsWith("http://") || rawUsername.startsWith("https://")
          ? rawUsername
          : `https://soundcloud.com/${rawUsername}`;

      const userData = await requestV2(`${API_V2_BASE}/resolve`, { url: profileUrl });
      if (!userData?.id || userData.kind !== "user") {
        return res.status(404).json({ detail: "SoundCloud user profile not found" });
      }

      const likesData = await requestV2(`${API_V2_BASE}/users/${userData.id}/likes`, {
        limit,
        offset: 0,
      });
      const collection = (likesData.collection || [])
        .map((entry) => normalizeTrack(entry?.track))
        .filter(Boolean);

      return res.status(200).json({
        user: {
          id: userData.id,
          username: userData.username,
          permalink: userData.permalink,
        },
        collection,
      });
    }

    if (route === "/wave/related") {
      const trackId = parsedUrl.searchParams.get("track_id");
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 25)));
      if (!trackId) return res.status(400).json({ detail: "track_id is required" });

      const data = await requestV2(`${API_V2_BASE}/tracks/${encodeURIComponent(trackId)}/related`, {
        limit,
        offset: 0,
      });
      const collection = (data.collection || []).map(normalizeTrack).filter(Boolean);
      return res.status(200).json({ collection });
    }

    if (route === "/stream") {
      const trackId = parsedUrl.searchParams.get("track_id");
      if (!trackId) return res.status(400).json({ detail: "track_id is required" });

      const trackData = await requestV2(`${API_V2_BASE}/tracks/${encodeURIComponent(trackId)}`);
      const transcodings = trackData.media?.transcodings || [];
      if (!transcodings.length) {
        return res.status(404).json({ detail: "No playable transcodings available" });
      }

      let selected =
        transcodings.find(
          (t) => t.format?.protocol === "progressive" && (t.format?.mime_type || "").includes("mpeg")
        ) ||
        transcodings.find((t) => t.format?.protocol === "progressive") ||
        transcodings.find(
          (t) => t.format?.protocol === "hls" && (t.format?.mime_type || "").includes("mpeg")
        ) ||
        transcodings[0];

      if (!selected?.url) {
        return res.status(502).json({ detail: "Invalid transcoding URL" });
      }

      const params = {};
      if (trackData.track_authorization) {
        params.track_authorization = trackData.track_authorization;
      }

      const resolved = await requestV2(selected.url, params);
      if (!resolved?.url) {
        return res.status(502).json({ detail: "SoundCloud did not return a stream URL" });
      }

      return res.status(200).json({
        url: resolved.url,
        protocol: selected.format?.protocol || "hls",
        mime_type: selected.format?.mime_type || "audio/mpeg",
        duration: trackData.duration || 0,
      });
    }

    return res.status(404).json({ detail: `Unknown API route: ${route}` });
  } catch (err) {
    const status = err.status || 502;
    return res.status(status).json({ detail: err.message || "Upstream SoundCloud error" });
  }
};