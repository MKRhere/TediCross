"use strict";

/**************************
 * Import important stuff *
 **************************/

const Application = require("../Application");
const messageConverter = require("./messageConverter");
const MessageMap = require("../MessageMap");
const _ = require("lodash");
const mime = require("mime/lite");
const Bridge = require("../bridgestuff/Bridge");
const request = require("request");
const Discord = require("discord.js");

/**
 * Creates a function which sends files from Telegram to discord
 *
 * @param {BotAPI} tgBot	The Telegram bot
 * @param {Discord.Client} dcBot	The Discord bot
 * @param {DiscordUserMap} dcUsers	A map between discord users and their IDs
 * @param {Settings} settings	The settings to use
 *
 * @returns {Function}	A function which can be used to send files from Telegram to Discord
 *
 * @private
 */
function makeFileSender(tgBot, dcBot, dcUsers, settings) {
	/**
	 * Sends a file to Discord
	 *
	 * @param {String} arg.discordChannel Discord channel ID
	 * @param {Message} arg.message	The message the file comes from
	 * @param {String} arg.fileId	ID of the file to download from Telegram's servers
	 * @param {String} arg.fileName	Name of the file to send
	 * @param {String} [arg.caption]	Additional text to send with the file
	 * @param {Boolean} [arg.resolveExtension]	Set to true if the bot should try to find the file extension itself, in which case it will be appended to the file name. Defaults to false
	 */
	return async function (bridge, {message, fileId, fileName, caption = "", resolveExtension = false}) {
		// Make the text to send
		const messageObj = messageConverter(message, dcUsers, tgBot, settings, dcBot, bridge);
		const textToSend = `**${messageObj.from}**:\n${caption}`;

		// Handle for the file extension
		let extension = "";

		// Wait for the Discord bot to become ready
		await dcBot.ready;

		// Start getting the file
		const [file, fileLink] = await Promise.all([tgBot.telegram.getFile(fileId), tgBot.telegram.getFileLink(fileId)]);
		const fileStream = request(fileLink);

		// Get the extension, if necessary
		if (resolveExtension) {
			extension = "." + file.file_path.split(".").pop();
		}

		// Pass it on to Discord
		await dcBot.channels.get(bridge.discord.channelId).send(
			textToSend,
			new Discord.Attachment(fileStream, fileName + extension)
		);
	};
}

/**
 * Makes a name object (for lack of better term) of a user object. It contains the user's full name, and the username or the text `No username`
 *
 * @param {User} user	The user object to make the name object of
 *
 * @returns {Object}	The name object, with `name` and `username` as properties
 */
function makeNameObject(user) {
	// Make the user's full name
	const name = user.first_name
		+ (user.last_name !== undefined
			? " " + user.last_name
			: ""
		);

	// Make the user's username
	const username = user.username !== undefined
		? "@" + user.username
		: "No username";

	return {
		name,
		username
	};
}

/**
 * Curryed function creating handlers handling messages which should not be relayed, and passing through those which should
 *
 * @param {BotAPI} tgBot	The Telegram bot
 * @param {BridgeMap} bridgeMap	Map of the bridges to use
 * @param {Function} func	The message handler to wrap
 * @param {TelegrafContext} ctx	The Telegraf context triggering the wrapped function
 *
 * @private
 */
const createMessageHandler = _.curry((tgBot, bridgeMap, func, ctx) => {
	// Extract the message. Treat ordinary messages and channel posts the same
	let message = null;
	if (ctx.message !== undefined || ctx.channel_post !== undefined) {
		message = ctx.message || ctx.channel_post;
	} else {
		message = ctx.editedMessage;
	}

	if (message.text !== undefined && tgBot.telegram.me !== undefined && message.text.toLowerCase() === `@${tgBot.telegram.me.username} chatinfo`.toLowerCase()) {
		// This is a request for chat info. Give it, no matter which chat this is from
		tgBot.telegram.sendMessage({
			chat_id: message.chat.id,
			text: "chatID: " + message.chat.id
		});
	} else {
		// Get the bridge
		const bridge = bridgeMap.fromTelegramChatId(message.chat.id);

		// Check if the message came from the correct chat
		if (bridge === undefined) {
			// Tell the sender that this is a private bot
			tgBot.telegram.sendMessage({
				chat_id: message.chat.id,
				text: "This is an instance of a [TediCross](https://github.com/TediCross/TediCross) bot, "
					+ "bridging a chat in Telegram with one in Discord. "
					+ "If you wish to use TediCross yourself, please download and create an instance. "
					+ "Join our [Telegram group](https://t.me/TediCrossSupport) or [Discord server](https://discord.gg/MfzGMzy) for help"
				,
				parse_mode: "markdown"
			})
				.catch((err) => {
					// Hmm... Could not send the message for some reason
					Application.logger.error("Could not tell user to get their own TediCross instance:", err, message);
				});
		} else {
			// Do the thing, if this is not a discord-to-telegram bridge
			if (bridge.direction !== Bridge.DIRECTION_DISCORD_TO_TELEGRAM) {
				func(message, bridge);
			}
		}
	}
});

