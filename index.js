const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { Player, useQueue, useMainPlayer } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const mongoose = require('mongoose');

// ═══════════════════════════
//  КОНФИГУРАЦИЯ
// ═══════════════════════════
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URL;

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN не найден! Добавь его в Variables на Railway.');
  process.exit(1);
}

// ═══════════════════════════
//  БАЗА ДАННЫХ
// ═══════════════════════════
const trackSchema = new mongoose.Schema({
  guildId: String,
  title: String,
  artist: { type: String, default: 'Неизвестен' },
  url: String,
  duration: String,
  addedBy: String,
  addedAt: { type: Date, default: Date.now }
});

const TrackModel = mongoose.model('Track', trackSchema);

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB подключена'))
    .catch(err => console.error('❌ MongoDB ошибка:', err.message));
} else {
  console.log('⚠️ MONGODB_URI не задан — БД отключена, бот работает без сохранения');
}

// ═══════════════════════════
//  DISCORD КЛИЕНТ
// ═══════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const player = new Player(client);
player.extractors.loadMulti(DefaultExtractors);

// ═══════════════════════════
//  КНОПКИ УПРАВЛЕНИЯ
// ═══════════════════════════
function makeButtons(paused) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sf_prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(paused ? 'sf_resume' : 'sf_pause').setEmoji(paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sf_skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('sf_queue').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  ), new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sf_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf_loop').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf_voldown').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf_volup').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sf_save').setEmoji('💾').setStyle(ButtonStyle.Success),
  )];
}

function nowPlayingEmbed(track, queue) {
  const bar = queue.node.createProgressBar({ timecodes: true, length: 14 });
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
      { name: '🔊', value: `${queue.node.volume}%`, inline: true },
      { name: '🔁', value: loops[queue.repeatMode] || 'Выкл', inline: true },
      { name: '📋', value: `${queue.tracks.size}`, inline: true },
    )
    .setFooter({ text: track.requestedBy ? `${track.requestedBy.username}` : '' })
    .setTimestamp();
}

