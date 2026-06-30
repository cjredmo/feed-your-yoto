const appConfig = window.APP_CONFIG || {};
const yotoClientId = appConfig.yoto?.clientId || "";

if (!yotoClientId) {
  console.warn("Missing Yoto client ID. Check config.js.");
}

const cards = [
  {
    id: "story-station",
    name: "Story Station",
    status: "Live - syncing",
    statusType: "live",
    nextCrawl: "Jun 28, 2026, 7:30 PM",
    nextCrawlValue: "2026-06-28T19:30",
    rss: "https://example.com/story-station.xml",
    yotoCard: "Blue Make My Own card",
    frequency: "Daily",
    art: "art-cloud",
  },
  {
    id: "space-songs",
    name: "Space Songs",
    status: "Paused",
    statusType: "paused",
    nextCrawl: "Jun 30, 2026, 8:00 AM",
    nextCrawlValue: "2026-06-30T08:00",
    rss: "https://example.com/space-songs.xml",
    yotoCard: "Yellow Make My Own card",
    frequency: "Weekly",
    art: "art-space",
  },
  {
    id: "music-minute",
    name: "Music Minute",
    status: "Error - disconnected",
    statusType: "error",
    nextCrawl: "Jul 1, 2026, 6:45 PM",
    nextCrawlValue: "2026-07-01T18:45",
    rss: "https://example.com/music-minute.xml",
    yotoCard: "Pink Make My Own card",
    frequency: "Daily",
    art: "art-music",
  },
  {
    id: "rainbow-roundup",
    name: "Rainbow Roundup",
    status: "Not setup",
    statusType: "setup",
    nextCrawl: "Choose a date",
    nextCrawlValue: "",
    rss: "",
    yotoCard: "Blue Make My Own card",
    frequency: "Monthly",
    art: "art-rainbow",
  },
];

const cardGrid = document.querySelector("#cardGrid");
const backdrop = document.querySelector("#dialogBackdrop");
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
const pauseCard = document.querySelector("#pauseCard");
const syncSwitch = document.querySelector("#syncSwitch");
const switchStatus = document.querySelector("#switchStatus");
const frequencyButtons = Array.from(document.querySelectorAll(".segment"));

let activeCardId = cards[0].id;
let isAuthenticated = false;
let authPollTimer = null;
let yotoLoginPopup = null;

const coverShapes = `
  <span class="cover-shape shape-one"></span>
  <span class="cover-shape shape-two"></span>
  <span class="cover-shape shape-three"></span>
`;

const setModalLock = () => {
  const modalOpen = !backdrop.hidden || !authBackdrop.hidden;
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
    throw new Error(data.message || data.error || "Request failed.");
  }

  return data;
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
  authButton.textContent = "Login";
  authButton.classList.remove("is-signed-in");
  authButton.setAttribute("aria-label", "Login to Yoto");
  addCardButton.classList.add("is-locked-action");
  addCardButton.setAttribute("aria-disabled", "true");
  showAllButton.classList.add("is-locked-action");
  showAllButton.setAttribute("aria-disabled", "true");
};

const unlockFeatures = () => {
  document.body.classList.remove("auth-locked");
  authBanner.hidden = true;
  authButton.textContent = "Sign out";
  authButton.classList.add("is-signed-in");
  authButton.setAttribute("aria-label", "Sign out of Yoto");
  addCardButton.classList.remove("is-locked-action");
  addCardButton.removeAttribute("aria-disabled");
  showAllButton.classList.remove("is-locked-action");
  showAllButton.removeAttribute("aria-disabled");
};

