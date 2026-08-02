// ==UserScript==
// @name         AeroDeck EFB
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @updateURL    https://raw.githubusercontent.com/machpoint82/geofs-aero-deck/main/aerodeck-efb.user.js
// @downloadURL  https://raw.githubusercontent.com/machpoint82/geofs-aero-deck/main/aerodeck-efb.user.js
// @description  Airline operations EFB for GeoFS.
// @author       machpoint82
// @match        *://www.geo-fs.com/*
// @match        *://geo-fs.com/*
// @icon         https://raw.githubusercontent.com/machpoint82/geofs-aero-deck/main/preview/icon.png
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      metar.vatsim.net
// @connect      aviationweather.gov
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      geofs-aerodeck-default-rtdb.firebaseio.com
// @connect      www.simbrief.com
// @require      https://cdn.jsdelivr.net/gh/machpoint82/geofs-aero-deck@main/data/airports.js
// @require      https://cdn.jsdelivr.net/gh/machpoint82/geofs-aero-deck@main/data/airlines.js
// ==/UserScript==

// ---------------------------------------------------------------------------

(function () {
    'use strict';

    // Page-world GeoFS (Tampermonkey sandbox cannot always see bare `geofs`)
    function pageGeofs() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow.geofs) return unsafeWindow.geofs;
        } catch (e) { /* ignore */ }
        try {
            if (typeof window !== 'undefined' && window.geofs) return window.geofs;
        } catch (e) { /* ignore */ }
        try {
            if (typeof geofs !== 'undefined') return geofs;
        } catch (e) { /* ignore */ }
        return null;
    }

    // ------------------------------- storage keys -------------------------------
    const STORAGE = {
        PROFILE: 'aerodeck_profile',
        AIRLINES_CACHE: 'aerodeck_airlines_cache_v1',
        AIRPORTS_CACHE: 'aerodeck_airports_cache_v1',
        HISTORY_PREFIX: 'aerodeck_history_',
        CHECKLIST_PREFIX: 'aerodeck_checklist_',
        GEOMETRY: 'aerodeck_geometry_v2',
        CHAT_AGE_ACK: 'aerodeck_chat_age_ack',
        THEME: 'aerodeck_theme',
        SIMBRIEF_USERNAME: 'aerodeck_simbrief_username',
        OPEN_SHORTCUT: 'aerodeck_open_shortcut'
    };

    const CHARTS_BASE_URL = 'https://cdn.jsdelivr.net/gh/machpoint82/geofs-aero-deck@main/charts';
    const AIRLINES_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
    const AIRPORTS_URL = 'https://raw.githubusercontent.com/mwgg/airports/master/airports.json';
    const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const LOGO_URL = (iata) => `https://images.kiwi.com/airlines/64/${iata}.png`;
    const MAX_HISTORY = 200;
    const METAR_CACHE_MS = 10 * 60 * 1000;

    // Keep in sync with // @version above
    const SCRIPT_VERSION = '1.0.2';
    const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/machpoint82/geofs-aero-deck/main/aerodeck-efb.js';
    const RELEASES_URL = 'https://github.com/machpoint82/geofs-aero-deck/releases/latest';
    let remoteVersion = null;
    let versionCheckDone = false;
    let lastUiInteractTs = 0;
    function markUiInteract() { lastUiInteractTs = Date.now(); }

    // ------------------------------- storage helpers -------------------------------
    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') {
                const v = GM_getValue(key, undefined);
                return v === undefined ? fallback : v;
            }
        } catch (e) { /* ignore */ }
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
    }
    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
        } catch (e) { /* ignore */ }
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }

    // ------------------------------- GM-backed network helper -------------------------------
    function gmFetchText(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                fetch(url).then((r) => r.ok ? r.text() : Promise.reject(new Error('bad status ' + r.status))).then(resolve).catch(reject);
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: timeoutMs || 8000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) resolve(res.responseText);
                    else reject(new Error('bad status ' + res.status));
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    // ------------------------------- data: airlines + airports -------------------------------
    let airlinesByIata = {};
    let airlinesByIcao = {};
    let airportsByIcao = {};
    let dataStatus = 'loading';

    function parseCsv(text) {
        const rows = [];
        let cur = [], field = '', inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
                else field += c;
            } else {
                if (c === '"') inQuotes = true;
                else if (c === ',') { cur.push(field); field = ''; }
                else if (c === '\n' || c === '\r') {
                    if (field.length || cur.length) { cur.push(field); rows.push(cur); }
                    field = ''; cur = [];
                    if (c === '\r' && text[i + 1] === '\n') i++;
                } else field += c;
            }
        }
        if (field.length || cur.length) { cur.push(field); rows.push(cur); }
        return rows;
    }
    function buildAirlineIndex(rows) {
        const byIata = {}, byIcao = {};
        for (const row of rows) {
            if (row.length < 8) continue;
            const name = (row[1] || '').trim();
            const iata = (row[3] || '').trim().toUpperCase();
            const icao = (row[4] || '').trim().toUpperCase();
            const country = (row[6] || '').trim();
            const active = (row[7] || '').trim().toUpperCase() === 'Y';
            if (!name) continue;
            const entry = { name, iata, icao, country, active };
            if (iata.length === 2 && /^[A-Z0-9]{2}$/.test(iata)) byIata[iata] = entry;
            if (icao.length === 3 && /^[A-Z]{3}$/.test(icao)) byIcao[icao] = entry;
        }
        return { byIata, byIcao };
    }
    async function loadAirlines() {
        if (typeof window.AERODECK_AIRLINES !== 'undefined' && Array.isArray(window.AERODECK_AIRLINES)) {
            const byIata = {}, byIcao = {};
            for (const entry of window.AERODECK_AIRLINES) {
                if (entry.iata) byIata[entry.iata] = entry;
                if (entry.icao) byIcao[entry.icao] = entry;
            }
            airlinesByIata = byIata; airlinesByIcao = byIcao;
            return;
        }
        const cached = gmGet(STORAGE.AIRLINES_CACHE, null);
        if (cached && cached.ts && (Date.now() - cached.ts < CACHE_MAX_AGE_MS)) {
            airlinesByIata = cached.byIata || {}; airlinesByIcao = cached.byIcao || {};
            return;
        }
        try {
            const text = await gmFetchText(AIRLINES_URL);
            const rows = parseCsv(text);
            const { byIata, byIcao } = buildAirlineIndex(rows);
            airlinesByIata = byIata; airlinesByIcao = byIcao;
            gmSet(STORAGE.AIRLINES_CACHE, { ts: Date.now(), byIata, byIcao });
        } catch (e) {
            console.warn('[AeroDeck] airline dataset fetch failed, using cache if any', e);
            if (cached) { airlinesByIata = cached.byIata || {}; airlinesByIcao = cached.byIcao || {}; }
        }
    }
    async function loadAirports() {
        if (typeof window.AERODECK_AIRPORTS !== 'undefined' && window.AERODECK_AIRPORTS) {
            airportsByIcao = window.AERODECK_AIRPORTS;
            return;
        }
        const cached = gmGet(STORAGE.AIRPORTS_CACHE, null);
        if (cached && cached.ts && (Date.now() - cached.ts < CACHE_MAX_AGE_MS)) {
            airportsByIcao = cached.data || {};
            return;
        }
        try {
            const text = await gmFetchText(AIRPORTS_URL);
            const json = JSON.parse(text);
            const reduced = {};
            for (const icao in json) {
                const a = json[icao];
                reduced[icao] = { icao: a.icao, iata: a.iata, name: a.name, city: a.city, country: a.country, lat: a.lat, lon: a.lon };
            }
            airportsByIcao = reduced;
            gmSet(STORAGE.AIRPORTS_CACHE, { ts: Date.now(), data: reduced });
        } catch (e) {
            console.warn('[AeroDeck] airport dataset fetch failed, using cache if any', e);
            if (cached) airportsByIcao = cached.data || {};
        }
    }
    async function initData() {
        dataStatus = 'loading';
        try { await Promise.all([loadAirlines(), loadAirports()]); dataStatus = 'ready'; }
        catch (e) { dataStatus = 'error'; }
        renderIfOpen();
    }
    function forceRefreshData() {
        gmSet(STORAGE.AIRLINES_CACHE, null);
        gmSet(STORAGE.AIRPORTS_CACHE, null);
        initData();
    }

    // ------------------------------- open-EFB keyboard shortcut -------------------------------
    // Stored as { ctrl, alt, shift, meta, key } or null when disabled.
    // key is a KeyboardEvent.key string (e.g. ' ', 'e', 'F1').
    function getOpenShortcut() {
        const v = gmGet(STORAGE.OPEN_SHORTCUT, null);
        if (!v || typeof v !== 'object' || !v.key) return null;
        return {
            ctrl: !!v.ctrl,
            alt: !!v.alt,
            shift: !!v.shift,
            meta: !!v.meta,
            key: String(v.key)
        };
    }
    function setOpenShortcut(spec) {
        if (!spec || !spec.key) gmSet(STORAGE.OPEN_SHORTCUT, null);
        else gmSet(STORAGE.OPEN_SHORTCUT, {
            ctrl: !!spec.ctrl, alt: !!spec.alt, shift: !!spec.shift, meta: !!spec.meta, key: String(spec.key)
        });
    }
    function formatShortcut(spec) {
        if (!spec || !spec.key) return 'None';
        const parts = [];
        if (spec.ctrl) parts.push('Ctrl');
        if (spec.alt) parts.push('Alt');
        if (spec.shift) parts.push('Shift');
        if (spec.meta) parts.push('Meta');
        let k = spec.key;
        if (k === ' ') k = 'Space';
        else if (k.length === 1) k = k.toUpperCase();
        parts.push(k);
        return parts.join(' + ');
    }
    function eventMatchesShortcut(e, spec) {
        if (!spec || !spec.key) return false;
        if (!!e.ctrlKey !== !!spec.ctrl) return false;
        if (!!e.altKey !== !!spec.alt) return false;
        if (!!e.shiftKey !== !!spec.shift) return false;
        if (!!e.metaKey !== !!spec.meta) return false;
        // Space is reported as ' ' ; compare case-insensitively for letters
        const ek = e.key;
        const sk = spec.key;
        if (sk === ' ' || sk === 'Space') return ek === ' ';
        if (sk.length === 1 && ek.length === 1) return ek.toLowerCase() === sk.toLowerCase();
        return ek === sk;
    }
    function isTypingTarget(el) {
        if (!el) return false;
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        return false;
    }
    let shortcutCaptureMode = false;
    function onGlobalShortcutKeydown(e) {
        if (shortcutCaptureMode) return; // handled by settings capture UI
        if (isTypingTarget(document.activeElement)) return;
        // Don't steal keys while the tablet has focus on an input (stopPropagation already helps)
        const spec = getOpenShortcut();
        if (!eventMatchesShortcut(e, spec)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!panelOpen) openPanel();
        else if (minimized) restore();
        else closePanel(); // toggle closed when fully open
    }
    function installOpenShortcutListener() {
        if (installOpenShortcutListener._done) return;
        installOpenShortcutListener._done = true;
        document.addEventListener('keydown', onGlobalShortcutKeydown, true);
    }

    // ------------------------------- lookups -------------------------------
    function lookupAirline(raw) {
        if (!raw) return null;
        const s = raw.trim().toUpperCase().replace(/\s+/g, '');
        const m2 = s.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
        const m3 = s.match(/^([A-Z]{3})(\d{1,4}[A-Z]?)$/);
        if (m2 && airlinesByIata[m2[1]]) return Object.assign({}, airlinesByIata[m2[1]], { flightNo: m2[2], code: m2[1], codeType: 'IATA' });
        if (m3 && airlinesByIcao[m3[1]]) return Object.assign({}, airlinesByIcao[m3[1]], { flightNo: m3[2], code: m3[1], codeType: 'ICAO' });
        if (m2 && airlinesByIcao[m2[1]]) return Object.assign({}, airlinesByIcao[m2[1]], { flightNo: m2[2], code: m2[1], codeType: 'ICAO' });
        return null;
    }
    function lookupAirport(raw) {
        if (!raw) return null;
        const icao = raw.trim().toUpperCase();
        return airportsByIcao[icao] || null;
    }
    function haversineNM(lat1, lon1, lat2, lon2) {
        const R = 3440.065;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return Math.round(2 * R * Math.asin(Math.sqrt(a)));
    }
    function findNearestAirport(lat, lon) {
        let best = null, bestD = Infinity;
        for (const icao in airportsByIcao) {
            const a = airportsByIcao[icao];
            if (a.lat == null || a.lon == null) continue;
            const d = haversineNM(lat, lon, a.lat, a.lon);
            if (d < bestD) { bestD = d; best = a; }
        }
        return best;
    }

    // ------------------------------- GeoFS live data helpers -------------------------------
    function getCurrentLatLon() {
        try {
            const inst = geofs.aircraft.instance;
            if (Array.isArray(inst.llaLocation) && inst.llaLocation.length >= 2) return { lat: inst.llaLocation[0], lon: inst.llaLocation[1] };
        } catch (e) { /* ignore */ }
        return null;
    }
    function getCurrentGroundSpeedKts() { try { return geofs.animation.values.groundSpeedKnt; } catch (e) { return null; } }
    function getCurrentHeading() { try { return geofs.animation.values.heading; } catch (e) { return null; } }
    function getCurrentAltitudeFt() { try { return Math.round(geofs.animation.values.altitude); } catch (e) { return null; } }
    function getCurrentMach() { try { return geofs.animation.values.mach; } catch (e) { return null; } }

    const FLIGHT_PHASES = {
        GROUND: { label: 'GROUND', color: '#8397ae' },
        CLIMB: { label: 'CLIMB', color: '#34d399' },
        CRUISE: { label: 'CRUISE', color: '#22d3ee' },
        DESCENT: { label: 'DESCENT', color: '#f0a35e' },
        UNKNOWN: { label: '—', color: '#5c7089' }
    };
    function getFlightPhaseCode() {
        try {
            const onGround = geofs.aircraft.instance.groundContact === true;
            if (onGround) return 'GROUND';
            const vs = geofs.animation.values.verticalSpeed || 0;
            if (vs > 300) return 'CLIMB';
            if (vs < -300) return 'DESCENT';
            return 'CRUISE';
        } catch (e) { return 'UNKNOWN'; }
    }
    function getFlightPhase() { return FLIGHT_PHASES[getFlightPhaseCode()]; }
    function getOnGround() { try { return geofs.aircraft.instance.groundContact === true; } catch (e) { return false; } }
   function getParkingBrakeSet() {
    try { return geofs.aircraft.instance.animationValue.parkingBrake === true; } catch (e) { return false; }
}
    function getEnginesOff() {
        try {
            const engines = geofs.aircraft.instance.engines;
            if (!engines || !engines.length) return true;
            return engines.every((e) => Math.abs(e.rpm || 0) < 5);
        } catch (e) { return false; }
    }

    // ------------------------------- aircraft auto-detection -------------------------------
    // --Credits to Ferhatduran Experimental Flight Interface https://github.com/Ferhatduran55/geofs-experimental-fi
    const AIRCRAFT_GROUPS = {
        fighter: ["7", "15", "2808", "4251"],
        fighterJet: ["3", "18", "27", "29", "1024", "2310", "2364", "2556", "2581", "2857", "2948", "2988", "3591", "3617", "5229", "5347", "5405", "5431"],
        glider: ["11", "41", "50", "53", "103", "2953", "2968"],
        singleEngine: ["1", "2", "8", "12", "13", "21", "22", "23", "31", "40", "1019", "1022", "1026", "1069", "2000", "2750", "2786", "2976", "2989", "3211", "4341", "4390", "4409", "4596", "5061", "5486", "5499"],
        twinPistonEngine: ["14", "16", "28", "4398", "4401"],
        twinTurboprop: ["6", "26", "2864", "3460"],
        twinjetNarrowBody: ["4", "238", "242", "1001", "1003", "1007", "1008", "2003", "2769", "2772", "2843", "2865", "2870", "2871", "2878", "2879", "2899", "3011", "3054", "3140", "3292", "3534", "4140", "4646", "4743", "4745", "5086", "5156", "5203", "5551"],
        wideBody4Engine: ["10", "252", "1002", "1010", "1012", "2153", "2752", "2951", "5193", "5211", "5314", "5409"],
        twinjetWideBody: ["24", "25", "235", "237", "239", "240", "244", "1004", "1005", "1006", "1009", "1011", "2386", "2856", "2973", "3179", "3180", "3575", "4402", "4631", "4764"],
        narrowBody4Engine: ["20", "1014", "2395"],
        trijet: ["1023", "5038"],
        regionalJet: ["236", "1015", "1016", "1017", "1018", "2004", "2700", "2706", "3036", "3307", "3341", "4017"],
        heavyCargo: ["2788", "5516"],
        businessJet: ["5", "1021", "2461", "3109", "5073"],
        turbopropCommuter: ["247", "1013", "1020", "2418", "2420", "2426", "2892", "2943", "3289", "3436"]
    };
    const GROUP_CAPACITY = {
        wideBody4Engine: 400, narrowBody4Engine: 180, trijet: 250,
        twinjetWideBody: 280, heavyCargo: 0, twinjetNarrowBody: 180,
        regionalJet: 90, turbopropCommuter: 60, twinTurboprop: 19,
        businessJet: 12, twinPistonEngine: 6, singleEngine: 4,
        fighter: 1, fighterJet: 1, glider: 1
    };
    // Per-aircraft-TYPE table, matched against the live aircraft name string from
    // geofs.aircraftList (not the numeric id — GeoFS keeps adding new ids/variants
    // that a static id list can never keep up with, which is what caused things
    // like the 747 silently falling back to the 150-pax default).
    // Checked top to bottom, first match wins — so put more specific variants
    // (e.g. "747-8i") above the more generic ones (e.g. plain "747").
    // capacity: 0 is used for pure freighters/cargo variants.
    const AIRCRAFT_TYPE_TABLE = [
        // --- freighters / cargo / non-passenger first, so they never inherit a pax figure ---
        { re: /747.*(LCF|dreamlifter)/i, capacity: 0, group: 'heavyCargo' },
        { re: /747.*-?8f|747.*freighter/i, capacity: 0, group: 'heavyCargo' },
        { re: /an-?225/i, capacity: 0, group: 'heavyCargo' },
        { re: /an-?124/i, capacity: 0, group: 'heavyCargo' },
        { re: /il-?76/i, capacity: 0, group: 'heavyCargo' },
        { re: /c-5\b/i, capacity: 0, group: 'heavyCargo' },
        { re: /c-17\b/i, capacity: 0, group: 'heavyCargo' },
        { re: /md-?11.*f\b|md-?11.*freighter/i, capacity: 0, group: 'heavyCargo' },

        // --- Boeing 747 family ---
        { re: /747.*-?8i/i, capacity: 467, group: 'wideBody4Engine' },
        { re: /747sp/i, capacity: 289, group: 'wideBody4Engine' },
        { re: /747.*-?400d/i, capacity: 568, group: 'wideBody4Engine' },
        { re: /747.*-?400/i, capacity: 416, group: 'wideBody4Engine' },
        { re: /747.*-?100/i, capacity: 452, group: 'wideBody4Engine' },
        { re: /747/i, capacity: 400, group: 'wideBody4Engine' },

        // --- Airbus A340 family (4-engine, but distinct from the 747) ---
        { re: /a340.*-?600/i, capacity: 380, group: 'wideBody4Engine' },
        { re: /a340.*-?500/i, capacity: 313, group: 'wideBody4Engine' },
        { re: /a340.*-?300/i, capacity: 295, group: 'wideBody4Engine' },
        { re: /a340/i, capacity: 300, group: 'wideBody4Engine' },

        // --- other 4-engine widebodies ---
        { re: /a380/i, capacity: 525, group: 'wideBody4Engine' },
        { re: /il-?86/i, capacity: 350, group: 'wideBody4Engine' },

        // --- Boeing 777 ---
        { re: /777.*-?300er/i, capacity: 396, group: 'twinjetWideBody' },
        { re: /777.*-?300/i, capacity: 368, group: 'twinjetWideBody' },
        { re: /777.*-?200/i, capacity: 314, group: 'twinjetWideBody' },
        { re: /777/i, capacity: 350, group: 'twinjetWideBody' },

        // --- Boeing 787 ---
        { re: /787.*-?10/i, capacity: 336, group: 'twinjetWideBody' },
        { re: /787.*-?9/i, capacity: 296, group: 'twinjetWideBody' },
        { re: /787.*-?8/i, capacity: 242, group: 'twinjetWideBody' },
        { re: /787/i, capacity: 270, group: 'twinjetWideBody' },

        // --- Airbus A350 ---
        { re: /a350.*-?1000/i, capacity: 366, group: 'twinjetWideBody' },
        { re: /a350.*-?900/i, capacity: 325, group: 'twinjetWideBody' },
        { re: /a350/i, capacity: 325, group: 'twinjetWideBody' },

        // --- Airbus A330 ---
        { re: /a330.*-?900/i, capacity: 287, group: 'twinjetWideBody' },
        { re: /a330.*-?300/i, capacity: 277, group: 'twinjetWideBody' },
        { re: /a330.*-?200/i, capacity: 247, group: 'twinjetWideBody' },
        { re: /a330/i, capacity: 260, group: 'twinjetWideBody' },

        // --- MD-11 / DC-10 (trijets) ---
        { re: /md-?11/i, capacity: 293, group: 'trijet' },
        { re: /dc-?10/i, capacity: 270, group: 'trijet' },

        // --- Boeing 767 / 757 ---
        { re: /767.*-?300/i, capacity: 218, group: 'twinjetWideBody' },
        { re: /767/i, capacity: 200, group: 'twinjetWideBody' },
        { re: /757.*-?300/i, capacity: 243, group: 'twinjetNarrowBody' },
        { re: /757/i, capacity: 200, group: 'twinjetNarrowBody' },

        // --- Boeing 737 family ---
        { re: /737.*max ?8/i, capacity: 189, group: 'twinjetNarrowBody' },
        { re: /737.*-?800/i, capacity: 189, group: 'twinjetNarrowBody' },
        { re: /737.*-?600/i, capacity: 132, group: 'twinjetNarrowBody' },
        { re: /737.*-?200/i, capacity: 130, group: 'twinjetNarrowBody' },
        { re: /737/i, capacity: 160, group: 'twinjetNarrowBody' },

        // --- Airbus A320 family ---
        { re: /a321neo|a321lr/i, capacity: 206, group: 'twinjetNarrowBody' },
        { re: /a321/i, capacity: 220, group: 'twinjetNarrowBody' },
        { re: /a320neo/i, capacity: 180, group: 'twinjetNarrowBody' },
        { re: /a320/i, capacity: 180, group: 'twinjetNarrowBody' },
        { re: /a319neo/i, capacity: 156, group: 'twinjetNarrowBody' },
        { re: /a319/i, capacity: 156, group: 'twinjetNarrowBody' },
        { re: /a318/i, capacity: 132, group: 'twinjetNarrowBody' },
        { re: /a220.*-?300/i, capacity: 140, group: 'twinjetNarrowBody' },
        { re: /a220/i, capacity: 120, group: 'twinjetNarrowBody' },

        // --- BAe 146 / Avro RJ ---
        { re: /rj ?100/i, capacity: 112, group: 'regionalJet' },
        { re: /bae ?146/i, capacity: 100, group: 'regionalJet' },

        // --- E-Jets ---
        { re: /e195/i, capacity: 132, group: 'regionalJet' },
        { re: /e190/i, capacity: 114, group: 'regionalJet' },
        { re: /e175/i, capacity: 88, group: 'regionalJet' },
        { re: /e170/i, capacity: 78, group: 'regionalJet' },

        // --- CRJ ---
        { re: /crj.*900/i, capacity: 90, group: 'regionalJet' },
        { re: /crj.*700/i, capacity: 70, group: 'regionalJet' },
        { re: /crj/i, capacity: 50, group: 'regionalJet' },

        // --- Turboprops ---
        { re: /atr ?72/i, capacity: 70, group: 'turbopropCommuter' },
        { re: /atr ?42/i, capacity: 48, group: 'turbopropCommuter' }
    ];
    function getAircraftGroup(id) {
        const key = String(id);
        for (const g in AIRCRAFT_GROUPS) if (AIRCRAFT_GROUPS[g].includes(key)) return g;
        return 'default';
    }
    function getTypeInfoFromName(name) {
        if (!name) return null;
        for (const entry of AIRCRAFT_TYPE_TABLE) if (entry.re.test(name)) return entry;
        return null;
    }
    function detectCurrentAircraft() {
        try {
            const g = pageGeofs();
            if (!g || !g.aircraft || !g.aircraft.instance) return null;
            const inst = g.aircraft.instance;
            const id = inst.id;
            if (id == null || id === '') return null;
            let name = null;
            try {
                const list = g.aircraftList || {};
                const entry = list[id] || list[String(id)] || list[Number(id)];
                if (entry && entry.name) name = entry.name;
            } catch (e) { /* ignore */ }
            if (!name) {
                try { name = inst.aircraftName || inst.name || (inst.definition && inst.definition.name) || null; } catch (e) { /* ignore */ }
            }
            // Prefer a match on the real aircraft name/variant — this is what actually
            // distinguishes a 747 from an A340 from a 737, and stays correct even for
            // new aircraft GeoFS adds later. Only fall back to the old numeric-id group
            // list (and finally a flat default) if the name doesn't match anything.
            const typeInfo = getTypeInfoFromName(name);
            let group, capacity;
            if (typeInfo) {
                group = typeInfo.group;
                capacity = typeInfo.capacity;
            } else {
                group = getAircraftGroup(id);
                capacity = GROUP_CAPACITY[group] != null ? GROUP_CAPACITY[group] : 150;
            }
            return { id, name: name || ('Aircraft #' + id), group, capacity };
        } catch (e) { return null; }
    }

    // ------------------------------- weather: METAR (VATSIM primary) + decoded ATIS -------------------------------
    const metarMemCache = {};
    async function fetchMetarRaw(icao) {
        const cached = metarMemCache[icao];
        if (cached && (Date.now() - cached.ts < METAR_CACHE_MS)) return cached.result;
        let result;
        try {
            const text = await gmFetchText(`https://metar.vatsim.net/${icao}`);
            const raw = (text || '').trim();
            if (!raw || raw.toLowerCase().includes('not found') || !raw.toUpperCase().startsWith(icao.toUpperCase())) {
                throw new Error('empty/invalid');
            }
            result = { raw };
        } catch (e1) {
            try {
                const text = await gmFetchText(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw`);
                const raw = (text || '').trim().split('\n')[0];
                if (!raw) throw new Error('empty');
                result = { raw };
            } catch (e2) {
                result = { error: `No current METAR available for ${icao}.` };
            }
        }
        metarMemCache[icao] = { ts: Date.now(), result };
        return result;
    }
    function decodeMetarToAtis(raw, icao) {
        if (!raw) return null;
        const parts = raw.split(/\s+/);
        const timeTok = parts.find((p) => /^\d{6}Z$/.test(p));
        const time = timeTok ? `${timeTok.slice(2, 4)}:${timeTok.slice(4, 6)}Z` : '—';
        let infoLetter = null;
        const infoTok = parts.find((p) => /^INFO(RMATION)?$/i.test(p));
        if (infoTok) {
            const idx = parts.indexOf(infoTok);
            if (parts[idx + 1] && /^[A-Z]$/i.test(parts[idx + 1])) infoLetter = parts[idx + 1].toUpperCase();
        }
        if (!infoLetter && timeTok) {
            const hour = parseInt(timeTok.slice(2, 4), 10);
            if (Number.isFinite(hour)) infoLetter = String.fromCharCode(65 + (hour % 26)); // A–X typically
        }
        const windTok = parts.find((p) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(p));
        let wind = 'calm';
        if (windTok) {
            const m = windTok.match(/^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/);
            if (m) wind = `${m[1] === 'VRB' ? 'variable' : m[1] + '°'} at ${parseInt(m[2], 10)} kt${m[4] ? ` gusting ${parseInt(m[4], 10)}` : ''}`;
        }
        const visTok = parts.find((p) => /^(\d{4}|P?\d{1,2}SM|CAVOK)$/.test(p));
        let vis = visTok || '—';
        if (visTok === 'CAVOK') vis = 'ceiling and visibility OK';
        else if (/^\d{4}$/.test(visTok || '')) vis = `${visTok} m`;
        const tempTok = parts.find((p) => /^M?\d{2}\/M?\d{2}$/.test(p));
        let temp = '—', dew = '—';
        if (tempTok) {
            const [t, d] = tempTok.split('/');
            temp = `${t.startsWith('M') ? '-' + t.slice(1) : t}°C`;
            dew = `${d.startsWith('M') ? '-' + d.slice(1) : d}°C`;
        }
        const qnhTok = parts.find((p) => /^Q\d{4}$/.test(p)) || parts.find((p) => /^A\d{4}$/.test(p));
        let qnh = '—';
        if (qnhTok) qnh = qnhTok.startsWith('Q') ? `${qnhTok.slice(1)} hPa` : `${(parseInt(qnhTok.slice(1), 10) / 100).toFixed(2)} inHg`;
        const cloudToks = parts.filter((p) => /^(FEW|SCT|BKN|OVC|VV)\d{3}/.test(p));
        const clouds = cloudToks.length ? cloudToks.map((c) => `${c.slice(0, 3)} ${parseInt(c.slice(3, 6), 10) * 100}ft`).join(', ') : 'sky clear';
        return { time, wind, vis, temp, dew, qnh, clouds, icao, infoLetter };
    }

    // ------------------------------- AeroDeck-only multiplayer presence (unchanged transport) -------------------------------
    const MULTIPLAYER_BACKEND_URL = 'https://geofs-aerodeck-default-rtdb.firebaseio.com';
    const PRESENCE_STALE_MS = 30000;
    const PRESENCE_BROADCAST_MS = 8000;
    let presenceBroadcastTimer = null;
    let cachedPresence = [];
    let lastPresenceFetch = 0;
    let backendReachable = null;
    let chatEnabled = false;
    let chatMessages = [];
    let lastChatFetch = 0;
    let lastChatSendTs = 0;
    const CHAT_POLL_MS = 4000;
    const CHAT_SEND_COOLDOWN_MS = 2000;

    async function fetchChatMessages() {
        if (!MULTIPLAYER_BACKEND_URL) return [];
        try {
            const res = await fetch(`${MULTIPLAYER_BACKEND_URL}/aerodeck_chat.json`);
            backendReachable = res.ok;
            const json = await res.json();
            if (!json) return [];
            const arr = Object.values(json).filter(Boolean);
            arr.sort((a, b) => a.ts - b.ts);
            return arr.slice(-50);
        } catch (e) { backendReachable = false; return []; }
    }
    async function sendChatMessage(profile, text) {
        const now = Date.now();
        if (now - lastChatSendTs < CHAT_SEND_COOLDOWN_MS) return;
        lastChatSendTs = now;
        const payload = { pilotId: profile.id, name: profile.name, text: text.slice(0, 200), ts: now };
        try { await fetch(`${MULTIPLAYER_BACKEND_URL}/aerodeck_chat.json`, { method: 'POST', body: JSON.stringify(payload) }); } catch (e) { /* best effort */ }
    }
    function renderChatMessages(container) {
        const list = container || (tabletEl && tabletEl.querySelector('#aerodeck-chat-messages'));
        if (!list) return;
        const profile = getProfile();
        list.innerHTML = chatMessages.map((m) => {
            const isSelf = !!(profile && m.pilotId === profile.id);
            return `
                <div class="aerodeck-chat-row ${isSelf ? 'self' : 'other'}">
                    <div class="aerodeck-chat-bubble">
                        ${!isSelf ? `<div class="chat-name">${escapeHtml(m.name)}</div>` : ''}
                        <div class="chat-text">${escapeHtml(m.text)}</div>
                    </div>
                </div>
            `;
        }).join('') || `<div class="aerodeck-empty-note" style="padding:20px 0;">No messages yet — say hi.</div>`;
        list.scrollTop = list.scrollHeight;
    }
    function fetchAndRenderChat() { fetchChatMessages().then((msgs) => { chatMessages = msgs; renderChatMessages(); }); }

    function startPresenceBroadcast(profile) {
        if (!MULTIPLAYER_BACKEND_URL || presenceBroadcastTimer) return;
        const broadcast = () => {
            const pos = getCurrentLatLon();
            if (!pos) return;
            const payload = {
                name: profile.name, lat: pos.lat, lon: pos.lon, heading: getCurrentHeading() || 0,
                speed: getCurrentGroundSpeedKts() || 0, altitude: getCurrentAltitudeFt() || 0,
                origin: flight.origin ? flight.origin.icao : null, destination: flight.destination ? flight.destination.icao : null,
                ts: Date.now()
            };
            fetch(`${MULTIPLAYER_BACKEND_URL}/aerodeck_presence/${profile.id}.json`, { method: 'PUT', body: JSON.stringify(payload) })
                .then((r) => { backendReachable = r.ok; }).catch(() => { backendReachable = false; });
        };
        broadcast();
        presenceBroadcastTimer = setInterval(broadcast, PRESENCE_BROADCAST_MS);
        window.addEventListener('beforeunload', () => {
            try { navigator.sendBeacon(`${MULTIPLAYER_BACKEND_URL}/aerodeck_presence/${profile.id}.json`, JSON.stringify(null)); } catch (e) { /* best effort */ }
        });
    }
    async function fetchAeroDeckPresence(selfId) {
        if (!MULTIPLAYER_BACKEND_URL) return [];
        try {
            const res = await fetch(`${MULTIPLAYER_BACKEND_URL}/aerodeck_presence.json`);
            backendReachable = res.ok;
            const json = await res.json();
            if (!json) return [];
            const now = Date.now();
            return Object.entries(json)
                .filter(([id, v]) => id !== selfId && v && (now - v.ts) < PRESENCE_STALE_MS)
                .map(([id, v]) => ({ id, callsign: v.name || id.slice(0, 6), lat: v.lat, lon: v.lon, heading: v.heading || 0, speed: v.speed || 0, altitude: v.altitude || 0, origin: v.origin, destination: v.destination }));
        } catch (e) { backendReachable = false; return []; }
    }
    function normalizeNameKey(name) { return name.trim().toLowerCase().replace(/[.#$\[\]\/]/g, '_').replace(/\s+/g, '_').slice(0, 60); }

    function versionParts(v) {
        return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
    }
    function isUpdateAvailable() {
        if (!remoteVersion) return false;
        const a = versionParts(SCRIPT_VERSION), b = versionParts(remoteVersion);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const x = a[i] || 0, y = b[i] || 0;
            if (y > x) return true;
            if (y < x) return false;
        }
        return false;
    }
    async function checkForUpdate() {
        if (versionCheckDone) return;
        versionCheckDone = true;
        try {
            const textBody = await gmFetchText(VERSION_CHECK_URL + '?t=' + Date.now(), 8000);
            const m = textBody.match(/@version\s+([0-9]+(?:\.[0-9]+)*)/);
            if (m) remoteVersion = m[1];
        } catch (e) {
            console.warn('[AeroDeck] version check failed', e);
            remoteVersion = null;
        }
        if (panelOpen && !minimized && activeTab === 'settings') render();
    }

    async function fetchNameClaim(nameKey) {
        if (!MULTIPLAYER_BACKEND_URL || !nameKey) return null;
        try {
            const res = await fetch(MULTIPLAYER_BACKEND_URL + '/aerodeck_names/' + encodeURIComponent(nameKey) + '.json');
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }
    async function claimPilotName(name, pilotId) {
        const nameKey = normalizeNameKey(name);
        if (!nameKey) return { ok: false, reason: 'invalid' };
        if (!MULTIPLAYER_BACKEND_URL) return { ok: true, offline: true };
        const existing = await fetchNameClaim(nameKey);
        if (existing && existing.pilotId && existing.pilotId !== pilotId) {
            return { ok: false, reason: 'taken' };
        }
        if (existing && existing.pilotId === pilotId) return { ok: true };
        try {
            const res = await fetch(MULTIPLAYER_BACKEND_URL + '/aerodeck_names/' + encodeURIComponent(nameKey) + '.json', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pilotId, claimedAt: Date.now(), name: name.trim().slice(0, 40) })
            });
            if (!res.ok) {
                // race: someone else claimed first
                const again = await fetchNameClaim(nameKey);
                if (again && again.pilotId && again.pilotId !== pilotId) return { ok: false, reason: 'taken' };
                return { ok: false, reason: 'network' };
            }
            return { ok: true };
        } catch (e) {
            return { ok: true, offline: true }; // allow local register if backend down
        }
    }

    // ------------------------------- theme -------------------------------
// ------------------------------- theme -------------------------------
    const THEME_CLASSES = ['theme-violet', 'theme-amber', 'theme-emerald', 'theme-rose', 'theme-sky', 'theme-slate', 'theme-coral', 'theme-lime', 'theme-indigo', 'theme-teal', 'theme-magenta', 'theme-gold', 'theme-mint', 'theme-crimson', 'theme-ocean', 'theme-grape', 'theme-forest'];
    function getTheme() { return gmGet(STORAGE.THEME, 'default'); }
    function setTheme(name) {
        gmSet(STORAGE.THEME, name);
        if (tabletEl) {
            tabletEl.classList.remove(...THEME_CLASSES);
            if (name && name !== 'default') tabletEl.classList.add('theme-' + name);
        }
    }

    // ------------------------------- pilot profile -------------------------------
    function getProfile() { return gmGet(STORAGE.PROFILE, null); }
    function saveProfile(p) { gmSet(STORAGE.PROFILE, p); }
    function clearProfile() { gmSet(STORAGE.PROFILE, null); }
    function genPilotId() {
        const t = Date.now().toString(36).toUpperCase().slice(-4);
        const r = Math.random().toString(36).toUpperCase().slice(2, 6);
        return 'P' + t + r;
    }

    // ------------------------------- flight history -------------------------------
    function getHistory(pilotId) { return gmGet(STORAGE.HISTORY_PREFIX + pilotId, []); }
    function addHistoryRecord(pilotId, record) {
        const list = getHistory(pilotId);
        list.unshift(record);
        if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
        gmSet(STORAGE.HISTORY_PREFIX + pilotId, list);
    }
    function clearHistory(pilotId) { gmSet(STORAGE.HISTORY_PREFIX + pilotId, []); }
    function computeBadge(pilotId) {
        const list = getHistory(pilotId);
        const totalMs = list.reduce((sum, r) => sum + (r.durationMs || 0), 0);
        const hours = totalMs / 3600000;
        let tier;
        if (hours < 10) tier = 'Trainee F/O';
        else if (hours < 50) tier = 'First Officer';
        else if (hours < 150) tier = 'Captain';
        else if (hours < 400) tier = 'Senior Captain';
        else tier = 'Chief Pilot';
        return { hours, tier, flights: list.length };
    }
    function computeCountriesVisited(pilotId) {
        const list = getHistory(pilotId);
        const seen = new Map(); // country -> Set(city)
        list.forEach((r) => {
            [r.origin, r.destination].forEach((icao) => {
                const a = icao && airportsByIcao[icao];
                if (!a || !a.country) return;
                if (!seen.has(a.country)) seen.set(a.country, new Set());
                if (a.city) seen.get(a.country).add(a.city);
            });
        });
        return Array.from(seen.entries()).map(([country, cities]) => ({ country, cities: Array.from(cities) })).sort((a, b) => a.country.localeCompare(b.country));
    }
    const ACHIEVEMENTS = [
        { id: 'first_flight', label: 'First Flight', test: (b) => b.flights >= 1 },
        { id: 'flights_5', label: '5 Flights', test: (b) => b.flights >= 5 },
        { id: 'flights_10', label: '10 Flights', test: (b) => b.flights >= 10 },
        { id: 'flights_25', label: '25 Flights', test: (b) => b.flights >= 25 },
        { id: 'flights_50', label: '50 Flights', test: (b) => b.flights >= 50 },
        { id: 'flights_100', label: 'Centurion', test: (b) => b.flights >= 100 },
        { id: 'flights_250', label: '250 Flights', test: (b) => b.flights >= 250 },
        { id: 'hours_1', label: 'First Hour', test: (b) => b.hours >= 1 },
        { id: 'hours_5', label: '5 Flight Hours', test: (b) => b.hours >= 5 },
        { id: 'hours_10', label: '10 Flight Hours', test: (b) => b.hours >= 10 },
        { id: 'hours_25', label: '25 Flight Hours', test: (b) => b.hours >= 25 },
        { id: 'hours_50', label: '50 Flight Hours', test: (b) => b.hours >= 50 },
        { id: 'hours_100', label: '100 Flight Hours', test: (b) => b.hours >= 100 },
        { id: 'hours_500', label: '500 Flight Hours', test: (b) => b.hours >= 500 },
        { id: 'night_owl', label: 'Night Owl', test: (b) => b.flights >= 10 && b.hours >= 5 },
        { id: 'commuter', label: 'Commuter', test: (b) => b.flights >= 20 },
        { id: 'line_pilot', label: 'Line Pilot', test: (b) => b.flights >= 75 && b.hours >= 40 },
        { id: 'captain', label: 'Captain', test: (b) => b.flights >= 150 && b.hours >= 100 },
        { id: 'veteran', label: 'Veteran', test: (b) => b.flights >= 300 && b.hours >= 250 },
        { id: 'legend', label: 'Legend', test: (b) => b.flights >= 500 && b.hours >= 500 }
    ];

    // ------------------------------- checklist -------------------------------
    const CHECKLIST_PHASES = [
        { title: 'PREFLIGHT', items: ['OFP / SimBrief — IMPORTED OR REVIEWED', 'Weather / METAR — CHECKED', 'Aircraft — DETECTED', 'Weight & balance — REVIEWED'] },
        { title: 'BEFORE START', items: ['Parking brake — SET', 'Doors — CLOSED', 'Passengers — BOARDED', 'Engines — CLEAR TO START'] },
        { title: 'BEFORE TAXI', items: ['Flaps — SET FOR TAKEOFF', 'Flight controls — CHECKED', 'Doors — CONFIRMED CLOSED'] },
        { title: 'BEFORE TAKEOFF', items: ['Flaps — CONFIRMED', 'Runway — CLEAR'] },
        { title: 'CLIMB', items: ['Gear — UP', 'Flaps — RETRACTED', 'Autopilot — AS REQUIRED'] },
        { title: 'CRUISE', items: ['Cruise altitude — CONFIRMED', 'Nav / ETA — REVIEWED'] },
        { title: 'DESCENT', items: ['Destination METAR — CHECKED', 'Altitude / descent plan — SET'] },
        { title: 'APPROACH', items: ['Approach briefing — COMPLETE', 'Gear — DOWN', 'Flaps — APPROACH'] },
        { title: 'BEFORE LANDING', items: ['Flaps — LANDING', 'Gear — DOWN AND LOCKED', 'Spoilers — ARMED'] },
        { title: 'AFTER LANDING', items: ['Flaps — UP', 'Spoilers — RETRACTED', 'Taxi route — CLEARED'] },
        { title: 'SHUTDOWN', items: ['Parking brake — SET', 'Engines — OFF', 'Doors — OPEN', 'Passengers — DEPLANE'] }
    ];
    function blankChecklistState() { return CHECKLIST_PHASES.map((p) => p.items.map(() => false)); }
    function getChecklistState(pilotId) {
        const saved = gmGet(STORAGE.CHECKLIST_PREFIX + pilotId, null);
        if (saved && Array.isArray(saved) && saved.length === CHECKLIST_PHASES.length) return saved;
        return blankChecklistState();
    }
    function saveChecklistState(pilotId, state) { gmSet(STORAGE.CHECKLIST_PREFIX + pilotId, state); }

    // ------------------------------- flight (current session) -------------------------------
    function blankFlight() {
        return {
            flightNumberText: '', originText: '', destText: '',
            airline: null, airlineNotFound: false,
            origin: null, originNotFound: false,
            destination: null, destNotFound: false,
            aircraft: null, capacity: null, doors: [],
            active: false, startTimestamp: null,
            paxTargetText: '', paxTarget: 0, paxError: null,
            boardingStatus: 'idle', boardingStartTs: null, boardingDurationMs: null,
            simbrief: null
        };
    }
    let flight = blankFlight();

    // ------------------------------- SimBrief import -------------------------------
    function getSimbriefUsername() { return gmGet(STORAGE.SIMBRIEF_USERNAME, ''); }
    function saveSimbriefUsername(name) { gmSet(STORAGE.SIMBRIEF_USERNAME, (name || '').trim()); }
    let simbrief = {
        usernameText: getSimbriefUsername(),
        status: 'idle', // idle | loading | ready | error
        error: null,
        raw: null,
        weights: null
    };
    async function fetchSimbriefPlan(username) {
        const clean = (username || '').trim();
        if (!clean) {
            simbrief.status = 'error';
            simbrief.error = 'Enter a SimBrief username first.';
            render();
            return;
        }
        simbrief.status = 'loading';
        simbrief.error = null;
        render();
        try {
            const url = `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(clean)}&json=v2`;
            const textBody = await gmFetchText(url, 12000);
            let json;
            try { json = JSON.parse(textBody); } catch (pe) {
                simbrief.status = 'error';
                simbrief.error = 'No SimBrief plan found for that username — check the spelling, or generate a flight plan on SimBrief first.';
                render();
                return;
            }
            if (json && (json.fetch || json.status) && String(json.fetch || json.status).toLowerCase().includes('error')) {
                simbrief.status = 'error';
                simbrief.error = 'No SimBrief plan found for that username — check the spelling, or generate a flight plan on SimBrief first.';
                render();
                return;
            }
            console.log('[AeroDeck] SimBrief raw OFP response:', json);
            simbrief.raw = json;
            simbrief.weights = parseSimbriefWeights(json);
            simbrief.status = 'ready';
            saveSimbriefUsername(clean);
        } catch (e) {
            const msg = (e && e.message) ? String(e.message) : '';
            if (msg.includes('400') || msg.toLowerCase().includes('bad status')) {
                simbrief.status = 'error';
                simbrief.error = 'No SimBrief plan found for that username — check the spelling, or generate a flight plan on SimBrief first.';
            } else {
                simbrief.status = 'error';
                simbrief.error = 'Could not reach SimBrief (network error or blocked). Try again shortly.';
            }
            console.warn('[AeroDeck] SimBrief fetch failed:', e);
        }
        render();
    }
    function parseSimbriefWeights(json) {
        if (!json) return null;
        const w = json.weights || {};
        const f = json.fuel || {};
        const g = json.general || {};
        const t = json.times || {};
        const p = json.params || {};
        const unit = (p.units || w.unit || 'lbs').toLowerCase().startsWith('k') ? 'kgs' : 'lbs';
        const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
        const fmtUnixUtc = (v) => {
            const n = num(v);
            if (n == null) return null;
            if (n < 1e8) return null;
            const d = new Date(n * 1000);
            if (isNaN(d.getTime())) return null;
            return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        };
        const fmtDurationSec = (v) => {
            const n = num(v);
            if (n == null) return null;
            if (n > 1e8) return null;
            const s = Math.max(0, Math.round(n));
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };
        const fmtClockLoose = (v) => {
            if (v == null || v === '') return null;
            const asUnix = fmtUnixUtc(v);
            if (asUnix) return asUnix;
            const s = String(v);
            if (/^\d{3,4}$/.test(s)) {
                const pad = s.padStart(4, '0');
                return `${pad.slice(0, 2)}:${pad.slice(2, 4)}`;
            }
            if (/^\d{1,2}:\d{2}/.test(s)) return s.slice(0, 5);
            return fmtDurationSec(v);
        };
        let dateDisplay = null;
        const rawDate = p.date || p.date_time || g.flight_date || null;
        if (rawDate) {
            const ds = String(rawDate);
            const m = ds.match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
            if (m) dateDisplay = `${m[1]} ${m[2].charAt(0).toUpperCase()}${m[2].slice(1).toLowerCase()} ${m[3].length === 2 ? m[3] : m[3].slice(-2)}`;
            else dateDisplay = ds;
        }
        let depTime = fmtUnixUtc(t.sched_out) || fmtUnixUtc(t.est_out) || fmtUnixUtc(t.est_off);
        if (!depTime && p.deph != null) {
            depTime = `${String(p.deph).padStart(2, '0')}:${String(p.depm != null ? p.depm : 0).padStart(2, '0')}`;
        }
        const arrTime = fmtUnixUtc(t.sched_in) || fmtUnixUtc(t.est_in) || fmtUnixUtc(t.est_on);
        const airTime = fmtDurationSec(t.est_time_enroute) || fmtDurationSec(t.sched_time_enroute);
        const blockTime = fmtDurationSec(t.est_block) || fmtDurationSec(t.sched_block);
        const depUnix = num(t.sched_out) || num(t.est_out) || num(t.est_off);
        const arrUnix = num(t.sched_in) || num(t.est_in) || num(t.est_on);

        const fuelPlanned = num(f.plan_ramp) != null ? num(f.plan_ramp) : num(w.est_fuel);
        const acType = (json.aircraft && (json.aircraft.icao_code || json.aircraft.icaocode || json.aircraft.type))
            || g.aircraft_icao || g.icao_aircraft || p.type || null;
        return {
            unit,
            paxCount:    num(w.pax_count),
            cargo:       num(w.cargo),
            payload:     num(w.payload),
            zfw:         num(w.est_zfw),
            maxZfw:      num(w.max_zfw),
            tow:         num(w.est_tow),
            maxTow:      num(w.max_tow),
            ldw:         num(w.est_ldw),
            maxLdw:      num(w.max_ldw),
            oew:         num(w.oew) != null ? num(w.oew) : num(w.est_oew),
            fuelPlanned,
            fuelTaxi:    num(f.taxi),
            fuelEnroute: num(f.enroute_burn),
            originIcao:  json.origin && (json.origin.icao_code || json.origin.icao),
            destIcao:    json.destination && (json.destination.icao_code || json.destination.icao),
            flightNo:    `${g.icao_airline || ''}${g.flight_number || ''}`,
            route:       g.route || '',
            dateDisplay,
            depTime,
            arrTime,
            airTime,
            blockTime,
            depUnix: depUnix && depUnix > 1e8 ? depUnix : null,
            arrUnix: arrUnix && arrUnix > 1e8 ? arrUnix : null,
            aircraftType: acType ? String(acType).toUpperCase() : null
        };
    }

    const JET_A_KG_PER_GAL = 3.028;
    const JET_A_KG_TO_GAL = 1 / JET_A_KG_PER_GAL;
    function fuelToKg(value, unit) {
        if (value == null) return null;
        const u = (unit || 'lbs').toLowerCase();
        if (u.startsWith('k')) return value;
        return value * 0.453592;
    }
    function formatFuelDual(value, unit) {
        if (value == null) return '—';
        const kg = fuelToKg(value, unit);
        const gal = kg * JET_A_KG_TO_GAL;
        return `${Math.round(kg).toLocaleString()} kg / ${Math.round(gal).toLocaleString()} gal Jet A`;
    }
    function estimateVspeedsFromTow(towKg) {
        if (towKg == null || !Number.isFinite(towKg) || towKg <= 0) return null;
        const ratio = Math.min(1.15, Math.max(0.75, towKg / 70000));
        const v2 = Math.round(130 + 40 * ratio);
        const vr = Math.round(v2 - 6);
        const v1 = Math.round(vr - 4);
        return { v1, vr, v2 };
    }


    // ------------------------------- Fuel system -------------------------------
    const ADFuel = {
        isActive: false,
        fuelPercentage: 100,
        fuelCapacityGal: 0,
        currentFuelGal: 0,
        consumptionRateGalPerSec: 0,
        capacityMultiplier: 0.635,
        consumptionMultiplier: 0.05,
        lastTick: 0,
        hooked: false,
        _origTick: null,
        STORAGE_PCT: 'aerodeck_fuel_pct',
        STORAGE_ACTIVE: 'aerodeck_fuel_active',
        getAircraft() {
            try { return geofs.aircraft.instance; } catch (e) { return null; }
        },
        getMassKg() {
            const a = this.getAircraft();
            try { return (a && a.definition && a.definition.mass) || 1000; } catch (e) { return 1000; }
        },
        hasEngines() {
            const a = this.getAircraft();
            return !!(a && a.engines && a.engines.length);
        },
        recalculateCapacity() {
            const massKg = this.getMassKg();
            const oldPct = this.fuelPercentage;
            this.fuelCapacityGal = massKg * this.capacityMultiplier * JET_A_KG_TO_GAL;
            this.currentFuelGal = this.fuelCapacityGal * oldPct / 100;
            this.fuelPercentage = this.fuelCapacityGal > 0 ? (this.currentFuelGal / this.fuelCapacityGal) * 100 : 0;
        },
        activate() {
            if (!this.hasEngines()) return false;
            this.recalculateCapacity();
            this.isActive = true;
            gmSet(this.STORAGE_ACTIVE, true);
            this.hookTick();
            return true;
        },
        deactivate() {
            this.isActive = false;
            gmSet(this.STORAGE_ACTIVE, false);
        },
        canRefuel() {
            try {
                const a = this.getAircraft();
                if (!a) return { ok: false, reason: 'No aircraft.' };
                const onGround = !!(a.groundContact || (a.collResult && a.collResult.location));
                let agl = null;
                try { agl = a.animationValue && a.animationValue.relativeAltitude; } catch (e) {}
                try { if (agl == null && geofs.animation && geofs.animation.values) agl = geofs.animation.values.relativeAltitude; } catch (e) {}
                const grounded = onGround || (agl != null && agl < 5);
                if (!grounded) return { ok: false, reason: 'Must be on the ground to refuel.' };
                let enginesHot = false;
                if (a.engines && a.engines.length) {
                    enginesHot = a.engines.some((e) => Math.abs(e.rpm || 0) > 50 || Math.abs(e.currentThrust || 0) > 10);
                }
                if (enginesHot) return { ok: false, reason: 'Engines must be off (or at idle) to refuel.' };
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: 'Cannot verify ground/engine state.' };
            }
        },
        refuel(percentage) {
            const gate = this.canRefuel();
            if (!gate.ok && percentage > this.fuelPercentage) {
                alert(gate.reason);
                return false;
            }
            percentage = Math.max(0, Math.min(100, percentage));
            if (this.fuelCapacityGal <= 0) this.recalculateCapacity();
            this.fuelPercentage = percentage;
            this.currentFuelGal = this.fuelCapacityGal * percentage / 100;
            const a = this.getAircraft();
            if (a && percentage > 0 && a.crashed) a.crashed = false;
            gmSet(this.STORAGE_PCT, percentage);
            return true;
        },
        refuelToKg(targetKg) {
            if (this.fuelCapacityGal <= 0) this.recalculateCapacity();
            const capacityKg = this.fuelCapacityGal * JET_A_KG_PER_GAL;
            if (capacityKg <= 0) return;
            const pct = Math.max(0, Math.min(100, (targetKg / capacityKg) * 100));
            this.refuel(pct);
            if (!this.isActive) this.activate();
            return pct;
        },
        onEmpty() {
            const a = this.getAircraft();
            if (!a) return;
            a.crashed = true;
            try { if (typeof a.stopEngine === 'function') a.stopEngine(); } catch (e) { /* ignore */ }
            try {
                if (a.engines) {
                    a.engines.forEach((e) => {
                        try {
                            e.rpm = 0;
                            e.currentThrust = 0;
                            if (e.thrust != null) e.thrust = 0;
                            if (e.on != null) e.on = false;
                        } catch (x) {}
                    });
                }
            } catch (e) { /* ignore */ }
            try {
                if (window.controls) {
                    if (controls.throttle != null) controls.throttle = 0;
                    if (controls.states && controls.states.throttle != null) controls.states.throttle = 0;
                }
            } catch (e) { /* ignore */ }
            try {
                if (window.geofs && geofs.animation && geofs.animation.values) {
                    const av = geofs.animation.values;
                    if (av.engineRunning != null) av.engineRunning = 0;
                    if (av.rpm != null) av.rpm = 0;
                    if (av.throttle != null) av.throttle = 0;
                    if (av.enginesOn != null) av.enginesOn = 0;
                }
            } catch (e) { /* ignore */ }
            try {
                if (a.groundContact && a.rigidBody && a.rigidBody.v_linearVelocity) {
                    const v = a.rigidBody.v_linearVelocity;
                    const spd = Math.sqrt((v[0]||0)**2 + (v[1]||0)**2 + (v[2]||0)**2);
                    if (spd < 30) {
                        a.rigidBody.v_linearVelocity = [0, 0, 0];
                    }
                }
            } catch (e) { /* ignore */ }
        },
        tick(deltaSec) {
            if (!this.isActive) return;
            try { if (geofs.pause) return; } catch (e) { /* ignore */ }
            const a = this.getAircraft();
            if (!a || !a.engines || !a.engines.length) return;
            let totalGalPerSec = 0;
            for (let i = 0; i < a.engines.length; i++) {
                const eng = a.engines[i];
                const thrust = Math.abs((eng && eng.currentThrust) || 0);
                const rpm = Math.abs((eng && eng.rpm) || 0);
                if (!rpm) continue;
                totalGalPerSec += (thrust / rpm) * this.consumptionMultiplier * JET_A_KG_TO_GAL;
            }
            this.consumptionRateGalPerSec = totalGalPerSec;
            if (this.fuelPercentage > 0) {
                this.currentFuelGal = Math.max(0, this.currentFuelGal - totalGalPerSec * deltaSec);
                this.fuelPercentage = this.fuelCapacityGal > 0 ? (this.currentFuelGal / this.fuelCapacityGal) * 100 : 0;
                if (a.crashed) a.crashed = false;
            }
            if (this.fuelPercentage <= 0) {
                this.fuelPercentage = 0;
                this.currentFuelGal = 0;
                this.onEmpty();
            } else if (this.fuelPercentage < 12 && this.fuelPercentage > 0) {
                this._maybeLowFuelWarn();
            }
        },
        _lastLowWarn: 0,
        _maybeLowFuelWarn() {
            const now = Date.now();
            if (now - this._lastLowWarn < 120000) return;
            try {
                if (!flight.active || !flight.destination) return;
                const pos = getCurrentLatLon();
                if (!pos || flight.destination.lat == null) return;
                const remNm = haversineNM(pos.lat, pos.lon, flight.destination.lat, flight.destination.lon);
                const spd = getCurrentGroundSpeedKts() || 400;
                const hours = remNm / Math.max(50, spd);
                const burnGalPerHr = (this.consumptionRateGalPerSec || 0.01) * 3600;
                const needGal = burnGalPerHr * hours * 1.15;
                if (this.currentFuelGal < needGal || this.fuelPercentage < 8) {
                    this._lastLowWarn = now;
                    alert('FUEL CRITICAL — remaining fuel may not reach destination. Divert to the nearest suitable airport.');
                }
            } catch (e) { /* ignore */ }
        },
        hookTick() {
            if (this.hooked) return;
            try {
                if (!window.geofs || !geofs.aircraft) return;
                const self = this;
                this._interval = setInterval(() => {
                    const now = Date.now();
                    const dt = self.lastTick ? Math.min(2, (now - self.lastTick) / 1000) : 0.25;
                    self.lastTick = now;
                    self.tick(dt);
                }, 250);
                this.hooked = true;
            } catch (e) { /* ignore */ }
        },
        currentWeightKg() {
            const oew = this.getMassKg();
            const payloadKg = (flight.simbrief && flight.simbrief.payload != null)
                ? fuelToKg(flight.simbrief.payload, flight.simbrief.unit)
                : (flight.paxTarget || 0) * 95;
            const fuelKg = this.currentFuelGal * JET_A_KG_PER_GAL;
            return { oew, payloadKg, fuelKg, gw: oew + (payloadKg || 0) + fuelKg };
        }
    };
    function applyPhysicalMassFromWeights() {
        try {
            const a = geofs.aircraft.instance;
            if (!a || !a.definition || !a.rigidBody) return;
            const wt = ADFuel.currentWeightKg();
            const kg = Math.max(500, wt.gw || wt.oew);
            a.definition.mass = kg;
            if (typeof a.rigidBody.setMassProps === 'function') {
                a.rigidBody.setMassProps(kg, a.definition.tensorFactor || 0.1);
            }
        } catch (e) { /* ignore */ }
    }

    try {
        if (gmGet(ADFuel.STORAGE_ACTIVE, false)) {
            const pct = gmGet(ADFuel.STORAGE_PCT, 100);
            ADFuel.fuelPercentage = typeof pct === 'number' ? pct : 100;
        }
    } catch (e) { /* ignore */ }

function applySimbriefToFlight() {
        if (!simbrief.weights) return;
        const w = simbrief.weights;
        if (w.paxCount != null) {
            flight.paxTarget = Math.round(w.paxCount);
            flight.paxTargetText = String(Math.round(w.paxCount));
            if (flight.boardingStatus !== 'boarding') flight.boardingStatus = 'idle';
            flight.paxError = null;
        }
        flight.simbrief = {
            used: true,
            unit: w.unit,
            payload: w.payload,
            cargo: w.cargo,
            zfw: w.zfw, maxZfw: w.maxZfw,
            tow: w.tow, maxTow: w.maxTow,
            ldw: w.ldw, maxLdw: w.maxLdw,
            fuelPlanned: w.fuelPlanned,
            aircraftType: w.aircraftType || null,
            depUnix: w.depUnix || null,
            arrUnix: w.arrUnix || null,
            depTime: w.depTime, arrTime: w.arrTime,
            airTime: w.airTime, blockTime: w.blockTime
        };
        if (w.originIcao) {
            flight.originText = w.originIcao;
            flight.origin = lookupAirport(w.originIcao);
            flight.originNotFound = !flight.origin;
        }
        if (w.destIcao) {
            flight.destText = w.destIcao;
            flight.destination = lookupAirport(w.destIcao);
            flight.destNotFound = !flight.destination;
        }
        if (w.flightNo) {
            flight.flightNumberText = w.flightNo;
            const found = lookupAirline(w.flightNo);
            flight.airline = found;
            flight.airlineNotFound = !found;
        }
        render();
    }
    function renderSimbriefSummaryHtml(w) {
        const fmt = (v) => v == null ? '—' : `${Math.round(v).toLocaleString()} ${w.unit}`;
        let depCountdown = '';
        if (w.depUnix) {
            const mins = Math.round((w.depUnix * 1000 - Date.now()) / 60000);
            if (mins > 0) depCountdown = `in ${mins} min`;
            else if (mins > -120) depCountdown = 'departed / past';
        }
        return `
            <div class="aerodeck-card">
                <div class="aerodeck-summary-sub">${w.flightNo ? escapeHtml(w.flightNo) + ' · ' : ''}${escapeHtml(w.originIcao || '')} &rarr; ${escapeHtml(w.destIcao || '')}${w.dateDisplay ? ' · ' + escapeHtml(w.dateDisplay) : ''}${w.aircraftType ? ' · ' + escapeHtml(w.aircraftType) : ''}</div>
                <div class="aerodeck-track-grid" style="margin-top:8px;">
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${escapeHtml(w.depTime || '—')}</div><div class="aerodeck-track-label">Dep UTC${depCountdown ? ' · ' + escapeHtml(depCountdown) : ''}</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${escapeHtml(w.arrTime || '—')}</div><div class="aerodeck-track-label">Arr UTC</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${escapeHtml(w.airTime || '—')}</div><div class="aerodeck-track-label">Air Time</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${escapeHtml(w.blockTime || '—')}</div><div class="aerodeck-track-label">Block Time</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${w.paxCount != null ? w.paxCount : '—'}</div><div class="aerodeck-track-label">Passengers</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(w.payload)}</div><div class="aerodeck-track-label">Payload</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:11px;">${escapeHtml(formatFuelDual(w.fuelPlanned, w.unit))}</div><div class="aerodeck-track-label">Planned Fuel</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(w.tow)}</div><div class="aerodeck-track-label">Est. TOW</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(w.zfw)}</div><div class="aerodeck-track-label">Est. ZFW</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(w.ldw)}</div><div class="aerodeck-track-label">Est. LDW</div></div>
                </div>
            </div>
        `;
    }


    function getDoorsForCapacity(cap) {
        const c = cap == null ? 150 : cap;
        if (c <= 90) {
            return [
                { id: 'L1', label: 'LEFT FWD', type: 'pax', open: true },
                { id: 'R1', label: 'RIGHT FWD', type: 'pax', open: true },
                { id: 'FWDCARGO', label: 'FWD CARGO', type: 'cargo', open: true },
                { id: 'L2', label: 'LEFT AFT', type: 'pax', open: true },
                { id: 'R2', label: 'RIGHT AFT', type: 'pax', open: true }
            ];
        }
        if (c <= 260) {
            return [
                { id: 'L1', label: 'LEFT FWD', type: 'pax', open: true },
                { id: 'R1', label: 'RIGHT FWD', type: 'pax', open: true },
                { id: 'FWDCARGO', label: 'FWD CARGO', type: 'cargo', open: true },
                { id: 'L2', label: 'LEFT MID', type: 'pax', open: true },
                { id: 'R2', label: 'RIGHT MID', type: 'pax', open: true },
                { id: 'AFTCARGO', label: 'AFT CARGO', type: 'cargo', open: true },
                { id: 'L3', label: 'LEFT AFT', type: 'pax', open: true },
                { id: 'R3', label: 'RIGHT AFT', type: 'pax', open: true }
            ];
        }
        return [
            { id: 'L1', label: 'LEFT FWD', type: 'pax', open: true },
            { id: 'R1', label: 'RIGHT FWD', type: 'pax', open: true },
            { id: 'FWDCARGO', label: 'FWD CARGO', type: 'cargo', open: true },
            { id: 'L2', label: 'LEFT MID', type: 'pax', open: true },
            { id: 'R2', label: 'RIGHT MID', type: 'pax', open: true },
            { id: 'BULKCARGO', label: 'BULK CARGO', type: 'cargo', open: true },
            { id: 'AFTCARGO', label: 'AFT CARGO', type: 'cargo', open: true },
            { id: 'L3', label: 'LEFT AFT', type: 'pax', open: true },
            { id: 'R3', label: 'RIGHT AFT', type: 'pax', open: true }
        ];
    }
    function buildDoorsDiagramHtml(doors) {
        if (!doors || !doors.length) return '';
        const POS = {
            L1: { left: 2, top: 18 },
            R1: { left: 66, top: 18 },
            FWDCARGO: { left: 66, top: 28 },
            L2: { left: 2, top: 42 },
            R2: { left: 66, top: 42 },
            BULKCARGO: { left: 66, top: 52 },
            AFTCARGO: { left: 66, top: 60 },
            L3: { left: 2, top: 72 },
            R3: { left: 66, top: 72 },
            L4: { left: 2, top: 82 },
            R4: { left: 66, top: 82 }
        };
        const chips = doors.map((d, i) => {
            const p = POS[d.id] || { left: (d.id && String(d.id)[0] === 'R') ? 66 : 2, top: 15 + i * 9 };
            const open = !!d.open;
            return `<button type="button" class="door-chip-btn ${open ? 'open' : 'closed'}" data-id="${escapeHtml(d.id)}"
                style="left:${p.left}%;top:${p.top}%;">
                <span class="door-chip-label">${escapeHtml(d.label)}</span>
                <span class="door-chip-state">${open ? 'OPEN' : 'CLOSED'}</span>
            </button>`;
        }).join('');
        const plane = `
            <svg viewBox="0 0 200 360" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" class="door-plane-svg">
                <g class="door-plane" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.85">
                    <path d="M100 18 C108 18 114 30 114 48 L114 300 C114 320 106 340 100 348 C94 340 86 320 86 300 L86 48 C86 30 92 18 100 18 Z"/>
                    <path d="M100 18 C96 10 96 6 100 4 C104 6 104 10 100 18"/>
                    <path d="M86 150 L18 190 L22 200 L86 175 Z"/>
                    <path d="M114 150 L182 190 L178 200 L114 175 Z"/>
                    <ellipse cx="48" cy="188" rx="10" ry="16"/>
                    <ellipse cx="152" cy="188" rx="10" ry="16"/>
                    <path d="M86 300 L50 330 L54 334 L86 312 Z"/>
                    <path d="M114 300 L150 330 L146 334 L114 312 Z"/>
                    <path d="M100 300 L100 348 L92 336 L100 300 L108 336 Z"/>
                </g>
            </svg>`;
        return `
            <div class="aerodeck-doors-diagram">
                ${plane}
                <div class="door-chips-layer">${chips}</div>
            </div>`;
    }


    function setAllDoors(doors, open) {
        return doors.map((d) => Object.assign({}, d, { open: !!open }));
    }
    function getBoardedCount() {
        if (flight.boardingStatus === 'complete') return flight.paxTarget;
        if (flight.boardingStatus !== 'boarding') return 0;
        const elapsed = Date.now() - flight.boardingStartTs;
        const frac = Math.min(1, elapsed / flight.boardingDurationMs);
        if (frac >= 1) { flight.boardingStatus = 'complete'; return flight.paxTarget; }
        return Math.round(flight.paxTarget * frac);
    }
    function getStartFlightChecks() {
        const doorsClosed = flight.doors.length > 0 && flight.doors.every((d) => !d.open);
        const boardingDone = flight.boardingStatus === 'complete' || flight.paxTarget === 0;
        return [
            { label: 'On ground', ok: getOnGround() },
            { label: 'Parking brake set', ok: getParkingBrakeSet() },
            { label: 'All doors closed', ok: doorsClosed },
            { label: 'Boarding complete', ok: boardingDone }
        ];
    }
    function getEndFlightChecks() {
        return [
            { label: 'On ground', ok: getOnGround() },
            { label: 'Parking brake set', ok: getParkingBrakeSet() },
            { label: 'Engines off', ok: getEnginesOff() }
        ];
    }
    let __nearestAirportCache = { ts: 0, nm: null };
    function findNearestAirportDistanceNM() {
        const now = Date.now();
        if (now - __nearestAirportCache.ts < 5000) return __nearestAirportCache.nm;
        const pos = getCurrentLatLon();
        if (!pos || !airportsByIcao) {
            __nearestAirportCache = { ts: now, nm: null };
            return null;
        }
        let bestNM = Infinity;
        for (const icao in airportsByIcao) {
            const apt = airportsByIcao[icao];
            if (apt.lat == null || apt.lon == null) continue;
            const d = haversineNM(pos.lat, pos.lon, apt.lat, apt.lon);
            if (d < bestNM) bestNM = d;
        }
        const result = Number.isFinite(bestNM) ? bestNM : null;
        __nearestAirportCache = { ts: now, nm: result };
        return result;
    }
    function getNearAirportStatus() {
        if (getOnGround()) return { ok: true, note: null };
        const nm = findNearestAirportDistanceNM();
        if (nm == null) return { ok: false, note: 'Position unavailable' };
        if (nm <= 3) return { ok: true, note: null };
        return { ok: false, note: `Not near an airport (${nm.toFixed(1)} NM to nearest)` };
    }
    function isNearAirportForEnd() {
        return getNearAirportStatus().ok;
    }
    function checksHtml(checks) {
        return `<div class="aerodeck-checks">${checks.map((c) => `
            <div class="aerodeck-check-row ${c.ok ? 'ok' : ''}">
                <span class="aerodeck-check-icon">${c.ok ? '&#10003;' : '&#8594;'}</span>
                <span>${escapeHtml(c.label)}</span>
            </div>`).join('')}</div>`;
    }

    // ------------------------------- MAP tab state -------------------------------
    let leafletMap = null, ownMarker = null, originMarker = null, destMarker = null, waypointsLayer = null;
    let multiplayerLayer = null, multiplayerEnabled = true, followAircraft = true, leafletLoadPromise = null;
    let miniLeafletMap = null, miniOwnMarker = null, miniPresenceLayer = null;

    function ensureLeaflet() {
        if (window.L) return Promise.resolve();
        if (leafletLoadPromise) return leafletLoadPromise;
        leafletLoadPromise = new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(link);
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load the map library (check your connection).'));
            document.head.appendChild(script);
        });
        return leafletLoadPromise;
    }
    function getGeofsWaypoints() {
        const waypoints = [];
        try {
            const nodes = document.querySelectorAll('.geofs-waypointIdent');
            nodes.forEach((el) => {
                let lat = parseFloat(el.parentElement && el.parentElement.dataset && el.parentElement.dataset.lat);
                let lon = parseFloat(el.parentElement && el.parentElement.dataset && el.parentElement.dataset.lon);
                const name = el.textContent.trim().toUpperCase().replace(/[0-9.,\s-]+$/, '');
                if ((isNaN(lat) || isNaN(lon)) && window.geofs && geofs.nav && geofs.nav.flightPlan) {
                    const match = geofs.nav.flightPlan.find((p) => p.ident === name);
                    if (match) { lat = match.lat; lon = match.lon; }
                }
                if (name && name !== '---' && !isNaN(lat) && !isNaN(lon)) waypoints.push({ name, lat, lon });
            });
        } catch (e) { /* GeoFS flight-plan UI not open / not available */ }
        return waypoints;
    }
    function drawRoute() {
        if (!leafletMap) return;
        if (waypointsLayer) { leafletMap.removeLayer(waypointsLayer); waypointsLayer = null; }
        const wpts = getGeofsWaypoints();
        let latlngs = null;
        if (wpts.length >= 2) latlngs = wpts.map((w) => [w.lat, w.lon]);
        else if (flight.origin && flight.destination && flight.origin.lat != null && flight.destination.lat != null) latlngs = [[flight.origin.lat, flight.origin.lon], [flight.destination.lat, flight.destination.lon]];
        if (!latlngs) return;
        waypointsLayer = L.layerGroup().addTo(leafletMap);
        L.polyline(latlngs, { color: '#22d3ee', weight: 2, dashArray: wpts.length >= 2 ? null : '6 6', opacity: 0.75 }).addTo(waypointsLayer);
        if (wpts.length >= 2) wpts.forEach((w) => L.circleMarker([w.lat, w.lon], { radius: 4, color: '#22d3ee', weight: 2, fillColor: '#0b1622', fillOpacity: 1 }).bindTooltip(w.name).addTo(waypointsLayer));
        leafletMap.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
    }

    function planeDivIcon(color, headingDeg) {
        const svg = `<svg width="26" height="26" viewBox="0 0 40 40" style="transform:rotate(${headingDeg || 0}deg);">
            <path d="M20 2C21 2 22 5 22 8L22 15L36 19L36 22L22 18L22 32L28 35L28 37L20 35.5L12 37L12 35L18 32L18 18L4 22L4 19L18 15L18 8C18 5 19 2 20 2Z"
                fill="${color}" stroke="#052024" stroke-width="1.2"/>
        </svg>`;
        return L.divIcon({ html: svg, className: 'aerodeck-plane-icon', iconSize: [26, 26], iconAnchor: [13, 13] });
    }
    function initMap(canvasEl) {
        const startPos = getCurrentLatLon() || (flight.origin ? { lat: flight.origin.lat, lon: flight.origin.lon } : { lat: 0, lon: 0 });
        leafletMap = L.map(canvasEl, { attributionControl: true, zoomControl: true }).setView([startPos.lat, startPos.lon], 7);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(leafletMap);
        ownMarker = L.marker([startPos.lat, startPos.lon], { icon: planeDivIcon('#facc15', getCurrentHeading() || 0) }).addTo(leafletMap);
        const profile = getProfile();
        ownMarker.bindTooltip(buildAircraftTooltip(profile ? profile.name : 'You', flight.origin, flight.destination, getCurrentGroundSpeedKts(), getCurrentAltitudeFt()), { direction: 'top' });
        if (flight.origin && flight.origin.lat != null) originMarker = L.circleMarker([flight.origin.lat, flight.origin.lon], { radius: 5, color: '#34d399', fillColor: '#34d399', fillOpacity: 1 }).bindTooltip(flight.origin.icao).addTo(leafletMap);
        if (flight.destination && flight.destination.lat != null) destMarker = L.circleMarker([flight.destination.lat, flight.destination.lon], { radius: 5, color: '#f0a35e', fillColor: '#f0a35e', fillOpacity: 1 }).bindTooltip(flight.destination.icao).addTo(leafletMap);
        drawRoute();
        multiplayerLayer = L.layerGroup().addTo(leafletMap);
        setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 150);
        updateMapLive();
    }
    function buildAircraftTooltip(callsign, origin, dest, speed, alt) {
        const route = origin && dest ? `${origin.icao || origin} → ${dest.icao || dest}` : 'No route set';
        const spd = speed != null ? `${Math.round(speed)} kt` : '—';
        const altTxt = alt != null ? `${alt.toLocaleString()} ft` : '—';
        return `<div style="font-family:Consolas,monospace;font-size:11px;"><b>${escapeHtml(callsign)}</b><br>${escapeHtml(route)}<br>${spd} · ${altTxt}</div>`;
    }
    function buildAircraftTooltipText(callsign, origin, dest, speed, alt) {
        const route = origin && dest ? `${origin.icao || origin} -> ${dest.icao || dest}` : 'No route set';
        const spd = speed != null ? `${Math.round(speed)} kt` : '--';
        const altTxt = alt != null ? `${Math.round(alt).toLocaleString()} ft` : '--';
        return `${callsign}\n${route}\n${spd} / ${altTxt}`;
    }
    function renderPresenceMarkers() {
        if (!multiplayerLayer) return;
        multiplayerLayer.clearLayers();
        if (!multiplayerEnabled) return;
        cachedPresence.forEach((u) => {
            const m = L.marker([u.lat, u.lon], { icon: planeDivIcon('#3b82f6', u.heading || 0) }).addTo(multiplayerLayer);
            m.bindTooltip(buildAircraftTooltip(u.callsign, u.origin, u.destination, u.speed, u.altitude), { direction: 'top' });
        });
    }
    function renderMiniPresenceMarkers() {
        if (!miniPresenceLayer) return;
        miniPresenceLayer.clearLayers();
        if (!multiplayerEnabled) return;
        cachedPresence.forEach((u) => {
            const m = L.marker([u.lat, u.lon], { icon: planeDivIcon('#3b82f6', u.heading || 0) }).addTo(miniPresenceLayer);
            m.bindTooltip(buildAircraftTooltip(u.callsign, u.origin, u.destination, u.speed, u.altitude), { direction: 'top' });
        });
    }
    function refreshPresenceIfStale() {
        if (!MULTIPLAYER_BACKEND_URL) return;
        const apply = (list) => {
            cachedPresence = list;
            renderPresenceMarkers();
            renderMiniPresenceMarkers();
            if (chartState) updateChartOtherAircraft();
        };
        if (Date.now() - lastPresenceFetch > 5000) {
            lastPresenceFetch = Date.now();
            const profile = getProfile();
            fetchAeroDeckPresence(profile ? profile.id : null).then(apply);
        } else apply(cachedPresence);
    }
    function destroyMiniMap() {
        if (miniLeafletMap) { try { miniLeafletMap.remove(); } catch (e) { /* ignore */ } }
        miniLeafletMap = null; miniOwnMarker = null; miniPresenceLayer = null;
    }
    function initMiniMap(canvasEl) {
        destroyMiniMap();
        const startPos = getCurrentLatLon() || (flight.origin ? { lat: flight.origin.lat, lon: flight.origin.lon } : { lat: 0, lon: 0 });
        miniLeafletMap = L.map(canvasEl, { attributionControl: false, zoomControl: false, dragging: true, scrollWheelZoom: true }).setView([startPos.lat, startPos.lon], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(miniLeafletMap);
        miniOwnMarker = L.marker([startPos.lat, startPos.lon], { icon: planeDivIcon('#facc15', getCurrentHeading() || 0) }).addTo(miniLeafletMap);
        const profile = getProfile();
        miniOwnMarker.bindTooltip(buildAircraftTooltip(profile ? profile.name : 'You', flight.origin, flight.destination, getCurrentGroundSpeedKts(), getCurrentAltitudeFt()), { direction: 'top' });
        miniPresenceLayer = L.layerGroup().addTo(miniLeafletMap);
        renderMiniPresenceMarkers();
        setTimeout(() => { if (miniLeafletMap) miniLeafletMap.invalidateSize(); }, 120);
    }
    function updateMapLive() {
        const pos = getCurrentLatLon();
        if (leafletMap && ownMarker) {
            ownMarker.setLatLng([pos ? pos.lat : ownMarker.getLatLng().lat, pos ? pos.lon : ownMarker.getLatLng().lng]);
            if (pos) {
                ownMarker.setIcon(planeDivIcon('#facc15', getCurrentHeading() || 0));
                if (followAircraft) leafletMap.panTo([pos.lat, pos.lon], { animate: true });
            }
        }
        if (miniLeafletMap && miniOwnMarker && pos) {
            miniOwnMarker.setLatLng([pos.lat, pos.lon]);
            miniOwnMarker.setIcon(planeDivIcon('#facc15', getCurrentHeading() || 0));
            miniLeafletMap.panTo([pos.lat, pos.lon], { animate: false });
        }
        refreshPresenceIfStale();
        if (chatEnabled && Date.now() - lastChatFetch > CHAT_POLL_MS) { lastChatFetch = Date.now(); fetchAndRenderChat(); }
    }
    function renderMapTab(container) {
        container.innerHTML = `
            <div class="aerodeck-map-wrap">
            <div class="aerodeck-map-toolbar">
                <label class="aerodeck-map-toggle"><input type="checkbox" id="aerodeck-map-follow" ${followAircraft ? 'checked' : ''}> Follow aircraft</label>
                <label class="aerodeck-map-toggle"><input type="checkbox" id="aerodeck-map-mp" ${multiplayerEnabled ? 'checked' : ''}> Show other AeroDeck pilots</label>
                <span class="aerodeck-map-phase" id="aerodeck-map-phase-badge"></span>
            </div>
            <div id="aerodeck-map-status" class="aerodeck-card muted" style="display:none;"></div>
            <div id="aerodeck-map-canvas"></div>
            <button id="aerodeck-map-refresh-route" class="aerodeck-btn secondary">REFRESH ROUTE FROM GEOFS FLIGHT PLAN</button>
            </div>
        `;
        container.querySelector('#aerodeck-map-follow').onchange = (e) => { followAircraft = e.target.checked; };
        container.querySelector('#aerodeck-map-mp').onchange = (e) => { multiplayerEnabled = e.target.checked; updateMapLive(); };
        container.querySelector('#aerodeck-map-refresh-route').onclick = () => drawRoute();
        const statusEl = container.querySelector('#aerodeck-map-status');
        ensureLeaflet().then(() => {
            const canvas = container.querySelector('#aerodeck-map-canvas');
            if (!canvas) return;
            initMap(canvas);
        }).catch((err) => { statusEl.style.display = 'block'; statusEl.innerHTML = `<div class="aerodeck-warn">${escapeHtml(err.message)}</div>`; });
    }

    // ------------------------------- CHARTS tab -------------------------------
    const chartDataCache = {};
    let chartMode = 'origin'; // 'origin' | 'destination' | 'search'
    const chartViewState = {}; // icao -> { zoom, panX, panY }, remembered across tab switches / minimize
    let chartSearchText = '';
    let chartLoadState = { status: 'idle', icao: null, error: null };
    let chartsMaximized = false;
    let chartState = null;

    async function loadChartData(icao) {
        if (Object.prototype.hasOwnProperty.call(chartDataCache, icao)) return chartDataCache[icao];
        if (window.AERODECK_CHARTS && window.AERODECK_CHARTS[icao]) { chartDataCache[icao] = window.AERODECK_CHARTS[icao]; return chartDataCache[icao]; }
        try {
            const text = await gmFetchText(`${CHARTS_BASE_URL}/${icao}.json`);
            const json = JSON.parse(text);
            chartDataCache[icao] = json;
            return json;
        } catch (e) { chartDataCache[icao] = null; return null; }
    }
    const CHART_FREQ_ORDER = { ATIS: 0, CLD: 1, GND: 2, TWR: 3, APP: 4, DEP: 5, UNICOM: 6 };
    function normalizeFreqMhz(v) { return v > 200 ? Math.round((v / 10) * 1000) / 1000 : v; }

    function buildChartSVG(container, data, icao) {
        container.innerHTML = '';
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 1000 700');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('id', 'aerodeck-chart-svg');
        container.appendChild(svg);
        function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
        const viewport = el('g', { id: 'chart-viewport' });
        svg.appendChild(viewport);
        const originLat = data.airport.lat, originLon = data.airport.lon;
        const R = 6371000;
        function toMeters(lat, lon) {
            const dLat = (lat - originLat) * Math.PI / 180, dLon = (lon - originLon) * Math.PI / 180;
            return [dLon * Math.cos(originLat * Math.PI / 180) * R, -dLat * R];
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        function extend(x, y) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        data.runways.forEach((r) => r.ends.forEach((e) => { const [x, y] = toMeters(e.lat, e.lon); extend(x, y); }));
        data.pavements.forEach((p) => p.points.forEach((pt) => { const [x, y] = toMeters(pt.lat, pt.lon); extend(x, y); }));
        const VB_W = 1000, VB_H = 700, PAD = 40;
        const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
        const scale = Math.min((VB_W - 2 * PAD) / spanX, (VB_H - 2 * PAD) / spanY);
        const cx = (minX + maxX) / 2, cyc = (minY + maxY) / 2;
        function px(lat, lon) { const [x, y] = toMeters(lat, lon); return [(x - cx) * scale + VB_W / 2, (y - cyc) * scale + VB_H / 2]; }

        const gApron = el('g', {});
        function terminalKey(name) { if (!name) return null; const m = name.trim().match(/^(T\d+)\b/i); return m ? m[1].toUpperCase() : null; }
        function pointInPoly(x, y, pts) {
            let inside = false;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
                const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        }
        const apronShapes = data.pavements.filter((p) => p.kind === 'apron' && p.closed).map((p) => ({ pts: p.points.map((pt) => px(pt.lat, pt.lon)), votes: {} }));
        (data.gates || []).forEach((g) => {
            const key = terminalKey(g.name);
            if (!key) return;
            const [gx, gy] = px(g.lat, g.lon);
            let match = apronShapes.find((a) => pointInPoly(gx, gy, a.pts));
            if (!match) {
                let best = null, bestD = Infinity;
                apronShapes.forEach((a) => {
                    const acx = a.pts.reduce((s, p) => s + p[0], 0) / a.pts.length, acy = a.pts.reduce((s, p) => s + p[1], 0) / a.pts.length;
                    const d = Math.hypot(acx - gx, acy - gy);
                    if (d < bestD) { bestD = d; best = a; }
                });
                if (best && bestD < 55) match = best;
            }
            if (match) match.votes[key] = (match.votes[key] || 0) + 1;
        });
        apronShapes.forEach((a) => {
            const entries = Object.entries(a.votes);
            const label = entries.length ? entries.sort((x, y) => y[1] - x[1])[0][0] : null;
            const pts = a.pts.map((p) => p.join(',')).join(' ');
            gApron.appendChild(el('polygon', { points: pts, class: label ? 'apron terminal' : 'apron' }));
            if (label) {
                const acx = a.pts.reduce((s, p) => s + p[0], 0) / a.pts.length;
                const topY = Math.min(...a.pts.map((p) => p[1]));
                const t = el('text', { x: acx, y: topY - 6, class: 'terminal-label', 'text-anchor': 'middle' });
                t.textContent = label;
                gApron.appendChild(t);
            }
        });
        viewport.appendChild(gApron);

        const gRwy = el('g', {}), gRwyLabels = el('g', {}), runwayPolys = [];
        // Shared collision registry: every label placed anywhere on the chart reserves
        // its box here, and every later label (taxi, then gate) is skipped if it would
        // land on top of something already placed. Runways go first (highest priority,
        // rarely crowded), then named taxiways, then LINK segments, then gate numbers —
        // so the numerous small gate labels are the ones that yield space, not the
        // taxiway names pilots actually need to read.
        const placedLabelRects = [];
        function estLabelWidth(text, fontSize) { return String(text).length * fontSize * 0.62 + 2; }
        function labelRect(cx, cy, text, fontSize) {
            const w = estLabelWidth(text, fontSize), h = fontSize * 1.25;
            return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
        }
        function rectFree(rect, pad) {
            const p = pad == null ? 1.5 : pad;
            return !placedLabelRects.some((r) => !(rect.x2 + p < r.x1 || rect.x1 - p > r.x2 || rect.y2 + p < r.y1 || rect.y1 - p > r.y2));
        }
        data.runways.forEach((r) => {
            const [x1, y1] = px(r.ends[0].lat, r.ends[0].lon), [x2, y2] = px(r.ends[1].lat, r.ends[1].lon);
            const wPx = Math.max(r.width_m * scale, 5);
            const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
            const nx = -dy / len * wPx / 2, ny = dx / len * wPx / 2;
            const polyPts = [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]];
            runwayPolys.push(polyPts);
            gRwy.appendChild(el('polygon', { points: polyPts.map((p) => p.join(',')).join(' '), class: 'runway' }));
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;
            const rot = angle > 90 || angle < -90 ? angle + 180 : angle;
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            const centerText = r.ends[0].id + ' / ' + r.ends[1].id;
            const centerLabel = el('text', { x: 0, y: 3, class: 'rwy-label', 'text-anchor': 'middle' });
            centerLabel.textContent = centerText;
            centerLabel.setAttribute('transform', `translate(${mx},${my}) rotate(${rot})`);
            gRwyLabels.appendChild(centerLabel);
            placedLabelRects.push(labelRect(mx, my, centerText, 14));
            [[x1, y1, dx, dy, r.ends[0].id], [x2, y2, -dx, -dy, r.ends[1].id]].forEach(([ex, ey, ddx, ddy, id]) => {
                const inLen = Math.hypot(ddx, ddy);
                const ix = ex + ddx / inLen * 22, iy = ey + ddy / inLen * 22;
                const eLabel = el('text', { x: 0, y: 3, class: 'rwy-label', 'text-anchor': 'middle' });
                eLabel.textContent = id;
                eLabel.setAttribute('transform', `translate(${ix},${iy}) rotate(${rot})`);
                gRwyLabels.appendChild(eLabel);
                placedLabelRects.push(labelRect(ix, iy, id, 14));
            });
        });
        viewport.appendChild(gRwy);

        const gTaxi = el('g', {}), gTaxiLabels = el('g', {});
        const nodes = data.taxi_network.nodes, groups = {};
        (data.taxi_network.edges || []).forEach((e) => {
            const a = nodes[e.n1], b = nodes[e.n2];
            if (!a || !b) return;
            const [x1, y1] = px(a.lat, a.lon), [x2, y2] = px(b.lat, b.lon);
            gTaxi.appendChild(el('line', { x1, y1, x2, y2, class: 'taxi-line' }));
            (groups[e.name] = groups[e.name] || []).push({ x1, y1, x2, y2 });
        });
        viewport.appendChild(gTaxi);
        function pointInAnyRunway(x, y) {
            for (const pts of runwayPolys) {
                let inside = false;
                for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
                    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
                    if (intersect) inside = !inside;
                }
                if (inside) return true;
            }
            return false;
        }
        const TAXI_LABEL_SPACING = 210;
        // Named taxiways get first pick of space, LINK segments (Gateway's unnamed
        // connector ids, not real charted designators) are placed after and yield to them.
        const groupNames = Object.keys(groups).sort((a, b) => {
            const la = /^link\d*$/i.test(a) ? 1 : 0, lb = /^link\d*$/i.test(b) ? 1 : 0;
            return la - lb;
        });
        groupNames.forEach((name) => {
            let lastX = null, lastY = null;
            const isLink = /^link\d*$/i.test((name || '').trim());
            const fontSize = isLink ? 9 : 11;
            groups[name].forEach((seg) => {
                const mx = (seg.x1 + seg.x2) / 2, my = (seg.y1 + seg.y2) / 2;
                if (pointInAnyRunway(mx, my)) return;
                if (lastX === null || Math.hypot(mx - lastX, my - lastY) >= TAXI_LABEL_SPACING) {
                    const rect = labelRect(mx, my, name, fontSize);
                    if (!rectFree(rect)) return;
                    const t = el('text', { x: mx, y: my, class: isLink ? 'taxi-label taxi-label-link' : 'taxi-label taxi-label-named', 'text-anchor': 'middle' });
                    t.textContent = name;
                    gTaxiLabels.appendChild(t);
                    placedLabelRects.push(rect);
                    lastX = mx; lastY = my;
                }
            });
        });
        viewport.appendChild(gTaxiLabels);
        viewport.appendChild(gRwyLabels);

        const gGates = el('g', {});
        function shortGateLabel(name) { if (!name) return ''; const parts = name.trim().split(/\s+/); return parts[parts.length - 1]; }
        const GATE_LABEL_SPACING = 32, GATE_TICK_SPACING = 9, placedGateLabels = [], placedGateTicks = [];
        (data.gates || []).forEach((g) => {
            const [x, y] = px(g.lat, g.lon);
            const tickTooClose = placedGateTicks.some((p) => Math.hypot(p[0] - x, p[1] - y) < GATE_TICK_SPACING);
            if (tickTooClose) return;
            placedGateTicks.push([x, y]);
            const tick = el('line', { x1: x, y1: y - 3, x2: x, y2: y + 3, class: 'gate-tick' });
            tick.appendChild(el('title', {})).textContent = (g.name || 'Gate') + (g.airline_code ? ' · ' + g.airline_code.toUpperCase() : '');
            gGates.appendChild(tick);
            const gateText = shortGateLabel(g.name);
            const tooCloseToGate = placedGateLabels.some((p) => Math.hypot(p[0] - x, p[1] - y) < GATE_LABEL_SPACING);
            const rect = labelRect(x + 4 + estLabelWidth(gateText, 8.5) / 2, y + 2.5, gateText, 8.5);
            if (!tooCloseToGate && rectFree(rect)) {
                const t = el('text', { x: x + 4, y: y + 2.5, class: 'gate-label' }); t.textContent = gateText; gGates.appendChild(t);
                placedGateLabels.push([x, y]);
                placedLabelRects.push(rect);
            }
        });
        viewport.appendChild(gGates);

        const acEl = el('polygon', { points: '0,-14 9,11 0,4 -9,11', class: 'aircraft' });
        const acTitle = el('title', {});
        acEl.appendChild(acTitle);
        viewport.appendChild(acEl);
        const gOthers = el('g', { id: 'chart-other-aircraft' });
        viewport.appendChild(gOthers);

        const freqByType = {};
        (data.frequencies || []).forEach((f) => {
            const mhz = normalizeFreqMhz(f.freq_mhz), key = f.label || f.type;
            if (!freqByType[key] || freqByType[key] > mhz) freqByType[key] = mhz;
        });
        const freqRows = Object.keys(freqByType).map((label) => ({ label, mhz: freqByType[label], order: CHART_FREQ_ORDER[(data.frequencies.find((f) => (f.label || f.type) === label) || {}).type] ?? 9 })).sort((a, b) => a.order - b.order);

        const savedView = icao ? chartViewState[icao] : null;
        let zoom = savedView ? savedView.zoom : 1, panX = savedView ? savedView.panX : 0, panY = savedView ? savedView.panY : 0;
        function applyTransform() {
            viewport.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
            if (icao) chartViewState[icao] = { zoom, panX, panY };
        }
        applyTransform(); // apply the restored view immediately, don't wait for the first zoom/pan action
        function onWheel(e) { e.preventDefault(); e.stopPropagation(); const factor = e.deltaY > 0 ? 0.9 : 1.1; zoom = Math.min(6, Math.max(0.5, zoom * factor)); applyTransform(); }
        let dragging = false, lastX = 0, lastY = 0;
        function onDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; }
        function onMove(e) { if (!dragging) return; panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; applyTransform(); }
        function onUp() { dragging = false; }
        if (container.__aerodeckPanCleanup) container.__aerodeckPanCleanup();
        container.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('mousedown', onDown);
        container.addEventListener('mousemove', onMove);
        container.addEventListener('mouseup', onUp);
        container.addEventListener('mouseleave', onUp);
        container.__aerodeckPanCleanup = () => {
            container.removeEventListener('wheel', onWheel);
            container.removeEventListener('mousedown', onDown);
            container.removeEventListener('mousemove', onMove);
            container.removeEventListener('mouseup', onUp);
            container.removeEventListener('mouseleave', onUp);
        };
        return { svg, px, acEl, acTitle, gOthers, freqRows };
    }
    function renderChartLegend(legendEl, freqRows) {
        const swatches = `
            <div><span class="chart-sw" style="background:#213a56"></span>Apron / ramp</div>
            <div><span class="chart-sw" style="background:#2e4a6c"></span>Terminal ramp</div>
            <div><span class="chart-sw" style="background:#0a1420;border:1px solid #dfe6ee"></span>Runway</div>
            <div><span class="chart-sw" style="background:#6ee7b7"></span>Taxiway</div>
            <div><span class="chart-sw" style="background:#6b8bb0"></span>Link segment</div>
            <div><span class="chart-sw" style="background:#e9b8f2"></span>Gate / stand</div>
            <div><span class="chart-sw" style="background:#f6c343"></span>You</div>
            <div><span class="chart-sw" style="background:#3b82f6"></span>Other pilots</div>`;
        const freqHtml = freqRows.length ? `<div class="chart-legend-freqs">${freqRows.map((r) => `<div><span class="chart-freq-label">${escapeHtml(r.label)}</span><span class="chart-freq-val">${r.mhz.toFixed(3)}</span></div>`).join('')}</div>` : '';
        legendEl.innerHTML = swatches + freqHtml;
    }
    function updateChartAircraft() {
        if (!chartState) return;
        const pos = getCurrentLatLon();
        if (!pos) return;
        const heading = getCurrentHeading() || 0;
        const [x, y] = chartState.px(pos.lat, pos.lon);
        const within = x > -300 && x < 1300 && y > -300 && y < 1000;
        chartState.acEl.style.display = within ? '' : 'none';
        chartState.acEl.setAttribute('transform', `translate(${x},${y}) rotate(${heading})`);
        if (chartState.acTitle) {
            const profile = getProfile();
            chartState.acTitle.textContent = buildAircraftTooltipText(profile ? profile.name : 'You', flight.origin, flight.destination, getCurrentGroundSpeedKts(), getCurrentAltitudeFt());
        }
    }
    function updateChartOtherAircraft() {
        if (!chartState || !chartState.gOthers) return;
        const NS = 'http://www.w3.org/2000/svg';
        chartState.gOthers.innerHTML = '';
        if (!multiplayerEnabled) return;
        cachedPresence.forEach((u) => {
            const [x, y] = chartState.px(u.lat, u.lon);
            const within = x > -300 && x < 1300 && y > -300 && y < 1000;
            if (!within) return;
            const poly = document.createElementNS(NS, 'polygon');
            poly.setAttribute('points', '0,-7 5,6 0,2 -5,6');
            poly.setAttribute('class', 'other-aircraft');
            poly.setAttribute('transform', `translate(${x},${y}) rotate(${u.heading || 0})`);
            const title = document.createElementNS(NS, 'title');
            title.textContent = buildAircraftTooltipText(u.callsign, u.origin, u.destination, u.speed, u.altitude);
            poly.appendChild(title);
            chartState.gOthers.appendChild(poly);
        });
    }
    function currentChartTargetIcao() {
        if (chartMode === 'origin') return flight.origin ? flight.origin.icao : null;
        if (chartMode === 'destination') return flight.destination ? flight.destination.icao : null;
        return chartSearchText ? chartSearchText.toUpperCase() : null;
    }
    function renderChartsTab(container) {
        container.innerHTML = `
            <div class="aerodeck-chart-wrap">
            <div class="aerodeck-mode-toggle">
                <button class="aerodeck-mode-btn ${chartMode === 'origin' ? 'active' : ''}" data-mode="origin">ORIGIN${flight.origin ? ' · ' + flight.origin.icao : ''}</button>
                <button class="aerodeck-mode-btn ${chartMode === 'destination' ? 'active' : ''}" data-mode="destination">DEST${flight.destination ? ' · ' + flight.destination.icao : ''}</button>
                <button class="aerodeck-mode-btn ${chartMode === 'search' ? 'active' : ''}" data-mode="search">SEARCH</button>
                <button id="aerodeck-chart-maximize-btn" class="aerodeck-icon-btn aerodeck-chart-maximize-btn" title="${chartsMaximized ? 'Restore' : 'Maximize chart'}">${chartsMaximized ? ICON_MINIMIZE : ICON_CHARTS}</button>
            </div>
            <div id="aerodeck-chart-search-row" style="display:${chartMode === 'search' ? 'flex' : 'none'};gap:8px;margin-bottom:10px;">
                <input id="aerodeck-chart-icao-input" class="aerodeck-input" style="max-width:140px;" type="text" placeholder="ICAO e.g. KJFK" maxlength="4" value="${escapeHtml(chartSearchText)}">
                <button id="aerodeck-chart-load-btn" class="aerodeck-btn secondary" style="margin-top:0;width:auto;padding:8px 14px;">LOAD</button>
            </div>
            <div id="aerodeck-chart-status" class="aerodeck-card muted" style="display:none;"></div>
            <div id="aerodeck-chart-stage" style="position:relative;flex:1;min-height:0;">
                <div id="aerodeck-chart-canvas"></div>
                <div id="aerodeck-chart-legend" class="aerodeck-chart-legend"></div>
            </div>
            </div>
        `;
        container.querySelectorAll('.aerodeck-mode-btn').forEach((btn) => {
            btn.onclick = () => { chartMode = btn.getAttribute('data-mode'); render(); };
        });
        const maximizeBtn = container.querySelector('#aerodeck-chart-maximize-btn');
        if (maximizeBtn) maximizeBtn.onclick = () => {
            chartsMaximized = !chartsMaximized;
            if (tabletEl) tabletEl.classList.toggle('charts-maximized', chartsMaximized);
            render();
            setTimeout(() => { if (chartState) updateChartAircraft(); }, 60);
        };
        if (tabletEl) tabletEl.classList.toggle('charts-maximized', chartsMaximized && activeTab === 'charts');
        const statusEl = container.querySelector('#aerodeck-chart-status');
        function renderStatus() {
            if (chartLoadState.status === 'loading') { statusEl.style.display = 'block'; statusEl.innerHTML = `Loading diagram for ${escapeHtml(chartLoadState.icao)}…`; }
            else if (chartLoadState.status === 'missing') { statusEl.style.display = 'block'; statusEl.innerHTML = `<div class="aerodeck-warn">No diagram available yet for ${escapeHtml(chartLoadState.icao)}. Charts are added over time — request this airport on the AeroDeck repo Issues page.</div>`; }
            else if (chartLoadState.status === 'error') { statusEl.style.display = 'block'; statusEl.innerHTML = `<div class="aerodeck-warn">${escapeHtml(chartLoadState.error)}</div>`; }
            else if (chartLoadState.status === 'none') { statusEl.style.display = 'block'; statusEl.innerHTML = `<div class="aerodeck-warn">Set an origin/destination in the Flight tab, or use Search.</div>`; }
            else statusEl.style.display = 'none';
        }
        function doLoad(icao) {
            if (!icao || !/^[A-Z]{4}$/.test(icao)) { chartLoadState = { status: 'none', icao: null, error: null }; renderStatus(); return; }
            chartLoadState = { status: 'loading', icao, error: null };
            renderStatus();
            loadChartData(icao).then((data) => {
                if (currentChartTargetIcao() !== icao) return;
                if (!data) { chartLoadState = { status: 'missing', icao, error: null }; renderStatus(); return; }
                chartLoadState = { status: 'ready', icao, error: null };
                renderStatus();
                const canvas = container.querySelector('#aerodeck-chart-canvas');
                const legendEl = container.querySelector('#aerodeck-chart-legend');
                if (!canvas) return;
                const built = buildChartSVG(canvas, data, icao);
                chartState = built;
                renderChartLegend(legendEl, built.freqRows);
                updateChartAircraft();
            });
        }
        if (chartMode === 'search') {
            const input = container.querySelector('#aerodeck-chart-icao-input');
            const doSearch = () => { chartSearchText = input.value.trim().toUpperCase(); doLoad(chartSearchText); };
            container.querySelector('#aerodeck-chart-load-btn').onclick = doSearch;
            input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
            doLoad(chartSearchText || null);
        } else {
            doLoad(currentChartTargetIcao());
        }
    }

    // ------------------------------- state -------------------------------
    let confirmingResetProfile = false, confirmingClearHistory = false;
    let activeTab = 'home'; // home | flight | charts | map | chat | checklist | history
    let checklistState = blankChecklistState();
    let panelOpen = false, minimized = false, backdropEl = null, tabletEl = null, dragAbort = null;
    let miniSizeIndex = 0; // locked mini sizes
    const MINI_SIZES = [{ w: 300, h: 180 }, { w: 380, h: 240 }];
    let showCountriesModal = false, showAchievementsModal = false;

    const ICON_BRAND = `<svg viewBox="0 0 64 64" width="40" height="40"><rect x="12" y="6" width="40" height="52" rx="6" fill="none" stroke="#22d3ee" stroke-width="3"/><path d="M22 30 L28 24 L36 34 L42 22" fill="none" stroke="#34d399" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="53.5" r="2" fill="#22d3ee"/></svg>`;
    const ICON_HOME = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 11l9-8 9 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10v10h14V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ICON_FLIGHT = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ICON_CHECK = `<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ICON_MAP = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
    const ICON_CHARTS = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20V10M12 20V4M20 20v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    const ICON_CHAT = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 5h16v11H8l-4 4V5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
    const ICON_AIRCRAFT = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M2 16l8-2.5L21 5l-1.5 6.5L10 14l-1 5-2.5-1L8 14 2 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 14l4 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

    const ICON_OFP = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    const ICON_NAV = `<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 12l4-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    const ICON_GALLERY = `<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 17l5-4 4 3 4-5 5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    const ICON_SETTINGS = `<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 13a7.7 7.7 0 000-2l2-1.5-2-3.4-2.3.9a7.6 7.6 0 00-1.8-1L15 3h-4l-.3 2.5a7.6 7.6 0 00-1.8 1l-2.3-.9-2 3.4L6.6 11a7.7 7.7 0 000 2l-2 1.5 2 3.4 2.3-.9c.55.44 1.16.79 1.8 1L11 21h4l.3-2.5c.64-.21 1.25-.56 1.8-1l2.3.9 2-3.4-2-1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    const ICON_HISTORY = `<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 3.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const ICON_PLUS = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
    const ICON_MINIMIZE = `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
    const ICON_SEARCH = `<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M20 20l-4.5-4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
    const ICON_SIGNAL = (ok) => `<svg viewBox="0 0 20 14" width="16" height="12"><rect x="0" y="9" width="3" height="5" rx="1" fill="${ok ? '#5eead4' : '#3d5675'}"/><rect x="5" y="6" width="3" height="8" rx="1" fill="${ok ? '#5eead4' : '#3d5675'}"/><rect x="10" y="3" width="3" height="11" rx="1" fill="${ok !== false ? '#5eead4' : '#3d5675'}"/><rect x="15" y="0" width="3" height="14" rx="1" fill="${ok === true ? '#5eead4' : '#3d5675'}"/></svg>`;
    const ICON_BATTERY = (pct) => {
        const p = Math.max(5, Math.min(100, pct == null ? 100 : pct));
        const fillW = Math.max(2, Math.round(17 * p / 100));
        const col = p > 20 ? '#5eead4' : '#f87171';
        return `<svg viewBox="0 0 24 12" width="20" height="10"><rect x="0.5" y="0.5" width="20" height="11" rx="2" fill="none" stroke="#8397ae"/><rect x="2" y="2" width="${fillW}" height="8" rx="1" fill="${col}"/><rect x="21" y="4" width="2" height="4" rx="1" fill="#8397ae"/></svg>`;
    };
    const batterySessionStart = Date.now();
    function getCosmeticBatteryPct() {
        const hours = (Date.now() - batterySessionStart) / 3600000;
        return Math.max(8, Math.round(100 - hours * 4)); // ~4% per hour
    }

    function injectStyles() {
        const existing = document.getElementById('aerodeck-style');
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = 'aerodeck-style';
        style.textContent = `
            #aerodeck-backdrop { position: fixed; inset: 0; background: rgba(4,9,17,0.62); z-index: 99998; backdrop-filter: blur(1.5px); }
            #aerodeck-tablet {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: min(640px, 94vw); height: min(480px, 82vh);
                background: #05070a; border-radius: 30px; padding: 12px;
                box-shadow: 0 30px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04) inset;
                z-index: 99999; display: flex; flex-direction: column; min-width: 380px; min-height: 320px; max-width: none; max-height: none;
            }
            #aerodeck-resize-handle { position: absolute; right: 6px; bottom: 6px; width: 18px; height: 18px; cursor: nwse-resize; z-index: 5; opacity: 0.5; }
            #aerodeck-tablet {
                --ad-accent: #22d3ee; --ad-accent2: #34d399; --ad-accent-glow: rgba(34,211,238,0.28);
            }
            #aerodeck-tablet.theme-violet { --ad-accent: #a78bfa; --ad-accent2: #f472b6; --ad-accent-glow: rgba(167,139,250,0.30); }
            #aerodeck-tablet.theme-amber { --ad-accent: #fbbf24; --ad-accent2: #fb7185; --ad-accent-glow: rgba(251,191,36,0.30); }
            #aerodeck-tablet.theme-emerald { --ad-accent: #34d399; --ad-accent2: #6ee7b7; --ad-accent-glow: rgba(52,211,153,0.30); }
            #aerodeck-tablet.theme-rose { --ad-accent: #fb7185; --ad-accent2: #f43f5e; --ad-accent-glow: rgba(251,113,133,0.30); }
            #aerodeck-tablet.theme-sky { --ad-accent: #38bdf8; --ad-accent2: #818cf8; --ad-accent-glow: rgba(56,189,248,0.30); }
            #aerodeck-tablet.theme-slate { --ad-accent: #94a3b8; --ad-accent2: #e2e8f0; --ad-accent-glow: rgba(148,163,184,0.28); }
            #aerodeck-tablet.theme-coral { --ad-accent: #fb923c; --ad-accent2: #f97316; --ad-accent-glow: rgba(251,146,60,0.30); }
            #aerodeck-tablet.theme-lime { --ad-accent: #a3e635; --ad-accent2: #84cc16; --ad-accent-glow: rgba(163,230,53,0.28); }
            #aerodeck-tablet.theme-indigo { --ad-accent: #818cf8; --ad-accent2: #6366f1; --ad-accent-glow: rgba(129,140,248,0.30); }
            #aerodeck-tablet.theme-teal { --ad-accent: #2dd4bf; --ad-accent2: #14b8a6; --ad-accent-glow: rgba(45,212,191,0.28); }
            #aerodeck-tablet.theme-magenta { --ad-accent: #e879f9; --ad-accent2: #d946ef; --ad-accent-glow: rgba(232,121,249,0.30); }
            #aerodeck-tablet.theme-gold { --ad-accent: #f59e0b; --ad-accent2: #eab308; --ad-accent-glow: rgba(245,158,11,0.30); }
            #aerodeck-tablet.theme-mint { --ad-accent: #5eead4; --ad-accent2: #99f6e4; --ad-accent-glow: rgba(94,234,212,0.28); }
            #aerodeck-tablet.theme-crimson { --ad-accent: #ef4444; --ad-accent2: #f87171; --ad-accent-glow: rgba(239,68,68,0.30); }
            #aerodeck-tablet.theme-ocean { --ad-accent: #0ea5e9; --ad-accent2: #22d3ee; --ad-accent-glow: rgba(14,165,233,0.30); }
            #aerodeck-tablet.theme-grape { --ad-accent: #c084fc; --ad-accent2: #a855f7; --ad-accent-glow: rgba(192,132,252,0.30); }
            #aerodeck-tablet.theme-forest { --ad-accent: #22c55e; --ad-accent2: #4ade80; --ad-accent-glow: rgba(34,197,94,0.28); }
            #aerodeck-resize-handle::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 10px; height: 10px; border-right: 2px solid var(--ad-accent); border-bottom: 2px solid var(--ad-accent); border-radius: 0 0 3px 0; }
            #aerodeck-tablet.is-mini { border-radius: 20px; padding: 6px; box-shadow: 0 14px 40px rgba(0,0,0,0.55); }
            #aerodeck-tablet.is-mini #aerodeck-screen { border-radius: 14px; }
            #aerodeck-tablet.is-mini #aerodeck-resize-handle { display: block; }
            #aerodeck-tablet.is-mini #aerodeck-topbar { padding: 6px 10px; cursor: grab; }
            #aerodeck-mini-body { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }
            .aerodeck-mini-toolbar { display: flex; gap: 4px; padding: 4px 6px; flex-shrink: 0; align-items: center; }
            .aerodeck-mini-btn { flex: 1; padding: 5px 0; font-size: 9px; font-weight: 800; letter-spacing: 0.5px; border-radius: 6px; border: 1px solid #1e3552; background: #0e2138; color: #6f85a0; cursor: pointer; }
            .aerodeck-mini-btn.active { background: linear-gradient(180deg,var(--ad-accent2),var(--ad-accent)); color: #052024; border-color: transparent; }
            .aerodeck-mini-icon-btn { flex-shrink: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid #1e3552; background: #0e2138; color: #6f85a0; cursor: pointer; padding: 0; }
            .aerodeck-mini-icon-btn:hover { color: var(--ad-accent); border-color: var(--ad-accent-glow); }
            .aerodeck-mini-search-row { display: flex; gap: 4px; padding: 0 6px 4px; flex-shrink: 0; }
            .aerodeck-mini-search-row .aerodeck-input { padding: 5px 7px; font-size: 11px; letter-spacing: 0.5px; }
            .aerodeck-mini-search-row .aerodeck-btn { margin-top: 0; width: auto; padding: 5px 10px; font-size: 10px; flex-shrink: 0; }
            #aerodeck-mini-canvas { flex: 1; min-height: 0; height: auto !important; border-radius: 8px; overflow: hidden; margin: 0 6px 6px; border: 1px solid #1e3552; background: #0a1729; position: relative; }
            #aerodeck-mini-canvas .leaflet-container { width: 100% !important; height: 100% !important; }
            #aerodeck-mini-nav { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; font-size: 10px; }

            #aerodeck-status-strip { display:flex; align-items:center; justify-content:flex-end; gap:6px; padding: 3px 10px 0; flex-shrink:0; }
            .aerodeck-status-credit { font-size: 8px; color: #4d6076; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap; }
            .aerodeck-status-user { font-size: 9px; color: #8397ae; font-weight: 700; letter-spacing: 0.3px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 4px; }
            .aerodeck-status-time { font-size: 9px; color: #cdd7e2; font-family: 'Consolas', monospace; margin-right: 4px; }
            #aerodeck-screen { flex: 1; min-height: 0; background: linear-gradient(160deg, #0d2036 0%, #081524 100%); border-radius: 20px; overflow: hidden; display: flex; flex-direction: column; color: #eef2f7; font-family: 'Segoe UI', Arial, sans-serif; border: 1px solid var(--ad-accent-glow); }
            #aerodeck-topbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 14px; background: linear-gradient(180deg, #10233c 0%, #0d1e33 100%); border-bottom: 1px solid var(--ad-accent-glow); flex-shrink: 0; cursor: grab; }
            #aerodeck-topbar:active { cursor: grabbing; }
            #aerodeck-topbar .aerodeck-title { font-weight: 800; letter-spacing: 1.6px; color: var(--ad-accent); font-size: 12.5px; white-space: nowrap; }
            .aerodeck-route-strip { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; font-family: 'Consolas', monospace; min-width: 0; font-size: 11.5px; }
            .aerodeck-route-strip .rs-route { font-weight: 800; color: #eef2f7; white-space: nowrap; }
            .aerodeck-route-strip .rs-dist { color: #7f93ab; white-space: nowrap; }
            .aerodeck-route-strip .rs-timer { font-weight: 800; color: var(--ad-accent2); white-space: nowrap; }
            .aerodeck-route-strip .rs-empty { color: #4d6076; letter-spacing: 0.4px; }
            .aerodeck-route-strip .rs-plane { color: var(--ad-accent); display: inline-flex; align-items: center; opacity: 0.9; }
            .aerodeck-topbar-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
            .aerodeck-icon-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); color: #cdd7e2; cursor: pointer; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center; line-height: 0; }
            .aerodeck-icon-btn:hover { color: var(--ad-accent); border-color: var(--ad-accent-glow); }
            #aerodeck-close-x { font-size: 13px; font-weight: 700; padding: 6px 10px; }
            #aerodeck-main { flex: 1; min-height: 0; display: flex; }
            #aerodeck-sidebar { width: 150px; flex-shrink: 0; background: #0a1a2e; border-right: 1px solid var(--ad-accent-glow); display: flex; flex-direction: column; justify-content: space-between; padding: 12px 8px; }
            .aerodeck-nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px; cursor: pointer; color: #6f85a0; font-size: 11.5px; font-weight: 700; letter-spacing: 0.3px; margin-bottom: 3px; transition: background .15s, color .15s; }
            .aerodeck-nav-item:hover { color: #cdd7e2; background: rgba(255,255,255,0.03); }
            .aerodeck-nav-item.active { color: #052024; background: linear-gradient(180deg,var(--ad-accent2),var(--ad-accent)); }
            .aerodeck-nav-item svg { flex-shrink: 0; }
            .aerodeck-sidebar-footer { border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; }
            .aerodeck-link { color: #38bdf8; font-size: 10px; cursor: pointer; white-space: nowrap; }
            .aerodeck-link:hover { color: var(--ad-accent); }
            .aerodeck-link.danger { color: #e0955c; }
            .aerodeck-sidebar-links { margin-top: 4px; display: flex; flex-direction: column; gap: 5px; }
            .aerodeck-confirm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 10px; color: #8397ae; margin-top: 3px; }
            #aerodeck-content { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 16px 18px 24px; display: flex; flex-direction: column; }
            #aerodeck-content.tab-fill { overflow: hidden; padding-bottom: 12px; }
            #aerodeck-tablet.charts-maximized #aerodeck-sidebar { display: none; }
            #aerodeck-tablet.charts-maximized #aerodeck-topbar { padding: 5px 10px; }
            #aerodeck-tablet.charts-maximized #aerodeck-content.tab-fill { padding: 6px; }
            #aerodeck-tablet.charts-maximized .aerodeck-chart-wrap,
            #aerodeck-tablet.charts-maximized #aerodeck-chart-stage { border-radius: 6px; }
            .aerodeck-chart-maximize-btn { margin-left: auto; }
            #aerodeck-content.tab-fill > .aerodeck-chat-panel,
            #aerodeck-content.tab-fill > .aerodeck-chart-wrap,
            #aerodeck-content.tab-fill > .aerodeck-map-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
            .aerodeck-chart-wrap, .aerodeck-map-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
            #aerodeck-content::-webkit-scrollbar { width: 8px; }
            #aerodeck-content::-webkit-scrollbar-thumb { background: #1e3552; border-radius: 4px; }
            .aerodeck-label { font-size: 10px; color: #8397ae; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin-bottom: 6px; margin-top: 14px; }
            .aerodeck-label:first-child { margin-top: 0; }
            .aerodeck-input { width: 100%; box-sizing: border-box; background: #081527; border: 1px solid #223956; color: #eef2f7; padding: 9px 11px; border-radius: 7px; font-size: 14px; font-family: 'Consolas', monospace; letter-spacing: 1px; outline: none; }
            .aerodeck-input:focus { border-color: var(--ad-accent); box-shadow: 0 0 0 3px var(--ad-accent-glow); }
            /* Touch / click responsiveness */
            #aerodeck-tablet, #aerodeck-tablet * { -webkit-tap-highlight-color: transparent; }
            .aerodeck-btn, .aerodeck-btn.secondary, .aerodeck-btn.danger,
            .aerodeck-nav-item, .aerodeck-icon-btn, .aerodeck-mini-btn, .aerodeck-mini-icon-btn,
            .aerodeck-door, .aerodeck-cl-item, .aerodeck-theme-swatch, .aerodeck-map-toggle,
            .aerodeck-card.clickable, button {
                touch-action: manipulation;
                cursor: pointer;
            }
            .aerodeck-btn { background: linear-gradient(180deg, var(--ad-accent2) 0%, var(--ad-accent) 100%); color: #052024; border: none; padding: 11px 13px; border-radius: 8px; font-weight: 800; letter-spacing: 0.5px; cursor: pointer; font-size: 12.5px; margin-top: 14px; width: 100%; }
            .aerodeck-btn:disabled { background: #223956; color: #5c7089; cursor: not-allowed; }
            .aerodeck-btn.secondary { background: transparent; border: 1px solid #223956; color: #8397ae; }
            .aerodeck-btn.secondary:hover { border-color: var(--ad-accent); color: var(--ad-accent); }
            .aerodeck-btn.danger { background: linear-gradient(180deg, #d15a5a 0%, #b23b3b 100%); color: #fff; }
            .aerodeck-card { background: #0e2138; border: 1px solid #1e3552; border-radius: 9px; padding: 12px 14px; margin-top: 8px; }
            .aerodeck-card.muted { text-align: center; color: #5c7089; font-size: 11.5px; border-style: dashed; }
            .aerodeck-row { display: flex; align-items: center; gap: 12px; }
            .aerodeck-logo { width: 48px; height: 48px; border-radius: 9px; background: #16304e; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #22d3ee; font-size: 14px; flex-shrink: 0; overflow: hidden; border: 1px solid #24405f; }
            .aerodeck-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
            .aerodeck-logo.small { width: 24px; height: 24px; font-size: 9px; border-radius: 6px; }
            .aerodeck-airline-name { font-weight: 800; font-size: 14.5px; }
            .aerodeck-airline-meta { font-size: 10.5px; color: #8397ae; margin-top: 3px; line-height: 1.6; }
            .aerodeck-warn { color: #e0955c; font-size: 11.5px; line-height: 1.5; }
            .aerodeck-airport-code { color: #22d3ee; font-weight: 800; font-size: 16px; letter-spacing: 1px; }
            .aerodeck-airport-name { font-size: 12px; margin-top: 3px; }
            .aerodeck-airport-city { font-size: 10.5px; color: #8397ae; margin-top: 1px; }
            .aerodeck-route-arrow { text-align: center; color: #3d5675; font-size: 15px; margin: 2px 0; }
            .aerodeck-data-status { font-size: 9px; color: #4d6076; text-align: left; margin-top: 10px; }
            .aerodeck-track-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 8px; }
            .aerodeck-doors-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 7px; }
            .aerodeck-door { display: flex; justify-content: space-between; align-items: center; padding: 9px 11px; background: #0e2138; border: 1px solid #1e3552; border-radius: 8px; cursor: pointer; font-size: 11.5px; color: #dbe6f0; user-select: none; }
            .aerodeck-door:hover { border-color: rgba(34,211,238,0.4); }
            .aerodeck-door-state { font-size: 9.5px; font-weight: 800; letter-spacing: 0.4px; }
            .aerodeck-door.open .aerodeck-door-state { color: #f0a35e; }
            .aerodeck-door.closed .aerodeck-door-state { color: #34d399; }
            .aerodeck-progress-track { width: 100%; height: 8px; border-radius: 6px; background: #081527; overflow: hidden; }
            .aerodeck-progress-fill { height: 100%; background: linear-gradient(90deg, #5eead4, #22d3ee); transition: width 0.4s ease; }
            .aerodeck-checks { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
            .aerodeck-check-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #e0955c; background: #0e2138; border: 1px solid #1e3552; border-radius: 7px; padding: 8px 12px; }
            .aerodeck-check-row.ok { color: #34d399; }
            .aerodeck-check-icon { font-weight: 800; width: 14px; text-align: center; }
            .aerodeck-track-item { background: #081527; border: 1px solid #1e3552; border-radius: 8px; padding: 9px; text-align: center; }
            .aerodeck-track-value { font-size: 16px; font-weight: 800; color: var(--ad-accent2); font-family: 'Consolas', monospace; }
            .aerodeck-track-label { font-size: 9px; color: #8397ae; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 3px; }
            .aerodeck-summary-route { font-size: 14px; font-weight: 800; }
            .aerodeck-summary-sub { font-size: 10.5px; color: #8397ae; margin-top: 3px; }
            .aerodeck-history-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
            .aerodeck-history-count { font-size: 10.5px; color: #8397ae; }
            .aerodeck-history-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
            .aerodeck-history-row { display: flex; align-items: center; gap: 11px; background: #0e2138; border: 1px solid #1e3552; border-radius: 9px; padding: 10px 12px; }
            .aerodeck-history-row .hr-main { flex: 1; min-width: 0; }
            .aerodeck-hr-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
            .aerodeck-hr-flight { font-weight: 700; font-size: 12.5px; }
            .aerodeck-hr-date { font-size: 10px; color: #5c7089; white-space: nowrap; }
            .aerodeck-hr-route { font-size: 12px; color: #cdd7e2; margin-top: 3px; font-family: 'Consolas', monospace; }
            .aerodeck-hr-meta { font-size: 10px; color: #8397ae; margin-top: 3px; }
            .aerodeck-empty-note { text-align: center; color: #5c7089; font-size: 11.5px; padding: 22px 10px; }
            .aerodeck-reg-wrap { max-width: 320px; margin: 26px auto 0; }
            .aerodeck-metar-icao { font-weight: 800; color: #22d3ee; font-size: 13px; letter-spacing: 1px; margin-bottom: 6px; }
            .aerodeck-metar-raw { font-family: 'Consolas', monospace; font-size: 11.5px; color: #dbe6f0; line-height: 1.6; word-break: break-word; }
            .aerodeck-atis-row { display:flex; justify-content: space-between; font-size: 11px; color:#cdd7e2; padding: 2px 0; }
            .aerodeck-atis-row span:first-child { color:#8397ae; }
            .aerodeck-map-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 9px; }
            .aerodeck-map-toggle { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8397ae; cursor: pointer; user-select: none; }
            .aerodeck-map-toggle input { accent-color: #22d3ee; cursor: pointer; }
            .aerodeck-map-phase { margin-left: auto; font-size: 10.5px; font-weight: 800; letter-spacing: 1px; padding: 3px 9px; border-radius: 20px; border: 1.5px solid #5c7089; color: #8397ae; }
            #aerodeck-map-canvas { flex: 1; min-height: 280px; border-radius: 12px; overflow: hidden; border: 1px solid #1e3552; background: #0a1729; }
            .aerodeck-map-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 8px; }
            #aerodeck-map-canvas .leaflet-control-attribution { font-size: 9px; }
            .aerodeck-mode-toggle { display: flex; gap: 7px; margin-bottom: 11px; }
            .aerodeck-mode-btn { flex: 1; padding: 8px 0; background: #0e2138; border: 1px solid #1e3552; color: #6f85a0; font-size: 10.5px; font-weight: 800; letter-spacing: 0.7px; border-radius: 8px; cursor: pointer; }
            .aerodeck-mode-btn.active { background: linear-gradient(180deg,var(--ad-accent2),var(--ad-accent)); color: #052024; border-color: transparent; }
            #aerodeck-chart-wrap { position: relative; border: 1px solid #1e3552; border-radius: 12px; overflow: hidden; background: #0a1420; margin-top: 4px; }
            #aerodeck-chart-canvas { width: 100%; height: 100%; min-height: 280px; }
            #aerodeck-chart-stage { position: relative; flex: 1; min-height: 0; }
            #aerodeck-chart-stage #aerodeck-chart-canvas { position: absolute; inset: 0; }
            #aerodeck-chart-canvas svg, #aerodeck-mini-canvas svg { width: 100%; height: 100%; display: block; }
            #aerodeck-chart-canvas .apron, #aerodeck-mini-canvas .apron { fill: #213a56; stroke: none; }
            #aerodeck-chart-canvas .apron.terminal, #aerodeck-mini-canvas .apron.terminal { fill: #2e4a6c; }
            #aerodeck-chart-canvas .terminal-label, #aerodeck-mini-canvas .terminal-label { fill: #cfe0ee; font-size: 11px; font-weight: 800; letter-spacing: 1px; }
            #aerodeck-chart-canvas .runway, #aerodeck-mini-canvas .runway { fill: #0a1420; stroke: #f2f6fa; stroke-width: 1.6; }
            #aerodeck-chart-canvas .rwy-label, #aerodeck-mini-canvas .rwy-label { fill: #f6f8fa; font-size: 14px; font-weight: 800; }
            #aerodeck-chart-canvas .taxi-line, #aerodeck-mini-canvas .taxi-line { stroke: #f6c343; stroke-width: 2; opacity: 0.92; }
            #aerodeck-chart-canvas .taxi-label, #aerodeck-mini-canvas .taxi-label { font-weight: 800; }
            #aerodeck-chart-canvas .taxi-label-named, #aerodeck-mini-canvas .taxi-label-named { fill: #6ee7b7; font-size: 11px; }
            #aerodeck-chart-canvas .taxi-label-link, #aerodeck-mini-canvas .taxi-label-link { fill: #6b8bb0; font-size: 9px; font-weight: 700; }
            #aerodeck-chart-canvas .gate-tick, #aerodeck-mini-canvas .gate-tick { stroke: #e39bef; stroke-width: 1.8; }
            #aerodeck-chart-canvas .gate-label, #aerodeck-mini-canvas .gate-label { fill: #e9b8f2; font-size: 8.5px; font-weight: 600; }
            #aerodeck-chart-canvas .aircraft, #aerodeck-mini-canvas .aircraft { fill: #f6c343; stroke: #052024; stroke-width: 0.6; }
            #aerodeck-chart-canvas .other-aircraft, #aerodeck-mini-canvas .other-aircraft { fill: #3b82f6; stroke: #052024; stroke-width: 0.6; opacity: 0.92; }
            .aerodeck-chart-legend { position: absolute; left: 10px; top: 10px; background: rgba(5,10,18,0.82); border: 1px solid #1e3552; border-radius: 8px; padding: 9px 11px; font-size: 10px; color: #cfe0ee; display: flex; flex-direction: column; gap: 4px; max-width: 140px; }
            .aerodeck-chart-legend > div { display: flex; align-items: center; gap: 7px; }
            .chart-sw { width: 11px; height: 11px; border-radius: 3px; flex-shrink: 0; display: inline-block; }
            .chart-legend-freqs { border-top: 1px solid #1e3552; margin-top: 4px; padding-top: 6px; display: flex; flex-direction: column; gap: 3px; }
            .chart-legend-freqs > div { display: flex; justify-content: space-between; gap: 10px; }
            .chart-freq-label { color: #8397ae; font-weight: 700; letter-spacing: 0.5px; }
            .chart-freq-val { color: #22d3ee; font-family: 'Consolas', monospace; }
            .aerodeck-chat-panel { display: flex; flex-direction: column; border: 1px solid #1e3552; border-radius: 12px; overflow: hidden; background: #0a1729; height: calc(100% - 8px); min-height: 280px; }
            .aerodeck-chat-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 9px; }
            .aerodeck-chat-row { display: flex; }
            .aerodeck-chat-row.self { justify-content: flex-end; }
            .aerodeck-chat-row.other { justify-content: flex-start; }
            .aerodeck-chat-bubble { max-width: 78%; padding: 8px 12px; border-radius: 14px 14px 14px 4px; background: #132a44; border: 1px solid #1e3552; }
            .aerodeck-chat-row.self .aerodeck-chat-bubble { border-radius: 14px 14px 4px 14px; background: linear-gradient(180deg, rgba(52,211,153,0.22), rgba(34,211,238,0.12)); border-color: rgba(52,211,153,0.4); }
            .aerodeck-chat-bubble .chat-name { font-size: 9.5px; font-weight: 800; color: var(--ad-accent); letter-spacing: 0.3px; margin-bottom: 3px; }
            .aerodeck-chat-bubble .chat-text { font-size: 12.5px; color: #eef2f7; line-height: 1.45; word-break: break-word; }
            .aerodeck-chat-input-row { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #1e3552; background: #0e2038; }
            .aerodeck-chat-input-row .aerodeck-input { flex: 1; border-radius: 20px; padding: 9px 15px; }
            .aerodeck-chat-input-row .aerodeck-btn { margin-top: 0; width: auto; padding: 10px 18px; border-radius: 20px; }

            .aerodeck-doors-diagram { position: relative; background: #0a1729; border: 1px solid #1e3552; border-radius: 12px; padding: 8px; margin-top: 6px; color: #7dd3fc; min-height: 280px; }
            .aerodeck-doors-diagram .door-plane-svg { display: block; width: 100%; height: 300px; pointer-events: none; }
            .aerodeck-doors-diagram .door-chips-layer { position: absolute; inset: 8px; pointer-events: none; }
            .aerodeck-doors-diagram .door-chip-btn {
                position: absolute; pointer-events: auto; z-index: 2;
                width: 32%; max-width: 110px; padding: 5px 4px; border-radius: 7px;
                border: 1.5px solid #3d5675; background: #132a44; color: #eef2f7;
                cursor: pointer; font-family: inherit; line-height: 1.15; text-align: center;
            }
            .aerodeck-doors-diagram .door-chip-btn.open { border-color: #34d399; background: rgba(52,211,153,0.22); }
            .aerodeck-doors-diagram .door-chip-btn.closed { border-color: #3d5675; background: #132a44; }
            .aerodeck-doors-diagram .door-chip-label { display: block; font-size: 9px; font-weight: 800; letter-spacing: 0.2px; }
            .aerodeck-doors-diagram .door-chip-state { display: block; font-size: 8px; font-weight: 700; color: #8397ae; margin-top: 2px; }
            .aerodeck-doors-diagram .door-chip-btn.open .door-chip-state { color: #34d399; }

            .aerodeck-cl-section { margin-bottom: 16px; }
            .aerodeck-cl-section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 7px; padding-bottom: 5px; border-bottom: 1px solid rgba(34,211,238,0.18); }
            .aerodeck-cl-section-title { font-size: 11.5px; font-weight: 800; letter-spacing: 1px; color: #22d3ee; }
            .aerodeck-cl-section-progress { font-size: 10px; color: #6f85a0; font-family: 'Consolas', monospace; }
            .aerodeck-cl-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #0e2138; border: 1px solid #1e3552; border-radius: 9px; padding: 11px 13px; margin-bottom: 7px; cursor: pointer; user-select: none; }
            .aerodeck-cl-item:hover { border-color: rgba(34,211,238,0.4); }
            .aerodeck-cl-item-text { font-size: 12.5px; color: #dbe6f0; }
            .aerodeck-cl-item.checked .aerodeck-cl-item-text { color: #6f85a0; text-decoration: line-through; }
            .aerodeck-cl-box { width: 22px; height: 22px; border-radius: 6px; border: 2px solid #3d5675; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #052024; }
            .aerodeck-cl-item.checked .aerodeck-cl-box { background: #34d399; border-color: #34d399; }
            .aerodeck-cl-progress { font-size: 10.5px; color: #8397ae; margin-bottom: 12px; text-align: right; }
            .aerodeck-home-hero { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 6px 0 4px; }
            .aerodeck-home-hero-icon { color: #22d3ee; display: flex; }
            .aerodeck-home-hero-text { font-size: 26px; font-weight: 900; letter-spacing: 4px; background: linear-gradient(90deg, var(--ad-accent), var(--ad-accent2), var(--ad-accent)); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; }
            .aerodeck-widget-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
            .aerodeck-widget { background: #0e2138; border: 1px solid #1e3552; border-radius: 14px; padding: 12px 13px; cursor: default; }
            .aerodeck-widget.clickable { cursor: pointer; }
            .aerodeck-widget.clickable:hover { border-color: rgba(34,211,238,0.4); }
            .aerodeck-widget-title { font-size: 10px; color: #8397ae; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700; }
            .aerodeck-widget-value { font-size: 20px; font-weight: 800; color: #eef2f7; margin-top: 5px; font-family: 'Consolas', monospace; }
            .aerodeck-widget-sub { font-size: 10.5px; color: #6f85a0; margin-top: 3px; }
            .aerodeck-profile-card { display:flex; align-items:center; gap:10px; }
            .aerodeck-profile-badge { display:inline-flex; align-items:center; gap:5px; font-size:9.5px; font-weight:700; color:#052024; background: linear-gradient(180deg,var(--ad-accent2),var(--ad-accent)); padding:2px 8px; border-radius:20px; margin-top:4px; width: fit-content; }
            .aerodeck-modal-backdrop { position: absolute; inset: 0; background: rgba(3,7,13,0.72); z-index: 20; display: flex; align-items: center; justify-content: center; padding: 20px; }
            .aerodeck-modal { background: #0e2138; border: 1px solid #1e3552; border-radius: 14px; padding: 16px; max-width: 100%; max-height: 100%; overflow-y: auto; width: 100%; }
            .aerodeck-modal-title { font-size: 13px; font-weight: 800; color: #22d3ee; margin-bottom: 10px; }
            .aerodeck-country-row { padding: 8px 0; border-bottom: 1px solid #1e3552; }
            .aerodeck-country-row:last-child { border-bottom: none; }
            .aerodeck-country-name { font-weight: 700; font-size: 12.5px; }
            .aerodeck-country-cities { font-size: 10.5px; color: #8397ae; margin-top: 2px; }
            .aerodeck-ach-row { display:flex; align-items:center; gap:9px; padding: 7px 0; }
            .aerodeck-ach-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink:0; }
            .aerodeck-ach-row.earned .aerodeck-ach-dot { background:#34d399; }
            .aerodeck-ach-row.locked .aerodeck-ach-dot { background:#3d5675; }
            .aerodeck-ach-row.locked { color:#5c7089; }
            #aerodeck-mini-body { display: flex; flex-direction: column; height: 100%; }
            .aerodeck-mini-toolbar { display: flex; gap: 6px; padding: 6px 8px 0; flex-shrink: 0; }
            .aerodeck-mini-btn { flex: 1; padding: 5px 0; font-size: 9.5px; font-weight: 800; letter-spacing: 0.5px; background: #0e2138; border: 1px solid #1e3552; color: #6f85a0; border-radius: 6px; cursor: pointer; }
            .aerodeck-mini-btn.active { background: linear-gradient(180deg,#5eead4,#22d3ee); color:#052024; border-color: transparent; }
            #aerodeck-mini-canvas { flex: 1; min-height: 0; margin: 6px 8px 8px; border-radius: 10px; overflow: hidden; border: 1px solid #1e3552; background: #0a1729; }
            #aerodeck-mini-canvas svg, #aerodeck-mini-canvas .leaflet-container { width: 100%; height: 100%; }
        `;
        document.head.appendChild(style);
    }

    function escapeHtml(s) { return (s || '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function formatDuration(ms) {
        if (ms == null || ms < 0) return '--:--:--';
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    let aerodeckOnlineCount = null;
    let aerodeckOnlineFetchedAt = 0;
    function getOnlinePilotsCount() {
        return aerodeckOnlineCount;
    }
    async function refreshAeroDeckOnlineCount() {
        try {
            if (Date.now() - aerodeckOnlineFetchedAt < 15000 && aerodeckOnlineCount != null) return aerodeckOnlineCount;
            const profile = getProfile();
            const list = await fetchAeroDeckPresence(profile ? profile.id : null);
            aerodeckOnlineCount = (list ? list.length : 0) + (profile ? 1 : 0);
            aerodeckOnlineFetchedAt = Date.now();
        } catch (e) {
            /* keep last */
        }
        return aerodeckOnlineCount;
    }

    function formatClockHM(d) { return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'); }
    function formatClockHMS(d) { return formatClockHM(d) + ':' + d.getSeconds().toString().padStart(2, '0'); }
    function formatDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function logoHtml(iata, sizeClass) {
        const initials = escapeHtml((iata || '??').slice(0, 2));
        return `<div class="aerodeck-logo ${sizeClass || ''}" data-iata="${escapeHtml(iata || '')}" data-initials="${initials}">${initials}</div>`;
    }
    function wireLogos(container) {
        container.querySelectorAll('.aerodeck-logo[data-iata]').forEach((el) => {
            const iata = el.getAttribute('data-iata');
            if (!iata) return;
            const initials = el.getAttribute('data-initials') || '';
            el.innerHTML = '';
            const img = document.createElement('img');
            img.src = LOGO_URL(iata);
            img.onerror = () => { el.innerHTML = initials; };
            el.appendChild(img);
        });
    }

    // ------------------------------- registration -------------------------------
    function renderRegisterView(content) {
        const pilotId = genPilotId();
        content.innerHTML = `
            <div class="aerodeck-reg-wrap">
                <div class="aerodeck-label">Welcome — Pilot Registration</div>
                <div style="font-size:11.5px;color:#8397ae;margin-bottom:11px;line-height:1.6;">Register once. Your Pilot ID is generated automatically and cannot be changed afterward.</div>
                <div class="aerodeck-label">Pilot Name</div>
                <input id="aerodeck-reg-name" class="aerodeck-input" type="text" placeholder="e.g. John Smith" maxlength="40">
                <div class="aerodeck-label">Your Pilot ID (permanent)</div>
                <input id="aerodeck-reg-id" class="aerodeck-input" type="text" value="${pilotId}" disabled>
                <button id="aerodeck-reg-save" class="aerodeck-btn">REGISTER &amp; CONTINUE</button>
            </div>`;
        content.querySelector('#aerodeck-reg-save').onclick = async () => {
            const nameInput = content.querySelector('#aerodeck-reg-name');
            const btn = content.querySelector('#aerodeck-reg-save');
            const name = nameInput.value.trim();
            if (!name) { nameInput.style.borderColor = '#c0392b'; return; }
            nameInput.style.borderColor = '';
            const prevWarn = content.querySelector('#aerodeck-reg-warn');
            if (prevWarn) prevWarn.remove();
            btn.disabled = true;
            btn.textContent = 'CHECKING…';
            const claim = await claimPilotName(name, pilotId);
            if (!claim.ok && claim.reason === 'taken') {
                btn.disabled = false;
                btn.textContent = 'REGISTER & CONTINUE';
                const warn = document.createElement('div');
                warn.id = 'aerodeck-reg-warn';
                warn.className = 'aerodeck-warn';
                warn.style.marginTop = '8px';
                warn.textContent = 'That username is already registered. Choose another name.';
                btn.insertAdjacentElement('beforebegin', warn);
                nameInput.style.borderColor = '#c0392b';
                return;
            }
            if (!claim.ok && claim.reason === 'network') {
                btn.disabled = false;
                btn.textContent = 'REGISTER & CONTINUE';
                const warn = document.createElement('div');
                warn.id = 'aerodeck-reg-warn';
                warn.className = 'aerodeck-warn';
                warn.style.marginTop = '8px';
                warn.textContent = 'Could not verify username (network). Try again.';
                btn.insertAdjacentElement('beforebegin', warn);
                return;
            }
            saveProfile({ name, id: pilotId, registeredAt: Date.now() });
            checklistState = getChecklistState(pilotId);
            render();
        };
    }

    // ------------------------------- cards -------------------------------
    function airlineCardHtml() {
        if (!flight.airline && !flight.airlineNotFound) return `<div class="aerodeck-card muted">Enter a flight number above</div>`;
        if (flight.airlineNotFound) return `<div class="aerodeck-card"><div class="aerodeck-warn">Airline code not recognized. Try IATA (2-char) or ICAO (3-char), e.g. "EK203" or "UAE203".</div></div>`;
        const a = flight.airline;
        return `<div class="aerodeck-card"><div class="aerodeck-row">${logoHtml(a.iata)}<div><div class="aerodeck-airline-name">${escapeHtml(a.name)}</div><div class="aerodeck-airline-meta">${escapeHtml(a.code)} (${a.codeType}) &middot; Flight ${escapeHtml(a.code)}${escapeHtml(a.flightNo)}<br>${escapeHtml(a.country || 'Unknown')}</div></div></div></div>`;
    }
    function airportCardHtml(label, text, apt, notFound) {
        if (!text) return `<div class="aerodeck-card muted">${label}</div>`;
        if (notFound) return `<div class="aerodeck-card"><div class="aerodeck-warn">"${escapeHtml(text)}" — ICAO code not found.</div></div>`;
        return `<div class="aerodeck-card"><div class="aerodeck-airport-code">${escapeHtml(apt.icao)}${apt.iata ? ' / ' + escapeHtml(apt.iata) : ''}</div><div class="aerodeck-airport-name">${escapeHtml(apt.name)}</div><div class="aerodeck-airport-city">${escapeHtml(apt.city || '')}${apt.city && apt.country ? ', ' : ''}${escapeHtml(apt.country || '')}</div></div>`;
    }

    // ------------------------------- FLIGHT tab (setup + live phase, merged) -------------------------------
    function renderFlightTab(container, profile) {
        if (!flight.active) {
            ensureAircraftDetected();
            const startChecks = getStartFlightChecks();
            const startReady = (flight.airline && flight.origin && flight.destination) && startChecks.every((c) => c.ok);
            container.innerHTML = `
                <div class="aerodeck-label">Flight Number</div>
                <input id="aerodeck-flight-input" class="aerodeck-input" type="text" placeholder="e.g. EK203" value="${escapeHtml(flight.flightNumberText)}" maxlength="8">
                ${airlineCardHtml()}
                <div class="aerodeck-label">Origin (ICAO)</div>
                <input id="aerodeck-origin-input" class="aerodeck-input" type="text" placeholder="e.g. OMDB" value="${escapeHtml(flight.originText)}" maxlength="4">
                ${airportCardHtml('Enter origin ICAO', flight.originText, flight.origin, flight.originNotFound)}
                <div class="aerodeck-route-arrow">&#9662;</div>
                <div class="aerodeck-label">Destination (ICAO)</div>
                <input id="aerodeck-dest-input" class="aerodeck-input" type="text" placeholder="e.g. EGLL" value="${escapeHtml(flight.destText)}" maxlength="4">
                ${airportCardHtml('Enter destination ICAO', flight.destText, flight.destination, flight.destNotFound)}
                <div class="aerodeck-label">Aircraft (auto-detected)</div>
                <div class="aerodeck-card clickable" id="aerodeck-flight-goto-aircraft" style="cursor:pointer;">${flight.aircraft ? `<div class="aerodeck-airline-name">${escapeHtml(flight.aircraft.name)}</div><div class="aerodeck-airline-meta">Aircraft tab: doors & boarding · OFP tab: SimBrief &rarr;</div>` : '<div class="aerodeck-warn">Could not detect aircraft — spawn in one to continue.</div>'}</div>
                <div class="aerodeck-label">Before Start</div>
                ${checksHtml(startChecks)}
                <button id="aerodeck-start-flight" class="aerodeck-btn" ${startReady ? '' : 'disabled'}>START FLIGHT</button>
            `;
            const commitFlightNumber = () => {
                const val = container.querySelector('#aerodeck-flight-input').value;
                flight.flightNumberText = val;
                if (!val.trim()) { flight.airline = null; flight.airlineNotFound = false; }
                else { const found = lookupAirline(val); flight.airline = found; flight.airlineNotFound = !found; }
                render();
            };
            const commitOrigin = () => {
                const val = container.querySelector('#aerodeck-origin-input').value;
                flight.originText = val;
                if (!val.trim()) { flight.origin = null; flight.originNotFound = false; }
                else { const found = lookupAirport(val); flight.origin = found; flight.originNotFound = !found; }
                render();
            };
            const commitDest = () => {
                const val = container.querySelector('#aerodeck-dest-input').value;
                flight.destText = val;
                if (!val.trim()) { flight.destination = null; flight.destNotFound = false; }
                else { const found = lookupAirport(val); flight.destination = found; flight.destNotFound = !found; }
                render();
            };
            const flightInput = container.querySelector('#aerodeck-flight-input');
            flightInput.onblur = commitFlightNumber;
            flightInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFlightNumber(); } };
            const originInput = container.querySelector('#aerodeck-origin-input');
            originInput.onblur = commitOrigin;
            originInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitOrigin(); } };
            const destInput = container.querySelector('#aerodeck-dest-input');
            destInput.onblur = commitDest;
            destInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitDest(); } };
            container.querySelector('#aerodeck-flight-goto-aircraft').onclick = () => { activeTab = 'aircraft'; render(); };
            const startBtn = container.querySelector('#aerodeck-start-flight');
            if (startBtn) startBtn.onclick = () => {
                if (!startReady) return;
                ensureAircraftDetected(true);
                flight.active = true;
                flight.startTimestamp = Date.now();
                render();
            };
        } else {
            const a = flight.airline;
            const elapsedMs = Date.now() - flight.startTimestamp;
            const curPos = getCurrentLatLon();
            const speed = getCurrentGroundSpeedKts();
            const mach = getCurrentMach();
            const alt = getCurrentAltitudeFt();
            let remainingNM = null, etaText = '--:--';
            if (curPos && flight.destination && flight.destination.lat != null) {
                remainingNM = haversineNM(curPos.lat, curPos.lon, flight.destination.lat, flight.destination.lon);
                if (speed && speed > 5) etaText = formatClockHM(new Date(Date.now() + (remainingNM / speed) * 3600 * 1000));
            }
            const nearAirport = getNearAirportStatus();
            const showEnd = nearAirport.ok;
            const endChecks = getEndFlightChecks();
            const endReady = endChecks.every((c) => c.ok);
            const simbriefNote = (flight.simbrief && flight.simbrief.used)
                ? ` &middot; SimBrief ${flight.simbrief.fuelPlanned != null ? Math.round(flight.simbrief.fuelPlanned).toLocaleString() + ' ' + (flight.simbrief.unit || '') + ' fuel' : 'OFP'}`
                : '';
            container.innerHTML = `
                <div class="aerodeck-card"><div class="aerodeck-row">${logoHtml(a.iata)}<div><div class="aerodeck-summary-route">${escapeHtml(flight.origin.icao)} &rarr; ${escapeHtml(flight.destination.icao)}</div><div class="aerodeck-summary-sub">${escapeHtml(a.name)} &middot; ${escapeHtml(a.code)}${escapeHtml(a.flightNo)} &middot; ${flight.aircraft ? escapeHtml(flight.aircraft.name) : 'Unknown aircraft'}${(flight.simbrief && flight.simbrief.aircraftType) ? ' · OFP ' + escapeHtml(flight.simbrief.aircraftType) : ''}${flight.paxTarget ? ` &middot; ${flight.paxTarget} pax` : ''}${simbriefNote}</div></div></div></div>
                <div class="aerodeck-label">Live Tracking</div>
                <div class="aerodeck-track-grid">
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="color:${getFlightPhase().color}">${getFlightPhase().label}</div><div class="aerodeck-track-label">Phase</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${formatDuration(elapsedMs)}</div><div class="aerodeck-track-label">Time in Air</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${remainingNM != null ? remainingNM : '—'}</div><div class="aerodeck-track-label">NM Remaining</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${etaText}</div><div class="aerodeck-track-label">ETA</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${speed != null ? Math.round(speed) : '—'} kt${mach != null ? ` / M${mach.toFixed(2)}` : ''}</div><div class="aerodeck-track-label">Speed</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value">${alt != null ? alt.toLocaleString() : '—'} ft</div><div class="aerodeck-track-label">Altitude</div></div>
                </div>
                ${showEnd
                    ? `<div class="aerodeck-label">Before End</div>${checksHtml(endChecks)}<button id="aerodeck-end-flight" class="aerodeck-btn danger" ${endReady ? '' : 'disabled'}>END FLIGHT</button>`
                    : `<div class="aerodeck-card muted" style="margin-top:14px;">${escapeHtml(nearAirport.note || 'Not near an airport')}</div>`}
            `;
            const endBtn = container.querySelector('#aerodeck-end-flight');
            if (endBtn) {
                endBtn.onclick = () => {
                    if (!endReady) return;
                    const durationMs = Date.now() - flight.startTimestamp;
                    let distanceNM = null;
                    if (flight.origin.lat != null && flight.destination.lat != null) distanceNM = haversineNM(flight.origin.lat, flight.origin.lon, flight.destination.lat, flight.destination.lon);
                    const now = new Date();
                    addHistoryRecord(profile.id, {
                        dateDisplay: formatDate(now), timestamp: now.getTime(),
                        airlineName: flight.airline.name, airlineCode: flight.airline.code, airlineIata: flight.airline.iata,
                        flightNo: flight.airline.code + flight.airline.flightNo, aircraft: flight.aircraft ? flight.aircraft.name : 'Unknown',
                        origin: flight.origin.icao, destination: flight.destination.icao, durationMs, distanceNM, paxBoarded: flight.paxTarget || 0
                    });
                    flight = blankFlight();
                    render();
                };
            }
        }
        wireLogos(container);
    }

    // ------------------------------- CHECKLIST tab -------------------------------
    function renderChecklistTab(container, profile) {
        const totalItems = CHECKLIST_PHASES.reduce((sum, p) => sum + p.items.length, 0);
        const doneItems = checklistState.reduce((sum, arr) => sum + arr.filter(Boolean).length, 0);
        const sectionsHtml = CHECKLIST_PHASES.map((phase, pIdx) => {
            const doneCount = checklistState[pIdx].filter(Boolean).length;
            const itemsHtml = phase.items.map((item, iIdx) => {
                const checked = checklistState[pIdx][iIdx];
                return `<div class="aerodeck-cl-item ${checked ? 'checked' : ''}" data-p="${pIdx}" data-i="${iIdx}"><span class="aerodeck-cl-item-text">${escapeHtml(item)}</span><span class="aerodeck-cl-box">${checked ? '&#10003;' : ''}</span></div>`;
            }).join('');
            return `<div class="aerodeck-cl-section"><div class="aerodeck-cl-section-head"><span class="aerodeck-cl-section-title">${escapeHtml(phase.title)}</span><span class="aerodeck-cl-section-progress">${doneCount}/${phase.items.length}</span></div>${itemsHtml}</div>`;
        }).join('');
        container.innerHTML = `<div class="aerodeck-cl-progress">${doneItems}/${totalItems} complete overall</div>${sectionsHtml}<button id="aerodeck-cl-reset" class="aerodeck-btn secondary">RESET ALL CHECKLISTS</button>`;
        container.querySelectorAll('.aerodeck-cl-item').forEach((el) => {
            el.onclick = () => { const p = parseInt(el.getAttribute('data-p'), 10), i = parseInt(el.getAttribute('data-i'), 10); checklistState[p][i] = !checklistState[p][i]; saveChecklistState(profile.id, checklistState); render(); };
        });
        container.querySelector('#aerodeck-cl-reset').onclick = () => { checklistState = blankChecklistState(); saveChecklistState(profile.id, checklistState); render(); };
    }

    // ------------------------------- HISTORY tab -------------------------------
    function renderHistoryTab(container, profile) {
        const list = getHistory(profile.id);
        const toolbarHtml = `<div class="aerodeck-history-toolbar"><span class="aerodeck-history-count">${list.length} flight${list.length === 1 ? '' : 's'} logged</span>${list.length ? (confirmingClearHistory ? `<div class="aerodeck-confirm-row">Clear all?<span class="aerodeck-link danger" id="aerodeck-clear-yes">Yes</span><span class="aerodeck-link" id="aerodeck-clear-no">No</span></div>` : `<span class="aerodeck-link" id="aerodeck-clear-history">clear history</span>`) : ''}</div>`;
        if (!list.length) container.innerHTML = toolbarHtml + `<div class="aerodeck-empty-note">No flights logged yet.<br>Complete a flight from the Flight tab to see it here.</div>`;
        else {
            const rows = list.map((r) => `<div class="aerodeck-history-row">${logoHtml(r.airlineIata, 'small')}<div class="hr-main"><div class="aerodeck-hr-top"><span class="aerodeck-hr-flight">${escapeHtml(r.flightNo || '')} &middot; ${escapeHtml(r.airlineName || '')}</span><span class="aerodeck-hr-date">${escapeHtml(r.dateDisplay || '')}</span></div><div class="aerodeck-hr-route">${escapeHtml(r.origin || '')} &rarr; ${escapeHtml(r.destination || '')}</div><div class="aerodeck-hr-meta">${escapeHtml(r.aircraft || 'Unknown aircraft')} &middot; ${formatDuration(r.durationMs)}${r.distanceNM != null ? ' &middot; ' + r.distanceNM + ' NM' : ''}</div></div></div>`).join('');
            container.innerHTML = toolbarHtml + `<div class="aerodeck-history-list">${rows}</div>`;
        }
        const clearLink = container.querySelector('#aerodeck-clear-history'); if (clearLink) clearLink.onclick = () => { confirmingClearHistory = true; render(); };
        const clearYes = container.querySelector('#aerodeck-clear-yes'); if (clearYes) clearYes.onclick = () => { clearHistory(profile.id); confirmingClearHistory = false; render(); };
        const clearNo = container.querySelector('#aerodeck-clear-no'); if (clearNo) clearNo.onclick = () => { confirmingClearHistory = false; render(); };
        wireLogos(container);
    }

    // ------------------------------- CHAT tab -------------------------------
    function renderChatTab(container, profile) {
        if (!gmGet(STORAGE.CHAT_AGE_ACK, false)) {
            container.innerHTML = `<div class="aerodeck-card" style="margin-top:0;"><div style="font-size:12px;color:#dbe6f0;margin-bottom:10px;line-height:1.5;">Live chat lets you message other AeroDeck pilots. By enabling it, you confirm you are 13 years of age or older.</div><div style="display:flex;gap:8px;"><button id="aerodeck-chat-agegate-confirm" class="aerodeck-btn" style="margin-top:0;">I'M 13+ — ENABLE CHAT</button></div></div>`;
            container.querySelector('#aerodeck-chat-agegate-confirm').onclick = () => { gmSet(STORAGE.CHAT_AGE_ACK, true); chatEnabled = true; render(); };
            return;
        }
        chatEnabled = true;
        container.innerHTML = `<div class="aerodeck-chat-panel"><div id="aerodeck-chat-messages" class="aerodeck-chat-messages"></div><div class="aerodeck-chat-input-row"><input id="aerodeck-chat-input" class="aerodeck-input" type="text" placeholder="Message other AeroDeck pilots…" maxlength="200"><button id="aerodeck-chat-send" class="aerodeck-btn">SEND</button></div></div>`;
        const doSend = () => {
            const input = container.querySelector('#aerodeck-chat-input');
            const text = input.value.trim();
            if (!text || !profile) return;
            input.value = '';
            sendChatMessage(profile, text).then(() => fetchAndRenderChat());
        };
        container.querySelector('#aerodeck-chat-send').onclick = doSend;
        container.querySelector('#aerodeck-chat-input').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } };
        fetchAndRenderChat();
    }

    // ------------------------------- HOME tab -------------------------------
    function metarWidgetHtml(label, apt) {
        if (!apt) return `<div class="aerodeck-widget"><div class="aerodeck-widget-title">${escapeHtml(label)} METAR</div><div class="aerodeck-widget-sub" style="margin-top:8px;">Set a route in the Flight tab</div></div>`;
        let cached = metarMemCache[apt.icao];
        if (cached && (Date.now() - cached.ts >= METAR_CACHE_MS)) {
            delete metarMemCache[apt.icao];
            cached = null;
        }
        if (!cached) { fetchMetarRaw(apt.icao).then(() => renderIfOpen()); return `<div class="aerodeck-widget"><div class="aerodeck-widget-title">${escapeHtml(label)} METAR &middot; ${escapeHtml(apt.icao)}</div><div class="aerodeck-widget-sub" style="margin-top:8px;">Loading…</div></div>`; }
        const res = cached.result;
        const ageMin = Math.round((Date.now() - cached.ts) / 60000);
        if (res.error) return `<div class="aerodeck-widget"><div class="aerodeck-widget-title">${escapeHtml(label)} METAR &middot; ${escapeHtml(apt.icao)}</div><div class="aerodeck-warn" style="margin-top:8px;">${escapeHtml(res.error)}</div></div>`;
        return `<div class="aerodeck-widget"><div class="aerodeck-widget-title">${escapeHtml(label)} METAR &middot; ${escapeHtml(apt.icao)} <span style="opacity:0.6;font-weight:600;">· ${ageMin}m</span></div><div class="aerodeck-metar-raw" style="margin-top:8px;font-size:10.5px;">${escapeHtml(res.raw)}</div></div>`;
    }
    function atisWidgetHtml(label, apt) {
        if (!apt) return '';
        const cached = metarMemCache[apt.icao];
        if (!cached || cached.result.error) return '';
        const atis = decodeMetarToAtis(cached.result.raw, apt.icao);
        if (!atis) return '';
        const ageMin = cached.ts ? Math.round((Date.now() - cached.ts) / 60000) : null;
        return `<div class="aerodeck-widget"><div class="aerodeck-widget-title">${escapeHtml(label)} ATIS (decoded)</div>
            <div style="margin-top:7px;">
                <div class="aerodeck-atis-row"><span>Time</span><span>${escapeHtml(atis.time)}</span></div>
                <div class="aerodeck-atis-row"><span>Wind</span><span>${escapeHtml(atis.wind)}</span></div>
                <div class="aerodeck-atis-row"><span>Visibility</span><span>${escapeHtml(atis.vis)}</span></div>
                <div class="aerodeck-atis-row"><span>Clouds</span><span>${escapeHtml(atis.clouds)}</span></div>
                <div class="aerodeck-atis-row"><span>Temp/Dew</span><span>${escapeHtml(atis.temp)} / ${escapeHtml(atis.dew)}</span></div>
                <div class="aerodeck-atis-row"><span>QNH</span><span>${escapeHtml(atis.qnh)}</span></div>
                ${ageMin != null ? `<div class="aerodeck-atis-row"><span>Age</span><span>${ageMin} min</span></div>` : ''}
            </div></div>`;
    }
    function renderHomeTab(container, profile) {
        refreshAeroDeckOnlineCount().then(() => { if (activeTab === 'home') renderIfOpen(); }).catch(() => {});

        const now = new Date();
        const clockStr = formatClockHMS(now);
        const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        const b = computeBadge(profile.id);
        const countries = computeCountriesVisited(profile.id);
        const earnedAch = ACHIEVEMENTS.filter((a) => a.test(b));

        container.innerHTML = `
            <div class="aerodeck-home-hero"><div class="aerodeck-home-hero-icon">${ICON_BRAND}</div><div class="aerodeck-home-hero-text">AERODECK</div></div>
            <div style="text-align:center;padding:6px 0 4px;">
                <div style="font-family:'Consolas',monospace;font-size:32px;font-weight:800;color:#eef2f7;letter-spacing:2px;">${clockStr}</div>
                <div style="font-size:11px;color:#8397ae;margin-top:3px;">${dateStr}</div>
            </div>

            <div class="aerodeck-label">Widgets</div>
            <div class="aerodeck-widget-grid">
                <div class="aerodeck-widget clickable" id="aerodeck-w-countries">
                    <div class="aerodeck-widget-title">Countries Visited</div>
                    <div class="aerodeck-widget-value">${countries.length}</div>
                </div>
                <div class="aerodeck-widget clickable" id="aerodeck-w-achievements">
                    <div class="aerodeck-widget-title">Achievements</div>
                    <div class="aerodeck-widget-value">${earnedAch.length}/${ACHIEVEMENTS.length}</div>
                </div>
                ${metarWidgetHtml('Origin', flight.origin)}
                ${metarWidgetHtml('Destination', flight.destination)}
                ${atisWidgetHtml('Origin', flight.origin)}
                ${atisWidgetHtml('Destination', flight.destination)}
            </div>
            <div class="aerodeck-widget" style="margin-top:10px;">
                <div class="aerodeck-widget-title">Pilots Online (AeroDeck)</div>
                <div class="aerodeck-widget-value">${(() => { const n = getOnlinePilotsCount(); return n == null ? '…' : n; })()}</div>
                <div class="aerodeck-widget-sub">AeroDeck users currently broadcasting presence</div>
            </div>

            ${showCountriesModal ? countriesModalHtml(countries) : ''}
            ${showAchievementsModal ? achievementsModalHtml(b) : ''}
        `;
        container.querySelector('#aerodeck-w-countries').onclick = () => { showCountriesModal = true; render(); };
        container.querySelector('#aerodeck-w-achievements').onclick = () => { showAchievementsModal = true; render(); };
    }
    function countriesModalHtml(countries) {
        const rows = countries.length ? countries.map((c) => `<div class="aerodeck-country-row"><div class="aerodeck-country-name">${escapeHtml(c.country)}</div><div class="aerodeck-country-cities">${c.cities.map(escapeHtml).join(', ') || '—'}</div></div>`).join('') : `<div class="aerodeck-empty-note">No completed flights yet.</div>`;
        return `<div class="aerodeck-modal-backdrop" id="aerodeck-countries-close"><div class="aerodeck-modal" onclick="event.stopPropagation()"><div class="aerodeck-modal-title">Countries Visited</div>${rows}<button class="aerodeck-btn secondary" id="aerodeck-countries-close-btn">CLOSE</button></div></div>`;
    }
    function achievementsModalHtml(badge) {
        const rows = ACHIEVEMENTS.map((a) => { const earned = a.test(badge); return `<div class="aerodeck-ach-row ${earned ? 'earned' : 'locked'}"><span class="aerodeck-ach-dot"></span><span>${escapeHtml(a.label)}</span></div>`; }).join('');
        return `<div class="aerodeck-modal-backdrop" id="aerodeck-ach-close"><div class="aerodeck-modal" onclick="event.stopPropagation()"><div class="aerodeck-modal-title">Achievements</div>${rows}<button class="aerodeck-btn secondary" id="aerodeck-ach-close-btn">CLOSE</button></div></div>`;
    }

    // ------------------------------- SETTINGS tab -------------------------------
    function renderSettingsTab(container, profile) {
        const b = computeBadge(profile.id);
        const theme = getTheme();
        const updateBanner = isUpdateAvailable()
            ? `<div class="aerodeck-card" style="margin-bottom:10px;border-color:var(--accent,#22d3ee);">
                    <div class="aerodeck-airline-name" style="font-size:12px;">Update available — v${escapeHtml(remoteVersion)}</div>
                    <div class="aerodeck-airline-meta">You are on v${escapeHtml(SCRIPT_VERSION)}</div>
                    <a id="aerodeck-update-link" class="aerodeck-btn secondary" style="display:inline-block;margin-top:8px;text-align:center;text-decoration:none;"
                       href="${RELEASES_URL}" target="_blank" rel="noopener">Open update page</a>
               </div>`
            : (remoteVersion
                ? `<div class="aerodeck-airline-meta" style="margin-bottom:10px;">Up to date · v${escapeHtml(SCRIPT_VERSION)}</div>`
                : `<div class="aerodeck-airline-meta" style="margin-bottom:10px;">AeroDeck v${escapeHtml(SCRIPT_VERSION)}</div>`);
        container.innerHTML = `
            ${updateBanner}
            <div class="aerodeck-label">Profile</div>
            <div class="aerodeck-card">
                <div class="aerodeck-profile-card">
                    <div>
                        <div class="aerodeck-airline-name" style="font-size:13px;">${escapeHtml(profile.name)}</div>
                        <div class="aerodeck-airline-meta">${escapeHtml(profile.id)}</div>
                        <div class="aerodeck-profile-badge">${escapeHtml(b.tier)} · ${b.hours.toFixed(1)}h</div>
                    </div>
                </div>
            </div>
            <div class="aerodeck-label">Career</div>
            <div class="aerodeck-track-grid">
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${b.flights}</div><div class="aerodeck-track-label">Flights Logged</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${b.hours.toFixed(1)}</div><div class="aerodeck-track-label">Total Hours</div></div>
            </div>
            <div class="aerodeck-label">Theme</div>
            <div class="aerodeck-mode-toggle" style="display:grid;grid-template-columns:repeat(9,1fr);gap:4px;">
                <button class="aerodeck-mode-btn ${theme === 'default' ? 'active' : ''}" data-theme="default">CYAN</button>
                <button class="aerodeck-mode-btn ${theme === 'violet' ? 'active' : ''}" data-theme="violet">VIOLET</button>
                <button class="aerodeck-mode-btn ${theme === 'amber' ? 'active' : ''}" data-theme="amber">AMBER</button>
                <button class="aerodeck-mode-btn ${theme === 'emerald' ? 'active' : ''}" data-theme="emerald">EMERALD</button>
                <button class="aerodeck-mode-btn ${theme === 'rose' ? 'active' : ''}" data-theme="rose">ROSE</button>
                <button class="aerodeck-mode-btn ${theme === 'sky' ? 'active' : ''}" data-theme="sky">SKY</button>
                <button class="aerodeck-mode-btn ${theme === 'slate' ? 'active' : ''}" data-theme="slate">SLATE</button>
                <button class="aerodeck-mode-btn ${theme === 'coral' ? 'active' : ''}" data-theme="coral">CORAL</button>
                <button class="aerodeck-mode-btn ${theme === 'lime' ? 'active' : ''}" data-theme="lime">LIME</button>
                <button class="aerodeck-mode-btn ${theme === 'indigo' ? 'active' : ''}" data-theme="indigo">INDIGO</button>
                <button class="aerodeck-mode-btn ${theme === 'teal' ? 'active' : ''}" data-theme="teal">TEAL</button>
                <button class="aerodeck-mode-btn ${theme === 'magenta' ? 'active' : ''}" data-theme="magenta">MAGENTA</button>
                <button class="aerodeck-mode-btn ${theme === 'gold' ? 'active' : ''}" data-theme="gold">GOLD</button>
                <button class="aerodeck-mode-btn ${theme === 'mint' ? 'active' : ''}" data-theme="mint">MINT</button>
                <button class="aerodeck-mode-btn ${theme === 'crimson' ? 'active' : ''}" data-theme="crimson">CRIMSON</button>
                <button class="aerodeck-mode-btn ${theme === 'ocean' ? 'active' : ''}" data-theme="ocean">OCEAN</button>
                <button class="aerodeck-mode-btn ${theme === 'grape' ? 'active' : ''}" data-theme="grape">GRAPE</button>
                <button class="aerodeck-mode-btn ${theme === 'forest' ? 'active' : ''}" data-theme="forest">FOREST</button>
            </div>
            <div class="aerodeck-label">Keyboard shortcut</div>
            <div class="aerodeck-card" style="margin-bottom:10px;">
                <div class="aerodeck-airline-meta" style="margin-bottom:8px;">Optional hotkey to open / restore / close the EFB tablet. Ignored while typing in a field.</div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button type="button" id="aerodeck-shortcut-capture" class="aerodeck-btn secondary" style="margin:0;width:auto;padding:8px 14px;">
                        ${shortcutCaptureMode ? 'Press keys…' : escapeHtml(formatShortcut(getOpenShortcut()))}
                    </button>
                    <span class="aerodeck-link" id="aerodeck-shortcut-clear">clear</span>
                </div>
                <div class="aerodeck-airline-meta" style="margin-top:8px;">Click the button, then press a combo (e.g. Ctrl+Space). Esc cancels.</div>
            </div>
            <div class="aerodeck-label">Data</div>
            <div class="aerodeck-sidebar-links" style="margin-top:0;">
                ${confirmingResetProfile
                    ? `<div class="aerodeck-confirm-row">Reset profile?<span class="aerodeck-link danger" id="aerodeck-reset-yes">Yes</span><span class="aerodeck-link" id="aerodeck-reset-no">No</span></div>`
                    : `<span class="aerodeck-link" id="aerodeck-reset-profile">reset profile</span>`}
                <span class="aerodeck-link" id="aerodeck-refresh-data">refresh airline/airport data</span>
            </div>
            <div class="aerodeck-data-status">${dataStatus === 'ready' ? 'Data loaded' : dataStatus === 'loading' ? 'Loading data…' : 'Data load failed — using cache'}</div>
        `;
        container.querySelectorAll('[data-theme]').forEach((btn) => { btn.onclick = () => { setTheme(btn.getAttribute('data-theme')); render(); }; });
        const resetLink = container.querySelector('#aerodeck-reset-profile'); if (resetLink) resetLink.onclick = () => { confirmingResetProfile = true; render(); };
        const resetYes = container.querySelector('#aerodeck-reset-yes'); if (resetYes) resetYes.onclick = () => { clearProfile(); confirmingResetProfile = false; flight = blankFlight(); render(); };
        const resetNo = container.querySelector('#aerodeck-reset-no'); if (resetNo) resetNo.onclick = () => { confirmingResetProfile = false; render(); };
        const refreshLink = container.querySelector('#aerodeck-refresh-data'); if (refreshLink) refreshLink.onclick = () => { if (!confirm('Refresh airline/airport data from the network? Cached data will be replaced.')) return; forceRefreshData(); render(); };

        const capBtn = container.querySelector('#aerodeck-shortcut-capture');
        const clearLink = container.querySelector('#aerodeck-shortcut-clear');
        if (clearLink) clearLink.onclick = () => { setOpenShortcut(null); shortcutCaptureMode = false; render(); };
        if (capBtn) {
            capBtn.onclick = () => {
                if (shortcutCaptureMode) return;
                shortcutCaptureMode = true;
                render();
                const onCapture = (e) => {
                    // pure modifiers alone are not a complete shortcut
                    if (e.key === 'Escape') {
                        e.preventDefault(); e.stopPropagation();
                        document.removeEventListener('keydown', onCapture, true);
                        shortcutCaptureMode = false;
                        render();
                        return;
                    }
                    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
                    e.preventDefault(); e.stopPropagation();
                    document.removeEventListener('keydown', onCapture, true);
                    setOpenShortcut({
                        ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key: e.key
                    });
                    shortcutCaptureMode = false;
                    render();
                };
                document.addEventListener('keydown', onCapture, true);
            };
        }
    }

    // ------------------------------- AIRCRAFT tab -------------------------------
    function ensureAircraftDetected(force) {
        const current = detectCurrentAircraft();
        if (!current) return;
        const prevCap = flight.capacity;
        const changed = !flight.aircraft || flight.aircraft.id !== current.id || flight.aircraft.name !== current.name;
        if (force || changed) {
            flight.aircraft = current;
            flight.capacity = current.capacity;
        }
        if (!flight.doors.length || (prevCap != null && prevCap !== flight.capacity)) {
            flight.doors = getDoorsForCapacity(flight.capacity);
        }
    }
    function renderAircraftTab(container) {
        ensureAircraftDetected(true);
        const doorsHtml = flight.doors.length
            ? `${buildDoorsDiagramHtml(flight.doors)}
               <div style="display:flex;gap:8px;margin-top:8px;">
                 <button id="aerodeck-doors-open-all" class="aerodeck-btn secondary" style="margin-top:0;flex:1;">OPEN ALL</button>
                 <button id="aerodeck-doors-close-all" class="aerodeck-btn secondary" style="margin-top:0;flex:1;">CLOSE ALL</button>
               </div>`
            : `<div class="aerodeck-card muted">No aircraft detected yet — spawn in one to configure doors.</div>`;

        const boarded = getBoardedCount();
        const boardingHtml = (() => {
            if (!flight.paxTarget && !(simbrief.weights && simbrief.weights.paxCount) && !flight.paxTargetText) {
                return `
                    <input id="aerodeck-pax-input" class="aerodeck-input" type="text" placeholder="Target passenger count" value="${escapeHtml(flight.paxTargetText || '')}" maxlength="4">
                    ${flight.paxError ? `<div class="aerodeck-warn" style="margin-top:6px;">${escapeHtml(flight.paxError)}</div>` : ''}
                    <button id="aerodeck-board-btn" class="aerodeck-btn secondary">BOARD PASSENGERS</button>
                `;
            }
            if (flight.boardingStatus === 'complete') {
                return `<div class="aerodeck-card"><div class="aerodeck-summary-sub">${flight.paxTarget} passengers on board</div>
                    <button id="aerodeck-board-reset" class="aerodeck-btn secondary" style="margin-top:8px;">DEPLANE</button></div>`;
            }
            if (flight.boardingStatus === 'boarding') {
                return `<div class="aerodeck-card"><div class="aerodeck-summary-sub" style="margin-bottom:8px;">${boarded} / ${flight.paxTarget} passengers boarded</div>
                    <div class="aerodeck-progress-track"><div class="aerodeck-progress-fill" style="width:${Math.min(100, (boarded / Math.max(1, flight.paxTarget)) * 100)}%;"></div></div></div>`;
            }
            return `
                <input id="aerodeck-pax-input" class="aerodeck-input" type="text" placeholder="Target passenger count" value="${escapeHtml(flight.paxTargetText || '')}" maxlength="4">
                ${flight.paxError ? `<div class="aerodeck-warn" style="margin-top:6px;">${escapeHtml(flight.paxError)}</div>` : ''}
                <button id="aerodeck-board-btn" class="aerodeck-btn secondary">BOARD PASSENGERS</button>
            `;
        })();

        container.innerHTML = `
            <div class="aerodeck-label">Aircraft (auto-detected)</div>
            <div class="aerodeck-card">${flight.aircraft
                ? `<div class="aerodeck-airline-name">${escapeHtml(flight.aircraft.name)}</div>
                   <div class="aerodeck-airline-meta">From the aircraft you are currently flying${flight.capacity ? ` · capacity ~${flight.capacity}` : ''}</div>`
                : '<div class="aerodeck-warn">Could not detect aircraft — spawn in one to continue.</div>'}</div>

            <div class="aerodeck-label">Passengers${flight.capacity ? ` (capacity ~${flight.capacity})` : ''}</div>
            ${boardingHtml}

            <div class="aerodeck-label">Doors</div>
            ${doorsHtml}
        `;

        container.querySelectorAll('.door-chip-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = btn.getAttribute('data-id');
                const door = flight.doors.find((d) => d.id === id);
                if (!door) return;
                door.open = !door.open;
                render();
            });
        });
        const openAll = container.querySelector('#aerodeck-doors-open-all');
        if (openAll) openAll.onclick = () => { flight.doors = setAllDoors(flight.doors, true); render(); };
        const closeAll = container.querySelector('#aerodeck-doors-close-all');
        if (closeAll) closeAll.onclick = () => { flight.doors = setAllDoors(flight.doors, false); render(); };

        const boardBtn = container.querySelector('#aerodeck-board-btn');
        const paxInput = container.querySelector('#aerodeck-pax-input');
        if (boardBtn) {
            boardBtn.onclick = () => {
                const raw = (paxInput ? paxInput.value : flight.paxTargetText || '').trim();
                flight.paxTargetText = raw;
                const n = parseInt(raw, 10);
                if (!raw || isNaN(n) || n <= 0) { flight.paxError = 'Enter a valid passenger count.'; render(); return; }
                if (flight.capacity != null && n > flight.capacity) { flight.paxError = `This aircraft can't carry ${n} passengers (capacity ~${flight.capacity}).`; render(); return; }
                flight.paxError = null; flight.paxTarget = n; flight.boardingStatus = 'boarding'; flight.boardingStartTs = Date.now();
                flight.boardingDurationMs = Math.min(180000, Math.max(25000, n * 350));
                render();
            };
        }
        const resetBtn = container.querySelector('#aerodeck-board-reset');
        if (resetBtn) resetBtn.onclick = () => {
            flight.boardingStatus = 'idle';
            flight.boardingStartTs = null;
            flight.boardingDurationMs = null;
            render();
        };
    }

