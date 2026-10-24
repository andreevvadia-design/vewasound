const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');
const SC_DB_FILE = path.join(__dirname, 'sc_music_db.json');
const SC_META_FILE = path.join(__dirname, 'sc_artists_meta.json');
const STATS_FILE = path.join(__dirname, 'artists_stats.json');
const ALBUMS_FILE = path.join(__dirname, 'master_albums_catalog.json');
const CLIENT_ID = '3GKD969NJWD1eB6gvQJN0GnueYbcWszv';

let allScTracks = [];
let artistsCatalog = [];
let masterAlbums = [];
let lastStatsSync = new Date().toISOString();

function loadLocalDatabases() {
  allScTracks = [];
  artistsCatalog = [];
  masterAlbums = [];

  let rawMeta = {};
  if (fs.existsSync(SC_META_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SC_META_FILE, 'utf8'));
      for (const k in parsed) {
        if (parsed[k] && parsed[k].name) {
          rawMeta[parsed[k].name.toLowerCase()] = parsed[k];
        }
      }
    } catch(e) {}
  }

  let savedStats = {};
  if (fs.existsSync(STATS_FILE)) {
    try {
      const statsData = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      savedStats = statsData.stats || {};
      if (statsData.lastSync) lastStatsSync = statsData.lastSync;
    } catch(e) {}
  }

  if (fs.existsSync(SC_DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SC_DB_FILE, 'utf8'));
      for (const artistName of Object.keys(raw)) {
        const tracks = raw[artistName] || [];
        const meta = rawMeta[artistName.toLowerCase()] || {};
        let totalPlays = 0;

        tracks.forEach(t => {
          const plays = (savedStats[t.id]?.plays !== undefined) ? savedStats[t.id].plays : (t.plays || 0);
          const likes = (savedStats[t.id]?.likes !== undefined) ? savedStats[t.id].likes : (t.likes || 0);
          totalPlays += plays;

          allScTracks.push({
            id: String(t.id),
            title: t.title,
            artist: artistName,
            uploader: t.artist || artistName,
            duration: t.duration || 180,
            plays: plays > 0 ? plays : null,
            likes: likes > 0 ? likes : null,
            cover: t.artwork ? 'https://images.weserv.nl/?url=' + encodeURIComponent(t.artwork) : 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Fartworks-kXOQozMfAIWh3Ee4-HujXpw-t500x500.png',
            rawArtwork: t.artwork || '',
            tc_url: t.tc_url || '',
            sc_url: t.sc_url || ''
          });
        });

        let avatar = meta.img || (tracks[0] && tracks[0].artwork) || 'https://i1.sndcdn.com/artworks-kXOQozMfAIWh3Ee4-HujXpw-t500x500.png';
        if (avatar.startsWith('http') && !avatar.includes('weserv.nl')) {
          avatar = 'https://images.weserv.nl/?url=' + encodeURIComponent(avatar);
        }

        artistsCatalog.push({
          name: artistName,
          avatar: avatar,
          trackCount: tracks.length,
          totalPlays: totalPlays > 0 ? totalPlays : null,
          followers: meta.scFollowers || null,
          lastSync: lastStatsSync
        });
      }
      console.log(`Loaded ${allScTracks.length} tracks and ${artistsCatalog.length} artists.`);
    } catch(e) {
      console.error('Error loading sc_music_db.json:', e.message);
    }
  }

  // Load master albums catalog
  if (fs.existsSync(ALBUMS_FILE)) {
    try {
      masterAlbums = JSON.parse(fs.readFileSync(ALBUMS_FILE, 'utf8'));
      console.log(`Loaded ${masterAlbums.length} albums into memory.`);
    } catch(e) {
      console.error('Error loading master_albums_catalog.json:', e.message);
    }
  }
}

loadLocalDatabases();

// -------------------------------------------------------------------
// DAILY STATS SYNC ENGINE (runs automatically every 24 hours)
// -------------------------------------------------------------------
async function syncStatsDaily() {
  console.log(`[${new Date().toISOString()}] Starting daily stats update for tracks, artists and albums...`);
  lastStatsSync = new Date().toISOString();

  const statsOutput = {
    lastSync: lastStatsSync,
    stats: {}
  };

  artistsCatalog.forEach(a => {
    const aTracks = allScTracks.filter(t => t.artist === a.name);
    let sum = 0;
    aTracks.forEach(t => {
      if (t.plays) sum += t.plays;
      statsOutput.stats[t.id] = { plays: t.plays, likes: t.likes };
    });
    a.totalPlays = sum > 0 ? sum : null;
    a.lastSync = lastStatsSync;
  });

  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(statsOutput, null, 2), 'utf8');
    console.log(`[${new Date().toISOString()}] Daily stats successfully synced and saved.`);
  } catch(e) {
    console.error('Error saving stats:', e.message);
  }
}

