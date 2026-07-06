const appConfig = window.APP_CONFIG || {};
const yotoClientId = appConfig.yoto?.clientId || "";

if (!yotoClientId) {
  console.warn("Missing Yoto client ID. Check config.js.");
}

let availableYotoCards = [];
let yotoCardsLoadState = {
  status: "idle",
  message: "",
};

let storyCards = [];
let storyQueueState = {
  storyCardId: "",
  status: "idle",
  message: "",
  stories: [],
  pendingUpdates: {},
  filter: "all",
};
let storyDownloadState = {
  storyIds: new Set(),
  uploadIds: new Set(),
  bulk: false,
  processing: false,
  syncing: false,
};
let storyProcessRetryTimers = new Map();
let activityLogEntries = [];
let activeView = "story-cards";
let storyQueuePollTimer = null;
let storyQueuePollInFlight = false;
let storyQueuePollSignature = "";
let storyQueuePollUnchangedCount = 0;
const storyTrackerPreviousSteps = new Map();

const YOTO_PROCESSING_MESSAGE = "Yoto is still getting this story ready. Feed Your Yoto will try again soon.";
const MISSING_AUDIO_DOWNLOAD_MESSAGE =
  "This story can't be downloaded because it is missing its download link in the RSS feed.";
const MISSING_AUDIO_PARENT_MESSAGE = "This story does not have an audio file Feed Your Yoto can use.";
const MISSING_AUDIO_TECHNICAL_MESSAGE =
  "The RSS feed item did not include a usable http or https audio URL.";
const MIN_PLAYLIST_RETRY_DELAY_MS = 5_000;
const STORY_QUEUE_FAST_POLL_MS = 3_000;
const STORY_QUEUE_WAITING_POLL_MS = 5_000;
const STORY_QUEUE_SLOW_POLL_MS = 15_000;
const STORY_QUEUE_SLOW_AFTER_UNCHANGED_POLLS = 24;
const YOTO_MYO_MAX_TRACKS = 100;
const YOTO_MYO_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const YOTO_MYO_MAX_TOTAL_SECONDS = 5 * 60 * 60;
const YOTO_MYO_MAX_TRACK_BYTES = 100 * 1024 * 1024;
const YOTO_MYO_MAX_TRACK_SECONDS = 60 * 60;
const MANUAL_MAX_STORAGE_MB_LIMIT = 2000;
const MANUAL_MAX_PLAY_TIME_MINUTES_LIMIT = 60 * 60;

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

const storyTrackerSteps = [
  { key: "found", label: "Found" },
  { key: "preparing", label: "Preparing" },
  { key: "sending", label: "Sending to Yoto" },
  { key: "updating", label: "Updating Playlist" },
  { key: "ready", label: "Ready" },
];
const STORY_TRACKER_STEP_SPACING = 46;

const defaultStoryRules = {
  newStoryBehavior: "auto_pick",
  playlistLimit: 10,
  capacityMode: "yoto_max",
  manualMaxStoriesEnabled: false,
  manualMaxStories: 100,
  manualMaxStorageEnabled: false,
  manualMaxStorageMb: 500,
  manualMaxPlayTimeEnabled: false,
  manualMaxPlayTimeMinutes: 300,
  favoritesNeverRotate: true,
};

const cardGrid = document.querySelector("#cardGrid");
const storyCardsNav = document.querySelector("#storyCardsNav");
const activityLogNav = document.querySelector("#activityLogNav");
const dashboardTitle = document.querySelector("#dashboardTitle");
const dashboardSubtitle = document.querySelector("#dashboardSubtitle");
const storyCardOverview = document.querySelector("#storyCardOverview");
const storyCardSectionHeading = document.querySelector("#storyCardSectionHeading");
const activityLogPanel = document.querySelector("#activityLogPanel");
const activityLogList = document.querySelector("#activityLogList");
const refreshActivityLog = document.querySelector("#refreshActivityLog");
const backdrop = document.querySelector("#dialogBackdrop");
const setupBackdrop = document.querySelector("#setupBackdrop");
const setupTitle = document.querySelector("#setupTitle");
const setupStepContent = document.querySelector("#setupStepContent");
const setupError = document.querySelector("#setupError");
const setupBackButton = document.querySelector("#setupBackButton");
const setupNextButton = document.querySelector("#setupNextButton");
const saveStoryCardButton = document.querySelector("#saveStoryCardButton");
const cancelSetupButton = document.querySelector("#cancelSetupButton");
const closeSetupDialog = document.querySelector("#closeSetupDialog");
const storyCardCount = document.querySelector("#storyCardCount");
const cardsUpdatingCount = document.querySelector("#cardsUpdatingCount");
const nextCheckDate = document.querySelector("#nextCheckDate");
const nextCheckTime = document.querySelector("#nextCheckTime");
const storyCardsSummary = document.querySelector("#storyCardsSummary");
const authBackdrop = document.querySelector("#authBackdrop");
const authBanner = document.querySelector("#authBanner");
const authButton = document.querySelector("#authButton");
const authStartState = document.querySelector("#authStartState");
const authDeviceState = document.querySelector("#authDeviceState");
const authUserCode = document.querySelector("#authUserCode");
const authMessage = document.querySelector("#authMessage");
const openYotoLogin = document.querySelector("#openYotoLogin");
const closeAuthDialog = document.querySelector("#closeAuthDialog");
const connectYotoButton = document.querySelector("#connectYotoButton");
const notNowButton = document.querySelector("#notNowButton");
const cancelAuthButton = document.querySelector("#cancelAuthButton");
const dialogArt = document.querySelector("#dialogArt");
const dialogTitle = document.querySelector("#dialogTitle");
const dialogStatus = document.querySelector("#dialogStatus");
const dialogCrawl = document.querySelector("#dialogCrawl");
const dialogPodcastDescription = document.querySelector("#dialogPodcastDescription");
const automaticScheduleStatus = document.querySelector("#automaticScheduleStatus");
const playlistName = document.querySelector("#playlistName");
const rssFeed = document.querySelector("#rssFeed");
const yotoCard = document.querySelector("#yotoCard");
const changeSetupDetails = document.querySelector("#changeSetupDetails");
const setupDetailsPanel = document.querySelector("#setupDetailsPanel");
const setupChangeAcknowledged = document.querySelector("#setupChangeAcknowledged");
const podcastChangeCode = document.querySelector("#podcastChangeCode");
const closeDialog = document.querySelector("#closeDialog");
const addCardButton = document.querySelector("#addCardButton");
const showAllButton = document.querySelector("#showAllButton");
const saveCard = document.querySelector("#saveCard");
const deleteCard = document.querySelector("#deleteCard");
const deleteConfirmPanel = document.querySelector("#deleteConfirmPanel");
const cancelDeleteCard = document.querySelector("#cancelDeleteCard");
const confirmDeleteCard = document.querySelector("#confirmDeleteCard");
const pauseCard = document.querySelector("#pauseCard");
const syncSwitch = document.querySelector("#syncSwitch");
const switchStatus = document.querySelector("#switchStatus");
const refreshStories = document.querySelector("#refreshStories");
const storyQueueContent = document.querySelector("#storyQueueContent");
const favoritesNeverRotate = document.querySelector("#favoritesNeverRotate");
const newStoryBehaviorButtons = Array.from(document.querySelectorAll("[data-new-story-behavior]"));
const capacityModeButtons = Array.from(document.querySelectorAll("[data-capacity-mode]"));
const manualCapacityControls = document.querySelector("#manualCapacityControls");
const manualMaxStoriesEnabled = document.querySelector("#manualMaxStoriesEnabled");
const manualMaxStories = document.querySelector("#manualMaxStories");
const manualMaxStorageEnabled = document.querySelector("#manualMaxStorageEnabled");
const manualMaxStorageMb = document.querySelector("#manualMaxStorageMb");
const manualMaxPlayTimeEnabled = document.querySelector("#manualMaxPlayTimeEnabled");
const manualMaxPlayTimeHours = document.querySelector("#manualMaxPlayTimeHours");
const manualMaxPlayTimeMinutes = document.querySelector("#manualMaxPlayTimeMinutes");
const editorTabs = Array.from(document.querySelectorAll("[data-editor-tab]"));
const editorPanels = Array.from(document.querySelectorAll("[data-editor-panel]"));
const storySubtabs = Array.from(document.querySelectorAll("[data-stories-subtab]"));
const storySubpanels = Array.from(document.querySelectorAll("[data-stories-subpanel]"));

let activeCardId = "";
let isAuthenticated = false;
let authPollTimer = null;
let yotoLoginPopup = null;
let setupStep = 0;
let setupDraft = getFreshSetupDraft();
let yotoCardsLoadId = 0;
let setupDetailsUnlocked = false;

function getFreshSetupDraft() {
  return {
    playlistMode: "create",
    newPlaylistTitle: "New Story Playlist",
    yotoCardId: "",
    yotoCardTitle: "",
    yotoCardImageUrl: null,
    overwriteAcknowledged: false,
    name: "",
    podcastLink: "",
    podcastPreview: null,
    podcastPreviewStatus: "idle",
    podcastPreviewMessage: "",
    podcastPreviewLink: "",
    automaticChecksEnabled: true,
    updateRhythm: "daily",
    lateCheckRhythm: "hourly",
  };
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeAttribute = escapeHtml;

const getPlainTextFromMarkup = (value) => {
  const rawText = String(value || "").trim();
  if (!rawText) return "";

  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawText, "text/html");
  return (parsed.body.textContent || rawText).replace(/\s+/g, " ").trim();
};

const truncateText = (value, maxLength = 260) => {
  const text = getPlainTextFromMarkup(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
};

const setModalLock = () => {
  const modalOpen = !backdrop.hidden || !setupBackdrop.hidden || !authBackdrop.hidden;
  document.body.classList.toggle("dialog-open", modalOpen);
};

const apiRequest = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || data.error || "Request failed.");
    error.status = response.status;
    throw error;
  }

  return data;
};

const jsonRequest = (path, method, body) =>
  apiRequest(path, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const setButtonBusy = (button, busy, busyText) => {
  if (!button) return "";

  const previousText = button.textContent;
  button.disabled = busy;
  if (busy && busyText) button.textContent = busyText;
  return previousText;
};

const refreshStoryCardCache = async () => {
  const savedStoryCards = await apiRequest("/api/story-cards");
  storyCards = Array.isArray(savedStoryCards) ? savedStoryCards : [];
};

const loadStoryCards = async () => {
  try {
    await refreshStoryCardCache();
    if (!storyCards.some((storyCard) => storyCard.id === activeCardId)) {
      activeCardId = storyCards[0]?.id || "";
    }
  } catch (error) {
    console.warn("Could not load Story Cards.", error);
    storyCards = [];
    activeCardId = "";
  }

  renderCards();
};

const stopAuthPolling = () => {
  if (authPollTimer) {
    window.clearTimeout(authPollTimer);
    authPollTimer = null;
  }
};

const closeYotoLoginPopup = () => {
  if (!yotoLoginPopup) return;

  try {
    if (!yotoLoginPopup.closed) {
      yotoLoginPopup.close();
    }
  } catch (error) {
    console.warn("Could not close the Yoto login window.", error);
  }

  yotoLoginPopup = null;
};

const lockFeatures = () => {
  document.body.classList.add("auth-locked");
  authBanner.hidden = false;
  authButton.textContent = "Connect Yoto";
  authButton.classList.remove("is-signed-in");
  authButton.setAttribute("aria-label", "Connect Yoto");
  addCardButton.classList.add("is-locked-action");
  addCardButton.setAttribute("aria-disabled", "true");
  showAllButton.classList.add("is-locked-action");
  showAllButton.setAttribute("aria-disabled", "true");
};

const unlockFeatures = () => {
  document.body.classList.remove("auth-locked");
  authBanner.hidden = true;
  authButton.textContent = "Disconnect";
  authButton.classList.add("is-signed-in");
  authButton.setAttribute("aria-label", "Disconnect Yoto");
  addCardButton.classList.remove("is-locked-action");
  addCardButton.removeAttribute("aria-disabled");
  showAllButton.classList.remove("is-locked-action");
  showAllButton.removeAttribute("aria-disabled");
};

const setAuthenticated = (authenticated) => {
  isAuthenticated = authenticated;

  if (isAuthenticated) {
    unlockFeatures();
    loadYotoCardsForSetup({ showLoading: false });
  } else {
    lockFeatures();
    yotoCardsLoadId += 1;
    availableYotoCards = [];
    yotoCardsLoadState = {
      status: "idle",
      message: "",
    };
    setupDraft.yotoCardId = "";
    setupDraft.yotoCardTitle = "";
    setupDraft.yotoCardImageUrl = null;
  }

  renderCards();
};

const showAuthState = (state) => {
  const showDevice = state === "device";
  authStartState.hidden = showDevice;
  authDeviceState.hidden = !showDevice;
};

const openAuthModal = (message = "") => {
  showAuthState("start");
  authMessage.textContent = message;
  connectYotoButton.disabled = false;
  connectYotoButton.textContent = "Connect Yoto";
  authBackdrop.hidden = false;
  setModalLock();
  window.setTimeout(() => connectYotoButton.focus(), 0);
};

const closeAuthModal = () => {
  stopAuthPolling();
  closeYotoLoginPopup();
  authBackdrop.hidden = true;
  setModalLock();
};

const requireAuth = (message = "Connect Yoto first.") => {
  if (isAuthenticated) return true;
  openAuthModal(message);
  return false;
};

const checkAuthStatus = async () => {
  try {
    const status = await apiRequest("/api/auth/status");
    setAuthenticated(Boolean(status.authenticated));
    return status;
  } catch (error) {
    setAuthenticated(false);
    authMessage.textContent = "Yoto sign-in is not available yet. Try again in a moment.";
    return { authenticated: false, error: error.message };
  }
};

const formatDateTime = (value) => {
  if (!value) return "Choose a time";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Choose a time";

  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const getPodcastPreview = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url || "No podcast link yet";
  }
};

const getYotoCardTitle = (card) => card?.title || card?.name || "Story Playlist";

const getPlaylistInitials = (title) => {
  const words = String(title || "Story Playlist")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]).join("");
  return initials.toUpperCase() || "SP";
};

const getPlaylistArtMarkup = (card) => {
  const title = getYotoCardTitle(card);
  const placeholder = `
    <span class="playlist-art-placeholder" aria-hidden="true">
      ${escapeHtml(getPlaylistInitials(title))}
    </span>
  `;

  if (!card?.imageUrl) return placeholder;

  return `
    <span class="playlist-art-frame">
      <img
        src="${escapeAttribute(card.imageUrl)}"
        alt=""
        class="playlist-art"
        onerror="this.hidden=true; this.parentElement.classList.add('is-image-missing');"
      />
      ${placeholder}
    </span>
  `;
};

const getStoryCardPlaylistTitle = (storyCard) =>
  storyCard?.yotoPlaylistTitle || storyCard?.yotoCardName || "Story Playlist";

const getStoryCardPlaylistImageUrl = (storyCard) =>
  storyCard?.yotoPlaylistImageUrl || storyCard?.yotoCardImageUrl || null;

const getStoryCardNextCheckLabel = (storyCard) => {
  if (!isAutomaticChecksEnabled(storyCard)) return "Only when I press Refresh Stories";
  return formatDateTime(storyCard?.nextAutomaticCheckAt || storyCard?.nextCheck);
};

const isAutomaticChecksEnabled = (storyCard = {}) => {
  if (Object.prototype.hasOwnProperty.call(storyCard, "automaticChecksEnabled")) {
    return storyCard.automaticChecksEnabled !== false;
  }
  return storyCard?.updateRhythm !== "manual";
};

const getStoryCardAutomaticCheckLabel = (storyCard) => {
  if (!isAutomaticChecksEnabled(storyCard)) return "Only when I press Refresh Stories";
  return formatDateTime(storyCard?.nextAutomaticCheckAt || storyCard?.nextCheck);
};

const getStoryCardLastAutomaticCheckLabel = (storyCard) =>
  storyCard?.lastAutomaticCheckAt ? formatDateTime(storyCard.lastAutomaticCheckAt) : "Not yet";

const getAutomaticResultText = (storyCard) => {
  if (!storyCard?.lastAutomaticResult) return "";
  if (storyCard.lastAutomaticResult === "success") return "Last check finished.";
  if (storyCard.lastAutomaticResult === "waiting") return "Waiting on Yoto.";
  if (storyCard.lastAutomaticResult === "failed") return "Needs help.";
  if (storyCard.lastAutomaticResult === "skipped") return "Last check was skipped.";
  return storyCard.lastAutomaticMessage || "";
};

const getStoryCardArtMarkup = (storyCard) => {
  const title = getStoryCardPlaylistTitle(storyCard);
  const imageUrl = getStoryCardPlaylistImageUrl(storyCard);
  const placeholder = `
    <span class="playlist-art-placeholder" aria-hidden="true">
      ${escapeHtml(getPlaylistInitials(title))}
    </span>
  `;

  if (!imageUrl) return placeholder;

  return `
    <span class="playlist-art-frame">
      <img
        src="${escapeAttribute(imageUrl)}"
        alt=""
        class="playlist-art"
        onerror="this.hidden=true; this.parentElement.classList.add('is-image-missing');"
      />
      ${placeholder}
    </span>
  `;
};

const isCompatibleYotoPlaylist = (card) => Boolean(card?.compatible && !card?.hasStreams);

const getRegularYotoPlaylists = () => availableYotoCards.filter(isCompatibleYotoPlaylist);

const getStreamingYotoPlaylists = () =>
  availableYotoCards.filter((card) => card?.hasStreams || card?.compatible === false);

const getUsedStoryCardForPlaylist = (playlistId) =>
  storyCards.find((storyCard) => storyCard.yotoPlaylistId === playlistId);

const isYotoPlaylistAlreadyUsed = (playlistId) => Boolean(getUsedStoryCardForPlaylist(playlistId));

const getUnusedRegularYotoPlaylists = () =>
  getRegularYotoPlaylists().filter((card) => !isYotoPlaylistAlreadyUsed(card.id));

const chooseDefaultSetupPlaylist = () => {
  if (setupDraft.playlistMode !== "existing") return;

  const selectedStillAvailable = getUnusedRegularYotoPlaylists().some(
    (card) => card.id === setupDraft.yotoCardId
  );

  if (!selectedStillAvailable) {
    setSetupSelectedCard(getUnusedRegularYotoPlaylists()[0] || null);
  }
};

const renderPlaylistTile = (card, { selectable, reason = "", usedStoryCard = null }) => {
  const title = getYotoCardTitle(card);

  if (!selectable) {
    const label = reason === "used" ? "Already used" : "Streaming playlist";
    const helper =
      reason === "used"
        ? "This playlist is already connected to another Story Card."
        : "Streaming playlists are grouped separately.";
    const usedBy = usedStoryCard ? ` Used by "${escapeHtml(usedStoryCard.name)}".` : "";

    return `
      <article class="setup-option playlist-option is-disabled ${reason === "used" ? "is-used" : ""}" aria-disabled="true">
        ${getPlaylistArtMarkup(card)}
        <span class="playlist-copy">
          <strong>${escapeHtml(title)}</strong>
          <span class="playlist-badge">${escapeHtml(label)}</span>
          <small>${escapeHtml(helper)}${usedBy}</small>
        </span>
      </article>
    `;
  }

  return `
    <button class="setup-option playlist-option ${setupDraft.yotoCardId === card.id ? "is-selected" : ""}" type="button" data-yoto-card-id="${escapeAttribute(card.id)}">
      ${getPlaylistArtMarkup(card)}
      <span class="playlist-copy">
        <strong>${escapeHtml(title)}</strong>
        <span>Story Playlist</span>
      </span>
    </button>
  `;
};

