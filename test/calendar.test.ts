import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarAt, DAY_MS, SEASON_DAYS, phaseAt } from '../src/core/calendar.ts';

test('一天的四个时段边界正确', () => {
  assert.equal(phaseAt(0.1), 'night');
  assert.equal(phaseAt(0.25), 'dawn');
  assert.equal(phaseAt(0.5), 'day');
  assert.equal(phaseAt(0.75), 'dusk');
  assert.equal(phaseAt(0.9), 'night');
});

test('季节按天数循环，每季 SEASON_DAYS 天', () => {
  assert.equal(calendarAt(0).season, 'spring');
  assert.equal(calendarAt(SEASON_DAYS * DAY_MS).season, 'summer');
  assert.equal(calendarAt(4 * SEASON_DAYS * DAY_MS).season, 'spring');
  assert.equal(calendarAt(SEASON_DAYS * DAY_MS).seasonDay, 1);
});

test('正午最亮，午夜最暗', () => {
  const noon = calendarAt(DAY_MS / 2);
  const midnight = calendarAt(0);
  assert.ok(noon.daylight > 0.99);
  assert.ok(midnight.daylight < 0.01);
});
