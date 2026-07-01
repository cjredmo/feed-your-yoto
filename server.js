const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = __dirname;
const YOTO_CLIENT_ID = process.env.YOTO_CLIENT_ID || "YzfLkOX13YlDuwKneSpa9inTCwJwTX2o";
const YOTO_AUDIENCE = "https://api.yotoplay.com";
const YOTO_API_BASE_URL = "https://api.yotoplay.com";
const YOTO_SCOPE =
  "offline_access user:content:view user:content:manage family:library:view family:library:manage";
const PRIMARY_DATA_DIR = process.env.YOTO_DATA_DIR || "/app/data";
const LOCAL_DATA_DIR = path.join(__dirname, "data");
const STATIC_FILES = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "assets/feed-your-yoto-mascot.png",
]);

let resolvedDataDir = null;

const getDataDir = async () => {
  if (resolvedDataDir) return resolvedDataDir;

  try {
    await fs.mkdir(PRIMARY_DATA_DIR, { recursive: true });
    resolvedDataDir = PRIMARY_DATA_DIR;
  } catch (error) {
    if (process.env.YOTO_DATA_DIR) throw error;

    resolvedDataDir = LOCAL_DATA_DIR;
    await fs.mkdir(resolvedDataDir, { recursive: true });
    console.warn(`Could not use ${PRIMARY_DATA_DIR}; storing auth data in ${resolvedDataDir}.`);
  }

  return resolvedDataDir;
};

const getTokenPath = async () => path.join(await getDataDir(), "yoto_tokens.json");
const getPendingPath = async () => path.join(await getDataDir(), "pending_device_auth.json");
const getStoryCardsPath = async () => path.join(await getDataDir(), "story_cards.json");

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
};

const sendError = (response, statusCode, message) => {
  sendJson(response, statusCode, { error: message, message });
};

const readJsonFile = async (filePath) => {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const writeJsonFile = async (filePath, value) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const deleteFileIfExists = async (filePath) => {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const readRequestJson = (request) =>
  new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error("Request body should be valid JSON.");
        error.status = 400;
        error.expose = true;
        reject(error);
      }
    });

    request.on("error", reject);
  });

const readStoryCards = async () => {
  const storyCards = await readJsonFile(await getStoryCardsPath());
  return Array.isArray(storyCards) ? storyCards : [];
};

const writeStoryCards = async (storyCards) => {
  await writeJsonFile(await getStoryCardsPath(), storyCards);
};

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const slugify = (value) =>
  String(value || "story-card")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "story-card";

const createStoryCardId = (name, existingCards) => {
  const base = slugify(name);
  let candidate = base;
  let count = 2;

  while (existingCards.some((card) => card.id === candidate)) {
    candidate = `${base}-${count}`;
    count += 1;
  }

  return candidate;
};

const createExposedError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
};

const validateStoryCardInput = (body, { requirePlaylist = true } = {}) => {
  const errors = [];
  const updateRhythm = String(body.updateRhythm || "").trim();
  const lateCheckRhythm = String(body.lateCheckRhythm || "").trim();

  if (!String(body.name || "").trim()) errors.push("Story Card Name is required.");
  if (!String(body.podcastLink || "").trim()) errors.push("Podcast Link is required.");
  if (body.podcastLink && !isHttpUrl(body.podcastLink)) {
    errors.push("Podcast Link should start with http or https.");
  }
  if (requirePlaylist && !String(body.yotoPlaylistId || "").trim()) {
    errors.push("Choose a Story Playlist first.");
  }
  if (!updateRhythm) errors.push("Choose when this Story Card should check for episodes.");
  if (updateRhythm !== "manual" && !lateCheckRhythm) {
    errors.push("Choose what to do if the episode is late.");
  }

  if (errors.length) {
    throw createExposedError(errors[0]);
  }
};

const normalizeStoryCard = (body, existingCard = {}) => {
  const now = new Date().toISOString();
  const updateRhythm = String(body.updateRhythm || existingCard.updateRhythm || "").trim();

  return {
    id: existingCard.id,
    name: String(body.name || "").trim(),
    podcastLink: String(body.podcastLink || "").trim(),
    yotoPlaylistId: String(body.yotoPlaylistId || "").trim(),
    yotoPlaylistTitle: String(body.yotoPlaylistTitle || "Story Playlist").trim(),
    yotoPlaylistImageUrl: isHttpUrl(body.yotoPlaylistImageUrl)
      ? body.yotoPlaylistImageUrl
      : null,
    updateRhythm,
    lateCheckRhythm: updateRhythm === "manual" ? "" : String(body.lateCheckRhythm || "").trim(),
    status: String(body.status || existingCard.status || "Updating").trim(),
    statusType: String(body.statusType || existingCard.statusType || "live").trim(),
    nextCheck: updateRhythm === "manual" ? "" : String(body.nextCheck || "").trim(),
    createdAt: existingCard.createdAt || now,
    updatedAt: now,
  };
};

