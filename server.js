const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

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
const PODCAST_FEED_TIMEOUT_MS = 10_000;
const PODCAST_FEED_MAX_REDIRECTS = 5;
const PODCAST_FEED_MAX_BYTES = 2_000_000;
const STORY_AUDIO_TIMEOUT_MS = 30_000;
const STORY_AUDIO_MAX_REDIRECTS = 15;
const STORY_AUDIO_MAX_BYTES = 150 * 1024 * 1024;
const YOTO_UPLOAD_TIMEOUT_MS = 120_000;
const YOTO_TRANSCODE_MAX_ATTEMPTS = 12;
const YOTO_TRANSCODE_POLL_INTERVAL_MS = 5_000;
const YOTO_PLAYLIST_PROCESSING_RETRY_MS = 2 * 60 * 1000;
const YOTO_TRANSCODE_MAX_RETRY_WINDOWS = 30;
const YOTO_PROCESSING_MESSAGE = "Yoto is still getting this story ready. Feed Your Yoto will try again soon.";
const playlistFailureTypes = new Set([
  "yoto_processing",
  "playlist_payload_error",
  "playlist_not_found",
  "yoto_auth",
  "yoto_http_error",
  "unknown",
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
const getStoryQueuePath = async () => path.join(await getDataDir(), "story_queue.json");
const getActivityLogPath = async () => path.join(await getDataDir(), "activity_log.json");
const getDownloadsDir = async () => path.join(await getDataDir(), "downloads");

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return Array.isArray(storyCards) ? storyCards.map(withStoryQueueRuleDefaults) : [];
};

const writeStoryCards = async (storyCards) => {
  await writeJsonFile(await getStoryCardsPath(), storyCards);
};

const readStoryQueue = async () => {
  const storyQueue = await readJsonFile(await getStoryQueuePath());
  return Array.isArray(storyQueue) ? storyQueue : [];
};

const writeStoryQueue = async (storyQueue) => {
  await writeJsonFile(await getStoryQueuePath(), storyQueue);
};

const readActivityLog = async () => {
  const activityLog = await readJsonFile(await getActivityLogPath());
  return Array.isArray(activityLog) ? activityLog : [];
};

const writeActivityLog = async (activityLog) => {
  await writeJsonFile(await getActivityLogPath(), activityLog.slice(0, 500));
};

const createActivityLogId = () =>
  `activity-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

const addActivityLogEntry = async (entry = {}) => {
  const activityLog = await readActivityLog();
  const nextEntry = {
    id: createActivityLogId(),
    createdAt: new Date().toISOString(),
    level: ["info", "warning", "error"].includes(entry.level) ? entry.level : "info",
    storyCardId: String(entry.storyCardId || "").trim(),
    storyId: String(entry.storyId || "").trim(),
    eventType: String(entry.eventType || "system").trim(),
    title: String(entry.title || "Feed Your Yoto update").trim(),
    message: String(entry.message || "").trim(),
    details: entry.details && typeof entry.details === "object" ? entry.details : {},
  };

  await writeActivityLog([nextEntry, ...activityLog].slice(0, 500));
  return nextEntry;
};

const getActivityLog = async ({ storyCardId = "", storyId = "", level = "", limit = 100 } = {}) => {
  const numericLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const activityLog = await readActivityLog();

  return activityLog
    .filter((entry) => !storyCardId || entry.storyCardId === storyCardId)
    .filter((entry) => !storyId || entry.storyId === storyId)
    .filter((entry) => !level || entry.level === level)
    .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime())
    .slice(0, numericLimit);
};

const storyStatusLabels = {
  discovered: "New story found",
  selected: "Picked for Yoto",
  skipped: "Skipped for now",
  downloading: "Getting story ready",
  downloaded: "Story ready to send",
  uploading: "Sending story to Yoto",
  uploaded: "Story sent",
  adding_to_playlist: "Adding to Story Playlist",
  synced: "Ready on Yoto",
  cleaning_local: "Tidying up",
  rotated_off: "Old story resting",
  failed: "Needs help",
};

const allowedStoryStatuses = new Set(Object.keys(storyStatusLabels));
const editableStoryStatuses = new Set(["discovered", "selected", "skipped", "rotated_off"]);
const allowedNewStoryBehaviors = new Set(["auto_pick", "choose_first"]);
const allowedPlaylistLimits = new Set([5, 10, 15, "all"]);

const normalizeNewStoryBehavior = (value) =>
  allowedNewStoryBehaviors.has(value) ? value : "auto_pick";

const normalizePlaylistLimit = (value) => {
  if (value === "all") return "all";
  const numericLimit = Number(value);
  return allowedPlaylistLimits.has(numericLimit) ? numericLimit : 10;
};

const normalizeFavoritesNeverRotate = (value) => value !== false;

const withStoryQueueRuleDefaults = (storyCard) => ({
  ...storyCard,
  newStoryBehavior: normalizeNewStoryBehavior(storyCard?.newStoryBehavior),
  playlistLimit: normalizePlaylistLimit(storyCard?.playlistLimit),
  favoritesNeverRotate: normalizeFavoritesNeverRotate(storyCard?.favoritesNeverRotate),
});

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const getSafeUrlDetails = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return {};
    return {
      host: url.hostname,
      pathname: url.pathname || "",
    };
  } catch {
    return {};
  }
};

const createDownloadError = (message, status = 502, details = {}) => {
  const error = createExposedError(message, status);
  Object.assign(error, details);
  return error;
};

const getSafePrepareDetails = (source = {}, story = {}) => {
  const originalUrlDetails = getSafeUrlDetails(story.audioUrl || source.audioUrl);
  const resolvedUrlDetails = getSafeUrlDetails(source.resolvedAudioUrl);
  return {
    step: source.step || "Getting story ready",
    technicalMessage: String(source.technicalMessage || source.message || "").slice(0, 240),
    audioUrlHost: source.audioUrlHost || originalUrlDetails.host || "",
    redirectCount: Number(source.redirectCount || 0),
    resolvedAudioUrlHost: source.resolvedAudioUrlHost || resolvedUrlDetails.host || "",
    httpStatus: Number(source.httpStatus || source.statusCode || 0),
    contentType: String(source.contentType || "").trim(),
    contentLength: Number(source.contentLength || 0),
    fileSize: Number(source.fileSize || 0),
  };
};

const validatePodcastLink = (podcastLink) => {
  const link = String(podcastLink || "").trim();

  if (!link) {
    throw createExposedError("Podcast Link is required.");
  }

  if (!isHttpUrl(link)) {
    throw createExposedError("Podcast Link should start with http or https.");
  }

  return link;
};

const decodeXmlEntities = (value) =>
  String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/<[^>]+>/g, "")
    .trim();

const getXmlTagText = (xml, tagName, { allowPrefix = false } = {}) => {
  const tagPattern = allowPrefix ? `(?:[\\w-]+:)?${tagName}` : tagName;
  const match = String(xml || "").match(
    new RegExp(`<${tagPattern}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern}>`, "i")
  );
  return match ? decodeXmlEntities(match[1]) : "";
};

const getXmlTagAttribute = (xml, tagName, attributeName, { allowPrefix = false } = {}) => {
  const tagPattern = allowPrefix ? `(?:[\\w-]+:)?${tagName}` : tagName;
  const tagMatch = String(xml || "").match(new RegExp(`<${tagPattern}\\b([^>]*)>`, "i"));
  if (!tagMatch) return "";

  const attributeMatch = tagMatch[1].match(
    new RegExp(`${attributeName}\\s*=\\s*(["'])(.*?)\\1`, "i")
  );
  return attributeMatch ? decodeXmlEntities(attributeMatch[2]) : "";
};

const extractXmlBlocks = (xml, tagName) => {
  const blocks = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match = pattern.exec(String(xml || ""));

  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(String(xml || ""));
  }

  return blocks;
};

const normalizeIsoDate = (dateValue) => {
  if (!dateValue) return "";
  const date = new Date(dateValue);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const getPodcastImageUrl = (channelXml) => {
  const itunesImage = getXmlTagAttribute(channelXml, "image", "href", { allowPrefix: true });
  const imageXml = extractXmlBlocks(channelXml, "image")[0] || "";
  const imageUrl = getXmlTagText(imageXml, "url");
  return isHttpUrl(itunesImage) ? itunesImage : isHttpUrl(imageUrl) ? imageUrl : null;
};

const getPodcastChannelXml = (xml) => {
  const channelMatch = String(xml || "").match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i);
  if (!channelMatch) {
    throw createExposedError("We could not read that Podcast Link. Try a different link.");
  }

  return channelMatch[1];
};

const getEpisodeAudio = (itemXml) => {
  const audioUrl = getXmlTagAttribute(itemXml, "enclosure", "url");
  const audioType = getXmlTagAttribute(itemXml, "enclosure", "type");
  return {
    audioUrl: isHttpUrl(audioUrl) ? audioUrl : "",
    audioType: audioType || "",
  };
};

const parsePodcastEpisodes = (channelXml) =>
  extractXmlBlocks(channelXml, "item").map((itemXml, index) => {
    const publishedAt = normalizeIsoDate(getXmlTagText(itemXml, "pubDate"));
    const audio = getEpisodeAudio(itemXml);
    return {
      index,
      title: getXmlTagText(itemXml, "title") || "Untitled story",
      description:
        getXmlTagText(itemXml, "description") ||
        getXmlTagText(itemXml, "summary", { allowPrefix: true }),
      publishedAt,
      guid: getXmlTagText(itemXml, "guid"),
      audioUrl: audio.audioUrl,
      audioType: audio.audioType,
    };
  });

const sortPodcastEpisodes = (episodes) =>
  episodes.slice().sort((first, second) => {
    if (!first.publishedAt && !second.publishedAt) return first.index - second.index;
    if (!first.publishedAt) return 1;
    if (!second.publishedAt) return -1;
    return new Date(second.publishedAt).getTime() - new Date(first.publishedAt).getTime();
  });

const parsePodcastFeed = (xml) => {
  const channelXml = getPodcastChannelXml(xml);
  const episodes = parsePodcastEpisodes(channelXml);
  const latestEpisode = sortPodcastEpisodes(episodes)[0] || null;

  const warnings = [];
  if (latestEpisode && !latestEpisode.audioUrl) {
    warnings.push("No audio file was found in the latest episode.");
  }

  return {
    title: getXmlTagText(channelXml, "title") || "Untitled podcast",
    description:
      getXmlTagText(channelXml, "description") ||
      getXmlTagText(channelXml, "summary", { allowPrefix: true }),
    imageUrl: getPodcastImageUrl(channelXml),
    latestEpisode: latestEpisode
      ? {
          title: latestEpisode.title,
          publishedAt: latestEpisode.publishedAt,
          audioUrl: latestEpisode.audioUrl,
          audioType: latestEpisode.audioType,
          guid: latestEpisode.guid,
        }
      : null,
    episodeCount: episodes.length,
    warnings,
  };
};

const parsePodcastStories = (xml) => sortPodcastEpisodes(parsePodcastEpisodes(getPodcastChannelXml(xml)));

const fetchPodcastFeedXml = async (podcastLink, redirectCount = 0) => {
  if (redirectCount > PODCAST_FEED_MAX_REDIRECTS) {
    throw createExposedError("That Podcast Link redirected too many times.", 502);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PODCAST_FEED_TIMEOUT_MS);

  try {
    const response = await fetch(podcastLink, {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "User-Agent": "FeedYourYoto/0.1 (+https://github.com/cjredmo/feed-your-yoto)",
      },
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw createExposedError("The podcast site redirected without a new link.", 502);
      }

      const nextUrl = new URL(location, podcastLink).toString();
      if (!isHttpUrl(nextUrl)) {
        throw createExposedError("Podcast Link should start with http or https.");
      }
      return fetchPodcastFeedXml(nextUrl, redirectCount + 1);
    }

    if (!response.ok) {
      throw createExposedError("The podcast site could not be reached.", 502);
    }

    const reader = response.body?.getReader();
    if (!reader) return "";

    const decoder = new TextDecoder();
    let receivedBytes = 0;
    let xml = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > PODCAST_FEED_MAX_BYTES) {
        throw createExposedError("That Podcast Link is too large to check.");
      }
      xml += decoder.decode(value, { stream: true });
    }

    xml += decoder.decode();
    return xml;
  } catch (error) {
    if (error.expose) throw error;
    if (error.name === "AbortError") {
      throw createExposedError("The podcast site took too long to answer.", 502);
    }
    throw createExposedError("The podcast site could not be reached.", 502);
  } finally {
    clearTimeout(timeout);
  }
};

