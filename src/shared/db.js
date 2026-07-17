import Dexie from 'dexie';

// Check if we are running in a content script (web page context)
const isContentScript = typeof window !== 'undefined' && window.location.protocol.startsWith('http');

let db = null;

if (!isContentScript) {
  db = new Dexie('MrkyDB');
  db.version(1).stores({
    cards: '++id, word, translation, pos, sentence, contextUrl, createdAt, nextReview, interval, ease',
    knownWords: '++id, &word',
    settings: 'key',
  });
}

function proxyCall(method, ...args) {
  if (!isContentScript) {
    throw new Error('proxyCall should only be used in content scripts');
  }
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) {
        throw new Error('Extension context invalidated.');
      }
      chrome.runtime.sendMessage({ type: 'DB_PROXY', method, args }, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || '';
          if (errMsg.includes('context invalidated') || errMsg.includes('invoking')) {
            return resolve(getDefaultFallback(method));
          }
          return reject(chrome.runtime.lastError);
        }
        if (response && response.error) {
          return reject(new Error(response.error));
        }
        resolve(response ? response.result : undefined);
      });
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('context invalidated') || errMsg.includes('invoking')) {
        // Graceful degradation when extension is updated/reloaded
        return resolve(getDefaultFallback(method));
      }
      reject(err);
    }
  });
}

function getDefaultFallback(method) {
  if (method === 'getKnownWordsSet') return new Set();
  if (method === 'getAllCards' || method === 'getDueCards') return [];
  if (method === 'getKnownWordCount') return 0;
  return undefined;
}

export async function addCard(card) {
  if (isContentScript) return proxyCall('addCard', card);
  return db.cards.add({
    ...card,
    createdAt: Date.now(),
    nextReview: Date.now(),
    interval: 1,
    ease: 2.5,
  });
}

export async function getAllCards() {
  if (isContentScript) return proxyCall('getAllCards');
  return db.cards.toArray();
}

export async function getDueCards() {
  if (isContentScript) return proxyCall('getDueCards');
  const now = Date.now();
  return db.cards.where('nextReview').belowOrEqual(now).toArray();
}

export async function reviewCard(id, quality) {
  if (isContentScript) return proxyCall('reviewCard', id, quality);
  const card = await db.cards.get(id);
  if (!card) return;

  let { interval, ease } = card;

  if (quality < 3) {
    interval = 1;
  } else {
    if (interval === 1) {
      interval = 3;
    } else if (interval === 3) {
      interval = 7;
    } else {
      interval = Math.round(interval * ease);
    }
    ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  }

  const nextReview = Date.now() + interval * 24 * 60 * 60 * 1000;
  await db.cards.update(id, { interval, ease, nextReview });
}

export async function deleteCard(id) {
  if (isContentScript) return proxyCall('deleteCard', id);
  return db.cards.delete(id);
}

export async function getCardCount() {
  if (isContentScript) return proxyCall('getCardCount');
  return db.cards.count();
}

export async function markAsKnown(word) {
  if (isContentScript) return proxyCall('markAsKnown', word);
  const lower = word.toLowerCase().trim();
  const existing = await db.knownWords.where('word').equals(lower).first();
  if (!existing) {
    await db.knownWords.add({ word: lower });
  }
}

export async function isKnown(word) {
  if (isContentScript) return proxyCall('isKnown', word);
  const lower = word.toLowerCase().trim();
  const result = await db.knownWords.where('word').equals(lower).first();
  return !!result;
}

export async function getKnownWordsSet() {
  if (isContentScript) {
    const arr = await proxyCall('getKnownWordsSet');
    return new Set(arr);
  }
  const all = await db.knownWords.toArray();
  return new Set(all.map(w => w.word));
}

export async function getKnownWordCount() {
  if (isContentScript) return proxyCall('getKnownWordCount');
  return db.knownWords.count();
}

export async function getSetting(key, defaultValue = null) {
  if (isContentScript) return proxyCall('getSetting', key, defaultValue);
  const row = await db.settings.get(key);
  return row ? row.value : defaultValue;
}

export async function setSetting(key, value) {
  if (isContentScript) return proxyCall('setSetting', key, value);
  await db.settings.put({ key, value });
}

export default db;
