const {
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  EmbedBuilder,
} = require('discord.js');

// /feedback — a single Discord form (modal) with:
//   ★ rating (1-5, required)  — a dropdown, since Discord forms have no star widget
//   title     (required)
//   message   (required)
// Submissions are stored with the rest of the bot's data and show up in the
// developer portal's Feedback tab.

const MODAL_ID = 'feedback_modal';
const RATING_ID = 'feedback_rating';
const TITLE_ID = 'feedback_title';
const MESSAGE_ID = 'feedback_message';
const COOLDOWN_MS = 60 * 1000;
const FEEDBACK_COLOR = 0xffb703;

const RATING_OPTIONS = [
  { value: '5', label: '★★★★★  Amazing', description: 'Love it' },
  { value: '4', label: '★★★★☆  Great', description: 'Really good, a few things to improve' },
  { value: '3', label: '★★★☆☆  Okay', description: 'It works, but could be better' },
  { value: '2', label: '★★☆☆☆  Not great', description: 'Some real problems' },
  { value: '1', label: '★☆☆☆☆  Bad', description: 'Something is really wrong' },
];

function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function buildFeedbackModal() {
  const rating = new StringSelectMenuBuilder()
    .setCustomId(RATING_ID)
    .setPlaceholder('Pick a rating')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(RATING_OPTIONS);

  const title = new TextInputBuilder()
    .setCustomId(TITLE_ID)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. "Love the streak counter" or "Buttons stopped working"')
    .setMinLength(3)
    .setMaxLength(100)
    .setRequired(true);

  const message = new TextInputBuilder()
    .setCustomId(MESSAGE_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Tell us what you think — bugs, ideas, anything. The more detail the better!')
    .setMinLength(10)
    .setMaxLength(2000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Send feedback to TV Tracker')
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('Thanks for helping make TV Tracker better! Everything here goes straight to the developer.')
    )
    .addLabelComponents(
      new LabelBuilder().setLabel('Rating').setDescription('How would you rate TV Tracker overall?').setStringSelectMenuComponent(rating),
      new LabelBuilder().setLabel('Title').setDescription('A short summary').setTextInputComponent(title),
      new LabelBuilder().setLabel('Message').setTextInputComponent(message)
    );
}

// Returns { rating, title, message } or null if something's missing/invalid.
function readFeedbackSubmission(interaction) {
  let ratingValue = null;
  try {
    ratingValue = interaction.fields.getStringSelectValues(RATING_ID)?.[0];
  } catch {
    ratingValue = null;
  }
  const rating = parseInt(ratingValue, 10);
  const title = (interaction.fields.getTextInputValue(TITLE_ID) || '').trim();
  const message = (interaction.fields.getTextInputValue(MESSAGE_ID) || '').trim();
  if (!(rating >= 1 && rating <= 5) || !title || !message) return null;
  return { rating, title, message };
}

function buildThanksEmbed(entry) {
  return new EmbedBuilder()
    .setColor(FEEDBACK_COLOR)
    .setAuthor({ name: 'Feedback sent — thank you! 💛' })
    .setTitle(entry.title)
    .setDescription(`**${stars(entry.rating)}**  ${entry.rating}/5\n\n${entry.message.length > 1000 ? `${entry.message.slice(0, 1000)}…` : entry.message}`)
    .setFooter({ text: 'Only you can see this • The developer reads every submission' })
    .setTimestamp(new Date(entry.createdAt));
}

module.exports = {
  MODAL_ID,
  COOLDOWN_MS,
  buildFeedbackModal,
  readFeedbackSubmission,
  buildThanksEmbed,
};