const previewPodcast = async (body) => {
  const podcastLink = validatePodcastLink(body.podcastLink);
  const xml = await fetchPodcastFeedXml(podcastLink);

  try {
    return parsePodcastFeed(xml);
  } catch (error) {
    if (error.expose) throw error;
    throw createExposedError("We could not read that Podcast Link. Try a different link.");
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
    podcastTitle: String(body.podcastTitle ?? existingCard.podcastTitle ?? "").trim(),
    podcastDescription: String(body.podcastDescription ?? existingCard.podcastDescription ?? "").trim(),
    podcastImageUrl: isHttpUrl(body.podcastImageUrl ?? existingCard.podcastImageUrl)
      ? body.podcastImageUrl ?? existingCard.podcastImageUrl
      : null,
    latestEpisodeTitle: String(body.latestEpisodeTitle ?? existingCard.latestEpisodeTitle ?? "").trim(),
    latestEpisodePublishedAt: String(
      body.latestEpisodePublishedAt ?? existingCard.latestEpisodePublishedAt ?? ""
    ).trim(),
    latestEpisodeGuid: String(body.latestEpisodeGuid ?? existingCard.latestEpisodeGuid ?? "").trim(),
    latestEpisodeAudioUrl: isHttpUrl(body.latestEpisodeAudioUrl ?? existingCard.latestEpisodeAudioUrl)
      ? body.latestEpisodeAudioUrl ?? existingCard.latestEpisodeAudioUrl
      : "",
    lastPreviewedAt: String(body.lastPreviewedAt ?? existingCard.lastPreviewedAt ?? "").trim(),
    lastStoryDiscoveryAt: String(
      body.lastStoryDiscoveryAt ?? existingCard.lastStoryDiscoveryAt ?? ""
    ).trim(),
    lastStoryDiscoveryStatus: String(
      body.lastStoryDiscoveryStatus ?? existingCard.lastStoryDiscoveryStatus ?? ""
    ).trim(),
    lastStoryDiscoveryMessage: String(
      body.lastStoryDiscoveryMessage ?? existingCard.lastStoryDiscoveryMessage ?? ""
    ).trim(),
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
    newStoryBehavior: normalizeNewStoryBehavior(
      body.newStoryBehavior ?? existingCard.newStoryBehavior
    ),
    playlistLimit: normalizePlaylistLimit(body.playlistLimit ?? existingCard.playlistLimit),
    favoritesNeverRotate: normalizeFavoritesNeverRotate(
      body.favoritesNeverRotate ?? existingCard.favoritesNeverRotate
    ),
    createdAt: existingCard.createdAt || now,
    updatedAt: now,
  };
};

const isPlaylistUsedByStoryCard = (storyCards, playlistId, ignoreStoryCardId = "") =>
  storyCards.some(
    (storyCard) =>
      storyCard.id !== ignoreStoryCardId && storyCard.yotoPlaylistId === playlistId
  );

const normalizeDangerousValue = (value) => (value == null ? "" : String(value).trim());

const didDangerousStoryCardFieldChange = (currentStoryCard, body) => {
  const dangerousFields = [
    "name",
    "podcastLink",
    "yotoPlaylistId",
    "yotoPlaylistTitle",
    "yotoPlaylistImageUrl",
  ];

  return dangerousFields.some(
    (field) =>
      Object.prototype.hasOwnProperty.call(body, field) &&
      normalizeDangerousValue(body[field]) !== normalizeDangerousValue(currentStoryCard[field])
  );
};

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

  if (didDangerousStoryCardFieldChange(storyCards[index], body)) {
    if (body.setupChangeAcknowledged !== true) {
      throw createExposedError("Unlock setup details before changing this Story Card.");
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "yotoPlaylistId") &&
      body.yotoPlaylistId !== storyCards[index].yotoPlaylistId &&
      isPlaylistUsedByStoryCard(storyCards, body.yotoPlaylistId, id)
    ) {
      throw createExposedError("This Story Playlist is already connected to another Story Card.");
    }
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

const getStoryCardOrThrow = async (storyCardId) => {
  const storyCards = await readStoryCards();
  const storyCard = storyCards.find((card) => card.id === storyCardId);

  if (!storyCard) {
    throw createExposedError("Story Card not found.", 404);
  }

  return { storyCards, storyCard };
};

const sortQueuedStories = (stories) =>
  stories.slice().sort((first, second) => {
    const firstDate = first.publishedAt || first.firstSeenAt || "";
    const secondDate = second.publishedAt || second.firstSeenAt || "";

    if (!firstDate && !secondDate) return String(first.title).localeCompare(String(second.title));
    if (!firstDate) return 1;
    if (!secondDate) return -1;

    return new Date(secondDate).getTime() - new Date(firstDate).getTime();
  });

const getStoryQueueForStoryCard = async (storyCardId) => {
  const storyQueue = await readStoryQueue();
  return sortQueuedStories(storyQueue.filter((story) => story.storyCardId === storyCardId));
};

const getPlaylistPreviewForStoryCard = (storyCard, queuedStories) => {
  const rules = withStoryQueueRuleDefaults(storyCard);
  const sortedStories = sortQueuedStories(queuedStories);
  const onYotoCandidates = [];
  const newStories = [];
  const skippedStories = [];
  const oldStoryCandidates = [];
  const favorites = sortedStories.filter((story) => story.isPinned);

  sortedStories.forEach((story) => {
    const isSkipped = story.isSkipped || story.status === "skipped";
    const isSelected = story.isSelected || story.status === "selected" || story.status === "synced";
    const isDiscovered = story.status === "discovered";
    const favoriteIncluded = Boolean(story.isPinned && rules.favoritesNeverRotate);

    if (isSkipped && !favoriteIncluded) {
      skippedStories.push(story);
      return;
    }

    if (favoriteIncluded || isSelected || (rules.newStoryBehavior === "auto_pick" && isDiscovered)) {
      onYotoCandidates.push(story);
      return;
    }

    if (isDiscovered && rules.newStoryBehavior === "choose_first") {
      newStories.push(story);
      return;
    }

    if (story.status === "rotated_off") {
      oldStoryCandidates.push(story);
      return;
    }

    newStories.push(story);
  });

  const prioritizedCandidates = onYotoCandidates.slice().sort((first, second) => {
    if (first.isPinned !== second.isPinned) return first.isPinned ? -1 : 1;
    const firstDate = first.publishedAt || first.firstSeenAt || "";
    const secondDate = second.publishedAt || second.firstSeenAt || "";
    return new Date(secondDate).getTime() - new Date(firstDate).getTime();
  });

  const limit = rules.playlistLimit === "all" ? prioritizedCandidates.length : rules.playlistLimit;
  const onYotoSoon = prioritizedCandidates.slice(0, limit);
  const oldStoriesResting = [...prioritizedCandidates.slice(limit), ...oldStoryCandidates];

  return {
    onYotoSoon,
    newStories,
    skippedStories,
    oldStoriesResting,
    favorites,
    summary: {
      onYotoSoonCount: onYotoSoon.length,
      newStoryCount: newStories.length,
      favoriteCount: favorites.length,
      skippedCount: skippedStories.length,
      oldStoryCount: oldStoriesResting.length,
    },
  };
};

const getQueuedStoryKey = (storyCardId, story) => {
  const keyValue = story.guid || story.audioUrl || `${story.title || "Untitled story"}:${story.publishedAt || ""}`;
  return `${storyCardId}:${keyValue}`;
};

const createQueuedStoryId = (storyCardId, story) => {
  const hash = crypto.createHash("sha1").update(getQueuedStoryKey(storyCardId, story)).digest("hex").slice(0, 16);
  return `${storyCardId}-${hash}`;
};

const normalizeQueuedStory = (storyCardId, story, existingStory = {}) => {
  const now = new Date().toISOString();
  const existingStatus = allowedStoryStatuses.has(existingStory.status) ? existingStory.status : "discovered";
  const status = existingStatus !== "discovered" ? existingStatus : "discovered";
  const audioUrl = story.audioUrl ?? existingStory.audioUrl;

  return {
    id: existingStory.id || createQueuedStoryId(storyCardId, story),
    storyCardId,
    title: String(story.title || existingStory.title || "Untitled story").trim(),
    description: String(story.description ?? existingStory.description ?? "").trim(),
    publishedAt: String(story.publishedAt ?? existingStory.publishedAt ?? "").trim(),
    guid: String(story.guid ?? existingStory.guid ?? "").trim(),
    audioUrl: isHttpUrl(audioUrl) ? audioUrl : "",
    audioType: String(story.audioType ?? existingStory.audioType ?? "").trim(),
    resolvedAudioUrl: String(existingStory.resolvedAudioUrl || "").trim(),
    resolvedAudioUrlHost: String(existingStory.resolvedAudioUrlHost || "").trim(),
    audioUrlHost: String(existingStory.audioUrlHost || "").trim(),
    redirectCount: Number(existingStory.redirectCount || 0),
    lastPrepareHttpStatus: Number(existingStory.lastPrepareHttpStatus || 0),
    lastPrepareContentType: String(existingStory.lastPrepareContentType || "").trim(),
    lastPrepareContentLength: Number(existingStory.lastPrepareContentLength || 0),
    lastPrepareErrorStep: String(existingStory.lastPrepareErrorStep || "").trim(),
    lastPreparedAt: String(existingStory.lastPreparedAt || "").trim(),
    status,
    statusLabel: storyStatusLabels[status] || storyStatusLabels.discovered,
    downloadStatus: String(existingStory.downloadStatus || "").trim(),
    downloadedAt: String(existingStory.downloadedAt || "").trim(),
    localFilePath: String(existingStory.localFilePath || "").trim(),
    localFileName: String(existingStory.localFileName || "").trim(),
    fileSize: Number(existingStory.fileSize || 0),
    contentType: String(existingStory.contentType || "").trim(),
    sha256: String(existingStory.sha256 || "").trim(),
    downloadError: String(existingStory.downloadError || "").trim(),
    yotoUploadStatus: String(existingStory.yotoUploadStatus || "").trim(),
    yotoUploadId: String(existingStory.yotoUploadId || "").trim(),
    yotoTrackId: String(existingStory.yotoTrackId || "").trim(),
    yotoTrackUrl: String(existingStory.yotoTrackUrl || "").trim(),
    transcodedSha256: String(existingStory.transcodedSha256 || "").trim(),
    yotoTranscodeStatus: String(existingStory.yotoTranscodeStatus || "").trim(),
    yotoTranscodeRetryAfter: String(existingStory.yotoTranscodeRetryAfter || "").trim(),
    yotoTranscodeLastCheckedAt: String(existingStory.yotoTranscodeLastCheckedAt || "").trim(),
    yotoTranscodePollCount: Number(existingStory.yotoTranscodePollCount || 0),
    yotoDuration: Number(existingStory.yotoDuration || 0),
    yotoFileSize: Number(existingStory.yotoFileSize || 0),
    yotoFormat: String(existingStory.yotoFormat || "").trim(),
    yotoChannels: String(existingStory.yotoChannels || "").trim(),
    uploadedAt: String(existingStory.uploadedAt || "").trim(),
    uploadError: String(existingStory.uploadError || "").trim(),
    playlistUpdateStatus: String(existingStory.playlistUpdateStatus || "").trim(),
    playlistUpdateError: String(existingStory.playlistUpdateError || "").trim(),
    playlistUpdateRetryAfter: String(existingStory.playlistUpdateRetryAfter || "").trim(),
    playlistUpdateFailureType: String(existingStory.playlistUpdateFailureType || "").trim(),
    isPinned: Boolean(existingStory.isPinned),
    isSelected: Boolean(existingStory.isSelected),
    isSkipped: Boolean(existingStory.isSkipped),
    firstSeenAt: existingStory.firstSeenAt || now,
    updatedAt: now,
  };
};

const upsertQueuedStories = async (storyCardId, stories) => {
  const storyQueue = await readStoryQueue();
  const nextQueue = [...storyQueue];

  stories.forEach((story) => {
    const id = createQueuedStoryId(storyCardId, story);
    const index = nextQueue.findIndex((queuedStory) => queuedStory.id === id);
    const existingStory = index >= 0 ? nextQueue[index] : {};
    const queuedStory = normalizeQueuedStory(storyCardId, story, existingStory);

    if (index >= 0) {
      nextQueue[index] = queuedStory;
    } else {
      nextQueue.push(queuedStory);
    }
  });

  await writeStoryQueue(nextQueue);
  return sortQueuedStories(nextQueue.filter((story) => story.storyCardId === storyCardId));
};

