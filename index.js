const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');
const fs = require('fs');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const BACKUP_DIR = './backups';
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Backup server (admin only)'),
  new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Restore server (owner only)')
    .addStringOption(option =>
      option.setName('id').setDescription('Backup ID').setRequired(true)
    ),
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Utility functions
function isAdmin(member) {
  return member.permissions.has('Administrator');
}

function isOwner(interaction) {
  return interaction.guild.ownerId === interaction.user.id;
}

async function backupGuild(guild) {
  const emojis = guild.emojis.cache.map(e => ({
    name: e.name,
    url: e.url,
  }));

  const roles = guild.roles.cache
    .filter(r => !r.managed && r.name !== '@everyone')
    .map(role => ({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      permissions: role.permissions.bitfield.toString(),
      mentionable: role.mentionable,
      position: role.position,
    }));

  const channels = [];
  guild.channels.cache.forEach(channel => {
    channels.push({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parent: channel.parentId,
      topic: channel.topic || null,
      nsfw: channel.nsfw || false,
      position: channel.position,
      permissionOverwrites: channel.permissionOverwrites.cache.map(perm => ({
        id: perm.id,
        allow: perm.allow.bitfield.toString(),
        deny: perm.deny.bitfield.toString(),
        type: perm.type,
      })),
    });
  });

  const members = [];
  const fetched = await guild.members.fetch();
  fetched.forEach(member => {
    members.push({
      id: member.id,
      roles: member.roles.cache
        .filter(r => r.name !== '@everyone')
        .map(r => r.name),
    });
  });

  const serverInfo = {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL(),
    description: guild.description || '',
    createdAt: guild.createdAt.toISOString(),
  };

  const data = {
    server: serverInfo,
    emojis,
    roles,
    channels,
    members,
  };

  const backupId = `${guild.id}-${Date.now()}`;
  fs.writeFileSync(`${BACKUP_DIR}/${backupId}.json`, JSON.stringify(data, null, 2));
  return backupId;
}

async function restoreGuild(guild, id) {
  const filePath = `${BACKUP_DIR}/${id}.json`;
  if (!fs.existsSync(filePath)) throw new Error('Backup not found');

  const data = JSON.parse(fs.readFileSync(filePath));

  await Promise.all(
    data.roles.reverse().map(role =>
      guild.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        permissions: BigInt(role.permissions),
        mentionable: role.mentionable,
      }).catch(() => {})
    )
  );

  await Promise.all(
    data.channels
      .sort((a, b) => a.position - b.position)
      .map(channel => {
        const options = {
          type: channel.type,
          topic: channel.topic,
          parent: channel.parent,
          nsfw: channel.nsfw,
          permissionOverwrites: channel.permissionOverwrites.map(p => ({
            id: p.id,
            allow: BigInt(p.allow),
            deny: BigInt(p.deny),
            type: p.type,
          })),
        };
        return guild.channels.create({ name: channel.name, ...options }).catch(() => {});
      })
  );

  const members = await guild.members.fetch();
  members.forEach(member => {
    const backupMember = data.members.find(m => m.id === member.id);
    if (backupMember) {
      backupMember.roles.forEach(roleName => {
        const role = guild.roles.cache.find(r => r.name === roleName);
        if (role) member.roles.add(role).catch(() => {});
      });
    }
  });
}

// Slash Command Handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'backup') {
    if (!isAdmin(interaction.member))
      return interaction.reply({ content: '❌ Admins only!', ephemeral: true });

    const id = await backupGuild(interaction.guild);
    try {
      await interaction.user.send(`📦 Backup ID: \`${id}\`\nUse /restore to restore this backup.`);
      await interaction.reply({ content: '✅ Backup created. Check your DMs!', ephemeral: true });
    } catch {
      interaction.reply({ content: '⚠️ Could not DM you the backup ID.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'restore') {
    if (!isOwner(interaction)) {
      return interaction.reply({
        content: '❌ Only the **server owner** can restore backups.',
        ephemeral: true,
      });
    }

    const id = interaction.options.getString('id');
    if (!fs.existsSync(`${BACKUP_DIR}/${id}.json`))
      return interaction.reply({ content: '❌ Backup ID not found.', ephemeral: true });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_restore_${id}`)
        .setLabel('✅ Yes')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cancel_restore')
        .setLabel('❌ No')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({
      content: `⚠️ Are you sure you want to restore backup \`${id}\`?\nThis will override roles and channels.`,
      components: [row],
      ephemeral: true,
    });
  }
});

// Button Handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;

  const [action, id] = interaction.customId.split('_').slice(1);

  if (interaction.customId.startsWith('confirm_restore_')) {
    await interaction.update({ content: `🔁 Restoring backup \`${id}\`...`, components: [] });
    try {
      await restoreGuild(interaction.guild, id);
      await interaction.followUp({ content: '✅ Server restored!', ephemeral: true });
    } catch (err) {
      await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
    }
  }

  if (interaction.customId === 'cancel_restore') {
    await interaction.update({ content: '❌ Restore cancelled.', components: [] });
  }
});

client.login(process.env.TOKEN);