const renderPlaylistRefreshButton = () => `
  <div class="setup-toolbar">
    <button class="refresh-playlists" type="button" data-refresh-yoto-playlists ${yotoCardsLoadState.status === "loading" ? "disabled" : ""}>
      Refresh
    </button>
  </div>
`;

const renderPlaylistModeTabs = () => `
  <div class="setup-mode-tabs" role="tablist" aria-label="Story Playlist setup options">
    <button class="setup-mode-tab ${setupDraft.playlistMode === "create" ? "is-selected" : ""}" type="button" data-playlist-mode="create">
      Make New Story Playlist
      <span>Recommended</span>
    </button>
    <button class="setup-mode-tab ${setupDraft.playlistMode === "existing" ? "is-selected" : ""}" type="button" data-playlist-mode="existing">
      Use Existing Story Playlist
      <span>Advanced</span>
    </button>
  </div>
`;

const renderPodcastPreview = () => {
  if (setupDraft.podcastPreviewStatus === "loading") {
    return `<p class="podcast-preview-message" role="status">Checking podcast...</p>`;
  }

  if (setupDraft.podcastPreviewStatus === "error") {
    return `<p class="podcast-preview-error" role="alert">${escapeHtml(setupDraft.podcastPreviewMessage)}</p>`;
  }

  const preview = setupDraft.podcastPreview;
  if (!preview) return "";

  const latestEpisode = preview.latestEpisode || {};
  const warning = preview.warnings?.[0] || "";
  const episodeDate = latestEpisode.publishedAt ? formatDateTime(latestEpisode.publishedAt) : "";

  return `
    <article class="podcast-preview-card">
      ${
        preview.imageUrl
          ? `<span class="podcast-preview-art">
              <img class="podcast-preview-image" src="${escapeAttribute(preview.imageUrl)}" alt="" onerror="this.hidden=true; this.nextElementSibling.hidden=false;" />
              <span class="playlist-art-placeholder podcast-preview-placeholder" aria-hidden="true" hidden>${escapeHtml(getPlaylistInitials(preview.title))}</span>
            </span>`
          : `<span class="playlist-art-placeholder podcast-preview-placeholder" aria-hidden="true">${escapeHtml(getPlaylistInitials(preview.title))}</span>`
      }
      <div class="podcast-preview-copy">
        <p class="podcast-preview-label">Podcast found</p>
        <strong>${escapeHtml(preview.title || "Untitled podcast")}</strong>
        ${preview.description ? `<span>${escapeHtml(preview.description)}</span>` : ""}
        ${latestEpisode.title ? `<span>Latest: ${escapeHtml(latestEpisode.title)}</span>` : ""}
        ${episodeDate ? `<span>${escapeHtml(episodeDate)}</span>` : ""}
        <span class="${warning ? "podcast-preview-warning" : "podcast-preview-ok"}">${escapeHtml(warning || "Audio file found")}</span>
      </div>
    </article>
  `;
};

const getPodcastPreviewPayload = () => {
  if (!setupDraft.podcastPreview || setupDraft.podcastPreviewLink !== setupDraft.podcastLink.trim()) {
    return {};
  }

  const preview = setupDraft.podcastPreview;
  const latestEpisode = preview.latestEpisode || {};
  return {
    podcastTitle: preview.title || "",
    podcastDescription: preview.description || "",
    podcastImageUrl: preview.imageUrl || null,
    latestEpisodeTitle: latestEpisode.title || "",
    latestEpisodePublishedAt: latestEpisode.publishedAt || "",
    latestEpisodeGuid: latestEpisode.guid || "",
    latestEpisodeAudioUrl: latestEpisode.audioUrl || "",
    lastPreviewedAt: new Date().toISOString(),
  };
};

const canContinueFromPlaylistStep = () => {
  if (setupDraft.playlistMode === "create") {
    return Boolean(setupDraft.newPlaylistTitle.trim());
  }

  return (
    yotoCardsLoadState.status === "loaded" &&
    Boolean(setupDraft.yotoCardId) &&
    setupDraft.overwriteAcknowledged
  );
};

const formatLookSchedule = (storyCard) => {
  return isAutomaticChecksEnabled(storyCard)
    ? "Automatic checks on"
    : "Only when I press Refresh Stories";
};

const getNextCheckParts = () => {
  const datedCards = storyCards
    .map((storyCard) => ({
      value: storyCard.nextCheck,
      date: storyCard.nextAutomaticCheckAt || storyCard.nextCheck
        ? new Date(storyCard.nextAutomaticCheckAt || storyCard.nextCheck)
        : null,
    }))
    .filter((item) => item.date && !Number.isNaN(item.date.getTime()))
    .sort((first, second) => first.date.getTime() - second.date.getTime());

  if (!datedCards.length) {
    return { date: "No check set", time: "" };
  }

  const next = datedCards[0].date;
  return {
    date: new Intl.DateTimeFormat([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(next),
    time: new Intl.DateTimeFormat([], {
      hour: "numeric",
      minute: "2-digit",
    }).format(next),
  };
};

const updateMetrics = () => {
  const next = getNextCheckParts();
  const updatingCount = storyCards.filter((storyCard) => storyCard.statusType === "live").length;

  storyCardCount.textContent = String(storyCards.length);
  cardsUpdatingCount.textContent = String(updatingCount);
  nextCheckDate.textContent = next.date;
  nextCheckTime.textContent = next.time;
  storyCardsSummary.textContent =
    storyCards.length === 1
      ? "1 story card managed by this app."
      : `${storyCards.length} story cards managed by this app.`;
};

const setActiveView = async (viewName) => {
  activeView = viewName === "activity-log" ? "activity-log" : "story-cards";
  const showingActivity = activeView === "activity-log";

  storyCardsNav?.classList.toggle("is-active", !showingActivity);
  activityLogNav?.classList.toggle("is-active", showingActivity);
  if (dashboardTitle) dashboardTitle.textContent = showingActivity ? "Activity Log" : "My Story Cards";
  if (dashboardSubtitle) {
    dashboardSubtitle.textContent = showingActivity
      ? "Recent story preparation updates and things that need help."
      : "Podcast-powered Story Cards for Story Playlists.";
  }
  if (storyCardOverview) storyCardOverview.hidden = showingActivity;
  if (storyCardSectionHeading) storyCardSectionHeading.hidden = showingActivity;
  if (cardGrid) cardGrid.hidden = showingActivity;
  if (activityLogPanel) activityLogPanel.hidden = !showingActivity;

  if (showingActivity) await loadActivityLog();
};

const getActivityStoryCardName = (entry) =>
  storyCards.find((storyCard) => storyCard.id === entry.storyCardId)?.name || "";

const getActivityStoryTitle = (entry) => {
  const visibleStory = storyQueueState.stories.find((story) => story.id === entry.storyId);
  return visibleStory?.title || "";
};

const getActivityLevelLabel = (level) => (level === "error" ? "Needs help" : level === "warning" ? "Warning" : "Info");

const renderActivityLog = () => {
  if (!activityLogList) return;

  if (!activityLogEntries.length) {
    activityLogList.innerHTML = `<p class="activity-log-empty">No activity yet.</p>`;
    return;
  }

  activityLogList.innerHTML = activityLogEntries
    .map((entry) => {
      const storyCardName = getActivityStoryCardName(entry);
      const storyTitle = getActivityStoryTitle(entry);
      return `
        <article class="activity-log-item">
          <div class="activity-log-meta">
            <span class="activity-level activity-${escapeAttribute(entry.level || "info")}">${escapeHtml(getActivityLevelLabel(entry.level))}</span>
            <time>${escapeHtml(entry.createdAt ? formatDateTime(entry.createdAt) : "")}</time>
          </div>
          <div class="activity-log-copy">
            <h3>${escapeHtml(entry.title || "Feed Your Yoto update")}</h3>
            ${entry.message ? `<p>${escapeHtml(entry.message)}</p>` : ""}
            ${storyCardName || storyTitle ? `<span>${escapeHtml([storyCardName, storyTitle].filter(Boolean).join(" - "))}</span>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
};

const loadActivityLog = async () => {
  if (!activityLogList) return;
  activityLogList.innerHTML = `<p class="activity-log-empty">Loading activity...</p>`;
  try {
    const entries = await apiRequest("/api/activity-log?limit=100");
    activityLogEntries = Array.isArray(entries) ? entries : [];
  } catch (error) {
    activityLogEntries = [];
    activityLogList.innerHTML = `<p class="activity-log-empty">Could not load the Activity Log.</p>`;
    return;
  }
  renderActivityLog();
};

function renderCards() {
  updateMetrics();

  if (!storyCards.length) {
    cardGrid.innerHTML = `
      <div class="empty-state">
        <h3>No story cards yet.</h3>
        <p>Choose a Story Playlist and add a podcast link to get started.</p>
        <button class="primary-action" type="button" data-empty-add>
          <span class="button-icon" aria-hidden="true">+</span>
          Add Story Card
        </button>
      </div>
    `;
    return;
  }

  cardGrid.innerHTML = storyCards
    .map(
      (storyCard) => `
        <button class="yoto-card ${isAuthenticated ? "" : "is-locked"}" type="button" data-card-id="${escapeAttribute(storyCard.id)}" aria-disabled="${!isAuthenticated}" aria-label="${escapeAttribute(storyCard.name)}, ${escapeAttribute(storyCard.status)}, next check ${escapeAttribute(getStoryCardNextCheckLabel(storyCard))}">
          <div class="card-picture playlist-card-picture" aria-hidden="true">
            ${getStoryCardArtMarkup(storyCard)}
          </div>
          <h3 class="card-title">${escapeHtml(storyCard.name)}</h3>
          <span class="status-pill status-${escapeAttribute(storyCard.statusType)}">${escapeHtml(storyCard.status)}</span>
          <div class="card-details">
            <div>
              <span>Story Playlist</span>
              <strong>${escapeHtml(getStoryCardPlaylistTitle(storyCard))}</strong>
            </div>
            <div>
              <span>Podcast Link</span>
              <strong>${escapeHtml(storyCard.podcastTitle || getPodcastPreview(storyCard.podcastLink))}</strong>
            </div>
            <div>
              <span>Next Check</span>
              <strong>${escapeHtml(getStoryCardNextCheckLabel(storyCard))}</strong>
            </div>
            <div>
              <span>Automatic checks</span>
              <strong>${escapeHtml(formatLookSchedule(storyCard))}</strong>
            </div>
          </div>
        </button>
      `
    )
    .join("");
}

const setSwitch = (isOn) => {
  syncSwitch.classList.toggle("is-on", isOn);
  syncSwitch.setAttribute("aria-pressed", String(isOn));
  switchStatus.textContent = isOn
    ? "Feed Your Yoto checks this Podcast Link every hour."
    : "Only check when I press Refresh Stories.";
};

const getActiveStoryCard = () => storyCards.find((storyCard) => storyCard.id === activeCardId);

const refreshScheduleDraftPreview = () => {
  const activeCard = getActiveStoryCard();
  if (!activeCard) return;

  const automaticChecksEnabled = syncSwitch.classList.contains("is-on");
  updateEditorPreview({
    ...activeCard,
    automaticChecksEnabled,
    updateRhythm: automaticChecksEnabled ? activeCard.updateRhythm || "daily" : "manual",
    lateCheckRhythm: automaticChecksEnabled ? activeCard.lateCheckRhythm || "hourly" : "",
    status: automaticChecksEnabled ? "Updating" : "Taking a Break",
    statusType: automaticChecksEnabled ? "live" : "paused",
  });
};

const setEditorTab = (tabName = "stories") => {
  editorTabs.forEach((tab) => {
    const isSelected = tab.dataset.editorTab === tabName;
    tab.classList.toggle("is-selected", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  });

  editorPanels.forEach((panel) => {
    panel.hidden = panel.dataset.editorPanel !== tabName;
  });
};

const normalizePlaylistLimitValue = (value) => {
  if (value === "all") return "all";
  const numericValue = Number(value);
  return [5, 10, 15].includes(numericValue) ? numericValue : 10;
};

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const normalizeCapacityMode = (value) => value === "manual" ? "manual" : "yoto_max";

const getMigratedCapacitySettings = (storyCard = {}) => {
  if (storyCard.capacityMode) {
    return {
      capacityMode: normalizeCapacityMode(storyCard.capacityMode),
      manualMaxStoriesEnabled: storyCard.manualMaxStoriesEnabled === true,
      manualMaxStories: clampNumber(storyCard.manualMaxStories, 1, YOTO_MYO_MAX_TRACKS, defaultStoryRules.manualMaxStories),
      manualMaxStorageEnabled: storyCard.manualMaxStorageEnabled === true,
      manualMaxStorageMb: clampNumber(storyCard.manualMaxStorageMb, 1, MANUAL_MAX_STORAGE_MB_LIMIT, defaultStoryRules.manualMaxStorageMb),
      manualMaxPlayTimeEnabled: storyCard.manualMaxPlayTimeEnabled === true,
      manualMaxPlayTimeMinutes: clampNumber(storyCard.manualMaxPlayTimeMinutes, 1, MANUAL_MAX_PLAY_TIME_MINUTES_LIMIT, defaultStoryRules.manualMaxPlayTimeMinutes),
    };
  }

  const legacyLimit = normalizePlaylistLimitValue(storyCard.playlistLimit ?? "all");
  if (legacyLimit === "all") {
    return {
      capacityMode: "yoto_max",
      manualMaxStoriesEnabled: false,
      manualMaxStories: defaultStoryRules.manualMaxStories,
      manualMaxStorageEnabled: false,
      manualMaxStorageMb: defaultStoryRules.manualMaxStorageMb,
      manualMaxPlayTimeEnabled: false,
      manualMaxPlayTimeMinutes: defaultStoryRules.manualMaxPlayTimeMinutes,
    };
  }

  return {
    capacityMode: "manual",
    manualMaxStoriesEnabled: true,
    manualMaxStories: legacyLimit,
    manualMaxStorageEnabled: false,
    manualMaxStorageMb: defaultStoryRules.manualMaxStorageMb,
    manualMaxPlayTimeEnabled: false,
    manualMaxPlayTimeMinutes: defaultStoryRules.manualMaxPlayTimeMinutes,
  };
};

const getStoryRules = (storyCard = {}) => ({
  newStoryBehavior: ["auto_pick", "choose_first"].includes(storyCard.newStoryBehavior)
    ? storyCard.newStoryBehavior
    : defaultStoryRules.newStoryBehavior,
  playlistLimit: normalizePlaylistLimitValue(storyCard.playlistLimit ?? defaultStoryRules.playlistLimit),
  ...getMigratedCapacitySettings(storyCard),
  favoritesNeverRotate: storyCard.favoritesNeverRotate !== false,
});

const storyRuleChangeKeys = [
  "newStoryBehavior",
  "playlistLimit",
  "capacityMode",
  "manualMaxStoriesEnabled",
  "manualMaxStories",
  "manualMaxStorageEnabled",
  "manualMaxStorageMb",
  "manualMaxPlayTimeEnabled",
  "manualMaxPlayTimeMinutes",
  "favoritesNeverRotate",
];

const haveStoryRulesChanged = (previousRules = {}, nextRules = {}) =>
  storyRuleChangeKeys.some((key) => previousRules[key] !== nextRules[key]);

const getEditorStoryRules = () => {
  const selectedBehavior = newStoryBehaviorButtons.find((button) =>
    button.classList.contains("is-selected")
  );
  const selectedCapacityMode = capacityModeButtons.find((button) =>
    button.classList.contains("is-selected")
  );
  const maxStoriesValue = clampNumber(manualMaxStories?.value, 1, YOTO_MYO_MAX_TRACKS, defaultStoryRules.manualMaxStories);
  const maxStorageValue = clampNumber(manualMaxStorageMb?.value, 1, MANUAL_MAX_STORAGE_MB_LIMIT, defaultStoryRules.manualMaxStorageMb);
  const playTimeHours = clampNumber(manualMaxPlayTimeHours?.value, 0, 60, 0);
  const playTimeMinuteRemainder = clampNumber(manualMaxPlayTimeMinutes?.value, 0, 59, 0);
  const maxPlayTimeValue = clampNumber(
    playTimeHours * 60 + playTimeMinuteRemainder,
    1,
    MANUAL_MAX_PLAY_TIME_MINUTES_LIMIT,
    defaultStoryRules.manualMaxPlayTimeMinutes
  );

  return {
    newStoryBehavior: selectedBehavior?.dataset.newStoryBehavior || defaultStoryRules.newStoryBehavior,
    capacityMode: normalizeCapacityMode(selectedCapacityMode?.dataset.capacityMode),
    manualMaxStoriesEnabled: Boolean(manualMaxStoriesEnabled?.checked),
    manualMaxStories: Math.round(maxStoriesValue),
    manualMaxStorageEnabled: Boolean(manualMaxStorageEnabled?.checked),
    manualMaxStorageMb: Math.round(maxStorageValue),
    manualMaxPlayTimeEnabled: Boolean(manualMaxPlayTimeEnabled?.checked),
    manualMaxPlayTimeMinutes: Math.round(maxPlayTimeValue),
    playlistLimit: normalizeCapacityMode(selectedCapacityMode?.dataset.capacityMode) === "manual" &&
      Boolean(manualMaxStoriesEnabled?.checked) &&
      [5, 10, 15].includes(Math.round(maxStoriesValue))
        ? Math.round(maxStoriesValue)
        : "all",
    favoritesNeverRotate: true,
  };
};

const setStoryRules = (storyCard = {}) => {
  const rules = getStoryRules(storyCard);

  newStoryBehaviorButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.newStoryBehavior === rules.newStoryBehavior);
  });

  capacityModeButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.capacityMode === rules.capacityMode);
  });
  if (manualCapacityControls) manualCapacityControls.hidden = rules.capacityMode !== "manual";
  if (manualMaxStoriesEnabled) manualMaxStoriesEnabled.checked = rules.manualMaxStoriesEnabled;
  if (manualMaxStories) manualMaxStories.value = String(rules.manualMaxStories);
  if (manualMaxStorageEnabled) manualMaxStorageEnabled.checked = rules.manualMaxStorageEnabled;
  if (manualMaxStorageMb) manualMaxStorageMb.value = String(rules.manualMaxStorageMb);
  if (manualMaxPlayTimeEnabled) manualMaxPlayTimeEnabled.checked = rules.manualMaxPlayTimeEnabled;
  if (manualMaxPlayTimeHours) manualMaxPlayTimeHours.value = String(Math.floor(rules.manualMaxPlayTimeMinutes / 60));
  if (manualMaxPlayTimeMinutes) manualMaxPlayTimeMinutes.value = String(rules.manualMaxPlayTimeMinutes % 60);
};

