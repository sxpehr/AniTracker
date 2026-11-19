const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType } = require('discord.js');

// Single source of truth for the slash commands. The bot registers these
// itself on startup (index.js), so a deploy is all it takes — running
// `npm run deploy-commands` by hand is only needed for a GUILD_ID test server.
// Every command is server-only (no DMs) and installed with the bot to a server.
const base = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

const commands = [
  base('track', "Start posting an AniList user's activity in this server").addStringOption((opt) =>
    opt.setName('username').setDescription('AniList username').setRequired(true).setMaxLength(50)
  ),
  base('untrack', 'Stop tracking an AniList user in this server').addStringOption((opt) =>
    opt.setName('username').setDescription('AniList username').setRequired(true).setMaxLength(50)
  ),
  base('list', 'List the AniList profiles tracked in this server'),
  base('whostracking', 'Who is being tracked and by whom (never pings anyone)'),
  base('setchannel', 'Choose the channel where AniList updates get posted')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Text channel for activity posts')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  base('watchlater', 'Your Watch Later backlog — reorder, mark started, remove'),
  base('myfavorites', 'Your favorites — reorder, add notes, feature one on your profile'),
  base('recommendanimes', 'The most-recommended anime — this server or global'),
  base('favorites', "Show someone's AniList favourites").addStringOption((opt) =>
    opt.setName('username').setDescription('AniList username').setRequired(true).setMaxLength(50)
  ),
  base('signin', 'Link your AniList account so only you control your profile'),
  base('signout', 'Unlink your AniList account from AniTracker'),
  base('tracking', 'Turn your live AniList activity posts on or off (everywhere)').addStringOption((opt) =>
    opt
      .setName('status')
      .setDescription('Leave empty to see your current setting')
      .setRequired(false)
      .addChoices({ name: 'On — post my activity', value: 'on' }, { name: 'Off — stop posting my activity', value: 'off' })
  ),
  base('update', 'Post an update notice in this server silently (no notifications)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Custom message — leave empty to post the latest AniTracker changelog').setRequired(false).setMaxLength(1800)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Where to post (defaults to the AniTracker channel)')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),
  base('profile', 'Open an anime profile — favorites, reviews, stats and more').addUserOption((o) =>
    o.setName('user').setDescription('Whose profile (leave empty for yours)').setRequired(false)
  ),
  base('settings', 'Customize your profile, theme, activity posts and privacy').addStringOption((o) =>
    o
      .setName('section')
      .setDescription('Jump straight to a section')
      .setRequired(false)
      .addChoices(
        { name: '🎨 Appearance', value: 'look' },
        { name: '👤 Profile', value: 'profile' },
        { name: '🧩 Showcase', value: 'showcase' },
        { name: '📡 Activity posts', value: 'activity' },
        { name: '🔒 Privacy', value: 'privacy' },
        { name: '📊 Stats & reviews', value: 'more' },
        { name: '🛡️ Server', value: 'server' }
      )
  ),
  base('review', 'Write and read anime reviews')
    .addSubcommand((sc) =>
      sc
        .setName('write')
        .setDescription('Write (or edit) your review of an anime')
        .addStringOption((o) => o.setName('anime').setDescription('Start typing a title…').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('read')
        .setDescription('Read reviews of an anime')
        .addStringOption((o) => o.setName('anime').setDescription('Start typing a title…').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('browse')
        .setDescription('Discover reviews — newest, most helpful, highest rated, this server')
        .addStringOption((o) =>
          o
            .setName('sort')
            .setDescription('How to sort')
            .setRequired(false)
            .addChoices(
              { name: '🆕 Newest', value: 'recent' },
              { name: '❤️ Most helpful', value: 'liked' },
              { name: '🏆 Highest rated', value: 'rating' },
              { name: '🏠 This server', value: 'server' },
              { name: '✍️ My reviews', value: 'mine' }
            )
        )
    ),
  base('collection', 'Your anime lists — favorites, watch later, custom collections')
    .addSubcommand((sc) =>
      sc
        .setName('view')
        .setDescription('Open a collection')
        .addUserOption((o) => o.setName('user').setDescription('Whose (leave empty for yours)').setRequired(false))
        .addStringOption((o) => o.setName('collection').setDescription('Which list').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Add an anime to one of your lists')
        .addStringOption((o) => o.setName('anime').setDescription('Start typing a title…').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('collection').setDescription('Which list (leave empty to pick several)').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sc) => sc.setName('create').setDescription('Create a custom collection, like “Comfort Anime”'))
    .addSubcommand((sc) => sc.setName('manage').setDescription('Reorder, add notes, rename or delete your lists')),
  base('recommend', 'Recommend an anime to everyone, with an optional message')
    .addStringOption((o) => o.setName('anime').setDescription('Start typing a title…').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('message').setDescription('Why people should watch it (no spoilers!)').setRequired(false).setMaxLength(140)),
  base('stats', 'Watching stats — this month, lifetime and streaks').addUserOption((o) =>
    o.setName('user').setDescription('Whose stats (leave empty for yours)').setRequired(false)
  ),
  base('recap', 'Your monthly anime recap — shareable')
    .addStringOption((o) => o.setName('month').setDescription('Which month (default: this month)').setRequired(false).setAutocomplete(true))
    .addUserOption((o) => o.setName('user').setDescription('Whose recap').setRequired(false))
    .addBooleanOption((o) => o.setName('private').setDescription('Only show it to me').setRequired(false)),
  base('leaderboard', 'Server leaderboards — episodes, streaks, reviews and more').addStringOption((o) =>
    o
      .setName('category')
      .setDescription('Which leaderboard')
      .setRequired(false)
      .addChoices(
        { name: '📺 Episodes this month', value: 'episodes' },
        { name: '🔥 Current streak', value: 'streak' },
        { name: '✅ Completed this month', value: 'completed' },
        { name: '💜 Recommendations', value: 'recommendations' },
        { name: '✍️ Reviews written', value: 'reviews' },
        { name: '❤️ Most helpful reviewers', value: 'helpful' }
      )
  ),
  base('feedback', 'Rate AniTracker and send feedback to the developer'),
  base('help', 'All AniTracker commands and buttons'),
].map((c) => c.toJSON());

module.exports = { commands };
