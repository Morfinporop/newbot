// SoundForge v4 — discord-player v7
const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, REST, Routes, SlashCommandBuilder
} = require('discord.js');
const { Player, useQueue, useMainPlayer, QueryType } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const mongoose = require('mongoose');
const https = require('https');
const http = require('http');

// ═══ КОНФИГУРАЦИЯ — ЗАМЕНИ НА СВОИ ПОСЛЕ ТЕСТА ═══
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || '1509625871797977300';
const GUILD_ID = process.env.GUILD_ID || '1459972063346557035';
const MONGO = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL;

if (!TOKEN) { console.error('DISCORD_TOKEN не задан!'); process.exit(1); }

// ═══ БАЗА ДАННЫХ ═══
const trackSchema = new mongoose.Schema({
  guildId: String, title: String, artist: String,
  url: String, duration: String, addedBy: String,
  source: String, addedAt: { type: Date, default: Date.now }
});
const SavedTrack = mongoose.model('SavedTrack', trackSchema);

let dbOk = false;
if (MONGO) {
  mongoose.connect(MONGO, { dbName: 'soundforge' })
    .then(() => { dbOk = true; console.log('DB: OK'); })
    .catch(e => console.error('DB:', e.message));
} else {
  console.log('DB: not configured');
}

// ═══ DISCORD КЛИЕНТ ═══
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ═══ DISCORD-PLAYER v7 ═══
const player = new Player(client);

// Загрузка экстракторов
(async () => {
  await player.extractors.loadMulti(DefaultExtractors);
  console.log('Extractors: loaded');
})();

// ═══ DIRECT PLAYER — для прямых MP3 ссылок ═══
const directs = new Map();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.destroy(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function playURL(guild, vc, tc, url, title, username) {
  // Убить старый
  const old = directs.get(guild.id);
  if (old) { try { old.ap.stop(true); old.conn.destroy(); } catch {} directs.delete(guild.id); }

  const conn = joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  try { await entersState(conn, VoiceConnectionStatus.Ready, 15000); } catch { conn.destroy(); return false; }

  let stream;
  try { stream = await httpGet(url); } catch (e) { console.error('Stream:', e.message); conn.destroy(); return false; }

  const res = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
  res.volume?.setVolume(0.5);

  const ap = createAudioPlayer();
  ap.play(res);
  conn.subscribe(ap);

  const info = { conn, ap, res, title, url, user: username, vol: 50, paused: false };
  directs.set(guild.id, info);

  ap.on(AudioPlayerStatus.Idle, () => { directs.delete(guild.id); try { conn.destroy(); } catch {} });
  ap.on('error', (e) => { console.error('AP:', e.message); directs.delete(guild.id); try { conn.destroy(); } catch {} });

  tc.send({ embeds: [directEmbed(info)], components: [directBtns(false)] });
  return true;
}

function directEmbed(d) {
  return new EmbedBuilder().setColor(0x06b6d4)
    .setTitle(d.title || 'Трек')
    .setDescription(`${d.paused ? 'На паузе' : 'Воспроизводится'}\n${'█'.repeat(Math.round(d.vol/10))}${'░'.repeat(10-Math.round(d.vol/10))} ${d.vol}%\n\nЗапросил: **${d.user}**`)
    .setFooter({ text: 'SoundForge' }).setTimestamp();
}

function directBtns(p) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('d_pp').setLabel(p?'Play':'Pause').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('d_stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('d_vd').setLabel('Vol -').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('d_vu').setLabel('Vol +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('d_save').setLabel('Save').setStyle(ButtonStyle.Success),
  );
}

function isMP3(url) {
  if (!url || !url.startsWith('http')) return false;
  const u = url.toLowerCase().split('?')[0].split('#')[0];
  return ['.mp3','.wav','.ogg','.flac','.m4a','.aac','.opus','.webm'].some(e => u.endsWith(e))
    || url.includes('hitmoz') || url.includes('/get/music/');
}

function nameFromURL(u) {
  try { return decodeURIComponent(u.split('/').pop().split('?')[0]).replace(/\.\w+$/,'').replace(/[_-]/g,' ').replace(/\d{6,}/,'').trim() || 'Трек'; }
  catch { return 'Трек'; }
}

