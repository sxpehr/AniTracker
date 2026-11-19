const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

// Single source of truth for the slash commands. The bot registers these
// itself on startup (index.js), so a deploy is all it takes.
// Every command is server-only (no DMs) and installed with the bot to a server.
const base = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

const commands = [
  base('track', 'Post a signed-in person’s movie and TV activity in this server').addUserOption((opt) =>
    opt.setName('user').setDescription('Someone who has used /signin').setRequired(true)
  ),
  base('untrack', 'Stop posting someone’s movie and TV activity here').addUserOption((opt) =>
    opt.setName('user').setDescription('The person to stop tracking').setRequired(true)
  ),
  base('list', 'Who is tracked in this server'),
  base('whostracking', 'Who is tracked and by whom (never pings anyone)'),
  base('setchannel', 'Choose the channel where watch posts go')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Text channel for watch posts')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  base('find', 'Look up a movie or TV show').addStringOption((opt) =>
    opt.setName('title').setDescription('Movie or show name, e.g. "Severance" or "Dune 2021"').setRequired(true).setMaxLength(100)
  ),
  base('watchlater', 'Your private watch later list'),
  base('myfavorites', 'Your private favorites list (saved with the 🤍 Favorite button)'),
  base('recommend', 'The most-recommended movies and shows — this server or global'),
  base('signin', 'Link your Simkl account so only you control your posts'),
  base('signout', 'Unlink your Simkl account from TV Tracker'),
  base('tracking', 'Turn your live watch posts on or off (everywhere)').addStringOption((opt) =>
    opt
      .setName('status')
      .setDescription('Leave empty to see your current setting')
      .setRequired(false)
      .addChoices({ name: 'On — post my activity', value: 'on' }, { name: 'Off — stop posting my activity', value: 'off' })
  ),
  base('update', 'Post an update notice in this server silently (no notifications)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Custom message — leave empty to post the latest changelog').setRequired(false).setMaxLength(1800)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Where to post (defaults to the watch post channel)')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  base('feedback', 'Rate TV Tracker and send feedback to the developer'),
  base('help', 'All TV Tracker commands and buttons'),
].map((c) => c.toJSON());

module.exports = { commands };