const isPlaylistUsedByStoryCard = (storyCards, playlistId, ignoreStoryCardId = "") =>
  storyCards.some(
    (storyCard) =>
      storyCard.id !== ignoreStoryCardId && storyCard.yotoPlaylistId === playlistId
  );

const createStoryCard = async (body) => {
  const storyCards = await readStoryCards();
  const playlistMode = body.playlistMode === "create" ? "create" : "existing";
  let storyCardBody = { ...body };

  if (playlistMode === "create") {
    const newPlaylistTitle = String(body.newPlaylistTitle || "").trim();
    if (!newPlaylistTitle) {
      throw createExposedError("Name the new Story Playlist first.");
    }

    validateStoryCardInput(storyCardBody, { requirePlaylist: false });
    const createdPlaylist = await createYotoPlaylist(newPlaylistTitle);
    storyCardBody = {
      ...storyCardBody,
      yotoPlaylistId: createdPlaylist.id,
      yotoPlaylistTitle: createdPlaylist.title,
      yotoPlaylistImageUrl: null,
    };
  } else {
    validateStoryCardInput(storyCardBody);

    if (body.overwriteAcknowledged !== true) {
      throw createExposedError("A grown-up needs to check the Story Playlist warning first.");
    }
  }

  validateStoryCardInput(storyCardBody);

  if (isPlaylistUsedByStoryCard(storyCards, storyCardBody.yotoPlaylistId)) {
    throw createExposedError("This Story Playlist is already connected to another Story Card.");
  }

  const storyCard = normalizeStoryCard(storyCardBody, {
    id: createStoryCardId(storyCardBody.name, storyCards),
  });
  storyCards.push(storyCard);
  await writeStoryCards(storyCards);
  return storyCard;
};

const updateStoryCard = async (id, body) => {
  const storyCards = await readStoryCards();
  const index = storyCards.findIndex((storyCard) => storyCard.id === id);

  if (index === -1) {
    const error = new Error("Story Card not found.");
    error.status = 404;
    error.expose = true;
    throw error;
  }

  const merged = {
    ...storyCards[index],
    ...body,
  };
  validateStoryCardInput(merged);
  const nextStoryCard = normalizeStoryCard(merged, storyCards[index]);
  storyCards[index] = nextStoryCard;
  await writeStoryCards(storyCards);
  return nextStoryCard;
};

const deleteStoryCard = async (id) => {
  const storyCards = await readStoryCards();
  const nextStoryCards = storyCards.filter((storyCard) => storyCard.id !== id);

  if (nextStoryCards.length === storyCards.length) {
    const error = new Error("Story Card not found.");
    error.status = 404;
    error.expose = true;
    throw error;
  }

  await writeStoryCards(nextStoryCards);
  return { deleted: true };
};

const hasCurrentAccessToken = (tokens) => {
  if (!tokens?.access_token || !tokens.expires_at) return false;
  return new Date(tokens.expires_at).getTime() > Date.now() + 60_000;
};

const cleanDisplayAuth = (auth) => ({
  user_code: auth.user_code,
  verification_uri: auth.verification_uri,
  verification_uri_complete: auth.verification_uri_complete,
  expires_in: auth.expires_in,
  interval: auth.interval || 5,
});

const normalizeTokens = (tokenResponse, previousTokens = {}) => {
  const now = Date.now();
  const expiresIn = Number(tokenResponse.expires_in || previousTokens.expires_in || 0);

  return {
    access_token: tokenResponse.access_token || previousTokens.access_token,
    refresh_token: tokenResponse.refresh_token || previousTokens.refresh_token,
    token_type: tokenResponse.token_type || previousTokens.token_type || "Bearer",
    scope: tokenResponse.scope || previousTokens.scope,
    expires_in: expiresIn || undefined,
    expires_at: expiresIn
      ? new Date(now + expiresIn * 1000).toISOString()
      : previousTokens.expires_at,
    saved_at: new Date(now).toISOString(),
  };
};

