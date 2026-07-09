import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import { Client, GatewayIntentBits, Collection, REST, Routes } from 'discord.js';
import playdl from 'play-dl';
import { Player } from './player.js';

async function setupAuth() {
  const dataDir = '.data';
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (process.env.SOUNDCLOUD_CLIENT_ID) {
    await playdl.setToken({ soundcloud: { client_id: process.env.SOUNDCLOUD_CLIENT_ID } });
    console.log('SoundCloud configured via env');
  } else {
    try {
      const id = await playdl.getFreeClientID();
      await playdl.setToken({ soundcloud: { client_id: id } });
      console.log('SoundCloud client ID auto-fetched');
    } catch {
      console.log('SoundCloud not configured. Set SOUNDCLOUD_CLIENT_ID in .env');
    }
  }

  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      const data = await res.json();
      if (data.access_token) {
        const expiry = Date.now() + (data.expires_in - 60) * 1000;
        await playdl.setToken({
          spotify: {
            client_id: process.env.SPOTIFY_CLIENT_ID,
            client_secret: process.env.SPOTIFY_CLIENT_SECRET,
            access_token: data.access_token,
            token_type: data.token_type,
            expiry,
            market: 'US',
          }
        });
        console.log('Spotify configured (token expires ' + new Date(expiry).toLocaleTimeString() + ')');
        setTimeout(() => { console.log('Spotify token expired. Restart to refresh.'); }, (data.expires_in - 60) * 1000);
      }
    } catch (e) {
      console.warn('Spotify setup failed:', e.message);
    }
  } else {
    console.log('Spotify not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
client.player = new Player();

async function loadCommands() {
  const { default: cmdPlay } = await import('./commands/play.js');
  const { default: cmdSearch } = await import('./commands/search.js');
  const { default: cmdSkip } = await import('./commands/skip.js');
  const { default: cmdStop } = await import('./commands/stop.js');
  const { default: cmdPause } = await import('./commands/pause.js');
  const { default: cmdVolume } = await import('./commands/volume.js');
  const { default: cmdShuffle } = await import('./commands/shuffle.js');
  const { default: cmdQueue } = await import('./commands/queue.js');
  const { default: cmdSkipTo } = await import('./commands/skipto.js');
  const { default: cmdRepeating } = await import('./commands/repeating.js');
  const { default: cmdAutoplay } = await import('./commands/autoplay.js');
  const { default: cmdLyrics } = await import('./commands/lyrics.js');
  const { default: cmdFilters } = await import('./commands/filters.js');
  const { default: cmdSeek } = await import('./commands/seek.js');
  const { default: cmdLeave } = await import('./commands/leave.js');
  const { default: cmdLike } = await import('./commands/like.js');
  const { default: cmdPlaylists } = await import('./commands/playlists.js');
  const { default: cmdHelp } = await import('./commands/help.js');
  const { default: cmdPing } = await import('./commands/ping.js');
  const { default: cmdNowplaying } = await import('./commands/nowplaying.js');
  const { default: cmd247 } = await import('./commands/247.js');
  const { default: cmdPrevious } = await import('./commands/previous.js');
  const { default: cmdPlayfile } = await import('./commands/playfile.js');
  const { default: cmdLiveLyrics } = await import('./commands/live-lyrics.js');
  const cmds = [
    cmdPlay, cmdSearch, cmdSkip, cmdStop, cmdPause, cmdVolume,
    cmdShuffle, cmdQueue, cmdSkipTo, cmdRepeating, cmdAutoplay,
    cmdLyrics, cmdFilters, cmdSeek, cmdLeave, cmdLike, cmdPlaylists,
    cmdHelp, cmdPing, cmdNowplaying, cmd247, cmdPrevious, cmdPlayfile,
    cmdLiveLyrics,
  ];
  for (const c of cmds) {
    client.commands.set(c.data.name, c);
  }
}

client.on('error', err => console.error('Client error:', err.message));
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('/play | Music Bot', { type: 3 });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`Error executing ${interaction.commandName}:`, err);
    const reply = { content: 'An error occurred while executing that command.', flags: 64 };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

await loadCommands();

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
try {
  console.log('Registering slash commands...');
  const cmdData = client.commands.map(c => c.data.toJSON());
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmdData });
  console.log(`Registered ${cmdData.length} commands.`);
} catch (err) {
  console.error('Failed to register commands:', err);
}

await setupAuth();
const loginPromise = client.login(process.env.DISCORD_TOKEN);
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out after 15s')), 15000));
try {
  await Promise.race([loginPromise, timeout]);
} catch (err) {
  console.error('Login failed:', err.message);
  console.error('This usually means the firewall/antivirus is blocking WebSocket (wss://gateway.discord.gg).');
  console.error('Try: running as Administrator, or disabling Windows Defender firewall temporarily.');
  process.exit(1);
}

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bot alive');
}).listen(PORT, () => console.log(`Keep-alive server on :${PORT}`));
