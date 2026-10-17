const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } = require('discord.js');

const ephemeral = content => ({ content, flags: MessageFlags.Ephemeral });

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('kick').setDescription('Kick a member')
      .addUserOption(o => o.setName('member').setDescription('Who to kick').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Why'))
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .setContexts(InteractionContextType.Guild),
    async execute(interaction) {
      const member = interaction.options.getMember('member');
      const reason = interaction.options.getString('reason') || 'No reason given';
      if (!member) return interaction.reply(ephemeral('That user is not in this server.'));
      if (!member.kickable) return interaction.reply(ephemeral('I cannot kick that member (their role is above mine).'));
      await member.kick(`${reason} — by ${interaction.user.tag}`);
      await interaction.reply(`👢 **${member.user.tag}** was kicked. Reason: ${reason}`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('ban').setDescription('Ban a user')
      .addUserOption(o => o.setName('user').setDescription('Who to ban').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Why'))
      .addIntegerOption(o => o.setName('delete_days').setDescription('Delete their messages from the last N days').setMinValue(0).setMaxValue(7))
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .setContexts(InteractionContextType.Guild),
    async execute(interaction) {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason given';
      const days = interaction.options.getInteger('delete_days') || 0;
      const member = interaction.options.getMember('user');
      if (member && !member.bannable) return interaction.reply(ephemeral('I cannot ban that member (their role is above mine).'));
      await interaction.guild.members.ban(user, { reason: `${reason} — by ${interaction.user.tag}`, deleteMessageSeconds: days * 86400 });
      await interaction.reply(`🔨 **${user.tag}** was banned. Reason: ${reason}`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('timeout').setDescription('Time a member out')
      .addUserOption(o => o.setName('member').setDescription('Who').setRequired(true))
      .addIntegerOption(o => o.setName('minutes').setDescription('How long').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption(o => o.setName('reason').setDescription('Why'))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(InteractionContextType.Guild),
    async execute(interaction) {
      const member = interaction.options.getMember('member');
      const minutes = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason') || 'No reason given';
      if (!member || !member.moderatable) return interaction.reply(ephemeral('I cannot time out that member.'));
      await member.timeout(minutes * 60000, reason);
      await interaction.reply(`⏳ **${member.user.tag}** is timed out for ${minutes} minute(s). Reason: ${reason}`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('purge').setDescription('Delete recent messages in this channel')
      .addIntegerOption(o => o.setName('count').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setContexts(InteractionContextType.Guild),
    async execute(interaction) {
      const count = interaction.options.getInteger('count');
      const deleted = await interaction.channel.bulkDelete(count, true);
      await interaction.reply(ephemeral(`🧹 Deleted ${deleted.size} message(s). Messages older than 14 days cannot be bulk-deleted.`));
    }
  }
];
