const SOUNDCLOUD_HOME = "https://soundcloud.com/";
const API_V2_BASE = "https://api-v2.soundcloud.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let cachedClientId = null;
let lastClientIdFetch = 0;
const CLIENT_ID_CACHE_TTL = 3600 * 1000; // 1 hour

async function getClientId(forceRefresh = false) {
  const now = Date.now();
  if (process.env.SOUNDCLOUD_CLIENT_ID && !forceRefresh) {
    return process.env.SOUNDCLOUD_CLIENT_ID;
  }

  if (cachedClientId && !forceRefresh && now - lastClientIdFetch < CLIENT_ID_CACHE_TTL) {
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
  const tagRegex = /<script[^>]+src="([^">]+\.js)"/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.includes("sndcdn.com") || src.includes("assets")) {
      scriptUrls.push(src.startsWith("//") ? `https:${src}` : src);
    }
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
        jsText.match(/client_id=([a-zA-Z0-9]{32})/) ||
        jsText.match(/client_id[:=]\s*["']?([a-zA-Z0-9]{32})["']?/);
      if (idMatch) {
        cachedClientId = idMatch[1];
        lastClientIdFetch = now;
        return cachedClientId;
      }
    } catch {
      continue;
    }
  }

  if (cachedClientId) return cachedClientId;
  throw new Error("Failed to extract SoundCloud client_id from web bundles");
}

async function requestV2(url, params = {}, oauthToken = null, retryOnAuth = true) {
  let clientId = await getClientId();
  const target = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      target.searchParams.set(k, String(v));
    }
  }
  target.searchParams.set("client_id", clientId);

  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Origin: "https://soundcloud.com",
    Referer: "https://soundcloud.com/",
  };
  if (oauthToken) {
    headers.Authorization = `OAuth ${oauthToken}`;
  }

  let resp = await fetch(target.toString(), { headers });

  if ((resp.status === 401 || resp.status === 403) && retryOnAuth && !oauthToken) {
    clientId = await getClientId(true);
    target.searchParams.set("client_id", clientId);
    resp = await fetch(target.toString(), { headers });
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
    bpm: raw.bpm || null,
    waveform_url: raw.waveform_url || "",
    created_at: raw.created_at || raw.release_date || "",
    permalink_url: raw.permalink_url || "",
    track_authorization: raw.track_authorization || "",
    user: {
      id: user.id || 0,
      username: user.username || "Unknown Artist",
      permalink: user.permalink || "",
      avatar_url: user.avatar_url || "",
    },
    media: {
      transcodings,
    },
  };
}

function normalizeUser(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    id: raw.id,
    username: raw.username || raw.permalink || "Unknown",
    permalink: raw.permalink || "",
    permalink_url: raw.permalink_url || "",
    avatar_url: raw.avatar_url || "",
    followers_count: raw.followers_count || 0,
    track_count: raw.track_count || 0,
    playlist_count: raw.playlist_count || 0,
    city: raw.city || "",
  };
}

async function hydrateTracks(rawTracks = [], oauthToken = null) {
  const ready = [];
  const missingIds = [];

  for (const t of rawTracks) {
    if (t && t.media?.transcodings?.length) {
      const norm = normalizeTrack(t);
      if (norm) ready.push(norm);
    } else if (t && t.id) {
      missingIds.push(t.id);
    }
  }

  if (missingIds.length > 0) {
    const chunkSize = 50;
    for (let i = 0; i < missingIds.length; i += chunkSize) {
      const chunk = missingIds.slice(i, i + chunkSize);
      try {
        const fetched = await requestV2(
          `${API_V2_BASE}/tracks`,
          { ids: chunk.join(",") },
          oauthToken
        );
        const list = Array.isArray(fetched) ? fetched : fetched.collection || [];
        for (const item of list) {
          const norm = normalizeTrack(item);
          if (norm) ready.push(norm);
        }
      } catch {
        // Ignore partial chunk failures
      }
    }
  }

  const byId = new Map(ready.map((t) => [t.id, t]));
  return rawTracks.map((t) => byId.get(t?.id) || normalizeTrack(t)).filter(Boolean);
}

function normalizePlaylistMeta(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  const user = raw.user || {};
  return {
    id: raw.id,
    title: raw.title || "Untitled Playlist",
    artwork_url: raw.artwork_url || raw.tracks?.[0]?.artwork_url || user.avatar_url || "",
    track_count: raw.track_count || (raw.tracks ? raw.tracks.length : 0),
    permalink_url: raw.permalink_url || "",
    user: {
      id: user.id || 0,
      username: user.username || "Unknown",
      permalink: user.permalink || "",
    },
  };
}

