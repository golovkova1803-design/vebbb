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
        if (Array.isArray(fetched)) {
          for (const item of fetched) {
            const norm = normalizeTrack(item);
            if (norm) ready.push(norm);
          }
        }
      } catch {
        // Ignore partial chunk failures
      }
    }
  }

  const byId = new Map(ready.map((t) => [t.id, t]));
  return rawTracks.map((t) => byId.get(t?.id)).filter(Boolean);
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
      id: user.id,
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
    return res.status(204).end();
  }

  try {
    const parsedUrl = new URL(req.url, "https://localhost");
    const routeParam = parsedUrl.searchParams.get("route");
    const route = routeParam
      ? `/${routeParam.replace(/^\/+/, "")}`
      : parsedUrl.pathname.replace(/^\/api/, "") || "/";

    const oauthToken = (req.headers["x-sc-oauth"] || "").toString().trim() || null;

    if (route === "/health") {
      const clientId = await getClientId();
      return res.status(200).json({ status: "ok", client_id_cached: Boolean(clientId) });
    }

    if (route === "/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim();
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 20)));
      if (!q) return res.status(400).json({ detail: "Query parameter q is required" });

      const data = await requestV2(`${API_V2_BASE}/search/tracks`, { q, limit, offset: 0 }, oauthToken);
      const collection = (data.collection || []).map(normalizeTrack).filter(Boolean);
      return res.status(200).json({ collection });
    }

    if (route === "/users/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim().replace(/^@/, "");
      const limit = Math.min(30, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 15)));
      if (!q) return res.status(400).json({ detail: "Query parameter q is required" });

      const data = await requestV2(`${API_V2_BASE}/search/users`, { q, limit, offset: 0 }, oauthToken);
      const collection = (data.collection || []).map(normalizeUser).filter(Boolean);
      return res.status(200).json({ collection });
    }

    if (route === "/playlists/search") {
      const q = (parsedUrl.searchParams.get("q") || "").trim();
      const limit = Math.min(30, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 15)));
      if (!q) return res.status(400).json({ detail: "Query parameter q is required" });

      const data = await requestV2(
        `${API_V2_BASE}/search/playlists_without_albums`,
        { q, limit, offset: 0 },
        oauthToken
      );
      const collection = (data.collection || []).map(normalizePlaylistMeta).filter(Boolean);
      return res.status(200).json({ collection });
    }

    if (route === "/user/profile" || route === "/user/likes") {
      const rawUsername = (parsedUrl.searchParams.get("username") || "").trim().replace(/^@/, "");
      const userIdParam = parsedUrl.searchParams.get("user_id");
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 40)));

      let userData = null;
      if (userIdParam) {
        userData = await requestV2(`${API_V2_BASE}/users/${encodeURIComponent(userIdParam)}`, {}, oauthToken);
      } else {
        if (!rawUsername) return res.status(400).json({ detail: "username is required" });
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
        return res.status(404).json({ detail: "SoundCloud user profile not found" });
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
        .map((entry) => normalizeTrack(entry?.track))
        .filter(Boolean);
      const playlists = (playlistsRes.collection || []).map(normalizePlaylistMeta).filter(Boolean);

      return res.status(200).json({
        user: normalizeUser(userData),
        collection: likes,
        playlists,
      });
    }

    if (route === "/me") {
      if (!oauthToken) {
        return res.status(401).json({ detail: "OAuth token required" });
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
        .map((entry) => normalizeTrack(entry?.track))
        .filter(Boolean);
      const playlists = (playlistsRes.collection || []).map(normalizePlaylistMeta).filter(Boolean);

      return res.status(200).json({
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
        return res.status(400).json({ detail: "Playlist id or url is required" });
      }

      if (!plData?.id || !Array.isArray(plData.tracks)) {
        return res.status(404).json({ detail: "Playlist not found" });
      }

      const tracks = await hydrateTracks(plData.tracks, oauthToken);
      return res.status(200).json({
        playlist: normalizePlaylistMeta(plData),
        tracks,
      });
    }

    if (route === "/wave/related") {
      const trackId = parsedUrl.searchParams.get("track_id");
      const limit = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get("limit") || 25)));
      if (!trackId) return res.status(400).json({ detail: "track_id is required" });

      const data = await requestV2(
        `${API_V2_BASE}/tracks/${encodeURIComponent(trackId)}/related`,
        { limit, offset: 0 },
        oauthToken
      );
      const collection = (data.collection || []).map(normalizeTrack).filter(Boolean);
      return res.status(200).json({ collection });
    }

    if (route === "/stream") {
      const trackId = parsedUrl.searchParams.get("track_id");
      if (!trackId) return res.status(400).json({ detail: "track_id is required" });

      const trackData = await requestV2(`${API_V2_BASE}/tracks/${encodeURIComponent(trackId)}`, {}, oauthToken);
      const transcodings = trackData.media?.transcodings || [];
      if (!transcodings.length) {
        return res.status(404).json({ detail: "No playable transcodings available" });
      }

      const progressive =
        transcodings.find(
          (t) => t.format?.protocol === "progressive" && (t.format?.mime_type || "").includes("mpeg")
        ) || transcodings.find((t) => t.format?.protocol === "progressive");

      const hls =
        transcodings.find(
          (t) => t.format?.protocol === "hls" && (t.format?.mime_type || "").includes("mpeg")
        ) || transcodings.find((t) => t.format?.protocol === "hls");

      const primaryTranscoding = progressive || hls || transcodings[0];
      const fallbackTranscoding =
        primaryTranscoding === progressive && hls ? hls : primaryTranscoding === hls && progressive ? progressive : null;

      const errors = [];
      const [primaryRes, fallbackRes] = await Promise.all([
        resolveTranscoding(primaryTranscoding, trackData.track_authorization, oauthToken).catch((e) => {
          errors.push(`primary:${e.status || e.message}`);
          return null;
        }),
        fallbackTranscoding
          ? resolveTranscoding(fallbackTranscoding, trackData.track_authorization, oauthToken).catch((e) => {
              errors.push(`fallback:${e.status || e.message}`);
              return null;
            })
          : Promise.resolve(null),
      ]);

      const primary = primaryRes?.url ? primaryRes : fallbackRes;
      const fallback = primaryRes?.url && fallbackRes?.url ? fallbackRes : null;

      if (!primary?.url) {
        return res.status(502).json({
          detail: "No working stream URL returned by SoundCloud",
          errors,
          transcodings_count: transcodings.length,
        });
      }

      return res.status(200).json({
        url: primary.url,
        protocol: primary.protocol,
        mime_type: primary.mime_type,
        fallback_url: fallback?.url || null,
        fallback_protocol: fallback?.protocol || null,
        duration: trackData.duration || 0,
      });
    }

    return res.status(404).json({ detail: `Unknown API route: ${route}` });
  } catch (err) {
    const status = err.status || 502;
    return res.status(status).json({ detail: err.message || "Upstream SoundCloud error" });
  }
};