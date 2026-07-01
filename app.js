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
const frequencyButtons = Array.from(document.querySelectorAll("[data-frequency]"));
const lateFrequencyButtons = Array.from(document.querySelectorAll("[data-late-frequency]"));

let activeCardId = "";
let isAuthenticated = false;
let authPollTimer = null;
let yotoLoginPopup = null;
let setupStep = 0;
let setupDraft = getFreshSetupDraft();
let yotoCardsLoadId = 0;

function getFreshSetupDraft() {
  return {
    yotoCardId: "",
    yotoCardTitle: "",
    yotoCardImageUrl: null,
    name: "",
    podcastLink: "",
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

const loadStoryCards = async () => {
  try {
    const savedStoryCards = await apiRequest("/api/story-cards");
    storyCards = Array.isArray(savedStoryCards) ? savedStoryCards : [];
    activeCardId = storyCards[0]?.id || "";
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
  storyCard?.yotoPlaylistTitle || storyCard?.yotoCardName || "Yoto Playlist";

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

const chooseDefaultSetupPlaylist = () => {
  const selectedStillAvailable = getRegularYotoPlaylists().some(
    (card) => card.id === setupDraft.yotoCardId
  );

  if (!selectedStillAvailable) {
    setSetupSelectedCard(getRegularYotoPlaylists()[0] || null);
  }
};

const renderPlaylistTile = (card, { selectable }) => {
  const title = getYotoCardTitle(card);

  if (!selectable) {
    return `
      <article class="setup-option playlist-option is-disabled" aria-disabled="true">
        ${getPlaylistArtMarkup(card)}
        <span class="playlist-copy">
          <strong>${escapeHtml(title)}</strong>
          <span>Streaming playlist</span>
        </span>
      </article>
    `;
  }

  return `
    <button class="setup-option playlist-option ${setupDraft.yotoCardId === card.id ? "is-selected" : ""}" type="button" data-yoto-card-id="${escapeAttribute(card.id)}">
      ${getPlaylistArtMarkup(card)}
      <span class="playlist-copy">
        <strong>${escapeHtml(title)}</strong>
        <span>Yoto playlist</span>
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
        <p>Choose a Yoto playlist and add a podcast link to get started.</p>
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
              <span>Yoto Playlist</span>
              <strong>${escapeHtml(getStoryCardPlaylistTitle(storyCard))}</strong>
            </div>
            <div>
              <span>Podcast Link</span>
              <strong>${escapeHtml(getPodcastPreview(storyCard.podcastLink))}</strong>
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
  const options = getRegularYotoPlaylists().map((card) => ({
    id: card.id,
    title: getYotoCardTitle(card),
  }));

  if (currentId && !options.some((option) => option.id === currentId)) {
    options.unshift({
      id: currentId,
      title: currentTitle,
    });
  }

  yotoCard.innerHTML = options.length
    ? options
        .map(
          (option) =>
            `<option value="${escapeAttribute(option.id)}">${escapeHtml(option.title)}</option>`
        )
        .join("")
    : `<option value="${escapeAttribute(currentId)}">${escapeHtml(currentTitle)}</option>`;
  yotoCard.value = currentId || options[0]?.id || "";
};

const openEditor = (storyCard) => {
  activeCardId = storyCard.id;
  hideDeleteConfirmation();

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

  backdrop.hidden = false;
  setModalLock();
  window.setTimeout(() => playlistName.focus(), 0);
};

const closeEditor = () => {
  hideDeleteConfirmation();
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

  try {
    await jsonRequest(`/api/story-cards/${encodeURIComponent(activeCard.id)}`, "PUT", {
      name: playlistName.value.trim(),
      podcastLink: rssFeed.value.trim(),
      yotoPlaylistId: selectedYotoCard?.id || activeCard.yotoPlaylistId || activeCard.yotoCardId,
      yotoPlaylistTitle: selectedYotoCard
        ? getYotoCardTitle(selectedYotoCard)
        : getStoryCardPlaylistTitle(activeCard),
      yotoPlaylistImageUrl: selectedYotoCard?.imageUrl || getStoryCardPlaylistImageUrl(activeCard),
      updateRhythm,
      lateCheckRhythm:
        updateRhythm === "manual"
          ? ""
          : selectedLateFrequency?.dataset.lateFrequency || activeCard.lateCheckRhythm,
      status: syncSwitch.classList.contains("is-on") ? "Updating" : "Taking a Break",
      statusType: syncSwitch.classList.contains("is-on") ? "live" : "paused",
      nextCheck: updateRhythm === "manual" ? "" : nextCrawl.value,
    });
    await loadStoryCards();
    closeEditor();
  } catch (error) {
    dialogCrawl.textContent = error.message || "Could not save this Story Card.";
  } finally {
    saveCard.disabled = false;
    saveCard.textContent = previousText;
  }
};

const setSetupSelectedCard = (card) => {
  if (!isCompatibleYotoPlaylist(card)) {
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
    message: "Loading your Yoto playlists...",
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
          : "Could not load your Yoto playlists. Try reconnecting Yoto.",
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
  setupNextButton.disabled =
    setupStep === 0 &&
    (yotoCardsLoadState.status !== "loaded" || !setupDraft.yotoCardId);
  saveStoryCardButton.hidden = setupStep !== 2 || !isSetupDraftComplete();

  document.querySelectorAll("[data-step-indicator]").forEach((indicator) => {
    indicator.classList.toggle("is-active", Number(indicator.dataset.stepIndicator) === setupStep);
  });

  if (setupStep === 0) {
    setupTitle.textContent = "Pick a Story Playlist";
    if (yotoCardsLoadState.status === "idle" || yotoCardsLoadState.status === "loading") {
      setupStepContent.innerHTML = `
        <p class="setup-helper">Loading your Yoto playlists...</p>
        ${renderPlaylistRefreshButton()}
      `;
      return;
    }

    if (yotoCardsLoadState.status === "unauthenticated") {
      setupStepContent.innerHTML = `
        <p class="setup-helper">Connect Yoto before choosing a card.</p>
        ${renderPlaylistRefreshButton()}
      `;
      return;
    }

    if (yotoCardsLoadState.status === "error") {
      setupStepContent.innerHTML = `
        <p class="setup-helper">${escapeHtml(yotoCardsLoadState.message)}</p>
        ${renderPlaylistRefreshButton()}
      `;
      return;
    }

    const regularPlaylists = getRegularYotoPlaylists();
    const streamingPlaylists = getStreamingYotoPlaylists();

    if (!regularPlaylists.length && !streamingPlaylists.length) {
      setupStepContent.innerHTML = `
        <p class="setup-helper">No compatible playlists found.</p>
        ${renderPlaylistRefreshButton()}
        <p class="setup-note">Streaming playlists are grouped separately because this app manages uploaded Yoto audio.</p>
      `;
      return;
    }

    setupStepContent.innerHTML = `
      <p class="setup-helper">Choose the Yoto playlist this app should keep updated. You can link that playlist to a physical Make Your Own card in the Yoto app.</p>
      ${renderPlaylistRefreshButton()}
      ${
        regularPlaylists.length
          ? `
            <section class="playlist-group" aria-labelledby="regularPlaylistsHeading">
              <h3 id="regularPlaylistsHeading" class="playlist-group-title">Regular Yoto Playlists</h3>
              <div class="setup-option-grid">
                ${regularPlaylists.map((card) => renderPlaylistTile(card, { selectable: true })).join("")}
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
                ${streamingPlaylists.map((card) => renderPlaylistTile(card, { selectable: false })).join("")}
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
  if (!setupDraft.yotoCardId) {
    return "Choose a Story Playlist first.";
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
  if (setupStep === 0 && !setupDraft.yotoCardId) {
    return "Choose a Story Playlist first.";
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
      name: setupDraft.name.trim(),
      podcastLink: setupDraft.podcastLink.trim(),
      yotoPlaylistId: selectedYotoCard?.id || setupDraft.yotoCardId,
      yotoPlaylistTitle: setupDraft.yotoCardTitle || getYotoCardTitle(selectedYotoCard),
      yotoPlaylistImageUrl: setupDraft.yotoCardImageUrl || selectedYotoCard?.imageUrl || null,
      updateRhythm: setupDraft.updateRhythm,
      lateCheckRhythm: setupDraft.updateRhythm === "manual" ? "" : setupDraft.lateCheckRhythm,
      status: "Updating",
      statusType: "live",
      nextCheck: timing.value,
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

syncSwitch.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to change update settings.")) return;
  setSwitch(!syncSwitch.classList.contains("is-on"));
});

pauseCard.addEventListener("click", () => {
  if (!requireAuth("Connect Yoto to take a break.")) return;
  setSwitch(false);
});

deleteCard.addEventListener("click", showDeleteConfirmation);
cancelDeleteCard.addEventListener("click", hideDeleteConfirmation);
confirmDeleteCard.addEventListener("click", deleteActiveCard);

setupStepContent.addEventListener("click", (event) => {
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
  if (event.target.id === "setupStoryCardName") {
    setupDraft.name = event.target.value;
  }

  if (event.target.id === "setupPodcastLink") {
    setupDraft.podcastLink = event.target.value;
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