const updateStoryCardDiscovery = async (storyCardId, status, message) => {
  const storyCards = await readStoryCards();
  const index = storyCards.findIndex((card) => card.id === storyCardId);

  if (index === -1) {
    throw createExposedError("Story Card not found.", 404);
  }

  storyCards[index] = normalizeStoryCard(
    {
      ...storyCards[index],
      lastStoryDiscoveryAt: new Date().toISOString(),
      lastStoryDiscoveryStatus: status,
      lastStoryDiscoveryMessage: message,
    },
    storyCards[index]
  );
  await writeStoryCards(storyCards);
  return storyCards[index];
};

const discoverStoriesForStoryCard = async (storyCardId) => {
  const { storyCard } = await getStoryCardOrThrow(storyCardId);

  try {
    const xml = await fetchPodcastFeedXml(validatePodcastLink(storyCard.podcastLink));
    const stories = parsePodcastStories(xml);
    const queuedStories = await upsertQueuedStories(storyCardId, stories);
    const message = stories.length ? `${stories.length} stories found.` : "No stories found yet.";
    await updateStoryCardDiscovery(
      storyCardId,
      "success",
      message
    );
    await addActivityLogEntry({
      level: "info",
      storyCardId,
      eventType: "story_discovered",
      title: "Found new stories",
      message,
      details: { step: "Checking Podcast Link" },
    });
    return queuedStories;
  } catch (error) {
    await updateStoryCardDiscovery(
      storyCardId,
      "error",
      error.expose ? error.message : "Could not look for stories."
    );
    throw error;
  }
};

const updateQueuedStory = async (storyCardId, storyId, body) => {
  await getStoryCardOrThrow(storyCardId);

  const storyQueue = await readStoryQueue();
  const index = storyQueue.findIndex(
    (story) => story.storyCardId === storyCardId && story.id === storyId
  );

  if (index === -1) {
    throw createExposedError("Story not found.", 404);
  }

  const nextStory = { ...storyQueue[index] };

  ["isPinned", "isSelected", "isSkipped"].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      nextStory[field] = Boolean(body[field]);
    }
  });

  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = String(body.status || "").trim();
    if (!editableStoryStatuses.has(status)) {
      throw createExposedError("That Story status cannot be changed here.");
    }
    nextStory.status = status;
  }

  if (nextStory.status === "selected") {
    nextStory.isSelected = true;
    nextStory.isSkipped = false;
  }

  if (nextStory.status === "skipped") {
    nextStory.isSkipped = true;
    nextStory.isSelected = false;
  }

  if (nextStory.status === "rotated_off") {
    nextStory.isSelected = false;
    if (!nextStory.isPinned) nextStory.isSkipped = false;
  }

  nextStory.statusLabel = storyStatusLabels[nextStory.status] || storyStatusLabels.discovered;
  nextStory.updatedAt = new Date().toISOString();
  storyQueue[index] = nextStory;
  await writeStoryQueue(storyQueue);

  return nextStory;
};


const safePathSegment = (value) =>
  String(value || "item")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "") || "item";

const getSafeAudioExtension = (audioUrl, contentType = "") => {
  const allowedExtensions = new Set([".mp3", ".m4a", ".aac", ".wav"]);

  try {
    const extension = path.extname(new URL(audioUrl).pathname).toLowerCase();
    if (allowedExtensions.has(extension)) return extension;
  } catch {
    // Fall back to the content type below.
  }

  const normalizedContentType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const contentTypeExtensions = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
  };

  return contentTypeExtensions[normalizedContentType] || ".mp3";
};

const fileExists = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const hasExistingStoryDownload = async (story) => {
  if (!story?.localFilePath || !story?.sha256 || !Number(story?.fileSize)) return false;
  return fileExists(story.localFilePath);
};

const updateQueuedStoryFields = async (storyCardId, storyId, fields) => {
  const storyQueue = await readStoryQueue();
  const index = storyQueue.findIndex(
    (story) => story.storyCardId === storyCardId && story.id === storyId
  );

  if (index === -1) {
    throw createExposedError("Story not found.", 404);
  }

  const status = fields.status || storyQueue[index].status || "discovered";
  const nextStory = {
    ...storyQueue[index],
    ...fields,
    status,
    statusLabel: storyStatusLabels[status] || storyStatusLabels.discovered,
    updatedAt: new Date().toISOString(),
  };

  if (status === "downloaded") {
    nextStory.downloadStatus = "downloaded";
    nextStory.isSkipped = false;
    nextStory.isSelected = true;
  } else if (status === "downloading") {
    nextStory.downloadStatus = "downloading";
  } else if (status === "uploading") {
    nextStory.yotoUploadStatus = "uploading";
  } else if (status === "uploaded") {
    nextStory.yotoUploadStatus = fields.yotoUploadStatus || nextStory.yotoUploadStatus || "uploaded";
    nextStory.isSkipped = false;
    nextStory.isSelected = true;
  } else if (status === "adding_to_playlist") {
    nextStory.playlistUpdateStatus = fields.playlistUpdateStatus || "adding";
  } else if (status === "synced") {
    nextStory.playlistUpdateStatus = "synced";
    nextStory.playlistUpdateError = "";
    nextStory.playlistUpdateRetryAfter = "";
    nextStory.playlistUpdateFailureType = "";
  } else if (status === "failed") {
    if (fields.downloadStatus) nextStory.downloadStatus = fields.downloadStatus;
    if (fields.yotoUploadStatus) nextStory.yotoUploadStatus = fields.yotoUploadStatus;
  }

  storyQueue[index] = nextStory;
  await writeStoryQueue(storyQueue);
  return nextStory;
};

