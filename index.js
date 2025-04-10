require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const commands = [
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Create a backup of the server'),

  new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Restore a backup by ID')
    .addStringOption(option =>
      option.setName('id')
        .setDescription('The backup ID to restore')
        .setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Register slash commands
client.once('ready', async () => {
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log(`✅ Logged in as ${client.user.tag}`);
  } catch (err) {
    console.error('❌ Error registering slash commands:', err);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, user, member } = interaction;

  if (commandName === 'backup') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ You must be an admin to create a backup.', ephemeral: true });
    }

    await interaction.reply({ content: '⏳ Creating backup...', ephemeral: true });

    const backupData = await backupGuild(guild);
    const backupId = uuidv4();
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

    // DM the backup ID
    try {
      await user.send(`✅ Backup created!\n**Backup ID:** \`${backupId}\``);
    } catch {
      return interaction.followUp({ content: '✅ Backup created, but I couldn\'t DM you the ID.', ephemeral: true });
    }

    await interaction.followUp({ content: '✅ Backup completed! Check your DMs for the ID.', ephemeral: true });
  }

  if (commandName === 'restore') {
    if (guild.ownerId !== user.id) {
      return interaction.reply({ content: '❌ Only the server owner can restore a backup.', ephemeral: true });
    }

    const id = interaction.options.getString('id');
    const backupPath = path.join(__dirname, 'backups', `${id}.json`);

    if (!fs.existsSync(backupPath)) {
      return interaction.reply({ content: '❌ Backup not found with that ID.', ephemeral: true });
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_restore')
        .setLabel('✅ Yes, restore')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel_restore')
        .setLabel('❌ No, cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: `⚠️ Are you sure you want to restore backup \`${id}\`? This will overwrite your server settings.`,
      components: [confirmRow],
      ephemeral: true
    });

    const collector = interaction.channel.createMessageComponentCollector({ time: 15000 });

    collector.on('collect', async i => {
      if (i.user.id !== user.id) return;

      if (i.customId === 'cancel_restore') {
        await i.update({ content: '❌ Restore cancelled.', components: [], ephemeral: true });
        collector.stop();
      }

      if (i.customId === 'confirm_restore') {
        await i.update({ content: '🔁 Restoring backup...', components: [], ephemeral: true });

        const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

        try {
          await restoreGuild(guild, data);
          await interaction.followUp({ content: '✅ Backup restored successfully!', ephemeral: true });
        } catch (err) {
          console.error('❌ Restore error:', err);
          await interaction.followUp({ content: '❌ Failed to restore backup.', ephemeral: true });
        }

        collector.stop();
      }
    });
  }
});

async function backupGuild(guild) {
  if (typeof guild === "string") {
    guild = await client.guilds.fetch(guild).catch(() => null);
  }

  if (!guild) return;

  const backup = {
    name: guild.name,
    icon: guild.iconURL({ dynamic: true }),
    roles: [],
    channels: [],
    emojis: [],
    settings: {
      verificationLevel: guild.verificationLevel,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      explicitContentFilter: guild.explicitContentFilter,
      afkChannelId: guild.afkChannelId,
      afkTimeout: guild.afkTimeout,
      systemChannelId: guild.systemChannelId,
      rulesChannelId: guild.rulesChannelId,
      publicUpdatesChannelId: guild.publicUpdatesChannelId,
    }
  };

  await guild.roles.fetch();
  guild.roles.cache.forEach(role => {
    if (!role.managed && role.name !== "@everyone") {
      backup.roles.push({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        permissions: role.permissions.bitfield,
        mentionable: role.mentionable,
        position: role.position
      });
    }
  });

  await guild.emojis.fetch();
  guild.emojis.cache.forEach(emoji => {
    backup.emojis.push({
      name: emoji.name,
      url: emoji.url
    });
  });

  guild.channels.cache.forEach(channel => {
    backup.channels.push({
      name: channel.name,
      type: channel.type,
      parent: channel.parent ? channel.parent.name : null,
      position: channel.position
    });
  });

  return backup;
}

async function restoreGuild(guild, backup) {
  await guild.setName(backup.name);
  if (backup.icon) await guild.setIcon(backup.icon).catch(() => { });

  // Clear channels
  for (const channel of guild.channels.cache.values()) {
    await channel.delete().catch(() => { });
  }

  // Clear roles (except @everyone)
  for (const role of guild.roles.cache.values()) {
    if (role.name !== "@everyone" && !role.managed) {
      await role.delete().catch(() => { });
    }
  }

  // Clear emojis
  for (const emoji of guild.emojis.cache.values()) {
    await emoji.delete().catch(() => { });
  }

  // Recreate roles
  for (const roleData of backup.roles.sort((a, b) => a.position - b.position)) {
    await guild.roles.create({ name: roleData.name, color: roleData.color, hoist: roleData.hoist, permissions: BigInt(roleData.permissions), mentionable: roleData.mentionable });
  }

  // Recreate channels (basic only)
  for (const channel of backup.channels) {
    await guild.channels.create({ name: channel.name, type: channel.type }).catch(() => { });
  }

  // Recreate emojis (if accessible)
  for (const emoji of backup.emojis) {
    await guild.emojis.create({ name: emoji.name, attachment: emoji.url }).catch(() => { });
  }

  // Restore basic settings
  await guild.setVerificationLevel(backup.settings.verificationLevel);
  await guild.setExplicitContentFilter(backup.settings.explicitContentFilter);
  await guild.setDefaultMessageNotifications(backup.settings.defaultMessageNotifications);
}

client.login(process.env.TOKEN);
