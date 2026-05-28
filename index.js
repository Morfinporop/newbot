const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, REST, Routes, SlashCommandBuilder
} = require('discord.js');
const { Player, QueryType } = require('discord-player');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const mongoose = require('mongoose');
const fetch = require('node-fetch');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MONGO = process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL;

if (!TOKEN) { console.error('DISCORD_TOKEN не задан!'); process.exit(1); }

// ═══ БД ═══
const trackSchema = new mongoose.Schema({
  guildId: String, title: String, artist: String,
  url: String, duration: String, addedBy: String,
  source: { type: String, default: 'url' },
  addedAt: { type: Date, default: Date.now }
});
const SavedTrack = mongoose.model('SavedTrack', trackSchema);

let dbOk = false;
if (MONGO) {
  mongoose.connect(MONGO, { dbName: 'soundforge' })
    .then(() => { dbOk = true; console.log('✅ MongoDB подключена'); })
    .catch(e => console.error('MongoDB:', e.message));
} else {
  console.log('⚠️ MongoDB не задана');
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

// Регистрация экстракторов вручную
const { SpotifyExtractor, SoundCloudExtractor, AppleMusicExtractor, AttachmentExtractor } = require('@discord-player/extractor');
player.extractors.register(SpotifyExtractor, {});
player.extractors.register(SoundCloudExtractor, {});
player.extractors.register(AppleMusicExtractor, {});
player.extractors.register(AttachmentExtractor, {});
console.log('✅ Экстракторы: Spotify, SoundCloud, AppleMusic, Attachment');

// ═══ ПРЯМАЯ ССЫЛКА — воспроизведение MP3/URL напрямую ═══
const directPlayers = new Map(); // guildId -> { connection, player, current }

async function playDirectURL(guild, voiceChannel, textChannel, url, title, user) {
  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });

    const audioPlayer = createAudioPlayer();
    const resource = createAudioResource(url);
    audioPlayer.play(resource);
    connection.subscribe(audioPlayer);

    directPlayers.set(guild.id, { connection, player: audioPlayer, current: { title, url, author: user.username } });

    const embed = new EmbedBuilder()
      .setColor(0x06b6d4)
      .setAuthor({ name: '♫ Воспроизводится' })
      .setTitle(title || 'Прямая ссылка')
      .setDescription(`Запросил: **${user.username}**`)
      .setFooter({ text: url.length > 60 ? url.slice(0, 60) + '...' : url });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('d_stop').setEmoji('⏹️').setLabel('Стоп').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('d_save').setEmoji('💾').setLabel('Сохранить').setStyle(ButtonStyle.Success),
    );

    textChannel.send({ embeds: [embed], components: [row] });

    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      connection.destroy();
      directPlayers.delete(guild.id);
    });

    audioPlayer.on('error', (err) => {
      console.error('Direct play error:', err);
      textChannel.send('❌ Ошибка воспроизведения ссылки');
      connection.destroy();
      directPlayers.delete(guild.id);
    });

    return true;
  } catch (e) {
    console.error('Direct URL error:', e);
    return false;
  }
}

// Проверка — это прямая ссылка на аудио?
function isDirectAudioURL(url) {
  if (!url.startsWith('http')) return false;
  const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm'];
  const lower = url.toLowerCase().split('?')[0];
  return audioExts.some(ext => lower.endsWith(ext));
}

// ═══ КНОПКИ ═══
function btns(paused) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('b_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(paused ? 'b_res' : 'b_pau').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('b_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('b_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('b_q').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  ), new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('b_shuf').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('b_loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('b_vd').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('b_vu').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('b_save').setEmoji('💾').setStyle(ButtonStyle.Success),
  )];
}

function npEmbed(track, queue) {
  const bar = queue.createProgressBar({ timecodes: true, length: 14 });
  const loops = { 0: 'Выкл', 1: 'Трек', 2: 'Очередь', 3: 'Авто' };
  return new EmbedBuilder()
    .setColor(0x06b6d4)
    .setAuthor({ name: '♫ Сейчас играет' })
    .setTitle(track.title)
    .setURL(track.url || null)
    .setDescription(`**${track.author}**\n\n${bar}`)
    .setThumbnail(track.thumbnail)
    .addFields(
      { name: '⏱', value: track.duration || '?', inline: true },
      { name: '🔊', value: `${queue.volume}%`, inline: true },
      { name: '🔁', value: loops[queue.repeatMode] || 'Выкл', inline: true },
      { name: '📋', value: `${queue.tracks.size}`, inline: true },
    )
    .setFooter({ text: track.requestedBy ? track.requestedBy.username : '' });
}

