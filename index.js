// index.js - Farlight 84 Scrims Manager (discord.js v14) for Render
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes,
        ActionRowBuilder, ButtonBuilder, ButtonStyle,
        ModalBuilder, TextInputBuilder, TextInputStyle,
        PermissionsBitField } = require('discord.js');
const Canvas = require('canvas');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const moment = require('moment-timezone');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SERVER_TZ = process.env.TIMEZONE || 'Asia/Kolkata';

// --- Health check server for Render ---
const http = require('http');
const PORT = process.env.PORT || 8080;

http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});
// --- End of health check server ---

if (!TOKEN || !GUILD_ID) {
  console.error('DISCORD_TOKEN and GUILD_ID must be set in environment variables');
  process.exit(1);
}

const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ],
  partials: [ Partials.Channel ]
});

// In-memory captcha map: key = `${userId}|${scrimName}` -> expected word
const captchaMap = {};

// Initialize DB
let db;
(async () => {
        
  // --- Render-compatible database path ---
const dbPath = process.env.DB_PATH || './scrims.sqlite';
db = await open({ filename: dbPath, driver: sqlite3.Database });
// --- End DB patch ---

  await db.exec(`CREATE TABLE IF NOT EXISTS teams (
    team_name TEXT PRIMARY KEY,
    team_tag TEXT,
    captain_id TEXT,
    captain_name TEXT,
    player2_id TEXT,
    player2_name TEXT,
    player3_id TEXT,
    player3_name TEXT,
    substitute_id TEXT,
    substitute_name TEXT
  );`);
  await db.exec(`CREATE TABLE IF NOT EXISTS scrims (
    scrim_name TEXT PRIMARY KEY,
    start_time TEXT,
    end_time TEXT,
    mention_role_id TEXT,
    day_of_week TEXT
  );`);
  await db.exec(`CREATE TABLE IF NOT EXISTS daily_registration (
    scrim_name TEXT,
    team_name TEXT,
    checked_in INTEGER,
    PRIMARY KEY(scrim_name, team_name)
  );`);
})();

// Helpers
function parseMentionIds(input) {
  if (!input) return [];
  const ids = [];
  const mentionRegex = /<@!?(\d+)>/g;
  let m;
  while ((m = mentionRegex.exec(input)) !== null) ids.push(m[1]);
  const numRegex = /(\d{17,20})/g;
  while ((m = numRegex.exec(input)) !== null) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

// Commands to register
const commands = [
  {
    name: 'create_scrim',
    description: 'Create a scrim schedule (admin only)',
    options: [
      { name: 'scrim_name', type: 3, description: 'Name for scrim', required: true },
      { name: 'day_of_week', type: 3, description: 'Monday..Sunday', required: true },
      { name: 'start_time', type: 3, description: 'HH:MM (24h) server timezone', required: true },
      { name: 'end_time', type: 3, description: 'HH:MM (24h) server timezone', required: true },
      { name: 'mention_role', type: 8, description: 'Role to mention when registration opens', required: true }
    ]
  },
  {
    name: 'create_leaderboard',
    description: 'Create leaderboard image from CSV lines (team,placement,kills)',
    options: [
      { name: 'scrim_name', type: 3, description: 'Scrim name', required: true },
      { name: 'data', type: 3, description: 'Lines: TeamName,placement_points,kill_points (one per line)', required: true }
    ]
  },
  {
    name: 'delete_team',
    description: 'Admin: delete a team',
    options: [{ name: 'team_name', type: 3, description: 'Team name', required: true }]
  }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
  console.log(`${client.user.tag} ready!`);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  } catch (e) { console.warn('Command register warning', e?.message); }

  const guild = await client.guilds.fetch(GUILD_ID);

  // Ensure Scrims category & base channels/roles
  let scrimCategory = guild.channels.cache.find(ch => ch.type === 4 && ch.name === 'Scrims');
  if (!scrimCategory) scrimCategory = await guild.channels.create({ name: 'Scrims', type: 4 });

  const ensureTextChannel = async (name, opts = {}) => {
    let ch = guild.channels.cache.find(c => c.name === name && c.parentId === scrimCategory.id && c.type === 0);
    if (!ch) ch = await guild.channels.create({ name, type: 0, parent: scrimCategory.id, ...opts });
    return ch;
  };

  await ensureTextChannel('scrim-register');
  await ensureTextChannel('scrim-log');

  let adminCh = guild.channels.cache.find(c => c.name === 'scrim-admin' && c.parentId === scrimCategory.id);
  if (!adminCh) {
    adminCh = await guild.channels.create({
      name: 'scrim-admin',
      type: 0,
      parent: scrimCategory.id,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });
  }

  // ensure IDP role
  let idpRole = guild.roles.cache.find(r => r.name === 'IDP');
  if (!idpRole) idpRole = await guild.roles.create({ name: 'IDP', reason: 'Grant to checked-in players' });

  // Post registration buttons message
  const regCh = guild.channels.cache.find(c => c.name === 'scrim-register' && c.parentId === scrimCategory.id);
  const last = await regCh.messages.fetch({ limit: 50 }).catch(()=>({}));
  let botMsg = (last && last.find) ? last.find(m => m.author?.id === client.user.id && m.content?.includes('Welcome to Farlight 84 Scrim Registration')) : null;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('register_team').setLabel('📝 Register Team').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit_team').setLabel('✏️ Edit Team').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('delete_team').setLabel('🗑️ Delete Team').setStyle(ButtonStyle.Danger)
  );
  if (botMsg) {
    try { await botMsg.edit({ content: 'Welcome to Farlight 84 Scrim Registration! Use buttons below to manage your team.', components: [row] }); } catch(e) {}
  } else {
    await regCh.send({ content: 'Welcome to Farlight 84 Scrim Registration! Use buttons below to manage your team.', components: [row] });
  }

  // schedule scrims from DB
  const scrimRows = await db.all('SELECT * FROM scrims');
  for (const s of scrimRows) scheduleScrimJob(guild, s);
});