// ═══ EMBED для discord-player v7 ═══
function trackEmbed(track, queue) {
  const bar = queue.node.createProgressBar({ timecodes: true, length: 16 });
  const loops = { 0: 'Off', 1: 'Track', 2: 'Queue' };
  return new EmbedBuilder().setColor(0x06b6d4)
    .setTitle(track.title)
    .setURL(track.url || null)
    .setDescription(`**${track.author}**\n\n${bar}\n\n${'█'.repeat(Math.round(queue.node.volume/10))}${'░'.repeat(10-Math.round(queue.node.volume/10))} ${queue.node.volume}%\nLoop: ${loops[queue.repeatMode]||'Off'} | Queue: ${queue.tracks.size}`)
    .setThumbnail(track.thumbnail)
    .setFooter({ text: `${track.requestedBy?.username||'?'} | SoundForge` }).setTimestamp();
}

function trackBtns(p) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t_prev').setLabel('Prev').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(p?'t_res':'t_pau').setLabel(p?'Play':'Pause').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('t_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t_stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('t_save').setLabel('Save').setStyle(ButtonStyle.Success),
  );
}

function trackBtns2() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('t_vd').setLabel('Vol -').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t_vu').setLabel('Vol +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t_shuf').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t_loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('t_q').setLabel('Queue').setStyle(ButtonStyle.Secondary),
  );
}

// ═══ КНОПКИ ═══
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;
  if (!i.member?.voice?.channel) return i.reply({ content: 'Join a voice channel first', ephemeral: true });

  try {
    // Direct
    if (i.customId.startsWith('d_')) {
      const d = directs.get(i.guild.id);
      if (!d) return i.reply({ content: 'Nothing playing', ephemeral: true });
      if (i.customId === 'd_pp') { if (d.paused) { d.ap.unpause(); d.paused = false; } else { d.ap.pause(); d.paused = true; } return i.update({ embeds: [directEmbed(d)], components: [directBtns(d.paused)] }); }
      if (i.customId === 'd_stop') { d.ap.stop(true); d.conn.destroy(); directs.delete(i.guild.id); return i.update({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('Stopped')], components: [] }); }
      if (i.customId === 'd_vd') { d.vol = Math.max(0, d.vol - 10); d.res.volume?.setVolume(d.vol / 100); return i.update({ embeds: [directEmbed(d)], components: [directBtns(d.paused)] }); }
      if (i.customId === 'd_vu') { d.vol = Math.min(100, d.vol + 10); d.res.volume?.setVolume(d.vol / 100); return i.update({ embeds: [directEmbed(d)], components: [directBtns(d.paused)] }); }
      if (i.customId === 'd_save') {
        if (!dbOk) return i.reply({ content: 'DB not connected', ephemeral: true });
        await SavedTrack.create({ guildId: i.guild.id, title: d.title, artist: d.user, url: d.url, addedBy: i.user.username, source: 'direct' });
        return i.reply({ content: `Saved: **${d.title}**`, ephemeral: true });
      }
    }

    // Player v7
    if (i.customId.startsWith('t_')) {
      const q = useQueue(i.guild.id);
      if (!q) return i.reply({ content: 'No queue', ephemeral: true });
      if (i.customId === 't_pau') { q.node.pause(); return i.update({ embeds: [trackEmbed(q.currentTrack, q)], components: [trackBtns(true), trackBtns2()] }); }
      if (i.customId === 't_res') { q.node.resume(); return i.update({ embeds: [trackEmbed(q.currentTrack, q)], components: [trackBtns(false), trackBtns2()] }); }
      if (i.customId === 't_skip') { q.node.skip(); return i.reply({ content: 'Skipped', ephemeral: true }); }
      if (i.customId === 't_prev') { try { await q.history.back(); return i.reply({ content: 'Previous', ephemeral: true }); } catch { return i.reply({ content: 'No history', ephemeral: true }); } }
      if (i.customId === 't_stop') { q.delete(); return i.update({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('Stopped')], components: [] }); }
      if (i.customId === 't_vd') { q.node.setVolume(Math.max(0, q.node.volume - 10)); return i.update({ embeds: [trackEmbed(q.currentTrack, q)], components: [trackBtns(false), trackBtns2()] }); }
      if (i.customId === 't_vu') { q.node.setVolume(Math.min(100, q.node.volume + 10)); return i.update({ embeds: [trackEmbed(q.currentTrack, q)], components: [trackBtns(false), trackBtns2()] }); }
      if (i.customId === 't_shuf') { if (q.tracks.size < 2) return i.reply({ content: 'Not enough tracks', ephemeral: true }); q.tracks.shuffle(); return i.reply({ content: 'Shuffled', ephemeral: true }); }
      if (i.customId === 't_loop') { const n = (q.repeatMode + 1) % 3; q.setRepeatMode(n); return i.update({ embeds: [trackEmbed(q.currentTrack, q)], components: [trackBtns(false), trackBtns2()] }); }
      if (i.customId === 't_q') {
        if (!q.tracks.size) return i.reply({ content: 'Queue empty', ephemeral: true });
        return i.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('Queue').setDescription(q.tracks.map((t,idx)=>`**${idx+1}.** ${t.title}`).slice(0,10).join('\n'))], ephemeral: true });
      }
      if (i.customId === 't_save') {
        if (!dbOk) return i.reply({ content: 'DB not connected', ephemeral: true });
        const t = q.currentTrack;
        await SavedTrack.create({ guildId: i.guild.id, title: t.title, artist: t.author, url: t.url, duration: t.duration, addedBy: i.user.username, source: 'search' });
        return i.reply({ content: `Saved: **${t.title}**`, ephemeral: true });
      }
    }
  } catch (e) { console.error('Btn:', e.message); if (!i.replied && !i.deferred) i.reply({ content: 'Error', ephemeral: true }).catch(()=>{}); }
});