// ═══ КНОПКИ ОБРАБОТКА ═══
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isButton()) return;

  // Кнопки для прямых ссылок
  if (int.customId === 'd_stop') {
    const dp = directPlayers.get(int.guild.id);
    if (dp) { dp.player.stop(); dp.connection.destroy(); directPlayers.delete(int.guild.id); }
    return int.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setDescription('⏹️ Остановлено')], components: [] });
  }
  if (int.customId === 'd_save') {
    const dp = directPlayers.get(int.guild.id);
    if (!dp?.current) return int.reply({ content: '❌ Нечего сохранять', ephemeral: true });
    if (!dbOk) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
    await SavedTrack.create({ guildId: int.guild.id, title: dp.current.title, artist: dp.current.author, url: dp.current.url, addedBy: int.user.username, source: 'direct' });
    return int.reply({ content: `💾 Сохранено: **${dp.current.title}**`, ephemeral: true });
  }

  if (!int.customId.startsWith('b_')) return;
  const queue = player.getQueue(int.guild.id);
  if (!int.member?.voice?.channel) return int.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });

  try {
    const a = int.customId.slice(2);
    if (a === 'pau') { if (!queue?.playing) return int.reply({ content: '❌ Ничего не играет', ephemeral: true }); queue.setPaused(true); return int.update({ embeds: [npEmbed(queue.current, queue)], components: btns(true) }); }
    if (a === 'res') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); queue.setPaused(false); return int.update({ embeds: [npEmbed(queue.current, queue)], components: btns(false) }); }
    if (a === 'skip') { if (!queue?.playing) return int.reply({ content: '❌ Нечего', ephemeral: true }); queue.skip(); return int.reply({ content: '⏭️ Пропущено', ephemeral: true }); }
    if (a === 'prev') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); try { await queue.back(); return int.reply({ content: '⏮️ Назад', ephemeral: true }); } catch { return int.reply({ content: '❌ История пуста', ephemeral: true }); } }
    if (a === 'stop') { if (!queue) return int.reply({ content: '❌ Уже', ephemeral: true }); queue.destroy(); return int.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setDescription('⏹️ Остановлено')], components: [] }); }
    if (a === 'shuf') { if (!queue || queue.tracks.size < 2) return int.reply({ content: '❌ Мало треков', ephemeral: true }); queue.shuffle(); return int.reply({ content: '🔀 Перемешано!', ephemeral: true }); }
    if (a === 'loop') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); const n = (queue.repeatMode + 1) % 3; queue.setRepeatMode(n); return int.reply({ content: `🔁 ${['Выкл','Трек','Очередь'][n]}`, ephemeral: true }); }
    if (a === 'vd') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); queue.setVolume(Math.max(0, queue.volume - 10)); return int.reply({ content: `🔉 ${queue.volume}%`, ephemeral: true }); }
    if (a === 'vu') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); queue.setVolume(Math.min(100, queue.volume + 10)); return int.reply({ content: `🔊 ${queue.volume}%`, ephemeral: true }); }
    if (a === 'save') {
      if (!queue?.current) return int.reply({ content: '❌ Нечего', ephemeral: true });
      if (!dbOk) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
      const t = queue.current;
      await SavedTrack.create({ guildId: int.guild.id, title: t.title, artist: t.author, url: t.url, duration: t.duration, addedBy: int.user.username, source: 'search' });
      return int.reply({ content: `💾 **${t.title}** сохранён!`, ephemeral: true });
    }
  } catch (e) { console.error('Button:', e); if (!int.replied && !int.deferred) int.reply({ content: '❌ Ошибка', ephemeral: true }); }
});