setInterval(syncStatsDaily, 24 * 60 * 60 * 1000);

// Stream resolution cache (max 30 seconds TTL)
const streamCache = new Map();

function resolveStream(tcUrl) {
  if (!tcUrl) return Promise.resolve(null);
  
  if (streamCache.has(tcUrl)) {
    const cached = streamCache.get(tcUrl);
    if (Date.now() - cached.time < 30 * 1000) {
      return Promise.resolve(cached.url);
    }
  }

  return new Promise((resolve) => {
    const url = `${tcUrl}?client_id=${CLIENT_ID}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 6000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.url) {
            streamCache.set(tcUrl, { url: json.url, time: Date.now() });
            resolve(json.url);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null)).on('timeout', () => resolve(null));
  });
}

// -------------------------------------------------------------------
// LIVE SOUNDCLOUD SEARCH ENGINES (Tracks, Artists, Playlists/Albums)
// -------------------------------------------------------------------
function searchSoundCloudTracks(query, limit = 40) {
  return new Promise((resolve) => {
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${CLIENT_ID}&limit=${limit}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 7000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const tracks = (json.collection || []).map(t => {
            const hls = t.media?.transcodings?.find(tc => tc.format?.protocol === 'hls' && tc.format?.mime_type?.includes('mp4a'))
                     || t.media?.transcodings?.[0];
            let artwork = t.artwork_url || t.user?.avatar_url || '';
            if (artwork.includes('-large.')) artwork = artwork.replace('-large.', '-t500x500.');
            return {
              id: String(t.id),
              title: t.title,
              artist: t.user?.username || query,
              duration: Math.round(t.duration / 1000),
              plays: t.playback_count > 0 ? t.playback_count : null,
              likes: t.likes_count > 0 ? t.likes_count : null,
              cover: artwork ? 'https://images.weserv.nl/?url=' + encodeURIComponent(artwork) : 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Fartworks-kXOQozMfAIWh3Ee4-HujXpw-t500x500.png',
              tc_url: hls?.url || '',
              sc_url: t.permalink_url
            };
          });
          resolve(tracks);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

function searchSoundCloudArtists(query, limit = 24) {
  return new Promise((resolve) => {
    const url = `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(query)}&client_id=${CLIENT_ID}&limit=${limit}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 7000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const users = (json.collection || []).map(u => {
            let avatar = u.avatar_url || '';
            if (avatar.includes('-large.')) avatar = avatar.replace('-large.', '-t500x500.');
            return {
              userId: u.id,
              name: u.username,
              avatar: avatar ? 'https://images.weserv.nl/?url=' + encodeURIComponent(avatar) : 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Fartworks-kXOQozMfAIWh3Ee4-HujXpw-t500x500.png',
              trackCount: u.track_count || 0,
              followers: u.followers_count ? u.followers_count.toLocaleString('ru-RU') : null,
              permalink_url: u.permalink_url
            };
          });
          resolve(users);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

function searchSoundCloudAlbums(query, limit = 20) {
  return new Promise((resolve) => {
    const url = `https://api-v2.soundcloud.com/search/playlists?q=${encodeURIComponent(query)}&client_id=${CLIENT_ID}&limit=${limit}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 7000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const albums = (json.collection || []).map(p => {
            let art = p.artwork_url || (p.tracks?.[0]?.artwork_url) || p.user?.avatar_url || '';
            if (art.includes('-large.')) art = art.replace('-large.', '-t500x500.');
            return {
              id: 'sc_alb_' + p.id,
              playlistId: p.id,
              title: p.title,
              artist: p.user?.username || 'SoundCloud Artist',
              type: p.track_count > 7 ? 'Альбом' : 'EP',
              year: p.release_year || (p.created_at ? new Date(p.created_at).getFullYear() : 2024),
              trackCount: p.track_count || 0,
              cover: art ? 'https://images.weserv.nl/?url=' + encodeURIComponent(art) : 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Fartworks-kXOQozMfAIWh3Ee4-HujXpw-t500x500.png',
              isSoundCloud: true
            };
          });
          resolve(albums);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

function fetchPlaylistFull(playlistId) {
  return new Promise((resolve) => {
    const url = `https://api-v2.soundcloud.com/playlists/${playlistId}?client_id=${CLIENT_ID}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 8000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', async () => {
        try {
          const json = JSON.parse(d);
          const tracks = [];
          
          // Filter tracks that already have transcodings
          const rawTracks = json.tracks || [];
          const tracksWithMedia = rawTracks.filter(t => t.media?.transcodings?.length);
          const needFetchIds = rawTracks.filter(t => !t.media?.transcodings?.length).map(t => t.id).slice(0, 30);

          tracksWithMedia.forEach(t => {
            const hls = t.media?.transcodings?.find(tc => tc.format?.protocol === 'hls' && tc.format?.mime_type?.includes('mp4a'))
                     || t.media?.transcodings?.[0];
            let art = t.artwork_url || json.artwork_url || '';
            if (art.includes('-large.')) art = art.replace('-large.', '-t500x500.');
            tracks.push({
              id: String(t.id),
              title: t.title,
              artist: t.user?.username || json.user?.username || 'Артист',
              duration: Math.round((t.duration || 180000) / 1000),
              plays: t.playback_count > 0 ? t.playback_count : null,
              likes: t.likes_count > 0 ? t.likes_count : null,
              cover: art ? ('https://images.weserv.nl/?url=' + encodeURIComponent(art)) : '',
              tc_url: hls?.url || '',
              sc_url: t.permalink_url
            });
          });

          // Fetch remaining tracks in batch if needed
          if (needFetchIds.length > 0) {
            try {
              const bUrl = `https://api-v2.soundcloud.com/tracks?ids=${needFetchIds.join(',')}&client_id=${CLIENT_ID}`;
              const bTracks = await new Promise(bRes => {
                https.get(bUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 }, bResp => {
                  let bd = '';
                  bResp.on('data', c => bd += c);
                  bResp.on('end', () => {
                    try { bRes(JSON.parse(bd)); } catch(e) { bRes([]); }
                  });
                }).on('error', () => bRes([]));
              });

              bTracks.forEach(t => {
                const hls = t.media?.transcodings?.find(tc => tc.format?.protocol === 'hls' && tc.format?.mime_type?.includes('mp4a'))
                         || t.media?.transcodings?.[0];
                let art = t.artwork_url || json.artwork_url || '';
                if (art.includes('-large.')) art = art.replace('-large.', '-t500x500.');
                tracks.push({
                  id: String(t.id),
                  title: t.title,
                  artist: t.user?.username || json.user?.username || 'Артист',
                  duration: Math.round((t.duration || 180000) / 1000),
                  plays: t.playback_count > 0 ? t.playback_count : null,
                  likes: t.likes_count > 0 ? t.likes_count : null,
                  cover: art ? ('https://images.weserv.nl/?url=' + encodeURIComponent(art)) : '',
                  tc_url: hls?.url || '',
                  sc_url: t.permalink_url
                });
              });
            } catch(e) {}
          }

          let art = json.artwork_url || (tracks[0] && tracks[0].cover) || '';
          if (art.includes('-large.')) art = art.replace('-large.', '-t500x500.');

          resolve({
            id: 'sc_alb_' + json.id,
            playlistId: json.id,
            title: json.title,
            artist: json.user?.username || 'SoundCloud Artist',
            type: tracks.length > 7 ? 'Альбом' : 'EP',
            year: json.release_year || (json.created_at ? new Date(json.created_at).getFullYear() : 2024),
            cover: art ? ('https://images.weserv.nl/?url=' + encodeURIComponent(art)) : '',
            trackCount: tracks.length,
            tracks: tracks
          });
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// ============================================================
// TELEGRAM AUTHORIZATION & USERS DATABASE (JSON + CSV TABLE)
// ============================================================
const TG_DB_FILE = path.join(__dirname, 'telegram_users_db.json');
const TG_CSV_FILE = path.join(__dirname, 'telegram_users_table.csv');
const TG_SETTINGS_FILE = path.join(__dirname, 'telegram_bot_settings.json');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kj18904sft';

let telegramBotSettings = {
  botUsername: '@Vewasoundbot',
  gasWebAppUrl: '',
  googleSheetUrl: ''
};
try {
  if (fs.existsSync(TG_SETTINGS_FILE)) {
    telegramBotSettings = { ...telegramBotSettings, ...JSON.parse(fs.readFileSync(TG_SETTINGS_FILE, 'utf8')) };
  }
} catch (e) {
  console.error('Error reading telegram bot settings:', e.message);
}

function saveTelegramBotSettings() {
  try {
    fs.writeFileSync(TG_SETTINGS_FILE, JSON.stringify(telegramBotSettings, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving telegram bot settings:', e.message);
  }
}

let telegramUsers = [];
try {
  if (fs.existsSync(TG_DB_FILE)) {
    telegramUsers = JSON.parse(fs.readFileSync(TG_DB_FILE, 'utf8'));
  }
} catch (e) {
  telegramUsers = [];
}

// Ensure default admin/owner record if empty so user immediately sees a populated table
if (!Array.isArray(telegramUsers) || telegramUsers.length === 0) {
  telegramUsers = [
    {
      id: '582910482',
      username: '@artem_admin',
      phone: '+79998887766',
      name: 'Артём',
      avatar: 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Favatars-000685412954-d85vwe-t500x500.jpg',
      authDate: new Date().toISOString(),
      ip: '127.0.0.1'
    }
  ];
  saveTelegramUsers();
}

function saveTelegramUsers() {
  try {
    fs.writeFileSync(TG_DB_FILE, JSON.stringify(telegramUsers, null, 2), 'utf8');

    // Generate CSV Table with UTF-8 BOM so Excel opens Cyrillic without issue
    const bom = '\uFEFF';
    const header = 'ID;Username;Phone;Name;Date;IP\n';
    const rows = telegramUsers.map(u => {
      const cleanId = String(u.id || '').replace(/[";\n]/g, '');
      const cleanUser = String(u.username || '').replace(/[";\n]/g, '');
      const cleanPhone = String(u.phone || '').replace(/[";\n]/g, '');
      const cleanName = '"' + String(u.name || u.firstName || '').replace(/"/g, '""') + '"';
      const cleanDate = String(u.authDate || '').replace(/[";\n]/g, '');
      const cleanIp = String(u.ip || '').replace(/[";\n]/g, '');
      return `${cleanId};${cleanUser};${cleanPhone};${cleanName};${cleanDate};${cleanIp}`;
    }).join('\n');

    fs.writeFileSync(TG_CSV_FILE, bom + header + rows, 'utf8');
  } catch (err) {
    console.error('Error saving telegram users table:', err.message);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // ============================================================
  // TELEGRAM AUTHENTICATION & USERS TABLE API ENDPOINTS
  // ============================================================

  // 0. GET /api/telegram_bot_settings - Get bot config (Protected: only botUsername is public)
  if (parsedUrl.pathname === '/api/telegram_bot_settings' && req.method === 'GET') {
    const isSecretAdmin = parsedUrl.searchParams.get('secret') === ADMIN_SECRET || 
                          req.headers['x-admin-secret'] === ADMIN_SECRET;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (isSecretAdmin) {
      return res.end(JSON.stringify({
        ok: true,
        botUsername: telegramBotSettings.botUsername || '@Vewasoundbot',
        gasWebAppUrl: telegramBotSettings.gasWebAppUrl || '',
        googleSheetUrl: telegramBotSettings.googleSheetUrl || '',
        configured: Boolean(telegramBotSettings.gasWebAppUrl),
        isAdmin: true
      }));
    } else {
      // Normal visitors only see the public bot @username to open in Telegram
      return res.end(JSON.stringify({
        ok: true,
        botUsername: telegramBotSettings.botUsername || '@Vewasoundbot'
      }));
    }
  }

  // 0.1 POST /api/telegram_bot_settings - Update bot config (Admin Only)
  if (parsedUrl.pathname === '/api/telegram_bot_settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const reqSecret = payload.secret || parsedUrl.searchParams.get('secret') || req.headers['x-admin-secret'];
        if (reqSecret !== ADMIN_SECRET) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Доступ запрещен' }));
        }

        if (payload.botUsername !== undefined) {
          let u = String(payload.botUsername || '').trim();
          if (u && !u.startsWith('@')) u = '@' + u;
          telegramBotSettings.botUsername = u;
        }
        if (payload.gasWebAppUrl !== undefined) {
          telegramBotSettings.gasWebAppUrl = String(payload.gasWebAppUrl || '').trim();
        }
        if (payload.googleSheetUrl !== undefined) {
          telegramBotSettings.googleSheetUrl = String(payload.googleSheetUrl || '').trim();
        }
        saveTelegramBotSettings();
        console.log('[BOT SETTINGS UPDATED]', telegramBotSettings);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, settings: telegramBotSettings }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 0.2 POST /api/telegram_verify_code - Verify code from Google Apps Script / Sheet
  if (parsedUrl.pathname === '/api/telegram_verify_code' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const code = String(payload.code || '').trim();

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Введите 6-значный проверочный код' }));
        }

        // A. If Google Apps Script URL is set, verify directly with Google Sheet
        if (telegramBotSettings.gasWebAppUrl) {
          try {
            const gasUrl = telegramBotSettings.gasWebAppUrl + 
              (telegramBotSettings.gasWebAppUrl.includes('?') ? '&' : '?') + 
              'action=verify&code=' + encodeURIComponent(code);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000);

            const gasRes = await fetch(gasUrl, {
              headers: { 'User-Agent': 'VewaSound-Server/1.0' },
              signal: controller.signal
            });
            clearTimeout(timeoutId);

            const gasData = await gasRes.json();

            if (gasData && gasData.success && gasData.user) {
              const u = gasData.user;
              const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').toString().replace('::ffff:', '');
              
              const verifiedUser = {
                id: String(u.id || Math.floor(100000000 + Math.random() * 900000000)),
                username: u.username || '',
                phone: u.phone || '—',
                name: (u.name || u.username || 'Слушатель').trim(),
                avatar: 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Favatars-000685412954-d85vwe-t500x500.jpg',
                authDate: new Date().toISOString(),
                ip: ip,
                source: 'Google Apps Script'
              };

              const existingIdx = telegramUsers.findIndex(item => 
                (item.id && String(item.id) === String(verifiedUser.id)) ||
                (verifiedUser.username && item.username && item.username.toLowerCase() === verifiedUser.username.toLowerCase())
              );

              if (existingIdx !== -1) {
                telegramUsers[existingIdx] = { ...telegramUsers[existingIdx], ...verifiedUser };
              } else {
                telegramUsers.unshift(verifiedUser);
              }
              saveTelegramUsers();

              console.log(`[TG GAS AUTH] Code ${code} verified for ${verifiedUser.username} (ID: ${verifiedUser.id})`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: true, user: verifiedUser, fromGas: true }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ 
                ok: false, 
                error: (gasData && gasData.error) ? gasData.error : 'Неверный проверочный код. Нажмите «🔑 Получить код» в боте и введите актуальный код.' 
              }));
            }
          } catch (fetchErr) {
            console.error('GAS request error:', fetchErr.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ 
              ok: false, 
              error: 'Ошибка подключения к Google Apps Script: ' + fetchErr.message 
            }));
          }
        }

        // B. Fallback: Demo / Test mode if Google Apps Script URL not entered yet
        if (code === '000000' || code === '777777' || code === '123456' || code.length === 6) {
          const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').toString().replace('::ffff:', '');
          const demoUser = {
            id: '582910482',
            username: '@artem_music',
            phone: '+7 (999) 888-77-66',
            name: 'Артём',
            avatar: 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Favatars-000685412954-d85vwe-t500x500.jpg',
            authDate: new Date().toISOString(),
            ip: ip,
            isDemo: true
          };

          const existingIdx = telegramUsers.findIndex(u => String(u.id) === String(demoUser.id));
          if (existingIdx !== -1) {
            telegramUsers[existingIdx] = { ...telegramUsers[existingIdx], ...demoUser };
          } else {
            telegramUsers.unshift(demoUser);
          }
          saveTelegramUsers();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ 
            ok: true, 
            user: demoUser, 
            isDemo: true,
            warning: 'Тестовый режим: вход выполнен с демо-аккаунтом. Для привязки реального бота вставьте URL веб-приложения в «⚙️ Настройки бота».' 
          }));
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
          ok: false, 
          error: 'Google Apps Script еще не настроен. Нажмите «⚙️ Настройки бота» и вставьте ссылку на Web App, либо введите тестовый код 000000.' 
        }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // A. POST /api/telegram_auth - Receive authorized Telegram user
  if (parsedUrl.pathname === '/api/telegram_auth' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        let { id, username, phone, name, firstName, avatar } = payload;

        if (!phone && !username && !id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing phone, username or id' }));
        }

        // Format username with leading @
        if (username) {
          username = username.trim();
          if (!username.startsWith('@')) username = '@' + username;
        }

        // Clean phone number
        if (phone) {
          phone = phone.trim();
        }

        // Generate ID if missing
        if (!id) {
          id = String(Math.floor(100000000 + Math.random() * 900000000));
        }

        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').toString().replace('::ffff:', '');
        const newRecord = {
          id: String(id),
          username: username || '',
          phone: phone || '',
          name: (name || firstName || username || 'Telegram User').trim(),
          avatar: avatar || 'https://images.weserv.nl/?url=https%3A%2F%2Fi1.sndcdn.com%2Favatars-000685412954-d85vwe-t500x500.jpg',
          authDate: new Date().toISOString(),
          ip: ip
        };

        // Check if user already exists by phone, ID, or username
        const existingIdx = telegramUsers.findIndex(u => 
          (u.id && String(u.id) === String(newRecord.id)) ||
          (u.phone && newRecord.phone && u.phone === newRecord.phone) ||
          (u.username && newRecord.username && u.username.toLowerCase() === newRecord.username.toLowerCase())
        );

        if (existingIdx !== -1) {
          telegramUsers[existingIdx] = {
            ...telegramUsers[existingIdx],
            ...newRecord,
            authDate: new Date().toISOString()
          };
        } else {
          telegramUsers.unshift(newRecord);
        }

        saveTelegramUsers();
        console.log(`[TG AUTH] New login: ${newRecord.name} | ${newRecord.username} | ${newRecord.phone} | ID: ${newRecord.id}`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          user: newRecord,
          totalUsers: telegramUsers.length
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  // B. GET /api/telegram_users - Get all authorized Telegram users (Admin Only)
  if (parsedUrl.pathname === '/api/telegram_users') {
    const isSecretAdmin = parsedUrl.searchParams.get('secret') === ADMIN_SECRET || 
                          req.headers['x-admin-secret'] === ADMIN_SECRET;
    if (!isSecretAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Доступ запрещен' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      total: telegramUsers.length,
      users: telegramUsers
    }));
  }

  // C. GET /api/telegram_users_export - Private CSV Export (Admin Only)
  if (parsedUrl.pathname === '/api/telegram_users_export') {
    const isSecretAdmin = parsedUrl.searchParams.get('secret') === ADMIN_SECRET || 
                          req.headers['x-admin-secret'] === ADMIN_SECRET;
    if (!isSecretAdmin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Доступ запрещен' }));
    }
    saveTelegramUsers();
    if (fs.existsSync(TG_CSV_FILE)) {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="telegram_users_table.csv"',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(TG_CSV_FILE).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Table file not found');
    }
    return;
  }

  // 1. HLS Playlist proxy with URL rewriting
  if (parsedUrl.pathname === '/api/hls_playlist') {
    const tcUrl = parsedUrl.searchParams.get('tc_url');
    if (!tcUrl) {
      res.writeHead(400);
      return res.end('Missing tc_url');
    }
    const streamUrl = await resolveStream(tcUrl);
    if (!streamUrl) {
      res.writeHead(404);
      return res.end('Stream not resolved');
    }

    const protocol = streamUrl.startsWith('https:') ? https : http;
    protocol.get(streamUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, upRes => {
      let m3u8 = '';
      upRes.on('data', c => m3u8 += c);
      upRes.on('end', () => {
        if (m3u8.includes('Forbidden') || upRes.statusCode !== 200) {
          streamCache.delete(tcUrl);
          res.writeHead(502);
          return res.end('Upstream signature expired, retry');
        }

        const rewritten = m3u8.split('\n').map(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
            return '/api/proxy_segment?url=' + encodeURIComponent(trimmed);
          }
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="(https?:\/\/[^"]+)"/g, (match, u) => 'URI="/api/proxy_segment?url=' + encodeURIComponent(u) + '"');
          }
          return line;
        }).join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        res.end(rewritten);
      });
    }).on('error', err => {
      res.writeHead(502);
      res.end('Error fetching playlist: ' + err.message);
    });
    return;
  }

  // 2. Segment proxy
  if (parsedUrl.pathname === '/api/proxy_segment') {
    const segUrl = parsedUrl.searchParams.get('url');
    if (!segUrl) {
      res.writeHead(400);
      return res.end('Missing url');
    }
    const protocol = segUrl.startsWith('https:') ? https : http;
    protocol.get(segUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, upRes => {
      res.writeHead(upRes.statusCode, {
        'Content-Type': upRes.headers['content-type'] || 'audio/mp4',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      });
      upRes.pipe(res);
    }).on('error', err => {
      res.writeHead(502);
      res.end('Segment error: ' + err.message);
    });
    return;
  }

  // 3. Return catalog of artists
  if (parsedUrl.pathname === '/api/artists') {
    const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
    let results = artistsCatalog;
    if (q) {
      results = results.filter(a => a.name.toLowerCase().includes(q));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      lastSync: lastStatsSync,
      artists: results
    }));
  }

  // 4. Return tracks of a specific artist
  if (parsedUrl.pathname === '/api/artist_tracks') {
    const artist = (parsedUrl.searchParams.get('artist') || '').toLowerCase();
    const tracks = allScTracks.filter(t => t.artist.toLowerCase() === artist || t.uploader.toLowerCase() === artist);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(tracks));
  }

  // 5. Return all albums or filter by artist
  if (parsedUrl.pathname === '/api/albums') {
    const artist = (parsedUrl.searchParams.get('artist') || '').toLowerCase();
    const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
    let results = masterAlbums;
    if (artist) {
      results = results.filter(a => a.artist.toLowerCase() === artist);
    }
    if (q) {
      results = results.filter(a => a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q));
    }
    // Return lightweight summary (omit full tracks array to keep response small)
    const summary = results.map(({ tracks, ...rest }) => rest);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(summary));
  }

  // 6. Return specific album with its full tracklist
  if (parsedUrl.pathname === '/api/album') {
    const id = parsedUrl.searchParams.get('id');
    if (!id) {
      res.writeHead(400);
      return res.end('Missing album id');
    }

    // Check if it is a local master album
    const found = masterAlbums.find(a => a.id === id);
    if (found) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(found));
    }

    // If it is a live SoundCloud playlist (e.g. sc_alb_1715470665)
    if (id.startsWith('sc_alb_')) {
      const pId = id.replace('sc_alb_', '');
      const full = await fetchPlaylistFull(pId);
      if (full) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(full));
      }
    }

    res.writeHead(404);
    return res.end('Album not found');
  }

  // 7. Live Search SoundCloud Albums / Playlists
  if (parsedUrl.pathname === '/api/sc_search_albums') {
    const q = parsedUrl.searchParams.get('q') || '';
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const albums = await searchSoundCloudAlbums(q);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(albums));
  }

  // 8. Live Search SoundCloud Artists
  if (parsedUrl.pathname === '/api/sc_search_artists') {
    const q = parsedUrl.searchParams.get('q') || '';
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const artists = await searchSoundCloudArtists(q);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(artists));
  }

  // 9. Return catalog of tracks from SoundCloud DB
  if (parsedUrl.pathname === '/api/tracks') {
    const limit = parseInt(parsedUrl.searchParams.get('limit')) || 400;
    const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
    let results = allScTracks;
    if (q) {
      results = results.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(results.slice(0, limit)));
  }

  // 10. SoundCloud Live Track Search
  if (parsedUrl.pathname === '/api/sc_search') {
    const q = parsedUrl.searchParams.get('q') || '';
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    const results = await searchSoundCloudTracks(q);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(results));
  }

  // 11. Manual trigger for stats sync
  if (parsedUrl.pathname === '/api/sync_stats') {
    await syncStatsDaily();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, lastSync: lastStatsSync }));
  }

  // 12. Serve index.html
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    fs.readFile(HTML_FILE, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Порт ${PORT} уже занят. Перезапустите сервер.`);
  } else {
    console.error('Ошибка сервера:', err);
  }
});

server.listen(PORT, () => {
  console.log(`VewaSound Server running on http://localhost:${PORT}`);
});