// ═══ SLASH КОМАНДЫ ═══
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  const vc = i.member?.voice?.channel;

  try {
    if (i.commandName === 'play') {
      if (!vc) return i.reply({ content: 'Join a voice channel', ephemeral: true });
      const q = i.options.getString('query', true).trim();
      await i.deferReply();

      // 1) Прямая MP3 ссылка
      if (isMP3(q)) {
        const ok = await playURL(i.guild, vc, i.channel, q, nameFromURL(q), i.user.username);
        return i.followUp(ok ? `Playing: **${nameFromURL(q)}**` : 'Failed to play URL');
      }

      // 2) Любой URL — проверяем audio
      if (q.startsWith('http')) {
        try {
          const stream = await httpGet(q);
          const ct = stream.headers?.['content-type'] || '';
          if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg')) {
            stream.destroy();
            const ok = await playURL(i.guild, vc, i.channel, q, nameFromURL(q), i.user.username);
            return i.followUp(ok ? `Playing: **${nameFromURL(q)}**` : 'Failed');
          }
          stream.destroy();
        } catch {}
      }

      // 3) discord-player v7 search
      const p = useMainPlayer();
      try {
        const { track } = await p.play(vc, q, {
          nodeOptions: { metadata: { channel: i.channel }, volume: 50, leaveOnEmpty: true, leaveOnEmptyCooldown: 60000, leaveOnEnd: true, leaveOnEndCooldown: 60000 },
          requestedBy: i.user
        });
        return i.followUp({ embeds: [new EmbedBuilder().setColor(0x22c55e).setDescription(`**${track.title}** — ${track.author}`).setThumbnail(track.thumbnail)] });
      } catch (e) {
        console.error('Play:', e.message);
        return i.followUp('Not found. Try a direct MP3 link or Spotify/SoundCloud URL.');
      }
    }

    if (i.commandName === 'np') {
      const d = directs.get(i.guild.id);
      if (d) return i.reply({ embeds: [directEmbed(d)], components: [directBtns(d.paused)] });
      const q = useQueue(i.guild.id);
      if (!q?.currentTrack) return i.reply({ content: 'Nothing playing', ephemeral: true });
      return i.reply({ embeds: [trackEmbed(q.currentTrack, q)], components: [trackBtns(q.node.isPaused()), trackBtns2()] });
    }

    if (i.commandName === 'stop') {
      const d = directs.get(i.guild.id);
      if (d) { d.ap.stop(true); d.conn.destroy(); directs.delete(i.guild.id); }
      const q = useQueue(i.guild.id); if (q) q.delete();
      return i.reply('Stopped');
    }

    if (i.commandName === 'skip') { const q = useQueue(i.guild.id); if (!q?.isPlaying()) return i.reply({ content: 'Nothing', ephemeral: true }); q.node.skip(); return i.reply('Skipped'); }
    if (i.commandName === 'pause') { const q = useQueue(i.guild.id); if (!q?.isPlaying()) return i.reply({ content: 'Nothing', ephemeral: true }); q.node.pause(); return i.reply('Paused'); }
    if (i.commandName === 'resume') { const q = useQueue(i.guild.id); if (!q) return i.reply({ content: 'Nothing', ephemeral: true }); q.node.resume(); return i.reply('Resumed'); }
    if (i.commandName === 'queue') {
      const q = useQueue(i.guild.id);
      if (!q?.tracks.size) return i.reply({ content: 'Empty', ephemeral: true });
      return i.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('Queue').setDescription(`Now: **${q.currentTrack?.title}**\n\n${q.tracks.map((t,idx)=>`${idx+1}. ${t.title}`).slice(0,15).join('\n')}`)] });
    }
    if (i.commandName === 'volume') { const q = useQueue(i.guild.id); if (!q) return i.reply({ content: 'Nothing', ephemeral: true }); q.node.setVolume(i.options.getInteger('level',true)); return i.reply(`Volume: ${q.node.volume}%`); }
    if (i.commandName === 'shuffle') { const q = useQueue(i.guild.id); if (!q) return i.reply({ content: 'Nothing', ephemeral: true }); q.tracks.shuffle(); return i.reply('Shuffled'); }
    if (i.commandName === 'loop') { const q = useQueue(i.guild.id); if (!q) return i.reply({ content: 'Nothing', ephemeral: true }); const m=i.options.getString('mode',true); q.setRepeatMode({off:0,track:1,queue:2}[m]); return i.reply(`Loop: ${m}`); }
    if (i.commandName === 'library') {
      if (!dbOk) return i.reply({ content: 'DB not connected', ephemeral: true });
      const s = await SavedTrack.find({ guildId: i.guild.id }).sort({ addedAt: -1 }).limit(20);
      if (!s.length) return i.reply({ content: 'Library empty. Press Save when playing.', ephemeral: true });
      return i.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('Library').setDescription(s.map((t,idx)=>`**${idx+1}.** ${t.title}`).join('\n'))], ephemeral: true });
    }
    if (i.commandName === 'playlib') {
      if (!vc) return i.reply({ content: 'Join VC', ephemeral: true });
      if (!dbOk) return i.reply({ content: 'DB not connected', ephemeral: true });
      const n = i.options.getInteger('number',true);
      const s = await SavedTrack.find({ guildId: i.guild.id }).sort({ addedAt: -1 });
      if (n<1||n>s.length) return i.reply({ content: `1-${s.length}`, ephemeral: true });
      const t = s[n-1]; if (!t.url) return i.reply({ content: 'No URL', ephemeral: true });
      await i.deferReply();
      if (isMP3(t.url)) { const ok = await playURL(i.guild, vc, i.channel, t.url, t.title, i.user.username); return i.followUp(ok ? `Playing: **${t.title}**` : 'Failed'); }
      const p = useMainPlayer();
      try {
        await p.play(vc, t.url, { nodeOptions: { metadata: { channel: i.channel } }, requestedBy: i.user });
        return i.followUp(`Playing: **${t.title}**`);
      } catch { return i.followUp('Failed'); }
    }
  } catch (e) { console.error('Cmd:', e.message); const r = { content: e.message, ephemeral: true }; if (i.replied||i.deferred) i.followUp(r).catch(()=>{}); else i.reply(r).catch(()=>{}); }
});