const setStoriesSubtab = (tabName = "queue") => {
  storySubtabs.forEach((tab) => {
    const isSelected = tab.dataset.storiesSubtab === tabName;
    tab.classList.toggle("is-selected", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  });

  storySubpanels.forEach((panel) => {
    panel.hidden = panel.dataset.storiesSubpanel !== tabName;
  });
};

const getStorySortValue = (story) => {
  const dateValue = story.publishedAt || story.firstSeenAt || "";
  const date = new Date(dateValue);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

const sortPreviewStories = (stories) =>
  stories.slice().sort((first, second) => getStorySortValue(second) - getStorySortValue(first));

const getStoryCapacityFileSize = (story) =>
  Number(story?.yotoFileSize || story?.fileSize || story?.contentLength || story?.lastPrepareContentLength || 0);

const getStoryCapacityDuration = (story) => Number(story?.yotoDuration || story?.estimatedDuration || 0);

const getEmptyPlaylistCapacity = () => ({
  tracks: 0,
  fileSize: 0,
  duration: 0,
  unknownSizeCount: 0,
  unknownDurationCount: 0,
});

const getPlaylistCapacityLimits = (rules = {}) => {
  const settings = getMigratedCapacitySettings(rules);
  const baseLimits = {
    capacityMode: settings.capacityMode,
    maxTracks: YOTO_MYO_MAX_TRACKS,
    maxStorageBytes: null,
    maxStorageMb: null,
    maxPlayTimeSeconds: null,
    maxPlayTimeMinutes: null,
    manualMaxStoriesEnabled: false,
    manualMaxStorageEnabled: false,
    manualMaxPlayTimeEnabled: false,
  };

  if (settings.capacityMode === "manual") {
    return {
      ...baseLimits,
      maxTracks: settings.manualMaxStoriesEnabled ? settings.manualMaxStories : YOTO_MYO_MAX_TRACKS,
      maxStorageBytes: settings.manualMaxStorageEnabled ? settings.manualMaxStorageMb * 1024 * 1024 : null,
      maxStorageMb: settings.manualMaxStorageEnabled ? settings.manualMaxStorageMb : null,
      maxPlayTimeSeconds: settings.manualMaxPlayTimeEnabled ? settings.manualMaxPlayTimeMinutes * 60 : null,
      maxPlayTimeMinutes: settings.manualMaxPlayTimeEnabled ? settings.manualMaxPlayTimeMinutes : null,
      manualMaxStoriesEnabled: settings.manualMaxStoriesEnabled,
      manualMaxStorageEnabled: settings.manualMaxStorageEnabled,
      manualMaxPlayTimeEnabled: settings.manualMaxPlayTimeEnabled,
    };
  }

  return {
    ...baseLimits,
    maxTracks: YOTO_MYO_MAX_TRACKS,
    maxStorageBytes: YOTO_MYO_MAX_TOTAL_BYTES,
    maxStorageMb: 500,
    maxPlayTimeSeconds: YOTO_MYO_MAX_TOTAL_SECONDS,
    maxPlayTimeMinutes: 300,
  };
};

const getStoryCapacityReason = (story, capacity, limits) => {
  const fileSize = getStoryCapacityFileSize(story);
  const duration = getStoryCapacityDuration(story);

  if (capacity.tracks >= YOTO_MYO_MAX_TRACKS) return "track_limit";
  if (capacity.tracks >= limits.maxTracks) return limits.capacityMode === "manual" ? "manual_story_count" : "track_limit";
  if (fileSize > YOTO_MYO_MAX_TRACK_BYTES) return "track_file_size";
  if (duration > YOTO_MYO_MAX_TRACK_SECONDS) return "track_duration";
  if (limits.maxStorageBytes && !fileSize) return "unknown_file_size";
  if (limits.maxPlayTimeSeconds && !duration) return "unknown_duration";
  if (limits.maxStorageBytes && capacity.fileSize + fileSize > limits.maxStorageBytes) {
    return limits.capacityMode === "manual" ? "manual_storage" : "card_file_size";
  }
  if (limits.maxPlayTimeSeconds && capacity.duration + duration > limits.maxPlayTimeSeconds) {
    return limits.capacityMode === "manual" ? "manual_play_time" : "card_duration";
  }
  return "";
};

const addStoryToPlaylistCapacity = (capacity, story) => {
  const fileSize = getStoryCapacityFileSize(story);
  const duration = getStoryCapacityDuration(story);

  return {
    tracks: capacity.tracks + 1,
    fileSize: capacity.fileSize + fileSize,
    duration: capacity.duration + duration,
    unknownSizeCount: capacity.unknownSizeCount + (fileSize ? 0 : 1),
    unknownDurationCount: capacity.unknownDurationCount + (duration ? 0 : 1),
  };
};

const applyPlaylistCapacityLimits = (stories, rules) => {
  const limits = getPlaylistCapacityLimits(rules);
  let capacity = getEmptyPlaylistCapacity();
  const included = [];
  const overflow = [];
  const warnings = [];

  stories.forEach((story) => {
    const capacityReason = getStoryCapacityReason(story, capacity, limits);
    if (capacityReason) {
      if (story.isPinned && rules.favoritesNeverRotate && !["track_limit", "track_file_size", "track_duration", "unknown_file_size", "unknown_duration"].includes(capacityReason)) {
        warnings.push("favorites_exceed_limits");
        included.push({ ...story, capacityWarning: capacityReason });
        capacity = addStoryToPlaylistCapacity(capacity, story);
        return;
      }

      overflow.push({ ...story, capacityReason });
      return;
    }

    included.push(story);
    capacity = addStoryToPlaylistCapacity(capacity, story);
  });

  return { included, overflow, capacity, limits, warnings: [...new Set(warnings)] };
};

const shouldAutoRestoreRestingStory = (story = {}, rules = {}) =>
  story.status === "rotated_off" &&
  rules.newStoryBehavior === "auto_pick" &&
  !(story.isSkipped || story.status === "skipped") &&
  canStoryOccupyPlaylistSlot(story);

const storyStatusesWithPreparedAudio = new Set([
  "downloaded",
  "uploading",
  "uploaded",
  "adding_to_playlist",
  "synced",
]);

const isStoryAudioUsable = (story) => {
  const audioUrl = String(story?.audioUrl || "").trim().toLowerCase();
  return audioUrl.startsWith("http://") || audioUrl.startsWith("https://");
};

const hasPreparedStoryAudio = (story) =>
  Boolean(
    story?.localFilePath ||
      story?.sha256 ||
      story?.yotoUploadId ||
      story?.yotoTrackUrl ||
      story?.transcodedSha256 ||
      storyStatusesWithPreparedAudio.has(story?.status)
  );

const isStoryMissingRssAudio = (story) => !isStoryAudioUsable(story) && !hasPreparedStoryAudio(story);

const canStoryOccupyPlaylistSlot = (story) => !isStoryMissingRssAudio(story);

const storyNeedsHelp = (story) => story?.status === "failed" && !isStoryMissingRssAudio(story);

const getStoryDownloadError = (story) =>
  story?.downloadError || (isStoryMissingRssAudio(story) ? MISSING_AUDIO_DOWNLOAD_MESSAGE : "");

const getPlaylistPreview = (rules, stories) => {
  const sortedStories = sortPreviewStories(stories);
  const onYotoCandidates = [];
  const newStories = [];
  const skippedStories = [];
  const oldStoryCandidates = [];
  const favorites = sortedStories.filter((story) => story.isPinned);

  sortedStories.forEach((story) => {
    const isSkipped = story.isSkipped || story.status === "skipped";
    const isSelected = story.isSelected || story.status === "selected" || story.status === "synced";
    const isDiscovered = story.status === "discovered";
    const isRestingAutoCandidate = shouldAutoRestoreRestingStory(story, rules);
    const favoriteIncluded = Boolean(story.isPinned && rules.favoritesNeverRotate);
    const wantsPlaylistSlot = favoriteIncluded ||
      isSelected ||
      isRestingAutoCandidate ||
      (rules.newStoryBehavior === "auto_pick" && isDiscovered);

    if (isStoryMissingRssAudio(story)) {
      skippedStories.push(story);
      return;
    }

    if (isSkipped && !favoriteIncluded) {
      skippedStories.push(story);
      return;
    }

    if (wantsPlaylistSlot && canStoryOccupyPlaylistSlot(story)) {
      onYotoCandidates.push(isRestingAutoCandidate ? { ...story, isAutoRestoredFromResting: true } : story);
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
    if (rules.newStoryBehavior === "choose_first") {
      const firstSelected = Boolean(first.isSelected || first.status === "selected");
      const secondSelected = Boolean(second.isSelected || second.status === "selected");
      if (firstSelected !== secondSelected) return firstSelected ? -1 : 1;
    }
    return getStorySortValue(second) - getStorySortValue(first);
  });

  const capacityPreview = applyPlaylistCapacityLimits(prioritizedCandidates, rules);
  const onYotoSoon = capacityPreview.included;
  const oldStoriesResting = [...capacityPreview.overflow, ...oldStoryCandidates];

  return {
    onYotoSoon,
    newStories,
    skippedStories,
    oldStoriesResting,
    favorites,
    capacity: capacityPreview.capacity,
    capacityLimits: capacityPreview.limits,
    capacityWarnings: capacityPreview.warnings,
  };
};

const getStoryQueueLastChecked = () => {
  const activeCard = storyCards.find((storyCard) => storyCard.id === storyQueueState.storyCardId);
  return activeCard?.lastStoryDiscoveryAt ? `Last checked ${formatDateTime(activeCard.lastStoryDiscoveryAt)}` : "";
};

const getStoryQueueCard = () =>
  storyCards.find((storyCard) => storyCard.id === storyQueueState.storyCardId);

const renderStoryQueuePodcastSummary = () => {
  const activeCard = getStoryQueueCard();
  if (!activeCard) return "";

  const podcastTitle = activeCard.podcastTitle || activeCard.name || "Podcast";
  const podcastDescription = truncateText(activeCard.podcastDescription, 320);
  const sourceLabel = getPodcastPreview(activeCard.podcastLink);

  return `
    <article class="story-podcast-summary">
      <div>
        <p class="section-kicker">Podcast</p>
        <h4>${escapeHtml(podcastTitle)}</h4>
        ${podcastDescription ? `<p>${escapeHtml(podcastDescription)}</p>` : ""}
      </div>
      <span>${escapeHtml(sourceLabel)}</span>
    </article>
  `;
};

const isStoryReadyToBringHome = (story) =>
  isStoryAudioUsable(story) &&
  !story?.yotoUploadId &&
  !story?.yotoTrackUrl &&
  !story?.transcodedSha256 &&
  story.status !== "downloaded" &&
  story.status !== "uploading" &&
  story.status !== "uploaded" &&
  story.status !== "adding_to_playlist" &&
  story.status !== "synced";

const setStoryDownloadState = (nextState) => {
  storyDownloadState = { ...storyDownloadState, ...nextState };
  renderStoryQueue();
  updateStoryQueuePolling();
};

const isStoryRestingForDisplay = (story, group = "new") =>
  group === "old" || (story.status === "rotated_off" && !story.isAutoRestoredFromResting);

const getStoryStatusClass = (story, group = "new") => {
  if (storyNeedsHelp(story)) return "is-error";
  if (isStoryMissingRssAudio(story) || story.status === "skipped") return "is-skipped";
  if (isStoryRestingForDisplay(story, group)) return "is-resting";
  if (isStoryWaitingForYoto(story)) return "is-waiting";
  if (["downloading", "downloaded", "uploading", "uploaded", "adding_to_playlist", "selected", "discovered"].includes(story?.status)) {
    return "is-active";
  }
  if (story?.status === "synced") return "is-ready";
  return "is-active";
};

const getStoryDisplayStatus = (story, group = "new") => {
  if (isStoryMissingRssAudio(story) || story.status === "skipped") return "Skipped";
  if (isStoryRestingForDisplay(story, group)) return "Resting story";
  if (isStoryWaitingForYoto(story)) return "Waiting on Yoto";
  if (storyNeedsHelp(story)) return "Needs help";
  if (story.isAutoRestoredFromResting && group === "on_yoto") return "Picked for Yoto";
  if (group === "on_yoto" && story.status === "discovered") return "Picked for Yoto";
  if (story.status === "downloading") return "Getting story ready";
  return storyStatusLabels[story.status] || story.statusLabel || "New story found";
};

const getFailedStoryTrackerStep = (story) => {
  if (story?.playlistUpdateStatus === "failed" || story?.playlistUpdateError) return "updating";
  if (story?.yotoUploadStatus === "failed" || story?.uploadError) return "sending";
  return "preparing";
};

const getStoryTrackerStep = (story, group = "new") => {
  if (storyNeedsHelp(story)) return getFailedStoryTrackerStep(story);
  if (story?.status === "synced") return "ready";
  if (story?.status === "adding_to_playlist" || shouldRetryStoryPlaylistUpdate(story)) return "updating";
  if (
    isStoryWaitingForYoto(story) ||
    ["uploading", "processing", "uploaded", "waiting_on_yoto"].includes(story?.status) ||
    story?.yotoUploadStatus === "processing" ||
    story?.yotoTranscodeStatus === "processing" ||
    story?.playlistUpdateStatus === "waiting"
  ) {
    return "sending";
  }
  if (story?.status === "downloading" || story?.status === "downloaded") return "preparing";
  if (group === "on_yoto" || story?.status === "selected") return "found";
  return "found";
};

const isStoryActivelyProcessing = (story) =>
  Boolean(
    storyDownloadState.storyIds.has(story.id) ||
      storyDownloadState.uploadIds.has(story.id) ||
      ["downloading", "uploading", "adding_to_playlist"].includes(story?.status) ||
      isStoryWaitingForYoto(story) ||
      (storyDownloadState.syncing && story?.status === "uploaded")
  );

const shouldShowStoryTracker = (story, group = "new") => {
  if (isStoryMissingRssAudio(story)) return false;
  if (isStoryRestingForDisplay(story, group) || story.status === "skipped") return false;
  if (story.status === "selected") return true;
  if (storyNeedsHelp(story) || story.status === "synced" || story.status === "downloaded") return true;
  return isStoryActivelyProcessing(story);
};

const getStoryTrackerStepIndex = (stepKey) => {
  const index = storyTrackerSteps.findIndex((step) => step.key === stepKey);
  return Math.max(0, index);
};

const getStorySendingWork = (story) => {
  if (getStoryTrackerStep(story) !== "sending") return null;
  return { label: "Working" };
};

const renderStoryTracker = (story, group = "new") => {
  if (!shouldShowStoryTracker(story, group)) return "";

  const activeStep = getStoryTrackerStep(story, group);
  const statusIndex = getStoryTrackerStepIndex(activeStep);
  const previousIndex = storyTrackerPreviousSteps.has(story.id)
    ? storyTrackerPreviousSteps.get(story.id)
    : statusIndex;
  const stepDistance = Math.abs(previousIndex - statusIndex);
  const startOffset = (previousIndex - statusIndex) * STORY_TRACKER_STEP_SPACING;
  const moveDuration = Math.min(2600, Math.max(1200, 850 + stepDistance * 520));
  const readyDuration = Math.min(5200, Math.max(3400, 2600 + stepDistance * 900));
  const isReady = story.status === "synced";
  const isFailed = storyNeedsHelp(story);
  const isMoving = previousIndex !== statusIndex;
  const justReachedReady = isReady && previousIndex !== statusIndex;
  const sendingWork = getStorySendingWork(story);
  const cardStateClass = [
    isMoving ? "is-moving" : "",
    sendingWork && !isMoving ? "is-working" : "",
  ]
    .filter(Boolean)
    .join(" ");
  storyTrackerPreviousSteps.set(story.id, statusIndex);

  return `
    <div class="story-tracker story-tracker-animated ${isReady ? "is-ready" : ""} ${justReachedReady ? "is-ready-arriving" : ""} ${isFailed ? "is-failed" : ""}" aria-label="Story Journey" data-active-step="${statusIndex}">
      <p>Story Journey</p>
      <ol style="--tracker-book-top: ${statusIndex * STORY_TRACKER_STEP_SPACING}px; --tracker-start-offset: ${startOffset}px; --tracker-move-duration: ${moveDuration}ms; --tracker-ready-duration: ${readyDuration}ms;">
        ${storyTrackerSteps
          .map((step, index) => {
            const state =
              index < statusIndex || (isReady && index < storyTrackerSteps.length - 1)
                ? "is-done"
                : index === statusIndex
                  ? "is-active"
                  : "";
            const readyIndicator =
              step.key === "ready"
                ? `<span class="story-tracker-ready-badge ${isReady ? "is-complete" : ""}" aria-hidden="true"></span>`
                : `<span class="story-tracker-step-dot"></span>`;
            return `<li class="story-tracker-step ${state}">${readyIndicator}${escapeHtml(step.label)}</li>`;
          })
          .join("")}
        ${
          isReady
            ? `<span class="story-tracker-book story-tracker-book-ready ${justReachedReady ? "is-arriving" : ""}" aria-hidden="true"><span></span></span>`
            : `<span class="story-tracker-book ${cardStateClass}" aria-hidden="true"><span></span></span>`
        }
      </ol>
      ${
        sendingWork
          ? `<div class="story-tracker-working" aria-label="${escapeAttribute(sendingWork.label)}">
              <span class="story-tracker-spinner" aria-hidden="true"></span>
              <span>${escapeHtml(sendingWork.label)}</span>
            </div>`
          : ""
      }
    </div>
  `;
};

const hasStoryDownloadMetadata = (story) =>
  Boolean(story?.localFilePath && Number(story?.fileSize) && story?.contentType && story?.sha256);

const missingDownloadedFileMessage = "The downloaded story file is missing. Try preparing it again.";

const isStoryReadyToUpload = (story) => story?.status === "downloaded" && hasStoryDownloadMetadata(story);

const getStoryTranscodedSha256 = (story) => {
  const explicitSha = String(story?.transcodedSha256 || story?.yotoTrackId || "").trim().replace(/^yoto:#/, "");
  if (explicitSha) return explicitSha;
  const trackUrl = String(story?.yotoTrackUrl || "").trim();
  return trackUrl.startsWith("yoto:#") ? trackUrl.replace(/^yoto:#/, "") : "";
};

const hasYotoUploadMetadata = (story) => Boolean(story?.yotoUploadId);

const hasUsableYotoTrackMetadata = (story) =>
  Boolean(
    getStoryTranscodedSha256(story) &&
      String(story?.yotoTrackUrl || "").startsWith("yoto:#") &&
      Number(story?.yotoFileSize || story?.fileSize || 0)
  );

const getStoryRetryAfterTime = (story) => {
  const retryAfter = String(story?.yotoTranscodeRetryAfter || story?.playlistUpdateRetryAfter || "").trim();
  if (!retryAfter) return 0;
  const time = new Date(retryAfter).getTime();
  return Number.isFinite(time) ? time : 0;
};

const isStoryWaitingForYoto = (story) =>
  story?.status === "uploaded" &&
  (story?.yotoUploadStatus === "processing" ||
    story?.yotoTranscodeStatus === "processing" ||
    Boolean(story?.yotoTranscodeRetryAfter) ||
    story?.playlistUpdateStatus === "waiting");

const isStoryWaitingForPlaylist = isStoryWaitingForYoto;

const isPlaylistRetryReady = (story) => {
  const retryAfter = getStoryRetryAfterTime(story);
  return !retryAfter || retryAfter <= Date.now();
};

const getPlaylistRetryDelayMs = (story) => {
  const retryAfter = getStoryRetryAfterTime(story);
  if (!retryAfter) return MIN_PLAYLIST_RETRY_DELAY_MS;
  return Math.max(retryAfter - Date.now(), MIN_PLAYLIST_RETRY_DELAY_MS);
};

const isStoryReadyToSync = (story) =>
  (story?.status === "uploaded" || story?.isAutoRestoredFromResting) &&
  hasUsableYotoTrackMetadata(story) &&
  isPlaylistRetryReady(story);

const shouldRetryStoryPlaylistUpdate = (story) =>
  Boolean(
    (story?.status === "uploaded" || story?.status === "failed") &&
      (hasUsableYotoTrackMetadata(story) || hasYotoUploadMetadata(story)) &&
      story?.yotoUploadStatus !== "failed" &&
      (story?.yotoUploadStatus === "processing" ||
        story?.yotoUploadStatus === "uploaded" ||
        story?.playlistUpdateStatus === "waiting" ||
        story?.playlistUpdateStatus === "failed")
  );

const shouldRetryStoryUpload = (story) =>
  story?.status === "failed" &&
  story?.yotoUploadStatus === "failed" &&
  hasStoryDownloadMetadata(story) &&
  !String(story.uploadError || "").toLowerCase().includes(missingDownloadedFileMessage.toLowerCase());

const getStoriesNeedingPreparation = (preview) =>
  (preview.onYotoSoon || []).filter(isStoryReadyToBringHome);

const getStoriesReadyToUpload = (stories) => (stories || []).filter(isStoryReadyToUpload);

const getStoriesReadyToSync = (stories) => (stories || []).filter(isStoryReadyToSync);

const getStoriesWaitingForYoto = (stories) =>
  (stories || []).filter((story) => isStoryWaitingForPlaylist(story));

const getStoryProcessingProgress = (preview, stories = []) => {
  const targets = preview.onYotoSoon || [];
  const targetIds = new Set(targets.map((story) => story.id));
  const targetStories = stories.filter((story) => targetIds.has(story.id));
  const totalTargetStories = targets.length;
  const downloadingStories = targetStories.filter((story) => story.status === "downloading");
  const sendingStories = targetStories.filter((story) => story.status === "uploading");
  const waitingStories = targetStories.filter(isStoryWaitingForYoto);
  const updatingStories = targetStories.filter((story) => story.status === "adding_to_playlist");
  const readyStories = targetStories.filter((story) => story.status === "synced" || hasUsableYotoTrackMetadata(story));
  const failedStories = targetStories.filter(storyNeedsHelp);
  const processedStories = targetStories.filter((story) =>
    story.status === "synced" ||
      hasUsableYotoTrackMetadata(story) ||
      storyNeedsHelp(story) ||
      isStoryMissingRssAudio(story)
  );
  const activeStory = [...downloadingStories, ...sendingStories, ...updatingStories, ...waitingStories][0] || null;
  const activeCount = downloadingStories.length + sendingStories.length + updatingStories.length;
  const isWorking =
    storyDownloadState.processing ||
    storyDownloadState.bulk ||
    storyDownloadState.syncing ||
    storyDownloadState.storyIds.size ||
    storyDownloadState.uploadIds.size ||
    activeCount > 0 ||
    waitingStories.length > 0;

  return {
    totalTargetStories,
    processedCount: Math.min(processedStories.length, totalTargetStories),
    downloadingCount: downloadingStories.length,
    sendingCount: sendingStories.length,
    waitingCount: waitingStories.length,
    updatingCount: updatingStories.length,
    readyCount: readyStories.length,
    failedCount: failedStories.length,
    activeStory,
    isWorking,
  };
};

const renderProcessingProgress = (preview) => {
  const progress = getStoryProcessingProgress(preview, storyQueueState.stories);
  if (!progress.isWorking && !progress.waitingCount) return "";

  const percent = progress.totalTargetStories
    ? Math.min(100, Math.round((progress.processedCount / progress.totalTargetStories) * 100))
    : 0;
  const countLabel = progress.totalTargetStories
    ? `${progress.processedCount} / ${progress.totalTargetStories} stories processed`
    : "Working...";

  return `
    <section class="story-processing-progress" aria-label="Processing stories">
      <div class="story-processing-header">
        <div>
          <p class="section-kicker">Processing stories</p>
          <h4>Processing stories</h4>
          <span>Feed Your Yoto is downloading, sending, and updating stories. You can leave this page open to watch progress.</span>
        </div>
        <strong>${escapeHtml(countLabel)}</strong>
      </div>
      <div class="story-processing-track" aria-hidden="true">
        <span style="width: ${percent}%"></span>
      </div>
      <div class="story-processing-counts" aria-label="Processing counts">
        <span>Downloading <strong>${progress.downloadingCount}</strong></span>
        <span>Sending to Yoto <strong>${progress.sendingCount}</strong></span>
        <span>Waiting on Yoto <strong>${progress.waitingCount}</strong></span>
        <span>Updating playlist <strong>${progress.updatingCount}</strong></span>
        <span>Ready <strong>${progress.readyCount}</strong></span>
        <span>Needs help <strong>${progress.failedCount}</strong></span>
      </div>
      ${progress.activeStory ? `<p>Now working on: ${escapeHtml(progress.activeStory.title || "Untitled story")}</p>` : ""}
    </section>
  `;
};

const formatDuration = (secondsValue) => {
  const totalSeconds = Number(secondsValue || 0);
  if (!totalSeconds) return "";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours && minutes) return `${hours} hr ${minutes} min`;
  if (hours) return `${hours} hr`;
  return `${minutes || 1} min`;
};

const renderPlaylistCapacityMeter = (preview) => {
  const capacity = preview.capacity || getEmptyPlaylistCapacity();
  const limits = preview.capacityLimits || getPlaylistCapacityLimits(getEditorStoryRules());
  const trackLimit = limits.maxTracks || YOTO_MYO_MAX_TRACKS;
  const storageLimit = limits.maxStorageBytes;
  const playTimeLimit = limits.maxPlayTimeSeconds;
  const trackPercent = Math.min(100, Math.round((capacity.tracks / trackLimit) * 100));
  const storagePercent = storageLimit ? Math.min(100, Math.round((capacity.fileSize / storageLimit) * 100)) : 0;
  const playTimePercent = playTimeLimit ? Math.min(100, Math.round((capacity.duration / playTimeLimit) * 100)) : 0;
  const getTone = (percent) => percent >= 100 ? "is-full" : percent >= 80 ? "is-warning" : "";
  const settingsText = limits.capacityMode === "manual"
    ? "Feed Your Yoto will stop before any manual limit you turn on."
    : "Feed Your Yoto will stop before the Story Playlist reaches Yoto's recommended limits.";
  const warningText = preview.capacityWarnings?.includes("favorites_exceed_limits")
    ? "Favorites exceed the selected limits, so Feed Your Yoto is keeping them and pausing new additions."
    : [trackPercent, storagePercent, playTimePercent].some((percent) => percent >= 100)
      ? limits.capacityMode === "manual"
        ? "Manual playlist limit reached."
        : "Max Yoto setting reached."
      : "";
  const renderRow = ({ label, value, percent, disabled = false }) => `
    <div class="story-capacity-row ${disabled ? "is-disabled" : ""} ${getTone(percent)}">
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
      <div class="story-capacity-track" aria-hidden="true">
        <span style="width: ${disabled ? 0 : percent}%"></span>
      </div>
    </div>
  `;

  return `
    <div class="story-capacity-meter" aria-label="Story Playlist capacity">
      <div class="story-capacity-meter-header">
        <div>
          <span>Playlist capacity</span>
          <strong>Feed Your Yoto watches track count, storage, and play time.</strong>
        </div>
        <p>${escapeHtml(settingsText)}</p>
      </div>
      ${renderRow({
        label: "Tracks",
        value: `${capacity.tracks} / ${trackLimit} tracks`,
        percent: trackPercent,
      })}
      ${renderRow({
        label: "Storage",
        value: storageLimit ? `${formatFileSize(capacity.fileSize) || "0 MB"} of ${formatFileSize(storageLimit)}` : `${formatFileSize(capacity.fileSize) || "0 MB"} used`,
        percent: storagePercent,
        disabled: !storageLimit,
      })}
      ${renderRow({
        label: "Play time",
        value: playTimeLimit ? `${formatDuration(capacity.duration) || "0 min"} of ${formatDuration(playTimeLimit)}` : `${formatDuration(capacity.duration) || "0 min"} used`,
        percent: playTimePercent,
        disabled: !playTimeLimit,
      })}
      ${warningText ? `<p class="story-capacity-warning">${escapeHtml(warningText)}</p>` : ""}
    </div>
  `;
};

const renderStoryStatusSummary = (preview) => {
  const storiesToPrepare = getStoriesNeedingPreparation(preview).length;
  const storiesToSend = getStoriesReadyToUpload(storyQueueState.stories).length;
  const storiesToSync = getStoriesReadyToSync(storyQueueState.stories).length;
  const storiesWaitingForYoto = getStoriesWaitingForYoto(storyQueueState.stories).length;
  const needsHelpCount = storyQueueState.stories.filter(storyNeedsHelp).length;
  const capacityRestingCount = (preview.oldStoriesResting || []).filter((story) => story.capacityReason).length;
  const isAutomaticMode = getEditorStoryRules().newStoryBehavior !== "choose_first";
  const automaticNote = storyDownloadState.processing
    ? storyDownloadState.syncing
      ? "Updating the Story Playlist..."
      : storiesToSend
        ? "Sending stories to Yoto..."
        : "Getting stories ready..."
    : storiesToPrepare
      ? "Feed Your Yoto will get picked stories ready automatically."
      : storiesToSend
        ? "Feed Your Yoto will send ready stories to Yoto automatically."
        : storiesToSync
          ? "Feed Your Yoto will update the Story Playlist automatically."
          : storiesWaitingForYoto
            ? YOTO_PROCESSING_MESSAGE
            : capacityRestingCount
              ? "Some stories are resting until Feed Your Yoto knows they will fit."
            : "Everything picked is ready on Yoto.";

  return `
    <section class="story-status-summary" aria-labelledby="storyPlaylistStatusTitle">
      <div>
        <p class="section-kicker">Story Playlist Status</p>
        <h4 id="storyPlaylistStatusTitle">Story Playlist Status</h4>
        <p>Feed Your Yoto keeps this Story Playlist filled from the Podcast Link.</p>
      </div>
      <div class="story-summary-counts" aria-label="Story Playlist counts">
        <span><strong>${preview.onYotoSoon.length}</strong> Playlist Lineup</span>
        <span><strong>${preview.newStories.length}</strong> New stories</span>
        <span><strong>${preview.favorites.length}</strong> Favorites</span>
        <span><strong>${needsHelpCount}</strong> Needs help</span>
      </div>
      ${renderPlaylistCapacityMeter(preview)}
      ${renderProcessingProgress(preview)}
      ${isAutomaticMode ? `<p class="story-auto-note">${automaticNote}</p>` : renderManualPreparePanel(storiesToPrepare, storiesToSync)}
    </section>
  `;
};

const renderManualPreparePanel = (storiesToPrepareCount, storiesToSync = 0) => {
  const busy = storyDownloadState.bulk;
  const syncing = storyDownloadState.syncing;
  const helper = storiesToSync
    ? `${storiesToSync} ${storiesToSync === 1 ? "story is" : "stories are"} ready for the Story Playlist.`
    : storiesToPrepareCount
      ? `${storiesToPrepareCount} ${storiesToPrepareCount === 1 ? "story is" : "stories are"} ready for the next step.`
      : "Pick a story first, then Feed Your Yoto can prepare it.";

  return `
    <div class="story-download-panel">
      <p>${escapeHtml(helper)}</p>
      ${storiesToSync ? `<button class="outline-action" type="button" data-sync-playlist ${syncing ? "disabled" : ""}>${syncing ? "Updating Playlist..." : "Update Story Playlist"}</button>` : ""}
      <button class="outline-action" type="button" data-download-selected ${!storiesToPrepareCount || busy ? "disabled" : ""}>
        ${busy ? "Preparing stories..." : "Prepare Stories"}
      </button>
    </div>
  `;
};

const getPreviewStorySets = (preview, stories = []) => ({
  on_yoto: new Set((preview.onYotoSoon || []).map((story) => story.id)),
  new: new Set((preview.newStories || []).map((story) => story.id)),
  needs_help: new Set((stories || []).filter(storyNeedsHelp).map((story) => story.id)),
  favorites: new Set((preview.favorites || []).map((story) => story.id)),
  old: new Set((preview.oldStoriesResting || []).map((story) => story.id)),
  skipped: new Set((preview.skippedStories || []).map((story) => story.id)),
});

const getStoryGroupFromPreview = (story, previewSets) => {
  if (previewSets.on_yoto.has(story.id)) return "on_yoto";
  if (previewSets.new.has(story.id)) return "new";
  if (previewSets.old.has(story.id)) return "old";
  if (previewSets.skipped.has(story.id)) return "skipped";
  return "new";
};

const getPreviewStory = (story, preview) =>
  [
    ...(preview.onYotoSoon || []),
    ...(preview.newStories || []),
    ...(preview.oldStoriesResting || []),
    ...(preview.skippedStories || []),
  ].find((item) => item.id === story.id) || story;

const storyFilterOptions = [
  { key: "all", label: "All Stories" },
  { key: "on_yoto", label: "Playlist Lineup" },
  { key: "needs_help", label: "Needs Help" },
  { key: "favorites", label: "Favorites" },
  { key: "old", label: "Resting Stories" },
  { key: "skipped", label: "Skipped" },
];

const getStoryFilterCounts = (preview, totalCount, stories = []) => ({
  all: totalCount,
  on_yoto: preview.onYotoSoon.length,
  needs_help: stories.filter(storyNeedsHelp).length,
  favorites: preview.favorites.length,
  old: preview.oldStoriesResting.length,
  skipped: preview.skippedStories.length,
});

const renderStoryFilterTags = (preview, totalCount) => {
  const counts = getStoryFilterCounts(preview, totalCount, storyQueueState.stories);
  const selectedFilter = storyQueueState.filter || "all";

  return `
    <div class="story-filter-tags" role="tablist" aria-label="Story filters">
      ${storyFilterOptions
        .map(
          (option) => `
            <button class="story-filter-tag ${selectedFilter === option.key ? "is-selected" : ""}" type="button" role="tab" aria-selected="${selectedFilter === option.key}" data-story-filter="${escapeAttribute(option.key)}">
              <span>${escapeHtml(option.label)}</span>
              <strong>${counts[option.key] || 0}</strong>
            </button>
          `
        )
        .join("")}
    </div>
  `;
};

const getFilteredStories = (stories, previewSets) => {
  const filter = storyQueueState.filter || "all";
  if (filter === "all") return stories;
  const matchingIds = previewSets[filter];
  return matchingIds ? stories.filter((story) => matchingIds.has(story.id)) : stories;
};

const renderStoryQueue = () => {
  if (!storyQueueContent) return;

  if (refreshStories) {
    refreshStories.disabled = storyQueueState.status === "loading";
    refreshStories.textContent = storyQueueState.status === "loading" ? "Looking..." : "Refresh Stories";
  }

  if (storyQueueState.status === "loading") {
    storyQueueContent.innerHTML = `<p class="story-queue-message" role="status">Looking for stories...</p>`;
    return;
  }

  if (storyQueueState.status === "error") {
    storyQueueContent.innerHTML = `
      <div class="story-queue-empty" role="alert">
        <p>${escapeHtml(storyQueueState.message || "Could not look for stories.")}</p>
      </div>
    `;
    return;
  }

  const lastChecked = getStoryQueueLastChecked();
  const lastCheckedMarkup = lastChecked ? `<p class="story-queue-last">${escapeHtml(lastChecked)}</p>` : "";
  const podcastSummaryMarkup = renderStoryQueuePodcastSummary();
  const queueMessageMarkup = storyQueueState.message
    ? `<p class="story-queue-note">${escapeHtml(storyQueueState.message)}</p>`
    : "";

  if (!storyQueueState.stories.length) {
    storyQueueContent.innerHTML = `
      ${podcastSummaryMarkup}
      ${lastCheckedMarkup}
      ${queueMessageMarkup}
      <div class="story-queue-empty">
        <p>No stories found yet.</p>
      </div>
    `;
    return;
  }

  const pendingCount = Object.keys(storyQueueState.pendingUpdates || {}).length;
  const pendingMarkup = pendingCount
    ? `<p class="story-queue-unsaved">${pendingCount} Story Queue change${pendingCount === 1 ? "" : "s"} ready to save.</p>`
    : "";
  const preview = getPlaylistPreview(getEditorStoryRules(), storyQueueState.stories);
  const previewSets = getPreviewStorySets(preview, storyQueueState.stories);
  const sortedStories = sortPreviewStories(storyQueueState.stories);
  const filteredStories = getFilteredStories(sortedStories, previewSets);

  storyQueueContent.innerHTML = `
    ${podcastSummaryMarkup}
    ${lastCheckedMarkup}
    ${queueMessageMarkup}
    ${pendingMarkup}
    ${renderStoryStatusSummary(preview)}
    <p class="story-queue-note">Local audio is cleaned up after stories are ready on Yoto.</p>
    ${renderStoryFilterTags(preview, storyQueueState.stories.length)}
    ${
      filteredStories.length
        ? `<div class="story-list">${filteredStories
            .map((story) => {
              const group = getStoryGroupFromPreview(story, previewSets);
              const previewStory = getPreviewStory(story, preview);
              return renderQueuedStory({ ...story, ...previewStory }, group);
            })
            .join("")}</div>`
        : `<div class="story-queue-empty"><p>No stories match this tag yet.</p></div>`
    }
  `;
};

const canStoryBeAddedBack = (story) =>
  canStoryOccupyPlaylistSlot(story) &&
    (!story.capacityReason || ["story_count", "manual_story_count"].includes(story.capacityReason));

const getStoryControlsForGroup = (story, group) => {
  const controls = [];
  const isManualMode = getEditorStoryRules().newStoryBehavior === "choose_first";
  const isResting = isStoryRestingForDisplay(story, group);
  const isSkipped = group === "skipped" || story.status === "skipped";
  const confirmAddBack = storyQueueState.addBackConfirmId === story.id;

  if (confirmAddBack) {
    return [
      { action: "confirm_add_back", label: "Confirm Add Back", active: false, style: "outline" },
      { action: "cancel_add_back", label: "Cancel", active: false },
    ];
  }

  if ((isResting || isSkipped) && canStoryBeAddedBack(story)) {
    controls.push({ action: "add_back", label: "Add Back", active: false, style: "outline" });
  }

  if (group === "on_yoto" && !isResting && !isSkipped && !isStoryMissingRssAudio(story)) {
    controls.push(
      story.isPinned
        ? { action: "pin", label: "Remove Favorite", active: true }
        : { action: "pin", label: "Keep Favorite", active: false }
    );
  }

  if (!isManualMode) return controls;

  if (group === "new" && !isStoryMissingRssAudio(story)) {
    controls.unshift(
      { action: "select", label: "Pick for Yoto", active: story.isSelected, style: "outline" },
      { action: "skip", label: "Skip for now", active: story.isSkipped }
    );
  }

  if (group === "on_yoto") {
    controls.unshift({ action: "remove", label: "Remove from Playlist", active: false });
  }

  return controls;
};

const getStoryAddBackReplacementCandidate = (story) => {
  const rules = getEditorStoryRules();
  const limits = getPlaylistCapacityLimits(rules);

  const preview = getPlaylistPreview(rules, storyQueueState.stories);
  const limit = Number(limits.maxTracks || YOTO_MYO_MAX_TRACKS);
  if (!Number.isFinite(limit) || preview.onYotoSoon.length < limit) return null;

  const candidates = preview.onYotoSoon
    .filter((item) => item.id !== story.id)
    .filter((item) => !(item.isPinned && rules.favoritesNeverRotate))
    .sort((first, second) => getStorySortValue(first) - getStorySortValue(second));

  if (candidates.length) return candidates[0];
  return { blocked: true };
};

const getStoryCapacityNote = (story) => {
  switch (story?.capacityReason) {
    case "unknown_file_size":
      return "This story is resting until Feed Your Yoto can see its audio size.";
    case "unknown_duration":
      return "This story is resting until Feed Your Yoto can see its play time.";
    case "track_file_size":
      return "This story is resting because its audio file is too large for one Yoto track.";
    case "track_duration":
      return "This story is resting because it is too long for one Yoto track.";
    case "card_file_size":
      return "This story is resting because the Story Playlist is almost full.";
    case "card_duration":
      return "This story is resting because the Story Playlist is almost out of listening time.";
    case "track_limit":
      return "This story is resting because this Story Playlist already has the most tracks Yoto allows.";
    case "manual_story_count":
      return "This story is resting because your manual story limit has been reached.";
    case "manual_storage":
      return "This story is resting because your manual storage limit has been reached.";
    case "manual_play_time":
      return "This story is resting because your manual play time limit has been reached.";
    default:
      return "";
  }
};

const getStoryContextMarkup = (story, group) => {
  if (storyQueueState.addBackConfirmId === story.id) {
    const replacement = getStoryAddBackReplacementCandidate(story);
    const replacementText = replacement?.blocked
      ? "All current playlist stories are favorited, so Feed Your Yoto will not replace them."
      : replacement?.title
        ? `To make room, Feed Your Yoto will move '${replacement.title}' to resting.`
        : "";

    return `
      <div class="story-confirmation">
        <h5>Add this story back to the playlist?</h5>
        <p>This may move one of the oldest non-favorite stories to resting so there is room.</p>
        ${replacementText ? `<p>${escapeHtml(replacementText)}</p>` : ""}
      </div>
    `;
  }

  if (isStoryMissingRssAudio(story)) return `<p class="story-note">${escapeHtml(MISSING_AUDIO_PARENT_MESSAGE)}</p>`;
  if (isStoryRestingForDisplay(story, group)) {
    return `<p class="story-note">${escapeHtml(getStoryCapacityNote(story) || "This story was moved off the playlist to make room for newer stories.")}</p>`;
  }
  if (story.status === "skipped") return `<p class="story-note">This story is skipped for now.</p>`;
  if (group === "on_yoto" && story.status === "selected") {
    return `<p class="story-note">Feed Your Yoto will get this story ready for Yoto next.</p>`;
  }
  return "";
};

const renderStoryDownloadAction = (story, group) => {
  const isManualMode = getEditorStoryRules().newStoryBehavior === "choose_first";
  const isDownloading = storyDownloadState.storyIds.has(story.id) || story.status === "downloading";
  const isUploading = storyDownloadState.uploadIds.has(story.id) || story.status === "uploading";
  const canPrepare = group === "on_yoto";

  if (isStoryMissingRssAudio(story)) {
    return `<button class="quiet-action" type="button" data-story-details>${story.showDetails ? "Hide details" : "See more"}</button>`;
  }

  if (storyNeedsHelp(story)) {
    const retryPlaylist = shouldRetryStoryPlaylistUpdate(story);
    const retryUploads = shouldRetryStoryUpload(story);
    const busy = retryPlaylist ? storyDownloadState.syncing : retryUploads ? isUploading : isDownloading;
    const busyLabel = retryPlaylist ? "Checking Yoto..." : retryUploads ? "Sending story..." : "Getting story ready...";
    const retryButton = `<button class="outline-action" type="button" data-retry-story ${busy ? "disabled" : ""}>${busy ? busyLabel : "Try Again"}</button>`;
    const detailsButton = `<button class="quiet-action" type="button" data-story-details>${story.showDetails ? "Hide details" : "See more"}</button>`;
    return `${retryButton}${detailsButton}`;
  }

  if (isStoryWaitingForYoto(story)) {
    const retryButton = `<button class="outline-action" type="button" data-retry-story ${storyDownloadState.syncing ? "disabled" : ""}>${storyDownloadState.syncing ? "Checking Yoto..." : "Try Again"}</button>`;
    const detailsButton = `<button class="quiet-action" type="button" data-story-details>${story.showDetails ? "Hide details" : "See more"}</button>`;
    return `${retryButton}${detailsButton}`;
  }

  if (isStoryReadyToUpload(story)) {
    return `<button class="outline-action" type="button" data-upload-story ${isUploading ? "disabled" : ""}>${isUploading ? "Sending story..." : "Send to Yoto"}</button>`;
  }

  if (!canPrepare) return "";

  if (!isStoryAudioUsable(story)) {
    return `<p class="story-audio-note">${escapeHtml(MISSING_AUDIO_PARENT_MESSAGE)}</p>`;
  }

  if (!isStoryReadyToBringHome(story)) return "";

  if (!isManualMode) {
    const busy = storyDownloadState.processing || storyDownloadState.bulk || isDownloading;
    return `<button class="outline-action" type="button" data-download-story ${busy ? "disabled" : ""}>${busy ? "Getting story ready..." : "Get ready now"}</button>`;
  }

  return `<button class="outline-action" type="button" data-download-story ${isDownloading ? "disabled" : ""}>${isDownloading ? "Getting story ready..." : "Prepare Story"}</button>`;
};

const formatFileSize = (value) => {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const renderStoryDetailValue = (label, value) =>
  value ? `<p><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></p>` : "";

const getLatestStoryActivity = (story) =>
  Array.isArray(story.activityLog) && story.activityLog.length ? story.activityLog[0] : null;

const renderStoryActivityDetails = (story) => {
  if (!story.showDetails) return "";
  const latestActivity = getLatestStoryActivity(story);
  const details = latestActivity?.details || {};
  const whatHappened =
    latestActivity?.message ||
    getStoryDownloadError(story) ||
    story.uploadError ||
    story.playlistUpdateError ||
    (isStoryWaitingForYoto(story) ? YOTO_PROCESSING_MESSAGE : "Feed Your Yoto tried to help this story, but it needs a grown-up check.");
  const lastTried = latestActivity?.createdAt || story.lastPreparedAt || story.uploadedAt || story.updatedAt || "";
  const fileSize = formatFileSize(details.fileSize || story.fileSize || story.yotoFileSize);
  const retryAfter = details.yotoTranscodeRetryAfter || story.yotoTranscodeRetryAfter || details.playlistUpdateRetryAfter || story.playlistUpdateRetryAfter || "";
  const transcodeLastChecked = details.yotoTranscodeLastCheckedAt || story.yotoTranscodeLastCheckedAt || "";
  const transcodePollCount = details.yotoTranscodePollCount ?? story.yotoTranscodePollCount ?? "";
  const activeStoryCard = storyCards.find((storyCard) => storyCard.id === (story.storyCardId || activeCardId));
  const storyPlaylistName = details.yotoPlaylistTitle || getStoryCardPlaylistTitle(activeStoryCard);
  const missingMetadataFields = Array.isArray(details.missingMetadataFields)
    ? details.missingMetadataFields.join(", ")
    : details.missingMetadataFields || "";

  return `
    <div class="story-details-panel">
      <h5>What happened?</h5>
      <p>${escapeHtml(whatHappened)}</p>
      <div class="story-detail-grid">
        ${renderStoryDetailValue("Last tried", lastTried ? formatDateTime(lastTried) : "")}
        ${renderStoryDetailValue("Step", details.step || story.lastPrepareErrorStep || (isStoryWaitingForYoto(story) ? "Waiting on Yoto" : shouldRetryStoryPlaylistUpdate(story) ? "Adding to Story Playlist" : story.uploadError ? "Sending story to Yoto" : "Getting story ready"))}
        ${renderStoryDetailValue("Story Playlist", storyPlaylistName)}
        ${renderStoryDetailValue("Audio host", details.audioUrlHost || story.audioUrlHost)}
        ${renderStoryDetailValue("Redirects", String(details.redirectCount ?? story.redirectCount ?? ""))}
        ${renderStoryDetailValue("Final host", details.resolvedAudioUrlHost || story.resolvedAudioUrlHost)}
        ${renderStoryDetailValue("HTTP status", details.httpStatus || story.lastPrepareHttpStatus ? String(details.httpStatus || story.lastPrepareHttpStatus) : "")}
        ${renderStoryDetailValue("Content type", details.contentType || story.lastPrepareContentType)}
        ${renderStoryDetailValue("Yoto upload", details.yotoUploadStatus || story.yotoUploadStatus)}
        ${renderStoryDetailValue("Yoto transcode", details.yotoTranscodeStatus || story.yotoTranscodeStatus)}
        ${renderStoryDetailValue("Last checked", transcodeLastChecked ? formatDateTime(transcodeLastChecked) : "")}
        ${renderStoryDetailValue("Retry after", retryAfter ? formatDateTime(retryAfter) : "")}
        ${renderStoryDetailValue("Poll count", transcodePollCount !== "" ? String(transcodePollCount) : "")}
        ${renderStoryDetailValue("Playlist update", details.playlistUpdateStatus || story.playlistUpdateStatus)}
        ${renderStoryDetailValue("Intended tracks", details.intendedTrackCount ? String(details.intendedTrackCount) : "")}
        ${renderStoryDetailValue("Tracks built", details.builtTrackCount ? String(details.builtTrackCount) : "")}
        ${renderStoryDetailValue("Tracks sent", details.sentTrackCount ? String(details.sentTrackCount) : "")}
        ${renderStoryDetailValue("Tracks found", details.verifiedTrackCount ? String(details.verifiedTrackCount) : "")}
        ${renderStoryDetailValue("Missing metadata", missingMetadataFields)}
        ${renderStoryDetailValue("Technical note", details.technicalMessage)}
        ${renderStoryDetailValue("File size", fileSize)}
      </div>
    </div>
  `;
};

const renderQueuedStory = (story, group = "new") => {
  const publishedAt = story.publishedAt ? formatDateTime(story.publishedAt) : "No date yet";
  const storyDescription = truncateText(story.description, 300);
  const controls = getStoryControlsForGroup(story, group);
  const downloadAction = renderStoryDownloadAction(story, group);
  const displayStatus = getStoryDisplayStatus(story, group);
  const statusClass = getStoryStatusClass(story, group);
  const contextMarkup = getStoryContextMarkup(story, group);
  const controlMarkup = controls
    .map(
      (control) => {
        const buttonClass = control.style === "outline" || control.action === "select" ? "outline-action" : "quiet-action";
        return `<button class="${buttonClass} ${control.active ? "is-active" : ""}" type="button" data-story-action="${escapeAttribute(control.action)}">${escapeHtml(control.label)}</button>`;
      }
    )
    .join("");

  return `
    <article class="story-item" data-story-id="${escapeAttribute(story.id)}">
      <div class="story-item-main">
        <div class="story-item-copy">
          <div class="story-item-title-row">
            <h4>${escapeHtml(story.title || "Untitled story")}</h4>
            ${story.isPinned ? `<span class="favorite-badge">Favorite</span>` : ""}
          </div>
          <div class="story-item-meta">
            <span>${escapeHtml(publishedAt)}</span>
            <span class="story-status ${escapeAttribute(statusClass)}">${escapeHtml(displayStatus)}</span>
          </div>
          ${storyDescription ? `<p class="story-description">${escapeHtml(storyDescription)}</p>` : ""}
          ${contextMarkup}
          ${storyNeedsHelp(story) && getStoryDownloadError(story) ? `<p class="story-error">${escapeHtml(getStoryDownloadError(story))}</p>` : ""}
          ${story.uploadError ? `<p class="story-error">${escapeHtml(story.uploadError)}</p>` : ""}
          ${isStoryWaitingForYoto(story) ? `<p class="story-waiting-note">${escapeHtml(story.playlistUpdateError || YOTO_PROCESSING_MESSAGE)}</p>` : ""}
          ${renderStoryActivityDetails(story)}
        </div>
        ${renderStoryTracker(story, group)}
      </div>
      ${controlMarkup || downloadAction ? `<div class="story-controls">${controlMarkup}${downloadAction}</div>` : ""}
    </article>
  `;
};

const getStoryQueueStatusSignature = (stories = []) =>
  stories
    .map((story) =>
      [
        story.id,
        story.status,
        story.downloadStatus,
        story.yotoUploadStatus,
        story.yotoTranscodeStatus,
        story.playlistUpdateStatus,
        story.yotoTranscodeRetryAfter,
        story.playlistUpdateRetryAfter,
        story.cleanedLocalAudioAt,
        story.updatedAt,
      ]
        .map((value) => String(value || ""))
        .join(":")
    )
    .join("|");

const isStoryWaitingForLiveUpdate = (story) =>
  Boolean(
    isStoryWaitingForYoto(story) ||
      ["downloaded", "processing", "uploaded"].includes(story?.status) ||
      story?.status === "waiting_on_yoto" ||
      story?.yotoUploadStatus === "processing" ||
      story?.yotoTranscodeStatus === "processing" ||
      story?.playlistUpdateStatus === "waiting"
  );

const isStoryFastLiveUpdateStatus = (story) =>
  Boolean(
    ["downloading", "uploading", "adding_to_playlist", "cleaning_local"].includes(story?.status) ||
      storyDownloadState.storyIds.has(story.id) ||
      storyDownloadState.uploadIds.has(story.id)
  );

const getStoryQueuePollingMode = () => {
  if (!activeCardId || backdrop.hidden || storyQueueState.status !== "loaded") return "";
  if (
    storyDownloadState.bulk ||
    storyDownloadState.processing ||
    storyDownloadState.syncing ||
    storyDownloadState.storyIds.size ||
    storyDownloadState.uploadIds.size
  ) {
    return "fast";
  }

  if ((storyQueueState.stories || []).some(isStoryFastLiveUpdateStatus)) return "fast";
  if ((storyQueueState.stories || []).some(isStoryWaitingForLiveUpdate)) return "waiting";
  return "";
};

const stopStoryQueuePolling = () => {
  if (storyQueuePollTimer) {
    window.clearTimeout(storyQueuePollTimer);
    storyQueuePollTimer = null;
  }
};

const mergeStoryQueueUiState = (incomingStories, { applyPendingUpdates = true } = {}) => {
  const localById = new Map((storyQueueState.stories || []).map((story) => [story.id, story]));
  const pendingUpdates = storyQueueState.pendingUpdates || {};

  return incomingStories.map((story) => {
    const localStory = localById.get(story.id);
    const pendingPatch = applyPendingUpdates ? pendingUpdates[story.id] : null;
    const mergedStory = pendingPatch ? applyStoryQueuePatch(story, pendingPatch) : story;

    return {
      ...mergedStory,
      showDetails: Boolean(localStory?.showDetails),
      activityLog: localStory?.activityLog,
    };
  });
};

const mergePolledStoryQueue = (incomingStories) => mergeStoryQueueUiState(incomingStories);

const pollStoryQueueOnce = async () => {
  if (!activeCardId || storyQueuePollInFlight) return;

  storyQueuePollInFlight = true;
  try {
    const stories = await apiRequest(`/api/story-cards/${encodeURIComponent(activeCardId)}/stories`);
    const nextStories = mergePolledStoryQueue(Array.isArray(stories) ? stories : []);
    const nextSignature = getStoryQueueStatusSignature(nextStories);
    const isUnchanged = nextSignature === storyQueuePollSignature;
    storyQueuePollUnchangedCount = isUnchanged ? storyQueuePollUnchangedCount + 1 : 0;
    storyQueuePollSignature = nextSignature;

    if (!isUnchanged) {
      setStoryQueueState({
        status: "loaded",
        stories: nextStories,
        pendingUpdates: storyQueueState.pendingUpdates || {},
        addBackConfirmId: storyQueueState.addBackConfirmId || "",
      });
    }
  } catch (error) {
    console.warn("Could not refresh Story Queue status.", error);
    stopStoryQueuePolling();
  } finally {
    storyQueuePollInFlight = false;
    updateStoryQueuePolling();
  }
};

const updateStoryQueuePolling = () => {
  stopStoryQueuePolling();

  const mode = getStoryQueuePollingMode();
  if (!mode) {
    storyQueuePollUnchangedCount = 0;
    storyQueuePollSignature = getStoryQueueStatusSignature(storyQueueState.stories || []);
    return;
  }

  const baseDelay = mode === "fast" ? STORY_QUEUE_FAST_POLL_MS : STORY_QUEUE_WAITING_POLL_MS;
  const delay =
    storyQueuePollUnchangedCount >= STORY_QUEUE_SLOW_AFTER_UNCHANGED_POLLS
      ? STORY_QUEUE_SLOW_POLL_MS
      : baseDelay;
  storyQueuePollTimer = window.setTimeout(pollStoryQueueOnce, delay);
};

const setStoryQueueState = (nextState) => {
  storyQueueState = { ...storyQueueState, ...nextState };
  renderStoryQueue();
  updateStoryQueuePolling();
};

const loadStoryQueue = async (storyCardId, { discoverIfEmpty = false } = {}) => {
  const isSameStoryCard = storyQueueState.storyCardId === storyCardId;
  setStoryQueueState({
    storyCardId,
    status: "loading",
    message: "",
    stories: isSameStoryCard ? storyQueueState.stories : [],
    pendingUpdates: {},
    filter: isSameStoryCard ? storyQueueState.filter : "all",
    addBackConfirmId: "",
  });

  try {
    const stories = await apiRequest(`/api/story-cards/${encodeURIComponent(storyCardId)}/stories`);
    const queueStories = mergeStoryQueueUiState(Array.isArray(stories) ? stories : []);

    if (discoverIfEmpty && queueStories.length === 0) {
      await discoverStories(storyCardId);
      return;
    }

    setStoryQueueState({ status: "loaded", stories: queueStories, message: "", pendingUpdates: {} });
    maybeProcessStoriesForStoryCard(storyCardId);
    scheduleWaitingPlaylistRetry(storyCardId, queueStories);
  } catch (error) {
    setStoryQueueState({
      status: "error",
      message: error.message || "Could not load the Story Queue.",
      stories: [],
      pendingUpdates: {},
    });
  }
};

const discoverStories = async (storyCardId = activeCardId) => {
  if (!storyCardId) return;

  setStoryQueueState({ storyCardId, status: "loading", message: "", pendingUpdates: {}, addBackConfirmId: "" });

  try {
    const stories = await apiRequest(
      `/api/story-cards/${encodeURIComponent(storyCardId)}/stories/discover`,
      { method: "POST" }
    );
    await refreshStoryCardCache();
    renderCards();
    const nextStories = mergeStoryQueueUiState(Array.isArray(stories) ? stories : []);
    setStoryQueueState({
      status: "loaded",
      stories: nextStories,
      message: "",
      pendingUpdates: {},
    });
    maybeProcessStoriesForStoryCard(storyCardId);
    scheduleWaitingPlaylistRetry(storyCardId, nextStories);
  } catch (error) {
    setStoryQueueState({
      status: "error",
      message: error.message || "Could not look for stories.",
    });
  }
};

const getStoryActionPayload = (story, action) => {
  if (action === "select") {
    return { action: "select", isSelected: true, isSkipped: false, status: "selected" };
  }

  if (action === "skip") {
    return { action: "skip", isSkipped: true, isSelected: false, status: "skipped" };
  }

  if (action === "remove") {
    return { action: "remove", isSelected: false, status: story.isPinned ? "discovered" : "rotated_off" };
  }

  if (action === "pin") {
    return { action: story.isPinned ? "unfavorite" : "favorite", isPinned: !story.isPinned };
  }

  return {};
};

const applyStoryQueuePatch = (story, patch) => {
  const nextStory = { ...story, ...patch };
  if (patch.status) {
    nextStory.statusLabel = storyStatusLabels[patch.status] || story.statusLabel;
  }
  return nextStory;
};

const addBackQueuedStory = async (storyId) => {
  if (!activeCardId || !storyId) return;

  setStoryQueueState({ status: "loaded", message: "Adding story back..." });

  try {
    const result = await jsonRequest(
      `/api/story-cards/${encodeURIComponent(activeCardId)}/stories/${encodeURIComponent(storyId)}`,
      "PUT",
      { action: "add_back", includeStories: true }
    );

    const updatedStory = result?.story || result;
    const nextStories = Array.isArray(result?.stories)
      ? mergePolledStoryQueue(result.stories)
      : storyQueueState.stories.map((story) => (story.id === storyId && updatedStory ? updatedStory : story));

    preserveStoryQueueScrollPosition(storyId, () => {
      setStoryQueueState({
        status: "loaded",
        message: "",
        stories: nextStories,
        pendingUpdates: {},
        addBackConfirmId: "",
      });
    });
    maybeProcessStoriesForStoryCard(activeCardId);
  } catch (error) {
    setStoryQueueState({
      status: "loaded",
      message: error.message || "Feed Your Yoto could not add this story back.",
    });
  }
};

const updateQueuedStoryControl = (storyId, action) => {
  if (!activeCardId || !storyId) return;

  const story = storyQueueState.stories.find((item) => item.id === storyId);
  if (!story) return;

  if (action === "add_back") {
    setStoryQueueState({ status: "loaded", message: "", addBackConfirmId: storyId });
    return;
  }

  if (action === "cancel_add_back") {
    setStoryQueueState({ status: "loaded", message: "", addBackConfirmId: "" });
    return;
  }

  if (action === "confirm_add_back") {
    setStoryQueueState({ addBackConfirmId: "" });
    addBackQueuedStory(storyId);
    return;
  }

  const payload = getStoryActionPayload(story, action);
  const nextPendingUpdates = {
    ...(storyQueueState.pendingUpdates || {}),
    [storyId]: {
      ...(storyQueueState.pendingUpdates?.[storyId] || {}),
      ...payload,
    },
  };

  setStoryQueueState({
    status: "loaded",
    message: "",
    stories: storyQueueState.stories.map((item) =>
      item.id === storyId ? applyStoryQueuePatch(item, payload) : item
    ),
    pendingUpdates: nextPendingUpdates,
  });
};

const savePendingStoryQueueChanges = async (storyCardId) => {
  const pendingEntries = Object.entries(storyQueueState.pendingUpdates || {});
  if (!pendingEntries.length) return;

  const updatedStories = await Promise.all(
    pendingEntries.map(([storyId, payload]) =>
      jsonRequest(
        `/api/story-cards/${encodeURIComponent(storyCardId)}/stories/${encodeURIComponent(storyId)}`,
        "PUT",
        payload
      )
    )
  );

    const updatedById = new Map(mergeStoryQueueUiState(updatedStories, { applyPendingUpdates: false }).map((story) => [story.id, story]));
    setStoryQueueState({
      status: "loaded",
      message: "",
      stories: storyQueueState.stories.map((story) => updatedById.get(story.id) || story),
    pendingUpdates: {},
  });
};

const mergeStoryQueueUpdates = (updatedStories) => {
  const updates = Array.isArray(updatedStories) ? updatedStories : [updatedStories];
  const updatedById = new Map(
    mergeStoryQueueUiState(updates.filter(Boolean), { applyPendingUpdates: false }).map((story) => [story.id, story])
  );

  setStoryQueueState({
    status: "loaded",
    message: "",
    stories: storyQueueState.stories.map((story) => updatedById.get(story.id) || story),
  });
};

const getStoryQueueScrollContainer = () => document.querySelector(".dialog-form") || storyQueueContent;

const getStoryElement = (storyId) =>
  Array.from(storyQueueContent?.querySelectorAll("[data-story-id]") || []).find(
    (element) => element.dataset.storyId === storyId
  );

const preserveStoryQueueScrollPosition = (storyId, updateCallback) => {
  const scrollContainer = getStoryQueueScrollContainer();
  const anchoredStory = getStoryElement(storyId);
  const previousTop = anchoredStory?.getBoundingClientRect().top ?? null;
  const previousScrollTop = scrollContainer?.scrollTop ?? 0;

  updateCallback();

  window.requestAnimationFrame(() => {
    if (!scrollContainer) return;

    const nextAnchoredStory = getStoryElement(storyId);
    if (nextAnchoredStory && previousTop !== null) {
      scrollContainer.scrollTop += nextAnchoredStory.getBoundingClientRect().top - previousTop;
      return;
    }

    scrollContainer.scrollTop = previousScrollTop;
  });
};

const toggleStoryDetails = async (storyId) => {
  if (!activeCardId || !storyId) return;

  const story = storyQueueState.stories.find((item) => item.id === storyId);
  if (!story) return;

  if (story.showDetails) {
    setStoryQueueState({
      stories: storyQueueState.stories.map((item) =>
        item.id === storyId ? { ...item, showDetails: false } : item
      ),
    });
    return;
  }

  try {
    const activityLog = await apiRequest(
      `/api/story-cards/${encodeURIComponent(activeCardId)}/stories/${encodeURIComponent(storyId)}/activity`
    );
    setStoryQueueState({
      stories: storyQueueState.stories.map((item) =>
        item.id === storyId ? { ...item, showDetails: true, activityLog } : item
      ),
    });
  } catch (error) {
    setStoryQueueState({
      stories: storyQueueState.stories.map((item) =>
        item.id === storyId
          ? {
              ...item,
              showDetails: true,
              activityLog: [
                {
                  createdAt: item.uploadedAt || item.lastPreparedAt || item.updatedAt || "",
                  message: getStoryDownloadError(item) || item.uploadError || "Feed Your Yoto could not load more details.",
                  details: {
                    step: isStoryWaitingForYoto(item)
                      ? "Waiting on Yoto"
                      : shouldRetryStoryPlaylistUpdate(item)
                        ? "Adding to Story Playlist"
                        : item.yotoUploadStatus === "failed"
                          ? "Sending story to Yoto"
                          : item.lastPrepareErrorStep || "Getting story ready",
                    yotoPlaylistTitle: getStoryCardPlaylistTitle(storyCards.find((storyCard) => storyCard.id === (item.storyCardId || activeCardId))),
                    audioUrlHost: item.audioUrlHost || "",
                    redirectCount: item.redirectCount || 0,
                    resolvedAudioUrlHost: item.resolvedAudioUrlHost || "",
                    httpStatus: item.lastPrepareHttpStatus || 0,
                    contentType: item.lastPrepareContentType || "",
                    contentLength: item.lastPrepareContentLength || 0,
                    fileSize: item.fileSize || item.yotoFileSize || 0,
                    yotoUploadStatus: item.yotoUploadStatus || "",
                    yotoTranscodeStatus: item.yotoTranscodeStatus || "",
                    yotoTranscodeLastCheckedAt: item.yotoTranscodeLastCheckedAt || "",
                    yotoTranscodeRetryAfter: item.yotoTranscodeRetryAfter || "",
                    yotoTranscodePollCount: item.yotoTranscodePollCount || 0,
                    playlistUpdateStatus: item.playlistUpdateStatus || "",
                    playlistUpdateRetryAfter: item.playlistUpdateRetryAfter || "",
                    intendedTrackCount: 0,
                    builtTrackCount: 0,
                    sentTrackCount: 0,
                    verifiedTrackCount: 0,
                    missingMetadataFields: [],
                    technicalMessage: isStoryMissingRssAudio(item) ? MISSING_AUDIO_TECHNICAL_MESSAGE : item.playlistUpdateError || item.uploadError || item.downloadError || "",
                  },
                },
              ],
            }
          : item
      ),
    });
  }
};

const downloadQueuedStory = async (storyId) => {
  if (!activeCardId || !storyId) return;

  const nextStoryIds = new Set(storyDownloadState.storyIds);
  nextStoryIds.add(storyId);
  setStoryDownloadState({ storyIds: nextStoryIds });

  try {
    await savePendingStoryQueueChanges(activeCardId);
    const updatedStory = await jsonRequest(
      `/api/story-cards/${encodeURIComponent(activeCardId)}/stories/${encodeURIComponent(storyId)}/download`,
      "POST"
    );
    mergeStoryQueueUpdates(updatedStory);
  } catch (error) {
    setStoryQueueState({
      status: "loaded",
      message: error.message || "Feed Your Yoto could not get this story ready.",
    });
  } finally {
    const remainingStoryIds = new Set(storyDownloadState.storyIds);
    remainingStoryIds.delete(storyId);
    setStoryDownloadState({ storyIds: remainingStoryIds });
  }
};

const uploadQueuedStory = async (storyId) => {
  if (!activeCardId || !storyId) return;

  const nextUploadIds = new Set(storyDownloadState.uploadIds);
  nextUploadIds.add(storyId);
  setStoryDownloadState({ uploadIds: nextUploadIds });

  try {
    await savePendingStoryQueueChanges(activeCardId);
    const updatedStory = await jsonRequest(
      `/api/story-cards/${encodeURIComponent(activeCardId)}/stories/${encodeURIComponent(storyId)}/upload`,
      "POST"
    );
    mergeStoryQueueUpdates(updatedStory);
  } catch (error) {
    setStoryQueueState({
      status: "loaded",
      message: error.message || "Feed Your Yoto could not send this story to Yoto.",
    });
  } finally {
    const remainingUploadIds = new Set(storyDownloadState.uploadIds);
    remainingUploadIds.delete(storyId);
    setStoryDownloadState({ uploadIds: remainingUploadIds });
  }
};

const syncStoryPlaylist = async () => {
  if (!activeCardId) return;

  setStoryDownloadState({ syncing: true });

  try {
    await savePendingStoryQueueChanges(activeCardId);
    const result = await jsonRequest(
      `/api/story-cards/${encodeURIComponent(activeCardId)}/sync-playlist`,
      "POST"
    );
    const nextStories = Array.isArray(result.stories)
      ? mergeStoryQueueUiState(result.stories, { applyPendingUpdates: false })
      : storyQueueState.stories;
    setStoryQueueState({
      status: "loaded",
      message: result.failed?.length
        ? "Some stories need help before the Story Playlist is ready."
        : result.waiting?.length
          ? YOTO_PROCESSING_MESSAGE
          : "",
      stories: nextStories,
      pendingUpdates: {},
    });
    scheduleWaitingPlaylistRetry(activeCardId, nextStories);
  } catch (error) {
    setStoryQueueState({
      status: "loaded",
      message: error.message || "Feed Your Yoto could not update the Story Playlist.",
    });
  } finally {
    setStoryDownloadState({ syncing: false });
  }
};

const retryQueuedStory = (storyId) => {
  const story = storyQueueState.stories.find((item) => item.id === storyId);
  if (!story) return;

  if (shouldRetryStoryPlaylistUpdate(story)) {
    syncStoryPlaylist();
    return;
  }

  if (shouldRetryStoryUpload(story)) {
    uploadQueuedStory(storyId);
    return;
  }

  downloadQueuedStory(storyId);
};

const processStoriesForStoryCard = async (storyCardId) => {
  if (!storyCardId || getEditorStoryRules().newStoryBehavior === "choose_first") return;
  if (storyDownloadState.processing) return;

  const preview = getPlaylistPreview(getEditorStoryRules(), storyQueueState.stories);
  const storiesToPrepare = getStoriesNeedingPreparation(preview);
  const storiesToUpload = getStoriesReadyToUpload(preview.onYotoSoon);
  const storiesToSync = getStoriesReadyToSync(preview.onYotoSoon);
  const storiesToCheckOnYoto = getStoriesWaitingForYoto(storyQueueState.stories).filter(isPlaylistRetryReady);
  if (!storiesToPrepare.length && !storiesToUpload.length && !storiesToSync.length && !storiesToCheckOnYoto.length) {
    scheduleWaitingPlaylistRetry(storyCardId, storyQueueState.stories);
    return;
  }

  setStoryDownloadState({ processing: true });

  try {
    let workingStories = storyQueueState.stories;
    let helpMessage = "";

    if (storiesToPrepare.length) {
      const downloadResult = await jsonRequest(
        `/api/story-cards/${encodeURIComponent(storyCardId)}/stories/download-selected`,
        "POST"
      );
      workingStories = Array.isArray(downloadResult.stories)
        ? mergeStoryQueueUiState(downloadResult.stories, { applyPendingUpdates: false })
        : workingStories;
      if (downloadResult.failed?.length) {
        helpMessage = "Some stories need help before they can get ready.";
      } else if (downloadResult.capacityReached) {
        helpMessage = downloadResult.message || "Feed Your Yoto is keeping local storage safe. It will upload and clean up stories before downloading more.";
      }
    }

    const readyAfterDownloadPreview = getPlaylistPreview(getEditorStoryRules(), workingStories);
    const readyAfterDownload = getStoriesReadyToUpload(readyAfterDownloadPreview.onYotoSoon);
    if (readyAfterDownload.length) {
      const uploadResult = await jsonRequest(
        `/api/story-cards/${encodeURIComponent(storyCardId)}/stories/upload-ready`,
        "POST"
      );
      workingStories = Array.isArray(uploadResult.stories)
        ? mergeStoryQueueUiState(uploadResult.stories, { applyPendingUpdates: false })
        : workingStories;
      if (uploadResult.failed?.length) {
        helpMessage = "Some stories need help before they can be sent to Yoto.";
      } else if (uploadResult.waiting?.length) {
        helpMessage = YOTO_PROCESSING_MESSAGE;
      }
    }

    const readyForPlaylistPreview = getPlaylistPreview(getEditorStoryRules(), workingStories);
    const readyForPlaylist = getStoriesReadyToSync(readyForPlaylistPreview.onYotoSoon);
    const waitingReadyForCheck = getStoriesWaitingForYoto(workingStories).filter(isPlaylistRetryReady);
    if (readyForPlaylist.length || waitingReadyForCheck.length) {
      setStoryDownloadState({ syncing: true });
      const syncResult = await jsonRequest(
        `/api/story-cards/${encodeURIComponent(storyCardId)}/sync-playlist`,
        "POST"
      );
      workingStories = Array.isArray(syncResult.stories)
        ? mergeStoryQueueUiState(syncResult.stories, { applyPendingUpdates: false })
        : workingStories;
      if (syncResult.failed?.length) {
        helpMessage = "Some stories need help before the Story Playlist is ready.";
      } else if (syncResult.waiting?.length) {
        helpMessage = YOTO_PROCESSING_MESSAGE;
      }
    }

    setStoryQueueState({
      status: "loaded",
      message: helpMessage,
      stories: workingStories,
      pendingUpdates: {},
    });
    scheduleWaitingPlaylistRetry(storyCardId, workingStories);
    const nextPreview = getPlaylistPreview(getEditorStoryRules(), workingStories);
    const hasMoreImmediateWork =
      getStoriesNeedingPreparation(nextPreview).length ||
      getStoriesReadyToUpload(nextPreview.onYotoSoon).length ||
      getStoriesReadyToSync(nextPreview.onYotoSoon).length;
    if (hasMoreImmediateWork && !getStoriesWaitingForYoto(workingStories).length) {
      window.setTimeout(() => processStoriesForStoryCard(storyCardId), 800);
    }
  } catch (error) {
    setStoryQueueState({
      status: "loaded",
      message: error.message || "Feed Your Yoto could not send stories to Yoto.",
    });
  } finally {
    setStoryDownloadState({ processing: false, syncing: false });
  }
};

const getNextWaitingPlaylistDelayMs = (stories) => {
  const waitingDelays = getStoriesWaitingForYoto(stories)
    .map(getPlaylistRetryDelayMs)
    .filter((delay) => Number.isFinite(delay));
  if (!waitingDelays.length) return 0;
  return Math.min(...waitingDelays);
};

const scheduleWaitingPlaylistRetry = (storyCardId, stories) => {
  if (!storyCardId || getEditorStoryRules().newStoryBehavior === "choose_first") return;
  const delay = getNextWaitingPlaylistDelayMs(stories);
  if (!delay) return;

  if (storyProcessRetryTimers.has(storyCardId)) {
    window.clearTimeout(storyProcessRetryTimers.get(storyCardId));
  }

  const timer = window.setTimeout(() => {
    storyProcessRetryTimers.delete(storyCardId);
    processStoriesForStoryCard(storyCardId);
  }, delay);
  storyProcessRetryTimers.set(storyCardId, timer);
};

const maybeProcessStoriesForStoryCard = (storyCardId) => {
  window.setTimeout(() => processStoriesForStoryCard(storyCardId), 0);
};

const downloadSelectedStories = async () => {
  if (!activeCardId) return;

  const preview = getPlaylistPreview(getEditorStoryRules(), storyQueueState.stories);
  const storiesToPrepare = getStoriesNeedingPreparation(preview);

  if (!storiesToPrepare.length) {
    setStoryQueueState({
      status: "loaded",
      message: "Pick a story first, then Feed Your Yoto can prepare it.",
    });
    return;
  }

  setStoryDownloadState({ bulk: true });

  try {
    await savePendingStoryQueueChanges(activeCardId);
    const result = await jsonRequest(
      `/api/story-cards/${encodeURIComponent(activeCardId)}/stories/download-selected`,
      "POST"
    );
    setStoryQueueState({
      status: "loaded",
      message: result.failed?.length
        ? "Some stories need help before they can get ready."
        : result.capacityReached
          ? result.message || "Feed Your Yoto is keeping local storage safe. It will upload and clean up stories before downloading more."
          : "",
      stories: Array.isArray(result.stories)
        ? mergeStoryQueueUiState(result.stories, { applyPendingUpdates: false })
        : storyQueueState.stories,
      pendingUpdates: {},
    });
  } catch (error) {
    setStoryQueueState({
      status: "loaded",
      message: error.message || "Feed Your Yoto could not get these stories ready.",
    });
  } finally {
    setStoryDownloadState({ bulk: false });
  }
};

const isSetupChangeAcknowledged = () => Boolean(setupChangeAcknowledged?.checked);

const isPodcastChangeConfirmed = () =>
  String(podcastChangeCode?.value || "").trim().toUpperCase() === "CHANGE";

const canEditSetupDetails = () => setupDetailsUnlocked && isSetupChangeAcknowledged();

const refreshSetupDetailLocks = () => {
  const setupEditable = canEditSetupDetails();
  const podcastEditable = setupEditable && isPodcastChangeConfirmed();

  playlistName.disabled = !setupEditable;
  yotoCard.disabled = !setupEditable;
  rssFeed.disabled = !podcastEditable;
  if (podcastChangeCode) podcastChangeCode.disabled = !setupDetailsUnlocked;
};

const resetEditorSetupLock = () => {
  setupDetailsUnlocked = false;
  setupDetailsPanel.hidden = true;
  changeSetupDetails.hidden = false;
  if (setupChangeAcknowledged) setupChangeAcknowledged.checked = false;
  if (podcastChangeCode) podcastChangeCode.value = "";
  refreshSetupDetailLocks();
};

const showSetupDetailsPanel = () => {
  setupDetailsUnlocked = true;
  setupDetailsPanel.hidden = false;
  changeSetupDetails.hidden = true;
  refreshSetupDetailLocks();
  setupChangeAcknowledged.focus();
};

const hideDeleteConfirmation = () => {
  deleteConfirmPanel.hidden = true;
  deleteCard.hidden = false;
};

const showDeleteConfirmation = () => {
  if (!requireAuth("Connect Yoto to remove this setup.")) return;

  deleteConfirmPanel.hidden = false;
  deleteCard.hidden = true;
  cancelDeleteCard.focus();
};

const populateEditorPlaylistOptions = (storyCard) => {
  const currentId = storyCard.yotoPlaylistId || storyCard.yotoCardId || "";
  const currentTitle = getStoryCardPlaylistTitle(storyCard);
  const options = getRegularYotoPlaylists().map((card) => {
    const usedStoryCard = getUsedStoryCardForPlaylist(card.id);
    return {
      id: card.id,
      title: getYotoCardTitle(card),
      disabled: Boolean(usedStoryCard && usedStoryCard.id !== storyCard.id),
      usedBy: usedStoryCard?.name || "",
    };
  });

  if (currentId && !options.some((option) => option.id === currentId)) {
    options.unshift({
      id: currentId,
      title: currentTitle,
      disabled: false,
      usedBy: "",
    });
  }

  yotoCard.innerHTML = options.length
    ? options
        .map((option) => {
          const label = option.disabled
            ? `${option.title} - already used by ${option.usedBy}`
            : option.title;
          return `<option value="${escapeAttribute(option.id)}" ${option.disabled ? "disabled" : ""}>${escapeHtml(label)}</option>`;
        })
        .join("")
    : `<option value="${escapeAttribute(currentId)}">${escapeHtml(currentTitle)}</option>`;
  yotoCard.value = currentId || options.find((option) => !option.disabled)?.id || "";
};

const updateEditorPreview = (storyCard) => {
  const podcastDescription = truncateText(storyCard.podcastDescription, 230);
  const automaticChecksOn = isAutomaticChecksEnabled(storyCard) && storyCard.statusType !== "paused";
  const automaticResult = getAutomaticResultText(storyCard);

  dialogArt.className = "dialog-cover card-picture playlist-card-picture";
  dialogArt.innerHTML = getStoryCardArtMarkup(storyCard);
  dialogTitle.textContent = storyCard.name;
  dialogStatus.className = `status-pill status-${storyCard.statusType}`;
  dialogStatus.textContent = storyCard.status;
  dialogCrawl.textContent = `Next Check: ${getStoryCardNextCheckLabel(storyCard)}`;

  if (dialogPodcastDescription) {
    dialogPodcastDescription.textContent = podcastDescription;
    dialogPodcastDescription.hidden = !podcastDescription;
  }

  if (automaticScheduleStatus) {
    automaticScheduleStatus.innerHTML = `
      <div>
        <p>${automaticChecksOn ? "Automatic checks are on." : "Automatic checks are off."}</p>
        <span>${automaticChecksOn ? "Checks about once an hour." : "Only check when I press Refresh Stories."}</span>
      </div>
      <dl>
        <div>
          <dt>Next check</dt>
          <dd>${escapeHtml(getStoryCardAutomaticCheckLabel(storyCard))}</dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>${escapeHtml(getStoryCardLastAutomaticCheckLabel(storyCard))}</dd>
        </div>
        ${
          automaticResult
            ? `<div>
                <dt>Status</dt>
                <dd>${escapeHtml(automaticResult)}</dd>
              </div>`
            : ""
        }
      </dl>
    `;
  }
};

const openEditor = (storyCard) => {
  activeCardId = storyCard.id;
  hideDeleteConfirmation();
  resetEditorSetupLock();

  updateEditorPreview(storyCard);

  playlistName.value = storyCard.name;
  rssFeed.value = storyCard.podcastLink;
  populateEditorPlaylistOptions(storyCard);
  setSwitch(isAutomaticChecksEnabled(storyCard) && storyCard.statusType !== "paused");
  setStoryRules(storyCard);
  setEditorTab("stories");
  setStoriesSubtab("queue");
  setStoryQueueState({
    storyCardId: storyCard.id,
    status: "loading",
    message: "",
    stories: [],
    pendingUpdates: {},
    filter: "all",
  });

  backdrop.hidden = false;
  setModalLock();
  loadStoryQueue(storyCard.id, { discoverIfEmpty: true });
  window.setTimeout(() => editorTabs.find((tab) => tab.dataset.editorTab === "stories")?.focus(), 0);
};

const closeEditor = () => {
  hideDeleteConfirmation();
  resetEditorSetupLock();
  stopStoryQueuePolling();
  backdrop.hidden = true;
  setModalLock();
};

const deleteActiveCard = async () => {
  if (!requireAuth("Connect Yoto to remove this setup.")) return;

  const activeCard = storyCards.find((storyCard) => storyCard.id === activeCardId);
  if (!activeCard) return;

  const previousText = setButtonBusy(confirmDeleteCard, true, "Removing...");
  try {
    await apiRequest(`/api/story-cards/${encodeURIComponent(activeCard.id)}`, {
      method: "DELETE",
    });
    await loadStoryCards();
    closeEditor();
  } catch (error) {
    dialogCrawl.textContent = error.message || "Could not remove this setup.";
  } finally {
    confirmDeleteCard.disabled = false;
    confirmDeleteCard.textContent = previousText;
  }
};

const saveActiveCard = async () => {
  if (!requireAuth("Connect Yoto to save story card changes.")) return;

  const activeCard = storyCards.find((storyCard) => storyCard.id === activeCardId);
  if (!activeCard) return;

  const selectedYotoCard = availableYotoCards.find(
    (card) => card.id === yotoCard.value
  );
  const automaticChecksEnabled = syncSwitch.classList.contains("is-on");
  const updateRhythm = automaticChecksEnabled ? "daily" : "manual";
  const previousText = setButtonBusy(saveCard, true, "Saving...");

  const storyRules = getEditorStoryRules();
  const shouldSyncPlaylistAfterSave = haveStoryRulesChanged(getStoryRules(activeCard), storyRules);
  const updatePayload = {
    automaticChecksEnabled,
    updateRhythm,
    lateCheckRhythm: automaticChecksEnabled ? "hourly" : "",
    status: automaticChecksEnabled ? "Updating" : "Taking a Break",
    statusType: automaticChecksEnabled ? "live" : "paused",
    nextCheck: "",
    newStoryBehavior: storyRules.newStoryBehavior,
    playlistLimit: storyRules.playlistLimit,
    capacityMode: storyRules.capacityMode,
    manualMaxStoriesEnabled: storyRules.manualMaxStoriesEnabled,
    manualMaxStories: storyRules.manualMaxStories,
    manualMaxStorageEnabled: storyRules.manualMaxStorageEnabled,
    manualMaxStorageMb: storyRules.manualMaxStorageMb,
    manualMaxPlayTimeEnabled: storyRules.manualMaxPlayTimeEnabled,
    manualMaxPlayTimeMinutes: storyRules.manualMaxPlayTimeMinutes,
    favoritesNeverRotate: storyRules.favoritesNeverRotate,
  };

  if (canEditSetupDetails()) {
    updatePayload.setupChangeAcknowledged = true;
    updatePayload.name = playlistName.value.trim();
    updatePayload.yotoPlaylistId =
      selectedYotoCard?.id || activeCard.yotoPlaylistId || activeCard.yotoCardId;
    updatePayload.yotoPlaylistTitle = selectedYotoCard
      ? getYotoCardTitle(selectedYotoCard)
      : getStoryCardPlaylistTitle(activeCard);
    updatePayload.yotoPlaylistImageUrl =
      selectedYotoCard?.imageUrl || getStoryCardPlaylistImageUrl(activeCard);

    if (isPodcastChangeConfirmed()) {
      updatePayload.podcastLink = rssFeed.value.trim();
    }
  }

  try {
    const savedStoryCard = await jsonRequest(
      `/api/story-cards/${encodeURIComponent(activeCard.id)}`,
      "PUT",
      updatePayload
    );
    await savePendingStoryQueueChanges(activeCard.id);
    await loadStoryCards();
    const refreshedCard = storyCards.find((storyCard) => storyCard.id === activeCard.id) || savedStoryCard;
    if (refreshedCard) {
      updateEditorPreview(refreshedCard);
      playlistName.value = refreshedCard.name;
      rssFeed.value = refreshedCard.podcastLink;
      populateEditorPlaylistOptions(refreshedCard);
      setStoryRules(refreshedCard);
      renderStoryQueue();
      if (shouldSyncPlaylistAfterSave) {
        await syncStoryPlaylist();
        maybeProcessStoriesForStoryCard(activeCard.id);
      }
    }
  } catch (error) {
    dialogCrawl.textContent = error.message || "Could not save this Story Card.";
  } finally {
    saveCard.disabled = false;
    saveCard.textContent = previousText;
  }
};

const setSetupSelectedCard = (card) => {
  if (!isCompatibleYotoPlaylist(card) || isYotoPlaylistAlreadyUsed(card?.id)) {
    setupDraft.yotoCardId = "";
    setupDraft.yotoCardTitle = "";
    setupDraft.yotoCardImageUrl = null;
    return;
  }

  setupDraft.yotoCardId = card.id;
  setupDraft.yotoCardTitle = getYotoCardTitle(card);
  setupDraft.yotoCardImageUrl = card.imageUrl || null;
};

const loadYotoCardsForSetup = async ({ force = false, showLoading = true } = {}) => {
  if (!force && yotoCardsLoadState.status === "loaded") {
    chooseDefaultSetupPlaylist();
    if (!setupBackdrop.hidden) renderSetupStep();
    return;
  }

  if (!force && yotoCardsLoadState.status === "loading") {
    if (!setupBackdrop.hidden) renderSetupStep();
    return;
  }

  const loadId = yotoCardsLoadId + 1;
  yotoCardsLoadId = loadId;

  if (force || !availableYotoCards.length) {
    availableYotoCards = [];
    setSetupSelectedCard(null);
  }

  yotoCardsLoadState = {
    status: "loading",
    message: "Loading your Story Playlists...",
  };
  if (showLoading && !setupBackdrop.hidden) renderSetupStep();

  try {
    const cards = await apiRequest("/api/yoto/cards");
    if (loadId !== yotoCardsLoadId) return;

    availableYotoCards = Array.isArray(cards) ? cards : [];
    yotoCardsLoadState = {
      status: "loaded",
      message: "",
    };
    chooseDefaultSetupPlaylist();
  } catch (error) {
    if (loadId !== yotoCardsLoadId) return;

    availableYotoCards = [];
    yotoCardsLoadState = {
      status: error.status === 401 ? "unauthenticated" : "error",
      message:
        error.status === 401
          ? "Connect Yoto before choosing a card."
          : "Could not load your Story Playlists. Try reconnecting Yoto.",
    };

    if (error.status === 401) {
      openAuthModal("Connect Yoto before choosing a card.");
    }
  } finally {
    if (loadId === yotoCardsLoadId && !setupBackdrop.hidden) renderSetupStep();
  }
};

const renderSetupStep = () => {
  setupError.textContent = "";
  setupBackButton.hidden = setupStep === 0;
  setupNextButton.hidden = setupStep === 2;
  setupNextButton.disabled = setupStep === 0 && !canContinueFromPlaylistStep();
  saveStoryCardButton.hidden = setupStep !== 2 || !isSetupDraftComplete();

  document.querySelectorAll("[data-step-indicator]").forEach((indicator) => {
    indicator.classList.toggle("is-active", Number(indicator.dataset.stepIndicator) === setupStep);
  });

  if (setupStep === 0) {
    setupTitle.textContent = "Pick a Story Playlist";

    if (setupDraft.playlistMode === "create") {
      setupStepContent.innerHTML = `
        ${renderPlaylistModeTabs()}
        <div class="setup-field-stack">
          <label class="field">
            <span>New Story Playlist Name</span>
            <input id="setupNewPlaylistTitle" type="text" value="${escapeAttribute(setupDraft.newPlaylistTitle)}" autocomplete="off" />
            <small>Recommended. Feed Your Yoto will create a fresh Story Playlist for this podcast so nothing you already have gets overwritten. After setup, open the Yoto app to link this playlist to a physical Make Your Own card.</small>
          </label>
        </div>
      `;
      return;
    }

    if (yotoCardsLoadState.status === "idle" || yotoCardsLoadState.status === "loading") {
      setupStepContent.innerHTML = `
        ${renderPlaylistModeTabs()}
        <p class="setup-helper">Loading your Story Playlists...</p>
        ${renderPlaylistRefreshButton()}
      `;
      return;
    }

    if (yotoCardsLoadState.status === "unauthenticated") {
      setupStepContent.innerHTML = `
        ${renderPlaylistModeTabs()}
        <p class="setup-helper">Connect Yoto before choosing a playlist.</p>
        ${renderPlaylistRefreshButton()}
      `;
      return;
    }

    if (yotoCardsLoadState.status === "error") {
      setupStepContent.innerHTML = `
        ${renderPlaylistModeTabs()}
        <p class="setup-helper">${escapeHtml(yotoCardsLoadState.message)}</p>
        ${renderPlaylistRefreshButton()}
      `;
      return;
    }

    const regularPlaylists = getRegularYotoPlaylists();
    const streamingPlaylists = getStreamingYotoPlaylists();

    if (!regularPlaylists.length && !streamingPlaylists.length) {
      setupStepContent.innerHTML = `
        ${renderPlaylistModeTabs()}
        <p class="setup-helper">No compatible playlists found.</p>
        ${renderPlaylistRefreshButton()}
        <p class="setup-note">Streaming playlists are grouped separately because this app manages uploaded Yoto audio.</p>
      `;
      return;
    }

    setupStepContent.innerHTML = `
      ${renderPlaylistModeTabs()}
      <p class="setup-helper">Use this only if you want Feed Your Yoto to manage a playlist that already exists.</p>
      <div class="setup-warning" role="note">
        <strong>Grown-up note</strong>
        <span>Feed Your Yoto will manage this playlist. When syncing starts, this may replace the playlist's chapters and tracks with podcast episodes.</span>
      </div>
      <label class="setup-checkbox">
        <input id="setupOverwriteAcknowledged" type="checkbox" ${setupDraft.overwriteAcknowledged ? "checked" : ""} />
        <span>I understand this app will manage the selected Story Playlist.</span>
      </label>
      ${renderPlaylistRefreshButton()}
      ${
        regularPlaylists.length
          ? `
            <section class="playlist-group" aria-labelledby="regularPlaylistsHeading">
              <h3 id="regularPlaylistsHeading" class="playlist-group-title">Story Playlists</h3>
              <div class="setup-option-grid">
                ${regularPlaylists
                  .map((card) => {
                    const usedStoryCard = getUsedStoryCardForPlaylist(card.id);
                    return renderPlaylistTile(card, {
                      selectable: !usedStoryCard,
                      reason: usedStoryCard ? "used" : "",
                      usedStoryCard,
                    });
                  })
                  .join("")}
              </div>
            </section>
          `
          : `
            <p class="setup-helper">No compatible playlists found.</p>
          `
      }
      ${
        streamingPlaylists.length
          ? `
            <section class="playlist-group" aria-labelledby="streamingPlaylistsHeading">
              <h3 id="streamingPlaylistsHeading" class="playlist-group-title">Streaming Playlists</h3>
              <div class="setup-option-grid">
                ${streamingPlaylists.map((card) => renderPlaylistTile(card, { selectable: false, reason: "streaming" })).join("")}
              </div>
            </section>
          `
          : ""
      }
      <p class="setup-note">Streaming playlists are grouped separately because this app manages uploaded Yoto audio.</p>
    `;
    return;
  }

  if (setupStep === 1) {
    setupTitle.textContent = "Add a podcast link";
    setupStepContent.innerHTML = `
      <div class="setup-field-stack">
        <label class="field">
          <span>Story Card Name</span>
          <input id="setupStoryCardName" type="text" value="${escapeAttribute(setupDraft.name)}" autocomplete="off" />
        </label>
        <label class="field">
          <span>Podcast Link</span>
          <input id="setupPodcastLink" type="url" value="${escapeAttribute(setupDraft.podcastLink)}" autocomplete="off" />
          <small>Paste the podcast's RSS feed link here.</small>
        </label>
        <div class="podcast-check-row">
          <button class="outline-action" type="button" data-check-podcast-link ${setupDraft.podcastPreviewStatus === "loading" ? "disabled" : ""}>
            Check Podcast Link
          </button>
        </div>
        <div class="podcast-preview-region">
          ${renderPodcastPreview()}
        </div>
      </div>
    `;
    return;
  }

  setupTitle.textContent = "Automatic checks";
  setupStepContent.innerHTML = `
    <div class="setup-field-stack">
      <div>
        <p class="setup-label">Automatic checks</p>
        <div class="setup-choice-list">
          <button class="setup-choice ${setupDraft.automaticChecksEnabled ? "is-selected" : ""}" type="button" data-automatic-checks="on">
            Automatic checks on
            <span>Feed Your Yoto checks this Podcast Link every hour.</span>
          </button>
          <button class="setup-choice ${!setupDraft.automaticChecksEnabled ? "is-selected" : ""}" type="button" data-automatic-checks="off">
            Automatic checks off
            <span>Only check when I press Refresh Stories.</span>
          </button>
        </div>
      </div>
    </div>
  `;
};

const openSetupFlow = () => {
  setupStep = 0;
  setupDraft = getFreshSetupDraft();
  setupBackdrop.hidden = false;
  setModalLock();
  loadYotoCardsForSetup();
};

const closeSetupFlow = () => {
  setupBackdrop.hidden = true;
  setModalLock();
};

const validatePodcastLink = (value) => {
  if (!value.trim()) {
    return "Podcast Link is required.";
  }

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Podcast Link should start with http or https.";
    }
  } catch {
    return "Podcast Link should look like a URL.";
  }

  return "";
};

const getSetupDraftError = () => {
  if (setupDraft.playlistMode === "create") {
    if (!setupDraft.newPlaylistTitle.trim()) {
      return "Name the new Story Playlist first.";
    }
  } else {
    if (!setupDraft.yotoCardId) {
      return "Choose a Story Playlist first.";
    }

    if (!setupDraft.overwriteAcknowledged) {
      return "A grown-up needs to check the Story Playlist warning first.";
    }
  }

  if (!setupDraft.name.trim()) {
    return "Story Card Name is required.";
  }

  const podcastError = validatePodcastLink(setupDraft.podcastLink);
  if (podcastError) return podcastError;

  return "";
};

const isSetupDraftComplete = () => getSetupDraftError() === "";

const validateSetupStep = () => {
  if (setupStep === 0) {
    if (setupDraft.playlistMode === "create") {
      return setupDraft.newPlaylistTitle.trim() ? "" : "Name the new Story Playlist first.";
    }

    if (!setupDraft.yotoCardId) {
      return "Choose a Story Playlist first.";
    }

    if (!setupDraft.overwriteAcknowledged) {
      return "A grown-up needs to check the Story Playlist warning first.";
    }
  }

  if (setupStep === 1) {
    if (!setupDraft.name.trim()) {
      return "Story Card Name is required.";
    }

    return validatePodcastLink(setupDraft.podcastLink);
  }

  return "";
};

const goToNextSetupStep = () => {
  const error = validateSetupStep();
  if (error) {
    setupError.textContent = error;
    return;
  }

  setupStep = Math.min(setupStep + 1, 2);
  renderSetupStep();
};

const goToPreviousSetupStep = () => {
  setupStep = Math.max(setupStep - 1, 0);
  renderSetupStep();
};

const getNewStoryCardTiming = () => {
  if (!setupDraft.automaticChecksEnabled) return { label: "Only when I press Refresh Stories", value: "" };
  return { label: "Checks about once an hour", value: "" };
};

const checkPodcastLink = async () => {
  const podcastError = validatePodcastLink(setupDraft.podcastLink);
  if (podcastError) {
    setupDraft.podcastPreviewStatus = "error";
    setupDraft.podcastPreviewMessage = podcastError;
    setupDraft.podcastPreview = null;
    renderSetupStep();
    return;
  }

  setupDraft.podcastPreviewStatus = "loading";
  setupDraft.podcastPreviewMessage = "";
  renderSetupStep();

  try {
    const preview = await jsonRequest("/api/podcast/preview", "POST", {
      podcastLink: setupDraft.podcastLink.trim(),
    });
    setupDraft.podcastPreview = preview;
    setupDraft.podcastPreviewStatus = "success";
    setupDraft.podcastPreviewMessage = "";
    setupDraft.podcastPreviewLink = setupDraft.podcastLink.trim();
  } catch (error) {
    setupDraft.podcastPreview = null;
    setupDraft.podcastPreviewStatus = "error";
    setupDraft.podcastPreviewMessage = error.message || "Could not check this Podcast Link.";
    setupDraft.podcastPreviewLink = "";
  }

  renderSetupStep();
};

const saveSetupStoryCard = async () => {
  const error = getSetupDraftError();
  if (error) {
    setupError.textContent = error;
    renderSetupStep();
    setupError.textContent = error;
    return;
  }

  const selectedYotoCard = availableYotoCards.find(
    (card) => card.id === setupDraft.yotoCardId
  );
  const timing = getNewStoryCardTiming();
  const previousText = setButtonBusy(saveStoryCardButton, true, "Saving...");

  try {
    await jsonRequest("/api/story-cards", "POST", {
      playlistMode: setupDraft.playlistMode,
      newPlaylistTitle: setupDraft.newPlaylistTitle.trim(),
      overwriteAcknowledged: setupDraft.overwriteAcknowledged,
      name: setupDraft.name.trim(),
      podcastLink: setupDraft.podcastLink.trim(),
      yotoPlaylistId:
        setupDraft.playlistMode === "existing"
          ? selectedYotoCard?.id || setupDraft.yotoCardId
          : "",
      yotoPlaylistTitle:
        setupDraft.playlistMode === "existing"
          ? setupDraft.yotoCardTitle || getYotoCardTitle(selectedYotoCard)
          : setupDraft.newPlaylistTitle.trim(),
      yotoPlaylistImageUrl:
        setupDraft.playlistMode === "existing"
          ? setupDraft.yotoCardImageUrl || selectedYotoCard?.imageUrl || null
          : null,
      automaticChecksEnabled: setupDraft.automaticChecksEnabled,
      updateRhythm: setupDraft.automaticChecksEnabled ? "daily" : "manual",
      lateCheckRhythm: setupDraft.automaticChecksEnabled ? "hourly" : "",
      status: "Updating",
      statusType: setupDraft.automaticChecksEnabled ? "live" : "paused",
      nextCheck: timing.value,
      ...getPodcastPreviewPayload(),
    });
    await loadStoryCards();
    closeSetupFlow();
  } catch (saveError) {
    setupError.textContent = saveError.message || "Could not save this Story Card.";
  } finally {
    saveStoryCardButton.disabled = false;
    saveStoryCardButton.textContent = previousText;
  }
};

const pollYotoAuth = (intervalSeconds = 5) => {
  stopAuthPolling();

  const pollOnce = async () => {
    try {
      const result = await apiRequest("/api/auth/poll", { method: "POST" });

      if (result.authenticated) {
        setAuthenticated(true);
        authMessage.textContent = "Yoto account connected.";
        closeYotoLoginPopup();
        closeAuthModal();
        if (!setupBackdrop.hidden && setupStep === 0) {
          loadYotoCardsForSetup();
        }
        return;
      }

      if (result.pending) {
        authMessage.textContent = "Waiting for Yoto sign-in to finish...";
        const nextInterval = Number(result.interval || intervalSeconds || 5);
        authPollTimer = window.setTimeout(pollOnce, Math.max(nextInterval, 1) * 1000);
        return;
      }

      authMessage.textContent = result.message || "Yoto sign-in was not completed.";
    } catch (error) {
      authMessage.textContent = error.message || "Could not check Yoto sign-in yet.";
      authPollTimer = window.setTimeout(pollOnce, Math.max(intervalSeconds, 5) * 1000);
    }
  };

  authPollTimer = window.setTimeout(pollOnce, Math.max(intervalSeconds, 1) * 1000);
};

const openCenteredAuthWindow = (url) => {
  const availableWidth = window.screen?.availWidth || 720;
  const availableHeight = window.screen?.availHeight || 820;
  const width = Math.min(520, Math.max(380, availableWidth - 48));
  const height = Math.min(720, Math.max(560, availableHeight - 80));
  const screenLeft = window.screenLeft ?? window.screenX ?? 0;
  const screenTop = window.screenTop ?? window.screenY ?? 0;
  const outerWidth = window.outerWidth || window.innerWidth || availableWidth;
  const outerHeight = window.outerHeight || window.innerHeight || availableHeight;
  const left = Math.max(0, screenLeft + (outerWidth - width) / 2);
  const top = Math.max(0, screenTop + (outerHeight - height) / 2);
  const features = [
    "popup=yes",
    "toolbar=no",
    "menubar=no",
    "status=no",
    "scrollbars=yes",
    "resizable=yes",
    "location=yes",
    `width=${Math.round(width)}`,
    `height=${Math.round(height)}`,
    `left=${Math.round(left)}`,
    `top=${Math.round(top)}`,
  ].join(",");

  yotoLoginPopup = window.open(url, "yotoLogin", features);

  if (!yotoLoginPopup) return false;

  yotoLoginPopup.focus();
  return true;
};

const openYotoLoginWindow = (event) => {
  event.preventDefault();

  const loginUrl = openYotoLogin.dataset.loginUrl || "";

  if (!loginUrl || openYotoLogin.disabled) {
    authMessage.textContent = "Start Yoto sign-in first, then open the login window.";
    return;
  }

  const opened = openCenteredAuthWindow(loginUrl);
  authMessage.textContent = opened
    ? "Finish Yoto sign-in in the small login window."
    : "The login window was blocked. Allow popups for this app and try again.";
};

const startYotoAuth = async () => {
  connectYotoButton.disabled = true;
  connectYotoButton.textContent = "Starting...";
  authMessage.textContent = "";

  try {
    const auth = await apiRequest("/api/auth/start", { method: "POST" });
    const loginUrl = auth.verification_uri_complete || auth.verification_uri || "#";

    authUserCode.textContent = auth.user_code || "----";
    openYotoLogin.dataset.loginUrl = loginUrl === "#" ? "" : loginUrl;
    openYotoLogin.disabled = loginUrl === "#";
    showAuthState("device");
    authMessage.textContent = "This window will update when Yoto says you are signed in.";
    pollYotoAuth(Number(auth.interval || 5));
  } catch (error) {
    authMessage.textContent = error.message || "Could not start Yoto sign-in.";
    connectYotoButton.disabled = false;
    connectYotoButton.textContent = "Connect Yoto";
  }
};

const resetYotoAuth = async () => {
  stopAuthPolling();
  closeYotoLoginPopup();
  closeEditor();
  closeSetupFlow();

  try {
    await apiRequest("/api/auth/reset", { method: "POST" });
  } catch (error) {
    console.warn("Could not reset Yoto auth on the server.", error);
  }

  setAuthenticated(false);
  openAuthModal("Disconnected. Connect Yoto to keep going.");
};

const initializeAuth = async () => {
  const status = await checkAuthStatus();

  if (!status.authenticated) {
    openAuthModal();
  }
};

storyCardsNav?.addEventListener("click", (event) => {
  event.preventDefault();
  setActiveView("story-cards");
});

activityLogNav?.addEventListener("click", (event) => {
  event.preventDefault();
  setActiveView("activity-log");
});

refreshActivityLog?.addEventListener("click", loadActivityLog);

cardGrid.addEventListener("click", (event) => {
  const emptyAddButton = event.target.closest("[data-empty-add]");
  if (emptyAddButton) {
    if (!requireAuth("Connect Yoto to add a story card.")) return;
    openSetupFlow();
    return;
  }

  const cardButton = event.target.closest(".yoto-card");
  if (!cardButton) return;
  if (!requireAuth("Connect Yoto to manage this story card.")) return;

  const storyCard = storyCards.find((item) => item.id === cardButton.dataset.cardId);
  if (storyCard) openEditor(storyCard);
});

editorTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setEditorTab(tab.dataset.editorTab);
  });
});

storySubtabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setStoriesSubtab(tab.dataset.storiesSubtab);
  });
});

newStoryBehaviorButtons.forEach((button) => {
  button.addEventListener("click", () => {
    newStoryBehaviorButtons.forEach((option) => {
      option.classList.toggle("is-selected", option === button);
    });
    renderStoryQueue();
    if (button.dataset.newStoryBehavior === "auto_pick") {
      maybeProcessStoriesForStoryCard(activeCardId);
    }
  });
});

capacityModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    capacityModeButtons.forEach((option) => {
      option.classList.toggle("is-selected", option === button);
    });
    if (manualCapacityControls) manualCapacityControls.hidden = button.dataset.capacityMode !== "manual";
    renderStoryQueue();
    if (getEditorStoryRules().newStoryBehavior === "auto_pick") {
      maybeProcessStoriesForStoryCard(activeCardId);
    }
  });
});

[
  manualMaxStoriesEnabled,
  manualMaxStories,
  manualMaxStorageEnabled,
  manualMaxStorageMb,
  manualMaxPlayTimeEnabled,
  manualMaxPlayTimeHours,
  manualMaxPlayTimeMinutes,
].forEach((control) => {
  control?.addEventListener("input", () => {
    renderStoryQueue();
    if (getEditorStoryRules().newStoryBehavior === "auto_pick") {
      maybeProcessStoriesForStoryCard(activeCardId);
    }
  });
  control?.addEventListener("change", () => {
    renderStoryQueue();
    if (getEditorStoryRules().newStoryBehavior === "auto_pick") {
      maybeProcessStoriesForStoryCard(activeCardId);
    }
  });
});

