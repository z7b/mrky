/**
 * Mrky SRT Subtitle Parser
 * Parses .srt subtitle files into a structured array of cues.
 * Used by the Local Video Player feature.
 */

/**
 * Parse an SRT file string into an array of subtitle cues.
 * @param {string} srtContent - Raw .srt file content
 * @returns {Array<{index: number, startTime: number, endTime: number, text: string}>}
 */
export function parseSRT(srtContent) {
  const cues = [];

  // Normalize line endings
  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  // Split into blocks separated by blank lines
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    // Line 1: Cue index (e.g., "1")
    const index = parseInt(lines[0], 10);
    if (isNaN(index)) continue;

    // Line 2: Timecodes (e.g., "00:01:23,456 --> 00:01:25,789")
    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/
    );
    if (!timeMatch) continue;

    const startTime = parseTimecode(timeMatch[1]);
    const endTime = parseTimecode(timeMatch[2]);

    // Lines 3+: Subtitle text (may span multiple lines)
    const text = lines
      .slice(2)
      .join(' ')
      .replace(/<[^>]+>/g, '') // Strip HTML tags (some SRT files have them)
      .replace(/\{[^}]+\}/g, '') // Strip SSA/ASS style tags
      .trim();

    if (text) {
      cues.push({ index, startTime, endTime, text });
    }
  }

  return cues;
}

/**
 * Convert an SRT timecode string to seconds.
 * @param {string} tc - Timecode like "01:23:45,678" or "01:23:45.678"
 * @returns {number} Time in seconds
 */
function parseTimecode(tc) {
  // Normalize comma to period
  const normalized = tc.replace(',', '.');
  const parts = normalized.split(':');

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format seconds to a display-friendly timecode (MM:SS).
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Find the active subtitle cue at a given time.
 * @param {Array} cues - Parsed subtitle cues
 * @param {number} currentTime - Current video time in seconds
 * @returns {Object|null} The active cue, or null if none
 */
export function getActiveCue(cues, currentTime) {
  for (const cue of cues) {
    if (currentTime >= cue.startTime && currentTime <= cue.endTime) {
      return cue;
    }
  }
  return null;
}