const fetchStoryAudioToFile = async (audioUrl, storyCardId, storyId, redirectCount = 0) => {
  if (redirectCount > STORY_AUDIO_MAX_REDIRECTS) {
    throw createDownloadError("This podcast's audio link keeps moving around. Try again later.", 502, {
      audioUrl,
      redirectCount,
      step: "Getting story ready",
      technicalMessage: "Audio URL exceeded the redirect limit.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORY_AUDIO_TIMEOUT_MS);
  let tempPath = "";

  try {
    const response = await fetch(audioUrl, {
      headers: {
        Accept: "audio/*, application/octet-stream, */*",
        "User-Agent": "FeedYourYoto/0.1 (+https://github.com/cjredmo/feed-your-yoto)",
      },
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw createDownloadError("The story link moved, but did not tell us where.", 502, {
          audioUrl,
          redirectCount,
          statusCode: response.status,
          step: "Getting story ready",
          technicalMessage: "Redirect response did not include a Location header.",
        });
      }

      clearTimeout(timeout);
      const nextUrl = new URL(location, audioUrl).toString();
      if (!isHttpUrl(nextUrl)) {
        throw createDownloadError("This story does not have an audio file Feed Your Yoto can use.", 400, {
          audioUrl,
          redirectCount,
          resolvedAudioUrl: nextUrl,
          statusCode: response.status,
          step: "Getting story ready",
          technicalMessage: "Redirect target was not an http or https URL.",
        });
      }
      return fetchStoryAudioToFile(nextUrl, storyCardId, storyId, redirectCount + 1);
    }

    if (!response.ok) {
      throw createDownloadError("Feed Your Yoto could not get this story ready.", 502, {
        audioUrl,
        redirectCount,
        resolvedAudioUrl: audioUrl,
        statusCode: response.status,
        step: "Getting story ready",
        technicalMessage: `Audio request failed with HTTP ${response.status}.`,
      });
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > STORY_AUDIO_MAX_BYTES) {
      throw createDownloadError("This story is too big to get ready right now.", 400, {
        audioUrl,
        redirectCount,
        resolvedAudioUrl: audioUrl,
        contentLength,
        fileSize: contentLength,
        step: "Getting story ready",
        technicalMessage: "Audio file exceeded the configured size limit.",
      });
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw createDownloadError("Feed Your Yoto could not read this story audio.", 502, {
        audioUrl,
        redirectCount,
        resolvedAudioUrl: audioUrl,
        statusCode: response.status,
        step: "Getting story ready",
        technicalMessage: "Audio response body was not readable.",
      });
    }

    const contentType = String(response.headers.get("content-type") || "").trim();
    const extension = getSafeAudioExtension(audioUrl, contentType);
    const downloadsDir = path.join(await getDownloadsDir(), safePathSegment(storyCardId));
    await fs.mkdir(downloadsDir, { recursive: true });

    const localFileName = `${safePathSegment(storyId)}${extension}`;
    const localFilePath = path.join(downloadsDir, localFileName);
    tempPath = `${localFilePath}.part`;
    const file = await fs.open(tempPath, "w");
    const hash = crypto.createHash("sha256");
    let fileSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileSize += value.byteLength;
        if (fileSize > STORY_AUDIO_MAX_BYTES) {
          throw createDownloadError("This story is too big to get ready right now.", 400, {
            audioUrl,
            redirectCount,
            resolvedAudioUrl: audioUrl,
            contentType,
            contentLength,
            fileSize,
            step: "Getting story ready",
            technicalMessage: "Audio file exceeded the configured size limit while downloading.",
          });
        }
        hash.update(value);
        await file.write(value);
      }
    } finally {
      await file.close();
    }

    await fs.rename(tempPath, localFilePath);

    return {
      localFilePath,
      localFileName,
      fileSize,
      contentType,
      contentLength,
      sha256: hash.digest("hex"),
      downloadedAt: new Date().toISOString(),
      resolvedAudioUrl: audioUrl,
      redirectCount,
      httpStatus: response.status,
    };
  } catch (error) {
    if (tempPath) await deleteFileIfExists(tempPath);
    if (error.expose) throw error;
    if (error.name === "AbortError") {
      throw createDownloadError("The story took too long to get ready. Try again.", 502, {
        audioUrl,
        redirectCount,
        step: "Getting story ready",
        technicalMessage: "Audio request timed out.",
      });
    }
    throw createDownloadError("Feed Your Yoto could not get this story ready.", 502, {
      audioUrl,
      redirectCount,
      step: "Getting story ready",
      technicalMessage: error.message || "Unknown audio download error.",
    });
  } finally {
    clearTimeout(timeout);
  }
};

const downloadStoryAudio = async (storyCardId, storyId) => {
  await getStoryCardOrThrow(storyCardId);

  const storyQueue = await readStoryQueue();
  const story = storyQueue.find((item) => item.storyCardId === storyCardId && item.id === storyId);

  if (!story) {
    throw createExposedError("Story not found.", 404);
  }

  if (await hasExistingStoryDownload(story)) {
    const details = getSafePrepareDetails({
      redirectCount: story.redirectCount,
      resolvedAudioUrlHost: story.resolvedAudioUrlHost,
      contentType: story.contentType,
      fileSize: story.fileSize,
      httpStatus: story.lastPrepareHttpStatus,
    }, story);
    await addActivityLogEntry({
      level: "info",
      storyCardId,
      storyId,
      eventType: "story_prepare_finished",
      title: "Story ready to send",
      message: "This story is already ready for the next step.",
      details,
    });
    return updateQueuedStoryFields(storyCardId, storyId, {
      status: "downloaded",
      downloadStatus: "downloaded",
      downloadError: "",
    });
  }

  if (!isHttpUrl(story.audioUrl)) {
    const details = getSafePrepareDetails({
      step: "Getting story ready",
      technicalMessage: "Story did not include a usable http or https audio URL.",
    }, story);
    await addActivityLogEntry({
      level: "error",
      storyCardId,
      storyId,
      eventType: "story_prepare_failed",
      title: "Story needs help",
      message: "This story does not have an audio file Feed Your Yoto can use.",
      details,
    });
    return updateQueuedStoryFields(storyCardId, storyId, {
      status: "failed",
      downloadStatus: "failed",
      downloadError: "This story does not have an audio file Feed Your Yoto can use.",
      audioUrlHost: details.audioUrlHost,
      redirectCount: details.redirectCount,
      lastPrepareErrorStep: details.step,
      lastPreparedAt: new Date().toISOString(),
    });
  }

  const allowedDownloadStatuses = new Set(["selected", "discovered", "downloaded", "failed"]);
  if (!allowedDownloadStatuses.has(story.status)) {
    throw createExposedError("Pick this Story for Yoto before getting it ready.");
  }

  const startDetails = getSafePrepareDetails({ step: "Getting story ready" }, story);
  await addActivityLogEntry({
    level: "info",
    storyCardId,
    storyId,
    eventType: "story_prepare_started",
    title: "Getting story ready",
    message: "Feed Your Yoto is getting this story ready.",
    details: startDetails,
  });

  await updateQueuedStoryFields(storyCardId, storyId, {
    status: "downloading",
    downloadStatus: "downloading",
    downloadError: "",
    audioUrlHost: startDetails.audioUrlHost,
    lastPrepareErrorStep: "",
  });

  try {
    const download = await fetchStoryAudioToFile(story.audioUrl, storyCardId, storyId);
    const details = getSafePrepareDetails(download, story);
    await addActivityLogEntry({
      level: "info",
      storyCardId,
      storyId,
      eventType: "story_prepare_finished",
      title: "Story ready to send",
      message: "This story is ready for the next step.",
      details,
    });
    return updateQueuedStoryFields(storyCardId, storyId, {
      status: "downloaded",
      downloadStatus: "downloaded",
      downloadedAt: download.downloadedAt,
      lastPreparedAt: download.downloadedAt,
      localFilePath: download.localFilePath,
      localFileName: download.localFileName,
      fileSize: download.fileSize,
      contentType: download.contentType,
      sha256: download.sha256,
      downloadError: "",
      resolvedAudioUrl: "",
      audioUrlHost: details.audioUrlHost,
      resolvedAudioUrlHost: details.resolvedAudioUrlHost,
      redirectCount: details.redirectCount,
      lastPrepareHttpStatus: details.httpStatus,
      lastPrepareContentType: details.contentType,
      lastPrepareContentLength: details.contentLength,
      lastPrepareErrorStep: "",
    });
  } catch (error) {
    const details = getSafePrepareDetails(error, story);
    await addActivityLogEntry({
      level: "error",
      storyCardId,
      storyId,
      eventType: "story_prepare_failed",
      title: "Story needs help",
      message: error.expose ? error.message : "Feed Your Yoto could not get this story ready.",
      details,
    });
    return updateQueuedStoryFields(storyCardId, storyId, {
      status: "failed",
      downloadStatus: "failed",
      downloadError: error.expose ? error.message : "Feed Your Yoto could not get this story ready.",
      resolvedAudioUrl: "",
      audioUrlHost: details.audioUrlHost,
      resolvedAudioUrlHost: details.resolvedAudioUrlHost,
      redirectCount: details.redirectCount,
      lastPrepareHttpStatus: details.httpStatus,
      lastPrepareContentType: details.contentType,
      lastPrepareContentLength: details.contentLength,
      lastPrepareErrorStep: details.step,
      lastPreparedAt: new Date().toISOString(),
    });
  }
};

const downloadSelectedStories = async (storyCardId) => {
  const { storyCard } = await getStoryCardOrThrow(storyCardId);
  const queuedStories = await getStoryQueueForStoryCard(storyCardId);
  const preview = getPlaylistPreviewForStoryCard(storyCard, queuedStories);
  const candidateIds = new Set([
    ...queuedStories
      .filter((story) => story.isSelected || story.status === "selected")
      .map((story) => story.id),
    ...preview.onYotoSoon.map((story) => story.id),
  ]);
  const downloaded = [];
  const failed = [];

  for (const storyId of candidateIds) {
    const currentStory = (await getStoryQueueForStoryCard(storyCardId)).find(
      (story) => story.id === storyId
    );

    if (!currentStory || !isHttpUrl(currentStory.audioUrl)) continue;
    if (await hasExistingStoryDownload(currentStory)) continue;

    const updatedStory = await downloadStoryAudio(storyCardId, storyId);
    if (updatedStory.status === "failed") {
      failed.push(updatedStory);
    } else {
      downloaded.push(updatedStory);
    }
  }

  return {
    downloaded,
    failed,
    stories: await getStoryQueueForStoryCard(storyCardId),
  };
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

const normalizePlaylistFailureType = (value) => {
  const failureType = String(value || "").trim();
  return playlistFailureTypes.has(failureType) ? failureType : "unknown";
};

const getYotoProcessingRetryAfter = () =>
  new Date(Date.now() + YOTO_PLAYLIST_PROCESSING_RETRY_MS).toISOString();

const isYotoProcessingError = (source = {}) => {
  const text = String(
    source.technicalMessage || source.message || source.playlistUpdateError || source.uploadError || ""
  ).toLowerCase();
  return (
    source.failureType === "yoto_processing" ||
    source.yotoUploadStatus === "transcode_timeout" ||
    source.yotoUploadStatus === "processing" ||
    source.yotoTranscodeStatus === "processing" ||
    Boolean(source.yotoTranscodeRetryAfter) ||
    (text.includes("transcod") && (text.includes("timed out") || text.includes("processing"))) ||
    (text.includes("still") && text.includes("ready")) ||
    text.includes("not ready")
  );
};

const classifyPlaylistFailure = (source = {}) => {
  const explicit = normalizePlaylistFailureType(source.failureType);
  if (explicit !== "unknown") return explicit;

  const httpStatus = Number(source.httpStatus || source.statusCode || source.status || 0);
  const text = String(
    source.technicalMessage || source.message || source.data?.message || source.data?.error || ""
  ).toLowerCase();
  const step = String(source.step || "").toLowerCase();

  if (isYotoProcessingError({ ...source, technicalMessage: text })) return "yoto_processing";
  if (httpStatus === 401 || httpStatus === 403) return "yoto_auth";
  if (httpStatus === 404) return "playlist_not_found";
  if (step.includes("building") || step.includes("payload")) return "playlist_payload_error";
  if (httpStatus) return "yoto_http_error";
  return "unknown";
};

// Yoto upload support is intentionally isolated from Story Playlist updates.
// It can upload prepared audio to Yoto media, but it does not call /content update APIs.
const sanitizeDiagnosticText = (value, story = {}) => {
  let text = String(value || "");
  if (story.localFilePath) text = text.split(story.localFilePath).join("[local story file]");
  return text.replace(/https?:\/\/\S+/g, "[hidden url]").slice(0, 240);
};

const getSafeUploadDetails = (source = {}, story = {}) => ({
  step: source.step || "Sending story to Yoto",
  failureType: normalizePlaylistFailureType(source.failureType),
  httpStatus: Number(source.httpStatus || source.statusCode || source.status || 0),
  technicalMessage: sanitizeDiagnosticText(
    source.technicalMessage || source.message || "",
    story
  ),
  yotoUploadStatus: String(source.yotoUploadStatus || source.uploadStatus || "").trim(),
  yotoUploadId: String(source.yotoUploadId || story.yotoUploadId || "").trim(),
  yotoTrackId: String(source.yotoTrackId || "").trim(),
  yotoTranscodeStatus: String(source.yotoTranscodeStatus || story.yotoTranscodeStatus || "").trim(),
  yotoTranscodeRetryAfter: String(source.yotoTranscodeRetryAfter || story.yotoTranscodeRetryAfter || "").trim(),
  yotoTranscodeLastCheckedAt: String(source.yotoTranscodeLastCheckedAt || story.yotoTranscodeLastCheckedAt || "").trim(),
  yotoTranscodePollCount: Number(source.yotoTranscodePollCount || story.yotoTranscodePollCount || 0),
  hasTranscodedSha256: Boolean(source.transcodedSha256 || story.transcodedSha256 || source.yotoTrackId || story.yotoTrackId),
  yotoDuration: Number(source.yotoDuration || 0),
  yotoFileSize: Number(source.yotoFileSize || story.yotoFileSize || 0),
  contentType: String(source.contentType || story.contentType || "").trim(),
  fileSize: Number(source.fileSize || story.fileSize || 0),
});

const createYotoUploadError = (message, status = 502, details = {}, story = {}) => {
  const error = createExposedError(message, status);
  Object.assign(error, getSafeUploadDetails(details, story));
  return error;
};

const getYotoUploadEnvelope = (uploadResult = {}) =>
  uploadResult?.upload || uploadResult?.data?.upload || uploadResult?.data || uploadResult || {};

const normalizeYotoUploadResult = (uploadResult = {}) => {
  const upload = getYotoUploadEnvelope(uploadResult);
  const hasUploadUrlField = Object.prototype.hasOwnProperty.call(upload, "uploadUrl");
  const uploadUrlValue = hasUploadUrlField ? upload.uploadUrl : upload.signedUrl || "";
  const trackUrlValue = upload.trackUrl || upload.mediaUrl || upload.transcodedUrl || "";
  const inferredStatus = uploadUrlValue === null
    ? "already_available"
    : isHttpUrl(uploadUrlValue)
      ? "ready_to_upload"
      : "";

  return {
    hasUploadUrlField,
    uploadUrl: isHttpUrl(uploadUrlValue) ? uploadUrlValue : null,
    yotoUploadId: String(upload.yotoUploadId || upload.uploadId || upload.id || upload.fileId || "").trim(),
    yotoTrackId: String(upload.trackId || upload.track?.id || upload.mediaId || "").trim(),
    yotoTrackUrl: isHttpUrl(trackUrlValue) ? trackUrlValue : "",
    yotoTranscodeStatus: String(
      upload.transcodeStatus || upload.transcodingStatus || upload.processingStatus || ""
    ).trim(),
    yotoDuration: Number(upload.duration || upload.durationSeconds || upload.track?.duration || 0),
    yotoFileSize: Number(upload.fileSize || upload.size || upload.bytes || 0),
    yotoUploadStatus: String(upload.status || upload.uploadStatus || inferredStatus).trim(),
    httpStatus: Number(uploadResult.httpStatus || upload.httpStatus || 0),
  };
};

const getYotoUploadInstructions = async (story) => {
  if (!story?.sha256) {
    throw createYotoUploadError("Get this story ready before sending it to Yoto.", 400, {
      step: "Asking Yoto where to send the story",
      technicalMessage: "Missing local audio sha256 hash.",
      yotoUploadStatus: "missing_hash",
    }, story);
  }

  const tokens = await getAuthenticatedTokens();
  if (!tokens) {
    throw createYotoUploadError("Feed Your Yoto needs to reconnect to Yoto.", 401, {
      step: "Asking Yoto where to send the story",
      technicalMessage: "No authenticated Yoto access token was available.",
      yotoUploadStatus: "not_authenticated",
    }, story);
  }

  const query = new URLSearchParams({ sha256: story.sha256 });
  if (story.localFileName) query.set("filename", story.localFileName);

  try {
    const response = await getYotoJsonWithRefresh(
      `/media/transcode/audio/uploadUrl?${query.toString()}`,
      tokens
    );
    const instructions = normalizeYotoUploadResult(response.data);

    if (!instructions.yotoUploadId) {
      throw createYotoUploadError("Yoto could not accept this story right now.", 502, {
        step: "Asking Yoto where to send the story",
        technicalMessage: "Upload URL response did not include uploadId.",
        yotoUploadStatus: instructions.yotoUploadStatus || "missing_upload_id",
      }, story);
    }

    if (!instructions.hasUploadUrlField) {
      throw createYotoUploadError("Yoto could not accept this story right now.", 502, {
        step: "Asking Yoto where to send the story",
        technicalMessage: "Upload URL response did not include uploadUrl.",
        yotoUploadStatus: instructions.yotoUploadStatus || "missing_upload_url",
      }, story);
    }

    return instructions;
  } catch (error) {
    if (error.expose) throw error;
    const authProblem = error.status === 401 || error.status === 403;
    throw createYotoUploadError(
      authProblem
        ? "Feed Your Yoto needs to reconnect to Yoto."
        : "Yoto could not accept this story right now.",
      authProblem ? 401 : 502,
      {
        step: "Asking Yoto where to send the story",
        httpStatus: error.status,
        technicalMessage: error.data?.message || error.data?.error || error.message,
        yotoUploadStatus: authProblem ? "not_authenticated" : "instruction_failed",
      },
      story
    );
  }
};

const getNormalizedYotoChannels = (value) => {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "mono" || normalized === "1") return "mono";
  if (normalized === "stereo" || normalized === "2") return "stereo";
  return "";
};

const getYotoFormatFromStory = (story = {}) => {
  const explicitFormat = String(story.yotoFormat || "").trim().toLowerCase();
  if (explicitFormat) return explicitFormat;

  const contentType = String(story.contentType || "").split(";")[0].trim().toLowerCase();
  const contentTypeFormats = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
  };
  if (contentTypeFormats[contentType]) return contentTypeFormats[contentType];

  const extension = path.extname(String(story.localFileName || "")).replace(/^\./, "").toLowerCase();
  return extension || "mp3";
};