refreshStories.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to refresh stories.")) return;
  discoverStories(activeCardId);
});

storyQueueContent.addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-story-filter]");
  if (filterButton) {
    setStoryQueueState({ filter: filterButton.dataset.storyFilter || "all" });
    return;
  }

  const syncPlaylistButton = event.target.closest("[data-sync-playlist]");
  if (syncPlaylistButton) {
    if (!requireAuth("Connect Yoto to update the Story Playlist.")) return;
    syncStoryPlaylist();
    return;
  }

  const bulkDownloadButton = event.target.closest("[data-download-selected]");
  if (bulkDownloadButton) {
    if (!requireAuth("Connect Yoto to get stories ready.")) return;
    downloadSelectedStories();
    return;
  }

  const downloadButton = event.target.closest("[data-download-story]");
  if (downloadButton) {
    if (!requireAuth("Connect Yoto to get this story ready.")) return;
    const storyItem = downloadButton.closest("[data-story-id]");
    downloadQueuedStory(storyItem?.dataset.storyId || "");
    return;
  }

  const uploadButton = event.target.closest("[data-upload-story]");
  if (uploadButton) {
    if (!requireAuth("Connect Yoto to send this story.")) return;
    const storyItem = uploadButton.closest("[data-story-id]");
    uploadQueuedStory(storyItem?.dataset.storyId || "");
    return;
  }

  const retryButton = event.target.closest("[data-retry-story]");
  if (retryButton) {
    if (!requireAuth("Connect Yoto to try this story again.")) return;
    const storyItem = retryButton.closest("[data-story-id]");
    retryQueuedStory(storyItem?.dataset.storyId || "");
    return;
  }

  const detailsButton = event.target.closest("[data-story-details]");
  if (detailsButton) {
    const storyItem = detailsButton.closest("[data-story-id]");
    toggleStoryDetails(storyItem?.dataset.storyId || "");
    return;
  }

  const actionButton = event.target.closest("[data-story-action]");
  if (!actionButton) return;
  if (!requireAuth("Connect Yoto to update the Story Queue.")) return;

  const storyItem = actionButton.closest("[data-story-id]");
  updateQueuedStoryControl(storyItem?.dataset.storyId || "", actionButton.dataset.storyAction);
});

