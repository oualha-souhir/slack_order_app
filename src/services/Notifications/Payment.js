const { fetchEntity } = require("../../database/databaseUtils");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");
const {
	getPaymentRequestBlocks,
	getFinancePaymentBlocks,
} = require("../Payment/blockBuilder");
const PaymentRequest = require("../../database/dbModels/PaymentRequest");
const { getPaymentBlocks } = require("../Order/blockBuilders");

// New function to notify both admin and demandeur about payment requests
async function notifyPaymentRequest(
	paymentRequest,
	context,
	validatedBy = null
) {
	console.log("** notifyPaymentRequest");
	const adminBlocks = [
		...getPaymentRequestBlocks(paymentRequest, validatedBy),
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Autoriser", emoji: true },
					style: "primary",
					action_id: "payment_verif_accept",
					value: paymentRequest.id_paiement,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Rejeter", emoji: true },
					style: "danger",
					action_id: "reject_order",
					value: paymentRequest.id_paiement,
				},
			],
		},
		{
			type: "context",
			elements: [{ type: "mrkdwn", text: "⏳ En attente de validation" }],
		},
	];
	console.log("paymentRequest.statut", paymentRequest);

	const demandeurBlocks = [
		...getPaymentRequestBlocks(paymentRequest, validatedBy),
		// Add edit button only if payment is still pending
		// ...(paymentRequest.statut === "En attente"
		//   ? [
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Modifier", emoji: true },
					style: "primary",
					action_id: "edit_payment",
					value: paymentRequest.id_paiement,
				},
			],
		},

		// : []),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "✅ Votre demande de paiement a été soumise. En attente de validation par un administrateur.",
				},
			],
		},
	];

	try {
		// Notify Admin
		context.log(
			`Sending payment request notification to admin channel: ${process.env.SLACK_ADMIN_ID}`
		);
		const adminResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Nouvelle demande de paiement *${paymentRequest.id_paiement}* par <@${paymentRequest.demandeur}>`,
				blocks: adminBlocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		if (!adminResponse.ok)
			throw new Error(`Admin notification failed: ${adminResponse.error}`);

		// Notify Demandeur
		context.log(
			`Sending payment request notification to demandeur: ${paymentRequest.demandeur}`
		);
		console.log("paymentRequest.demandeur", paymentRequest.demandeur);
		const demandeurResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: paymentRequest.demandeurId,
				text: `Demande de paiement *${paymentRequest.id_paiement}* soumise`,
				blocks: demandeurBlocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Save message details in the database
		await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentRequest.id_paiement },
			{
				demandeur_message: {
					channel: paymentRequest.demandeurId,
					ts: demandeurResponse.ts,
				},
				admin_message: {
					channel: process.env.SLACK_ADMIN_ID,
					ts: adminResponse.ts,
				},
			},
			{ new: true }
		);
		if (!demandeurResponse.ok)
			throw new Error(
				`Demandeur notification failed: ${demandeurResponse.error}`
			);

		return { adminResponse, demandeurResponse };
	} catch (error) {
		context.log(`❌ notifyPaymentRequest failed: ${error.message}`);
		throw error;
	}
}
async function notifyFinancePayment(paymentRequest, context, validatedBy) {
	console.log("** notifyFinancePayment");
	try {
		context.log(
			`Sending payment notification to finance channel: ${process.env.SLACK_FINANCE_CHANNEL_ID}`
		);
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `💰 Demande de paiement *${paymentRequest.id_paiement}* validée par admin`,
				blocks: getFinancePaymentBlocks(paymentRequest, validatedBy),
			},
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`notifyFinancePayment response: ${JSON.stringify(response)}`);
		if (!response.ok) {
			throw new Error(`Slack API error: ${response.error}`);
		}
		return response; // Optional, if you need the response elsewhere
	} catch (error) {
		context.log(`❌ notifyFinancePayment failed: ${error.message}`);
		throw error; // Rethrow to handle in caller if needed
	}
}
async function notifyPayment(
	entityId,
	notifyPaymentData,
	totalAmountDue,
	remainingAmount,
	paymentStatus,
	context,
	target,
	userId
) {
	console.log("** notifyPayment");
	console.log("target", target);
	const entity = await fetchEntity(entityId, context);
	console.log("userId", userId);

	// const validatedBy = entityId.validatedBy || "unknown";
	if (!entity) return;

	const blocks = await getPaymentBlocks(
		entity,
		notifyPaymentData,
		remainingAmount,
		paymentStatus
	);
	console.log("FIN getPaymentBlocks");

	const channel =
		target === "finance"
			? process.env.SLACK_FINANCE_CHANNEL_ID
			: target === "admin"
			? process.env.SLACK_ADMIN_ID
			: entity.demandeurId;
	const text = `💲 Paiement Enregistré pour ${entityId}`;
	if (target === "finance" && remainingAmount > 0) {
		blocks.push({
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
					value: entityId,
				},
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Signaler un problème",
						emoji: true,
					},
					style: "danger",
					action_id: "report_problem",
					value: entityId,
				},
			],
		});
	}
	if (target === "user") {
		blocks.push({
			type: "actions",

			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Signaler un problème",
						emoji: true,
					},
					style: "danger",
					action_id: "report_problem",
					value: entityId,
				},
			],
		});
	}

	blocks.push({
		type: "context",

		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Détails financiers fournis par <@${userId}>* le ${new Date().toLocaleString(
					"fr-FR",
					{
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					}
				)}`,
			},
		],
	});

	const response = await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{ channel, text, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);
	console.log("1Slack API response:", response);
	if (!response.ok) {
		console.error(
			`❌ Failed to notify ${target} about payment for ${entityId}: ${response.error}`
		);
	}

	console.log(`${target} notified about payment for ${entityId}`);
}

module.exports = {
	notifyPaymentRequest,
	notifyFinancePayment,
	notifyPayment,
};
