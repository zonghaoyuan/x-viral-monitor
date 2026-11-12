import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Local addition: leaderboard sort modes + age / reply filters.
const source = readFileSync(resolve(process.cwd(), 'content.js'), 'utf8');
const start = source.indexOf('function sortAndFilterLeaderboard(');
const end = source.indexOf('\nfunction formatLbAge(', start);
const makeSorter = (lbSort) => Function('lbSort', `${source.slice(start, end)}; return sortAndFilterLeaderboard;`)(lbSort);

const now = Date.now();
const hoursAgo = (h) => now - h * 3600000;
const entries = [
  { id: 'old-fast', velocity: 9000, replies: 300, createdMs: hoursAgo(10) },
  { id: 'new-quiet', velocity: 3000, replies: 2, createdMs: hoursAgo(0.5) },
  { id: 'new-busy', velocity: 5000, replies: 80, createdMs: hoursAgo(1) },
  { id: 'mid-quiet', velocity: 1000, replies: 2, createdMs: hoursAgo(3) },
];
const ids = (list) => list.map((e) => e.id);

it('sorts by velocity, newest first, or fewest replies', () => {
  expect(ids(makeSorter({ mode: 'velocity', maxAgeHours: null, maxReplies: null })(entries)))
    .toEqual(['old-fast', 'new-busy', 'new-quiet', 'mid-quiet']);
  expect(ids(makeSorter({ mode: 'newest', maxAgeHours: null, maxReplies: null })(entries)))
    .toEqual(['new-quiet', 'new-busy', 'mid-quiet', 'old-fast']);
  // Ties on reply count fall back to the faster post.
  expect(ids(makeSorter({ mode: 'replies', maxAgeHours: null, maxReplies: null })(entries)))
    .toEqual(['new-quiet', 'mid-quiet', 'new-busy', 'old-fast']);
});

it('filters by post age and reply count, and treats empty limits as no limit', () => {
  expect(ids(makeSorter({ mode: 'velocity', maxAgeHours: 2, maxReplies: 20 })(entries)))
    .toEqual(['new-quiet']);
  expect(ids(makeSorter({ mode: 'velocity', maxAgeHours: 2, maxReplies: null })(entries)))
    .toEqual(['new-busy', 'new-quiet']);
  expect(ids(makeSorter({ mode: 'velocity', maxAgeHours: null, maxReplies: 0 })(entries)))
    .toEqual([]);
});