syncSwitch.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to change update settings.")) return;
  setSwitch(!syncSwitch.classList.contains("is-on"));
  refreshScheduleDraftPreview();
});

pauseCard.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to take a break.")) return;
  setSwitch(false);
  refreshScheduleDraftPreview();
});

changeSetupDetails.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to change setup details.")) return;
  showSetupDetailsPanel();
});

setupChangeAcknowledged.addEventListener("change", refreshSetupDetailLocks);
podcastChangeCode.addEventListener("input", refreshSetupDetailLocks);

deleteCard.addEventListener("click", showDeleteConfirmation);
cancelDeleteCard.addEventListener("click", hideDeleteConfirmation);
confirmDeleteCard.addEventListener("click", deleteActiveCard);

setupStepContent.addEventListener("click", (event) => {
  const playlistModeOption = event.target.closest("[data-playlist-mode]");
  if (playlistModeOption) {
    setupDraft.playlistMode = playlistModeOption.dataset.playlistMode;
    setupDraft.yotoCardId = "";
    setupDraft.yotoCardTitle = "";
    setupDraft.yotoCardImageUrl = null;
    setupDraft.overwriteAcknowledged = false;
    chooseDefaultSetupPlaylist();
    renderSetupStep();
    return;
  }

  const checkPodcastButton = event.target.closest("[data-check-podcast-link]");
  if (checkPodcastButton) {
    checkPodcastLink();
    return;
  }

  const refreshPlaylistsButton = event.target.closest("[data-refresh-yoto-playlists]");
  if (refreshPlaylistsButton) {
    loadYotoCardsForSetup({ force: true });
    return;
  }

  const yotoCardOption = event.target.closest("[data-yoto-card-id]");
  if (yotoCardOption) {
    const selectedCard = availableYotoCards.find(
      (card) => card.id === yotoCardOption.dataset.yotoCardId
    );
    setSetupSelectedCard(selectedCard);
    renderSetupStep();
    return;
  }

  const automaticChecksOption = event.target.closest("[data-automatic-checks]");
  if (automaticChecksOption) {
    setupDraft.automaticChecksEnabled = automaticChecksOption.dataset.automaticChecks === "on";
    setupDraft.updateRhythm = setupDraft.automaticChecksEnabled ? "daily" : "manual";
    setupDraft.lateCheckRhythm = setupDraft.automaticChecksEnabled ? "hourly" : "";
    renderSetupStep();
  }
});

