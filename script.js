(() => {
  "use strict";

  const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  const REQUEST_TIMEOUT_MS = 10000;
  const STORAGE_KEY = "weather:lastCity";

  // ---- DOM --------------------------------------------------------------

  const form = document.getElementById("search-form");
  const input = document.getElementById("city-input");
  const button = document.getElementById("search-btn");
  const statusBox = document.getElementById("status");
  const statusMessage = document.getElementById("status-message");
  const weatherBox = document.getElementById("weather");

  const els = {
    icon: document.getElementById("weather-icon"),
    city: document.getElementById("city-name"),
    region: document.getElementById("city-region"),
    temp: document.getElementById("temperature"),
    condition: document.getElementById("condition"),
    humidity: document.getElementById("humidity"),
    wind: document.getElementById("wind"),
  };

  // ---- Weather code mapping (WMO codes used by Open-Meteo) --------------

  function describe(code, isDay) {
    if (code === 0)  return { label: isDay ? "Clear" : "Clear night", kind: isDay ? "sunny" : "night" };
    if (code === 1)  return { label: isDay ? "Mostly clear" : "Mostly clear", kind: isDay ? "sunny" : "night" };
    if (code === 2)  return { label: "Partly cloudy", kind: "partly" };
    if (code === 3)  return { label: "Cloudy", kind: "cloudy" };
    if (code === 45 || code === 48) return { label: "Foggy", kind: "fog" };
    if (code >= 51 && code <= 57)   return { label: "Drizzle", kind: "rain" };
    if (code >= 61 && code <= 67)   return { label: "Rainy", kind: "rain" };
    if (code >= 71 && code <= 77)   return { label: "Snowy", kind: "snow" };
    if (code >= 80 && code <= 82)   return { label: "Rain showers", kind: "rain" };
    if (code === 85 || code === 86) return { label: "Snow showers", kind: "snow" };
    if (code >= 95 && code <= 99)   return { label: "Thunderstorm", kind: "storm" };
    return { label: "Unknown", kind: "cloudy" };
  }

  // Which page theme each kind of weather uses
  function themeFor(kind, isDay) {
    if (kind === "partly") return isDay ? "sunny" : "night";
    return kind;
  }

  // ---- Icons (inline SVG, no external assets) ---------------------------

  const CLOUD = '<path d="M46 46H20a10 10 0 1 1 2.2-19.76A14 14 0 0 1 49 28a9 9 0 0 1-3 18z" fill="#ffffff"/>';
  const CLOUD_GREY = '<path d="M46 46H20a10 10 0 1 1 2.2-19.76A14 14 0 0 1 49 28a9 9 0 0 1-3 18z" fill="#e3e8ee"/>';

  const SUN = `
    <circle cx="32" cy="32" r="11" fill="#ffd23f"/>
    <g stroke="#ffd23f" stroke-width="4" stroke-linecap="round">
      <line x1="32" y1="8" x2="32" y2="14"/><line x1="32" y1="50" x2="32" y2="56"/>
      <line x1="8" y1="32" x2="14" y2="32"/><line x1="50" y1="32" x2="56" y2="32"/>
      <line x1="15" y1="15" x2="19" y2="19"/><line x1="45" y1="45" x2="49" y2="49"/>
      <line x1="15" y1="49" x2="19" y2="45"/><line x1="45" y1="19" x2="49" y2="15"/>
    </g>`;

  const MOON = '<path d="M40 10a22 22 0 1 0 14 38A18 18 0 0 1 40 10z" fill="#eef1ff"/>';

  const ICONS = {
    sunny: SUN,
    night: MOON,
    partly: (isDay) => `
      <g transform="translate(-6 -8) scale(0.8)">${isDay ? SUN : MOON}</g>
      <g transform="translate(6 6)">${CLOUD}</g>`,
    cloudy: `<g transform="translate(0 4)">${CLOUD}</g>`,
    fog: `
      <g transform="translate(0 -4)">${CLOUD_GREY}</g>
      <g stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.9">
        <line x1="16" y1="50" x2="48" y2="50"/><line x1="22" y1="57" x2="54" y2="57"/>
      </g>`,
    rain: `
      <g transform="translate(0 -6)">${CLOUD_GREY}</g>
      <g stroke="#6ec6ff" stroke-width="4" stroke-linecap="round">
        <line x1="24" y1="48" x2="21" y2="56"/><line x1="34" y1="48" x2="31" y2="56"/>
        <line x1="44" y1="48" x2="41" y2="56"/>
      </g>`,
    snow: `
      <g transform="translate(0 -6)">${CLOUD_GREY}</g>
      <g fill="#ffffff">
        <circle cx="23" cy="51" r="3"/><circle cx="33" cy="56" r="3"/><circle cx="43" cy="51" r="3"/>
      </g>`,
    storm: `
      <g transform="translate(0 -6)"><path d="M46 46H20a10 10 0 1 1 2.2-19.76A14 14 0 0 1 49 28a9 9 0 0 1-3 18z" fill="#c4c9d6"/></g>
      <polygon points="34,38 26,52 32,52 29,62 41,46 35,46 38,38" fill="#ffd23f"/>`,
  };

  function iconSvg(kind, isDay) {
    const part = ICONS[kind] ?? ICONS.cloudy;
    const inner = typeof part === "function" ? part(isDay) : part;
    return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false">${inner}</svg>`;
  }

  // ---- Networking -------------------------------------------------------

  class WeatherError extends Error {}

  let activeController = null;

  async function fetchJson(url, signal) {
    let response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new WeatherError("Can't reach the weather service. Check your internet connection and try again.");
    }
    if (!response.ok) {
      throw new WeatherError("The weather service had a problem. Please try again in a moment.");
    }
    try {
      return await response.json();
    } catch {
      throw new WeatherError("Received an unexpected response. Please try again.");
    }
  }

  async function findCity(name, signal) {
    const params = new URLSearchParams({ name, count: "1", language: "en", format: "json" });
    const data = await fetchJson(`${GEO_URL}?${params}`, signal);
    const place = data.results?.[0];
    if (!place) {
      throw new WeatherError(`We couldn't find "${name}". Check the spelling or try a nearby city.`);
    }
    return place;
  }

  async function getCurrentWeather(lat, lon, signal) {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      wind_speed_unit: "kmh",
      timezone: "auto",
    });
    const data = await fetchJson(`${FORECAST_URL}?${params}`, signal);
    if (!data.current) throw new WeatherError("Weather data isn't available for that location right now.");
    return data.current;
  }

  // ---- UI state ---------------------------------------------------------

  function setStatus(type, message) {
    statusBox.hidden = false;
    statusBox.classList.toggle("is-error", type === "error");
    statusBox.classList.toggle("is-loading", type === "loading");
    statusMessage.textContent = message;
  }

  function clearStatus() {
    statusBox.hidden = true;
    statusBox.classList.remove("is-error", "is-loading");
    statusMessage.textContent = "";
  }

  function setBusy(busy) {
    button.disabled = busy;
    button.textContent = busy ? "Searching…" : "Search";
  }

  function render(place, current) {
    const isDay = current.is_day === 1;
    const { label, kind } = describe(current.weather_code, isDay);

    els.icon.innerHTML = iconSvg(kind, isDay);
    els.city.textContent = place.name;
    els.region.textContent = [place.admin1, place.country].filter(Boolean).join(", ");
    els.temp.textContent = Math.round(current.temperature_2m);
    els.condition.textContent = label;
    els.humidity.textContent = `${Math.round(current.relative_humidity_2m)}%`;
    els.wind.textContent = `${Math.round(current.wind_speed_10m)} km/h`;

    document.body.dataset.theme = themeFor(kind, isDay);
    weatherBox.hidden = false;
    // Restart the entrance animation on each new result
    weatherBox.style.animation = "none";
    void weatherBox.offsetWidth;
    weatherBox.style.animation = "";
  }

  // ---- Main flow --------------------------------------------------------

  async function search(rawName) {
    const name = rawName.trim();
    if (!name) {
      setStatus("error", "Please enter a city name.");
      return;
    }

    // Cancel any request still in flight so results can't arrive out of order
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);

    setBusy(true);
    setStatus("loading", "Fetching weather…");

    try {
      const place = await findCity(name, controller.signal);
      const current = await getCurrentWeather(place.latitude, place.longitude, controller.signal);

      render(place, current);
      clearStatus();
      saveLastCity(place.name);
    } catch (err) {
      if (err.name === "AbortError") {
        // Superseded by a newer search: stay quiet. Timed out: tell the user.
        if (controller.signal.reason !== "timeout") return;
        weatherBox.hidden = true;
        setStatus("error", "The request took too long. Please try again.");
      } else {
        weatherBox.hidden = true;
        document.body.dataset.theme = "default";
        setStatus("error", err instanceof WeatherError
          ? err.message
          : "Something went wrong. Please try again.");
      }
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) {
        activeController = null;
        setBusy(false);
      }
    }
  }

  // ---- Remember the last city (storage can be unavailable) --------------

  function saveLastCity(name) {
    try { localStorage.setItem(STORAGE_KEY, name); } catch { /* ignore */ }
  }

  function loadLastCity() {
    try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
  }

  // ---- Events -----------------------------------------------------------

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    search(input.value);
  });

  const last = loadLastCity();
  if (last) {
    input.value = last;
    search(last);
  }
})();