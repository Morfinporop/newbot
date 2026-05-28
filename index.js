const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, REST, Routes, SlashCommandBuilder
} = require('discord.js');
const { Player, QueryType } = require('discord-player');
const mongoose = require('mongoose');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MONGO = process.env.MONGODB_URI || process.env.MONGO_URL;

if (!TOKEN) { console.error('DISCORD_TOKEN не найден!'); process.exit(1); }

// ═══ БАЗА ДАННЫХ ═══
const trackSchema = new mongoose.Schema({
  guildId: String, title: String, artist: String,
  url: String, duration: String, addedBy: String,
  addedAt: { type: Date, default: Date.now }
});
const SavedTrack = mongoose.model('SavedTrack', trackSchema);

if (MONGO) {
  mongoose.connect(MONGO).then(() => console.log('DB подключена')).catch(e => console.error('DB ошибка:', e.message));
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

const player = new Player(client, { ytdlOptions: { quality: 'highestaudio' } });
player.extractors.loadDefault();

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
      { name: '⏱', value: track.duration, inline: true },
      { name: '🔊', value: `${queue.volume}%`, inline: true },
      { name: '🔁', value: loops[queue.repeatMode] || 'Выкл', inline: true },
      { name: '📋', value: `${queue.tracks.size}`, inline: true },
    )
    .setFooter({ text: track.requestedBy ? `${track.requestedBy.username}` : '' });
}

// ═══ КНОПКИ ОБРАБОТКА ═══
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isButton() || !int.customId.startsWith('b_')) return;
  const queue = player.getQueue(int.guild.id);
  if (!int.member?.voice?.channel) return int.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });

  try {
    const a = int.customId.slice(2);
    if (a === 'pau') { if (!queue?.playing) return int.reply({ content: '❌ Ничего не играет', ephemeral: true }); queue.setPaused(true); return int.update({ embeds: [npEmbed(queue.current, queue)], components: btns(true) }); }
    if (a === 'res') { if (!queue) return int.reply({ content: '❌ Нет очереди', ephemeral: true }); queue.setPaused(false); return int.update({ embeds: [npEmbed(queue.current, queue)], components: btns(false) }); }
    if (a === 'skip') { if (!queue?.playing) return int.reply({ content: '❌ Нечего', ephemeral: true }); queue.skip(); return int.reply({ content: '⏭️ Пропущено', ephemeral: true }); }
    if (a === 'prev') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); await queue.back(); return int.reply({ content: '⏮️ Назад', ephemeral: true }); }
    if (a === 'stop') { if (!queue) return int.reply({ content: '❌ Уже', ephemeral: true }); queue.destroy(); return int.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setDescription('⏹️ Остановлено')], components: [] }); }
    if (a === 'shuf') { if (!queue || queue.tracks.size < 2) return int.reply({ content: '❌ Мало треков', ephemeral: true }); queue.shuffle(); return int.reply({ content: '🔀 Перемешано!', ephemeral: true }); }
    if (a === 'loop') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); const n = (queue.repeatMode + 1) % 3; queue.setRepeatMode(n); return int.reply({ content: `🔁 Повтор: **${['Выкл','Трек','Очередь'][n]}**`, ephemeral: true }); }
    if (a === 'vd') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); queue.setVolume(Math.max(0, queue.volume - 10)); return int.reply({ content: `🔉 ${queue.volume}%`, ephemeral: true }); }
    if (a === 'vu') { if (!queue) return int.reply({ content: '❌ Нет', ephemeral: true }); queue.setVolume(Math.min(100, queue.volume + 10)); return int.reply({ content: `🔊 ${queue.volume}%`, ephemeral: true }); }
    if (a === 'save') {
      if (!queue?.current) return int.reply({ content: '❌ Нечего', ephemeral: true });
      if (!MONGO) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
      const t = queue.current;
      await SavedTrack.create({ guildId: int.guild.id, title: t.title, artist: t.author, url: t.url, duration: t.duration, addedBy: int.user.username });
      return int.reply({ content: `💾 **${t.title}** сохранён!`, ephemeral: true });
    }
  } catch (e) { console.error(e); if (!int.replied) int.reply({ content: '❌ Ошибка', ephemeral: true }); }
});