const setAuthenticated = (authenticated) => {
  isAuthenticated = authenticated;

  if (isAuthenticated) {
    unlockFeatures();
  } else {
    lockFeatures();
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
  connectYotoButton.textContent = "Connect Yoto Account";
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

const requireAuth = (message = "Connect your Yoto account first.") => {
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

const formatCrawlDate = (value) => {
  if (!value) return "Choose a date";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Choose a date";

  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

function renderCards() {
  cardGrid.innerHTML = cards
    .map(
      (card) => `
        <button class="yoto-card ${isAuthenticated ? "" : "is-locked"}" type="button" data-card-id="${card.id}" aria-disabled="${!isAuthenticated}" aria-label="${card.name}, ${card.status}, next crawl ${card.nextCrawl}">
          <div class="card-picture ${card.art}" aria-hidden="true">
            ${coverShapes}
          </div>
          <h3 class="card-title">${card.name}</h3>
          <div class="card-meta">
            <span class="status-pill status-${card.statusType}">${card.status}</span>
            <div class="next-crawl">
              <span>Next crawl</span>
              ${card.nextCrawl}
            </div>
          </div>
        </button>
      `
    )
    .join("");
}

const setFrequency = (frequency) => {
  frequencyButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.frequency === frequency);
  });
};

const setSwitch = (isOn) => {
  syncSwitch.classList.toggle("is-on", isOn);
  syncSwitch.setAttribute("aria-pressed", String(isOn));
  switchStatus.textContent = isOn ? "On and watching" : "Off for now";
};

const openEditor = (card) => {
  activeCardId = card.id;

  dialogArt.className = `dialog-cover card-picture ${card.art}`;
  dialogArt.innerHTML = coverShapes;
  dialogTitle.textContent = card.name;
  dialogStatus.className = `status-pill status-${card.statusType}`;
  dialogStatus.textContent = card.status;
  dialogCrawl.textContent = `Next crawl: ${card.nextCrawl}`;

  playlistName.value = card.name;
  rssFeed.value = card.rss;
  yotoCard.value = card.yotoCard;
  nextCrawl.value = card.nextCrawlValue;
  setFrequency(card.frequency);
  setSwitch(card.statusType === "live" || card.statusType === "error");

  backdrop.hidden = false;
  setModalLock();
  window.setTimeout(() => playlistName.focus(), 0);
};

const closeEditor = () => {
  backdrop.hidden = true;
  setModalLock();
};

const saveActiveCard = () => {
  if (!requireAuth("Connect your Yoto account to save card changes.")) return;

  const activeCard = cards.find((card) => card.id === activeCardId);
  if (!activeCard) return;

  const selectedFrequency = frequencyButtons.find((button) =>
    button.classList.contains("is-selected")
  );

  activeCard.name = playlistName.value || activeCard.name;
  activeCard.rss = rssFeed.value;
  activeCard.yotoCard = yotoCard.value;
  activeCard.nextCrawlValue = nextCrawl.value;
  activeCard.nextCrawl = formatCrawlDate(nextCrawl.value);
  activeCard.frequency = selectedFrequency?.dataset.frequency || activeCard.frequency;
  activeCard.status = syncSwitch.classList.contains("is-on") ? "Live - syncing" : "Paused";
  activeCard.statusType = syncSwitch.classList.contains("is-on") ? "live" : "paused";

  renderCards();
  closeEditor();
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
    connectYotoButton.textContent = "Connect Yoto Account";
  }
};

const resetYotoAuth = async () => {
  stopAuthPolling();
  closeYotoLoginPopup();
  closeEditor();

  try {
    await apiRequest("/api/auth/reset", { method: "POST" });
  } catch (error) {
    console.warn("Could not reset Yoto auth on the server.", error);
  }

  setAuthenticated(false);
  openAuthModal("Signed out. Connect your Yoto account to keep going.");
};

const initializeAuth = async () => {
  const status = await checkAuthStatus();

  if (!status.authenticated) {
    openAuthModal();
  }
};

cardGrid.addEventListener("click", (event) => {
  const cardButton = event.target.closest(".yoto-card");
  if (!cardButton) return;
  if (!requireAuth("Connect your Yoto account to manage this card.")) return;

  const card = cards.find((item) => item.id === cardButton.dataset.cardId);
  if (card) openEditor(card);
});

frequencyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!requireAuth("Connect your Yoto account to change auto-feed settings.")) return;
    setFrequency(button.dataset.frequency);
  });
});

syncSwitch.addEventListener("click", () => {
  if (!requireAuth("Connect your Yoto account to change sync settings.")) return;
  setSwitch(!syncSwitch.classList.contains("is-on"));
});

pauseCard.addEventListener("click", () => {
  if (!requireAuth("Connect your Yoto account to pause feeds.")) return;
  setSwitch(false);
});

saveCard.addEventListener("click", saveActiveCard);
closeDialog.addEventListener("click", closeEditor);
addCardButton.addEventListener("click", () => {
  if (!requireAuth("Connect your Yoto account to add a card.")) return;
  openEditor(cards[cards.length - 1]);
});
showAllButton.addEventListener("click", () => {
  requireAuth("Connect your Yoto account to see every card.");
});

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

authBackdrop.addEventListener("click", (event) => {
  if (event.target === authBackdrop) closeAuthModal();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (!authBackdrop.hidden) {
    closeAuthModal();
    return;
  }

  if (!backdrop.hidden) closeEditor();
});

lockFeatures();
renderCards();
initializeAuth();
