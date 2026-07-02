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
};
let storyDownloadState = {
  storyIds: new Set(),
  bulk: false,
};

const storyStatusLabels = {
  discovered: "New story found",
  selected: "Picked for Yoto",
  skipped: "Skipped for now",
  downloading: "Getting story ready",
  downloaded: "Story ready to send",
  uploaded: "Story sent",
  adding_to_playlist: "Adding to Story Playlist",
  synced: "Ready on Yoto",
  cleaning_local: "Tidying up",
  rotated_off: "Old story resting",
  failed: "Needs help",
};

const storyTrackerSteps = [
  { key: "discovered", label: "New story found" },
  { key: "selected", label: "Picked for Yoto" },
  { key: "downloading", label: "Getting story ready" },
  { key: "downloaded", label: "Story ready to send" },
  { key: "uploaded", label: "Sending story to Yoto" },
  { key: "adding_to_playlist", label: "Adding to Story Playlist" },
  { key: "synced", label: "Ready on Yoto" },
];

const defaultStoryRules = {
  newStoryBehavior: "auto_pick",
  playlistLimit: 10,
  favoritesNeverRotate: true,
};

const updateRhythmOptions = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "manual", label: "Only when I press check" },
];

const lateCheckRhythmOptions = [
  { value: "hourly", label: "Keep checking every hour", shortLabel: "if late, checks every hour" },
  { value: "daily", label: "Keep checking once a day", shortLabel: "if late, checks once a day" },
  { value: "next", label: "Wait until next time", shortLabel: "if late, waits until next time" },
];

const cardGrid = document.querySelector("#cardGrid");
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
const playlistName = document.querySelector("#playlistName");
const rssFeed = document.querySelector("#rssFeed");
const yotoCard = document.querySelector("#yotoCard");
const nextCrawl = document.querySelector("#nextCrawl");
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
const frequencyButtons = Array.from(document.querySelectorAll("[data-frequency]"));
const lateFrequencyButtons = Array.from(document.querySelectorAll("[data-late-frequency]"));
const newStoryBehaviorButtons = Array.from(document.querySelectorAll("[data-new-story-behavior]"));
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
  if (storyCard?.updateRhythm === "manual") return "Only when I press check";
  return formatDateTime(storyCard?.nextCheck);
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

const getRhythmLabel = (value) =>
  updateRhythmOptions.find((option) => option.value === value)?.label || "Every day";

const getLateLabel = (value) =>
  lateCheckRhythmOptions.find((option) => option.value === value)?.shortLabel ||
  "if late, checks every hour";

const formatLookSchedule = (storyCard) => {
  if (storyCard.updateRhythm === "manual") {
    return getRhythmLabel(storyCard.updateRhythm);
  }

  return `${getRhythmLabel(storyCard.updateRhythm)} - ${getLateLabel(storyCard.lateCheckRhythm)}`;
};