// ═══ SLASH КОМАНДЫ ═══
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isChatInputCommand()) return;
  const voice = int.member?.voice?.channel;

  try {
    // /play — главная команда
    if (int.commandName === 'play') {
      if (!voice) return int.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });
      const q = int.options.getString('query', true);
      await int.deferReply();

      // 1. Проверяем — это прямая ссылка на аудиофайл?
      if (isDirectAudioURL(q)) {
        const filename = decodeURIComponent(q.split('/').pop().split('?')[0]).replace(/[_-]/g, ' ').replace(/\.\w+$/, '');
        const ok = await playDirectURL(int.guild, voice, int.channel, q, filename, int.user);
        if (ok) return int.followUp({ content: `▶️ Играю: **${filename}**` });
        return int.followUp('❌ Не удалось воспроизвести ссылку');
      }

      // 2. Если URL но не аудиофайл — тоже пробуем как direct
      if (q.startsWith('http') && !q.includes('spotify') && !q.includes('soundcloud') && !q.includes('apple')) {
        try {
          const head = await fetch(q, { method: 'HEAD', timeout: 5000 });
          const ct = head.headers.get('content-type') || '';
          if (ct.includes('audio') || ct.includes('mpeg') || ct.includes('ogg')) {
            const filename = decodeURIComponent(q.split('/').pop().split('?')[0]).replace(/[_-]/g, ' ').replace(/\.\w+$/, '');
            const ok = await playDirectURL(int.guild, voice, int.channel, q, filename, int.user);
            if (ok) return int.followUp({ content: `▶️ Играю: **${filename}**` });
          }
        } catch {}
      }

      // 3. Поиск через discord-player (Spotify, SoundCloud, Apple Music)
      const res = await player.search(q, { requestedBy: int.user, searchEngine: QueryType.AUTO });

      if (!res || !res.tracks.length) {
        return int.followUp('❌ Не найдено. Попробуй:\n• Прямую ссылку на MP3\n• Ссылку Spotify/SoundCloud\n• Другое название');
      }

      const queue = player.createQueue(int.guild, {
        metadata: { channel: int.channel },
        volume: 50, leaveOnEnd: true, leaveOnEndCooldown: 60000,
        leaveOnEmpty: true, leaveOnEmptyCooldown: 60000
      });

      try { if (!queue.connection) await queue.connect(voice); }
      catch { queue.destroy(); return int.followUp('❌ Не могу подключиться'); }

      res.playlist ? queue.addTracks(res.tracks) : queue.addTrack(res.tracks[0]);
      if (!queue.playing) await queue.play();

      const embed = new EmbedBuilder().setColor(0x22c55e);
      if (res.playlist) embed.setDescription(`✅ **${res.playlist.title}** — ${res.tracks.length} треков`);
      else embed.setDescription(`✅ **${res.tracks[0].title}** — ${res.tracks[0].author}`).setThumbnail(res.tracks[0].thumbnail);
      return int.followUp({ embeds: [embed] });
    }

    if (int.commandName === 'np') {
      const queue = player.getQueue(int.guild.id);
      // Проверяем и direct player
      const dp = directPlayers.get(int.guild.id);
      if (dp?.current) {
        const embed = new EmbedBuilder().setColor(0x06b6d4).setTitle(dp.current.title).setDescription(`Запросил: ${dp.current.author}`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('d_stop').setEmoji('⏹️').setLabel('Стоп').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('d_save').setEmoji('💾').setLabel('Сохранить').setStyle(ButtonStyle.Success),
        );
        return int.reply({ embeds: [embed], components: [row] });
      }
      if (!queue?.current) return int.reply({ content: '❌ Ничего не играет', ephemeral: true });
      return int.reply({ embeds: [npEmbed(queue.current, queue)], components: btns(false) });
    }

    if (int.commandName === 'skip') { const q = player.getQueue(int.guild.id); if (!q?.playing) return int.reply({ content: '❌', ephemeral: true }); q.skip(); return int.reply('⏭️ Пропущено'); }
    if (int.commandName === 'stop') {
      const q = player.getQueue(int.guild.id);
      const dp = directPlayers.get(int.guild.id);
      if (dp) { dp.player.stop(); dp.connection.destroy(); directPlayers.delete(int.guild.id); }
      if (q) q.destroy();
      return int.reply('⏹️ Остановлено');
    }
    if (int.commandName === 'pause') { const q = player.getQueue(int.guild.id); if (!q?.playing) return int.reply({ content: '❌', ephemeral: true }); q.setPaused(true); return int.reply('⏸️'); }
    if (int.commandName === 'resume') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); q.setPaused(false); return int.reply('▶️'); }
    if (int.commandName === 'queue') {
      const q = player.getQueue(int.guild.id);
      if (!q || !q.tracks.size) return int.reply({ content: '📭 Очередь пуста', ephemeral: true });
      const list = q.tracks.map((t, i) => `**${i+1}.** ${t.title} — \`${t.duration}\``).slice(0,15).join('\n');
      return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📋 Очередь').setDescription(`**Сейчас:** ${q.current.title}\n\n${list}`)] });
    }
    if (int.commandName === 'volume') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); q.setVolume(int.options.getInteger('level',true)); return int.reply(`🔊 ${q.volume}%`); }
    if (int.commandName === 'shuffle') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); q.shuffle(); return int.reply('🔀'); }
    if (int.commandName === 'loop') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌', ephemeral: true }); const m = int.options.getString('mode',true); q.setRepeatMode({off:0,track:1,queue:2}[m]); return int.reply(`🔁 ${{off:'Выкл',track:'Трек',queue:'Очередь'}[m]}`); }

    if (int.commandName === 'library') {
      if (!dbOk) return int.reply({ content: '❌ БД не подключена. Свяжи MongoDB с ботом на Railway.', ephemeral: true });
      const saved = await SavedTrack.find({ guildId: int.guild.id }).sort({ addedAt: -1 }).limit(20);
      if (!saved.length) return int.reply({ content: '📭 Библиотека пуста.\nВоспроизведи трек → нажми 💾 → он сохранится.', ephemeral: true });
      const list = saved.map((t, i) => `**${i+1}.** ${t.title} ${t.artist !== t.title ? `— *${t.artist}*` : ''}`).join('\n');
      return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📚 Библиотека').setDescription(list).setFooter({ text: `${saved.length} треков` })], ephemeral: true });
    }

    if (int.commandName === 'playlib') {
      if (!voice) return int.reply({ content: '❌ Зайди в канал', ephemeral: true });
      if (!dbOk) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
      const n = int.options.getInteger('number',true);
      const saved = await SavedTrack.find({ guildId: int.guild.id }).sort({ addedAt: -1 });
      if (n < 1 || n > saved.length) return int.reply({ content: `❌ Номер 1-${saved.length}`, ephemeral: true });
      const t = saved[n-1]; if (!t.url) return int.reply({ content: '❌ Нет URL', ephemeral: true });
      await int.deferReply();

      // Прямая ссылка?
      if (isDirectAudioURL(t.url)) {
        const ok = await playDirectURL(int.guild, voice, int.channel, t.url, t.title, int.user);
        if (ok) return int.followUp(`▶️ **${t.title}**`);
        return int.followUp('❌ Не удалось');
      }

      const res = await player.search(t.url, { requestedBy: int.user });
      if (!res?.tracks?.length) return int.followUp('❌ Не найдено');
      const queue = player.createQueue(int.guild, { metadata: { channel: int.channel }, volume: 50 });
      try { if (!queue.connection) await queue.connect(voice); } catch { queue.destroy(); return int.followUp('❌'); }
      queue.addTrack(res.tracks[0]); if (!queue.playing) await queue.play();
      return int.followUp(`▶️ **${t.title}**`);
    }

  } catch (e) {
    console.error('Cmd:', e);
    const r = { content: `❌ ${e.message}`, ephemeral: true };
    if (int.replied || int.deferred) int.followUp(r); else int.reply(r);
  }
});

