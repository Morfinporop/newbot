const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, REST, Routes, SlashCommandBuilder
} = require('discord.js');
const { Player, QueryType } = require('discord-player');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus,
  entersState, getVoiceConnection
} = require('@discordjs/voice');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const https = require('https');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MONGO = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL;

if (!TOKEN) { console.error('DISCORD_TOKEN не задан!'); process.exit(1); }

// ═══ БД ═══
const trackSchema = new mongoose.Schema({
  guildId: String, title: String, artist: String,
  url: String, duration: String, addedBy: String,
  source: String, addedAt: { type: Date, default: Date.now }
});
const SavedTrack = mongoose.model('SavedTrack', trackSchema);
let dbOk = false;
if (MONGO) {
  mongoose.connect(MONGO, { dbName: 'soundforge' })
    .then(() => { dbOk = true; console.log('✅ MongoDB подключена'); })
    .catch(e => console.error('MongoDB:', e.message));
}

// ═══ КЛИЕНТ ═══
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const player = new Player(client, {
  ytdlOptions: { quality: 'highestaudio', highWaterMark: 1 << 25 }
});

// Экстракторы
const { SpotifyExtractor, SoundCloudExtractor, AppleMusicExtractor, AttachmentExtractor } = require('@discord-player/extractor');
player.extractors.register(SpotifyExtractor, {});
player.extractors.register(SoundCloudExtractor, {});
player.extractors.register(AppleMusicExtractor, {});
player.extractors.register(AttachmentExtractor, {});
console.log('✅ Экстракторы: Spotify, SoundCloud, AppleMusic, Attachment');

// ═══ DIRECT PLAYER — для MP3 ссылок ═══
const directPlayers = new Map();

function fetchStream(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchStream(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      resolve(res);
    }).on('error', reject);
  });
}

async function playDirect(guild, voiceChannel, textChannel, url, title, user) {
  try {
    // Остановить предыдущий direct
    const old = directPlayers.get(guild.id);
    if (old) { try { old.player.stop(true); old.connection.destroy(); } catch {} }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    // Ждём подключения
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      connection.destroy();
      return false;
    }

    const stream = await fetchStream(url);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    resource.volume?.setVolume(0.5);

    const audioPlayer = createAudioPlayer();
    audioPlayer.play(resource);
    connection.subscribe(audioPlayer);

    const info = { connection, player: audioPlayer, resource, title, url, user: user.username, volume: 50, paused: false };
    directPlayers.set(guild.id, info);

    // Embed с управлением
    const embed = makeDirectEmbed(info);
    const row = makeDirectButtons(false);
    textChannel.send({ embeds: [embed], components: [row] });

    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      directPlayers.delete(guild.id);
      try { connection.destroy(); } catch {}
    });

    audioPlayer.on('error', (err) => {
      console.error('Direct error:', err.message);
      textChannel.send({ embeds: [new EmbedBuilder().setColor(0xef4444).setDescription(`❌ Ошибка: ${err.message}`)] });
      directPlayers.delete(guild.id);
      try { connection.destroy(); } catch {}
    });

    return true;
  } catch (e) {
    console.error('playDirect:', e.message);
    return false;
  }
}

function makeDirectEmbed(info) {
  const cleanTitle = info.title.replace(/\d{5,}/, '').trim();
  return new EmbedBuilder()
    .setColor(0x06b6d4)
    .setTitle(`♫ ${cleanTitle || 'Трек'}`)
    .setDescription([
      ``,
      `**Статус:** ${info.paused ? '⏸ Пауза' : '▶ Воспроизводится'}`,
      `**Громкость:** ${'▰'.repeat(Math.round(info.volume / 10))}${'▱'.repeat(10 - Math.round(info.volume / 10))} ${info.volume}%`,
      `**Запросил:** ${info.user}`,
      ``,
    ].join('\n'))
    .setFooter({ text: 'SoundForge • Прямая ссылка' })
    .setTimestamp();
}

function makeDirectButtons(paused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('d_pau').setLabel(paused ? 'Плей' : 'Пауза').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('d_stop').setLabel('Стоп').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('d_vd').setLabel('-10').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('d_vu').setLabel('+10').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('d_save').setLabel('Сохранить').setEmoji('💾').setStyle(ButtonStyle.Success),
  );
}