const postYotoForm = async (url, form) => {
  if (typeof fetch !== "function") {
    throw new Error("This server needs Node 18 or newer for built-in fetch.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(data.error_description || data.error || "Yoto request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
};

const refreshTokens = async (tokens) => {
  if (!tokens.refresh_token) return null;

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: YOTO_CLIENT_ID,
    audience: YOTO_AUDIENCE,
  });
  const refreshed = await postYotoForm("https://login.yotoplay.com/oauth/token", form);
  const nextTokens = normalizeTokens(refreshed, tokens);
  await writeJsonFile(await getTokenPath(), nextTokens);
  return nextTokens;
};

const getAuthStatus = async () => {
  const tokenPath = await getTokenPath();
  const tokens = await readJsonFile(tokenPath);

  if (!tokens) {
    return { authenticated: false, token_file_exists: false };
  }

  if (hasCurrentAccessToken(tokens)) {
    return {
      authenticated: true,
      token_file_exists: true,
      expires_at: tokens.expires_at,
    };
  }

  try {
    const refreshed = await refreshTokens(tokens);
    if (hasCurrentAccessToken(refreshed)) {
      return {
        authenticated: true,
        token_file_exists: true,
        expires_at: refreshed.expires_at,
      };
    }
  } catch (error) {
    console.warn("Yoto token refresh failed.", error.message);
  }

  return {
    authenticated: false,
    token_file_exists: true,
    expires_at: tokens.expires_at,
  };
};

const getAuthenticatedTokens = async () => {
  const tokens = await readJsonFile(await getTokenPath());

  if (!tokens) return null;
  if (hasCurrentAccessToken(tokens)) return tokens;

  try {
    const refreshed = await refreshTokens(tokens);
    return hasCurrentAccessToken(refreshed) ? refreshed : null;
  } catch (error) {
    console.warn("Yoto token refresh failed.", error.message);
    return null;
  }
};