// Interaction handling
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'register_team') {
        const modal = new ModalBuilder().setCustomId('modal_register').setTitle('Register Team - Farlight 84');
        const t1 = new TextInputBuilder().setCustomId('team_name').setLabel('Team Name').setStyle(TextInputStyle.Short).setRequired(true);
        const t2 = new TextInputBuilder().setCustomId('team_tag').setLabel('Team Tag [TAG] (no brackets, max 6)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6);
        const t3 = new TextInputBuilder().setCustomId('captain').setLabel('Captain In-game name & UID').setStyle(TextInputStyle.Short).setRequired(true);
        const t4 = new TextInputBuilder().setCustomId('p2').setLabel('Player2 In-game name & UID').setStyle(TextInputStyle.Short).setRequired(true);
        const t5 = new TextInputBuilder().setCustomId('p3').setLabel('Player3 In-game name & UID').setStyle(TextInputStyle.Short).setRequired(true);
        const t6 = new TextInputBuilder().setCustomId('sub').setLabel('Substitute (optional)').setStyle(TextInputStyle.Short).setRequired(false);
        const t7 = new TextInputBuilder().setCustomId('mentions').setLabel('Mention teammates (e.g. @user @user)').setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(t1),
          new ActionRowBuilder().addComponents(t2),
          new ActionRowBuilder().addComponents(t3),
          new ActionRowBuilder().addComponents(t4),
          new ActionRowBuilder().addComponents(t5),
          new ActionRowBuilder().addComponents(t6),
          new ActionRowBuilder().addComponents(t7)
        );
        await interaction.showModal(modal);
        return;
      } else if (id === 'edit_team') {
        const uid = interaction.user.id.toString();
        const team = await db.get('SELECT * FROM teams WHERE captain_id=? OR player2_id=? OR player3_id=? OR substitute_id=?', [uid,uid,uid,uid]);
        if (!team) {
          await interaction.reply({ content: 'No team found to edit.', ephemeral: true });
          return;
        }
        const modal = new ModalBuilder().setCustomId('modal_edit').setTitle('Edit Team: ' + team.team_name);
        const t1 = new TextInputBuilder().setCustomId('team_name').setLabel('Team Name').setStyle(TextInputStyle.Short).setRequired(true).setValue(team.team_name);
        const t2 = new TextInputBuilder().setCustomId('team_tag').setLabel('Team Tag').setStyle(TextInputStyle.Short).setRequired(true).setValue(team.team_tag||'');
        const t3 = new TextInputBuilder().setCustomId('captain').setLabel('Captain name & UID').setStyle(TextInputStyle.Short).setRequired(true).setValue(team.captain_name||'');
        const t4 = new TextInputBuilder().setCustomId('p2').setLabel('Player2 name & UID').setStyle(TextInputStyle.Short).setRequired(true).setValue(team.player2_name||'');
        const t5 = new TextInputBuilder().setCustomId('p3').setLabel('Player3 name & UID').setStyle(TextInputStyle.Short).setRequired(true).setValue(team.player3_name||'');
        const t6 = new TextInputBuilder().setCustomId('sub').setLabel('Sub (optional)').setStyle(TextInputStyle.Short).setRequired(false).setValue(team.substitute_name||'');
        const t7 = new TextInputBuilder().setCustomId('mentions').setLabel('Mention teammates (e.g. @user @user)').setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(t1),
          new ActionRowBuilder().addComponents(t2),
          new ActionRowBuilder().addComponents(t3),
          new ActionRowBuilder().addComponents(t4),
          new ActionRowBuilder().addComponents(t5),
          new ActionRowBuilder().addComponents(t6),
          new ActionRowBuilder().addComponents(t7)
        );
        await interaction.showModal(modal);
        return;
      } else if (id === 'delete_team') {
        const uid = interaction.user.id.toString();
        const team = await db.get('SELECT * FROM teams WHERE captain_id=? OR player2_id=? OR player3_id=? OR substitute_id=?', [uid,uid,uid,uid]);
        if (!team) return interaction.reply({ content: 'No team found to delete.', ephemeral: true });
        if (team.captain_id !== uid && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Only captain or admin can delete team.', ephemeral: true });
        }
        await db.run('DELETE FROM teams WHERE team_name=?', [team.team_name]);
        await interaction.reply({ content: `Team ${team.team_name} deleted.`, ephemeral: true });
        const log = interaction.guild.channels.cache.find(c => c.name === 'scrim-log');
        if (log) log.send(`Team ${team.team_name} deleted by ${interaction.user.tag}`);
        return;
      } else if (id.startsWith('transfer_')) {
        const teamName = id.replace('transfer_', '');
        const role = interaction.guild.roles.cache.find(r => r.name === 'IDP');
        if (!role) return interaction.reply({ content: 'No IDP role exists', ephemeral: true });
        if (!interaction.member.roles.cache.has(role.id)) return interaction.reply({ content: 'You do not hold the IDP role', ephemeral: true });
        const team = await db.get('SELECT captain_id, player2_id, player3_id, substitute_id FROM teams WHERE team_name=?', [teamName]);
        if (!team) return interaction.reply({ content: 'Team not found', ephemeral: true });
        const members = [team.captain_id, team.player2_id, team.player3_id, team.substitute_id].filter(Boolean);
        const candidates = members.filter(m => m !== interaction.user.id.toString());
        if (!candidates.length) return interaction.reply({ content: 'No teammate to transfer to', ephemeral: true });
        const newId = candidates[0];
        const newMember = await interaction.guild.members.fetch(newId).catch(()=>null);
        if (!newMember) return interaction.reply({ content: 'Teammate not on server', ephemeral: true });
        await interaction.member.roles.remove(role);
        await newMember.roles.add(role);
        return interaction.reply({ content: `IDP role transferred to ${newMember.user.tag}`, ephemeral: true });
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_register') {
        const team_name = interaction.fields.getTextInputValue('team_name').trim();
        const team_tag = interaction.fields.getTextInputValue('team_tag').trim();
        const captain_name = interaction.fields.getTextInputValue('captain').trim();
        const p2name = interaction.fields.getTextInputValue('p2').trim();
        const p3name = interaction.fields.getTextInputValue('p3').trim();
        const subname = interaction.fields.getTextInputValue('sub').trim();
        const mentions = interaction.fields.getTextInputValue('mentions').trim();
        const ids = parseMentionIds(mentions);
        if (ids.length < 3) {
          return interaction.reply({ content: 'Mention at least captain, player2, player3.', ephemeral: true });
        }
        try {
          await db.run('INSERT INTO teams VALUES (?,?,?,?,?,?,?,?,?,?)', [
            team_name, team_tag, interaction.user.id.toString(), captain_name,
            ids[1] ? ids[1].toString() : '', p2name,
            ids[2] ? ids[2].toString() : '', p3name,
            ids[3] ? ids[3].toString() : '', subname
          ]);
          await interaction.reply({ content: `Team ${team_name} registered successfully`, ephemeral: true });
          const log = interaction.guild.channels.cache.find(c => c.name === 'scrim-log');
          if (log) log.send(`Team registered: **${team_name}** by ${interaction.user.tag}`);
        } catch (e) {
          console.error(e);
          await interaction.reply({ content: `Could not register team. Name might already exist.`, ephemeral: true });
        }
        return;
      } else if (interaction.customId === 'modal_edit') {
        const team_name_new = interaction.fields.getTextInputValue('team_name').trim();
        const team_tag = interaction.fields.getTextInputValue('team_tag').trim();
        const captain_name = interaction.fields.getTextInputValue('captain').trim();
        const p2name = interaction.fields.getTextInputValue('p2').trim();
        const p3name = interaction.fields.getTextInputValue('p3').trim();
        const subname = interaction.fields.getTextInputValue('sub').trim();
        const mentions = interaction.fields.getTextInputValue('mentions').trim();
        const ids = parseMentionIds(mentions);
        if (ids.length < 3) {
          return interaction.reply({ content: 'Mention at least captain, player2, player3.', ephemeral: true });
        }
        const uid = interaction.user.id.toString();
        const teamOld = await db.get('SELECT team_name FROM teams WHERE captain_id=? OR player2_id=? OR player3_id=? OR substitute_id=?', [uid,uid,uid,uid]);
        if (!teamOld) return interaction.reply({ content: 'No team to edit found', ephemeral: true });
        try {
          await db.run('UPDATE teams SET team_name=?, team_tag=?, captain_id=?, captain_name=?, player2_id=?, player2_name=?, player3_id=?, player3_name=?, substitute_id=?, substitute_name=? WHERE team_name=?', [
            team_name_new, team_tag, interaction.user.id.toString(), captain_name,
            ids[1] ? ids[1].toString() : '', p2name,
            ids[2] ? ids[2].toString() : '', p3name,
            ids[3] ? ids[3].toString() : '', subname,
            teamOld.team_name
          ]);
          await interaction.reply({ content: `Team updated to ${team_name_new}`, ephemeral: true });
        } catch (e) {
          console.error(e);
          await interaction.reply({ content: `Update error`, ephemeral: true });
        }
        return;
      } else if (interaction.customId && interaction.customId.startsWith('captcha_modal_')) {
        const scrimName = interaction.customId.replace('captcha_modal_', '');
        const answer = interaction.fields.getTextInputValue('captcha_input').trim();
        const key = interaction.user.id + '|' + scrimName;
        const expected = captchaMap[key];
        if (!expected) {
          return interaction.reply({ content: 'Captcha expired. Click Register again.', ephemeral: true });
        }
        if (answer !== expected) return interaction.reply({ content: 'Incorrect CAPTCHA.', ephemeral: true });
        const uid = interaction.user.id.toString();
        const teamRow = await db.get('SELECT team_name FROM teams WHERE captain_id=? OR player2_id=? OR player3_id=? OR substitute_id=?', [uid,uid,uid,uid]);
        if (!teamRow) return interaction.reply({ content: 'You are not part of a registered team.', ephemeral: true });
        await db.run('INSERT OR REPLACE INTO daily_registration VALUES (?,?,?)', [scrimName, teamRow.team_name, 1]);
        const guild = interaction.guild;
        let idpRole = guild.roles.cache.find(r => r.name === 'IDP');
        if (!idpRole) idpRole = await guild.roles.create({ name: 'IDP' });
        const member = await guild.members.fetch(interaction.user.id);
        await member.roles.add(idpRole);
        try {
          const transferRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('transfer_' + teamRow.team_name).setLabel('Transfer IDP Role').setStyle(ButtonStyle.Primary)
          );
          await member.send({ content: `You are IDP for team **${teamRow.team_name}**. Transfer if needed:`, components: [transferRow] });
        } catch (e) {}
        delete captchaMap[key];
        return interaction.reply({ content: `Team ${teamRow.team_name} checked-in for ${scrimName}.`, ephemeral: true });
      }
    }

    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'create_scrim') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }
        const scrim_name = interaction.options.getString('scrim_name');
        const day_of_week = interaction.options.getString('day_of_week');
        const start_time = interaction.options.getString('start_time');
        const end_time = interaction.options.getString('end_time');
        const mentionRole = interaction.options.getRole('mention_role');
        await db.run('INSERT OR REPLACE INTO scrims VALUES (?,?,?,?,?)', [scrim_name, start_time, end_time, mentionRole.id.toString(), day_of_week]);
        await interaction.reply({ content: `Scrim ${scrim_name} scheduled for ${day_of_week} ${start_time}-${end_time}`, ephemeral: true });
        const guild = await client.guilds.fetch(GUILD_ID);
        let regCh = guild.channels.cache.find(c => c.name === `${scrim_name}-register-here`);
        if (!regCh) {
          regCh = await guild.channels.create({ name: `${scrim_name}-register-here`, type: 0, parent: guild.channels.cache.find(ch => ch.name==='Scrims' && ch.type===4)?.id || undefined, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }] });
        }
        scheduleScrimJob(guild, { scrim_name, start_time, end_time, mention_role_id: mentionRole.id.toString(), day_of_week });
        return;
      } else if (name === 'create_leaderboard') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }
        const scrim_name = interaction.options.getString('scrim_name');
        const data = interaction.options.getString('data');
        const lines = data.split('\n').map(s=>s.trim()).filter(Boolean);
        const table = [];
        for (const ln of lines) {
          const parts = ln.split(',').map(p=>p.trim());
          if (parts.length < 3) continue;
          const team = parts[0];
          const place = parseInt(parts[1]) || 0;
          const kills = parseInt(parts[2]) || 0;
          table.push({ team, place, kills, total: place + kills });
        }
        if (!table.length) return interaction.reply({ content: 'No valid data lines provided.', ephemeral: true });
        table.sort((a,b)=>b.total - a.total);
        const width = 1000;
        const rowH = 48;
        const height = 140 + table.length*rowH;
        const canvas = Canvas.createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0,0,width,height);
        ctx.fillStyle = '#111827';
        ctx.font = '28px sans-serif';
        const header = `Maxxi's Farlight 84 Scrims - ${moment().tz(SERVER_TZ).format('dddd, DD MMMM YYYY')}`;
        ctx.fillText(header, 28, 40);
        ctx.font = '18px sans-serif';
        ctx.fillStyle = '#000000';
        ctx.fillText('Rank', 28, 84);
        ctx.fillText('Team', 120, 84);
        ctx.fillText('Placement', 620, 84);
        ctx.fillText('Kills', 760, 84);
        ctx.fillText('Total', 880, 84);
        let y = 120;
        for (let i=0;i<table.length;i++) {
          const r = table[i];
          if (i < 3) {
            ctx.fillStyle = '#0f9d58';
            ctx.fillRect(20, y-30, width-40, rowH-10);
            ctx.fillStyle = '#ffffff';
          } else {
            ctx.fillStyle = '#111827';
          }
          ctx.font = '16px sans-serif';
          ctx.fillText(String(i+1), 28, y);
          ctx.fillText(r.team, 120, y);
          ctx.fillText(String(r.place), 640, y);
          ctx.fillText(String(r.kills), 770, y);
          ctx.fillText(String(r.total), 890, y);
          y += rowH;
        }
        const buffer = canvas.toBuffer('image/png');
        await interaction.reply({ files: [{ attachment: buffer, name: `leaderboard_${scrim_name}.png` }] });
        return;
      } else if (name === 'delete_team') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }
        const teamName = interaction.options.getString('team_name');
        await db.run('DELETE FROM teams WHERE team_name=?', [teamName]);
        return interaction.reply({ content: `Team ${teamName} removed (if existed).`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Interaction error', err);
    try { if (interaction.replied || interaction.deferred) await interaction.followUp({ content: 'Internal error', ephemeral: true }); else await interaction.reply({ content: 'Internal error', ephemeral: true }); } catch(e) {}
  }
});