const normalizeYotoTranscodeResult = (data = {}, uploadResult = {}) => {
  const transcode = data?.transcode || data || {};
  const mediaInfo = transcode.transcodedInfo || transcode.info || transcode.mediaInfo || {};
  const transcodedSha256 = String(
    transcode.transcodedSha256 ||
      transcode.sha256 ||
      transcode.transcodedHash ||
      ""
  ).trim();

  return {
    ...uploadResult,
    transcodedSha256: transcodedSha256 || uploadResult.transcodedSha256 || "",
    yotoTrackId: transcodedSha256 || uploadResult.yotoTrackId || "",
    yotoTrackUrl: transcodedSha256 ? `yoto:#${transcodedSha256}` : uploadResult.yotoTrackUrl || "",
    yotoTranscodeStatus: transcodedSha256
      ? "ready"
      : String(transcode.status || uploadResult.yotoTranscodeStatus || "processing").trim(),
    yotoDuration: Number(mediaInfo.duration || transcode.duration || uploadResult.yotoDuration || 0),
    yotoFileSize: Number(mediaInfo.fileSize || transcode.fileSize || uploadResult.yotoFileSize || 0),
    yotoFormat: String(mediaInfo.format || transcode.format || uploadResult.yotoFormat || "").trim(),
    yotoChannels: getNormalizedYotoChannels(mediaInfo.channels || transcode.channels || uploadResult.yotoChannels),
  };
};

const isYotoTranscodeFailureStatus = (status) => {
  const normalized = String(status || "").trim().toLowerCase();
  return ["failed", "failure", "error", "errored", "rejected"].includes(normalized);
};

const pollYotoUploadIfNeeded = async (uploadResult, story = {}, options = {}) => {
  if (uploadResult.yotoTrackUrl && String(uploadResult.yotoTrackUrl).startsWith("yoto:#")) {
    return uploadResult;
  }

  if (!uploadResult.yotoUploadId) {
    throw createYotoUploadError("Yoto could not accept this story right now.", 502, {
      step: "Checking Yoto story audio",
      technicalMessage: "Missing uploadId for transcode polling.",
      yotoUploadStatus: "missing_upload_id",
    }, story);
  }

  let tokens = await getAuthenticatedTokens();
  if (!tokens) {
    throw createYotoUploadError("Feed Your Yoto needs to reconnect to Yoto.", 401, {
      step: "Checking Yoto story audio",
      technicalMessage: "No authenticated Yoto access token was available.",
      yotoUploadStatus: "not_authenticated",
    }, story);
  }

  const maxAttempts = Math.max(Number(options.maxAttempts || YOTO_TRANSCODE_MAX_ATTEMPTS), 1);
  const intervalMs = Math.max(Number(options.intervalMs ?? YOTO_TRANSCODE_POLL_INTERVAL_MS), 0);
  let lastHttpStatus = 0;
  let lastTechnicalMessage = "Transcoding timed out before transcodedSha256 was returned.";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await getYotoJsonWithRefresh(
        `/media/upload/${encodeURIComponent(uploadResult.yotoUploadId)}/transcoded?loudnorm=false`,
        tokens
      );
      tokens = response.tokens;
      const normalized = normalizeYotoTranscodeResult(response.data, uploadResult);
      if (isYotoTranscodeFailureStatus(normalized.yotoTranscodeStatus)) {
        throw createYotoUploadError("Yoto could not get this story ready.", 502, {
          step: "Waiting on Yoto",
          technicalMessage: "Yoto reported a failed transcode status.",
          yotoUploadStatus: "failed",
          yotoUploadId: uploadResult.yotoUploadId,
          yotoTranscodeStatus: "failed",
          yotoTranscodeLastCheckedAt: new Date().toISOString(),
          yotoTranscodePollCount: Number(story.yotoTranscodePollCount || 0) + attempt + 1,
        }, story);
      }
      if (normalized.yotoTrackUrl) return normalized;
      lastTechnicalMessage = `Yoto transcode status: ${normalized.yotoTranscodeStatus || "processing"}.`;
    } catch (error) {
      if (error.expose && error.yotoTranscodeStatus === "failed") throw error;
      lastHttpStatus = Number(error.status || error.httpStatus || 0);
      lastTechnicalMessage = error.data?.message || error.data?.error || error.technicalMessage || error.message || lastTechnicalMessage;
      if (![404, 409, 425].includes(Number(error.status || 0))) {
        throw createYotoUploadError("Yoto could not accept this story right now.", 502, {
          step: "Checking Yoto story audio",
          httpStatus: error.status,
          technicalMessage: error.data?.message || error.data?.error || error.message,
          yotoUploadStatus: "transcode_check_failed",
        }, story);
      }
    }

    if (attempt < maxAttempts - 1 && intervalMs) await wait(intervalMs);
  }

  throw createYotoUploadError(YOTO_PROCESSING_MESSAGE, 202, {
    step: "Waiting on Yoto",
    failureType: "yoto_processing",
    httpStatus: lastHttpStatus,
    technicalMessage: lastTechnicalMessage,
    yotoUploadStatus: "processing",
    yotoUploadId: uploadResult.yotoUploadId,
    yotoTranscodeStatus: "processing",
    yotoTranscodeRetryAfter: getYotoProcessingRetryAfter(),
    yotoTranscodeLastCheckedAt: new Date().toISOString(),
    yotoTranscodePollCount: Number(story.yotoTranscodePollCount || 0) + maxAttempts,
  }, story);
};


const uploadStoryFileToYoto = async (story) => {
  const fileStats = await fs.stat(story.localFilePath);
  const instructions = await getYotoUploadInstructions({
    ...story,
    yotoFileSize: story.fileSize || fileStats.size,
  });
  const safeInstructions = {
    ...instructions,
    uploadUrl: undefined,
    yotoFileSize: instructions.yotoFileSize || story.fileSize || fileStats.size,
    contentType: story.contentType,
    fileSize: story.fileSize || fileStats.size,
  };

  if (!instructions.uploadUrl) {
    return pollYotoUploadIfNeeded({
      ...safeInstructions,
      yotoUploadStatus: "uploaded",
      yotoTranscodeStatus: instructions.yotoUploadStatus || "already_available",
    }, story);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOTO_UPLOAD_TIMEOUT_MS);

  try {
    const fileBuffer = await fs.readFile(story.localFilePath);
    // TODO: Yoto documents a signed upload URL but not the HTTP method in the generated page.
    // Keep this isolated until real-account testing confirms PUT is the correct signed URL method.
    const response = await fetch(instructions.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": story.contentType || "application/octet-stream",
      },
      body: fileBuffer,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw createYotoUploadError("Yoto could not accept this story right now.", 502, {
        step: "Sending story to Yoto",
        httpStatus: response.status,
        technicalMessage: text || `Signed upload URL returned HTTP ${response.status}.`,
        yotoUploadStatus: "upload_failed",
      }, story);
    }

    return pollYotoUploadIfNeeded({
      ...safeInstructions,
      httpStatus: response.status,
      yotoUploadStatus: "uploaded",
    }, story);
  } catch (error) {
    if (error.expose) throw error;
    if (error.name === "AbortError") {
      throw createYotoUploadError("Yoto could not accept this story right now.", 502, {
        step: "Sending story to Yoto",
        technicalMessage: "Signed upload URL request timed out.",
        yotoUploadStatus: "timed_out",
      }, story);
    }
    throw createYotoUploadError("Feed Your Yoto could not send this story to Yoto.", 502, {
      step: "Sending story to Yoto",
      technicalMessage: error.message || "Unknown Yoto upload error.",
      yotoUploadStatus: "upload_failed",
    }, story);
  } finally {
    clearTimeout(timeout);
  }
};

const getStoryDownloadUploadProblem = async (story) => {
  if (!story?.localFilePath || !Number(story?.fileSize) || !story?.contentType || !story?.sha256) {
    return {
      message: "Get this story ready before sending it to Yoto.",
      technicalMessage: "Story is missing local download metadata required for upload.",
      yotoUploadStatus: "missing_download_metadata",
    };
  }

  if (!(await fileExists(story.localFilePath))) {
    return {
      message: "The downloaded story file is missing. Try preparing it again.",
      technicalMessage: "Local story audio file was not found on disk.",
      yotoUploadStatus: "missing_file",
    };
  }

  return null;
};

const markStoryUploadFailed = async (storyCardId, storyId, story, message, details = {}) => {
  const safeDetails = getSafeUploadDetails({
    step: "Sending story to Yoto",
    yotoUploadStatus: "failed",
    ...details,
  }, story);

  await addActivityLogEntry({
    level: "error",
    storyCardId,
    storyId,
    eventType: "story_upload_failed",
    title: "Story needs help",
    message,
    details: safeDetails,
  });

  return updateQueuedStoryFields(storyCardId, storyId, {
    status: "failed",
    yotoUploadStatus: safeDetails.yotoUploadStatus || "failed",
    uploadError: message,
  });
};

const uploadDownloadedStoryToYoto = async (storyCardId, storyId) => {
  await getStoryCardOrThrow(storyCardId);

  const storyQueue = await readStoryQueue();
  const story = storyQueue.find((item) => item.storyCardId === storyCardId && item.id === storyId);
  if (!story) {
    throw createExposedError("Story not found.", 404);
  }

  if (hasPendingYotoTranscode(story)) {
    return checkYotoTranscodeStatusForStory(storyCardId, storyId, { poll: true });
  }

  const uploadProblem = await getStoryDownloadUploadProblem(story);
  if (uploadProblem) {
    return markStoryUploadFailed(storyCardId, storyId, story, uploadProblem.message, {
      technicalMessage: uploadProblem.technicalMessage,
      yotoUploadStatus: uploadProblem.yotoUploadStatus,
    });
  }

  await updateQueuedStoryFields(storyCardId, storyId, {
    status: "uploading",
    yotoUploadStatus: "uploading",
    uploadError: "",
  });

  const startDetails = getSafeUploadDetails({
    step: "Sending story to Yoto",
    yotoUploadStatus: "uploading",
  }, story);
  await addActivityLogEntry({
    level: "info",
    storyCardId,
    storyId,
    eventType: "story_upload_started",
    title: "Sending story to Yoto",
    message: "Feed Your Yoto is sending this story to Yoto.",
    details: startDetails,
  });

  try {
    const upload = await uploadStoryFileToYoto(story);
    return markYotoTranscodeReady(storyCardId, storyId, story, {
      ...upload,
      step: "Sending story to Yoto",
      yotoUploadStatus: "uploaded",
    });
  } catch (error) {
    const details = getSafeUploadDetails(error, story);

    if (isYotoProcessingError(details) && details.yotoUploadId) {
      return markYotoTranscodeWaiting(storyCardId, storyId, story, details);
    }

    const message = error.expose ? error.message : "Feed Your Yoto could not send this story to Yoto.";
    return markStoryUploadFailed(storyCardId, storyId, story, message, details);
  }
};

const uploadReadyStoriesToYoto = async (storyCardId) => {
  await getStoryCardOrThrow(storyCardId);
  const uploaded = [];
  const waiting = [];
  const failed = [];
  const readyStories = (await getStoryQueueForStoryCard(storyCardId)).filter(
    (story) => story.status === "downloaded"
  );

  for (const story of readyStories) {
    const updatedStory = await uploadDownloadedStoryToYoto(storyCardId, story.id);
    if (updatedStory.status === "uploaded" && updatedStory.yotoUploadStatus === "processing") {
      waiting.push(updatedStory);
    } else if (updatedStory.status === "uploaded") {
      uploaded.push(updatedStory);
    } else if (updatedStory.status === "failed") {
      failed.push(updatedStory);
    }
  }

  return {
    uploaded,
    waiting,
    failed,
    stories: await getStoryQueueForStoryCard(storyCardId),
  };
};


const getSafeStringArray = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 50);

const getSafePlaylistMetadataSummary = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      storyId: String(item.storyId || item.id || "").trim(),
      title: sanitizeDiagnosticText(item.title || ""),
      hasYotoUploadId: Boolean(item.yotoUploadId),
      hasYotoTrackId: Boolean(item.yotoTrackId),
      hasYotoTrackUrl: Boolean(String(item.yotoTrackUrl || "").startsWith("yoto:#")),
      hasTranscodedSha256: Boolean(item.transcodedSha256 || item.yotoTrackId),
      yotoUploadStatus: String(item.yotoUploadStatus || "").trim(),
      yotoTranscodeStatus: String(item.yotoTranscodeStatus || "").trim(),
      yotoTranscodePollCount: Number(item.yotoTranscodePollCount || 0),
      yotoDuration: Number(item.yotoDuration || 0),
      yotoFileSize: Number(item.yotoFileSize || item.fileSize || 0),
      yotoFormat: String(item.yotoFormat || "").trim(),
      missingMetadataFields: getSafeStringArray(item.missingMetadataFields),
    }))
    .slice(0, 50);

const getSafeYotoResponseShape = (value = {}) => {
  const card = value?.card || value || {};
  const chapters = asArray(card?.content?.chapters);
  const tracks = chapters.flatMap((chapter) => asArray(chapter?.tracks));
  return {
    hasCard: Boolean(value?.card || card?.cardId || card?._id || card?.id),
    cardId: String(card?.cardId || card?.id || card?._id || "").trim(),
    contentKeys: card?.content && typeof card.content === "object" ? Object.keys(card.content).slice(0, 20) : [],
    metadataKeys: card?.metadata && typeof card.metadata === "object" ? Object.keys(card.metadata).slice(0, 20) : [],
    chapterCount: chapters.length,
    trackCount: tracks.length,
    populatedTrackCount: tracks.filter((track) => String(track?.trackUrl || "").startsWith("yoto:#")).length,
  };
};