function isAudioURL(url) {
  if (!url || !url.startsWith('http')) return false;
  const exts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm'];
  const clean = url.toLowerCase().split('?')[0].split('#')[0];
  return exts.some(e => clean.endsWith(e)) || url.includes('hitmoz') || url.includes('/get/music/');
}

function titleFromURL(url) {
  try {
    let name = decodeURIComponent(url.split('/').pop().split('?')[0]);
    name = name.replace(/\.\w{2,4}$/, '').replace(/[_-]/g, ' ').replace(/\d{5,}/, '').trim();
    return name || 'Трек';
  } catch { return 'Трек'; }
}

// ═══ КРАСИВЫЙ EMBED ДЛЯ discord-player ═══
function npEmbed(track, queue) {
  const bar = queue.createProgressBar({ timecodes: true, length: 16 });
  const loops = { 0: 'Выкл', 1: '🔂 Трек', 2: '🔁 Очередь' };
  return new EmbedBuilder()
    .setColor(0x06b6d4)
    .setTitle(`♫ ${track.title}`)
    .setURL(track.url || null)
    .setDescription([
      `**${track.author}**`,
      ``,
      bar,
      ``,
      `**Громкость:** ${'▰'.repeat(Math.round(queue.volume / 10))}${'▱'.repeat(10 - Math.round(queue.volume / 10))} ${queue.volume}%`,
      `**Повтор:** ${loops[queue.repeatMode] || 'Выкл'}  •  **В очереди:** ${queue.tracks.size}`,
    ].join('\n'))
    .setThumbnail(track.thumbnail)
    .setFooter({ text: `Запросил: ${track.requestedBy?.username || '?'} • SoundForge` })
    .setTimestamp();
}

function playerButtons(paused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('p_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(paused ? 'p_res' : 'p_pau').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('p_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('p_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('p_save').setEmoji('💾').setStyle(ButtonStyle.Success),
  );
}

function playerButtons2() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('p_vd').setLabel('-10').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('p_vu').setLabel('+10').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('p_shuf').setLabel('Микс').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('p_loop').setLabel('Повтор').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('p_q').setLabel('Очередь').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  );
}

