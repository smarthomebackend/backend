const axios  = require('axios');
const moment = require('moment');
const cron   = require('node-cron');
const settingsSvc = require('./settings');
const calendar    = require('./calendar');

// ── Location ───────────────────────────────────────────────────────────────────
const LAT = 41.722034;  // Wellsboro, PA
const LNG = -77.263969;
const TZ  = 'America/New_York';

const ASTRO_URL = `https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LNG}&formatted=0`;

let eveningDark  = null;
let morningLight = null;

// Shared cron options
const CRON_OPTS = { scheduled: true, timezone: TZ };

// ── Core fetch ──────────────────────────────────────────────────────────────────
async function fetchAstroData() {
  try {
    const { data } = await axios.get(ASTRO_URL, { timeout: 10000 });
    const { sunset, sunrise, astronomical_twilight_end, astronomical_twilight_begin } = data.results;

    const now = moment();
    eveningDark  = moment.utc(sunset).local();
    morningLight = moment.utc(sunrise).local();

    // If we've passed today's sunset, advance sunrise to tomorrow
    if (now.isAfter(eveningDark)) morningLight.add(1, 'day');

    const astroEnd   = moment.utc(astronomical_twilight_end).local();
    const astroBegin = moment.utc(astronomical_twilight_begin).local();
    if (now.isAfter(astroEnd)) astroBegin.add(1, 'day');

    await settingsSvc.updateSetting('stargazingStart', astroEnd.format('h:mm'));
    await settingsSvc.updateSetting('stargazingEnd',   astroBegin.format('h:mm'));
    await settingsSvc.updateSetting('sunset',  eveningDark.format('h:mm'));
    await settingsSvc.updateSetting('sunrise', morningLight.format('h:mm'));

    console.log(`[Astro] Sunrise: ${morningLight.format('h:mm A')}  Sunset: ${eveningDark.format('h:mm A')}`);
  } catch (err) {
    console.error('[Astro] Error fetching data:', err.message);
  }
}

function isAfterSunset() {
  if (!morningLight || !eveningDark) return false;
  return !moment().isBetween(morningLight, eveningDark);
}

// ── Weather helper ──────────────────────────────────────────────────────────────
async function getTempFAt7am(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LNG}` +
    `&hourly=temperature_2m&temperature_unit=fahrenheit` +
    `&timezone=${encodeURIComponent(TZ)}` +
    `&start_date=${y}-${m}-${d}&end_date=${y}-${m}-${d}`;

  // Hard 10s timeout — this is a background job, never let it hang
  const { data } = await axios.get(url, { timeout: 10000 });
  const times = data?.hourly?.time || [];
  const temps = data?.hourly?.temperature_2m || [];
  const target = `${y}-${m}-${d}T07:00`;
  const idx = times.indexOf(target);
  if (idx === -1) throw new Error(`No 07:00 reading for ${target}`);
  return temps[idx];
}

// ── Car start helper ────────────────────────────────────────────────────────────
async function maybeStartCar(tag) {
  const now = new Date();
  try {
    if (!calendar.shouldRunToday(now)) {
      console.log(`[AutoStart] Skip (${tag}): not an eligible workday.`);
      return;
    }
    const tempF = await getTempFAt7am(now);
    const triggers = tempF < 60 || tempF > 80;
    if (!triggers) {
      console.log(`[AutoStart] Skip (${tag}): temp ${tempF}°F is comfortable (60–80°F).`);
      return;
    }
    console.log(`[AutoStart] Conditions met (${tag}). Temp ${tempF}°F. Queuing car start.`);
    const { queueCommand } = require('./vehicleQueue');
    // Fire-and-forget — do NOT await this. queueCommand waits up to 35s for the
    // car to respond, which exceeds Render's 30s request timeout and causes a 504.
    // The cron callback returns immediately; the promise resolves in the background.
    queueCommand('SUBURBAN', 'start').then(result => {
      if (result.ok) {
        console.log(`[AutoStart] Car started successfully (${tag}).`);
      } else if (result.timeout) {
        console.warn(`[AutoStart] Car did not respond in time (${tag}). May not be in range.`);
      } else {
        console.warn(`[AutoStart] Car start failed (${tag}): ${result.message}`);
      }
    }).catch(err => {
      console.error(`[AutoStart] queueCommand error (${tag}):`, err.message);
    });
  } catch (err) {
    // Must catch everything — a cron callback must never throw an unhandled rejection
    console.error(`[AutoStart] Error (${tag}):`, err.message);
  }
}

// ── Cron jobs ───────────────────────────────────────────────────────────────────
function scheduleCronJobs() {
  // Refresh astro data + SmartThings token at midnight
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Midnight maintenance');
    try {
      await fetchAstroData();
      const smartthings = require('./smartthings');
      await smartthings.refreshToken();
    } catch (err) {
      console.error('[Cron] Midnight maintenance error:', err.message);
    }
  }, CRON_OPTS);

  // Auto-start car at 7:00 AM — await so unhandled rejections can't escape
//   cron.schedule('0 7 * * *', async () => {
//     console.log('[Cron] 07:00 triggered');
//     await maybeStartCar('07:00');
//   }, CRON_OPTS);

//   // Retry at 7:11 AM
//   cron.schedule('11 7 * * *', async () => {
//     console.log('[Cron] 07:11 triggered');
//     await maybeStartCar('07:11');
//   }, CRON_OPTS);
}

// ── Ping keepalive ───────────────────────────────────────────────────────────────
// Keeps Render from spinning down. Always hits /ping specifically — it's
// a one-liner that returns Date.now(), no DB, no downstream calls, never slow.
// That way a slow lights/sensor request can't cause a ping 504.
function schedulePing() {
  const rawUrl = process.env.PING_URL;
  if (!rawUrl) {
    console.log('[Ping] PING_URL not set, skipping.');
    return;
  }

  const url = rawUrl.replace(/\/$/, '') + '/ping';

  const ping = () =>
    axios.get(url, { timeout: 8000 })
      .then(r => console.log('[Ping] ok', r.data))
      .catch(err => {
        console.warn('[Ping] failed:', err.message);
        // Back off 5s and retry once quietly — don't cascade
        setTimeout(() => axios.get(url, { timeout: 8000 }).catch(() => {}), 5000);
      });

  cron.schedule('*/10 * * * *', ping, CRON_OPTS);
  ping();
}

async function init() {
  await fetchAstroData();
  scheduleCronJobs();
  schedulePing();
}

module.exports = { init, fetchAstroData, isAfterSunset, getTempFAt7am, LAT, LNG, TZ };
