const Order = require("../../database/dbModels/Order");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");
const axios = require("axios");
const { getProformaBlocks, getOrderBlocks } = require("./blockBuilders");
const {
	getOrderMessageFromDB,
	saveOrderMessageToDB,
} = require("../../database/databaseUtils");
const { getPaymentRequestBlocks } = require("../Payment/blockBuilder");

async function notifyAdmin(
	order,
	context,
	isEdit = false,
	admin_action = false,
	status
) {
	console.log("** notifyAdmin");
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const blocks = [
		...(isEdit
			? [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Commande modifiée: ${order.id_commande}*`,
						},
					},
			  ]
			: []),
		...getOrderBlocks(order, requestDate),
		...getProformaBlocks(order),
		...(!admin_action
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Approuver", emoji: true },
								style: "primary",
								action_id: "payment_verif_accept",
								value: order.id_commande,
							},
							{
								type: "button",
								text: { type: "plain_text", text: "Rejeter", emoji: true },
								style: "danger",
								action_id: "reject_order",
								value: order.id_commande,
							},
						],
					},
					{
						type: "context",
						elements: [
							{ type: "mrkdwn", text: "⏳ En attente de votre validation" },
						],
					},
			  ]
			: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `Demande ${status}e avec succués`,
						},
					},
			  ]),
	];

	const existingMessage = await getOrderMessageFromDB(order.id_commande);
	if (existingMessage && isEdit) {
		return await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: existingMessage.channel,
				ts: existingMessage.ts,
				text: `Commande modifiée: ${order.id_commande}`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
	} else {
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Commande reçue: ${order.id_commande}`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		await saveOrderMessageToDB(order.id_commande, {
			channel: response.channel,
			ts: response.ts,
			orderId: order.id_commande,
		});
		return response;
	}
}

async function notifyUser(order, userId, context) {
	console.log("** notifyUser");
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const blocks = [
		...getOrderBlocks(order, requestDate),
		...getProformaBlocks(order),
		...(order.statut === "En attente"
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Modifier", emoji: true },
								style: "primary",
								action_id: "edit_order",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "⏳ Votre commande est soumise avec succès ! Un administrateur va la vérifier sous 24h.",
				},
			],
		},
	];

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{ channel: userId, text: `✅ Commande *${order.id_commande}*`, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
async function sendDelayReminder(order, context, type = "admin") {
	console.log("** sendDelayReminder");
	const reminderId = `REMINDER-${order.id_commande}-${Date.now()}`;
	console.log(
		`sendDelayReminder1 for order ${order.id_commande}, type: ${type}, reminderId: ${reminderId}`
	);

	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const normalizedType = type.toLowerCase();

	console.log(
		`Received type: '${type}' for order ${order.id_commande}, normalized to '${normalizedType}', reminderId: ${reminderId}`
	);

	let inferredType = normalizedType;
	if (
		order.statut === "Validé" &&
		order.proformas.length === 0 &&
		normalizedType === "admin"
	) {
		inferredType = "proforma";
		console.log(
			`Overriding type from 'admin' to 'proforma' for order ${order.id_commande}, reminderId: ${reminderId}`
		);
	} else if (
		order.statut === "Validé" &&
		order.payments.length === 0 &&
		order.proformas.length > 0 &&
		normalizedType === "admin"
	) {
		inferredType = "payment";
		console.log(
			`Overriding type from 'admin' to 'payment' for order ${order.id_commande}, reminderId: ${reminderId}`
		);
	}

	const channel =
		inferredType === "proforma"
			? process.env.SLACK_ACHAT_CHANNEL_ID
			: inferredType === "payment"
			? process.env.SLACK_FINANCE_CHANNEL_ID
			: process.env.SLACK_ADMIN_ID;

	if (!channel) {
		console.log(
			`Error: Channel is undefined for type '${inferredType}', reminderId: ${reminderId}`
		);
		throw new Error(`No valid channel defined for type '${inferredType}'`);
	}

	console.log(
		`Sending delay reminder for order ${order.id_commande} with type '${inferredType}' to channel ${channel}`
	);

	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*⚠️ Alerte : ${
					inferredType === "proforma"
						? "Proforma"
						: inferredType === "payment"
						? "Paiement"
						: "Commande"
				} en attente*\n\nLa commande *${order.id_commande}* est ${
					inferredType === "payment" ? "validée" : "en attente"
				} depuis plus de 24 heures.`,
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Date de création:* ${order.createdAt.toLocaleString()}`,
			},
		},
		...getOrderBlocks(order, requestDate),
		...getProformaBlocks(order),
		...(inferredType === "payment"
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Enregistrer paiement",
									emoji: true,
								},
								style: "primary",
								action_id: "finance_payment_form",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
		...(inferredType === "proforma"
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Ajouter des proformas",
									emoji: true,
								},
								style: "primary",
								action_id: "proforma_form",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
		...(inferredType != "proforma" && inferredType != "payment"
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Autoriser", emoji: true },
								style: "primary",
								action_id: "payment_verif_accept",
								value: order.id_commande,
							},
							{
								type: "button",
								text: { type: "plain_text", text: "Rejeter", emoji: true },
								style: "danger",
								action_id: "reject_order",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
	];

	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel,
				text: `⏰ Commande en attente dépassant 24h (${inferredType}) [reminderId: ${reminderId}]`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			console
		);
		console.log(
			`Successfully sent reminder for ${order.id_commande} to ${channel}, reminderId: ${reminderId}`
		);
	} catch (error) {
		console.log(
			`Failed to send reminder for ${order.id_commande} to ${channel}: ${error.message}, reminderId: ${reminderId}`
		);
		throw error;
	}

	await Order.findOneAndUpdate(
		{ id_commande: order.id_commande },
		{
			$set: { [`${inferredType}_reminder_sent`]: true },
			$push: {
				delay_history: {
					type: `${inferredType}_reminder`,
					timestamp: new Date(),
					reminderId, // Store reminderId for traceability
				},
			},
		}
	);
}
async function notifyUserAI(order, userId, logger, messageOverride) {
	console.log("** notifyUserAI");
	logger.log(`Sending notification to ${userId}: ${messageOverride}`);

	try {
		const slackToken = process.env.SLACK_BOT_TOKEN;

		if (!slackToken) {
			throw new Error("SLACK_BOT_TOKEN not configured");
		}

		const slackMessage = {
			channel: userId, // Make sure this is the correct Slack user ID (starts with U) or channel ID
			text: messageOverride,
		};

		logger.log(`Posting to Slack: ${JSON.stringify(slackMessage)}`);

		const response = await axios.post(
			"https://slack.com/api/chat.postMessage",
			slackMessage,
			{
				headers: {
					Authorization: `Bearer ${slackToken}`,
					"Content-Type": "application/json",
				},
			}
		);

		logger.log(`Slack response: ${JSON.stringify(response.data)}`);

		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}

		return { success: true, data: response.data };
	} catch (error) {
		logger.log(`Notification error: ${error.message}`);
		return { success: false, error: error.message };
	}
}