// ═══ ОБРАБОТКА КНОПОК ═══
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isButton()) return;
  if (!int.member?.voice?.channel) return int.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });

  try {
    // Direct player buttons
    if (int.customId.startsWith('d_')) {
      const dp = directPlayers.get(int.guild.id);
      if (!dp) return int.reply({ content: '❌ Ничего не играет', ephemeral: true });

      if (int.customId === 'd_pau') {
        if (dp.paused) { dp.player.unpause(); dp.paused = false; }
        else { dp.player.pause(); dp.paused = true; }
        return int.update({ embeds: [makeDirectEmbed(dp)], components: [makeDirectButtons(dp.paused)] });
      }
      if (int.customId === 'd_stop') {
        dp.player.stop(true); dp.connection.destroy(); directPlayers.delete(int.guild.id);
        return int.update({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('⏹️ Остановлено')], components: [] });
      }
      if (int.customId === 'd_vd') {
        dp.volume = Math.max(0, dp.volume - 10);
        dp.resource.volume?.setVolume(dp.volume / 100);
        return int.update({ embeds: [makeDirectEmbed(dp)], components: [makeDirectButtons(dp.paused)] });
      }
      if (int.customId === 'd_vu') {
        dp.volume = Math.min(100, dp.volume + 10);
        dp.resource.volume?.setVolume(dp.volume / 100);
        return int.update({ embeds: [makeDirectEmbed(dp)], components: [makeDirectButtons(dp.paused)] });
      }
      if (int.customId === 'd_save') {
        if (!dbOk) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
        await SavedTrack.create({ guildId: int.guild.id, title: dp.title, artist: dp.user, url: dp.url, addedBy: int.user.username, source: 'direct' });
        return int.reply({ content: `💾 Сохранено: **${dp.title}**`, ephemeral: true });
      }
    }

    // Discord-player buttons
    if (int.customId.startsWith('p_')) {
      const queue = player.getQueue(int.guild.id);
      if (!queue) return int.reply({ content: '❌ Нет очереди', ephemeral: true });

      if (int.customId === 'p_pau') { queue.setPaused(true); return int.update({ embeds: [npEmbed(queue.current, queue)], components: [playerButtons(true), playerButtons2()] }); }
      if (int.customId === 'p_res') { queue.setPaused(false); return int.update({ embeds: [npEmbed(queue.current, queue)], components: [playerButtons(false), playerButtons2()] }); }
      if (int.customId === 'p_skip') { queue.skip(); return int.reply({ content: '⏭️ Пропущено', ephemeral: true }); }
      if (int.customId === 'p_prev') { try { await queue.back(); return int.reply({ content: '⏮️ Назад', ephemeral: true }); } catch { return int.reply({ content: '❌ История пуста', ephemeral: true }); } }
      if (int.customId === 'p_stop') { queue.destroy(); return int.update({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('⏹️ Остановлено')], components: [] }); }
      if (int.customId === 'p_vd') { queue.setVolume(Math.max(0, queue.volume - 10)); return int.update({ embeds: [npEmbed(queue.current, queue)], components: [playerButtons(false), playerButtons2()] }); }
      if (int.customId === 'p_vu') { queue.setVolume(Math.min(100, queue.volume + 10)); return int.update({ embeds: [npEmbed(queue.current, queue)], components: [playerButtons(false), playerButtons2()] }); }
      if (int.customId === 'p_shuf') { if (queue.tracks.size < 2) return int.reply({ content: '❌ Мало треков', ephemeral: true }); queue.shuffle(); return int.reply({ content: '🔀 Перемешано!', ephemeral: true }); }
      if (int.customId === 'p_loop') { const n = (queue.repeatMode + 1) % 3; queue.setRepeatMode(n); return int.update({ embeds: [npEmbed(queue.current, queue)], components: [playerButtons(false), playerButtons2()] }); }
      if (int.customId === 'p_q') {
        if (!queue.tracks.size) return int.reply({ content: '📭 Очередь пуста', ephemeral: true });
        const list = queue.tracks.map((t, i) => `**${i+1}.** ${t.title} — \`${t.duration}\``).slice(0, 10).join('\n');
        return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📋 Очередь').setDescription(list).setFooter({ text: `Всего: ${queue.tracks.size}` })], ephemeral: true });
      }
      if (int.customId === 'p_save') {
        if (!dbOk) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
        const t = queue.current;
        await SavedTrack.create({ guildId: int.guild.id, title: t.title, artist: t.author, url: t.url, duration: t.duration, addedBy: int.user.username, source: 'search' });
        return int.reply({ content: `💾 **${t.title}** сохранён!`, ephemeral: true });
      }
    }
  } catch (e) {
    console.error('Button:', e.message);
    if (!int.replied && !int.deferred) int.reply({ content: '❌ Ошибка', ephemeral: true }).catch(() => {});
  }
});