const fetchYotoJson = async (pathName, tokens) => {
  if (typeof fetch !== "function") {
    throw new Error("This server needs Node 18 or newer for built-in fetch.");
  }

  const response = await fetch(`${YOTO_API_BASE_URL}${pathName}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error("Yoto request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
};

const getYotoJsonWithRefresh = async (pathName, tokens) => {
  try {
    return {
      data: await fetchYotoJson(pathName, tokens),
      tokens,
    };
  } catch (error) {
    if (error.status !== 401) throw error;

    const refreshed = await refreshTokens(tokens);
    if (!hasCurrentAccessToken(refreshed)) throw error;

    return {
      data: await fetchYotoJson(pathName, refreshed),
      tokens: refreshed,
    };
  }
};

const postYotoJson = async (pathName, tokens, body) => {
  if (typeof fetch !== "function") {
    throw new Error("This server needs Node 18 or newer for built-in fetch.");
  }

  const response = await fetch(`${YOTO_API_BASE_URL}${pathName}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error("Yoto request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
};

const postYotoJsonWithRefresh = async (pathName, tokens, body) => {
  try {
    return {
      data: await postYotoJson(pathName, tokens, body),
      tokens,
    };
  } catch (error) {
    if (error.status !== 401) throw error;

    const refreshed = await refreshTokens(tokens);
    if (!hasCurrentAccessToken(refreshed)) throw error;

    return {
      data: await postYotoJson(pathName, refreshed, body),
      tokens: refreshed,
    };
  }
};

const getCreatedYotoPlaylistId = (data) =>
  data?.card?.cardId || data?.card?.card_id || data?.card?._id || data?.card?.id || data?.cardId || data?.id || "";

const createYotoPlaylist = async (title) => {
  let tokens = await getAuthenticatedTokens();
  if (!tokens) {
    throw createExposedError("Connect Yoto before creating a Story Playlist.", 401);
  }

  const playlistTitle = String(title || "").trim();
  const createResponse = await postYotoJsonWithRefresh("/content", tokens, {
    title: playlistTitle,
    metadata: {
      title: playlistTitle,
      description: "Managed by Feed Your Yoto",
    },
    content: {
      chapters: [],
      config: {
        resumeTimeout: 2592000,
      },
      playbackType: "linear",
    },
  });
  const id = getCreatedYotoPlaylistId(createResponse.data);

  if (!id) {
    throw createExposedError("Yoto did not return a new Story Playlist id.", 502);
  }

  return {
    id,
    title: playlistTitle,
    imageUrl: null,
  };
};

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};

const extractContentItems = (data) => {
  if (Array.isArray(data)) return data;

  const candidateKeys = ["items", "results", "content", "contents", "cards", "myoContent"];
  for (const key of candidateKeys) {
    if (Array.isArray(data?.[key])) return data[key];
  }

  return [];
};

const getCardId = (card) =>
  card?.id || card?.contentId || card?.cardId || card?.playlistId || card?._id || "";

const readCardTitle = (card) =>
  card?.title ||
  card?.name ||
  card?.metadata?.title ||
  card?.metadata?.media?.title ||
  card?.cardTitle ||
  "";

const getCardTitle = (card, fallbackCard = null) =>
  readCardTitle(card) || readCardTitle(fallbackCard) || "Untitled Story Playlist";

const isBrowserImageUrl = (value) => {
  const url = String(value || "");
  return url.startsWith("http://") || url.startsWith("https://");
};

const getYotoPlaylistImageUrl = (item) => {
  const imageUrl =
    item?.metadata?.cover?.imageL ||
    item?.metadata?.cover?.imageM ||
    item?.metadata?.cover?.imageS ||
    item?.content?.cover?.imageL ||
    item?.content?.cover?.imageM ||
    item?.content?.cover?.imageS ||
    item?.cover?.imageL ||
    item?.cover?.imageM ||
    item?.cover?.imageS ||
    item?.imageUrl ||
    item?.metadata?.imageUrl ||
    item?.metadata?.media?.imageUrl ||
  "";

  return isBrowserImageUrl(imageUrl) ? imageUrl : null;
};

const getCardImageUrl = (card, fallbackCard = null) =>
  getYotoPlaylistImageUrl(card) || getYotoPlaylistImageUrl(fallbackCard);

const isStreamTrack = (track) => {
  if (!track || typeof track !== "object") return false;

  const type = String(track.type || "").toLowerCase();
  const trackUrl = String(
    track.trackUrl ||
      track.streamUrl ||
      track.mediaUrl ||
      track.audioUrl ||
      track.url ||
      track.uri ||
      ""
  );

  return type === "stream" || trackUrl.startsWith("http://") || trackUrl.startsWith("https://");
};

const hasStreamingMedia = (value) => {
  if (!value || typeof value !== "object") return false;

  if (value?.metadata?.media?.hasStreams === true) return true;
  if (value?.content?.config?.hasStreams === true) return true;
  if (isStreamTrack(value)) return true;

  const playbackType = String(value.playbackType || value?.content?.playbackType || "").toLowerCase();
  if (playbackType.includes("stream")) return true;

  const children = [
    ...asArray(value.tracks),
    ...asArray(value.trackList),
    ...asArray(value.chapters),
    ...asArray(value.content),
    ...asArray(value.card),
    ...asArray(value.items),
    ...asArray(value.content?.config?.tracks),
    ...asArray(value.content?.config?.chapters),
    ...asArray(value.content?.config?.items),
    ...asArray(value.metadata?.tracks),
    ...asArray(value.metadata?.chapters),
    ...asArray(value.metadata?.media?.tracks),
    ...asArray(value.metadata?.media?.chapters),
  ];

  return children.some(hasStreamingMedia);
};

const getSafeYotoCards = async () => {
  let tokens = await getAuthenticatedTokens();
  if (!tokens) {
    const error = new Error("Connect Yoto before choosing a card.");
    error.status = 401;
    error.expose = true;
    throw error;
  }

  const mineResponse = await getYotoJsonWithRefresh("/content/mine", tokens);
  tokens = mineResponse.tokens;

  const cards = extractContentItems(mineResponse.data);
  const safeCards = [];

  for (const card of cards) {
    const id = getCardId(card);
    if (!id) continue;

    let cardDetails = null;
    try {
      const detailResponse = await getYotoJsonWithRefresh(
        `/content/${encodeURIComponent(id)}`,
        tokens
      );
      tokens = detailResponse.tokens;
      cardDetails = detailResponse.data;
    } catch (error) {
      console.warn(`Could not inspect Story Playlist ${id}.`, error.message);
    }

    const detailCard = cardDetails?.card || cardDetails;
    const hasStreams = hasStreamingMedia(card) || hasStreamingMedia(detailCard);
    const source = detailCard || card;
    safeCards.push({
      id,
      title: getCardTitle(source, card),
      compatible: !hasStreams,
      hasStreams,
      imageUrl: getCardImageUrl(source, card),
    });
  }

  return safeCards;
};

const startAuth = async () => {
  const form = new URLSearchParams({
    client_id: YOTO_CLIENT_ID,
    audience: YOTO_AUDIENCE,
    scope: YOTO_SCOPE,
  });
  const auth = await postYotoForm("https://login.yotoplay.com/oauth/device/code", form);
  const pending = {
    device_code: auth.device_code,
    user_code: auth.user_code,
    verification_uri: auth.verification_uri,
    verification_uri_complete: auth.verification_uri_complete,
    expires_at: new Date(Date.now() + Number(auth.expires_in || 600) * 1000).toISOString(),
    interval: Number(auth.interval || 5),
    created_at: new Date().toISOString(),
  };

  await writeJsonFile(await getPendingPath(), pending);
  return cleanDisplayAuth(auth);
};

const pollAuth = async () => {
  const pendingPath = await getPendingPath();
  const pending = await readJsonFile(pendingPath);

  if (!pending?.device_code) {
    return { authenticated: false, pending: false, message: "No Yoto sign-in is waiting." };
  }

  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    await deleteFileIfExists(pendingPath);
    return { authenticated: false, pending: false, message: "Yoto sign-in expired." };
  }

  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: pending.device_code,
    client_id: YOTO_CLIENT_ID,
    audience: YOTO_AUDIENCE,
  });

  try {
    const tokenResponse = await postYotoForm("https://login.yotoplay.com/oauth/token", form);
    await writeJsonFile(await getTokenPath(), normalizeTokens(tokenResponse));
    await deleteFileIfExists(pendingPath);
    return { authenticated: true };
  } catch (error) {
    const code = error.data?.error;

    if (code === "authorization_pending") {
      return { authenticated: false, pending: true, interval: pending.interval || 5 };
    }

    if (code === "slow_down") {
      pending.interval = Number(pending.interval || 5) + 5;
      await writeJsonFile(pendingPath, pending);
      return { authenticated: false, pending: true, interval: pending.interval };
    }

    if (code === "expired_token" || code === "access_denied") {
      await deleteFileIfExists(pendingPath);
      return {
        authenticated: false,
        pending: false,
        message: code === "access_denied" ? "Yoto sign-in was cancelled." : "Yoto sign-in expired.",
      };
    }

    throw error;
  }
};