const getNextCheckParts = () => {
  const datedCards = storyCards
    .map((storyCard) => ({
      value: storyCard.nextCheck,
      date: storyCard.nextCheck ? new Date(storyCard.nextCheck) : null,
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
              <span>Looks for episodes</span>
              <strong>${escapeHtml(formatLookSchedule(storyCard))}</strong>
            </div>
          </div>
        </button>
      `
    )
    .join("");
}

const setFrequency = (frequency) => {
  const selectedFrequency = frequency || "daily";
  frequencyButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.frequency === selectedFrequency);
  });
};

const setLateFrequency = (frequency) => {
  const selectedFrequency = frequency || "hourly";
  lateFrequencyButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.lateFrequency === selectedFrequency);
  });
};

const setSwitch = (isOn) => {
  syncSwitch.classList.toggle("is-on", isOn);
  syncSwitch.setAttribute("aria-pressed", String(isOn));
  switchStatus.textContent = isOn ? "On and watching" : "Off for now";
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

const getStoryRules = (storyCard = {}) => ({
  newStoryBehavior: ["auto_pick", "choose_first"].includes(storyCard.newStoryBehavior)
    ? storyCard.newStoryBehavior
    : defaultStoryRules.newStoryBehavior,
  playlistLimit: normalizePlaylistLimitValue(storyCard.playlistLimit ?? defaultStoryRules.playlistLimit),
  favoritesNeverRotate: storyCard.favoritesNeverRotate !== false,
});

const getEditorStoryRules = () => {
  const selectedBehavior = newStoryBehaviorButtons.find((button) =>
    button.classList.contains("is-selected")
  );

  return {
    newStoryBehavior: selectedBehavior?.dataset.newStoryBehavior || defaultStoryRules.newStoryBehavior,
    playlistLimit: defaultStoryRules.playlistLimit,
    favoritesNeverRotate: true,
  };
};

const setStoryRules = (storyCard = {}) => {
  const rules = getStoryRules(storyCard);

  newStoryBehaviorButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.newStoryBehavior === rules.newStoryBehavior);
  });
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

  const pinnedOnYoto = [];
  const limitedCandidates = [];
  onYotoCandidates.forEach((story) => {
    if (story.isPinned && rules.favoritesNeverRotate) {
      pinnedOnYoto.push(story);
    } else {
      limitedCandidates.push(story);
    }
  });

  const limit = rules.playlistLimit === "all" ? limitedCandidates.length : rules.playlistLimit;
  const onYotoSoon = [...pinnedOnYoto, ...limitedCandidates.slice(0, limit)];
  const oldStoriesResting = [...limitedCandidates.slice(limit), ...oldStoryCandidates];

  return { onYotoSoon, newStories, skippedStories, oldStoriesResting, favorites };
};

const getStoryQueueLastChecked = () => {
  const activeCard = storyCards.find((storyCard) => storyCard.id === storyQueueState.storyCardId);
  return activeCard?.lastStoryDiscoveryAt ? `Last checked ${formatDateTime(activeCard.lastStoryDiscoveryAt)}` : "";
};

const isStoryAudioUsable = (story) => /^https?:\/\//i.test(String(story?.audioUrl || ""));

const isStoryReadyToBringHome = (story) =>
  isStoryAudioUsable(story) &&
  story.status !== "downloaded" &&
  story.status !== "uploaded" &&
  story.status !== "adding_to_playlist" &&
  story.status !== "synced";

const setStoryDownloadState = (nextState) => {
  storyDownloadState = { ...storyDownloadState, ...nextState };
  renderStoryQueue();
};

const getStoryDisplayStatus = (story, group = "new") => {
  if (group === "old" || story.status === "rotated_off") return "Old story resting";
  if (group === "on_yoto" && story.status === "discovered") return "Picked for Yoto";
  if (story.status === "downloading") return "Getting story ready";
  return storyStatusLabels[story.status] || story.statusLabel || "New story found";
};

const getStoryTrackerStatus = (story, group = "new") => {
  if (group === "on_yoto" && story.status === "discovered") return "selected";
  return story.status;
};

const renderStoryTracker = (story, group = "new") => {
  if (group === "old" || story.status === "skipped" || story.status === "rotated_off") return "";

  const trackerStatus = getStoryTrackerStatus(story, group);
  const statusIndex = {
    discovered: 0,
    selected: 1,
    downloading: 2,
    downloaded: 3,
    failed: 2,
    uploaded: 4,
    adding_to_playlist: 5,
    synced: 6,
  }[trackerStatus] ?? 0;

  return `
    <div class="story-tracker" aria-label="Story Tracker">
      <p>Story Tracker</p>
      <ol>
        ${storyTrackerSteps
          .map((step, index) => {
            const state = index < statusIndex ? "is-done" : index === statusIndex ? "is-active" : "";
            return `<li class="story-tracker-step ${state}"><span></span>${escapeHtml(step.label)}</li>`;
          })
          .join("")}
      </ol>
    </div>
  `;
};

const renderBringStoriesHomePanel = (preview) => {
  const onYotoStories = preview.onYotoSoon || [];
  const storiesToBringHome = onYotoStories.filter(isStoryReadyToBringHome);
  const hasOnYotoStories = onYotoStories.length > 0;
  const busy = storyDownloadState.bulk;
  const helper = hasOnYotoStories
    ? storiesToBringHome.length
      ? `${storiesToBringHome.length} ${storiesToBringHome.length === 1 ? "story is" : "stories are"} ready for the next step.`
      : "Stories picked for Yoto are already ready or waiting for the next step."
    : "Pick a story first, then Feed Your Yoto can get it ready.";

  return `
    <div class="story-download-panel">
      <p>${escapeHtml(helper)}</p>
      <button class="outline-action" type="button" data-download-selected ${!storiesToBringHome.length || busy ? "disabled" : ""}>
        ${busy ? "Getting stories ready..." : "Get Stories Ready"}
      </button>
    </div>
  `;
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
  const queueMessageMarkup = storyQueueState.message
    ? `<p class="story-queue-note">${escapeHtml(storyQueueState.message)}</p>`
    : "";

  if (!storyQueueState.stories.length) {
    storyQueueContent.innerHTML = `
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
  const hasPreviewStories = [
    preview.onYotoSoon,
    preview.newStories,
    preview.favorites,
    preview.skippedStories,
    preview.oldStoriesResting,
  ].some((group) => group.length > 0);

  storyQueueContent.innerHTML = `
    ${lastCheckedMarkup}
    ${queueMessageMarkup}
    ${pendingMarkup}
    ${renderBringStoriesHomePanel(preview)}
    ${hasPreviewStories ? renderPlaylistPreviewGroups(preview) : `<div class="story-queue-empty"><p>No stories found yet.</p></div>`}
  `;
};

const renderPlaylistPreviewGroups = (preview) => `
  <div class="playlist-preview-groups">
    ${renderPreviewGroup("On Yoto Soon", "on_yoto", preview.onYotoSoon)}
    ${renderPreviewGroup("New Stories", "new", preview.newStories)}
    ${renderPreviewGroup("Favorites", "favorites", preview.favorites)}
    ${renderPreviewGroup("Skipped Stories", "skipped", preview.skippedStories)}
    ${renderPreviewGroup("Old Stories Resting", "old", preview.oldStoriesResting)}
  </div>
`;

const renderPreviewGroup = (title, group, stories) => `
  <section class="preview-group" aria-label="${escapeAttribute(title)}">
    <div class="preview-group-heading">
      <h5>${escapeHtml(title)}</h5>
      <span>${stories.length}</span>
    </div>
    ${
      stories.length
        ? `<div class="story-list">${stories.map((story) => renderQueuedStory(story, group)).join("")}</div>`
        : `<p class="preview-group-empty">No stories here yet.</p>`
    }
  </section>
`;

const getStoryControlsForGroup = (story, group) => {
  if (group === "new") {
    return getEditorStoryRules().newStoryBehavior === "choose_first"
      ? [{ action: "select", label: "Pick for Yoto", active: story.isSelected }]
      : [];
  }

  if (group === "on_yoto") {
    return story.isPinned
      ? [{ action: "pin", label: "Remove Favorite", active: true }]
      : [
          { action: "remove", label: "Remove from Card", active: false },
          { action: "pin", label: "Keep Favorite", active: false },
        ];
  }

  if (group === "favorites") {
    return [];
  }

  return [{ action: "add_back", label: "Add Back to Playlist", active: false }];
};

const renderStoryDownloadAction = (story, group) => {
  const canShowButton = group === "on_yoto" || story.isSelected || story.status === "selected" || story.status === "failed";
  const isBusy = storyDownloadState.storyIds.has(story.id) || story.status === "downloading";

  if (!canShowButton) return "";

  if (!isStoryAudioUsable(story)) {
    return `<p class="story-audio-note">This story does not have an audio file Feed Your Yoto can use.</p>`;
  }

  if (!isStoryReadyToBringHome(story)) return "";

  return `<button class="outline-action" type="button" data-download-story ${isBusy ? "disabled" : ""}>${isBusy ? "Getting story ready..." : story.status === "failed" ? "Try Again" : "Get Story Ready"}</button>`;
};

const renderQueuedStory = (story, group = "new") => {
  const publishedAt = story.publishedAt ? formatDateTime(story.publishedAt) : "No date yet";
  const controls = getStoryControlsForGroup(story, group);
  const downloadAction = renderStoryDownloadAction(story, group);
  const displayStatus = getStoryDisplayStatus(story, group);
  const controlMarkup = controls
    .map(
      (control) =>
        `<button class="${control.action === "select" ? "outline-action" : "quiet-action"} ${control.active ? "is-active" : ""}" type="button" data-story-action="${escapeAttribute(control.action)}">${escapeHtml(control.label)}</button>`
    )
    .join("");

  return `
    <article class="story-item" data-story-id="${escapeAttribute(story.id)}">
      <div class="story-item-copy">
        <div class="story-item-title-row">
          <h4>${escapeHtml(story.title || "Untitled story")}</h4>
          ${story.isPinned ? `<span class="favorite-badge">Favorite</span>` : ""}
        </div>
        <p>${escapeHtml(publishedAt)}</p>
        <span class="story-status ${story.status === "failed" ? "is-error" : ""}">${escapeHtml(displayStatus)}</span>
        ${story.downloadError ? `<p class="story-error">${escapeHtml(story.downloadError)}</p>` : ""}
        ${renderStoryTracker(story, group)}
      </div>
      ${controlMarkup || downloadAction ? `<div class="story-controls">${controlMarkup}${downloadAction}</div>` : ""}
    </article>
  `;
};

const setStoryQueueState = (nextState) => {
  storyQueueState = { ...storyQueueState, ...nextState };
  renderStoryQueue();
};

const loadStoryQueue = async (storyCardId, { discoverIfEmpty = false } = {}) => {
  setStoryQueueState({
    storyCardId,
    status: "loading",
    message: "",
    stories: storyQueueState.storyCardId === storyCardId ? storyQueueState.stories : [],
    pendingUpdates: {},
  });

  try {
    const stories = await apiRequest(`/api/story-cards/${encodeURIComponent(storyCardId)}/stories`);
    const queueStories = Array.isArray(stories) ? stories : [];

    if (discoverIfEmpty && queueStories.length === 0) {
      await discoverStories(storyCardId);
      return;
    }

    setStoryQueueState({ status: "loaded", stories: queueStories, message: "", pendingUpdates: {} });
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

  setStoryQueueState({ storyCardId, status: "loading", message: "", pendingUpdates: {} });

  try {
    const stories = await apiRequest(
      `/api/story-cards/${encodeURIComponent(storyCardId)}/stories/discover`,
      { method: "POST" }
    );
    await refreshStoryCardCache();
    renderCards();
    setStoryQueueState({
      status: "loaded",
      stories: Array.isArray(stories) ? stories : [],
      message: "",
      pendingUpdates: {},
    });
  } catch (error) {
    setStoryQueueState({
      status: "error",
      message: error.message || "Could not look for stories.",
    });
  }
};

const getStoryActionPayload = (story, action) => {
  if (action === "select" || action === "add_back") {
    return { isSelected: true, isSkipped: false, status: "selected" };
  }

  if (action === "skip") {
    return { isSkipped: true, isSelected: false, status: "skipped" };
  }

  if (action === "remove") {
    return { isSelected: false, status: story.isPinned ? "discovered" : "rotated_off" };
  }

  return { isPinned: !story.isPinned };
};

const applyStoryQueuePatch = (story, patch) => {
  const nextStory = { ...story, ...patch };
  if (patch.status) {
    nextStory.statusLabel = storyStatusLabels[patch.status] || story.statusLabel;
  }
  return nextStory;
};

const updateQueuedStoryControl = (storyId, action) => {
  if (!activeCardId || !storyId) return;

  const story = storyQueueState.stories.find((item) => item.id === storyId);
  if (!story) return;

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

  const updatedById = new Map(updatedStories.map((story) => [story.id, story]));
  setStoryQueueState({
    status: "loaded",
    message: "",
    stories: storyQueueState.stories.map((story) => updatedById.get(story.id) || story),
    pendingUpdates: {},
  });
};

const mergeStoryQueueUpdates = (updatedStories) => {
  const updates = Array.isArray(updatedStories) ? updatedStories : [updatedStories];
  const updatedById = new Map(updates.filter(Boolean).map((story) => [story.id, story]));

  setStoryQueueState({
    status: "loaded",
    message: "",
    stories: storyQueueState.stories.map((story) => updatedById.get(story.id) || story),
  });
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

const downloadSelectedStories = async () => {
  if (!activeCardId) return;

  const preview = getPlaylistPreview(getEditorStoryRules(), storyQueueState.stories);
  const storiesToBringHome = (preview.onYotoSoon || []).filter(isStoryReadyToBringHome);

  if (!storiesToBringHome.length) {
    setStoryQueueState({
      status: "loaded",
      message: "Pick a story first, then Feed Your Yoto can get it ready.",
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
      message: result.failed?.length ? "Some stories need help before they can get ready." : "",
      stories: Array.isArray(result.stories) ? result.stories : storyQueueState.stories,
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

const openEditor = (storyCard) => {
  activeCardId = storyCard.id;
  hideDeleteConfirmation();
  resetEditorSetupLock();

  dialogArt.className = "dialog-cover card-picture playlist-card-picture";
  dialogArt.innerHTML = getStoryCardArtMarkup(storyCard);
  dialogTitle.textContent = storyCard.name;
  dialogStatus.className = `status-pill status-${storyCard.statusType}`;
  dialogStatus.textContent = storyCard.status;
  dialogCrawl.textContent = `Next Check: ${getStoryCardNextCheckLabel(storyCard)}`;

  playlistName.value = storyCard.name;
  rssFeed.value = storyCard.podcastLink;
  populateEditorPlaylistOptions(storyCard);
  nextCrawl.value = storyCard.nextCheck || "";
  setFrequency(storyCard.updateRhythm);
  setLateFrequency(storyCard.lateCheckRhythm);
  setSwitch(storyCard.statusType === "live" || storyCard.statusType === "error");
  setStoryRules(storyCard);
  setEditorTab("stories");
  setStoriesSubtab("queue");
  setStoryQueueState({
    storyCardId: storyCard.id,
    status: "loading",
    message: "",
    stories: [],
    pendingUpdates: {},
  });

  backdrop.hidden = false;
  setModalLock();
  loadStoryQueue(storyCard.id, { discoverIfEmpty: true });
  window.setTimeout(() => editorTabs.find((tab) => tab.dataset.editorTab === "stories")?.focus(), 0);
};

const closeEditor = () => {
  hideDeleteConfirmation();
  resetEditorSetupLock();
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

  const selectedFrequency = frequencyButtons.find((button) =>
    button.classList.contains("is-selected")
  );
  const selectedLateFrequency = lateFrequencyButtons.find((button) =>
    button.classList.contains("is-selected")
  );
  const selectedYotoCard = availableYotoCards.find(
    (card) => card.id === yotoCard.value
  );
  const updateRhythm = selectedFrequency?.dataset.frequency || activeCard.updateRhythm;
  const previousText = setButtonBusy(saveCard, true, "Saving...");

  const storyRules = getEditorStoryRules();
  const updatePayload = {
    updateRhythm,
    lateCheckRhythm:
      updateRhythm === "manual"
        ? ""
        : selectedLateFrequency?.dataset.lateFrequency || activeCard.lateCheckRhythm,
    status: syncSwitch.classList.contains("is-on") ? "Updating" : "Taking a Break",
    statusType: syncSwitch.classList.contains("is-on") ? "live" : "paused",
    nextCheck: updateRhythm === "manual" ? "" : nextCrawl.value,
    newStoryBehavior: storyRules.newStoryBehavior,
    playlistLimit: storyRules.playlistLimit,
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
      dialogArt.innerHTML = getStoryCardArtMarkup(refreshedCard);
      dialogTitle.textContent = refreshedCard.name;
      dialogStatus.className = `status-pill status-${refreshedCard.statusType}`;
      dialogStatus.textContent = refreshedCard.status;
      dialogCrawl.textContent = `Next Check: ${getStoryCardNextCheckLabel(refreshedCard)}`;
      playlistName.value = refreshedCard.name;
      rssFeed.value = refreshedCard.podcastLink;
      populateEditorPlaylistOptions(refreshedCard);
      setStoryRules(refreshedCard);
      renderStoryQueue();
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

  setupTitle.textContent = "When should we look for new episodes?";
  setupStepContent.innerHTML = `
    <div class="setup-field-stack">
      <div>
        <p class="setup-label">Add a new episode</p>
        <div class="setup-choice-list">
          ${updateRhythmOptions
            .map(
              (option) => `
                <button class="setup-choice ${setupDraft.updateRhythm === option.value ? "is-selected" : ""}" type="button" data-update-rhythm="${escapeAttribute(option.value)}">
                  ${escapeHtml(option.label)}
                </button>
              `
            )
            .join("")}
        </div>
      </div>
      <div>
        <p class="setup-label">If the new episode is late</p>
        <div class="setup-choice-list">
          ${lateCheckRhythmOptions
            .map(
              (option) => `
                <button class="setup-choice ${setupDraft.lateCheckRhythm === option.value ? "is-selected" : ""}" type="button" data-late-check-rhythm="${escapeAttribute(option.value)}">
                  ${escapeHtml(option.label)}
                </button>
              `
            )
            .join("")}
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

  if (!setupDraft.updateRhythm) {
    return "Choose when this Story Card should check for episodes.";
  }

  if (setupDraft.updateRhythm !== "manual" && !setupDraft.lateCheckRhythm) {
    return "Choose what to do if the episode is late.";
  }

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
  if (setupDraft.updateRhythm === "manual") {
    return { label: "Only when I press check", value: "" };
  }

  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(19, 30, 0, 0);

  return {
    label: "Tomorrow at 7:30 PM",
    value: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate()
    ).padStart(2, "0")}T19:30`,
  };
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
      updateRhythm: setupDraft.updateRhythm,
      lateCheckRhythm: setupDraft.updateRhythm === "manual" ? "" : setupDraft.lateCheckRhythm,
      status: "Updating",
      statusType: "live",
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

frequencyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!requireAuth("Connect Yoto to change update settings.")) return;
    setFrequency(button.dataset.frequency);
  });
});

lateFrequencyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!requireAuth("Connect Yoto to change update settings.")) return;
    setLateFrequency(button.dataset.lateFrequency);
  });
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
  });
});

refreshStories.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to refresh stories.")) return;
  discoverStories(activeCardId);
});

storyQueueContent.addEventListener("click", (event) => {
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

  const actionButton = event.target.closest("[data-story-action]");
  if (!actionButton) return;
  if (!requireAuth("Connect Yoto to update the Story Queue.")) return;

  const storyItem = actionButton.closest("[data-story-id]");
  updateQueuedStoryControl(storyItem?.dataset.storyId || "", actionButton.dataset.storyAction);
});

syncSwitch.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to change update settings.")) return;
  setSwitch(!syncSwitch.classList.contains("is-on"));
});

pauseCard.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to take a break.")) return;
  setSwitch(false);
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

  const updateRhythmOption = event.target.closest("[data-update-rhythm]");
  if (updateRhythmOption) {
    setupDraft.updateRhythm = updateRhythmOption.dataset.updateRhythm;
    renderSetupStep();
    return;
  }

  const lateCheckOption = event.target.closest("[data-late-check-rhythm]");
  if (lateCheckOption) {
    setupDraft.lateCheckRhythm = lateCheckOption.dataset.lateCheckRhythm;
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
