require('dotenv').config();
const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
const { generateVouchId } = require('./utils');
const { v4: uuidv4 } = require('uuid');

const emojis = {
  correct: `<a:correct:${process.env.CORRECT_EMOJI}>`,
  wrong: `<a:wrong:${process.env.WRONG_EMOJI}>`,
  pin: `<a:pin:${process.env.PIN_EMOJI}>`,
  alert: `<a:alert_white:${process.env.ALERT_EMOJI}>`,
  dot: `<a:white_dot:${process.env.DOT_EMOJI}>`,
  typing: `<a:Typing:${process.env.TYPING_EMOJI}>`,
  loading: `<a:a_loading:${process.env.LOADING_EMOJI}>`
};

const cooldowns = new Map();
const stickyMessages = new Map();

function generateGuid() {
  return uuidv4();
}

function validateThumbnailUrl(url) {
  if (!url) return null;
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const extension = pathname.match(/\.(png|jpg|jpeg|gif|webp)$/i);
    return extension ? url : null;
  } catch {
    return null;
  }
}

function isOnCooldown(userId, command, cooldownTime = 2) {
  if (!cooldowns.has(command)) cooldowns.set(command, new Map());
  const now = Date.now();
  const timestamps = cooldowns.get(command);
  const cooldownAmount = cooldownTime * 1000;
  if (timestamps.has(userId)) {
    const expirationTime = timestamps.get(userId) + cooldownAmount;
    if (now < expirationTime) return Math.ceil((expirationTime - now) / 1000);
  }
  timestamps.set(userId, now);
  setTimeout(() => timestamps.delete(userId), cooldownAmount);
  return false;
}

function hasPermissions(channel, client, permissions) {
  if (!channel || !client.user) return false;
  const perms = channel.permissionsFor(client.user);
  return perms && perms.has(permissions);
}

