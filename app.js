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
const saveCard = document.querySelector("#saveCard");
const pauseCard = document.querySelector("#pauseCard");
const syncSwitch = document.querySelector("#syncSwitch");
const switchStatus = document.querySelector("#switchStatus");
const frequencyButtons = Array.from(document.querySelectorAll(".segment"));

let activeCardId = cards[0].id;

const coverShapes = `
  <span class="cover-shape shape-one"></span>
  <span class="cover-shape shape-two"></span>
  <span class="cover-shape shape-three"></span>
`;

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

const renderCards = () => {
  cardGrid.innerHTML = cards
    .map(
      (card) => `
        <button class="yoto-card" type="button" data-card-id="${card.id}" aria-label="${card.name}, ${card.status}, next crawl ${card.nextCrawl}">
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
};

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
  document.body.classList.add("dialog-open");
  window.setTimeout(() => playlistName.focus(), 0);
};

const closeEditor = () => {
  backdrop.hidden = true;
  document.body.classList.remove("dialog-open");
};

const saveActiveCard = () => {
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

cardGrid.addEventListener("click", (event) => {
  const cardButton = event.target.closest(".yoto-card");
  if (!cardButton) return;

  const card = cards.find((item) => item.id === cardButton.dataset.cardId);
  if (card) openEditor(card);
});

frequencyButtons.forEach((button) => {
  button.addEventListener("click", () => setFrequency(button.dataset.frequency));
});

syncSwitch.addEventListener("click", () => {
  setSwitch(!syncSwitch.classList.contains("is-on"));
});

pauseCard.addEventListener("click", () => {
  setSwitch(false);
});

saveCard.addEventListener("click", saveActiveCard);
closeDialog.addEventListener("click", closeEditor);
addCardButton.addEventListener("click", () => openEditor(cards[cards.length - 1]));

backdrop.addEventListener("click", (event) => {
  if (event.target === backdrop) closeEditor();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !backdrop.hidden) closeEditor();
});

renderCards();