function renderOfpTab(container) {
        container.innerHTML = `
            <div class="aerodeck-label">SimBrief Import</div>
            <input id="aerodeck-simbrief-username" class="aerodeck-input" type="text"
                   placeholder="SimBrief username" value="${escapeHtml(simbrief.usernameText || '')}" maxlength="40">
            <button id="aerodeck-simbrief-import" class="aerodeck-btn secondary" ${simbrief.status === 'loading' ? 'disabled' : ''}>
                ${simbrief.status === 'loading' ? 'IMPORTING…' : 'IMPORT LATEST OFP'}
            </button>
            ${simbrief.status === 'error' ? `<div class="aerodeck-card"><div class="aerodeck-warn">${escapeHtml(simbrief.error || 'Import failed')}</div></div>` : ''}
            ${simbrief.status === 'ready' && simbrief.weights ? renderSimbriefSummaryHtml(simbrief.weights) : ''}
            <div style="display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap;">
                <div class="aerodeck-card muted" style="font-size:10.5px;flex:1;margin:0;">SimBrief API returns the latest OFP only — generate a new plan on simbrief.com to switch flights.</div>
                ${simbrief.status === 'ready' || (flight.simbrief && flight.simbrief.used) ? `<button id="aerodeck-ofp-clear" class="aerodeck-btn secondary" style="margin-top:0;width:auto;padding:8px 14px;">CLEAR OFP</button>` : ''}
            </div>
            <div class="aerodeck-card muted" style="margin-top:12px;font-size:11px;">Boarding & doors are on the <span class="aerodeck-link" id="aerodeck-goto-aircraft">Aircraft</span> tab.</div>
        `;

        const sbInput = container.querySelector('#aerodeck-simbrief-username');
        if (sbInput) {
            sbInput.oninput = (e) => { simbrief.usernameText = e.target.value; };
            sbInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    fetchSimbriefPlan(simbrief.usernameText).then(() => { if (simbrief.status === 'ready') applySimbriefToFlight(); });
                }
            };
        }
        const sbBtn = container.querySelector('#aerodeck-simbrief-import');
        if (sbBtn) sbBtn.onclick = () => {
            fetchSimbriefPlan(simbrief.usernameText).then(() => { if (simbrief.status === 'ready') applySimbriefToFlight(); });
        };
        const clearOfp = container.querySelector('#aerodeck-ofp-clear');
        if (clearOfp) clearOfp.onclick = () => {
            if (!confirm('Clear the imported SimBrief OFP and related fields?')) return;
            simbrief.status = 'idle';
            simbrief.weights = null;
            simbrief.raw = null;
            simbrief.error = null;
            flight.simbrief = null;
            render();
        };
        const goAc = container.querySelector('#aerodeck-goto-aircraft');
        if (goAc) goAc.onclick = () => { activeTab = 'aircraft'; render(); };
    }


    // ------------------------------- sidebar -------------------------------

    function renderNavTab(container) {
        const pos = getCurrentLatLon() || { lat: null, lon: null };
        const spd = getCurrentGroundSpeedKts();
        const mach = getCurrentMach();
        let alt = null, hdg = null, vs = null, ias = null, tas = null;
        try {
            const a = geofs.aircraft.instance;
            if (a) {
                alt = a.animationValue && a.animationValue.altitude != null ? a.animationValue.altitude
                    : (a.altitude != null ? a.altitude : null);
                hdg = getCurrentHeading();
                if (a.animationValue) {
                    vs = a.animationValue.verticalSpeed;
                    ias = a.animationValue.kias || a.animationValue.airspeed;
                    tas = a.animationValue.ktas || a.animationValue.trueAirSpeed;
                }
            }
            if (window.geofs && geofs.animation && geofs.animation.values) {
                const av = geofs.animation.values;
                if (alt == null && av.altitude != null) alt = av.altitude;
                if (ias == null && av.kias != null) ias = av.kias;
                if (tas == null && av.ktas != null) tas = av.ktas;
                if (vs == null && av.verticalSpeed != null) vs = av.verticalSpeed;
                if (hdg == null && av.heading != null) hdg = av.heading;
            }
        } catch (e) { /* ignore */ }
        let etaDest = '—', distDest = '—', etaNext = '—';
        try {
            if (flight.destination && flight.destination.lat != null && pos.lat != null) {
                const nm = haversineNM(pos.lat, pos.lon, flight.destination.lat, flight.destination.lon);
                distDest = nm.toFixed(0) + ' nm';
                if (spd && spd > 20) {
                    const hrs = nm / spd;
                    const eta = new Date(Date.now() + hrs * 3600000);
                    etaDest = formatClockHMS(eta) + ' loc';
                }
            }
            if (window.geofs && geofs.flightPlan && typeof geofs.flightPlan.getNextWaypoint === 'function') {
                const wp = geofs.flightPlan.getNextWaypoint();
                if (wp && wp.lat != null && pos.lat != null && spd > 20) {
                    const nm = haversineNM(pos.lat, pos.lon, wp.lat, wp.lon);
                    const hrs = nm / spd;
                    etaNext = formatClockHMS(new Date(Date.now() + hrs * 3600000));
                }
            }
        } catch (e) { /* ignore */ }
        const fmt = (v, d=0) => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(d);
        container.innerHTML = `
            <div class="aerodeck-label">Live Navigation</div>
            <div class="aerodeck-track-grid">
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(ias, 0)}</div><div class="aerodeck-track-label">IAS kt</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(tas, 0)}</div><div class="aerodeck-track-label">TAS kt</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(spd, 0)}</div><div class="aerodeck-track-label">GS kt</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(mach, 2)}</div><div class="aerodeck-track-label">Mach</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(alt, 0)}</div><div class="aerodeck-track-label">ALT ft</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(vs, 0)}</div><div class="aerodeck-track-label">VS fpm</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${fmt(hdg, 0)}</div><div class="aerodeck-track-label">HDG °</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${pos.lat != null ? pos.lat.toFixed(3) : '—'}</div><div class="aerodeck-track-label">LAT</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${pos.lon != null ? pos.lon.toFixed(3) : '—'}</div><div class="aerodeck-track-label">LON</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value">${escapeHtml(distDest)}</div><div class="aerodeck-track-label">Dist DEST</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:12px;">${escapeHtml(etaDest)}</div><div class="aerodeck-track-label">ETA DEST</div></div>
                <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:12px;">${escapeHtml(etaNext)}</div><div class="aerodeck-track-label">ETA NEXT WP</div></div>
            </div>
            <div class="aerodeck-card muted" style="margin-top:10px;font-size:10.5px;">Values read live from GeoFS. Availability depends on the aircraft instrument data.</div>
        `;
    }

    function renderGalleryTab(container) {
        const base = (typeof CHARTS_BASE_URL !== 'undefined' ? CHARTS_BASE_URL.replace(/\/charts.?$/, '') : '') || 'https://raw.githubusercontent.com';
        container.innerHTML = `
            <div class="aerodeck-label">Gallery</div>
            <div class="aerodeck-card muted" style="font-size:11px;line-height:1.5;">
                Gallery will load low-resolution screenshots from the AeroDeck repository when an image index is published.
                For now this tab is a placeholder so it does not add network load or lag.
            </div>
            <div id="aerodeck-gallery-grid" class="aerodeck-widget-grid" style="margin-top:10px;"></div>
        `;
        const grid = container.querySelector('#aerodeck-gallery-grid');
        try {
            const url = (typeof GALLERY_INDEX_URL !== 'undefined' && GALLERY_INDEX_URL)
                ? GALLERY_INDEX_URL
                : null;
            if (!url) {
                grid.innerHTML = `<div class="aerodeck-widget"><div class="aerodeck-widget-sub">No gallery index configured yet.</div></div>`;
                return;
            }
            gmFetchText(url).then((t) => {
                const items = JSON.parse(t);
                if (!Array.isArray(items) || !items.length) {
                    grid.innerHTML = `<div class="aerodeck-widget"><div class="aerodeck-widget-sub">Gallery is empty.</div></div>`;
                    return;
                }
                grid.innerHTML = items.slice(0, 24).map((it) => {
                    const src = it.thumb || it.url || '';
                    const cap = it.caption || it.name || '';
                    return `<div class="aerodeck-widget" style="padding:6px;"><img src="${escapeHtml(src)}" alt="" style="width:100%;border-radius:8px;display:block;" loading="lazy"/><div class="aerodeck-widget-sub" style="margin-top:4px;">${escapeHtml(cap)}</div></div>`;
                }).join('');
            }).catch(() => {
                grid.innerHTML = `<div class="aerodeck-widget"><div class="aerodeck-widget-sub">Could not load gallery index.</div></div>`;
            });
        } catch (e) {
            grid.innerHTML = `<div class="aerodeck-widget"><div class="aerodeck-widget-sub">Gallery unavailable.</div></div>`;
        }
    }