// ═══ КОМАНДЫ ═══
client.on(Events.InteractionCreate, async (int) => {
  if (!int.isChatInputCommand()) return;
  const voice = int.member?.voice?.channel;

  try {
    if (int.commandName === 'play') {
      if (!voice) return int.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });
      await int.deferReply();
      const q = int.options.getString('query', true);
      const res = await player.search(q, { requestedBy: int.user, searchEngine: QueryType.AUTO });
      if (!res || !res.tracks.length) return int.followUp('❌ Ничего не найдено');

      const queue = player.createQueue(int.guild, { metadata: { channel: int.channel }, volume: 50, leaveOnEnd: true, leaveOnEndCooldown: 60000 });
      try { if (!queue.connection) await queue.connect(voice); } catch { queue.destroy(); return int.followUp('❌ Не могу подключиться'); }

      res.playlist ? queue.addTracks(res.tracks) : queue.addTrack(res.tracks[0]);
      if (!queue.playing) await queue.play();

      const embed = new EmbedBuilder().setColor(0x22c55e).setDescription(`✅ **${res.playlist ? res.playlist.title + ` (${res.tracks.length} треков)` : res.tracks[0].title}**`).setThumbnail(res.tracks[0].thumbnail);
      return int.followUp({ embeds: [embed] });
    }

    if (int.commandName === 'np') {
      const queue = player.getQueue(int.guild.id);
      if (!queue?.current) return int.reply({ content: '❌ Ничего не играет', ephemeral: true });
      return int.reply({ embeds: [npEmbed(queue.current, queue)], components: btns(queue.connection?.paused) });
    }

    if (int.commandName === 'skip') { const q = player.getQueue(int.guild.id); if (!q?.playing) return int.reply({ content: '❌ Ничего', ephemeral: true }); q.skip(); return int.reply('⏭️ Пропущено'); }
    if (int.commandName === 'stop') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌ Нет', ephemeral: true }); q.destroy(); return int.reply('⏹️ Остановлено'); }
    if (int.commandName === 'pause') { const q = player.getQueue(int.guild.id); if (!q?.playing) return int.reply({ content: '❌ Ничего', ephemeral: true }); q.setPaused(true); return int.reply('⏸️ Пауза'); }
    if (int.commandName === 'resume') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌ Нет', ephemeral: true }); q.setPaused(false); return int.reply('▶️ Продолжено'); }
    if (int.commandName === 'queue') {
      const q = player.getQueue(int.guild.id);
      if (!q || !q.tracks.size) return int.reply({ content: '📭 Очередь пуста', ephemeral: true });
      const list = q.tracks.map((t, i) => `**${i+1}.** ${t.title} — \`${t.duration}\``).slice(0,15).join('\n');
      return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📋 Очередь').setDescription(`**Сейчас:** ${q.current.title}\n\n${list}`)] });
    }
    if (int.commandName === 'volume') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌ Нет', ephemeral: true }); const v = int.options.getInteger('level', true); q.setVolume(v); return int.reply(`🔊 Громкость: **${v}%**`); }
    if (int.commandName === 'shuffle') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌ Нет', ephemeral: true }); q.shuffle(); return int.reply('🔀 Перемешано!'); }
    if (int.commandName === 'loop') { const q = player.getQueue(int.guild.id); if (!q) return int.reply({ content: '❌ Нет', ephemeral: true }); const m = int.options.getString('mode', true); const map = { off:0, track:1, queue:2 }; q.setRepeatMode(map[m]); return int.reply(`🔁 Повтор: **${m==='off'?'Выкл':m==='track'?'Трек':'Очередь'}**`); }
    if (int.commandName === 'library') {
      if (!MONGO) return int.reply({ content: '❌ БД не подключена', ephemeral: true });
      const saved = await SavedTrack.find({ guildId: int.guild.id }).sort({ addedAt: -1 }).limit(15);
      if (!saved.length) return int.reply({ content: '📭 Пусто. Нажми 💾 чтобы сохранить трек.', ephemeral: true });
      return int.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📚 Библиотека').setDescription(saved.map((t,i) => `**${i+1}.** ${t.title} — *${t.artist}*`).join('\n'))], ephemeral: true });
    }
    if (int.commandName === 'playlib') {
      if (!voice) return int.reply({ content: '❌ Зайди в канал', ephemeral: true });
      if (!MONGO) return int.reply({ content: '❌ БД нет', ephemeral: true });
      const n = int.options.getInteger('number', true);
      const saved = await SavedTrack.find({ guildId: int.guild.id }).sort({ addedAt: -1 });
      if (n < 1 || n > saved.length) return int.reply({ content: `❌ Номер 1-${saved.length}`, ephemeral: true });
      const t = saved[n-1]; if (!t.url) return int.reply({ content: '❌ Нет URL', ephemeral: true });
      await int.deferReply();
      const res = await player.search(t.url, { requestedBy: int.user });
      if (!res?.tracks?.length) return int.followUp('❌ Не найдено');
      const queue = player.createQueue(int.guild, { metadata: { channel: int.channel }, volume: 50 });
      try { if (!queue.connection) await queue.connect(voice); } catch { queue.destroy(); return int.followUp('❌ Нет подключения'); }
      queue.addTrack(res.tracks[0]); if (!queue.playing) await queue.play();
      return int.followUp(`▶️ Из библиотеки: **${t.title}**`);
    }
  } catch (e) { console.error(e); const r = { content: `❌ ${e.message}`, ephemeral: true }; int.replied||int.deferred ? int.followUp(r) : int.reply(r); }
});