const resetAuth = async () => {
  await deleteFileIfExists(await getTokenPath());
  await deleteFileIfExists(await getPendingPath());

  return {
    authenticated: false,
    message: "Yoto authentication reset.",
  };
};

const handleApi = async (request, response, pathname) => {
  try {
    const storyCardRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/?$/);
    const isStoryCardsRoute = pathname === "/api/story-cards" || pathname === "/api/story-cards/";

    if (request.method === "GET" && pathname === "/api/auth/status") {
      sendJson(response, 200, await getAuthStatus());
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/start") {
      sendJson(response, 200, await startAuth());
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/poll") {
      sendJson(response, 200, await pollAuth());
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/reset") {
      sendJson(response, 200, await resetAuth());
      return;
    }

    if (request.method === "GET" && pathname === "/api/yoto/cards") {
      sendJson(response, 200, await getSafeYotoCards());
      return;
    }

    if (request.method === "GET" && isStoryCardsRoute) {
      sendJson(response, 200, await readStoryCards());
      return;
    }

    if (request.method === "POST" && isStoryCardsRoute) {
      sendJson(response, 201, await createStoryCard(await readRequestJson(request)));
      return;
    }

    if (request.method === "PUT" && storyCardRoute) {
      const storyCardId = decodeURIComponent(storyCardRoute[1]);
      sendJson(response, 200, await updateStoryCard(storyCardId, await readRequestJson(request)));
      return;
    }

    if (request.method === "DELETE" && storyCardRoute) {
      const storyCardId = decodeURIComponent(storyCardRoute[1]);
      sendJson(response, 200, await deleteStoryCard(storyCardId));
      return;
    }

    sendError(response, 404, "API route not found.");
  } catch (error) {
    if (error.expose && error.status) {
      sendError(response, error.status, error.message);
      return;
    }

    console.error(error);
    sendError(response, 500, "Yoto request failed.");
  }
};

const serveStatic = async (request, response, pathname) => {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  if (!STATIC_FILES.has(relativePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const filePath = path.join(PUBLIC_DIR, relativePath);
  const extension = path.extname(filePath);
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
  };

  try {
    const contents = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    throw error;
  }
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url.pathname);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  try {
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Server error");
  }
});

server.listen(PORT, () => {
  console.log(`Feed Your Yoto running at http://127.0.0.1:${PORT}`);
});