// ═══════════════════════════
//  ОБРАБОТКА КНОПОК
// ═══════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('sf_')) return;

  const queue = useQueue(interaction.guild.id);
  const voice = interaction.member?.voice?.channel;

  if (!voice) return interaction.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });

  const act = interaction.customId.slice(3);

  try {
    switch (act) {
      case 'pause':
        if (!queue?.isPlaying()) return interaction.reply({ content: '❌ Ничего не играет', ephemeral: true });
        queue.node.pause();
        await interaction.update({ embeds: [nowPlayingEmbed(queue.currentTrack, queue)], components: makeButtons(true) });
        break;

      case 'resume':
        if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
        queue.node.resume();
        await interaction.update({ embeds: [nowPlayingEmbed(queue.currentTrack, queue)], components: makeButtons(false) });
        break;

      case 'skip':
        if (!queue?.isPlaying()) return interaction.reply({ content: '❌ Нечего пропускать', ephemeral: true });
        queue.node.skip();
        await interaction.reply({ content: '⏭️ Пропущено', ephemeral: true });
        break;

      case 'prev':
        if (!queue || queue.history.isEmpty()) return interaction.reply({ content: '❌ История пуста', ephemeral: true });
        await queue.history.back();
        await interaction.reply({ content: '⏮️ Предыдущий трек', ephemeral: true });
        break;

      case 'stop':
        if (!queue) return interaction.reply({ content: '❌ Уже остановлено', ephemeral: true });
        queue.delete();
        await interaction.update({ embeds: [new EmbedBuilder().setColor(0xef4444).setDescription('⏹️ Остановлено')], components: [] });
        break;

      case 'shuffle':
        if (!queue || queue.tracks.size < 2) return interaction.reply({ content: '❌ Мало треков', ephemeral: true });
        queue.tracks.shuffle();
        await interaction.reply({ content: '🔀 Перемешано!', ephemeral: true });
        break;

      case 'loop': {
        if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
        const next = (queue.repeatMode + 1) % 3;
        queue.setRepeatMode(next);
        const names = ['Выключен', 'Трек', 'Очередь'];
        await interaction.reply({ content: `🔁 Повтор: **${names[next]}**`, ephemeral: true });
        break;
      }

      case 'queue': {
        if (!queue || queue.tracks.size === 0) return interaction.reply({ content: '📭 Очередь пуста', ephemeral: true });
        const list = queue.tracks.map((t, i) => `**${i + 1}.** ${t.title} — \`${t.duration}\``).slice(0, 10).join('\n');
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📋 Очередь').setDescription(list).setFooter({ text: `Всего: ${queue.tracks.size}` })], ephemeral: true });
        break;
      }

      case 'voldown':
        if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
        queue.node.setVolume(Math.max(0, queue.node.volume - 10));
        await interaction.reply({ content: `🔉 Громкость: **${queue.node.volume}%**`, ephemeral: true });
        break;

      case 'volup':
        if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
        queue.node.setVolume(Math.min(100, queue.node.volume + 10));
        await interaction.reply({ content: `🔊 Громкость: **${queue.node.volume}%**`, ephemeral: true });
        break;

      case 'save': {
        if (!queue?.currentTrack) return interaction.reply({ content: '❌ Нечего сохранять', ephemeral: true });
        const t = queue.currentTrack;
        if (MONGO_URI) {
          await TrackModel.create({
            guildId: interaction.guild.id,
            title: t.title,
            artist: t.author,
            url: t.url,
            duration: t.duration,
            addedBy: interaction.user.username,
          });
          await interaction.reply({ content: `💾 **${t.title}** сохранён в библиотеку!`, ephemeral: true });
        } else {
          await interaction.reply({ content: '❌ БД не подключена', ephemeral: true });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Button error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Ошибка', ephemeral: true });
  }
});

// ═══════════════════════════
//  SLASH КОМАНДЫ
// ═══════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const voice = interaction.member?.voice?.channel;
  const name = interaction.commandName;

  try {
    if (name === 'play') {
      if (!voice) return interaction.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });
      const query = interaction.options.getString('query', true);
      await interaction.deferReply();

      const mainPlayer = useMainPlayer();
      const result = await mainPlayer.play(voice, query, {
        nodeOptions: {
          metadata: { channel: interaction.channel },
          volume: 50,
          leaveOnEmpty: true,
          leaveOnEmptyCooldown: 60000,
          leaveOnEnd: true,
          leaveOnEndCooldown: 60000,
        },
        requestedBy: interaction.user
      });

      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setDescription(`✅ **${result.track.title}** добавлен в очередь`)
        .setThumbnail(result.track.thumbnail);

      if (result.searchResult.playlist) {
        embed.setDescription(`✅ Плейлист **${result.searchResult.playlist.title}** — ${result.searchResult.tracks.length} треков`);
      }

      return interaction.followUp({ embeds: [embed] });
    }

    if (name === 'np') {
      const queue = useQueue(interaction.guild.id);
      if (!queue?.currentTrack) return interaction.reply({ content: '❌ Ничего не играет', ephemeral: true });
      return interaction.reply({ embeds: [nowPlayingEmbed(queue.currentTrack, queue)], components: makeButtons(queue.node.isPaused()) });
    }

    if (name === 'skip') {
      const queue = useQueue(interaction.guild.id);
      if (!queue?.isPlaying()) return interaction.reply({ content: '❌ Ничего не играет', ephemeral: true });
      const t = queue.currentTrack;
      queue.node.skip();
      return interaction.reply({ content: `⏭️ Пропущено: **${t.title}**` });
    }

    if (name === 'stop') {
      const queue = useQueue(interaction.guild.id);
      if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
      queue.delete();
      return interaction.reply({ content: '⏹️ Остановлено' });
    }

    if (name === 'pause') {
      const queue = useQueue(interaction.guild.id);
      if (!queue?.isPlaying()) return interaction.reply({ content: '❌ Ничего не играет', ephemeral: true });
      queue.node.pause();
      return interaction.reply({ content: '⏸️ Пауза' });
    }

    if (name === 'resume') {
      const queue = useQueue(interaction.guild.id);
      if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
      queue.node.resume();
      return interaction.reply({ content: '▶️ Продолжено' });
    }

    if (name === 'queue') {
      const queue = useQueue(interaction.guild.id);
      if (!queue || queue.tracks.size === 0) return interaction.reply({ content: '📭 Очередь пуста', ephemeral: true });
      const list = queue.tracks.map((t, i) => `**${i + 1}.** ${t.title} — \`${t.duration}\``).slice(0, 15).join('\n');
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📋 Очередь').setDescription(`**Сейчас:** ${queue.currentTrack.title}\n\n${list}`).setFooter({ text: `Всего: ${queue.tracks.size}` })] });
    }

    if (name === 'volume') {
      const queue = useQueue(interaction.guild.id);
      if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
      const vol = interaction.options.getInteger('level', true);
      queue.node.setVolume(vol);
      return interaction.reply({ content: `🔊 Громкость: **${vol}%**` });
    }

    if (name === 'shuffle') {
      const queue = useQueue(interaction.guild.id);
      if (!queue || queue.tracks.size < 2) return interaction.reply({ content: '❌ Мало треков', ephemeral: true });
      queue.tracks.shuffle();
      return interaction.reply({ content: '🔀 Очередь перемешана!' });
    }

    if (name === 'loop') {
      const queue = useQueue(interaction.guild.id);
      if (!queue) return interaction.reply({ content: '❌ Нет очереди', ephemeral: true });
      const mode = interaction.options.getString('mode', true);
      const map = { off: 0, track: 1, queue: 2 };
      queue.setRepeatMode(map[mode]);
      const names = { off: 'Выключен', track: 'Трек', queue: 'Очередь' };
      return interaction.reply({ content: `🔁 Повтор: **${names[mode]}**` });
    }

    if (name === 'library') {
      if (!MONGO_URI) return interaction.reply({ content: '❌ БД не подключена', ephemeral: true });
      const saved = await TrackModel.find({ guildId: interaction.guild.id }).sort({ addedAt: -1 }).limit(15);
      if (saved.length === 0) return interaction.reply({ content: '📭 Библиотека пуста. Нажми 💾 при воспроизведении чтобы сохранить трек.', ephemeral: true });
      const list = saved.map((t, i) => `**${i + 1}.** ${t.title} — *${t.artist}*`).join('\n');
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x06b6d4).setTitle('📚 Библиотека сервера').setDescription(list).setFooter({ text: `${saved.length} треков сохранено` })], ephemeral: true });
    }

    if (name === 'playlib') {
      if (!voice) return interaction.reply({ content: '❌ Зайди в голосовой канал', ephemeral: true });
      if (!MONGO_URI) return interaction.reply({ content: '❌ БД не подключена', ephemeral: true });
      const num = interaction.options.getInteger('number', true);
      const saved = await TrackModel.find({ guildId: interaction.guild.id }).sort({ addedAt: -1 });
      if (num < 1 || num > saved.length) return interaction.reply({ content: `❌ Номер от 1 до ${saved.length}`, ephemeral: true });
      const track = saved[num - 1];
      if (!track.url) return interaction.reply({ content: '❌ У трека нет URL', ephemeral: true });
      await interaction.deferReply();
      const mainPlayer = useMainPlayer();
      await mainPlayer.play(voice, track.url, {
        nodeOptions: { metadata: { channel: interaction.channel }, volume: 50, leaveOnEnd: true, leaveOnEndCooldown: 60000 },
        requestedBy: interaction.user
      });
      return interaction.followUp({ content: `▶️ Играю из библиотеки: **${track.title}**` });
    }

  } catch (err) {
    console.error('Command error:', err);
    const r = { content: `❌ Ошибка: ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(r);
    else await interaction.reply(r);
  }
});

// ═══════════════════════════
//  СОБЫТИЯ ПЛЕЕРА
// ═══════════════════════════
player.events.on('playerStart', (queue, track) => {
  queue.metadata.channel.send({
    embeds: [nowPlayingEmbed(track, queue)],
    components: makeButtons(false)
  });
});

player.events.on('emptyQueue', (queue) => {
  queue.metadata.channel.send({ embeds: [new EmbedBuilder().setColor(0x94a3b8).setDescription('📭 Очередь закончилась')] });
});

player.events.on('playerError', (queue, err) => {
  console.error('Player error:', err);
  queue.metadata.channel.send({ content: `❌ Ошибка: ${err.message}` });
});

player.events.on('error', (queue, err) => {
  console.error('Queue error:', err);
});

// ═══════════════════════════
//  РЕГИСТРАЦИЯ КОМАНД + ЗАПУСК
// ═══════════════════════════
client.once(Events.ClientReady, async (c) => {
  console.log('');
  console.log('╔══════════════════════════════════╗');
  console.log(`║  ♫ SoundForge Music Bot          ║`);
  console.log(`║  ${c.user.tag.padEnd(32)}║`);
  console.log(`║  Серверов: ${String(c.guilds.cache.size).padEnd(21)}║`);
  console.log('╚══════════════════════════════════╝');
  console.log('');

  c.user.setActivity('музыку | /play', { type: ActivityType.Listening });

  // Авто-регистрация команд при старте
  const commands = [
    new SlashCommandBuilder().setName('play').setDescription('🎵 Воспроизвести трек').addStringOption(o => o.setName('query').setDescription('Название или URL').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('🎵 Текущий трек + кнопки'),
    new SlashCommandBuilder().setName('skip').setDescription('⏭️ Пропустить'),
    new SlashCommandBuilder().setName('stop').setDescription('⏹️ Остановить'),
    new SlashCommandBuilder().setName('pause').setDescription('⏸️ Пауза'),
    new SlashCommandBuilder().setName('resume').setDescription('▶️ Продолжить'),
    new SlashCommandBuilder().setName('queue').setDescription('📋 Очередь'),
    new SlashCommandBuilder().setName('volume').setDescription('🔊 Громкость').addIntegerOption(o => o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('🔀 Перемешать'),
    new SlashCommandBuilder().setName('loop').setDescription('🔁 Повтор').addStringOption(o => o.setName('mode').setDescription('Режим').setRequired(true).addChoices({ name: 'Выкл', value: 'off' }, { name: 'Трек', value: 'track' }, { name: 'Очередь', value: 'queue' })),
    new SlashCommandBuilder().setName('library').setDescription('📚 Сохранённые треки сервера'),
    new SlashCommandBuilder().setName('playlib').setDescription('▶️ Играть из библиотеки').addIntegerOption(o => o.setName('number').setDescription('Номер трека').setRequired(true).setMinValue(1)),
  ].map(c => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Команды зарегистрированы для сервера ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Команды зарегистрированы глобально');
    }
  } catch (err) {
    console.error('❌ Ошибка регистрации команд:', err);
  }
});

// СТАРТ
client.login(TOKEN);