// ═══ СОБЫТИЯ ПЛЕЕРА ═══
player.on('trackStart', (queue, track) => {
  queue.metadata.channel.send({ embeds: [npEmbed(track, queue)], components: btns(false) });
});
player.on('queueEnd', (queue) => {
  queue.metadata.channel.send({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('📭 Очередь закончилась')] });
});
player.on('error', (queue, e) => console.error(`[${queue.guild.name}]`, e));

// ═══ ЗАПУСК + РЕГИСТРАЦИЯ КОМАНД ═══
client.once(Events.ClientReady, async (c) => {
  console.log(`\n✅ ${c.user.tag} ОНЛАЙН | Серверов: ${c.guilds.cache.size}\n`);
  c.user.setActivity('музыку | /play', { type: ActivityType.Listening });

  const cmds = [
    new SlashCommandBuilder().setName('play').setDescription('Воспроизвести').addStringOption(o => o.setName('query').setDescription('Название/URL').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('Текущий трек + кнопки'),
    new SlashCommandBuilder().setName('skip').setDescription('Пропустить'),
    new SlashCommandBuilder().setName('stop').setDescription('Остановить'),
    new SlashCommandBuilder().setName('pause').setDescription('Пауза'),
    new SlashCommandBuilder().setName('resume').setDescription('Продолжить'),
    new SlashCommandBuilder().setName('queue').setDescription('Очередь'),
    new SlashCommandBuilder().setName('volume').setDescription('Громкость').addIntegerOption(o => o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('Перемешать'),
    new SlashCommandBuilder().setName('loop').setDescription('Повтор').addStringOption(o => o.setName('mode').setDescription('Режим').setRequired(true).addChoices({name:'Выкл',value:'off'},{name:'Трек',value:'track'},{name:'Очередь',value:'queue'})),
    new SlashCommandBuilder().setName('library').setDescription('Сохранённые треки'),
    new SlashCommandBuilder().setName('playlib').setDescription('Из библиотеки').addIntegerOption(o => o.setName('number').setDescription('Номер').setRequired(true).setMinValue(1)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) { await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds }); console.log('Команды зарегистрированы'); }
    else { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds }); console.log('Команды зарегистрированы глобально'); }
  } catch (e) { console.error('Регистрация команд:', e); }
});

client.login(TOKEN);