// schedule a scrim job
function scheduleScrimJob(guild, scrimRecord) {
  const { scrim_name, start_time, end_time, mention_role_id, day_of_week } = scrimRecord;
  const now = moment().tz(SERVER_TZ);
  const targetWeekday = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].indexOf(day_of_week);
  if (targetWeekday === -1) return;
  let start = moment.tz(start_time, 'HH:mm', SERVER_TZ).day(targetWeekday);
  let end = moment.tz(end_time, 'HH:mm', SERVER_TZ).day(targetWeekday);
  if (start.isBefore(now)) { start.add(7, 'days'); end.add(7, 'days'); }
  const msToStart = start.diff(now);
  const msToEnd = end.diff(now);

  setTimeout(async () => {
    try {
      const g = await client.guilds.fetch(GUILD_ID);
      const regCh = g.channels.cache.find(ch => ch.name === `${scrim_name}-register-here`);
      const role = g.roles.cache.get(mention_role_id);
      const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('checkin_' + scrim_name).setLabel('Register (Check-in)').setStyle(ButtonStyle.Success));
      const sent = await regCh.send({ content: `${role ? role.toString() : ''} Registration is now OPEN for **${scrim_name}**. Click Register and complete CAPTCHA to check-in.`, components: [btn] });

      const collector = sent.createMessageComponentCollector({ time: msToEnd, filter: i => i.customId === ('checkin_' + scrim_name) });
      collector.on('collect', async (i) => {
        const word = 'SCRIM' + Math.floor(1000 + Math.random()*9000);
        const modal = new ModalBuilder().setCustomId('captcha_modal_' + scrim_name).setTitle('Enter CAPTCHA to check-in');
        const input = new TextInputBuilder().setCustomId('captcha_input').setLabel(`Type this exactly: ${word}`).setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        captchaMap[i.user.id + '|' + scrim_name] = word;
        await i.showModal(modal);
      });

      collector.on('end', async () => {
        await createLobbiesForScrim(g, scrim_name);
      });

      const rec = await db.get('SELECT * FROM scrims WHERE scrim_name=?', [scrim_name]);
      if (rec) scheduleScrimJob(g, rec);
    } catch (e) { console.error('schedule job error', e); }
  }, msToStart);
}