async function safeSend(channel, content, client, thumbnailUrl) {
  if (!client?.user || !channel?.isTextBased()) return null;
  if (!hasPermissions(channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) return null;
  try {
    const validatedThumbnail = validateThumbnailUrl(thumbnailUrl) || thumbnailUrl;
    return await channel.send(typeof content === 'string' ? 
      { embeds: [new EmbedBuilder().setDescription(content).setColor('#00FF00').setThumbnail(validatedThumbnail)] } : 
      { ...content, embeds: content.embeds?.map(embed => embed.setThumbnail(validatedThumbnail)) }
    );
  } catch (error) {
    console.error('[ERROR] safeSend failed:', error.message);
    return null;
  }
}

async function safeReply(message, content, client, thumbnailUrl) {
  if (!client?.user || !message?.channel) return null;
  if (!hasPermissions(message.channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) return null;
  try {
    const validatedThumbnail = validateThumbnailUrl(thumbnailUrl) || thumbnailUrl;
    return await message.reply(typeof content === 'string' ? 
      { embeds: [new EmbedBuilder().setDescription(content).setColor('#00FF00').setThumbnail(validatedThumbnail)] } : 
      { ...content, embeds: content.embeds?.map(embed => embed.setThumbnail(validatedThumbnail)) }
    );
  } catch (error) {
    console.error('[ERROR] safeReply failed:', error.message);
    return await safeSend(message.channel, content, client, thumbnailUrl);
  }
}

async function setupPagination(message, embed, items, itemsPerPage, generateEmbed, client, thumbnailUrl) {
  const totalPages = Math.ceil(items.length / itemsPerPage);
  let currentPage = 1;
  if (totalPages <= 1) return await safeReply(message, { embeds: [embed.setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl)] }, client, thumbnailUrl);
  
  embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`).setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl);
  const prevButton = new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(currentPage === 1);
  const nextButton = new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(currentPage === totalPages);
  const row = new ActionRowBuilder().addComponents(prevButton, nextButton);
  const reply = await safeReply(message, { embeds: [embed], components: [row] }, client, thumbnailUrl);
  if (!reply) return;

  const filter = i => ['prev_page', 'next_page'].includes(i.customId) && !i.user.bot && i.user.id === message.author.id;
  const collector = reply.createMessageComponentCollector({ filter, time: 120000 });
  
  collector.on('collect', async interaction => {
    if (interaction.customId === 'next_page' && currentPage < totalPages) currentPage++;
    else if (interaction.customId === 'prev_page' && currentPage > 1) currentPage--;
    else return;
    
    const newEmbed = await generateEmbed(items, currentPage, totalPages);
    const updatedPrevButton = ButtonBuilder.from(prevButton).setDisabled(currentPage === 1);
    const updatedNextButton = ButtonBuilder.from(nextButton).setDisabled(currentPage === totalPages);
    const updatedRow = new ActionRowBuilder().addComponents(updatedPrevButton, updatedNextButton);
    await interaction.update({ embeds: [newEmbed.setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl)], components: [updatedRow] });
  });

  collector.on('end', async () => {
    if (reply.editable) {
      const disabledRow = new ActionRowBuilder().addComponents(
        ButtonBuilder.from(prevButton).setDisabled(true),
        ButtonBuilder.from(nextButton).setDisabled(true)
      );
      await reply.edit({ components: [disabledRow], embeds: [embed.setDescription(embed.description + '\n*Interaction timed out*').setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl)] });
    }
  });
}

async function handleGuildCreate(guild, client, notificationChannelId, thumbnailUrl) {
  if (!client?.user || !guild) return null;
  let inviteLink = 'No invite link generated';
  try {
    const channel = guild.channels.cache.find(c => c.isTextBased() && hasPermissions(c, client, PermissionsBitField.Flags.CreateInstantInvite));
    if (channel) inviteLink = (await channel.createInvite({ maxAge: 86400, maxUses: 1 })).url;
  } catch {}
  return new EmbedBuilder()
    .setTitle(`${emojis.pin} Guild Joined`)
    .setDescription(`${emojis.dot} Joined ${guild.name} (${guild.id}) with ${guild.memberCount} members. Invite: ${inviteLink}`)
    .setColor('#00FF00')
    .setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl)
    .setTimestamp();
}

async function updateStickyMessage(channel, client, thumbnailUrl) {
  if (!channel.isTextBased() || !hasPermissions(channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageMessages])) {
    return;
  }

  try {
    const previousStickyId = stickyMessages.get(channel.id);
    if (previousStickyId) {
      const previousMessage = await channel.messages.fetch(previousStickyId).catch(() => null);
      if (previousMessage) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        await previousMessage.delete().catch(() => {});
      }
    }

    const stickyEmbed = new EmbedBuilder()
      .setTitle(`${emojis.pin} Vouch Guide`)
      .setDescription(
        `${emojis.dot} To vouch for someone, use this format:\n` +
        `\`!vouch @user [message]\` (Proof/Screenshot Required)\n` +
        `- \`@user\`: Mention the user you're vouching for\n` +
        `- \`[message]\`: Optional comment (max 500 chars)\n` +
        `- Attach a screenshot/proof\n` +
        `Example: \`!vouch @Koala Trusted gwapo sarap kalami.\` (with screenshot)`
      )
      .setColor('#0099FF')
      .setFooter({ text: 'Koala Vouch Bot' })
      .setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl);

    const stickyMessage = await safeSend(channel, { embeds: [stickyEmbed] }, client, thumbnailUrl);
    if (stickyMessage) {
      stickyMessages.set(channel.id, stickyMessage.id);
    }
  } catch {}
}

async function initializeStickyMessages(client, allowedChannelIds, thumbnailUrl) {
  for (const channelId of allowedChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel && hasPermissions(channel, client, [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageMessages])) {
      setInterval(() => updateStickyMessage(channel, client, thumbnailUrl), 60000);
      await updateStickyMessage(channel, client, thumbnailUrl);
    }
  }
}

const commands = ['vouch', 'vouchgive', 'vouches', 'vouchhistory', 'vouchremove', 'vouchstats', 'vouchleaderboard', 'vouchsearch', 'vouchtransfer', 'restorevouches', 'help', 'koala'];