async function resolveTranscoding(transcoding, trackAuthorization, oauthToken) {
  if (!transcoding?.url) return null;
  const params = {};
  if (trackAuthorization) {
    params.track_authorization = trackAuthorization;
  }
  const resolved = await requestV2(transcoding.url, params, oauthToken);
  if (!resolved?.url) return null;
  return {
    url: resolved.url,
    protocol: transcoding.format?.protocol || "hls",
    mime_type: transcoding.format?.mime_type || "audio/mpeg",
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status ? res.status(204).end() : (res.statusCode = 204, res.end());
  }

  const sendJson = (status, payload) => {
    if (res.status && typeof res.status === "function") {
      return res.status(status).json(payload);
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  };

  try {
    const parsedUrl = new URL(req.url, "https://localhost");
    const routeParam = parsedUrl.searchParams.get("route");
    const route = routeParam
      ? `/${routeParam.replace(/^\/+/, "")}`
      : parsedUrl.pathname.replace(/^\/api/, "") || "/";

    const oauthToken = (req.headers["x-sc-oauth"] || "").toString().trim() || null;

    if (route === "/health") {
      const clientId = await getClientId();
      return sendJson(200, { status: "ok", client_id_cached: Boolean(clientId) });
    }

    if (route === "/tracks") {
      const ids = (parsedUrl.searchParams.get("ids") || "").trim();
      if (!ids) return sendJson(400, { detail: "ids parameter is required" });
      const data = await requestV2(`${API_V2_BASE}/tracks`, { ids }, oauthToken);
      const list = Array.isArray(data) ? data : data.collection || [];
      const collection = list.map(normalizeTrack).filter(Boolean);
      return sendJson(200, { collection });
    }

    if (route === "/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim();
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 20)));
      if (!q) return sendJson(400, { detail: "Query parameter q is required" });

      const data = await requestV2(`${API_V2_BASE}/search/tracks`, { q, limit, offset: 0 }, oauthToken);
      const collection = (data.collection || []).map(normalizeTrack).filter(Boolean);
      return sendJson(200, { collection });
    }

    if (route === "/users/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim().replace(/^@/, "");
      const limit = Math.min(30, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 15)));
      if (!q) return sendJson(400, { detail: "Query parameter q is required" });

      const data = await requestV2(`${API_V2_BASE}/search/users`, { q, limit, offset: 0 }, oauthToken);
      const collection = (data.collection || []).map(normalizeUser).filter(Boolean);
      return sendJson(200, { collection });
    }

    if (route === "/playlists/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim();
      const limit = Math.min(30, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 15)));
      if (!q) return sendJson(400, { detail: "Query parameter q is required" });

      const data = await requestV2(
        `${API_V2_BASE}/search/playlists_without_albums`,
        { q, limit, offset: 0 },
        oauthToken
      );
      const collection = (data.collection || []).map(normalizePlaylistMeta).filter(Boolean);
      return sendJson(200, { collection });
    }

    if (route === "/user/profile" || route === "/user/likes") {
      const rawUsername = (parsedUrl.searchParams.get("username") || "").trim().replace(/^@/, "");
      const userIdParam = parsedUrl.searchParams.get("user_id");
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 40)));

      let userData = null;
      if (userIdParam) {
        userData = await requestV2(`${API_V2_BASE}/users/${encodeURIComponent(userIdParam)}`, {}, oauthToken);
      } else {
        if (!rawUsername) return sendJson(400, { detail: "username is required" });
        const profileUrl =
          rawUsername.startsWith("http://") || rawUsername.startsWith("https://")
            ? rawUsername.split("?")[0].replace(/\/+$/, "")
            : `https://soundcloud.com/${rawUsername}`;

        try {
          userData = await requestV2(`${API_V2_BASE}/resolve`, { url: profileUrl }, oauthToken);
        } catch {
          userData = null;
        }

        // Fallback to user search if /resolve failed (e.g. display name instead of permalink)
        if (!userData?.id || userData.kind !== "user") {
          const searchRes = await requestV2(
            `${API_V2_BASE}/search/users`,
            { q: rawUsername, limit: 1 },
            oauthToken
          ).catch(() => ({ collection: [] }));
          if (searchRes.collection?.length) {
            userData = searchRes.collection[0];
          }
        }
      }

      if (!userData?.id || userData.kind !== "user") {
        return sendJson(404, { detail: "SoundCloud user profile not found" });
      }

      const [likesRes, playlistsRes] = await Promise.all([
        requestV2(`${API_V2_BASE}/users/${userData.id}/likes`, { limit, offset: 0 }, oauthToken).catch(
          () => ({ collection: [] })
        ),
        requestV2(`${API_V2_BASE}/users/${userData.id}/playlists`, { limit: 25, offset: 0 }, oauthToken).catch(
          () => ({ collection: [] })
        ),
      ]);

      const likes = (likesRes.collection || [])
        .map((entry) => normalizeTrack(entry?.track || entry))
        .filter(Boolean);
      const playlists = (playlistsRes.collection || []).map(normalizePlaylistMeta).filter(Boolean);

      return sendJson(200, {
        user: normalizeUser(userData),
        collection: likes,
        playlists,
      });
    }

    if (route === "/me") {
      if (!oauthToken) {
        return sendJson(401, { detail: "OAuth token required" });
      }
      const me = await requestV2(`${API_V2_BASE}/me`, {}, oauthToken);
      const [likesRes, playlistsRes] = await Promise.all([
        requestV2(`${API_V2_BASE}/users/${me.id}/likes`, { limit: 50, offset: 0 }, oauthToken).catch(
          () => ({ collection: [] })
        ),
        requestV2(`${API_V2_BASE}/users/${me.id}/playlists`, { limit: 30, offset: 0 }, oauthToken).catch(
          () => ({ collection: [] })
        ),
      ]);

      const likes = (likesRes.collection || [])
        .map((entry) => normalizeTrack(entry?.track || entry))
        .filter(Boolean);
      const playlists = (playlistsRes.collection || []).map(normalizePlaylistMeta).filter(Boolean);

      return sendJson(200, {
        user: normalizeUser(me),
        collection: likes,
        playlists,
      });
    }

    if (route === "/playlist") {
      const playlistId = parsedUrl.searchParams.get("id");
      const playlistUrl = (parsedUrl.searchParams.get("url") || "").trim().split("?")[0];

      let plData;
      if (playlistId) {
        plData = await requestV2(`${API_V2_BASE}/playlists/${encodeURIComponent(playlistId)}`, {}, oauthToken);
      } else if (playlistUrl) {
        plData = await requestV2(`${API_V2_BASE}/resolve`, { url: playlistUrl }, oauthToken);
      } else {
        return sendJson(400, { detail: "Playlist id or url is required" });
      }

      if (!plData?.id || !Array.isArray(plData.tracks)) {
        return sendJson(404, { detail: "Playlist not found" });
      }

      const tracks = await hydrateTracks(plData.tracks, oauthToken);
      return sendJson(200, {
        playlist: normalizePlaylistMeta(plData),
        tracks,
      });
    }

    if (route === "/wave/related") {
      const trackId = parsedUrl.searchParams.get("track_id");
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 25)));
      if (!trackId) return sendJson(400, { detail: "track_id is required" });

      try {
        const data = await requestV2(
          `${API_V2_BASE}/tracks/${encodeURIComponent(trackId)}/related`,
          { limit, offset: 0 },
          oauthToken
        );
        const collection = (data.collection || []).map(normalizeTrack).filter(Boolean);
        return sendJson(200, { collection });
      } catch (relErr) {
        // Graceful fallback if SoundCloud has no related tracks graph for this item
        return sendJson(200, { collection: [] });
      }
    }

    if (route === "/wave/artist-likes") {
      const userId = parsedUrl.searchParams.get("user_id");
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 25)));
      if (!userId) return sendJson(400, { detail: "user_id is required" });

      try {
        const data = await requestV2(
          `${API_V2_BASE}/users/${encodeURIComponent(userId)}/likes`,
          { limit, offset: 0 },
          oauthToken
        );
        const collection = (data.collection || [])
          .map((entry) => normalizeTrack(entry?.track || entry))
          .filter(Boolean);
        return sendJson(200, { collection });
      } catch (err) {
        return sendJson(200, { collection: [] });
      }
    }

    if (route === "/stream") {
      const trackId = parsedUrl.searchParams.get("track_id");
      if (!trackId) return sendJson(400, { detail: "track_id is required" });

      const trackData = await requestV2(`${API_V2_BASE}/tracks/${encodeURIComponent(trackId)}`, {}, oauthToken);
      const transcodings = trackData.media?.transcodings || [];
      if (!transcodings.length) {
        return sendJson(404, { detail: "No playable transcodings available" });
      }

      // Sort transcodings: progressive mpeg -> hls mpeg -> other hls -> anything else
      const score = (t) => {
        const proto = t.format?.protocol || "";
        const mime = t.format?.mime_type || "";
        if (proto === "progressive" && mime.includes("mpeg")) return 0;
        if (proto === "progressive") return 1;
        if (proto === "hls" && mime.includes("mpeg")) return 2;
        if (proto === "hls") return 3;
        return 4;
      };
      const playable = transcodings.filter((t) => {
        const proto = (t.format?.protocol || "").toLowerCase();
        return proto === "progressive" || proto === "hls";
      });
      const ordered = [...playable].sort((a, b) => score(a) - score(b));

      const errors = [];
      const resolvedList = [];
      for (const t of ordered) {
        try {
          const r = await resolveTranscoding(t, trackData.track_authorization, oauthToken);
          if (r?.url) {
            resolvedList.push(r);
            if (resolvedList.length >= 2) break;
          }
        } catch (e) {
          errors.push(`${t.format?.protocol || "?"}:${t.format?.mime_type || "?"}->${e.status || e.message}`);
        }
      }

      const primary = resolvedList[0];
      const fallback = resolvedList[1] || null;

      if (!primary?.url) {
        return sendJson(502, {
          detail: "No working stream URL returned by SoundCloud",
          errors,
          formats: ordered.map((t) => t.format),
        });
      }

      return sendJson(200, {
        url: primary.url,
        protocol: primary.protocol,
        mime_type: primary.mime_type,
        fallback_url: fallback?.url || null,
        fallback_protocol: fallback?.protocol || null,
        duration: trackData.duration || 0,
      });
    }

    return sendJson(404, { detail: `Unknown API route: ${route}` });
  } catch (err) {
    const status = err.status || 502;
    return sendJson(status, { detail: err.message || "Upstream SoundCloud error" });
  }
};
