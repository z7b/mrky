/**
 * Mrky Local Video Player Controller
 * Handles drag and drop file parsing, SRT loading, subtitle time synchronization,
 * and renders interactive subtitles with translation support.
 */
import { parseSRT, getActiveCue } from '../shared/srt-parser.js';
import { analyzeText } from '../shared/nlp-processor.js';
import { getKnownWordsSet } from '../shared/db.js';
import { renderSubtitles, clearOverlay, initOverlay } from '../content/overlay-renderer.js';
import { initTooltip } from '../content/tooltip.js';

let subtitleCues = [];
let knownWords = new Set();
let videoFile = null;
let subtitleFile = null;

document.addEventListener('DOMContentLoaded', async () => {
  // Load database known words list
  knownWords = await getKnownWordsSet();

  // Initialize UI systems
  initOverlay();
  initTooltip();

  // Setup DOM Elements
  const dropzone = document.getElementById('dropzone');
  const videoInput = document.getElementById('video-file-input');
  const subtitleInput = document.getElementById('subtitle-file-input');
  const videoEl = document.getElementById('local-video');
  const btnBack = document.getElementById('btn-back');

  // Drag and Drop Events
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');

    const files = Array.from(e.dataTransfer.files);
    handleDroppedFiles(files);
  });

  // Native Inputs Change
  videoInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      videoFile = e.target.files[0];
      checkAndLaunch();
    }
  });

  subtitleInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      subtitleFile = e.target.files[0];
      checkAndLaunch();
    }
  });

  // Subtitle Synchronization Loop
  videoEl.addEventListener('timeupdate', handleTimeUpdate);

  // Back Button Event
  btnBack.addEventListener('click', () => {
    // Stop playback
    videoEl.pause();
    videoEl.src = '';
    subtitleCues = [];
    clearOverlay();

    // Toggle view
    document.getElementById('player-container').classList.add('hidden');
    dropzone.classList.remove('hidden');
  });
});

/**
 * Identify and categorize files dropped into the zone.
 * @param {File[]} files
 */
function handleDroppedFiles(files) {
  files.forEach(file => {
    if (file.type.startsWith('video/') || file.name.endsWith('.mp4') || file.name.endsWith('.mkv') || file.name.endsWith('.webm')) {
      videoFile = file;
    } else if (file.name.endsWith('.srt')) {
      subtitleFile = file;
    }
  });

  checkAndLaunch();
}

/**
 * Launch the player if video file is loaded. Subtitles are optional but highly recommended.
 */
function checkAndLaunch() {
  if (!videoFile) return;

  const dropzone = document.getElementById('dropzone');
  const playerContainer = document.getElementById('player-container');
  const videoEl = document.getElementById('local-video');
  const titleEl = document.getElementById('video-title');

  titleEl.textContent = videoFile.name;

  // Set local video stream
  videoEl.src = URL.createObjectURL(videoFile);
  videoEl.controls = true;

  // Load SRT Subtitles if selected
  if (subtitleFile) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const rawText = e.target.result;
      subtitleCues = parseSRT(rawText);
      console.log(`[Mrky Player] Loaded ${subtitleCues.length} subtitles cues.`);
    };
    reader.readAsText(subtitleFile);
  }

  // Toggle View
  dropzone.classList.add('hidden');
  playerContainer.classList.remove('hidden');
  videoEl.play();
}

let lastCueIndex = -1;

/**
 * Handles video playback ticks and matches subtitle timecodes to render color coding.
 */
function handleTimeUpdate(e) {
  const video = e.target;
  const rect = video.getBoundingClientRect();

  if (subtitleCues.length === 0) return;

  const activeCue = getActiveCue(subtitleCues, video.currentTime);

  if (!activeCue) {
    clearOverlay();
    lastCueIndex = -1;
    return;
  }

  // Avoid processing the same cue on multiple updates
  if (activeCue.index === lastCueIndex) {
    // Still need to update layout position on resize
    return;
  }
  lastCueIndex = activeCue.index;

  // Tag sentence text and render custom overlay
  const analyzed = analyzeText(activeCue.text, knownWords);
  renderSubtitles(analyzed, activeCue.text, rect);
}