async function handleMessage(message, client, Vouch, allowedChannelIds, ownerIds, notificationChannelId, logChannelId, vouchCooldownSeconds, thumbnailUrl) {
  console.log('[DEBUG] Owner IDs:', ownerIds);
  console.log('[DEBUG] Message Author ID:', message.author.id);
  console.log('[DEBUG] Message Channel ID:', message.channel.id);
  console.log('[DEBUG] Allowed Channel IDs:', allowedChannelIds);

  const isOwner = ownerIds.includes(message.author.id);
  const adminCommands = ['vouchgive', 'vouchremove', 'vouchtransfer', 'vouchsearch', 'restorevouches'];
  if (!isOwner && !allowedChannelIds.includes(message.channel.id)) {
    console.log('[DEBUG] Non-owner user attempted command outside allowed channel');
    return;
  }

  if (message.author.bot) return;

  await message.channel.sendTyping();

  let command = message.content.toLowerCase().trim();
  if (command.startsWith('!')) command = command.slice(1).split(/\s+/)[0];
  else if (command.endsWith('!')) command = command.slice(0, -1);
  else command = commands.find(cmd => command === cmd || command.startsWith(`${cmd} `) || command.endsWith(` ${cmd}`)) || '';

  let args = command ? message.content.replace(/!vouch/g, '!vouch').replace(/vouch!/g, '!vouch').trim().split(/\s+/) : [];
  if (command && args[0] === '') args.shift();

  console.log('[DEBUG] Command:', command);
  console.log('[DEBUG] Args:', args);

  if (!commands.includes(command)) return;

  if (!isOwner && adminCommands.includes(command)) {
    const errorEmbed = new EmbedBuilder()
      .setTitle(`${emojis.wrong} Permission Error`)
      .setDescription(`${emojis.alert} Only bot owners can use this command.`)
      .setColor('#FF0000')
      .setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl);
    await safeReply(message, { embeds: [errorEmbed] }, client, thumbnailUrl);
    await message.react(emojis.wrong);
    return;
  }

  if (!isOwner) {
    const cooldown = isOnCooldown(message.author.id, command);
    if (cooldown) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Cooldown`)
            .setDescription(`${emojis.alert} Please wait ${cooldown} seconds before using this command again.`)
            .setColor('#FF0000')
            .setTimestamp()
            .setThumbnail(validateThumbnailUrl(thumbnailUrl) || thumbnailUrl)
        ]
      }, client, thumbnailUrl);
      await message.react(emojis.wrong);
      return;
    }
  }

  const thumbnail = validateThumbnailUrl(thumbnailUrl) || thumbnailUrl;

  if (command === 'koala') {
    const koalaEmbed = new EmbedBuilder()
      .setTitle(`${emojis.pin} Koala Bot`)
      .setDescription(`${emojis.dot} The most kupal bot on Discord!`)
      .addFields(
        { name: `${emojis.alert} Commands`, value: 'Use `!help` to see all commands', inline: true },
        { name: `${emojis.alert} Owner`, value: '<@1139540844853084172>', inline: true },
        { name: `${emojis.alert} Version`, value: '2.0.0', inline: true }
      )
      .setImage(thumbnail)
      .setColor('#00AA00')
      .setFooter({ text: 'Bawal kupal dito.' })
      .setThumbnail(thumbnail);
    await safeReply(message, { embeds: [koalaEmbed] }, client, thumbnail);
    await message.react(emojis.correct);
    return;
  }

  if (command === 'help') {
    const helpEmbed = new EmbedBuilder()
      .setTitle(`${emojis.alert} Koala Bot Help`)
      .setDescription(`${emojis.dot} Here are all available commands:`)
      .addFields(
        {
          name: `${emojis.pin} Vouch Commands`,
          value: '```diff\n' +
            '+ !vouch <@user|userID> [message] - Give someone a vouch\n' +
            '+ !vouches [@user|userID] - Check someone\'s vouches\n' +
            '+ !vouchhistory <@user|userID> - See full vouch history\n' +
            '+ !vouchleaderboard - Top vouched users\n' +
            '```'
        },
        {
          name: `${emojis.alert} Admin Commands`,
          value: '```diff\n' +
            '+ !vouchgive <@user|userID> count message - Give multiple vouches\n' +
            '+ !vouchremove <@user|userID> - Remove vouches\n' +
            '+ !vouchtransfer <@from> <@to> - Transfer vouches\n' +
            '+ !restorevouches - Restore vouches from user\n' +
            '```'
        },
        {
          name: `${emojis.dot} Other`,
          value: '```diff\n' +
            '+ !koala - Show bot owner\n' +
            '+ !help - Display this help message\n' +
            '```'
        }
      )
      .setColor('#0099FF')
      .setFooter({ text: 'Need more help? Contact the bot owner' })
      .setThumbnail(thumbnail);
    
    const loadingMsg = await message.reply(`${emojis.loading} Loading help menu...`);
    await loadingMsg.edit({ 
      content: `${emojis.correct} Help menu loaded!`,
      embeds: [helpEmbed] 
    });
    return;
  }

  if (command === 'vouch') {
    if (args.length < 1 && !message.mentions.users.first()) {
      const embed = new EmbedBuilder()
        .setTitle(`${emojis.pin} Vouch Command Guide`)
        .setDescription(
          `${emojis.dot} How to use !vouch:\n- Syntax: !vouch <@user|userID> [message]\n- <@user|userID>: Mention or ID of user\n- [message]: Optional comment (max 500 chars)\n- Attach a screenshot/proof\nExample: !vouch @Koala Trusted gwapo sarap kalami.\n\nMessage ID: \`${generateGuid()}\``
        )
        .setColor('#FFFF00')
        .setThumbnail(thumbnail);
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
      args.shift();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]).catch(() => null);
        if (!user) {
          await safeReply(message, {
            embeds: [
              new EmbedBuilder()
                .setTitle(`${emojis.wrong} Error`)
                .setDescription(`${emojis.alert} Invalid user ID: \`${args[0]}\`. Please provide a valid user mention or ID.`)
                .setColor('#FF0000')
                .setThumbnail(thumbnail)
            ]
          }, client, thumbnail);
          await message.react(emojis.wrong);
          return;
        }
        args.shift();
      } catch {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Invalid user ID. Please provide a valid user mention or ID.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }
    } else {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} Invalid user input. Please provide a user mention (e.g., @user) or a valid user ID as the first argument.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    if (user.id === message.author.id) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} You can't vouch for yourself.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    const vouchMessage = args.join(' ').substring(0, 500) || 'No comment provided';

    const attachment = message.attachments.first();
    if (!attachment) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} No proof/screenshot attached. Please provide a screenshot to verify the vouch's authenticity.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    if (!isOwner) {
      const lastVouch = await Vouch.findOne({ userId: user.id, vouchedBy: message.author.id, deleted: false }).sort({ timestamp: -1 });
      if (lastVouch) {
        const timeSinceLastVouch = (Date.now() - lastVouch.timestamp) / 1000;
        if (timeSinceLastVouch < vouchCooldownSeconds) {
          const remainingSeconds = Math.ceil(vouchCooldownSeconds - timeSinceLastVouch);
          const minutes = Math.floor(remainingSeconds / 60);
          const seconds = remainingSeconds % 60;
          await safeReply(message, {
            embeds: [
              new EmbedBuilder()
                .setTitle(`${emojis.wrong} Cooldown Error`)
                .setDescription(`${emojis.alert} Wait ${minutes}m ${seconds}s before vouching for this user again.`)
                .setColor('#FF0000')
                .setThumbnail(thumbnail)
            ]
          }, client, thumbnail);
          await message.react(emojis.wrong);
          return;
        }
      }
    }

    try {
      const newVouch = new Vouch({
        userId: user.id,
        vouchedBy: message.author.id,
        points: 1,
        message: vouchMessage,
        vouchId: generateVouchId()
      });
      await newVouch.save();

      const count = await Vouch.countDocuments({ userId: user.id, deleted: false });

      const embed = new EmbedBuilder()
        .setTitle(`${emojis.correct} Vouch Logged`)
        .setDescription(`${emojis.dot} Vouch for ${user.tag} by ${message.author.tag}`)
        .addFields(
          { name: 'Vouches', value: `+1 Vouch`, inline: true },
          { name: 'Comment', value: vouchMessage, inline: false },
          { name: 'Vouch ID', value: `\`${newVouch.vouchId}\``, inline: true }
        )
        .setColor('#00FF00')
        .setFooter({ text: 'Thank you for using Koala Vouch Bot!' })
        .setThumbnail(thumbnail);

      await safeReply(message, { embeds: [embed] }, client, thumbnail);

      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        await safeSend(logChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.pin} Vouch Logged`)
              .setDescription(`${emojis.dot} Vouch for ${user.tag} by ${message.author.tag}\nVouches: +1\nComment: ${vouchMessage}\nVouch ID: \`${newVouch.vouchId}\``)
              .setImage(attachment.url)
              .setColor('#00FF00')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
      }
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch creation failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred while saving the vouch. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchgive') {
  console.log('[DEBUG] Processing !vouchgive command');
  console.log('[DEBUG] Owner IDs:', ownerIds);
  console.log('[DEBUG] Message Author ID:', message.author.id);

  if (!isOwner) {
    console.log('[DEBUG] Non-owner attempted !vouchgive');
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Permission Error`)
          .setDescription(`${emojis.alert} Only bot owners can use this command.`)
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
  }

  console.log('[DEBUG] Raw message content:', message.content);
  console.log('[DEBUG] Initial args:', args);

  if (args.length < 3) {
    console.log('[DEBUG] Insufficient arguments for !vouchgive');
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Usage Error`)
          .setDescription(
            `${emojis.alert} Usage: !vouchgive <@user|userID> count message\n` +
            `Received: ${args.join(' ')}`
          )
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
  }

  let user;
  let shiftedArgs = [...args];
  const userArg = shiftedArgs.shift();

  try {
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
      shiftedArgs.shift();
      console.log('[DEBUG] Found user mention:', user.id, 'Remaining args:', shiftedArgs);
    } else if (/^\d+$/.test(userArg)) {
      user = await client.users.fetch(userArg).catch((err) => {
        console.log('[ERROR] User fetch failed:', err.message);
        return null;
      });
      if (!user) {
        console.log('[DEBUG] Invalid user ID:', userArg);
        throw new Error('User not found');
      }
      console.log('[DEBUG] Found user by ID:', user.id, 'Remaining args:', shiftedArgs);
    } else {
      console.log('[DEBUG] Invalid user format:', userArg);
      throw new Error('Invalid user format');
    }
  } catch (error) {
    console.log('[ERROR] User parsing failed:', error.message);
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Error`)
          .setDescription(
            `${emojis.alert} Please mention a user or provide a valid user ID.\n` +
            `Received: \`${userArg}\`\n` +
            `Error: ${error.message}`
          )
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
  }

  if (shiftedArgs.length < 2) {
    console.log('[DEBUG] Not enough arguments after user:', shiftedArgs);
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Usage Error`)
          .setDescription(
            `${emojis.alert} Not enough arguments.\n` +
            `Usage: !vouchgive <@user|userID> count message\n` +
            `Remaining args: ${shiftedArgs.join(' ')}`
          )
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
  }

  const vouchCount = parseInt(shiftedArgs[0], 10);
  console.log('[DEBUG] Parsed vouch count:', vouchCount);

  if (isNaN(vouchCount) || vouchCount < 1 || vouchCount > 1000) {
    console.log('[DEBUG] Invalid vouch count:', shiftedArgs[0]);
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Error`)
          .setDescription(
            `${emojis.alert} Vouch count must be a number between 1 and 1000.\n` +
            `Received: \`${shiftedArgs[0]}\``
          )
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
  }

  const vouchMessage = shiftedArgs.slice(1).join(' ').trim().substring(0, 500);
  console.log('[DEBUG] Vouch message:', vouchMessage);

  if (!vouchMessage || vouchMessage.length === 0) {
    console.log('[DEBUG] No vouch message provided');
    return await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Error`)
          .setDescription(
            `${emojis.alert} Please provide a message (max 500 characters).\n` +
            `Received: \`${shiftedArgs.slice(1).join(' ')}\``
          )
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
  }

  try {
    const timestamp = new Date();
    const vouches = Array(vouchCount).fill().map(() => ({
      userId: user.id,
      vouchedBy: message.author.id,
      points: 1,
      message: vouchMessage,
      timestamp: timestamp
    }));

    console.log('[DEBUG] Inserting vouches:', vouches.length, 'documents');
    await Vouch.insertMany(vouches, { ordered: false });

    const count = await Vouch.countDocuments({ userId: user.id, deleted: false });
    console.log('[DEBUG] Total vouches for user:', count);

    const embed = new EmbedBuilder()
      .setTitle(`${emojis.correct} Vouches Added`)
      .setDescription(`${emojis.dot} Added ${vouchCount} vouches at <t:${Math.floor(Date.now() / 1000)}:f>`)
      .addFields(
        { name: 'User', value: user.tag, inline: true },
        { name: 'Vouches', value: `+${vouchCount}`, inline: true },
        { name: 'Total Vouches', value: `${count}`, inline: true },
        { name: 'Comment', value: vouchMessage, inline: false }
      )
      .setColor('#00FF00')
      .setFooter({ text: 'Thank you for using Koala Vouch Bot!' })
      .setThumbnail(thumbnail);

    await safeReply(message, { embeds: [embed] }, client, thumbnail);

    const channel = await client.channels.fetch(notificationChannelId).catch(() => null);
    if (channel) {
      await safeSend(channel, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.pin} Vouches Added`)
            .setDescription(
              `${emojis.dot} Added ${vouchCount} vouches for ${user.tag} by ${message.author.tag}`
            )
            .setColor('#00FF00')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
    }
    await message.react(emojis.correct);
  } catch (error) {
    console.error('[ERROR] Vouch processing failed:', error.message, error.stack);
    await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Error`)
          .setDescription(
            `${emojis.alert} Failed to add vouches. Please try again or contact the bot owner.\n` +
            `Error: ${error.message}`
          )
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
    await message.react(emojis.wrong);
  }
  return;
}

  if (command === 'vouches') {
    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
      } catch {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Invalid user ID.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }
    } else {
      user = message.author;
    }

    try {
      const vouches = await Vouch.find({ userId: user.id, deleted: false }).sort({ timestamp: -1 });
      if (vouches.length === 0) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} No Vouches`)
              .setDescription(`${emojis.alert} ${user.tag} has no vouches.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const count = await Vouch.countDocuments({ userId: user.id, deleted: false });
      const latestVouch = vouches[0];

      const embed = new EmbedBuilder()
        .setTitle(`${emojis.pin} Vouch Summary`)
        .setDescription(`${emojis.dot} Vouch details for ${user.tag}`)
        .addFields(
          { name: 'Vouches', value: `${count}`, inline: true },
          { name: 'Last Vouch', value: `<t:${Math.floor(latestVouch.timestamp.getTime() / 1000)}:R>`, inline: true },
          { name: 'Last Comment', value: `${latestVouch.message.substring(0, 50)}${latestVouch.message.length > 50 ? '...' : ''}`, inline: true }
        )
        .setColor('#00FF00')
        .setFooter({ text: `For full history, try !vouchhistory @${user.username}` })
        .setThumbnail(thumbnail);
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouches fetch failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchhistory') {
    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
      } catch {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Invalid user ID.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }
    } else {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Usage Error`)
            .setDescription(`${emojis.alert} Usage: !vouchhistory <@user|userID> [page]`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    try {
      const vouches = await Vouch.find({ userId: user.id, deleted: false }).sort({ timestamp: -1 });
      if (vouches.length === 0) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} No Vouches`)
              .setDescription(`${emojis.alert} ${user.tag} has no vouch history.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const page = parseInt(args[1]) || 1;
      if (page < 1) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Page number must be 1 or greater.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const itemsPerPage = 5;
      const totalPages = Math.ceil(vouches.length / itemsPerPage);
      if (page > totalPages) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Page must be 1-${totalPages}.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const generateEmbed = async (items, currentPage, totalPages) => {
        const start = (currentPage - 1) * itemsPerPage;
        const embed = new EmbedBuilder()
          .setTitle(`${emojis.pin} Vouch History`)
          .setDescription(`${emojis.dot} History for ${user.tag}`)
          .setColor('#00FF00')
          .setThumbnail(thumbnail);
        
        for (let i = start; i < Math.min(start + itemsPerPage, items.length); i++) {
          const vouch = items[i];
          embed.addFields(
            { name: `${i + 1}. By`, value: `<@${vouch.vouchedBy}> on <t:${Math.floor(vouch.timestamp.getTime() / 1000)}:f>`, inline: false },
            { name: 'Vouches', value: `+1`, inline: true },
            { name: 'Message', value: vouch.message || 'No message', inline: false }
          );
        }
        return embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`);
      };

      await setupPagination(message, await generateEmbed(vouches, page, totalPages), vouches, itemsPerPage, generateEmbed, client, thumbnail);
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch history fetch failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchremove') {
    console.log('[DEBUG] Processing !vouchremove command');
    console.log('[DEBUG] Owner IDs:', ownerIds);
    console.log('[DEBUG] Message Author ID:', message.author.id);

    if (!isOwner) {
      console.log('[DEBUG] Non-owner attempted !vouchremove');
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Permission Error`)
            .setDescription(`${emojis.alert} Only bot owners can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    let user;
    if (message.mentions.users.first()) {
      user = message.mentions.users.first();
      console.log('[DEBUG] Found user mention:', user.id);
    } else if (args[0] && !isNaN(args[0])) {
      try {
        user = await client.users.fetch(args[0]);
        console.log('[DEBUG] Found user by ID:', user.id);
      } catch {
        console.log('[DEBUG] Invalid user ID:', args[0]);
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Invalid user ID.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }
    } else {
      console.log('[DEBUG] No user provided for !vouchremove');
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Usage Error`)
            .setDescription(`${emojis.alert} Usage: !vouchremove <@user|userID>`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    try {
      const count = await Vouch.countDocuments({ userId: user.id, deleted: false });
      console.log('[DEBUG] Vouches to remove:', count);
      if (count === 0) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} No Vouches`)
              .setDescription(`${emojis.alert} ${user.tag} has no vouches to remove.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const result = await Vouch.updateMany(
        { userId: user.id, deleted: false },
        { $set: { deleted: true } }
      );
      console.log('[DEBUG] Vouch removal result:', result);

      const embed = new EmbedBuilder()
        .setTitle(`${emojis.correct} Vouch Removal`)
        .setDescription(`${emojis.dot} Removed ${result.modifiedCount} vouches for ${user.tag}.`)
        .setColor('#00FF00')
        .setThumbnail(thumbnail);
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        await safeSend(logChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.pin} Vouches Removed`)
              .setDescription(`${emojis.dot} ${message.author.tag} removed ${result.modifiedCount} vouches for ${user.tag}`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
      }
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch removal failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred while removing vouches. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchstats') {
    try {
      const totalVouches = await Vouch.countDocuments({ deleted: false });
      const topGiver = await Vouch.aggregate([
        { $match: { deleted: false } },
        { $group: { _id: "$vouchedBy", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]);

      const topReceiver = await Vouch.aggregate([
        { $match: { deleted: false } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ]);

      const embed = new EmbedBuilder()
        .setTitle(`${emojis.pin} Vouch Statistics`)
        .setDescription(`${emojis.dot} System statistics`)
        .setColor('#00FF00')
        .addFields(
          { name: 'Total Vouches', value: `${totalVouches}`, inline: true }
        )
        .setThumbnail(thumbnail);

      if (topGiver.length > 0) {
        const giver = await client.users.fetch(topGiver[0]._id).catch(() => ({ tag: 'Unknown User' }));
        embed.addFields({ name: 'Top Vouch Giver', value: `${giver.tag} (${topGiver[0].count} vouches)`, inline: true });
      }

      if (topReceiver.length > 0) {
        const receiver = await client.users.fetch(topReceiver[0]._id).catch(() => ({ tag: 'Unknown User' }));
        embed.addFields({ name: 'Most Vouched User', value: `${receiver.tag} (${topReceiver[0].count} vouches)`, inline: true });
      }

      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch stats failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchleaderboard') {
    try {
      const topUsers = await Vouch.aggregate([
        { $match: { deleted: false } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ]);

      if (topUsers.length === 0) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} No Data`)
              .setDescription(`${emojis.alert} No vouches found.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const page = parseInt(args[0]) || 1;
      if (page < 1) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Page number must be 1 or greater.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const itemsPerPage = 10;
      const totalPages = Math.ceil(topUsers.length / itemsPerPage);
      if (page > totalPages) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Page must be 1-${totalPages}.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const generateEmbed = async (users, currentPage, totalPages) => {
        const start = (currentPage - 1) * itemsPerPage;
        const embed = new EmbedBuilder()
          .setTitle(`${emojis.pin} Vouch Leaderboard`)
          .setDescription(`${emojis.dot} Top vouched users`)
          .setColor('#00FF00')
          .setThumbnail(thumbnail);
        
        for (let i = start; i < Math.min(start + itemsPerPage, users.length); i++) {
          const user = await client.users.fetch(users[i]._id).catch(() => ({ tag: 'Unknown User' }));
          embed.addFields({ name: `${i + 1}.`, value: `${user.tag} - ${users[i].count} vouches`, inline: false });
        }
        return embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`);
      };

      await setupPagination(message, await generateEmbed(topUsers, page, totalPages), topUsers, itemsPerPage, generateEmbed, client, thumbnail);
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch leaderboard failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchsearch') {
    if (!isOwner) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Permission Error`)
            .setDescription(`${emojis.alert} Only bot owners can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    let user = message.mentions.users.first();
    let keyword = args.join(' ');
    let page = 1;
    
    if (user) keyword = args.slice(1).join(' ');
    if (!isNaN(parseInt(args[args.length - 1]))) {
      page = parseInt(args[args.length - 1]);
      keyword = user ? args.slice(1, -1).join(' ') : args.slice(0, -1).join(' ');
    }

    if (!keyword) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Usage Error`)
            .setDescription(`${emojis.alert} Usage: !vouchsearch [@user] keyword [page]`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }
    if (page < 1) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} Page number must be 1 or greater.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    try {
      const query = user 
        ? { userId: user.id, message: { $regex: keyword, $options: 'i' }, deleted: false } 
        : { message: { $regex: keyword, $options: 'i' }, deleted: false };

      const vouches = await Vouch.find(query).sort({ timestamp: -1 });
      if (vouches.length === 0) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} No Results`)
              .setDescription(`${emojis.alert} No vouches found for "${keyword}"${user ? ` for ${user.tag}` : ''}.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const itemsPerPage = 5;
      const totalPages = Math.ceil(vouches.length / itemsPerPage);
      if (page > totalPages) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} Error`)
              .setDescription(`${emojis.alert} Page must be 1-${totalPages}.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const generateEmbed = async (items, currentPage, totalPages) => {
        const start = (currentPage - 1) * itemsPerPage;
        const embed = new EmbedBuilder()
          .setTitle(`${emojis.pin} Vouch Search Results`)
          .setDescription(`${emojis.dot} Search results${user ? ` for ${user.tag}` : ''}\nSearch: \`${keyword}\``)
          .setColor('#00FF00')
          .setThumbnail(thumbnail);
        
        for (let i = start; i < Math.min(start + itemsPerPage, items.length); i++) {
          const vouch = items[i];
          const voucher = await client.users.fetch(vouch.vouchedBy).catch(() => ({ tag: 'Unknown User' }));
          const vouchedUser = await client.users.fetch(vouch.userId).catch(() => ({ tag: 'Unknown User' }));
          embed.addFields(
            { name: `${i + 1}.`, value: `For ${vouchedUser.tag} by ${voucher.tag}`, inline: false },
            { name: 'Vouches', value: `+1`, inline: true },
            { name: 'Message', value: vouch.message || 'No message', inline: false },
            { name: 'Date', value: `<t:${Math.floor(vouch.timestamp.getTime() / 1000)}:f>`, inline: false }
          );
        }
        return embed.setDescription(embed.description + `\nPage ${currentPage}/${totalPages}`);
      };

      await setupPagination(message, await generateEmbed(vouches, page, totalPages), vouches, itemsPerPage, generateEmbed, client, thumbnail);
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch search failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'vouchtransfer') {
    if (!isOwner) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Permission Error`)
            .setDescription(`${emojis.alert} Only authorized users can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    if (message.mentions.users.size < 2) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Usage Error`)
            .setDescription(`${emojis.alert} Usage: !vouchtransfer <@sourceUser> <@targetUser>`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    const sourceUser = message.mentions.users.first();
    const targetUser = message.mentions.users.at(1);
    if (sourceUser.id === targetUser.id) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} Source and target users must be different.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    try {
      const count = await Vouch.countDocuments({ userId: sourceUser.id, deleted: false });
      if (count === 0) {
        await safeReply(message, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.wrong} No Vouches`)
              .setDescription(`${emojis.alert} ${sourceUser.tag} has no vouches to transfer.`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
        await message.react(emojis.wrong);
        return;
      }

      const result = await Vouch.updateMany(
        { userId: sourceUser.id, deleted: false },
        { $set: { userId: targetUser.id } }
      );

      const embed = new EmbedBuilder()
        .setTitle(`${emojis.correct} Vouch Transfer`)
        .setDescription(`${emojis.dot} Transferred ${result.modifiedCount} vouches from ${sourceUser.tag} to ${targetUser.tag}.`)
        .setColor('#00FF00')
        .setThumbnail(thumbnail);
      
      await safeReply(message, { embeds: [embed] }, client, thumbnail);
      
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        await safeSend(logChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.pin} Vouch Transferred`)
              .setDescription(`${emojis.dot} ${message.author.tag} transferred ${result.modifiedCount} vouches from ${sourceUser.tag} to ${targetUser.tag}`)
              .setColor('#FF0000')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
      }

      const notifyChannel = await client.channels.fetch(notificationChannelId).catch(() => null);
      if (notifyChannel) {
        await safeSend(notifyChannel, {
          embeds: [
            new EmbedBuilder()
              .setTitle(`${emojis.pin} Vouch Transfer Notification`)
              .setDescription(`${emojis.dot} Vouches transferred from ${sourceUser.tag} to ${targetUser.tag}`)
              .setColor('#00FF00')
              .setThumbnail(thumbnail)
          ]
        }, client, thumbnail);
      }
      await message.react(emojis.correct);
    } catch (error) {
      console.error('[ERROR] Vouch transfer failed:', error.message);
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Error`)
            .setDescription(`${emojis.alert} An error occurred. Please try again later or contact the bot owner.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
    }
    return;
  }

  if (command === 'restorevouches') {
    if (!isOwner) {
      await safeReply(message, {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${emojis.wrong} Permission Error`)
            .setDescription(`${emojis.alert} Only bot owners can use this command.`)
            .setColor('#FF0000')
            .setThumbnail(thumbnail)
        ]
      }, client, thumbnail);
      await message.react(emojis.wrong);
      return;
    }

    await safeReply(message, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`${emojis.wrong} Not Implemented`)
          .setDescription(`${emojis.alert} The !restorevouches command is not yet implemented.`)
          .setColor('#FF0000')
          .setThumbnail(thumbnail)
      ]
    }, client, thumbnail);
    await message.react(emojis.wrong);
    return;
  }
}

module.exports = { 
  safeSend, 
  safeReply, 
  setupPagination, 
  handleGuildCreate, 
  handleMessage, 
  initializeStickyMessages,
  commands 
};