"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "../script.js"), "utf8");

// Uji script asli dengan waktu, DOM, dan backend media yang dikendalikan.
function setup({ cached = false, audioUrl = "" } = {}) {
  const timers = new Map();
  const elements = new Map();
  const documentListeners = {};
  const created = [];
  const scripts = [];
  const calls = { play: 0, pause: 0, unmute: 0, constructors: 0, audio: 0 };
  let nextTimer = 0;
  let events;
  let audio;
  function element() {
    const classes = new Set();
    return {
      attrs: {}, listeners: {},
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      click() { return this.listeners.click(); },
      replaceWith(replacement) { elements.set("#yt-player", replacement); },
      remove() { this.removed = true; },
      scrollIntoView() {},
    };
  }
  for (const id of ["yt-player", "btn-music", "cover", "btn-open", "beranda"]) elements.set(`#${id}`, element());
  const fakePlayer = {
    playVideo() { calls.play++; }, pauseVideo() { calls.pause++; },
    unMute() { calls.unmute++; }, setVolume(value) { calls.volume = value; },
  };
  const YT = {
    PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
    Player: function (id, options) { calls.constructors++; events = options.events; return fakePlayer; },
  };
  const window = {
    matchMedia: () => ({ matches: false }),
    location: new URL("https://invitation.example/?to=Budi%20Santoso"),
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
  };
  const document = {
    querySelector: selector => elements.get(selector),
    addEventListener(name, listener) { documentListeners[name] = listener; },
    createElement(tag) { created.push(tag); return element(); },
    body: element(),
    head: { appendChild(script) {
      assert.equal(typeof window.onYouTubeIframeAPIReady, "function");
      scripts.push(script);
    } },
  };
  function Audio(url) {
    calls.audio++;
    audio = element(); audio.src = url; audio.paused = true;
    audio.play = () => { audio.paused = false; calls.play++; return Promise.resolve(); };
    audio.pause = () => { audio.paused = true; calls.pause++; audio.listeners.pause(); };
    return audio;
  }
  if (cached) window.YT = YT;
  const context = vm.createContext({window, document, Audio, URLSearchParams,
    clearTimeout: id => timers.delete(id), setTimeout: window.setTimeout});
  vm.runInContext(source, context);
  vm.runInContext(`CONFIG.musicAudioUrl = ${JSON.stringify(audioUrl)}`, context);
  context.toast = () => assert.fail("Musik tidak boleh menampilkan toast");
  context.initMusic(); context.initCover();
  return {
    context, calls, created, scripts,
    el: id => elements.get(`#${id}`),
    get audio() { return audio; },
    load() { window.YT = YT; window.onYouTubeIframeAPIReady(); },
    ready() { events.onReady({target: fakePlayer}); },
    state(data) { events.onStateChange({data}); },
    blocked() { events.onAutoplayBlocked({}); },
    error(data = 153) { events.onError({data}); },
    gesture(target = null) { documentListeners.click({target: {closest: () => target}}); },
    timeout() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === 12000) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

test("hanya tombol kecil: tidak ada markup/style panel atau pesan error musik", () => {
  const html = readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const css = readFileSync(path.join(__dirname, "../style.css"), "utf8");
  assert.doesNotMatch(html + css, /music-panel|music-status|music-close|music-copy-link|music-youtube-link/);
  assert.match(html, /class="music-btn"/);
  assert.match(html, /class="yt-holder" aria-hidden="true"/);
  assert.doesNotMatch(html, /<script src="https:\/\/www.youtube.com\/iframe_api"/);
});

test("izin/referrer dipasang sebelum iframe dimuat dan origin sesuai hosting", () => {
  const h = setup();
  const frame = h.el("yt-player");
  assert.equal(frame.attrs.allow, "autoplay; encrypted-media");
  assert.equal(frame.attrs.referrerpolicy, "strict-origin-when-cross-origin");
  const url = new URL(frame.src);
  assert.equal(url.searchParams.get("origin"), "https://invitation.example");
  assert.equal(url.searchParams.get("controls"), "0");
  assert.equal(url.searchParams.get("playsinline"), "1");
  assert.equal(url.searchParams.get("playlist"), "viW0M5R2BLo");
});

test("musik dimulai langsung dari klik pembuka dan status menunggu konfirmasi PLAYING", () => {
  const h = setup(); h.load(); h.ready();
  assert.equal(h.calls.play, 0);
  h.el("btn-open").click();
  assert.equal(h.calls.play, 1);
  assert.equal(h.calls.unmute, 1);
  assert.notEqual(h.el("btn-music").attrs["aria-pressed"], "true");
  h.state(1); h.timeout();
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "true");
});

