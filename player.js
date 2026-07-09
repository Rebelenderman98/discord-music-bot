import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import playdl from 'play-dl';
import { Collection, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import ffmpegStatic from 'ffmpeg-static';

export const CYAN = 0x00FFFF;
export const MAGENTA = 0xFF00FF;
export const NEON_GREEN = 0x00FF41;
export const NEON_RED = 0xFF0044;

const FFMPEG_FILTERS = {
  bassboost: 'bass=g=15',
  nightcore: 'aresample=48000,asetrate=48000*1.25',
  vaporwave: 'aresample=48000,asetrate=48000*0.8',
  '8d': 'apulsator=hz=0.08',
  karaoke: 'pan=stereo|c0=c0|c1=c1,asplit[pan],pan=mono|c0=c0-c1,pan=mono|c0=c0,amix=inputs=2:duration=first,volume=0.5',
  pitch: 'asetrate=48000*1.15,aresample=48000',
  earrape: 'volume=15',
  lofi: 'aresample=22050,aecho=0.8:0.88:60:0.4',
  treble: 'equalizer=f=3000:t=q:w=1:g=12',
};

const ytDlpPath = process.platform === 'win32' ? '.\\yt-dlp.exe' : 'yt-dlp';
const ffmpegDir = ffmpegStatic.substring(0, ffmpegStatic.lastIndexOf('\\'));
process.env.PATH = `${ffmpegDir};${process.env.PATH}`;
process.env.FFMPEG_PATH = ffmpegStatic;

export function bufferStream(input, maxMs = 1000) {
  const buf = new PassThrough({ highWaterMark: 1024 * 256 });
  input.pipe(buf);
  return Promise.race([
    new Promise(r => buf.once('data', () => setTimeout(r, 300))),
    new Promise(r => setTimeout(r, maxMs)),
  ]).then(() => buf);
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseLRC(lrc) {
  const entries = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
    if (m) {
      const time = parseInt(m[1]) * 60000 + parseInt(m[2]) * 1000 + parseInt(m[3].padEnd(3, '0'));
      const text = m[4].trim();
      if (text) entries.push({ time, text });
    }
  }
  return entries.sort((a, b) => a.time - b.time);
}

export function progressBar(current, total, length = 14) {
  if (total <= 0) return '`' + '·'.repeat(length) + '`';
  const fraction = Math.min(1, Math.max(0, current / total));
  const f = Math.min(length - 1, Math.round(fraction * length));
  let bar = '';
  for (let i = 0; i < length; i++) {
    if (i < f) bar += '▓';
    else if (i === f) bar += '●';
    else bar += '░';
  }
  return '`' + bar + '`' + ` \`${formatDuration(current)}\` ${formatDuration(total)}`;
}

const PCM_BYTES_PER_MS = 192;

function killProcesses(procs) {
  for (const p of procs) {
    try { p.kill('SIGKILL'); } catch {}
  }
}

function getStream(songUrl) {
  if (!songUrl.includes('youtube.com') && !songUrl.includes('youtu.be')) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const yt = spawn(ytDlpPath, ['-f', 'bestaudio', '-o', '-', '--no-warnings', '--no-playlist', songUrl]);
    let errBuf = '';
    yt.stderr.on('data', d => errBuf += d.toString());
    yt.on('error', (e) => reject(new Error(`yt-dlp: ${e.message}`)));
    yt.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp failed (${code}): ${errBuf.slice(0, 200)}`));
      }
    });
    resolve({ stream: yt.stdout, type: 'arbitrary', _procs: [yt] });
  });
}

export class Player {
  constructor() {
    this.queues = new Collection();
  }

  getQueue(guildId) {
    let q = this.queues.get(guildId);
    if (!q) {
      q = {
        guildId,
        songs: [],
        currentIndex: -1,
        connection: null,
        audioPlayer: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
        volume: 50,
        loopMode: 'none',
        autoplay: false,
        isPaused: false,
        manualStop: false,
        filters: [],
        likedSongs: [],
        textChannel: null,
        voiceChannel: null,
        playingMessage: null,
        history: [],
        destroyTimeout: null,
        stayInVC: false,
        position: 0,
        streamStartTime: 0,
        resource: null,
        streamProcs: [],
        progressInterval: null,
        liveLyricsMessage: null,
        liveLyricsInterval: null,
        _lastLyricsIdx: -1,
        lyricsOffset: 0,
        pipelineDelay: 3000,
      };
      const stopProgress = () => {
        if (q.progressInterval) {
          clearInterval(q.progressInterval);
          q.progressInterval = null;
        }
      };
      q.audioPlayer.on(AudioPlayerStatus.Idle, () => {
        stopProgress();
        if (!q.manualStop && q.resource) {
          q.position = q.songs[q.currentIndex]?.durationMs || 0;
        }
        if (!q.manualStop) {
          this.onTrackEnd(guildId).catch(err => console.error(`Auto-skip error in ${guildId}:`, err));
        }
      });
      q.audioPlayer.on(AudioPlayerStatus.Playing, () => {});
      q.audioPlayer.on(AudioPlayerStatus.Paused, stopProgress);
      q.audioPlayer.on(AudioPlayerStatus.Resumed, () => {
        if (q.streamStartTime && q.position) {
          q.streamStartTime = Date.now() - q.position;
        }
        this.startProgressUpdates(guildId);
      });
      q.audioPlayer.on('error', (err) => {
        console.error(`Player error: ${err.message}`);
        q.textChannel?.send({ embeds: [{ color: NEON_RED, description: `Playback error: \`${err.message}\`` }] }).catch(() => {});
        this.next(guildId);
      });
      this.queues.set(guildId, q);
    }
    return q;
  }

  async connect(guildId, voiceChannel, textChannel) {
    const q = this.getQueue(guildId);
    if (q.destroyTimeout) {
      clearTimeout(q.destroyTimeout);
      q.destroyTimeout = null;
    }
    if (q.connection && q.connection.joinConfig.channelId === voiceChannel.id) return q;
    if (q.connection) q.connection.destroy();
    q.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    q.connection.subscribe(q.audioPlayer);
    q.voiceChannel = voiceChannel;
    q.textChannel = textChannel;
    return q;
  }

  async play(guildId, query, requester, platform = 'ytsearch') {
    const q = this.getQueue(guildId);
    let songs = [];
    try {
      if (query.match(/^https?:\/\//)) {
        const info = await playdl.video_info(query).catch(() => null);
        if (info) {
          songs.push(this.formatSong(info.video_details, requester));
        } else {
          const pl = await playdl.playlist_info(query).catch(() => null);
          if (pl) {
            const vids = await pl.all_videos();
            songs = vids.map(v => this.formatSong(v, requester));
          } else {
            const sp = await this.resolveSpotify(query, requester);
            if (sp) songs = sp;
            else {
              const sc = await this.resolveSoundCloud(query, requester);
              if (sc) songs = sc;
              else throw new Error('Could not resolve URL');
            }
          }
        }
      } else {
        if (platform === 'spsearch') {
          const sp = await this.resolveSpotifySearch(query, requester);
          if (sp) songs = sp;
          else platform = 'ytsearch';
        } else if (platform === 'scsearch') {
          try {
            const scResults = await playdl.search(query, { limit: 1, source: { soundcloud: 'track' } });
            if (scResults.length > 0) {
              const sc = scResults[0];
              songs.push({
                title: sc.name,
                url: sc.url,
                duration: sc.durationRaw || '0:00',
                durationMs: sc.durationInMs || 0,
                thumbnail: sc.thumbnail?.url || null,
                author: sc.user?.name || 'Unknown',
                requester,
                platform: 'soundcloud',
              });
            } else platform = 'ytsearch';
          } catch { platform = 'ytsearch'; }
        } else if (platform === 'dzsearch') {
          try {
            const dz = await playdl.search(query, { limit: 1, source: { deezer: 'track' } });
            if (dz.length > 0) {
              const d = dz[0];
              songs.push({
                title: d.title || 'Unknown',
                url: d.url,
                duration: d.durationRaw || '0:00',
                durationMs: d.durationInMs || 0,
                thumbnail: d.thumbnail?.url || null,
                author: d.artist?.name || 'Unknown',
                requester,
                platform: 'deezer',
              });
            } else platform = 'ytsearch';
          } catch { platform = 'ytsearch'; }
        }
        if (songs.length === 0) {
          const results = await playdl.search(query, { limit: 1, source: { youtube: 'video' } });
          if (results.length === 0) throw new Error('No results found');
          songs.push(this.formatSong(results[0], requester));
        }
      }
    } catch (err) {
      throw new Error(`Search failed: ${err.message}`);
    }
    if (songs.length === 0) throw new Error('No songs found');
    q.songs.push(...songs);
    if (q.currentIndex === -1) {
      q.currentIndex = 0;
      await this.playCurrent(guildId);
    }
    return songs;
  }

  async searchPlay(guildId, query, requester) {
    const q = this.getQueue(guildId);
    try {
      const results = await playdl.search(query, { limit: 5, source: { youtube: 'video' } });
      if (results.length === 0) throw new Error('No results found');
      return results.map(r => this.formatSong(r, requester));
    } catch (err) {
      throw new Error(`Search failed: ${err.message}`);
    }
  }

  async playFile(guildId, attachment, requester) {
    const q = this.getQueue(guildId);
    const song = {
      title: attachment.name || 'Unknown File',
      url: attachment.url,
      duration: '0:00',
      durationMs: 0,
      thumbnail: null,
      author: attachment.name || 'file',
      requester,
      platform: 'file',
    };
    q.songs.push(song);
    if (q.currentIndex === -1) {
      q.currentIndex = 0;
      await this.playCurrent(guildId);
    }
    return song;
  }

  formatSong(video, requester) {
    return {
      title: video.title || 'Unknown',
      url: video.url || video.id ? `https://youtube.com/watch?v=${video.id}` : '#',
      duration: video.durationRaw || '0:00',
      durationMs: video.durationInSec ? video.durationInSec * 1000 : 0,
      thumbnail: video.thumbnails ? (video.thumbnails[0]?.url || null) : null,
      author: video.channel?.name || video.author || 'Unknown',
      requester,
      platform: video.url?.includes('spotify') ? 'spotify' : 'youtube',
    };
  }

  async resolveSpotify(url, requester) {
    try {
      const sp = await playdl.spotify(url);
      if (sp.type === 'track') {
        const search = await playdl.search(`${sp.name} ${sp.artists[0]}`, { limit: 1, source: { youtube: 'video' } });
        if (search.length === 0) return null;
        return [this.formatSong(search[0], requester)];
      } else if (sp.type === 'playlist') {
        const tracks = await sp.all_tracks();
        const songs = [];
        for (const t of tracks.slice(0, 50)) {
          const search = await playdl.search(`${t.name} ${t.artists[0]}`, { limit: 1, source: { youtube: 'video' } });
          if (search.length > 0) songs.push(this.formatSong(search[0], requester));
        }
        return songs;
      }
    } catch { return null; }
    return null;
  }

  async resolveSpotifySearch(query, requester) {
    try {
      const results = await playdl.search(query, { limit: 1, source: { spotify: 'track' } });
      if (results.length === 0) return null;
      const sp = await playdl.spotify(results[0].url);
      if (sp && sp.type === 'track') {
        const yt = await playdl.search(`${sp.name} ${sp.artists[0]}`, { limit: 1, source: { youtube: 'video' } });
        if (yt.length > 0) return [this.formatSong(yt[0], requester)];
      }
      return null;
    } catch { return null; }
  }

  async resolveSoundCloud(url, requester) {
    try {
      const sc = await playdl.soundcloud(url);
      if (sc.type === 'track') {
        return [{
          title: sc.name,
          url: sc.url,
          duration: formatDuration(sc.durationInMs),
          durationMs: sc.durationInMs,
          thumbnail: sc.thumbnail?.url || null,
          author: sc.user?.name || 'Unknown',
          requester,
          platform: 'soundcloud',
        }];
      } else if (sc.type === 'playlist') {
        const tracks = await sc.all_tracks();
        return tracks.slice(0, 50).map(t => ({
          title: t.name,
          url: t.url,
          duration: formatDuration(t.durationInMs),
          durationMs: t.durationInMs,
          thumbnail: t.thumbnail?.url || null,
          author: t.user?.name || 'Unknown',
          requester,
          platform: 'soundcloud',
        }));
      }
    } catch { return null; }
    return null;
  }

  async playCurrent(guildId) {
    const q = this.getQueue(guildId);
    if (q.currentIndex < 0 || q.currentIndex >= q.songs.length) {
      if (q.autoplay && q.songs.length > 0) {
        await this.autoplayNext(guildId);
        return;
      }
      this.destroyIfEmpty(guildId);
      return;
    }
    const song = q.songs[q.currentIndex];
    try {
      if (q.streamProcs && q.streamProcs.length > 0) killProcesses(q.streamProcs);
      let stream;
      if (song.platform === 'file') {
        const res = await fetch(song.url);
        if (!res.ok) throw new Error(`File fetch returned ${res.status}`);
        stream = { stream: await bufferStream(res.body), type: 'arbitrary', _procs: [] };
      } else {
        const isYT = song.platform === 'youtube' || song.url.includes('youtube.com') || song.url.includes('youtu.be');
        const raw = isYT ? await getStream(song.url) : null;
        if (!raw) {
          const s = await playdl.stream(song.url).catch(() => null);
          if (!s) throw new Error('Could not create audio stream');
          stream = { stream: await bufferStream(s.stream), type: s.type, _procs: [] };
        } else {
          stream = { stream: await bufferStream(raw.stream), type: raw.type, _procs: raw._procs };
        }
      }
      q.streamProcs = stream._procs || [];
      const activeFilters = Array.isArray(q.filters) ? q.filters : [];
      if (activeFilters.length > 0) {
        const filterStr = activeFilters.map(f => FFMPEG_FILTERS[f]).filter(Boolean).join(',');
        if (filterStr) {
          const ff = spawn(ffmpegStatic, [
            '-i', 'pipe:0',
            '-af', filterStr,
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            '-loglevel', 'warning',
            'pipe:1',
          ]);
          let stderrBuf = '';
          ff.stderr.on('data', d => stderrBuf += d.toString());
          ff.stdin.on('error', () => {});
          stream.stream.pipe(ff.stdin);
          stream.stream = ff.stdout;
          stream._procs.push(ff);
          q.streamProcs = stream._procs;
          setTimeout(() => {
            if (stderrBuf) console.warn(`Filters [${activeFilters.join(',')}]: ${stderrBuf}`);
          }, 2000);
        }
      }
      const inputType = stream.type === 'opus' ? StreamType.Opus : StreamType.Arbitrary;
      const resource = createAudioResource(stream.stream, {
        inputType,
        inlineVolume: true,
      });
      resource.volume.setVolume(q.volume / 100);
      q.resource = resource;
      q.position = 0;
      q.streamStartTime = Date.now();
      q.audioPlayer.play(resource);
      q.isPaused = false;
      q.manualStop = false;
      this.stopLiveLyrics(guildId);
      this.sendNowPlaying(guildId, song);
    } catch (err) {
      console.error(`Failed to play ${song.title}:`, err.message);
      q.textChannel?.send({ embeds: [{ color: NEON_RED, description: `⚠ **PLAYBACK ERROR** \n\`${song.title}\`\n\`${err.message}\`` }] }).catch(() => {});
      q.songs.splice(q.currentIndex, 1);
      if (q.songs.length === 0) {
        q.currentIndex = -1;
        this.destroyIfEmpty(guildId);
      }
      this.next(guildId);
    }
  }

  buildEmbed(guildId, song) {
    const q = this.getQueue(guildId);
    q.position = q.streamStartTime ? Date.now() - q.streamStartTime : 0;
    const bar = progressBar(Math.min(q.position, song.durationMs), song.durationMs);
    const filterTag = Array.isArray(q.filters) && q.filters.length > 0 ? q.filters.map(f => f.toUpperCase()).join(' + ') : '';
    return {
      color: q.isPaused ? 0x7755CC : 0x00CCFF,
      title: q.isPaused ? '⏸  PAUSED' : '▶  PLAYING',
      description: `**[${song.title}](${song.url})**  \`${song.author}\``,
      fields: [
        { name: '⏱', value: bar, inline: false },
        { name: '🔊', value: `${q.volume}%`, inline: true },
        { name: '🔁', value: q.loopMode.toUpperCase(), inline: true },
        { name: '📋', value: `${Math.max(0, q.songs.length - q.currentIndex - 1)}`, inline: true },
        { name: '🤖', value: q.autoplay ? 'ON' : 'OFF', inline: true },
        { name: '👤', value: `<@${song.requester}>`, inline: true },
      ].concat(filterTag ? [{ name: '⚡', value: filterTag, inline: true }] : []),
      thumbnail: song.thumbnail ? { url: song.thumbnail } : undefined,
      footer: { text: `◈ ${song.duration || formatDuration(song.durationMs)}  ◈  ${Math.floor(Date.now() / 1000)}` },
      timestamp: new Date().toISOString(),
    };
  }

  startProgressUpdates(guildId) {
    const q = this.queues.get(guildId);
    if (!q || !q.playingMessage || q.currentIndex < 0) return;
    if (q.progressInterval) clearInterval(q.progressInterval);
    q.progressInterval = setInterval(() => {
      const song = q.songs[q.currentIndex];
      if (!song || !q.playingMessage) {
        if (q.progressInterval) clearInterval(q.progressInterval);
        q.progressInterval = null;
        return;
      }
      q.position = q.streamStartTime ? Date.now() - q.streamStartTime : 0;
      if (q.isPaused) return;
      if (song.durationMs > 0 && q.position > song.durationMs + 3000 && !q.manualStop && q.audioPlayer.state.status === 'playing') {
        if (q.progressInterval) clearInterval(q.progressInterval);
        q.progressInterval = null;
        q.audioPlayer.stop();
        this.onTrackEnd(guildId).catch(err => console.error(`Duration-triggered skip error:`, err));
        return;
      }
      const embed = this.buildEmbed(guildId, song);
      q.playingMessage.edit({ embeds: [embed] }).catch(() => {
        q.playingMessage = null;
        if (q.progressInterval) clearInterval(q.progressInterval);
        q.progressInterval = null;
      });
    }, 1000);
  }

  buildRow(q) {
    const pauseLabel = q.isPaused ? '▶' : '⏸';
    const pauseStyle = q.isPaused ? ButtonStyle.Success : ButtonStyle.Secondary;
    const loopLabel = q.loopMode === 'none' ? '🔁' : q.loopMode === 'current' ? '🔂' : '🔁';
    const loopStyle = q.loopMode === 'none' ? ButtonStyle.Secondary : ButtonStyle.Primary;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prev').setEmoji('⏮').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pause').setEmoji(pauseLabel).setStyle(pauseStyle),
      new ButtonBuilder().setCustomId('skip').setEmoji('⏭').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setEmoji('⏹').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('loop').setEmoji(loopLabel).setStyle(loopStyle),
    );
  }

  sendNowPlaying(guildId, song) {
    const q = this.getQueue(guildId);
    if (!q.textChannel) return;
    q.streamStartTime = Date.now();
    q.position = 0;
    const embed = this.buildEmbed(guildId, song);
    const row = this.buildRow(q);
    q.textChannel.send({ embeds: [embed], components: [row] }).then((msg) => {
      q.playingMessage = msg;
      this.startProgressUpdates(guildId);
      const col = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 3600000 });
      col.on('collect', async (i) => {
        if (i.user.id !== song.requester && !i.member?.permissions?.has('ManageMessages')) {
          return i.reply({ content: 'Not your session.', flags: 64 });
        }
        await i.deferUpdate();
        switch (i.customId) {
          case 'prev':
            col.stop();
            await this.previous(guildId);
            break;
          case 'pause':
            this.pause(guildId);
            break;
          case 'skip':
            col.stop();
            this.skip(guildId);
            break;
          case 'stop':
            col.stop();
            this.stop(guildId);
            break;
          case 'loop': {
            const modes = ['none', 'current', 'queue'];
            const idx = modes.indexOf(q.loopMode);
            q.loopMode = modes[(idx + 1) % modes.length];
            break;
          }
        }
        const updated = this.queues.get(guildId);
        if (!col.ended) {
          if (updated && updated.currentIndex >= 0 && updated.songs[updated.currentIndex]) {
            const newEmbed = this.buildEmbed(guildId, updated.songs[updated.currentIndex]);
            const newRow = this.buildRow(updated);
            i.editReply({ embeds: [newEmbed], components: [newRow] }).catch(() => {});
          } else {
            i.editReply({ components: [] }).catch(() => {});
          }
        }
      });
      col.on('end', () => {
        msg.edit({ components: [] }).catch(() => {});
      });
    }).catch(() => {});
  }

  async onTrackEnd(guildId) {
    this.stopLiveLyrics(guildId);
    const q = this.getQueue(guildId);
    if (!q) return;
    if (q.currentIndex >= 0 && q.currentIndex < q.songs.length) {
      q.history.push(q.songs[q.currentIndex]);
    }
    if (q.loopMode === 'current' && q.currentIndex >= 0 && q.currentIndex < q.songs.length) {
      await this.playCurrent(guildId);
    } else if (q.loopMode === 'queue' && q.songs.length > 0) {
      if (q.currentIndex >= q.songs.length - 1) {
        q.currentIndex = 0;
      } else {
        q.currentIndex++;
      }
      await this.playCurrent(guildId);
    } else {
      await this.next(guildId);
    }
  }

  async next(guildId) {
    const q = this.getQueue(guildId);
    if (q.loopMode === 'queue' && q.songs.length > 0) {
      q.currentIndex = (q.currentIndex + 1) % q.songs.length;
    } else {
      q.currentIndex++;
    }
    if (q.currentIndex < q.songs.length) {
      await this.playCurrent(guildId);
    } else if (q.autoplay && q.songs.length > 0) {
      await this.autoplayNext(guildId);
    } else {
      q.currentIndex = -1;
      this.destroyIfEmpty(guildId);
    }
  }

  async autoplayNext(guildId) {
    const q = this.getQueue(guildId);
    if (q.songs.length === 0) return;
    const lastSong = q.songs[q.songs.length - 1];
    try {
      const results = await playdl.search(`${lastSong.title} ${lastSong.author}`, { limit: 5, source: { youtube: 'video' } });
      const existing = new Set(q.songs.map(s => s.url));
      const newSong = results.find(r => !existing.has(r.url || `https://youtube.com/watch?v=${r.id}`));
      if (newSong) {
        const song = this.formatSong(newSong, q.songs[q.songs.length - 1].requester);
        q.songs.push(song);
        if (q.currentIndex === -1) {
          q.currentIndex = 0;
        } else {
          q.currentIndex = q.songs.length - 1;
        }
        await this.playCurrent(guildId);
      } else {
        this.destroyIfEmpty(guildId);
      }
    } catch {
      this.destroyIfEmpty(guildId);
    }
  }

  async previous(guildId) {
    const q = this.getQueue(guildId);
    if (q.history.length === 0) return false;
    const prev = q.history.pop();
    q.songs.splice(q.currentIndex, 0, prev);
    q.currentIndex = Math.max(0, q.currentIndex);
    await this.playCurrent(guildId);
    return true;
  }

  skip(guildId) {
    const q = this.getQueue(guildId);
    if (!q.audioPlayer) return;
    q.position = q.songs[q.currentIndex]?.durationMs || 0;
    q.audioPlayer.stop();
  }

  skipTo(guildId, index) {
    const q = this.getQueue(guildId);
    if (index < 0 || index >= q.songs.length) return false;
    q.currentIndex = index - 1;
    q.position = q.songs[q.currentIndex]?.durationMs || 0;
    q.audioPlayer.stop();
    return true;
  }

  stop(guildId) {
    const q = this.getQueue(guildId);
    if (q.streamProcs && q.streamProcs.length > 0) killProcesses(q.streamProcs);
    q.streamProcs = [];
    q.songs = [];
    q.currentIndex = -1;
    q.history = [];
    q.manualStop = true;
    q.position = 0;
    q.audioPlayer.stop();
  }

  pause(guildId) {
    const q = this.getQueue(guildId);
    if (q.isPaused) {
      q.audioPlayer.unpause();
      q.isPaused = false;
    } else {
      q.audioPlayer.pause();
      q.isPaused = true;
    }
    return q.isPaused;
  }

  setVolume(guildId, vol) {
    const q = this.getQueue(guildId);
    q.volume = Math.max(0, Math.min(200, vol));
    if (q.resource?.volume) q.resource.volume.setVolume(q.volume / 100);
    return q.volume;
  }

  shuffle(guildId) {
    const q = this.getQueue(guildId);
    if (q.songs.length < 2) return false;
    const current = q.songs[q.currentIndex];
    const rest = q.songs.filter((_, i) => i !== q.currentIndex);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    q.songs = [current, ...rest];
    q.currentIndex = 0;
    return true;
  }

  setLoop(guildId, mode) {
    const q = this.getQueue(guildId);
    q.loopMode = mode;
    return mode;
  }

  toggleAutoplay(guildId) {
    const q = this.getQueue(guildId);
    q.autoplay = !q.autoplay;
    return q.autoplay;
  }

  async setFilters(guildId, filterArray) {
    const q = this.getQueue(guildId);
    q.filters = filterArray;
    if (q.currentIndex >= 0 && q.songs[q.currentIndex] && q.audioPlayer) {
      q.position = q.songs[q.currentIndex]?.durationMs || 0;
      q.audioPlayer.stop();
    }
  }

  async liveLyrics(guildId, channel) {
    const q = this.getQueue(guildId);
    if (!q || q.currentIndex < 0 || !q.songs[q.currentIndex]) throw new Error('Nothing is playing.');
    this.stopLiveLyrics(guildId);
    const song = q.songs[q.currentIndex];
    const query = `${song.title} ${song.author}`.replace(/\s*\([^)]*\)/g, '').replace(/\s*-\s*\d{4}.*$/, '').replace(/\s*\[[^\]]*\]/g, '').replace(/(Official\s*(Video|Audio|Lyrics|Music|Visualizer)).*/i, '').trim();

    async function fetchNetease(qry) {
      const h = { Referer: 'https://music.163.com' };
      const s = await fetch(`https://music.163.com/api/cloudsearch/pc?type=1&s=${encodeURIComponent(qry)}`, { headers: h });
      if (!s.ok) return null;
      const b = await s.json();
      if (!b?.result?.songs?.length) return null;
      for (const c of b.result.songs.slice(0, 3)) {
        const lr = await fetch(`https://music.163.com/api/song/lyric?id=${c.id}&lv=-1&kv=-1&tv=-1`, { headers: h });
        if (!lr.ok) continue;
        const lb = await lr.json();
        if (lb?.lrc?.lyric?.length > 50) return lb.lrc.lyric;
        if (lb?.tlyric?.lyric?.length > 50) return lb.tlyric.lyric;
      }
      return null;
    }

    async function fetchLRCLIB(qry) {
      const s = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(qry)}`);
      if (!s.ok) return null;
      const r = await s.json();
      if (!Array.isArray(r) || !r.length) return null;
      const t = r.find(x => x.syncedLyrics) || r[0];
      if (t.syncedLyrics) return t.syncedLyrics;
      const d = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(t.trackName)}&artist_name=${encodeURIComponent(t.artistName)}`);
      if (d.ok) { const dt = await d.json(); if (dt.syncedLyrics) return dt.syncedLyrics; }
      return null;
    }

    let rawLrc = await fetchNetease(query);
    if (!rawLrc) rawLrc = await fetchNetease(query.replace(/-.*/, '').trim());
    if (!rawLrc) rawLrc = await fetchLRCLIB(query);
    if (!rawLrc) throw new Error('No timed lyrics available.');

    const metaRe = /^(作词|作曲|编曲|制作人|OP|SP|纯音乐|制作|混音|录音|监制|原曲|原唱|翻唱|改编|和声|吉他|贝斯|鼓|键盘|小提琴|大提琴|口琴|萨克斯|钢琴|弦乐|管乐|打击乐|发行|出品|企划|统筹|宣传|封面|设计)\s*[:：]/;
    const allParsed = parseLRC(rawLrc);
    let entries = allParsed.filter(e => !metaRe.test(e.text));
    if (entries.length < 3 && allParsed.length >= 3) entries = allParsed;
    if (entries.length === 0) throw new Error('Could not parse lyrics.');
    const dur = song.durationMs > 0 ? song.durationMs : 240000;
    q.lyricsOffset = 0;
    const stopBtn = new ButtonBuilder()
      .setCustomId('stop-lyrics')
      .setLabel('✕ Stop')
      .setStyle(ButtonStyle.Danger);
    const backBtn = new ButtonBuilder()
      .setCustomId('lyrics-back')
      .setLabel('◀ -5s')
      .setStyle(ButtonStyle.Secondary);
    const fwdBtn = new ButtonBuilder()
      .setCustomId('lyrics-fwd')
      .setLabel('+5s ▶')
      .setStyle(ButtonStyle.Secondary);
    const resetBtn = new ButtonBuilder()
      .setCustomId('lyrics-reset')
      .setLabel('⟲ Reset')
      .setStyle(ButtonStyle.Danger);
    const row1 = new ActionRowBuilder().addComponents(backBtn, resetBtn, fwdBtn);
    const row2 = new ActionRowBuilder().addComponents(stopBtn);
    const embed = this.buildLyricsEmbed(song, entries, 0, dur, 0);
    const msg = await channel.send({ embeds: [embed], components: [row1, row2] });
    q.liveLyricsMessage = msg;
    const col = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: dur + 30000,
    });
    col.on('collect', async (i) => {
      try {
        if (i.customId === 'stop-lyrics') {
          this.stopLiveLyrics(guildId);
          await i.update({ components: [] });
        } else {
          await i.deferUpdate();
          const offset = i.customId === 'lyrics-back' ? (q.lyricsOffset || 0) - 5000
                       : i.customId === 'lyrics-fwd' ? (q.lyricsOffset || 0) + 5000
                       : 0;
          q.lyricsOffset = offset;
          q._lastLyricsIdx = -1;
          const pos = Math.max(0, (q.streamStartTime ? Date.now() - q.streamStartTime : 0) + offset);
          let idx = 0;
          for (let j = 0; j < entries.length; j++) {
            if (entries[j].time <= pos) idx = j;
            else break;
          }
          q._lastLyricsIdx = idx;
          const e2 = this.buildLyricsEmbed(song, entries, idx, dur, pos);
          await q.liveLyricsMessage?.edit({ embeds: [e2], components: [row1, row2] });
        }
      } catch (e) {
        if (i.customId !== 'stop-lyrics') console.error('Lyrics button error:', e);
      }
    });
    const updateLyrics = () => {
      if (!q.liveLyricsMessage) { this.stopLiveLyrics(guildId); return; }
      if (q.isPaused) return;
      const pos = Math.max(0, (q.streamStartTime ? Date.now() - q.streamStartTime : 0) + (q.lyricsOffset || 0));
      let idx = 0;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].time <= pos) idx = i;
        else break;
      }
      if (q._lastLyricsIdx === idx) return;
      q._lastLyricsIdx = idx;
      const embed2 = this.buildLyricsEmbed(song, entries, idx, dur, pos);
      q.liveLyricsMessage.edit({ embeds: [embed2], components: [row1, row2] }).catch(() => {});
    };
    q.liveLyricsInterval = setInterval(updateLyrics, 500);
  }

  buildLyricsEmbed(song, entries, currentIdx, dur, pos) {
    const totalLines = entries.length;
    const pageSize = 20;
    const page = Math.floor(currentIdx / pageSize);
    const start = page * pageSize;
    const pageEntries = entries.slice(start, start + pageSize);
    const desc = pageEntries.map((e, i) => {
      const idx = start + i;
      return idx === currentIdx ? `**● ${e.text}**` : `  ${e.text}`;
    }).join('\n');
    const pct = dur > 0 ? Math.round(pos / dur * 100) : 0;
    return {
      color: 0x8844FF,
      title: `♫ ${song.title}`,
      description: desc.length > 3900 ? desc.slice(0, 3897) + '...' : desc,
      footer: { text: `⏱ ${Math.floor(pos / 1000)}s ▸ ${pct}% ▸ LN ${currentIdx + 1}/${totalLines}` },
    };
  }

  stopLiveLyrics(guildId) {
    const q = this.queues.get(guildId);
    if (!q) return;
    if (q.liveLyricsInterval) {
      clearInterval(q.liveLyricsInterval);
      q.liveLyricsInterval = null;
    }
    if (q.liveLyricsMessage) {
      q.liveLyricsMessage.edit({ components: [] }).catch(() => {});
      q.liveLyricsMessage = null;
    }
  }

  disconnect(guildId) {
    const q = this.getQueue(guildId);
    this.stop(guildId);
    if (q.connection) {
      q.connection.destroy();
      q.connection = null;
    }
  }

  destroyIfEmpty(guildId) {
    const q = this.queues.get(guildId);
    if (!q) return;
    if (q.songs.length === 0 && q.currentIndex === -1) {
      if (q.stayInVC) return;
      if (q.destroyTimeout) clearTimeout(q.destroyTimeout);
      q.destroyTimeout = setTimeout(() => {
        if (q.connection) {
          q.connection.destroy();
          q.connection = null;
        }
        if (q.textChannel) {
          q.textChannel.send({ embeds: [{ color: MAGENTA, description: '⍟ **SESSION TERMINATED** \nQueue empty · Left voice channel.' }] }).catch(() => {});
        }
        this.queues.delete(guildId);
      }, 60000);
    }
  }

  getStatus(guildId) {
    const q = this.queues.get(guildId);
    if (!q || q.currentIndex === -1 || q.songs.length === 0) return null;
    return {
      current: q.songs[q.currentIndex],
      queue: q.songs,
      index: q.currentIndex,
      volume: q.volume,
      loopMode: q.loopMode,
      autoplay: q.autoplay,
      isPaused: q.isPaused,
      position: q.position,
      filters: q.filters,
    };
  }
}