// ═══ СОБЫТИЯ ═══
player.on('trackStart', (queue, track) => {
  queue.metadata.channel.send({ embeds: [npEmbed(track, queue)], components: btns(false) });
});
player.on('queueEnd', (queue) => {
  queue.metadata.channel.send({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('📭 Очередь закончилась')] });
});
player.on('error', (q, e) => console.error('player error:', e));
player.on('connectionError', (q, e) => console.error('conn error:', e));

// ═══ СТАРТ ═══
client.once(Events.ClientReady, async (c) => {
  console.log('');
  console.log('═══════════════════════════════════');
  console.log(`  ♫ ${c.user.tag} ОНЛАЙН`);
  console.log(`  Серверов: ${c.guilds.cache.size}`);
  console.log(`  MongoDB: ${dbOk ? '✅' : '❌'}`);
  console.log('═══════════════════════════════════');

  c.user.setActivity('музыку | /play', { type: ActivityType.Listening });

  const cmds = [
    new SlashCommandBuilder().setName('play').setDescription('▶️ Воспроизвести (название, URL, ссылка на MP3)').addStringOption(o => o.setName('query').setDescription('Название или прямая ссылка на MP3').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('♫ Текущий трек + кнопки'),
    new SlashCommandBuilder().setName('skip').setDescription('⏭️ Пропустить'),
    new SlashCommandBuilder().setName('stop').setDescription('⏹️ Остановить'),
    new SlashCommandBuilder().setName('pause').setDescription('⏸️ Пауза'),
    new SlashCommandBuilder().setName('resume').setDescription('▶️ Продолжить'),
    new SlashCommandBuilder().setName('queue').setDescription('📋 Очередь'),
    new SlashCommandBuilder().setName('volume').setDescription('🔊 Громкость').addIntegerOption(o => o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('🔀 Перемешать'),
    new SlashCommandBuilder().setName('loop').setDescription('🔁 Повтор').addStringOption(o => o.setName('mode').setDescription('Режим').setRequired(true).addChoices({name:'Выкл',value:'off'},{name:'Трек',value:'track'},{name:'Очередь',value:'queue'})),
    new SlashCommandBuilder().setName('library').setDescription('📚 Сохранённые треки'),
    new SlashCommandBuilder().setName('playlib').setDescription('▶️ Из библиотеки').addIntegerOption(o => o.setName('number').setDescription('Номер').setRequired(true).setMinValue(1)),
  ].map(c => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
    console.log('✅ 12 команд зарегистрированы');
  } catch (e) { console.error('Регистрация:', e.message); }
});

client.login(TOKEN);