test("API terlambat lalu autoplay diblokir: klik berikutnya mencoba lagi tanpa UI tambahan", () => {
  const h = setup(); h.el("btn-open").click(); h.load(); h.ready(); h.blocked();
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "false");
  h.gesture(); assert.equal(h.calls.play, 2);
  h.state(1);
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "true");
  assert.deepEqual(h.created, ["iframe", "script"]);
});

test("klik tombol musik/pembuka tidak diulang oleh listener klik dokumen", () => {
  const h = setup(); h.load(); h.ready(); h.el("btn-open").click(); h.blocked();
  h.gesture({id: "btn-music"});
  assert.equal(h.calls.play, 1);
  h.el("btn-music").click();
  assert.equal(h.calls.play, 2);
});

test("menjeda saat loading membatalkan autoplay, termasuk event PLAYING terlambat", () => {
  const h = setup(); h.el("btn-open").click(); h.el("btn-music").click();
  h.load(); h.ready(); h.gesture();
  assert.equal(h.calls.play, 0);
  h.state(1); assert.equal(h.calls.pause, 1);
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "false");
});

test("tombol putar/jeda dapat melanjutkan; klik halaman tidak membatalkan jeda tamu", () => {
  const h = setup(); h.load(); h.ready(); h.el("btn-open").click(); h.state(1);
  h.el("btn-music").click(); h.state(2); h.gesture();
  assert.equal(h.calls.play, 1); assert.equal(h.calls.pause, 1);
  h.el("btn-music").click(); assert.equal(h.calls.play, 2);
});

test("timeout tetap diam dan tombol kecil dapat mencoba ulang", () => {
  const h = setup(); h.load(); h.ready(); h.el("btn-open").click(); h.timeout();
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "false");
  h.el("btn-music").click(); assert.equal(h.calls.play, 2);
});

test("API gagal diunduh bisa dicoba lagi pada klik berikutnya", () => {
  const h = setup(); h.el("btn-open").click(); h.scripts[0].onerror(); h.gesture();
  assert.equal(h.scripts.length, 2);
  assert.equal(h.scripts[0].removed, true);
});

for (const code of [100, 101, 150, 153, 5]) {
  test(`error YouTube ${code} tetap diam dan menghentikan upaya otomatis`, () => {
    const h = setup(); h.load(); h.ready(); h.el("btn-open").click(); h.error(code); h.gesture();
    assert.equal(h.calls.play, 1);
    assert.equal(h.el("btn-music").attrs["aria-pressed"], "false");
  });
}

test("API tersedia tidak diunduh ulang dan player dibuat satu kali", () => {
  const h = setup({cached: true}); h.load(); h.load();
  assert.equal(h.scripts.length, 0); assert.equal(h.calls.constructors, 1);
});

test("URL audio memakai audio native melalui tombol yang sama tanpa memuat YouTube", () => {
  const h = setup({audioUrl: "/assets/lagu.mp3"});
  assert.equal(h.audio.src, "/assets/lagu.mp3");
  assert.equal(h.audio.loop, true); assert.equal(h.scripts.length, 0);
  assert.equal(h.calls.play, 0);
  h.el("btn-open").click(); assert.equal(h.calls.play, 1);
  h.audio.listeners.playing();
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "true");
  h.el("btn-music").click(); h.gesture();
  assert.equal(h.calls.play, 1); assert.equal(h.calls.pause, 1);
});

test("audio native yang diblokir dapat dicoba lagi tanpa toast/panel", async () => {
  const h = setup({audioUrl: "/assets/lagu.mp3"});
  h.audio.play = () => { h.calls.play++; return Promise.reject({name: "NotAllowedError"}); };
  h.el("btn-open").click(); await Promise.resolve();
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "false");
  h.gesture(); assert.equal(h.calls.play, 2); await Promise.resolve();
});

test("penolakan play lama tidak membatalkan permintaan audio yang lebih baru", async () => {
  const h = setup({audioUrl: "/assets/lagu.mp3"});
  let rejectOld;
  h.audio.play = () => new Promise((resolve, reject) => { rejectOld = reject; });
  h.el("btn-open").click(); h.el("btn-music").click();
  h.audio.play = () => Promise.resolve();
  h.el("btn-music").click(); h.audio.listeners.playing();
  rejectOld({name: "NotAllowedError"}); await Promise.resolve();
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "true");
});

test("audio error tidak membuat UI baru atau memutar ulang saat tamu mengklik halaman", () => {
  const h = setup({audioUrl: "/assets/lagu.mp3"}); h.el("btn-open").click();
  h.audio.listeners.error(); h.gesture();
  assert.equal(h.calls.play, 1);
  assert.equal(h.el("btn-music").attrs["aria-pressed"], "false");
  assert.deepEqual(h.created, []);
});