const getSafePlaylistDetails = (source = {}, storyCard = {}) => {
  const failureType = classifyPlaylistFailure(source);
  return {
    step: source.step || "Adding to Story Playlist",
    failureType,
    storyCardId: String(source.storyCardId || storyCard.id || "").trim(),
    yotoPlaylistId: String(source.yotoPlaylistId || storyCard.yotoPlaylistId || "").trim(),
    yotoPlaylistTitle: String(source.yotoPlaylistTitle || storyCard.yotoPlaylistTitle || storyCard.name || "").trim(),
    trackCount: Number(source.trackCount || source.builtTrackCount || 0),
    intendedTrackCount: Number(source.intendedTrackCount || source.intendedStoriesCount || 0),
    readyTrackCount: Number(source.readyTrackCount || source.readyStoriesCount || 0),
    builtTrackCount: Number(source.builtTrackCount || source.trackCount || 0),
    sentTrackCount: Number(source.sentTrackCount || 0),
    verifiedTrackCount: Number(source.verifiedTrackCount || 0),
    syncedCount: Number(source.syncedCount || 0),
    storyIdsAttempted: getSafeStringArray(source.storyIdsAttempted || source.storyIds),
    storyTitlesIncluded: getSafeStringArray(source.storyTitlesIncluded || source.storyTitles).map(sanitizeDiagnosticText),
    missingMetadataFields: getSafeStringArray(source.missingMetadataFields),
    uploadTrackMetadata: getSafePlaylistMetadataSummary(source.uploadTrackMetadata || source.trackMetadataUsed),
    responseShape: source.responseShape && typeof source.responseShape === "object" ? source.responseShape : undefined,
    verifiedResponseShape: source.verifiedResponseShape && typeof source.verifiedResponseShape === "object" ? source.verifiedResponseShape : undefined,
    playlistUpdateStatus: String(source.playlistUpdateStatus || "").trim(),
    playlistUpdateRetryAfter: String(source.playlistUpdateRetryAfter || source.retryAfter || "").trim(),
    yotoUploadStatus: String(source.yotoUploadStatus || "").trim(),
    yotoTranscodeStatus: String(source.yotoTranscodeStatus || "").trim(),
    yotoTranscodeRetryAfter: String(source.yotoTranscodeRetryAfter || "").trim(),
    yotoTranscodeLastCheckedAt: String(source.yotoTranscodeLastCheckedAt || "").trim(),
    yotoTranscodePollCount: Number(source.yotoTranscodePollCount || 0),
    httpStatus: Number(source.httpStatus || source.statusCode || source.status || 0),
    technicalMessage: sanitizeDiagnosticText(
      source.technicalMessage || source.data?.message || source.data?.error || source.message || ""
    ),
  };
};

const createYotoPlaylistUpdateError = (message, status = 502, details = {}, storyCard = {}) => {
  const error = createExposedError(message, status);
  Object.assign(error, getSafePlaylistDetails(details, storyCard));
  return error;
};

const getTranscodedSha256FromStory = (story = {}) => {
  const explicitSha = String(story.transcodedSha256 || story.yotoTrackId || "").trim().replace(/^yoto:#/, "");
  if (explicitSha) return explicitSha;

  const trackUrl = String(story.yotoTrackUrl || "").trim();
  if (trackUrl.startsWith("yoto:#")) return trackUrl.replace(/^yoto:#/, "");
  return "";
};

const getYotoTrackUrlFromStory = (story = {}) => {
  const transcodedSha256 = getTranscodedSha256FromStory(story);
  if (transcodedSha256) return `yoto:#${transcodedSha256}`;
  return "";
};

const hasUsableYotoTrackMetadata = (story = {}) =>
  Boolean(
    getTranscodedSha256FromStory(story) &&
      getYotoTrackUrlFromStory(story) &&
      Number(story.yotoFileSize || story.fileSize || 0)
  );

const hasPendingYotoTranscode = (story = {}) =>
  Boolean(story.yotoUploadId && !hasUsableYotoTrackMetadata(story));

const getStoredYotoUploadForStory = (story = {}) => ({
  yotoUploadId: story.yotoUploadId,
  yotoTrackId: story.yotoTrackId,
  yotoTrackUrl: story.yotoTrackUrl,
  transcodedSha256: story.transcodedSha256,
  yotoTranscodeStatus: story.yotoTranscodeStatus,
  yotoDuration: story.yotoDuration,
  yotoFileSize: story.yotoFileSize,
  yotoFormat: story.yotoFormat,
  yotoChannels: story.yotoChannels,
  contentType: story.contentType,
  fileSize: story.fileSize,
});

const getQueuedStoryById = async (storyCardId, storyId) => {
  const storyQueue = await readStoryQueue();
  return storyQueue.find((item) => item.storyCardId === storyCardId && item.id === storyId) || null;
};

const markYotoTranscodeWaiting = async (storyCardId, storyId, story, details = {}) => {
  const now = details.yotoTranscodeLastCheckedAt || new Date().toISOString();
  const retryAfter = details.yotoTranscodeRetryAfter || details.playlistUpdateRetryAfter || getYotoProcessingRetryAfter();
  const pollCount = Number(details.yotoTranscodePollCount || story.yotoTranscodePollCount || 0) || 0;

  if (pollCount > YOTO_TRANSCODE_MAX_RETRY_WINDOWS * YOTO_TRANSCODE_MAX_ATTEMPTS) {
    return markYotoTranscodeFailed(storyCardId, storyId, story,
      "Yoto is taking longer than expected getting this story ready. Try again in a little while.",
      {
        ...details,
        step: "Waiting on Yoto",
        technicalMessage: "Transcode retry window limit was reached.",
        yotoUploadStatus: "failed",
        yotoTranscodeStatus: "failed",
      }
    );
  }

  const safeDetails = getSafeUploadDetails({
    ...details,
    step: "Waiting on Yoto",
    failureType: "yoto_processing",
    yotoUploadStatus: "processing",
    yotoTranscodeStatus: "processing",
    yotoTranscodeRetryAfter: retryAfter,
    yotoTranscodeLastCheckedAt: now,
    yotoTranscodePollCount: pollCount,
  }, story);

  await addActivityLogEntry({
    level: "warning",
    storyCardId,
    storyId,
    eventType: "story_transcode_waiting",
    title: "Waiting on Yoto",
    message: YOTO_PROCESSING_MESSAGE,
    details: safeDetails,
  });

  return updateQueuedStoryFields(storyCardId, storyId, {
    status: "uploaded",
    yotoUploadStatus: "processing",
    yotoUploadId: details.yotoUploadId || story.yotoUploadId || "",
    yotoTranscodeStatus: "processing",
    yotoTranscodeRetryAfter: retryAfter,
    yotoTranscodeLastCheckedAt: now,
    yotoTranscodePollCount: pollCount,
    yotoFileSize: details.yotoFileSize || story.yotoFileSize || story.fileSize || 0,
    yotoFormat: details.yotoFormat || story.yotoFormat || getYotoFormatFromStory(story),
    uploadedAt: story.uploadedAt || new Date().toISOString(),
    uploadError: "",
    playlistUpdateStatus: "waiting",
    playlistUpdateError: YOTO_PROCESSING_MESSAGE,
    playlistUpdateRetryAfter: retryAfter,
    playlistUpdateFailureType: "yoto_processing",
  });
};

const markYotoTranscodeReady = async (storyCardId, storyId, story, upload = {}) => {
  const now = new Date().toISOString();
  const transcodedSha256 = String(
    upload.transcodedSha256 || upload.yotoTrackId || getTranscodedSha256FromStory(upload) || getTranscodedSha256FromStory(story)
  ).trim().replace(/^yoto:#/, "");
  const yotoTrackUrl = transcodedSha256 ? `yoto:#${transcodedSha256}` : upload.yotoTrackUrl || story.yotoTrackUrl || "";
  const details = getSafeUploadDetails({
    ...upload,
    step: "Waiting on Yoto",
    yotoUploadStatus: "uploaded",
    yotoTranscodeStatus: "ready",
    yotoTranscodeLastCheckedAt: now,
    yotoTranscodePollCount: Number(story.yotoTranscodePollCount || 0) + 1,
    transcodedSha256,
  }, story);

  await addActivityLogEntry({
    level: "info",
    storyCardId,
    storyId,
    eventType: "story_transcode_ready",
    title: "Story sent",
    message: "Yoto finished getting this story ready.",
    details,
  });

  return updateQueuedStoryFields(storyCardId, storyId, {
    status: "uploaded",
    yotoUploadStatus: "uploaded",
    yotoUploadId: upload.yotoUploadId || story.yotoUploadId || "",
    transcodedSha256,
    yotoTrackId: transcodedSha256 || upload.yotoTrackId || story.yotoTrackId || "",
    yotoTrackUrl,
    yotoTranscodeStatus: "ready",
    yotoTranscodeRetryAfter: "",
    yotoTranscodeLastCheckedAt: now,
    yotoTranscodePollCount: Number(story.yotoTranscodePollCount || 0) + 1,
    yotoDuration: upload.yotoDuration || story.yotoDuration || 0,
    yotoFileSize: upload.yotoFileSize || story.yotoFileSize || story.fileSize || 0,
    yotoFormat: upload.yotoFormat || story.yotoFormat || getYotoFormatFromStory(story),
    yotoChannels: upload.yotoChannels || story.yotoChannels || "",
    uploadedAt: story.uploadedAt || now,
    uploadError: "",
    playlistUpdateStatus: "",
    playlistUpdateError: "",
    playlistUpdateRetryAfter: "",
    playlistUpdateFailureType: "",
  });
};

const markYotoTranscodeFailed = async (storyCardId, storyId, story, message, details = {}) => {
  const now = new Date().toISOString();
  const safeDetails = getSafeUploadDetails({
    ...details,
    step: "Waiting on Yoto",
    yotoUploadStatus: "failed",
    yotoTranscodeStatus: "failed",
    yotoTranscodeLastCheckedAt: now,
    yotoTranscodePollCount: Number(details.yotoTranscodePollCount || story.yotoTranscodePollCount || 0) + 1,
  }, story);

  await addActivityLogEntry({
    level: "error",
    storyCardId,
    storyId,
    eventType: "story_transcode_failed",
    title: "Story needs help",
    message,
    details: safeDetails,
  });

  return updateQueuedStoryFields(storyCardId, storyId, {
    status: "failed",
    yotoUploadStatus: "failed",
    yotoTranscodeStatus: "failed",
    yotoTranscodeRetryAfter: "",
    yotoTranscodeLastCheckedAt: now,
    yotoTranscodePollCount: safeDetails.yotoTranscodePollCount,
    uploadError: message,
    playlistUpdateStatus: "failed",
    playlistUpdateError: message,
    playlistUpdateRetryAfter: "",
    playlistUpdateFailureType: "yoto_processing",
  });
};

const checkYotoTranscodeStatusForStory = async (storyCardId, storyId, { poll = false } = {}) => {
  const story = await getQueuedStoryById(storyCardId, storyId);
  if (!story) throw createExposedError("Story not found.", 404);
  if (hasUsableYotoTrackMetadata(story)) return story;

  if (!story.yotoUploadId) {
    return markYotoTranscodeFailed(storyCardId, storyId, story,
      "Feed Your Yoto could not find the Yoto upload for this story.",
      {
        technicalMessage: "Story had no uploadId to check transcode status.",
        yotoUploadStatus: "failed",
        yotoTranscodeStatus: "failed",
      }
    );
  }

  try {
    const upload = await pollYotoUploadIfNeeded(getStoredYotoUploadForStory(story), story, {
      maxAttempts: poll ? YOTO_TRANSCODE_MAX_ATTEMPTS : 1,
      intervalMs: poll ? YOTO_TRANSCODE_POLL_INTERVAL_MS : 0,
    });
    return markYotoTranscodeReady(storyCardId, storyId, story, upload);
  } catch (error) {
    const details = getSafeUploadDetails(error, story);
    if (isYotoProcessingError(details)) {
      return markYotoTranscodeWaiting(storyCardId, storyId, story, details);
    }

    const message = error.expose ? error.message : "Yoto could not get this story ready.";
    return markYotoTranscodeFailed(storyCardId, storyId, story, message, details);
  }
};

const ensureYotoTrackMetadataForStory = async (storyCardId, story) => {
  if (hasUsableYotoTrackMetadata(story)) return story;
  if (!story.yotoUploadId) return story;
  return checkYotoTranscodeStatusForStory(storyCardId, story.id);
};

const getYotoPlaylistCardFromResponse = (data) => data?.card || data;

const getYotoPlaylistContent = async (storyCard) => {
  const playlistId = String(storyCard.yotoPlaylistId || "").trim();
  if (!playlistId) {
    throw createYotoPlaylistUpdateError("Feed Your Yoto could not find this Story Playlist.", 404, {
      step: "Finding Story Playlist",
      failureType: "playlist_not_found",
      yotoPlaylistId: playlistId,
      technicalMessage: "Story Card did not include a selected Yoto playlist id.",
    }, storyCard);
  }

  let tokens = await getAuthenticatedTokens();
  if (!tokens) {
    throw createYotoPlaylistUpdateError("Feed Your Yoto needs to reconnect to Yoto.", 401, {
      step: "Finding Story Playlist",
      failureType: "yoto_auth",
      yotoPlaylistId: playlistId,
      technicalMessage: "No authenticated Yoto access token was available.",
    }, storyCard);
  }

  try {
    const response = await getYotoJsonWithRefresh(`/content/${encodeURIComponent(playlistId)}`, tokens);
    const card = getYotoPlaylistCardFromResponse(response.data);

    if (!card?.cardId && !card?.id && !card?._id) {
      throw createYotoPlaylistUpdateError("Feed Your Yoto could not find this Story Playlist.", 404, {
        step: "Finding Story Playlist",
        failureType: "playlist_not_found",
        yotoPlaylistId: playlistId,
        technicalMessage: "Yoto content response did not include a card object.",
      }, storyCard);
    }

    if (card.deleted === true || hasStreamingMedia(card)) {
      throw createYotoPlaylistUpdateError("Feed Your Yoto could not update this Story Playlist safely.", 400, {
        step: "Checking Story Playlist",
        failureType: "playlist_payload_error",
        yotoPlaylistId: playlistId,
        technicalMessage: card.deleted === true
          ? "Selected Yoto content is deleted."
          : "Selected Yoto content contains streaming media.",
      }, storyCard);
    }

    return { card, tokens: response.tokens };
  } catch (error) {
    if (error.expose) throw error;
    const notFound = error.status === 404;
    const authProblem = error.status === 401 || error.status === 403;
    throw createYotoPlaylistUpdateError(
      notFound
        ? "Feed Your Yoto could not find this Story Playlist."
        : authProblem
          ? "Feed Your Yoto needs to reconnect to Yoto."
          : "Feed Your Yoto could not update this Story Playlist right now.",
      notFound ? 404 : authProblem ? 401 : 502,
      {
        step: "Finding Story Playlist",
        failureType: notFound ? "playlist_not_found" : authProblem ? "yoto_auth" : classifyPlaylistFailure(error),
        yotoPlaylistId: playlistId,
        httpStatus: error.status,
        technicalMessage: error.data?.message || error.data?.error || error.message,
      },
      storyCard
    );
  }
};

const formatYotoTrackKey = (index) => String(index + 1).padStart(2, "0");

const getMissingYotoTrackMetadataFields = (story = {}) => {
  const missing = [];
  if (!String(story.title || "").trim()) missing.push("title");
  if (!getTranscodedSha256FromStory(story)) missing.push("transcodedSha256");
  if (!getYotoTrackUrlFromStory(story)) missing.push("yotoTrackUrl");
  if (!Number(story.yotoFileSize || story.fileSize || 0)) missing.push("fileSize");
  if (!getYotoFormatFromStory(story)) missing.push("format");
  return missing;
};

const buildYotoPlaylistTrackFromStory = (story, index) => {
  const missingMetadataFields = getMissingYotoTrackMetadataFields(story);
  if (missingMetadataFields.length) {
    throw createYotoPlaylistUpdateError("Feed Your Yoto could not build playlist tracks from the uploaded stories.", 400, {
      step: "Building Story Playlist",
      failureType: "playlist_payload_error",
      storyIdsAttempted: [story.id],
      missingMetadataFields,
      uploadTrackMetadata: [{ ...story, missingMetadataFields }],
      technicalMessage: `Story was missing required Yoto track metadata: ${missingMetadataFields.join(", ")}.`,
    });
  }

  const key = formatYotoTrackKey(index);
  const track = {
    key,
    title: String(story.title || "Untitled story").trim(),
    trackUrl: getYotoTrackUrlFromStory(story),
    overlayLabel: String(index + 1),
    duration: Number(story.yotoDuration || 0),
    fileSize: Number(story.yotoFileSize || story.fileSize || 0),
    format: getYotoFormatFromStory(story),
    type: "audio",
    display: {
      icon16x16: null,
    },
  };

  const channels = getNormalizedYotoChannels(story.yotoChannels);
  if (channels) track.channels = channels;
  return track;
};

const buildYotoPlaylistTracksFromStories = (stories = []) => {
  const tracks = [];
  const readyStories = [];
  const skippedStories = [];

  stories.forEach((story) => {
    const missingMetadataFields = getMissingYotoTrackMetadataFields(story);
    if (missingMetadataFields.length) {
      skippedStories.push({ ...story, missingMetadataFields });
      return;
    }

    const track = buildYotoPlaylistTrackFromStory(story, tracks.length);
    tracks.push(track);
    readyStories.push(story);
  });

  return { tracks, readyStories, skippedStories };
};

const buildYotoPlaylistChapters = (currentCard, storyCard, tracks) => {
  const existingChapters = asArray(currentCard?.content?.chapters).filter(
    (chapter) => chapter && typeof chapter === "object"
  );
  const chapterTemplate = existingChapters[0] || {};
  const display = chapterTemplate.display && typeof chapterTemplate.display === "object"
    ? chapterTemplate.display
    : { icon16x16: null };

  return [
    {
      ...chapterTemplate,
      key: String(chapterTemplate.key || "01"),
      title: String(chapterTemplate.title || storyCard.yotoPlaylistTitle || storyCard.name || "Story Playlist"),
      overlayLabel: String(chapterTemplate.overlayLabel || "1"),
      display,
      tracks,
    },
  ];
};

const buildYotoPlaylistUpdatePayload = (currentCard, storyCard, tracks) => {
  const content = currentCard.content && typeof currentCard.content === "object"
    ? { ...currentCard.content }
    : {};
  content.chapters = buildYotoPlaylistChapters(currentCard, storyCard, tracks);
  if (!content.playbackType) content.playbackType = "linear";
  if (!content.config) content.config = { resumeTimeout: 2592000 };

  const payload = {
    cardId: currentCard.cardId || storyCard.yotoPlaylistId,
    title: currentCard.title || storyCard.yotoPlaylistTitle || storyCard.name || "Story Playlist",
    metadata: currentCard.metadata && typeof currentCard.metadata === "object" ? currentCard.metadata : {},
    content,
  };

  ["createdAt", "deleted", "updatedAt", "userId"].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(currentCard, field)) payload[field] = currentCard[field];
  });

  return payload;
};

