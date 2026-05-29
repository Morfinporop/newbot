const {
  Client, GatewayIntentBits, Events, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ActivityType, REST, Routes, SlashCommandBuilder
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const { Pool } = require('pg');
const https = require('https');
const http = require('http');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || 'postgresql://postgres:nJzLejgzLPytNXhIKcEEbbJurUTftAqd@postgres.railway.internal:5432/railway';

if (!TOKEN) { console.error('NO TOKEN'); process.exit(1); }

// PostgreSQL
let pool, dbOk = false;
if (DB_URL) {
  pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  pool.query('SELECT 1').then(() => { dbOk = true; console.log('DB OK'); }).catch(e => console.error('DB:', e.message));
}

async function dbTracks(search) {
  if (!dbOk) return [];
  try {
    if (search) {
      const r = await pool.query("SELECT * FROM tracks WHERE LOWER(title) LIKE $1 OR LOWER(artist) LIKE $1 ORDER BY added_at DESC LIMIT 5", ['%' + search.toLowerCase() + '%']);
      return r.rows;
    }
    return (await pool.query('SELECT * FROM tracks ORDER BY added_at DESC LIMIT 50')).rows;
  } catch { return []; }
}

// Client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

// Queue
const queues = new Map();
function getQ(id) { return queues.get(id); }
function vb(v) { return '█'.repeat(Math.round(v/10)) + '░'.repeat(10-Math.round(v/10)) + ' ' + v + '%'; }

function httpStream(url) {
  return new Promise((ok, fail) => {
    (url.startsWith('https') ? https : http).get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': '*/*', 'Connection': 'keep-alive' },
      timeout: 20000
    }, r => {
      if ([301,302,303,307,308].includes(r.statusCode) && r.headers.location) { r.destroy(); return httpStream(r.headers.location).then(ok).catch(fail); }
      if (r.statusCode !== 200) { r.destroy(); return fail(new Error('HTTP ' + r.statusCode)); }
      ok(r);
    }).on('error', fail).on('timeout', function(){ this.destroy(); fail(new Error('Timeout')); });
  });
}

function mkEmbed(q) {
  const t = q.current;
  if (!t) return new EmbedBuilder().setColor(0x7c3aed).setDescription('Nothing');
  return new EmbedBuilder().setColor(0x7c3aed).setTitle(t.title)
    .setDescription([t.artist||'', q.paused?'Paused':'Playing', vb(q.vol), `Loop: ${['Off','Track','Queue'][q.loop]} | Queue: ${q.tracks.length}`].filter(Boolean).join('\n'))
    .setFooter({ text: (t.user||'?') + ' | SoundForge' }).setTimestamp();
}

function mkBtns(p) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prev').setLabel('Prev').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(p?'play':'pause').setLabel(p?'Play':'Pause').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('vd').setLabel('Vol-').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('vu').setLabel('Vol+').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('shuf').setLabel('Mix').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('qlist').setLabel('Queue').setStyle(ButtonStyle.Secondary),
    )
  ];
}

async function playNext(gid) {
  const q = getQ(gid);
  if (!q) return;
  if (!q.tracks.length) { q.ch.send({ embeds: [new EmbedBuilder().setColor(0x6b7280).setDescription('Queue ended')] }); q.conn.destroy(); queues.delete(gid); return; }
  const t = q.tracks.shift(); q.current = t;
  try {
    const stream = await httpStream(t.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    resource.volume?.setVolume(q.vol / 100);
    q.res = resource; q.ap.play(resource); q.paused = false;
    q.ch.send({ embeds: [mkEmbed(q)], components: mkBtns(false) });
  } catch (e) {
    console.error('Play:', e.message);
    q.ch.send({ content: 'Skip (error): ' + t.title });
    playNext(gid);
  }
}

async function enqueue(guild, vc, ch, tracks) {
  let q = getQ(guild.id);
  if (!q) {
    const conn = joinVoiceChannel({
      channelId: vc.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    // Retry logic — Railway иногда медленно устанавливает UDP
    let connected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 30000);
        connected = true;
        break;
      } catch {
        console.log('Voice connect attempt', attempt + 1, 'failed, retrying...');
        if (attempt === 2) { conn.destroy(); throw new Error('Voice connection failed after 3 attempts. Railway may not support UDP.'); }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    const ap = createAudioPlayer(); conn.subscribe(ap);
    q = { conn, ap, res: null, tracks: [], current: null, vol: 60, loop: 0, paused: false, ch };
    ap.on(AudioPlayerStatus.Idle, () => { const qq=getQ(guild.id); if(!qq)return; if(qq.loop===1&&qq.current)qq.tracks.unshift({...qq.current}); if(qq.loop===2&&qq.current)qq.tracks.push({...qq.current}); playNext(guild.id); });
    ap.on('error', e => { console.error('AP:', e.message); playNext(guild.id); });
    queues.set(guild.id, q);
  }
  const idle = !q.current || q.ap.state.status === AudioPlayerStatus.Idle;
  q.tracks.push(...tracks); q.ch = ch;
  if (idle) await playNext(guild.id);
}

function cleanUrl(u) { try { return decodeURIComponent(u.split('/').pop().split('?')[0]).replace(/\.\w+$/,'').replace(/[_-]/g,' ').replace(/\d{6,}/,'').trim()||'Track'; } catch { return 'Track'; } }

// Buttons
client.on(Events.InteractionCreate, async i => {
  if(!i.isButton()) return;
  if(!i.member?.voice?.channel) return i.reply({content:'Join VC',ephemeral:true});
  const q=getQ(i.guild.id);
  if(!q) return i.reply({content:'Nothing',ephemeral:true});
  try {
    if(i.customId==='pause'){q.ap.pause();q.paused=true;return i.update({embeds:[mkEmbed(q)],components:mkBtns(true)});}
    if(i.customId==='play'){q.ap.unpause();q.paused=false;return i.update({embeds:[mkEmbed(q)],components:mkBtns(false)});}
    if(i.customId==='skip'){q.ap.stop();return i.reply({content:'Skipped',ephemeral:true});}
    if(i.customId==='prev'){if(q.current)q.tracks.unshift({...q.current});q.ap.stop();return i.reply({content:'Prev',ephemeral:true});}
    if(i.customId==='stop'){q.tracks=[];q.ap.stop();q.conn.destroy();queues.delete(i.guild.id);return i.update({embeds:[new EmbedBuilder().setColor(0x6b7280).setDescription('Stopped')],components:[]});}
    if(i.customId==='vd'){q.vol=Math.max(0,q.vol-10);q.res?.volume?.setVolume(q.vol/100);return i.update({embeds:[mkEmbed(q)],components:mkBtns(q.paused)});}
    if(i.customId==='vu'){q.vol=Math.min(100,q.vol+10);q.res?.volume?.setVolume(q.vol/100);return i.update({embeds:[mkEmbed(q)],components:mkBtns(q.paused)});}
    if(i.customId==='shuf'){for(let x=q.tracks.length-1;x>0;x--){const j=Math.floor(Math.random()*(x+1));[q.tracks[x],q.tracks[j]]=[q.tracks[j],q.tracks[x]];}return i.reply({content:'Shuffled',ephemeral:true});}
    if(i.customId==='loop'){q.loop=(q.loop+1)%3;return i.update({embeds:[mkEmbed(q)],components:mkBtns(q.paused)});}
    if(i.customId==='qlist'){return i.reply({embeds:[new EmbedBuilder().setColor(0x7c3aed).setTitle('Queue').setDescription(q.tracks.length?q.tracks.slice(0,12).map((t,x)=>`${x+1}. ${t.title}`).join('\n'):'Empty')],ephemeral:true});}
  } catch(e){if(!i.replied)i.reply({content:'Error',ephemeral:true}).catch(()=>{});}
});

// Commands
client.on(Events.InteractionCreate, async i => {
  if(!i.isChatInputCommand()) return;
  const vc = i.member?.voice?.channel;
  try {
    if(i.commandName==='play'){
      if(!vc) return i.reply({content:'Join voice channel',ephemeral:true});
      const q=i.options.getString('query',true).trim();
      await i.deferReply();

      // Direct URL
      if(q.startsWith('http')){
        try{
          await enqueue(i.guild,vc,i.channel,[{title:cleanUrl(q),artist:'',url:q,user:i.user.username}]);
          return i.followUp('Playing: **'+cleanUrl(q)+'**');
        }catch(e){return i.followUp('Error: '+e.message);}
      }

      // Search DB
      const found = await dbTracks(q);
      if(found.length){
        await enqueue(i.guild,vc,i.channel,[{title:found[0].title,artist:found[0].artist,url:found[0].url,user:i.user.username}]);
        return i.followUp('Playing: **'+found[0].title+'**');
      }
      return i.followUp('Not in library. Add tracks on the website or use direct URL.');
    }
    if(i.commandName==='np'){const q=getQ(i.guild.id);if(!q?.current)return i.reply({content:'Nothing',ephemeral:true});return i.reply({embeds:[mkEmbed(q)],components:mkBtns(q.paused)});}
    if(i.commandName==='skip'){const q=getQ(i.guild.id);if(!q)return i.reply({content:'-',ephemeral:true});q.ap.stop();return i.reply('Skipped');}
    if(i.commandName==='stop'){const q=getQ(i.guild.id);if(q){q.tracks=[];q.ap.stop();q.conn.destroy();queues.delete(i.guild.id);}return i.reply('Stopped');}
    if(i.commandName==='pause'){const q=getQ(i.guild.id);if(!q)return i.reply({content:'-',ephemeral:true});q.ap.pause();q.paused=true;return i.reply('Paused');}
    if(i.commandName==='resume'){const q=getQ(i.guild.id);if(!q)return i.reply({content:'-',ephemeral:true});q.ap.unpause();q.paused=false;return i.reply('Resumed');}
    if(i.commandName==='volume'){const q=getQ(i.guild.id);if(!q)return i.reply({content:'-',ephemeral:true});q.vol=i.options.getInteger('level',true);q.res?.volume?.setVolume(q.vol/100);return i.reply('Vol: '+q.vol+'%');}
    if(i.commandName==='queue'){const q=getQ(i.guild.id);if(!q?.tracks.length)return i.reply({content:'Empty',ephemeral:true});return i.reply({embeds:[new EmbedBuilder().setColor(0x7c3aed).setTitle('Queue').setDescription(`Now: **${q.current?.title}**\n\n${q.tracks.slice(0,15).map((t,x)=>`${x+1}. ${t.title}`).join('\n')}`)]});}
    if(i.commandName==='shuffle'){const q=getQ(i.guild.id);if(!q)return i.reply({content:'-',ephemeral:true});for(let x=q.tracks.length-1;x>0;x--){const j=Math.floor(Math.random()*(x+1));[q.tracks[x],q.tracks[j]]=[q.tracks[j],q.tracks[x]];}return i.reply('Shuffled');}
    if(i.commandName==='loop'){const q=getQ(i.guild.id);if(!q)return i.reply({content:'-',ephemeral:true});const m=i.options.getString('mode',true);q.loop={off:0,track:1,queue:2}[m];return i.reply('Loop: '+m);}
    if(i.commandName==='library'){
      const all=await dbTracks();
      if(!all.length)return i.reply({content:'Library empty. Add on website.',ephemeral:true});
      return i.reply({embeds:[new EmbedBuilder().setColor(0x7c3aed).setTitle('Library').setDescription(all.map((t,x)=>`**${x+1}.** ${t.title} — ${t.artist}`).join('\n'))],ephemeral:true});
    }
    if(i.commandName==='playlib'){
      if(!vc)return i.reply({content:'Join VC',ephemeral:true});
      const n=i.options.getInteger('number',true);
      const all=await dbTracks();
      if(n<1||n>all.length)return i.reply({content:'1-'+all.length,ephemeral:true});
      const t=all[n-1]; await i.deferReply();
      await enqueue(i.guild,vc,i.channel,[{title:t.title,artist:t.artist,url:t.url,user:i.user.username}]);
      return i.followUp('Playing: **'+t.title+'**');
    }
    if(i.commandName==='playall'){
      if(!vc)return i.reply({content:'Join VC',ephemeral:true});
      const all=await dbTracks();
      if(!all.length)return i.reply({content:'Empty',ephemeral:true});
      await i.deferReply();
      await enqueue(i.guild,vc,i.channel,all.map(t=>({title:t.title,artist:t.artist,url:t.url,user:i.user.username})));
      return i.followUp(`Playing ${all.length} tracks`);
    }
  } catch(e){console.error('CMD:',e.message);const r={content:e.message,ephemeral:true};if(i.replied||i.deferred)i.followUp(r).catch(()=>{});else i.reply(r).catch(()=>{});}
});

// Start
client.once(Events.ClientReady, async c => {
  console.log(`${c.user.tag} ONLINE | ${c.guilds.cache.size} guilds | DB: ${dbOk}`);
  c.user.setActivity('/play', { type: ActivityType.Listening });
  const cmds = [
    new SlashCommandBuilder().setName('play').setDescription('Play URL or search library').addStringOption(o=>o.setName('query').setDescription('URL or name').setRequired(true)),
    new SlashCommandBuilder().setName('np').setDescription('Now playing'),
    new SlashCommandBuilder().setName('skip').setDescription('Skip'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume'),
    new SlashCommandBuilder().setName('queue').setDescription('Queue'),
    new SlashCommandBuilder().setName('volume').setDescription('Volume').addIntegerOption(o=>o.setName('level').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle'),
    new SlashCommandBuilder().setName('loop').setDescription('Loop').addStringOption(o=>o.setName('mode').setDescription('Mode').setRequired(true).addChoices({name:'Off',value:'off'},{name:'Track',value:'track'},{name:'Queue',value:'queue'})),
    new SlashCommandBuilder().setName('library').setDescription('Library'),
    new SlashCommandBuilder().setName('playlib').setDescription('Play #').addIntegerOption(o=>o.setName('number').setDescription('#').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('playall').setDescription('Play all'),
  ].map(c=>c.toJSON());
  try{const rest=new REST({version:'10'}).setToken(TOKEN);if(GUILD_ID)await rest.put(Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID),{body:cmds});else await rest.put(Routes.applicationCommands(CLIENT_ID),{body:cmds});console.log('13 commands');}catch(e){console.error('Reg:',e.message);}
});

client.login(TOKEN);