/**
 * Clears the bot's update queue
 *
 * @param {Telegraf} tgBot	The bot to clear the queue of
 *
 * @returns {Number} offset	New offset to use
 */
async function clearOldMessages(tgBot) {
	// Get updates for the bot
	const updates = await tgBot.telegram.getUpdates(0, 100, -1);

	//  Add 1 to the ID of the last one, if there is one
	return updates.length > 0 
		? updates[updates.length-1].update_id + 1
		: 0
	;
}

/**********************
 * The setup function *
 **********************/

/**
 * Sets up the receiving of Telegram messages, and relaying them to Discord
 *
 * @param {BotAPI} tgBot	The Telegram bot
 * @param {Discord.Client} dcBot	The Discord bot
 * @param {DiscordUserMap} dcUsers	A map between discord users and their IDs
 * @param {MessageMap} messageMap	Map between IDs of messages
 * @param {BridgeMap} bridgeMap	Map of the bridges to use
 * @param {Settings} settings	The settings to use
 */
async function setup(tgBot, dcBot, dcUsers, messageMap, bridgeMap, settings) {
	// Ignore existing updates if `skipOldMessages` is true
	let initialPollOffset = 0;
	if (settings.telegram.skipOldMessages) {
		initialPollOffset = await clearOldMessages(tgBot);
	}

	// Start longpolling
	tgBot.polling.offset = initialPollOffset;
	tgBot.startPolling();

	// Make the file sender
	const sendFile = makeFileSender(tgBot, dcBot, dcUsers, settings);

	// Create the message handler wrapper
	const wrapFunction = createMessageHandler(tgBot, bridgeMap);

	// Set up event listener for text messages from Telegram
	tgBot.on("text", wrapFunction(async (message, bridge) => {

		// Turn the text discord friendly
		const messageObj = messageConverter(message, dcUsers, tgBot, settings, dcBot, bridge);

		try {
			// Pass it on to Discord when the dcBot is ready
			await dcBot.ready;

			// Discord doesn't handle messages longer than 2000 characters. Split it up into chunks that big
			const chunks = messageObj.composed.match(/[\s\S]{1,2000}/g);

			// Get the channel to send to
			const channel = dcBot.channels.get(bridge.discord.channelId);

			// Send them in serial
			let dcMessage = null;
			for (const chunk of chunks) {
				dcMessage = await channel.send(chunk);
			}

			// Make the mapping so future edits can work XXX Only the last chunk is considered
			messageMap.insert(MessageMap.TELEGRAM_TO_DISCORD, message.message_id, dcMessage.id);
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Discord did not accept a text message:`, err);
			Application.logger.error(`[${bridge.name}] Failed message:`, message.text);
		}
	}));

	// Set up event listener for photo messages from Telegram
	tgBot.on("photo", wrapFunction(async (message, bridge) => {
		try {
			await sendFile(bridge, {
				message,
				fileId: message.photo[message.photo.length-1].file_id,
				fileName: "photo.jpg",	// Telegram will convert it to jpg no matter what filetype is actually sent
				caption: message.caption
			});
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not send photo`, err);
		}
	}));

	// Set up event listener for stickers from Telegram
	tgBot.on("sticker", wrapFunction(async (message, bridge) => {
		try {
			await sendFile(bridge, {
				message,
				fileId: message.sticker.thumb.file_id,
				fileName: "sticker.webp",	// Telegram will insist that it is a jpg, but it really is a webp
				caption: settings.telegram.sendEmojiWithStickers ? message.sticker.emoji : undefined
			});
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not send sticker`, err);
		}
	}));

	// Set up event listener for filetypes not caught by the other filetype handlers
	tgBot.on("document", wrapFunction(async (message, bridge) => {
		// message.file_name can for some reason be undefined some times.  Default to "file.ext"
		let fileName = message.document.file_name;
		if (fileName === undefined) {
			fileName = "file." + mime.getExtension(message.document.mime_type);
		}

		try {
			// Pass it on to Discord
			await sendFile(bridge, {
				message,
				fileId: message.document.file_id,
				fileName: fileName,
				resolveExtension: false
			});
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not send document`, err);
		}
	}));

	// Set up event listener for voice messages
	tgBot.on("voice", wrapFunction(async (message, bridge) => {
		try {
			await sendFile(bridge, {
				message,
				fileId: message.voice.file_id,
				fileName: "voice" + "." + mime.getExtension(message.voice.mime_type),
				resolveExtension: false
			});
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not send voice`, err);
		}
	}));

	// Set up event listener for audio messages
	tgBot.on("audio", wrapFunction(async (message, bridge) => {
		try {
			await sendFile(bridge, {
				message,
				fileId: message.audio.file_id,
				fileName: message.audio.title,
				resolveExtension: true
			});
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not send audio`, err);
		}
	}));

	// Set up event listener for video messages
	tgBot.on("video", wrapFunction(async (message, bridge) => {
		try {
			await sendFile(bridge, {
				message,
				caption: message.caption,
				fileId: message.video.file_id,
				fileName: "video" + "." + mime.getExtension(message.video.mime_type),
				resolveExtension: false
			});
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not send video`, err);
		}
	}));

	// Listen for users joining the chat
	tgBot.on("new_chat_members", wrapFunction(({new_chat_members}, bridge) => {
		// Ignore it if the settings say no
		if (!bridge.telegram.relayJoinMessages) {
			return;
		}

		// Notify Discord about each user
		new_chat_members.forEach(async (user) => {
			// Make the text to send
			const nameObj = makeNameObject(user);
			const text = `**${nameObj.name} (${nameObj.username})** joined the Telegram side of the chat`;

			try {
				// Pass it on
				await dcBot.ready;
				await dcBot.channels.get(bridge.discord.channelId).send(text);
			} catch (err) {
				Application.logger.error(`[${bridge.name}] Could not notify Discord about a user that joined Telegram`, err);
			}
		});
	}));

	// Listen for users leaving the chat
	tgBot.on("left_chat_member", wrapFunction(async ({left_chat_member}, bridge) => {
		// Ignore it if the settings say no
		if (!bridge.telegram.relayLeaveMessages) {
			return;
		}

		// Make the text to send
		const nameObj = makeNameObject(left_chat_member);
		const text = `**${nameObj.name} (${nameObj.username})** left the Telegram side of the chat`;

		try {
			// Pass it on when Discord is ready
			await dcBot.ready;
			await dcBot.channels.get(bridge.discord.channelId).send(text);
		} catch (err) {
			Application.logger.error(`[${bridge.name}] Could not notify Discord about a user that left Telegram`, err);
		}
	}));

	// Set up event listener for message edits
	tgBot.on("edited_message", wrapFunction(async (tgMessage, bridge) => {
		try {
			// Wait for the Discord bot to become ready
			await dcBot.ready;

			// Try to get the corresponding message in Discord
			const dcMessageId = await messageMap.getCorresponding(MessageMap.TELEGRAM_TO_DISCORD, tgMessage.message_id);

			// Get the message from Discord
			const dcMessage = await dcBot.channels.get(bridge.discord.channelId).fetchMessage(dcMessageId);

			const messageObj = messageConverter(tgMessage, dcUsers, tgBot, settings, dcBot, bridge);

			// Try to edit the message
			await dcMessage.edit(messageObj.composed);
		} catch (err) {
			// Log it
			Application.logger.error(`[${bridge.name}] Could not edit Discord message:`, err);
		}
	}));

	// Make a promise which resolves when the dcBot is ready
	tgBot.telegram.ready = tgBot.telegram.getMe()
		.then((bot) => {
			// Log the bot's info
			Application.logger.info(`Telegram: ${bot.username} (${bot.id})`);

			// Put the data on the bot
			tgBot.telegram.me = bot;
		})
		.catch((err) => {
			// Log the error(
			Application.logger.error("Failed at getting the Telegram bot's me-object:", err);

			// Pass it on
			throw err;
		});
}

/*****************************
 * Export the setup function *
 *****************************/

module.exports = setup;