setupStepContent.addEventListener("input", (event) => {
  if (event.target.id === "setupNewPlaylistTitle") {
    setupDraft.newPlaylistTitle = event.target.value;
    setupNextButton.disabled = !canContinueFromPlaylistStep();
  }

  if (event.target.id === "setupStoryCardName") {
    setupDraft.name = event.target.value;
  }

  if (event.target.id === "setupPodcastLink") {
    setupDraft.podcastLink = event.target.value;
    if (setupDraft.podcastPreviewLink !== setupDraft.podcastLink.trim()) {
      setupDraft.podcastPreview = null;
      setupDraft.podcastPreviewStatus = "idle";
      setupDraft.podcastPreviewMessage = "";
    }
  }
});

setupStepContent.addEventListener("change", (event) => {
  if (event.target.id === "setupOverwriteAcknowledged") {
    setupDraft.overwriteAcknowledged = event.target.checked;
    setupNextButton.disabled = !canContinueFromPlaylistStep();
  }
});

saveCard.addEventListener("click", saveActiveCard);
closeDialog.addEventListener("click", closeEditor);
addCardButton.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to add a story card.")) return;
  openSetupFlow();
});
showAllButton.addEventListener("click", () => {
  requireAuth("Connect Yoto to see every story card.");
});

setupBackButton.addEventListener("click", goToPreviousSetupStep);
setupNextButton.addEventListener("click", goToNextSetupStep);
saveStoryCardButton.addEventListener("click", saveSetupStoryCard);
cancelSetupButton.addEventListener("click", closeSetupFlow);
closeSetupDialog.addEventListener("click", closeSetupFlow);

authButton.addEventListener("click", () => {
  if (isAuthenticated) {
    resetYotoAuth();
    return;
  }

  openAuthModal();
});
connectYotoButton.addEventListener("click", startYotoAuth);
openYotoLogin.addEventListener("click", openYotoLoginWindow);
notNowButton.addEventListener("click", closeAuthModal);
cancelAuthButton.addEventListener("click", closeAuthModal);
closeAuthDialog.addEventListener("click", closeAuthModal);

backdrop.addEventListener("click", (event) => {
  if (event.target === backdrop) closeEditor();
});

setupBackdrop.addEventListener("click", (event) => {
  if (event.target === setupBackdrop) closeSetupFlow();
});

authBackdrop.addEventListener("click", (event) => {
  if (event.target === authBackdrop) closeAuthModal();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (!authBackdrop.hidden) {
    closeAuthModal();
    return;
  }

  if (!setupBackdrop.hidden) {
    closeSetupFlow();
    return;
  }

  if (!backdrop.hidden) {
    if (!deleteConfirmPanel.hidden) {
      hideDeleteConfirmation();
      return;
    }

    closeEditor();
  }
});

lockFeatures();
loadStoryCards();
initializeAuth();