const getYotoPlaylistTracksFromContent = (card = {}) =>
  asArray(card?.content?.chapters).flatMap((chapter) =>
    asArray(chapter?.tracks).map((track) => ({ ...track, chapterKey: chapter?.key || "" }))
  );

const verifyYotoPlaylistTracks = (card = {}, tracks = []) => {
  const yotoTracks = getYotoPlaylistTracksFromContent(card);
  const sentTrackUrls = new Set(tracks.map((track) => String(track.trackUrl || "").trim()).filter(Boolean));
  const verifiedTracks = yotoTracks.filter((track) => sentTrackUrls.has(String(track.trackUrl || "").trim()));
  return {
    yotoTracks,
    verifiedTracks,
    verifiedTrackCount: verifiedTracks.length,
    populatedTrackCount: yotoTracks.filter((track) => String(track.trackUrl || "").startsWith("yoto:#")).length,
  };
};


const markPlaylistUpdateWaiting = async (storyCardId, stories, storyCard, details = {}) => {
  const waiting = [];
  const retryAfter = details.yotoTranscodeRetryAfter || details.playlistUpdateRetryAfter || details.retryAfter || getYotoProcessingRetryAfter();
  const lastCheckedAt = details.yotoTranscodeLastCheckedAt || new Date().toISOString();

  for (const story of stories) {
    const safeDetails = getSafePlaylistDetails({
      ...details,
      failureType: "yoto_processing",
      storyIdsAttempted: details.storyIdsAttempted || [story.id],
      uploadTrackMetadata: details.uploadTrackMetadata || [story],
      playlistUpdateStatus: "waiting",
      playlistUpdateRetryAfter: retryAfter,
      yotoUploadStatus: details.yotoUploadStatus || story.yotoUploadStatus || "processing",
      yotoTranscodeStatus: details.yotoTranscodeStatus || story.yotoTranscodeStatus || "processing",
      yotoTranscodeRetryAfter: retryAfter,
      yotoTranscodeLastCheckedAt: lastCheckedAt,
      yotoTranscodePollCount: details.yotoTranscodePollCount || story.yotoTranscodePollCount || 0,
    }, storyCard);

    await addActivityLogEntry({
      level: "warning",
      storyCardId,
      storyId: story.id,
      eventType: "story_playlist_update_waiting",
      title: "Yoto is getting story ready",
      message: YOTO_PROCESSING_MESSAGE,
      details: safeDetails,
    });

    waiting.push(await updateQueuedStoryFields(storyCardId, story.id, {
      status: "uploaded",
      yotoUploadStatus: story.yotoUploadStatus === "failed" ? "failed" : "processing",
      yotoTranscodeStatus: details.yotoTranscodeStatus || story.yotoTranscodeStatus || "processing",
      yotoTranscodeRetryAfter: retryAfter,
      yotoTranscodeLastCheckedAt: lastCheckedAt,
      yotoTranscodePollCount: Number(details.yotoTranscodePollCount || story.yotoTranscodePollCount || 0),
      playlistUpdateStatus: "waiting",
      playlistUpdateError: YOTO_PROCESSING_MESSAGE,
      playlistUpdateRetryAfter: retryAfter,
      playlistUpdateFailureType: "yoto_processing",
      uploadError: "",
    }));
  }

  return waiting;
};

const markPlaylistUpdateFailed = async (storyCardId, stories, storyCard, message, details = {}) => {
  const failed = [];

  for (const story of stories) {
    const safeDetails = getSafePlaylistDetails({
      ...details,
      storyIdsAttempted: details.storyIdsAttempted || [story.id],
      uploadTrackMetadata: details.uploadTrackMetadata || [story],
      playlistUpdateStatus: "failed",
    }, storyCard);
    await addActivityLogEntry({
      level: "error",
      storyCardId,
      storyId: story.id,
      eventType: "story_playlist_update_failed",
      title: "Story needs help",
      message,
      details: safeDetails,
    });
    failed.push(await updateQueuedStoryFields(storyCardId, story.id, {
      status: "failed",
      uploadError: message,
      playlistUpdateStatus: "failed",
      playlistUpdateError: message,
      playlistUpdateRetryAfter: "",
      playlistUpdateFailureType: safeDetails.failureType,
    }));
  }

  return failed;
};

const isPlaylistUpdateCandidateStory = (story = {}) => {
  if (!story || story.storyCardId === undefined) return false;
  if (["uploaded", "synced"].includes(story.status)) return true;
  return story.status === "failed" && (hasPendingYotoTranscode(story) || hasUsableYotoTrackMetadata(story));
};

