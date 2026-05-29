// SoundForge v5 — чистый @discordjs/voice + play-dl, без discord-player
const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, REST, Routes, SlashCommandBuilder
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const play = require('play-dl');
const mongoose = require('mongoose');
const https = require('https');
const http = require('http');
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MONGO = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL;
if (!TOKEN) { console.error('NO TOKEN'); process.exit(1); }
// DB
const SavedTrack = (() => {
  const s = new mongoose.Schema({ guildId: String, title: String, artist: String, url: String, duration: Number, addedBy: String, source: String, addedAt: { type: Date, default: Date.now } });
  return mongoose.model('SavedTrack', s);
})();
let dbOk = false;
if (MONGO) mongoose.connect(MONGO, { dbName: 'soundforge' }).then(() => { dbOk = true; console.log('DB OK'); }).catch(e => console.error('DB:', e.message));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
// ═══ QUEUE SYSTEM ═══
const queues = new Map();
function getQ(id) { return queues.get(id); }
function vol(v) { return '█'.repeat(Math.round(v / 10)) + '░'.repeat(10 - Math.round(v / 10)) + ' ' + v + '%'; }
function fmt(s) { if (!s) return '-:--'; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function cleanName(u) { try { return decodeURIComponent(u.split('/').pop().split('?')[0]).replace(/\.\w+$/, '').replace(/[_-]/g, ' ').replace(/\d{6,}/, '').trim() || 'Track'; } catch { return 'Track'; } }
function isDirectURL(u) { if (!u?.startsWith('http')) return false; const l = u.toLowerCase().split('?')[0]; return ['.mp3','.wav','.ogg','.flac','.m4a','.aac','.opus','.webm'].some(e => l.endsWith(e)) || u.includes('hitmoz') || u.includes('/get/music/'); }
function httpStream(url) {
  return new Promise((ok, fail) => {
    (url.startsWith('https') ? https : http).get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 15000 }, r => {
      if ([301,302,303,307,308].includes(r.statusCode) && r.headers.location) { r.destroy(); return httpStream(r.headers.location).then(ok).catch(fail); }
      if (r.statusCode !== 200) { r.destroy(); return fail(new Error('HTTP ' + r.statusCode)); }
      ok(r);
    }).on('error', fail).on('timeout', function() { this.destroy(); fail(new Error('Timeout')); });
  });
}
// Embeds
function embed(q) {
  const t = q.current;
  if (!t) return new EmbedBuilder().setColor(0x7c3aed).setDescription('Nothing playing');
  const loops = ['Off', 'Track', 'Queue'];
  return new EmbedBuilder().setColor(0x7c3aed)
    .setTitle(t.title)
    .setDescription([
      t.artist ? `${t.artist}` : null,
      '',
      `${q.paused ? 'Paused' : 'Playing'}  ${fmt(t.duration)}`,
      vol(q.vol),
      `Loop: ${loops[q.loop]}  |  Queue: ${q.tracks.length}`,
    ].filter(x => x !== null).join('\n'))
    .setThumbnail(t.thumb || null)
    .setFooter({ text: t.user + ' | SoundForge' }).setTimestamp();
}
function btns(p) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prev').setLabel('Prev').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(p ? 'play' : 'pause').setLabel(p ? 'Play' : 'Pause').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('save').setLabel('Save').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vd').setLabel('Vol -').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vu').setLabel('Vol +').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('shuf').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('qlist').setLabel('Queue').setStyle(ButtonStyle.Secondary),
    )
  ];
}
// Play next
async function next(gid) {
  const q = getQ(gid);
  if (!q) return;
  if (!q.tracks.length) {
    q.ch.send({ embeds: [new EmbedBuilder().setColor(0x6b7280).setDescription('Queue ended')] });
    q.conn.destroy(); queues.delete(gid); return;
  }
  const t = q.tracks.shift();
  q.current = t;
  try {
    let resource;
    if (t.direct) {
      const s = await httpStream(t.url);
      resource = createAudioResource(s, { inputType: StreamType.Arbitrary, inlineVolume: true });
    } else {
      const s = await play.stream(t.url);
      resource = createAudioResource(s.stream, { inputType: s.type, inlineVolume: true });
    }
    resource.volume?.setVolume(q.vol / 100);
    q.res = resource;
    q.ap.play(resource);
    q.paused = false;
    q.ch.send({ embeds: [embed(q)], components: btns(false) });
  } catch (e) {
    console.error('Next:', e.message);
    q.ch.send({ content: 'Error: ' + e.message });
    next(gid);
  }
}
async function enqueue(guild, vc, ch, tracks) {
  let q = getQ(guild.id);
  if (!q) {
    const conn = joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    try { await entersState(conn, VoiceConnectionStatus.Ready, 15000); } catch { conn.destroy(); throw new Error('Cannot connect'); }
    const ap = createAudioPlayer();
    conn.subscribe(ap);
    q = { conn, ap, res: null, tracks: [], current: null, vol: 60, loop: 0, paused: false, ch };
    ap.on(AudioPlayerStatus.Idle, () => {
      const qq = getQ(guild.id);
      if (!qq) return;
      if (qq.loop === 1 && qq.current) qq.tracks.unshift({ ...qq.current });
      if (qq.loop === 2 && qq.current) qq.tracks.push({ ...qq.current });
      next(guild.id);
    });
    ap.on('error', e => { console.error('AP:', e.message); next(guild.id); });
    queues.set(guild.id, q);
  }
  const wasIdle = !q.current || q.ap.state.status === AudioPlayerStatus.Idle;
  q.tracks.push(...tracks);
  q.ch = ch;
  if (wasIdle) await next(guild.id);
}
// ═══ BUTTONS ═══
client.on(Events.InteractionCreate, async i => {
  if (!i.isButton()) return;
  if (!i.member?.voice?.channel) return i.reply({ content: 'Join VC', ephemeral: true });
  const q = getQ(i.guild.id);
  if (!q) return i.reply({ content: 'Nothing playing', ephemeral: true });
  try {
    if (i.customId === 'pause') { q.ap.pause(); q.paused = true; return i.update({ embeds: [embed(q)], components: btns(true) }); }
    if (i.customId === 'play') { q.ap.unpause(); q.paused = false; return i.update({ embeds: [embed(q)], components: btns(false) }); }
    if (i.customId === 'skip') { q.ap.stop(); return i.reply({ content: 'Skipped', ephemeral: true }); }
    if (i.customId === 'prev') { if (q.current) q.tracks.unshift({ ...q.current }); q.ap.stop(); return i.reply({ content: 'Prev', ephemeral: true }); }
    if (i.customId === 'stop') { q.tracks = []; q.ap.stop(); q.conn.destroy(); queues.delete(i.guild.id); return i.update({ embeds: [new EmbedBuilder().setColor(0x6b7280).setDescription('Stopped')], components: [] }); }
    if (i.customId === 'vd') { q.vol = Math.max(0, q.vol - 10); q.res?.volume?.setVolume(q.vol / 100); return i.update({ embeds: [embed(q)], components: btns(q.paused) }); }
    if (i.customId === 'vu') { q.vol = Math.min(100, q.vol + 10); q.res?.volume?.setVolume(q.vol / 100); return i.update({ embeds: [embed(q)], components: btns(q.paused) }); }
    if (i.customId === 'shuf') { for (let x = q.tracks.length - 1; x > 0; x--) { const j = Math.floor(Math.random() * (x + 1)); [q.tracks[x], q.tracks[j]] = [q.tracks[j], q.tracks[x]]; } return i.reply({ content: 'Shuffled', ephemeral: true }); }
    if (i.customId === 'loop') { q.loop = (q.loop + 1) % 3; return i.update({ embeds: [embed(q)], components: btns(q.paused) }); }
    if (i.customId === 'qlist') { return i.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle('Queue').setDescription(q.tracks.length ? q.tracks.slice(0, 12).map((t, x) => `${x + 1}. ${t.title}`).join('\n') : 'Empty')], ephemeral: true }); }
    if (i.customId === 'save') {
      if (!dbOk) return i.reply({ content: 'No DB', ephemeral: true });
      if (!q.current) return i.reply({ content: 'Nothing', ephemeral: true });
      await SavedTrack.create({ guildId: i.guild.id, title: q.current.title, artist: q.current.artist, url: q.current.url, duration: q.current.duration, addedBy: i.user.username, source: q.current.direct ? 'url' : 'search' });
      return i.reply({ content: 'Saved: ' + q.current.title, ephemeral: true });
    }
  } catch (e) { console.error('BTN:', e.message); if (!i.replied) i.reply({ content: 'Error', ephemeral: true }).catch(() => {}); }
});
// ═══ COMMANDS ═══
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;
  const vc = i.member?.voice?.channel;
  try {
    if (i.commandName === 'play') {
      if (!vc) return i.reply({ content: 'Join VC', ephemeral: true });
      const query = i.options.getString('query', true).trim();
      await i.deferReply();
      // 1) Direct URL
      if (query.startsWith('http')) {
        // Check if audio
        let isDirect = isDirectURL(query);
        if (!isDirect) {
          try {
            const s = await httpStream(query);
            const ct = s.headers['content-type'] || '';
            s.destroy();
            isDirect = ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg') || ct.includes('octet');
          } catch {}
        }
        if (isDirect) {
          await enqueue(i.guild, vc, i.channel, [{ title: cleanName(query), artist: '', url: query, duration: 0, thumb: null, user: i.user.username, direct: true }]);
          return i.followUp('Playing: **' + cleanName(query) + '**');
        }
        // Try play-dl for SoundCloud/Spotify URLs
        try {
          const info = await play.search(query, { limit: 1 });
          if (info.length) {
            const t = info[0];
            await enqueue(i.guild, vc, i.channel, [{ title: t.title, artist: t.channel?.name || '', url: t.url, duration: t.durationInSec || 0, thumb: t.thumbnails?.[0]?.url, user: i.user.username, direct: false }]);
            return i.followUp('Playing: **' + t.title + '**');
          }
        } catch (e) { console.log('play-dl URL:', e.message); }
        return i.followUp('Cannot play this URL');
      }
      // 2) Search by name via play-dl (SoundCloud)
      try {
        const results = await play.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
        if (results.length) {
          const t = results[0];
          await enqueue(i.guild, vc, i.channel, [{ title: t.title, artist: t.user?.name || t.channel?.name || '', url: t.url, duration: t.durationInSec || 0, thumb: t.thumbnails?.[0]?.url, user: i.user.username, direct: false }]);
          return i.followUp('Playing: **' + t.title + '**');
        }
      } catch (e) { console.log('SC:', e.message); }
      // 3) General search
      try {
        const results = await play.search(query, { limit: 1 });
        if (results.length) {
          const t = results[0];
          await enqueue(i.guild, vc, i.channel, [{ title: t.title, artist: t.channel?.name || '', url: t.url, duration: t.durationInSec || 0, thumb: t.thumbnails?.[0]?.url, user: i.user.username, direct: false }]);
          return i.followUp('Playing: **' + t.title + '**');
        }
      } catch (e) { console.log('Search:', e.message); }
      return i.followUp('Not found. Try a direct .mp3 link.');
    }
    if (i.commandName === 'np') { const q = getQ(i.guild.id); if (!q?.current) return i.reply({ content: 'Nothing', ephemeral: true }); return i.reply({ embeds: [embed(q)], components: btns(q.paused) }); }
    if (i.commandName === 'skip') { const q = getQ(i.guild.id); if (!q) return i.reply({ content: '-', ephemeral: true }); q.ap.stop(); return i.reply('Skipped'); }
    if (i.commandName === 'stop') { const q = getQ(i.guild.id); if (q) { q.tracks = []; q.ap.stop(); q.conn.destroy(); queues.delete(i.guild.id); } return i.reply('Stopped'); }
    if (i.commandName === 'pause') { const q = getQ(i.guild.id); if (!q) return i.reply({ content: '-', ephemeral: true }); q.ap.pause(); q.paused = true; return i.reply('Paused'); }
    if (i.commandName === 'resume') { const q = getQ(i.guild.id); if (!q) return i.reply({ content: '-', ephemeral: true }); q.ap.unpause(); q.paused = false; return i.reply('Resumed'); }
    if (i.commandName === 'volume') { const q = getQ(i.guild.id); if (!q) return i.reply({ content: '-', ephemeral: true }); q.vol = i.options.getInteger('level', true); q.res?.volume?.setVolume(q.vol / 100); return i.reply('Volume: ' + q.vol + '%'); }
    if (i.commandName === 'queue') { const q = getQ(i.guild.id); if (!q?.tracks.length) return i.reply({ content: 'Empty', ephemeral: true }); return i.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle('Queue').setDescription(`Now: **${q.current?.title}**\n\n${q.tracks.slice(0, 15).map((t, x) => `${x + 1}. ${t.title}`).join('\n')}`)] }); }
    if (i.commandName === 'shuffle') { const q = getQ(i.guild.id); if (!q) return i.reply({ content: '-', ephemeral: true }); for (let x = q.tracks.length - 1; x > 0; x--) { const j = Math.floor(Math.random() * (x + 1)); [q.tracks[x], q.tracks[j]] = [q.tracks[j], q.tracks[x]]; } return i.reply('Shuffled'); }
    if (i.commandName === 'loop') { const q = getQ(i.guild.id); if (!q) return i.reply({ content: '-', ephemeral: true }); const m = i.options.getString('mode', true); q.loop = { off: 0, track: 1, queue: 2 }[m]; return i.reply('Loop: ' + m); }
    if (i.commandName === 'library') {
      if (!dbOk) return i.reply({ content: 'No DB', ephemeral: true });
      const s = await SavedTrack.find({ guildId: i.guild.id }).sort({ addedAt: -1 }).limit(20);
      if (!s.length) return i.reply({ content: 'Library empty', ephemeral: true });
      return i.reply({ embeds: [new EmbedBuilder().setColor(0x7c3aed).setTitle('Library').setDescription(s.map((t, x) => `**${x + 1}.** ${t.title}`).join('\n'))], ephemeral: true });
    }
    if (i.commandName === 'playlib') {
      if (!vc) return i.reply({ content: 'Join VC', ephemeral: true });
      if (!dbOk) return i.reply({ content: 'No DB', ephemeral: true });
      const n = i.options.getInteger('number', true);
      const s = await SavedTrack.find({ guildId: i.guild.id }).sort({ addedAt: -1 });
      if (n < 1 || n > s.length) return i.reply({ content: '1-' + s.length, ephemeral: true });
      const t = s[n - 1]; if (!t.url) return i.reply({ content: 'No URL', ephemeral: true });
      await i.deferReply();
      const isDirect = t.source === 'url' || t.source === 'direct' || isDirectURL(t.url);
      try {
        if (isDirect) {
          await enqueue(i.guild, vc, i.channel, [{ title: t.title, artist: t.artist, url: t.url, duration: t.duration, thumb: null, user: i.user.username, direct: true }]);
        } else {
          const res = await play.search(t.url, { limit: 1 });
          if (!res.length) return i.followUp('Not found');
          await enqueue(i.guild, vc, i.channel, [{ title: res[0].title, artist: '', url: res[0].url, duration: res[0].durationInSec, thumb: res[0].thumbnails?.[0]?.url, user: i.user.username, direct: false }]);
        }
        return i.followUp('Playing: **' + t.title + '**');
      } catch (e) { return i.followUp('Error: ' + e.message); }
    }
  } catch (e) { console.error('CMD:', e.message); const r = { content: e.message, ephemeral: true }; if (i.replied || i.deferred) i.followUp(r).catch(() => {}); else i.reply(r).catch(() => {}); }
});
// ═══ START ═══
client.once(Events.ClientReady, async c => {
  console.log(`\n${c.user.tag} ONLINE | ${c.guilds.cache.size} guilds | DB: ${dbOk}\n`);
  c.user.setActivity('/play', { type: ActivityType.Listening });
  const cmds = [
    new SlashCommandBuilder().setName('play').setDescription('Play').addStringOption(o => o.setName('query').setDescription('URL or name').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('Now playing'),
    new SlashCommandBuilder().setName('skip').setDescription('Skip'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume'),
    new SlashCommandBuilder().setName('queue').setDescription('Queue'),
    new SlashCommandBuilder().setName('volume').setDescription('Volume').addIntegerOption(o => o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle'),
    new SlashCommandBuilder().setName('loop').setDescription('Loop').addStringOption(o => o.setName('mode').setDescription('Mode').setRequired(true).addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
    new SlashCommandBuilder().setName('library').setDescription('Library'),
    new SlashCommandBuilder().setName('playlib').setDescription('From library').addIntegerOption(o => o.setName('number').setDescription('#').setRequired(true).setMinValue(1)),
  ].map(c => c.toJSON());
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
    console.log('Commands OK');
  } catch (e) { console.error('Reg:', e.message); }
});
client.login(TOKEN);