// create lobbies and post slotlists
async function createLobbiesForScrim(guild, scrimName) {
  const rows = await db.all('SELECT team_name FROM daily_registration WHERE scrim_name=? AND checked_in=1', [scrimName]);
  const teams = rows.map(r => r.team_name);
  if (!teams.length) {
    const ch = guild.channels.cache.find(c => c.name === `${scrimName}-register-here`);
    if (ch) ch.send('No teams checked in for this scrim.');
    return;
  }
  const chunkSize = 20;
  const chunks = [];
  for (let i=0;i<teams.length;i+=chunkSize) chunks.push(teams.slice(i,i+chunkSize));

  let scrimCat = guild.channels.cache.find(c => c.type === 4 && c.name === 'Scrims');
  if (!scrimCat) scrimCat = await guild.channels.create({ name: 'Scrims', type: 4 });
  let lobbiesCat = guild.channels.cache.find(c => c.type === 4 && c.name === 'Lobbies');
  if (!lobbiesCat) lobbiesCat = await guild.channels.create({ name: 'Lobbies', type: 4, parent: scrimCat.id });

  for (let idx=0; idx<chunks.length; idx++) {
    const lobbyName = `Lobby ${idx+1}`;
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
    for (const teamName of chunks[idx]) {
      const t = await db.get('SELECT captain_id, player2_id, player3_id, substitute_id FROM teams WHERE team_name=?', [teamName]);
      if (!t) continue;
      const members = [t.captain_id, t.player2_id, t.player3_id, t.substitute_id].filter(Boolean);
      for (const mid of members) {
        try {
          const m = await guild.members.fetch(mid);
          overwrites.push({ id: m.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
        } catch (e) {}
      }
    }
    let lobbyCh = guild.channels.cache.find(c => c.name === lobbyName && c.parentId === lobbiesCat.id);
    if (!lobbyCh) lobbyCh = await guild.channels.create({ name: lobbyName, type: 0, parent: lobbiesCat.id, permissionOverwrites: overwrites });
    let text = `📋 **Slot List (${scrimName})**\n`;
    chunks[idx].forEach((t,i)=> text += `${i+1}. ${t}\n`);
    await lobbyCh.send(text);
  }
}

client.login(TOKEN);