// ═══ SLASH КОМАНДЫ ═══
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isChatInputCommand()) return;
  const voice = int.member?.voice?.channel;

  try {
    if (int.commandName === 'play') {
      if (!voice) return int.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });
      const q = int.options.getString('query', true);
      await int.deferReply();

      // Прямая ссылка на аудио
      if (isAudioURL(q)) {
        const title = titleFromURL(q);
        const ok = await playDirect(int.guild, voice, int.channel, q, title, int.user);
        if (ok) return int.followUp({ embeds: [new EmbedBuilder().setColor(0x22c55e).setDescription(`✅ Играю: **${title}**`)] });
        return int.followUp('❌ Не удалось воспроизвести');
      }

      // Любой другой URL — проверяем content-type
      if (q.startsWith('http') && !q.includes('spotify') && !q.includes('soundcloud') && !q.includes('apple')) {
        try {
          const mod = q.startsWith('https') ? require('https') : require('http');
          const ct = await new Promise((res, rej) => {
            mod.get(q, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
              r.destroy(); res(r.headers['content-type'] || '');
            }).on('error', () => res(''));
          });
          if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg')) {
            const title = titleFromURL(q);
            const ok = await playDirect(int.guild, voice, int.channel, q, title, int.user);
            if (ok) return int.followUp({ embeds: [new EmbedBuilder().setColor(0x22c55e).setDescription(`✅ Играю: **${title}**`)] });
          }
        } catch {}
      }

      // Поиск через discord-player
      const res = await player.search(q, { requestedBy: int.user, searchEngine: QueryType.AUTO });
      if (!res || !res.tracks.length) {
        return int.followUp('❌ Не найдено. Попробуй:\n• Прямую ссылку `.mp3`\n• Ссылку Spotify / SoundCloud\n• Другое название');
      }

      const queue = player.createQueue(int.guild, {
        metadata: { channel: int.channel }, volume: 50,
        leaveOnEnd: true, leaveOnEndCooldown: 60000,
        leaveOnEmpty: true, leaveOnEmptyCooldown: 60000
      });
      try { if (!queue.connection) await queue.connect(voice); }
      catch { queue.destroy(); return int.followUp('❌ Не подключиться'); }

      res.playlist ? queue.addTracks(res.tracks) : queue.addTrack(res.tracks[0]);
      if (!queue.playing) await queue.play();

      const embed = new EmbedBuilder().setColor(0x22c55e);
      if (res.playlist) embed.setDescription(`✅ **${res.playlist.title}** — ${res.tracks.length} треков`);
      else embed.setDescription(`✅ **${res.tracks[0].title}** — ${res.tracks[0].author}`).setThumbnail(res.tracks[0].thumbnail);
      return int.followUp({ embeds: [embed] });
    }

    if (int.commandName === 'np') {
      const dp = directPlayers.get(int.guild.id);
      if (dp) return int.reply({ embeds: [makeDirectEmbed(dp)], components: [makeDirectButtons(dp.paused)] });
      const queue = player.getQueue(int.guild.id);
      if (!queue?.current) return int.reply({ content: '❌ Ничего не играет', ephemeral: true });
      return int.reply({ embeds: [npEmbed(queue.current, queue)], components: [playerButtons(false), playerButtons2()] });
    }

    if (int.commandName === 'skip') { const q = player.getQueue(int.guild.id); if (!q?.playing) return int.reply({ content: '❌', ephemeral: true }); q.skip(); return int.reply('⏭️ Пропущено'); }
    if (int.commandName === 'stop') {
      const dp = directPlayers.get(int.guild.id);
      if (dp) { dp.player.stop(true); dp.connection.destroy(); directPlayers.delete(int.guild.id); }
      const q = player.getQueue(int.guild.id); if (q) q.destroy();
      return int.reply('⏹️ Остановлено');
    }
    if (int.commandName === 'pause') { const q = player.getQueue(int.guild.id); if (!q?.playing) return int.reply({ content: '❌', ephemeral: true }); q.setPaused(true); return int.reply('⏸️'); }
    if (int.commandName === 'resume') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); q.setPaused(false); return int.reply('▶️'); }
    if (int.commandName === 'queue') {
      const q = player.getQueue(int.guild.id);
      if (!q || !q.tracks.size) return int.reply({ content: '📭 Пуста', ephemeral: true });
      return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📋 Очередь').setDescription(`**Сейчас:** ${q.current.title}\n\n${q.tracks.map((t,i)=>`**${i+1}.** ${t.title}`).slice(0,15).join('\n')}`)] });
    }
    if (int.commandName === 'volume') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); q.setVolume(int.options.getInteger('level', true)); return int.reply(`🔊 ${q.volume}%`); }
    if (int.commandName === 'shuffle') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); q.shuffle(); return int.reply('🔀'); }
    if (int.commandName === 'loop') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); const m=int.options.getString('mode',true); q.setRepeatMode({off:0,track:1,queue:2}[m]); return int.reply(`🔁 ${{off:'Выкл',track:'Трек',queue:'Очередь'}[m]}`); }
    if (int.commandName === 'library') {
      if (!dbOk) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
      const saved = await SavedTrack.find({ guildId: int.guild.id }).sort({ addedAt: -1 }).limit(20);
      if (!saved.length) return int.reply({ content: '📭 Библиотека пуста. Нажми 💾 чтобы сохранить трек.', ephemeral: true });
      return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📚 Библиотека').setDescription(saved.map((t,i)=>`**${i+1}.** ${t.title}`).join('\n')).setFooter({text:`${saved.length} треков`})], ephemeral: true });
    }
    if (int.commandName === 'playlib') {
      if (!voice) return int.reply({ content: '❌ Зайди в канал', ephemeral: true });
      if (!dbOk) return int.reply({ content: '❌ БД нет', ephemeral: true });
      const n = int.options.getInteger('number', true);
      const saved = await SavedTrack.find({ guildId: int.guild.id }).sort({ addedAt: -1 });
      if (n<1||n>saved.length) return int.reply({ content: `❌ 1-${saved.length}`, ephemeral: true });
      const t = saved[n-1]; if (!t.url) return int.reply({ content: '❌ Нет URL', ephemeral: true });
      await int.deferReply();
      if (isAudioURL(t.url)) { const ok = await playDirect(int.guild, voice, int.channel, t.url, t.title, int.user); if (ok) return int.followUp(`▶️ **${t.title}**`); return int.followUp('❌'); }
      const res = await player.search(t.url, { requestedBy: int.user });
      if (!res?.tracks?.length) return int.followUp('❌');
      const queue = player.createQueue(int.guild, { metadata: { channel: int.channel }, volume: 50 });
      try { if (!queue.connection) await queue.connect(voice); } catch { queue.destroy(); return int.followUp('❌'); }
      queue.addTrack(res.tracks[0]); if (!queue.playing) await queue.play();
      return int.followUp(`▶️ **${t.title}**`);
    }
  } catch (e) {
    console.error('Cmd:', e.message);
    const r = { content: `❌ ${e.message}`, ephemeral: true };
    if (int.replied||int.deferred) int.followUp(r).catch(()=>{}); else int.reply(r).catch(()=>{});
  }
});