// ═══ СОБЫТИЯ ПЛЕЕРА ═══
player.events.on('playerStart', (queue, track) => {
  queue.metadata.channel.send({ embeds: [trackEmbed(track, queue)], components: [trackBtns(false), trackBtns2()] });
});
player.events.on('emptyQueue', (queue) => {
  queue.metadata.channel.send({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('Queue ended')] });
});
player.events.on('error', (q, e) => console.error('PlayerErr:', e.message));
player.events.on('playerError', (q, e) => console.error('TrackErr:', e.message));

// ═══ ЗАПУСК ═══
client.once(Events.ClientReady, async (c) => {
  console.log(`\n${c.user.tag} ONLINE | Guilds: ${c.guilds.cache.size} | DB: ${dbOk}\n`);
  c.user.setActivity('/play', { type: ActivityType.Listening });

  const cmds = [
    new SlashCommandBuilder().setName('play').setDescription('Play (URL, Spotify, SoundCloud, name)').addStringOption(o=>o.setName('query').setDescription('URL or search').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('Now playing + controls'),
    new SlashCommandBuilder().setName('skip').setDescription('Skip'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume'),
    new SlashCommandBuilder().setName('queue').setDescription('Queue'),
    new SlashCommandBuilder().setName('volume').setDescription('Volume').addIntegerOption(o=>o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle'),
    new SlashCommandBuilder().setName('loop').setDescription('Loop').addStringOption(o=>o.setName('mode').setDescription('Mode').setRequired(true).addChoices({name:'Off',value:'off'},{name:'Track',value:'track'},{name:'Queue',value:'queue'})),
    new SlashCommandBuilder().setName('library').setDescription('Saved tracks'),
    new SlashCommandBuilder().setName('playlib').setDescription('Play from library').addIntegerOption(o=>o.setName('number').setDescription('Track number').setRequired(true).setMinValue(1)),
  ].map(c => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
    console.log('Commands registered');
  } catch (e) { console.error('Reg:', e.message); }
});

client.login(TOKEN);