const updateYotoStoryPlaylistForStoryCard = async (storyCardId) => {
  const { storyCard } = await getStoryCardOrThrow(storyCardId);
  let queuedStories = await getStoryQueueForStoryCard(storyCardId);
  const preview = getPlaylistPreviewForStoryCard(storyCard, queuedStories);
  const candidateStories = preview.onYotoSoon.filter(
    (story) => story.storyCardId === storyCardId && isPlaylistUpdateCandidateStory(story)
  );
  const intendedTrackCount = candidateStories.length;
  const synced = [];
  const waiting = [];
  let failed = [];

  if (!candidateStories.length) {
    return { synced, waiting, failed, stories: queuedStories };
  }

  const readyStories = [];
  for (const story of candidateStories) {
    const currentStory = (await getStoryQueueForStoryCard(storyCardId)).find((item) => item.id === story.id) || story;
    try {
      const withTrackMetadata = await ensureYotoTrackMetadataForStory(storyCardId, currentStory);
      if (hasUsableYotoTrackMetadata(withTrackMetadata)) {
        readyStories.push(withTrackMetadata);
      } else if (withTrackMetadata.status === "uploaded" && withTrackMetadata.yotoUploadId) {
        waiting.push(...(await markPlaylistUpdateWaiting(storyCardId, [withTrackMetadata], storyCard, {
          step: "Waiting on Yoto",
          storyCardId,
          yotoPlaylistId: storyCard.yotoPlaylistId,
          yotoPlaylistTitle: storyCard.yotoPlaylistTitle,
          intendedTrackCount,
          readyTrackCount: readyStories.length,
          storyIdsAttempted: candidateStories.map((item) => item.id),
          storyTitlesIncluded: candidateStories.map((item) => item.title),
          technicalMessage: "Story upload exists, but Yoto has not returned playlist-ready track metadata yet.",
        })));
      } else if (withTrackMetadata.status === "uploaded") {
        const missingMetadataFields = getMissingYotoTrackMetadataFields(withTrackMetadata);
        failed.push(...(await markPlaylistUpdateFailed(storyCardId, [withTrackMetadata], storyCard,
          "Feed Your Yoto could not build playlist tracks from the uploaded stories.",
          {
            step: "Building Story Playlist",
            failureType: "playlist_payload_error",
            storyCardId,
            yotoPlaylistId: storyCard.yotoPlaylistId,
            yotoPlaylistTitle: storyCard.yotoPlaylistTitle,
            intendedTrackCount,
            readyTrackCount: readyStories.length,
            storyIdsAttempted: [withTrackMetadata.id],
            storyTitlesIncluded: [withTrackMetadata.title],
            missingMetadataFields,
            uploadTrackMetadata: [{ ...withTrackMetadata, missingMetadataFields }],
            technicalMessage: "Story did not have usable Yoto track metadata.",
          }
        )));
      }
    } catch (error) {
      if (isYotoProcessingError(error) && currentStory.status === "uploaded") {
        waiting.push(...(await markPlaylistUpdateWaiting(storyCardId, [currentStory], storyCard, {
          ...error,
          step: error.step || "Waiting on Yoto",
          storyCardId,
          yotoPlaylistId: storyCard.yotoPlaylistId,
          yotoPlaylistTitle: storyCard.yotoPlaylistTitle,
          intendedTrackCount,
          readyTrackCount: readyStories.length,
          storyIdsAttempted: candidateStories.map((item) => item.id),
          storyTitlesIncluded: candidateStories.map((item) => item.title),
        })));
      } else {
        const message = error.expose ? error.message : "Feed Your Yoto could not add this story to the Story Playlist.";
        failed.push(...(await markPlaylistUpdateFailed(storyCardId, [currentStory], storyCard, message, {
          ...error,
          intendedTrackCount,
          readyTrackCount: readyStories.length,
          storyIdsAttempted: [currentStory.id],
          storyTitlesIncluded: [currentStory.title],
        })));
      }
    }
  }

  if (!readyStories.length) {
    return { synced, waiting, failed, stories: await getStoryQueueForStoryCard(storyCardId) };
  }

  const { tracks, readyStories: trackStories, skippedStories } = buildYotoPlaylistTracksFromStories(readyStories);
  const missingMetadataFields = [...new Set(skippedStories.flatMap((story) => story.missingMetadataFields || []))];
  const detailsBase = {
    step: "Adding to Story Playlist",
    storyCardId,
    yotoPlaylistId: storyCard.yotoPlaylistId,
    yotoPlaylistTitle: storyCard.yotoPlaylistTitle,
    intendedTrackCount,
    readyTrackCount: readyStories.length,
    builtTrackCount: tracks.length,
    trackCount: tracks.length,
    sentTrackCount: 0,
    syncedCount: trackStories.filter((story) => story.status !== "synced").length,
    storyIdsAttempted: trackStories.map((story) => story.id),
    storyTitlesIncluded: trackStories.map((story) => story.title),
    missingMetadataFields,
    uploadTrackMetadata: [...trackStories, ...skippedStories],
  };

  if (!tracks.length || tracks.length !== readyStories.length || skippedStories.length) {
    const storiesToFail = skippedStories.length ? skippedStories : readyStories;
    failed = [
      ...failed,
      ...(await markPlaylistUpdateFailed(storyCardId, storiesToFail, storyCard,
        "Feed Your Yoto could not build playlist tracks from the uploaded stories.",
        {
          ...detailsBase,
          step: "Building Story Playlist",
          failureType: "playlist_payload_error",
          technicalMessage: "Built track count did not match uploaded/transcode-ready stories.",
        }
      )),
    ];
    return { synced, waiting, failed, stories: await getStoryQueueForStoryCard(storyCardId) };
  }

  const storiesNeedingPlaylistUpdate = trackStories.filter((story) => story.status !== "synced");
  if (!storiesNeedingPlaylistUpdate.length) {
    return { synced, waiting, failed, stories: await getStoryQueueForStoryCard(storyCardId) };
  }

  for (const story of storiesNeedingPlaylistUpdate) {
    await updateQueuedStoryFields(storyCardId, story.id, {
      status: "adding_to_playlist",
      playlistUpdateStatus: "adding",
      playlistUpdateError: "",
      playlistUpdateRetryAfter: "",
      playlistUpdateFailureType: "",
    });
    await addActivityLogEntry({
      level: "info",
      storyCardId,
      storyId: story.id,
      eventType: "story_playlist_update_started",
      title: "Adding to Story Playlist",
      message: "Feed Your Yoto is updating this Story Playlist.",
      details: getSafePlaylistDetails({ ...detailsBase, playlistUpdateStatus: "adding" }, storyCard),
    });
  }

  try {
    const { card, tokens } = await getYotoPlaylistContent(storyCard);
    const updatePayload = buildYotoPlaylistUpdatePayload(card, storyCard, tracks);
    const response = await postYotoJsonWithRefresh("/content", tokens, updatePayload);
    const responseShape = getSafeYotoResponseShape(response.data);
    const { card: verifiedCard } = await getYotoPlaylistContent(storyCard);
    const verification = verifyYotoPlaylistTracks(verifiedCard, tracks);
    const verifiedResponseShape = getSafeYotoResponseShape(verifiedCard);
    const verifiedTrackCount = verification.verifiedTrackCount;
    const finishDetails = getSafePlaylistDetails({
      ...detailsBase,
      playlistUpdateStatus: verifiedTrackCount === tracks.length ? "synced" : "failed",
      sentTrackCount: tracks.length,
      verifiedTrackCount,
      httpStatus: 200,
      responseShape,
      verifiedResponseShape,
    }, storyCard);

    if (verifiedTrackCount !== tracks.length || verifiedTrackCount === 0) {
      const message = "Feed Your Yoto updated the Story Playlist, but Yoto did not show the stories yet.";
      failed = [
        ...failed,
        ...(await markPlaylistUpdateFailed(storyCardId, storiesNeedingPlaylistUpdate, storyCard, message, {
          ...finishDetails,
          step: "Adding to Story Playlist",
          failureType: "playlist_payload_error",
          technicalMessage: "Playlist verification did not find every sent track URL after update.",
        })),
      ];
      return { synced, waiting, failed, stories: await getStoryQueueForStoryCard(storyCardId) };
    }

    for (const story of storiesNeedingPlaylistUpdate) {
      await addActivityLogEntry({
        level: "info",
        storyCardId,
        storyId: story.id,
        eventType: "story_playlist_update_finished",
        title: "Ready on Yoto",
        message: "This Story Playlist is ready on Yoto.",
        details: finishDetails,
      });
      synced.push(await updateQueuedStoryFields(storyCardId, story.id, {
        status: "synced",
        uploadError: "",
        playlistUpdateStatus: "synced",
        playlistUpdateError: "",
        playlistUpdateRetryAfter: "",
        playlistUpdateFailureType: "",
      }));
    }
  } catch (error) {
    const details = getSafePlaylistDetails({
      ...error,
      ...detailsBase,
      sentTrackCount: tracks.length,
      httpStatus: error.httpStatus || error.status,
      technicalMessage: error.technicalMessage || error.data?.message || error.data?.error || error.message,
    }, storyCard);

    if (details.failureType === "yoto_processing") {
      waiting.push(...(await markPlaylistUpdateWaiting(storyCardId, storiesNeedingPlaylistUpdate, storyCard, details)));
    } else {
      const message = error.expose ? error.message : "Feed Your Yoto could not update this Story Playlist right now.";
      failed = [
        ...failed,
        ...(await markPlaylistUpdateFailed(storyCardId, storiesNeedingPlaylistUpdate, storyCard, message, details)),
      ];
    }
  }

  return {
    synced,
    waiting,
    failed,
    stories: await getStoryQueueForStoryCard(storyCardId),
  };
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
    const storyQueueRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/?$/);
    const storyDiscoverRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/discover\/?$/);
    const playlistPreviewRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/playlist-preview\/?$/);
    const syncPlaylistRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/sync-playlist\/?$/);
    const storyActivityRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/([^/]+)\/activity\/?$/);
    const storyDownloadSelectedRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/download-selected\/?$/);
    const storyUploadReadyRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/upload-ready\/?$/);
    const storyDownloadRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/([^/]+)\/download\/?$/);
    const storyUploadRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/([^/]+)\/upload\/?$/);
    const storyQueueItemRoute = pathname.match(/^\/api\/story-cards\/([^/]+)\/stories\/([^/]+)\/?$/);
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

    if (request.method === "POST" && pathname === "/api/podcast/preview") {
      sendJson(response, 200, await previewPodcast(await readRequestJson(request)));
      return;
    }

    if (request.method === "GET" && pathname === "/api/activity-log") {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      sendJson(response, 200, await getActivityLog({
        storyCardId: url.searchParams.get("storyCardId") || "",
        storyId: url.searchParams.get("storyId") || "",
        level: url.searchParams.get("level") || "",
        limit: url.searchParams.get("limit") || 100,
      }));
      return;
    }

    if (request.method === "GET" && storyActivityRoute) {
      const storyCardId = decodeURIComponent(storyActivityRoute[1]);
      const storyId = decodeURIComponent(storyActivityRoute[2]);
      sendJson(response, 200, await getActivityLog({ storyCardId, storyId, limit: 25 }));
      return;
    }

    if (request.method === "GET" && storyQueueRoute) {
      const storyCardId = decodeURIComponent(storyQueueRoute[1]);
      await getStoryCardOrThrow(storyCardId);
      sendJson(response, 200, await getStoryQueueForStoryCard(storyCardId));
      return;
    }

    if (request.method === "POST" && storyDiscoverRoute) {
      const storyCardId = decodeURIComponent(storyDiscoverRoute[1]);
      sendJson(response, 200, await discoverStoriesForStoryCard(storyCardId));
      return;
    }

    if (request.method === "GET" && playlistPreviewRoute) {
      const storyCardId = decodeURIComponent(playlistPreviewRoute[1]);
      const { storyCard } = await getStoryCardOrThrow(storyCardId);
      const queuedStories = await getStoryQueueForStoryCard(storyCardId);
      sendJson(response, 200, getPlaylistPreviewForStoryCard(storyCard, queuedStories));
      return;
    }

    if (request.method === "POST" && syncPlaylistRoute) {
      const storyCardId = decodeURIComponent(syncPlaylistRoute[1]);
      sendJson(response, 200, await updateYotoStoryPlaylistForStoryCard(storyCardId));
      return;
    }

    if (request.method === "POST" && storyDownloadSelectedRoute) {
      const storyCardId = decodeURIComponent(storyDownloadSelectedRoute[1]);
      sendJson(response, 200, await downloadSelectedStories(storyCardId));
      return;
    }

    if (request.method === "POST" && storyUploadReadyRoute) {
      const storyCardId = decodeURIComponent(storyUploadReadyRoute[1]);
      sendJson(response, 200, await uploadReadyStoriesToYoto(storyCardId));
      return;
    }

    if (request.method === "POST" && storyDownloadRoute) {
      const storyCardId = decodeURIComponent(storyDownloadRoute[1]);
      const storyId = decodeURIComponent(storyDownloadRoute[2]);
      sendJson(response, 200, await downloadStoryAudio(storyCardId, storyId));
      return;
    }

    if (request.method === "POST" && storyUploadRoute) {
      const storyCardId = decodeURIComponent(storyUploadRoute[1]);
      const storyId = decodeURIComponent(storyUploadRoute[2]);
      sendJson(response, 200, await uploadDownloadedStoryToYoto(storyCardId, storyId));
      return;
    }

    if (request.method === "PUT" && storyQueueItemRoute) {
      const storyCardId = decodeURIComponent(storyQueueItemRoute[1]);
      const storyId = decodeURIComponent(storyQueueItemRoute[2]);
      sendJson(response, 200, await updateQueuedStory(storyCardId, storyId, await readRequestJson(request)));
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