// ═══ СОБЫТИЯ ═══
player.on('trackStart', (queue, track) => {
  queue.metadata.channel.send({ embeds: [npEmbed(track, queue)], components: [playerButtons(false), playerButtons2()] });
});
player.on('queueEnd', (queue) => {
  queue.metadata.channel.send({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('📭 Очередь закончилась')] });
});
player.on('error', (q, e) => console.error('Error:', e.message));
player.on('connectionError', (q, e) => console.error('ConnErr:', e.message));

// ═══ СТАРТ ═══
client.once(Events.ClientReady, async (c) => {
  console.log(`\n♫ ${c.user.tag} ОНЛАЙН | Серверов: ${c.guilds.cache.size} | MongoDB: ${dbOk?'✅':'❌'}\n`);
  c.user.setActivity('музыку | /play', { type: ActivityType.Listening });

  const cmds = [
    new SlashCommandBuilder().setName('play').setDescription('▶️ Воспроизвести (URL, Spotify, SoundCloud, название)').addStringOption(o=>o.setName('query').setDescription('Ссылка или название').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('♫ Плеер с управлением'),
    new SlashCommandBuilder().setName('skip').setDescription('⏭️ Пропустить'),
    new SlashCommandBuilder().setName('stop').setDescription('⏹️ Стоп'),
    new SlashCommandBuilder().setName('pause').setDescription('⏸️ Пауза'),
    new SlashCommandBuilder().setName('resume').setDescription('▶️ Продолжить'),
    new SlashCommandBuilder().setName('queue').setDescription('📋 Очередь'),
    new SlashCommandBuilder().setName('volume').setDescription('🔊 Громкость').addIntegerOption(o=>o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('🔀 Перемешать'),
    new SlashCommandBuilder().setName('loop').setDescription('🔁 Повтор').addStringOption(o=>o.setName('mode').setDescription('Режим').setRequired(true).addChoices({name:'Выкл',value:'off'},{name:'Трек',value:'track'},{name:'Очередь',value:'queue'})),
    new SlashCommandBuilder().setName('library').setDescription('📚 Библиотека'),
    new SlashCommandBuilder().setName('playlib').setDescription('▶️ Из библиотеки').addIntegerOption(o=>o.setName('number').setDescription('Номер').setRequired(true).setMinValue(1)),
  ].map(c => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
    console.log('✅ 12 команд');
  } catch (e) { console.error('Reg:', e.message); }
});

client.login(TOKEN);