function renderSidebar(sidebarEl) {
        sidebarEl.innerHTML = `
            <div>
                <div class="aerodeck-nav-item ${activeTab === 'home' ? 'active' : ''}" data-tab="home">${ICON_HOME}<span>Home</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'flight' ? 'active' : ''}" data-tab="flight">${ICON_FLIGHT}<span>Flight</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'ofp' ? 'active' : ''}" data-tab="ofp">${ICON_OFP}<span>OFP</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'aircraft' ? 'active' : ''}" data-tab="aircraft">${ICON_AIRCRAFT}<span>Aircraft</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'nav' ? 'active' : ''}" data-tab="nav">${ICON_NAV}<span>Nav</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'charts' ? 'active' : ''}" data-tab="charts">${ICON_CHARTS}<span>Charts</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'gallery' ? 'active' : ''}" data-tab="gallery">${ICON_GALLERY}<span>Gallery</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'map' ? 'active' : ''}" data-tab="map">${ICON_MAP}<span>Map</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'chat' ? 'active' : ''}" data-tab="chat">${ICON_CHAT}<span>Chat</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'checklist' ? 'active' : ''}" data-tab="checklist">${ICON_CHECK}<span>Checklist</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'history' ? 'active' : ''}" data-tab="history">${ICON_HISTORY}<span>History</span></div>
                <div class="aerodeck-nav-item ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">${ICON_SETTINGS}<span>Settings</span></div>
            </div>
        `;
        sidebarEl.querySelectorAll('.aerodeck-nav-item').forEach((el) => { el.onclick = () => { activeTab = el.getAttribute('data-tab'); render(); }; });
    }

    // ------------------------------- header route strip (slimmed) -------------------------------
    function renderRouteStrip(stripEl) {
        if (!(flight.origin && flight.destination)) { stripEl.innerHTML = `<span class="rs-empty">NO ROUTE</span>`; return; }
        const distNM = (flight.origin.lat != null && flight.destination.lat != null) ? haversineNM(flight.origin.lat, flight.origin.lon, flight.destination.lat, flight.destination.lon) : null;
        let timerHtml = '';
        if (flight.active) timerHtml = `<span class="rs-timer">${formatDuration(Date.now() - flight.startTimestamp)}</span>`;
        stripEl.innerHTML = `<span class="rs-route">${escapeHtml(flight.origin.icao)}</span><span class="rs-plane">&#9656;</span><span class="rs-route">${escapeHtml(flight.destination.icao)}</span>${distNM != null ? `<span class="rs-dist">${distNM}nm</span>` : ''}${timerHtml}`;
    }

    function renderStatusStrip(el) {
        const profile = getProfile();
        el.innerHTML = `
            <span class="aerodeck-status-credit">©2026 machpoint82 AeroDeck</span>
            <span style="flex:1"></span>
            ${profile ? `<span class="aerodeck-status-user">${escapeHtml(profile.name)}</span>` : ''}
            <span class="aerodeck-status-time">${formatClockHMS(new Date())}</span>
            ${ICON_SIGNAL(backendReachable)}${ICON_BATTERY(getCosmeticBatteryPct())}
        `;
    }

    // ------------------------------- main render -------------------------------
    let renderScheduled = false;
    function render() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            renderNow();
        });
    }
    function renderNow() {
        if (!tabletEl) return;
        const profile = getProfile();
        const routeStrip = tabletEl.querySelector('#aerodeck-route-strip');
        const plusBtn = tabletEl.querySelector('#aerodeck-plus-btn');
        const main = tabletEl.querySelector('#aerodeck-main');
        const statusStrip = tabletEl.querySelector('#aerodeck-status-strip');
        if (routeStrip) renderRouteStrip(routeStrip);
        if (statusStrip) renderStatusStrip(statusStrip);

        if (minimized) {
            if (leafletMap) { try { leafletMap.remove(); } catch (e) {} leafletMap = null; ownMarker = null; originMarker = null; destMarker = null; waypointsLayer = null; multiplayerLayer = null; }
            renderMinimized();
            return;
        }
        if (miniLeafletMap) destroyMiniMap();

        if (!profile) {
            if (plusBtn) plusBtn.style.display = 'none';
            main.innerHTML = `<div id="aerodeck-content"></div>`;
            renderRegisterView(main.querySelector('#aerodeck-content'));
            return;
        }
        if (plusBtn) plusBtn.style.display = (activeTab === 'flight' && !flight.active) ? 'flex' : 'none';

        const prevContent = main.querySelector('#aerodeck-content');
        const prevScrollTop = prevContent ? prevContent.scrollTop : 0;
        main.innerHTML = `<div id="aerodeck-sidebar"></div><div id="aerodeck-content" style="position:relative;"></div>`;
        renderSidebar(main.querySelector('#aerodeck-sidebar'));
        const content = main.querySelector('#aerodeck-content');
        if (activeTab !== 'map' && leafletMap) { try { leafletMap.remove(); } catch (e) {} leafletMap = null; ownMarker = null; originMarker = null; destMarker = null; waypointsLayer = null; multiplayerLayer = null; }
        if (activeTab !== 'charts') chartState = null;

        if (activeTab === 'home') renderHomeTab(content, profile);
        else if (activeTab === 'flight') renderFlightTab(content, profile);
        else if (activeTab === 'ofp') renderOfpTab(content);
        else if (activeTab === 'aircraft') renderAircraftTab(content);
        else if (activeTab === 'nav') renderNavTab(content);
        else if (activeTab === 'gallery') renderGalleryTab(content);
        else if (activeTab === 'charts') renderChartsTab(content);
        else if (activeTab === 'map') renderMapTab(content);
        else if (activeTab === 'chat') renderChatTab(content, profile);
        else if (activeTab === 'checklist') renderChecklistTab(content, profile);
        else if (activeTab === 'settings') renderSettingsTab(content, profile);
        else renderHistoryTab(content, profile);
        content.scrollTop = prevScrollTop;
        if (activeTab === 'chat' || activeTab === 'map' || activeTab === 'charts') content.classList.add('tab-fill');
        else content.classList.remove('tab-fill');
        if (activeTab !== 'charts' && tabletEl) tabletEl.classList.remove('charts-maximized');

        const cClose = content.querySelector('#aerodeck-countries-close'); if (cClose) cClose.onclick = () => { showCountriesModal = false; render(); };
        const cCloseBtn = content.querySelector('#aerodeck-countries-close-btn'); if (cCloseBtn) cCloseBtn.onclick = () => { showCountriesModal = false; render(); };
        const aClose = content.querySelector('#aerodeck-ach-close'); if (aClose) aClose.onclick = () => { showAchievementsModal = false; render(); };
        const aCloseBtn = content.querySelector('#aerodeck-ach-close-btn'); if (aCloseBtn) aCloseBtn.onclick = () => { showAchievementsModal = false; render(); };
    }
    function renderIfOpen() { if (panelOpen && !minimized) render(); }

    // ------------------------------- geometry persistence -------------------------------
    function getGeometry() { return gmGet(STORAGE.GEOMETRY, null); }
    function saveGeometry(patch) { const cur = getGeometry() || {}; gmSet(STORAGE.GEOMETRY, Object.assign({}, cur, patch)); }
    function clampRectToViewport(rect) {
        const width = Math.min(rect.width, window.innerWidth - 20);
        const height = Math.min(rect.height, window.innerHeight - 20);
        const maxLeft = Math.max(0, window.innerWidth - width), maxTop = Math.max(0, window.innerHeight - height);
        return { width, height, left: Math.min(Math.max(0, rect.left), maxLeft), top: Math.min(Math.max(0, rect.top), maxTop) };
    }
    function clampPointToViewport(pt, w, h) {
        const maxLeft = Math.max(0, window.innerWidth - w), maxTop = Math.max(0, window.innerHeight - h);
        return { left: Math.min(Math.max(0, pt.left), maxLeft), top: Math.min(Math.max(0, pt.top), maxTop) };
    }
    function saveFullRectFromEl(el) { const rect = el.getBoundingClientRect(); saveGeometry({ full: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } }); }
    function saveMiniPosFromEl(el) { const rect = el.getBoundingClientRect(); saveGeometry({ mini: { top: rect.top, left: rect.left }, miniSizeIndex }); }

    // ------------------------------- drag / resize helpers -------------------------------
    function makeDraggable(handle, target, signal, onEnd) {
        let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            dragging = true;
            const rect = target.getBoundingClientRect();
            target.style.left = rect.left + 'px'; target.style.top = rect.top + 'px'; target.style.right = 'auto'; target.style.bottom = 'auto'; target.style.transform = 'none';
            startX = e.clientX; startY = e.clientY; startLeft = rect.left; startTop = rect.top;
            e.preventDefault();
        }, { signal });
        document.addEventListener('mousemove', (e) => { if (!dragging) return; target.style.left = (startLeft + e.clientX - startX) + 'px'; target.style.top = (startTop + e.clientY - startY) + 'px'; }, { signal });
        document.addEventListener('mouseup', () => { if (dragging && onEnd) onEnd(); dragging = false; }, { signal });
    }
    function makeResizable(handle, target, signal, onEnd, minW, minH, maxW, maxH) {
        let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
        handle.addEventListener('mousedown', (e) => {
            resizing = true;
            const rect = target.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY; startW = rect.width; startH = rect.height;
            e.preventDefault(); e.stopPropagation();
        }, { signal });
        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            target.style.width = Math.max(minW, Math.min(maxW, startW + (e.clientX - startX))) + 'px';
            target.style.height = Math.max(minH, Math.min(maxH, startH + (e.clientY - startY))) + 'px';
        }, { signal });
        document.addEventListener('mouseup', () => { if (resizing && onEnd) onEnd(); resizing = false; }, { signal });
    }

    // ------------------------------- minimized (small tablet) render -------------------------------
    function renderMinimized() {
        if (!tabletEl) return;
        const main = tabletEl.querySelector('#aerodeck-main');
        const plusBtn = tabletEl.querySelector('#aerodeck-plus-btn');
        if (plusBtn) plusBtn.style.display = 'none';
        if (!main) return;
        main.innerHTML = `
            <div id="aerodeck-mini-body">
                <div class="aerodeck-mini-toolbar">
                    <button class="aerodeck-mini-btn ${miniView === 'map' ? 'active' : ''}" id="aerodeck-mini-map-btn">MAP</button>
                    <button class="aerodeck-mini-btn ${miniView === 'charts' ? 'active' : ''}" id="aerodeck-mini-charts-btn">CHARTS</button>
                    <button class="aerodeck-mini-btn ${miniView === 'nav' ? 'active' : ''}" id="aerodeck-mini-nav-btn">NAV</button>
                    ${miniView === 'charts' ? `<button class="aerodeck-mini-icon-btn" id="aerodeck-mini-chart-search-btn" title="Search airport">${ICON_SEARCH}</button>` : ''}
                </div>
                ${miniView === 'charts' && miniChartSearchOpen ? `
                <div class="aerodeck-mini-search-row">
                    <input id="aerodeck-mini-chart-icao-input" class="aerodeck-input" type="text" placeholder="ICAO" maxlength="4" value="${escapeHtml(miniChartIcaoText)}">
                    <button id="aerodeck-mini-chart-load-btn" class="aerodeck-btn secondary">GO</button>
                </div>` : ''}
                ${miniView === 'nav' ? '<div id="aerodeck-mini-nav"></div>' : '<div id="aerodeck-mini-canvas"></div>'}
            </div>`;
        main.querySelector('#aerodeck-mini-map-btn').onclick = () => { if (miniView !== 'map') { destroyMiniMap(); miniView = 'map'; miniChartSearchOpen = false; renderMinimized(); } };
        main.querySelector('#aerodeck-mini-charts-btn').onclick = () => { if (miniView !== 'charts') { destroyMiniMap(); miniView = 'charts'; chartState = null; renderMinimized(); } };
        main.querySelector('#aerodeck-mini-nav-btn').onclick = () => { if (miniView !== 'nav') { destroyMiniMap(); miniView = 'nav'; miniChartSearchOpen = false; renderMinimized(); } };
        const miniSearchBtn = main.querySelector('#aerodeck-mini-chart-search-btn');
        if (miniSearchBtn) miniSearchBtn.onclick = () => { miniChartSearchOpen = !miniChartSearchOpen; renderMinimized(); };
        const miniIcaoInput = main.querySelector('#aerodeck-mini-chart-icao-input');
        const miniLoadBtn = main.querySelector('#aerodeck-mini-chart-load-btn');
        if (miniIcaoInput && miniLoadBtn) {
            miniIcaoInput.oninput = (e) => { miniChartIcaoText = e.target.value.toUpperCase(); };
            const doMiniLoad = () => {
                const v = (miniChartIcaoText || '').trim().toUpperCase();
                if (!/^[A-Z]{4}$/.test(v)) return;
                miniChartIcaoOverride = v;
                miniChartSearchOpen = false;
                chartState = null;
                renderMinimized();
            };
            miniLoadBtn.onclick = doMiniLoad;
            miniIcaoInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doMiniLoad(); } };
            miniIcaoInput.focus();
        }

        if (miniView === 'nav') {
            const navEl = main.querySelector('#aerodeck-mini-nav');
            const pos = getCurrentLatLon() || {};
            const spd = getCurrentGroundSpeedKts();
            let alt = null, hdg = getCurrentHeading(), ias = null;
            try {
                if (geofs.animation && geofs.animation.values) {
                    const av = geofs.animation.values;
                    alt = av.altitude; ias = av.kias || av.airspeed;
                }
            } catch (e) {}
            let eta = '—', dist = '—';
            try {
                if (flight.destination && flight.destination.lat != null && pos.lat != null) {
                    const nm = haversineNM(pos.lat, pos.lon, flight.destination.lat, flight.destination.lon);
                    dist = nm.toFixed(0) + ' nm';
                    if (spd && spd > 20) eta = formatClockHMS(new Date(Date.now() + (nm / spd) * 3600000));
                }
            } catch (e) {}
            const fmt = (v, d=0) => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(d);
            navEl.innerHTML = `
                <div class="aerodeck-track-grid" style="grid-template-columns:1fr 1fr;">
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:14px;">${fmt(ias,0)}</div><div class="aerodeck-track-label">IAS</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:14px;">${fmt(spd,0)}</div><div class="aerodeck-track-label">GS</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:14px;">${fmt(alt,0)}</div><div class="aerodeck-track-label">ALT</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:14px;">${fmt(hdg,0)}</div><div class="aerodeck-track-label">HDG</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:12px;">${escapeHtml(dist)}</div><div class="aerodeck-track-label">DIST</div></div>
                    <div class="aerodeck-track-item"><div class="aerodeck-track-value" style="font-size:12px;">${escapeHtml(eta)}</div><div class="aerodeck-track-label">ETA</div></div>
                </div>

            `;
            return;
        }

        if (miniView === 'map') {
            ensureLeaflet().then(() => {
                const canvas = main.querySelector('#aerodeck-mini-canvas');
                if (!canvas || !panelOpen || minimized !== true) return;
                const body = main.querySelector('#aerodeck-mini-body');
                if (body) {
                    const tb = body.querySelector('.aerodeck-mini-toolbar');
                    const h = Math.max(80, body.clientHeight - (tb ? tb.offsetHeight : 28) - 12);
                    canvas.style.height = h + 'px';
                }
                try {
                    if (miniLeafletMap) { miniLeafletMap.remove(); miniLeafletMap = null; }
                } catch (e) {}
                initMiniMap(canvas);
                setTimeout(() => { try { if (miniLeafletMap) miniLeafletMap.invalidateSize(true); } catch (e) {} }, 100);
                setTimeout(() => { try { if (miniLeafletMap) miniLeafletMap.invalidateSize(true); } catch (e) {} }, 350);
            }).catch((err) => {
                const canvas = main.querySelector('#aerodeck-mini-canvas');
                if (canvas) canvas.innerHTML = `<div class="aerodeck-warn" style="padding:8px;">${escapeHtml(err.message || 'Map failed')}</div>`;
            });
        } else if (miniView === 'charts') {
            const canvas = main.querySelector('#aerodeck-mini-canvas');
            const icao = miniChartIcaoOverride || (flight.origin && flight.origin.icao) || (flight.destination && flight.destination.icao);
            if (!icao) {
                canvas.innerHTML = `<div class="aerodeck-card muted" style="margin:8px;">Set a route, or use the search icon above, to load a chart</div>`;
                return;
            }
            loadChartData(icao).then((data) => {
                const freshCanvas = main.querySelector('#aerodeck-mini-canvas');
                if (!freshCanvas) return;
                if (!data) { freshCanvas.innerHTML = `<div class="aerodeck-card muted" style="margin:8px;">No diagram for ${escapeHtml(icao)}</div>`; return; }
                const body = main.querySelector('#aerodeck-mini-body');
                if (body) {
                    const tb = body.querySelector('.aerodeck-mini-toolbar');
                    const sr = body.querySelector('.aerodeck-mini-search-row');
                    const h = Math.max(80, body.clientHeight - (tb ? tb.offsetHeight : 28) - (sr ? sr.offsetHeight : 0) - 12);
                    freshCanvas.style.height = h + 'px';
                }
                const built = buildChartSVG(freshCanvas, data, icao);
                chartState = built;
                updateChartAircraft();
                refreshPresenceIfStale();
            });
        }
    }

    let miniView = 'map';
    let miniChartSearchOpen = false;
    let miniChartIcaoText = '';
    let miniChartIcaoOverride = null;

    // ------------------------------- open / close / minimize -------------------------------
    let dataLoadStarted = false;
    function ensureDataLoaded() { if (dataLoadStarted) return; dataLoadStarted = true; initData(); }

    function openPanel() {
        if (panelOpen) return;
        panelOpen = true; minimized = false;
        injectStyles(); ensureDataLoaded();
        checkForUpdate();
        dragAbort = new AbortController();
        backdropEl = document.createElement('div'); backdropEl.id = 'aerodeck-backdrop'; backdropEl.onclick = closePanel;
        document.body.appendChild(backdropEl);
        tabletEl = document.createElement('div'); tabletEl.id = 'aerodeck-tablet'; tabletEl.onclick = (e) => e.stopPropagation();
        tabletEl.innerHTML = `
            <div id="aerodeck-status-strip"></div>
            <div id="aerodeck-screen">
                <div id="aerodeck-topbar">
                    <div class="aerodeck-title">AERODECK</div>
                    <div class="aerodeck-route-strip" id="aerodeck-route-strip"></div>
                    <div class="aerodeck-topbar-actions">
                        <button class="aerodeck-icon-btn" id="aerodeck-plus-btn" title="New flight">${ICON_PLUS}</button>
                        <button class="aerodeck-icon-btn" id="aerodeck-minimize-btn" title="Minimize">${ICON_MINIMIZE}</button>
                        <button class="aerodeck-icon-btn" id="aerodeck-close-x" title="Close">&#10005;</button>
                    </div>
                </div>
                <div id="aerodeck-main"></div>
            </div>
            <div id="aerodeck-resize-handle" title="Drag to resize"></div>
        `;
        document.body.appendChild(tabletEl);
        const savedTheme = getTheme();
        if (savedTheme && savedTheme !== 'default') tabletEl.classList.add('theme-' + savedTheme);

        const geom = getGeometry();
        if (geom && geom.full) {
            const clamped = clampRectToViewport(geom.full);
            tabletEl.style.top = clamped.top + 'px'; tabletEl.style.left = clamped.left + 'px';
            tabletEl.style.width = clamped.width + 'px'; tabletEl.style.height = clamped.height + 'px';
            tabletEl.style.right = 'auto'; tabletEl.style.bottom = 'auto'; tabletEl.style.transform = 'none';
        }
        if (geom && geom.miniSizeIndex != null) miniSizeIndex = geom.miniSizeIndex;

        tabletEl.addEventListener('pointerdown', markUiInteract, true);
        tabletEl.addEventListener('touchstart', markUiInteract, { capture: true, passive: true });
        tabletEl.querySelector('#aerodeck-close-x').onclick = closePanel;
        tabletEl.querySelector('#aerodeck-plus-btn').onclick = () => { if (activeTab === 'flight' && !flight.active) { flight = blankFlight(); render(); } };
        tabletEl.querySelector('#aerodeck-minimize-btn').onclick = () => (minimized ? restore() : minimize());

        const topbar = tabletEl.querySelector('#aerodeck-topbar');
        makeDraggable(topbar, tabletEl, dragAbort.signal, () => { if (minimized) saveMiniPosFromEl(tabletEl); else saveFullRectFromEl(tabletEl); });

        const resizeHandle = tabletEl.querySelector('#aerodeck-resize-handle');
        makeResizable(resizeHandle, tabletEl, dragAbort.signal, () => {
            if (minimized) {
                const rect = tabletEl.getBoundingClientRect();
                let nearestIdx = 0, nearestD = Infinity;
                MINI_SIZES.forEach((s, i) => { const d = Math.abs(s.w - rect.width) + Math.abs(s.h - rect.height); if (d < nearestD) { nearestD = d; nearestIdx = i; } });
                miniSizeIndex = nearestIdx;
                applyMiniSize();
                saveMiniPosFromEl(tabletEl);
            } else saveFullRectFromEl(tabletEl);
        }, minimized ? 200 : 380, minimized ? 120 : 320, minimized ? 520 : Math.max(1200, window.innerWidth - 16), minimized ? 320 : Math.max(900, window.innerHeight - 16));

        ['keydown', 'keyup', 'keypress'].forEach((evt) => { tabletEl.addEventListener(evt, (e) => { e.stopPropagation(); }, { signal: dragAbort.signal }); });

        const profile = getProfile();
        if (profile) { checklistState = getChecklistState(profile.id); startPresenceBroadcast(profile); }
        render();
    }
    function applyMiniSize() {
        const s = MINI_SIZES[miniSizeIndex] || MINI_SIZES[0];
        tabletEl.style.width = s.w + 'px'; tabletEl.style.height = s.h + 'px';
        setTimeout(() => {
            try { if (leafletMap) leafletMap.invalidateSize(); } catch (e) {}
            try {
                const c = tabletEl.querySelector('#aerodeck-chart-canvas, #aerodeck-mini-canvas');
                if (c && chartState && chartState.svg) {
                    c.style.height = '100%';
                }
            } catch (e) {}
        }, 80);
    }
    function minimize() {
        if (!panelOpen || minimized) return;
        saveFullRectFromEl(tabletEl);
        minimized = true;
        tabletEl.classList.add('is-mini');
        backdropEl.style.display = 'none';
        const geom = getGeometry();
        if (geom && geom.mini) {
            const s = MINI_SIZES[miniSizeIndex] || MINI_SIZES[0];
            const clamped = clampPointToViewport(geom.mini, s.w, s.h);
            tabletEl.style.top = clamped.top + 'px'; tabletEl.style.left = clamped.left + 'px';
        } else {
            const s = MINI_SIZES[miniSizeIndex] || MINI_SIZES[0];
            tabletEl.style.top = (window.innerHeight - s.h - 24) + 'px'; tabletEl.style.left = (window.innerWidth - s.w - 24) + 'px';
        }
        applyMiniSize();
        tabletEl.style.right = 'auto'; tabletEl.style.bottom = 'auto'; tabletEl.style.transform = 'none';
        render();
    }
    function restore() {
        if (!panelOpen || !minimized) return;
        saveMiniPosFromEl(tabletEl);
        minimized = false;
        tabletEl.classList.remove('is-mini');
        const geom = getGeometry();
        if (geom && geom.full) {
            const clamped = clampRectToViewport(geom.full);
            tabletEl.style.top = clamped.top + 'px'; tabletEl.style.left = clamped.left + 'px';
            tabletEl.style.width = clamped.width + 'px'; tabletEl.style.height = clamped.height + 'px';
        } else {
            tabletEl.style.width = ''; tabletEl.style.height = '';
            tabletEl.style.top = '50%'; tabletEl.style.left = '50%'; tabletEl.style.transform = 'translate(-50%, -50%)';
        }
        backdropEl.style.display = 'block';
        render();
    }
    function closePanel() {
        panelOpen = false; minimized = false;
        if (dragAbort) { dragAbort.abort(); dragAbort = null; }
        if (leafletMap) { try { leafletMap.remove(); } catch (e) {} leafletMap = null; ownMarker = null; originMarker = null; destMarker = null; waypointsLayer = null; multiplayerLayer = null; }
        destroyMiniMap();
        if (tabletEl) { tabletEl.remove(); tabletEl = null; }
        if (backdropEl) { backdropEl.remove(); backdropEl = null; }
    }

    // ------------------------------- live tracking tick -------------------------------
    setInterval(() => {
        if (!panelOpen) return;
        if (minimized) {
            if (miniView === 'map') updateMapLive();
            else { updateChartAircraft(); refreshPresenceIfStale(); }
            const strip = tabletEl && tabletEl.querySelector('#aerodeck-route-strip');
            if (strip) renderRouteStrip(strip);
            return;
        }
        if (activeTab === 'map') { updateMapLive(); const strip = tabletEl && tabletEl.querySelector('#aerodeck-route-strip'); if (strip && flight.active) renderRouteStrip(strip); return; }
        if (activeTab === 'charts') { updateChartAircraft(); refreshPresenceIfStale(); }
        if (minimized || activeTab === 'home' || activeTab === 'flight' || activeTab === 'aircraft' || activeTab === 'ofp' || activeTab === 'nav') {
            const activeEl = document.activeElement;
            const typing = activeEl && activeEl.tagName === 'INPUT' && tabletEl && tabletEl.contains(activeEl);
            const recentTouch = (Date.now() - lastUiInteractTs) < 700;
            if (!typing && !recentTouch) render();
            else if (flight.active) { const strip = tabletEl && tabletEl.querySelector('#aerodeck-route-strip'); if (strip) renderRouteStrip(strip); }
        } else if (flight.active) { const strip = tabletEl && tabletEl.querySelector('#aerodeck-route-strip'); if (strip) renderRouteStrip(strip); }
    }, 1000);

    // ------------------------------- toolbar button -------------------------------
    function addToolbarButton() {
        if (document.getElementById('aerodeck-toolbar-button')) return;
        const buttonDiv = document.createElement('div');
        buttonDiv.innerHTML = `<button class="mdl-button mdl-js-button geofs-f-standard-ui geofs-mediumScreenOnly" data-tooltip-classname="mdl-tooltip--top" tabindex="0" id="aerodeck-toolbar-button" size="50%">EFB</button>`;
        let retryCount = 0;
        function tryInsert() {
            if (document.getElementById('aerodeck-toolbar-button')) return;
            const bottomUI = document.getElementsByClassName('geofs-ui-bottom')[0];
            if (bottomUI) {
                const element = buttonDiv.firstElementChild;
                if (typeof geofs !== 'undefined' && geofs.version >= 3.6) bottomUI.insertBefore(element, bottomUI.children[5] || null);
                else bottomUI.insertBefore(element, bottomUI.children[4] || null);
                element.onclick = function () { if (!panelOpen) { openPanel(); return; } if (minimized) { restore(); return; } closePanel(); };
            } else if (retryCount < 30) { retryCount++; setTimeout(tryInsert, 300); }
        }
        tryInsert();
    }
    function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
    ready(() => { addToolbarButton(); installOpenShortcutListener(); });
    setTimeout(addToolbarButton, 3000);
    setTimeout(installOpenShortcutListener, 500);
})();