async function updateSlackMessageWithReason1(
	user,
	channelId,
	messageTs,
	orderId,
	status,
	reason,
	order
) {
	console.log("** updateSlackMessageWithReason1");
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			text: `Commande *${orderId}* - *${status}*`,
			blocks: [
				...getPaymentRequestBlocks(order),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `❌ - *REJETÉE* par <@${user}> le ${new Date().toLocaleString(
							"fr-FR"
						)}`,
					},
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Motif de rejet: ${reason}`,
					},
				},
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}
// Update Slack message to include rejection reason
async function updateSlackMessageWithReason(
	user,
	channelId,
	messageTs,
	orderId,
	status,
	reason,
	order
) {
	console.log("** updateSlackMessageWithReason");
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			text: `Commande *${orderId}* - *${status}*`,
			blocks: [
				...getOrderBlocks(order),
				...getProformaBlocks(order),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `❌ - *REJETÉE par* <@${user}> le ${new Date().toLocaleString(
							"fr-FR"
						)}`,
					},
				},

				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Motif de rejet: ${reason}`,
					},
				},
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}
// Helper function to update the Slack message
async function updateSlackMessage1(payload, paymentId, status) {
	console.log("** updateSlackMessage1");
	const updatedBlocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `Commande *${paymentId}* a été *${status}* par <@${payload.user.id}>`,
			},
		},
		// No actions block here, so buttons disappear
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `✅ Traitement terminé le ${new Date().toLocaleDateString()}`,
				},
			],
		},
	];

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: payload.channel?.id || process.env.SLACK_ADMIN_ID, // Use the original channel
			ts: payload.message?.ts, // Use the original message timestamp
			blocks: updatedBlocks,
			text: `Commande ${paymentId} mise à jour`,
		},
		process.env.SLACK_BOT_TOKEN
	);
}
// Update the original function to include rejection reason
// async function updateSlackMessage(payload, orderId, status, reason = null) {
// 	console.log("** updateSlackMessage");

// 	const blocks = [
// 		{
// 			type: "section",
// 			text: {
// 				type: "mrkdwn",
// 				text: `*Commande ID:* ${orderId}\n*Statut:* *${status}*${
// 					reason ? `Motif de rejet: ${reason}` : ""
// 				}`,
// 			},
// 		},
// 	];
// }

// Notify requester with rejection reason
async function notifyRequesterWithReason(order, rejectionReason) {
	console.log("** notifyRequesterWithReason");
	console.log("order", order);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: order.demandeur,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text:
							"❌ Demande de paiement: " +
							order.id_paiement +
							" - Rejetée" +
							` par <@${
								order.rejectedByName
							}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
						emoji: true,
					},
				},
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}
async function updateExistingOrderMessages(
	order,
	existingMetadata,
	channelId,
	userId,
	context,
	slackToken
) {
	const messageBlocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Commande ID:* ${order.id_commande}\n*Statut:* ${order.statut}`,
			},
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Modifier" },
					action_id: "edit_order",
					value: order.id_commande,
				},
			],
		},
	];

	await Promise.all([
		postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: channelId,
				ts: existingMetadata.messageTs,
				text: `Commande *${order.id_commande}* - Modifiée`,
				blocks: messageBlocks,
			},
			slackToken
		),
		// notifyUser(order, userId, context, "✅ Votre commande a été modifiée avec succès."),
		notifyUser(order, userId, context),

		notifyAdmin(order, context, true),
	]);
}
module.exports = {
	notifyAdmin,
	notifyUser,
	sendDelayReminder,
	notifyUserAI,
	updateSlackMessageWithReason,
	// updateSlackMessage,
	updateSlackMessageWithReason1,
	notifyRequesterWithReason,
	updateExistingOrderMessages,
	updateSlackMessage1,
};
