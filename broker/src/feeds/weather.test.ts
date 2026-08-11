import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weatherLine, weatherUrl } from './weather.ts';

const BODY = {
  current: { temperature_2m: 29.4, weather_code: 0 },
  hourly: {
    time: ['2026-08-11T14:00', '2026-08-11T15:00', '2026-08-11T16:00'],
    precipitation_probability: [10, 80, 20],
  },
};

test('renders a short line: temperature, sky, and the rain hour if there is one', () => {
  assert.equal(weatherLine(BODY), '29°C, clear; rain likely 15:00.');
});

test('no likely rain means no rain clause', () => {
  const dry = { ...BODY, hourly: { ...BODY.hourly, precipitation_probability: [5, 10, 5] } };
  assert.equal(weatherLine(dry), '29°C, clear.');
});

test('weather codes map to words a person would use', () => {
  assert.match(weatherLine({ ...BODY, current: { temperature_2m: 25, weather_code: 61 } })!, /rain/i);
  assert.match(weatherLine({ ...BODY, current: { temperature_2m: 25, weather_code: 3 } })!, /overcast/i);
  assert.match(weatherLine({ ...BODY, current: { temperature_2m: 25, weather_code: 95 } })!, /storm/i);
});

test('an unusable body is null, so the digest simply drops the line', () => {
  assert.equal(weatherLine({}), null);
  assert.equal(weatherLine(null), null);
  assert.equal(weatherLine({ current: {} }), null);
});

test('the URL asks for exactly the two things the line needs — and no API key', () => {
  const url = weatherUrl(18.48, -69.93);
  assert.match(url, /latitude=18\.48/);
  assert.match(url, /longitude=-69\.93/);
  assert.match(url, /current=temperature_2m,weather_code/);
  assert.equal(/key|token|appid/i.test(url), false);
});
