const { createSlackResponse } = require("../../Handlers/slackApiUtils");
const { notifyPaymentRequest } = require("../Notifications/Payment");
const { notifyUserAI } = require("../Order/orderNotificationService");
const { parsePaymentFromText } = require("../../Handlers/Utils");
const { handlePaymentReport } = require("./paymentReportService");
const { createAndSavePaymentRequest } = require("./paymentRequestService");

// Separate handler for payment commands
async function handlePaymentCommand(
	requestData,
	userPermissions,
	logger,
	context
) {
	const { text, userId } = requestData;
	const { isAdmin } = userPermissions;

	// Handle payment text parsing
	if (text.toLowerCase().includes("montant")) {
		return await handlePaymentTextParsing(text, requestData, logger);
	}

	// Handle payment reports
	if (text.trim().startsWith("report")) {
		return await handlePaymentReport(text, requestData, isAdmin, context);
	}

	// Show default payment options
	return await showPaymentOptions(userId);
}

async function handlePaymentTextParsing(text, requestData, logger) {
	const { userId, userName, channelId, channelName } = requestData;

	logger.log(`Received payment text: "${text}"`);
	logger.log("Starting AI payment parsing...");

	setImmediate(async () => {
		try {
			const parsedPayment = await parsePaymentFromText(text, logger);
			logger.log(`Parsed payment: ${JSON.stringify(parsedPayment)}`);

			if (parsedPayment.montant && parsedPayment.montant > 0) {
				logger.log(`Channel name resolved: ${channelId}`);
				const requestedDate = new Date(parsedPayment.date_requise);
				const currentDate = new Date();

				if (requestedDate < currentDate) {
					logger.log(
						"Invalid payment request - requested date is in the past."
					);
					await notifyUserAI(
						{ id: "N/A" },
						channelId,
						logger,
						"⚠️ *Erreur*: La date sélectionnée est dans le passé."
					);
					return;
				}

				const newPaymentRequest = await createAndSavePaymentRequest(
					userId,
					userName,
					channelId,
					channelName,
					{
						request_title: {
							input_request_title: {
								value: parsedPayment.titre || "Demande de paiement sans titre",
							},
						},
						request_date: {
							input_request_date: {
								selected_date:
									parsedPayment.date_requise ||
									new Date().toISOString().split("T")[0],
							},
						},
						payment_reason: {
							input_payment_reason: {
								value: parsedPayment.motif || "Motif non spécifié",
							},
						},
						amount_to_pay: {
							input_amount_to_pay: {
								value: `${parsedPayment.montant} ${
									parsedPayment.devise || "XOF"
								}`,
							},
						},
						po_number: {
							input_po_number: {
								value: parsedPayment.bon_de_commande || null,
							},
						},
					},
					logger
				);

				logger.log(
					`Payment request created: ${JSON.stringify(newPaymentRequest)}`
				);
				await notifyPaymentRequest(newPaymentRequest, logger, userId);
			} else {
				logger.log("No valid payment amount found in parsed request.");
				await notifyUserAI(
					{ id_paiement: "N/A" },
					userId,
					logger,
					"Aucun montant valide détecté dans votre demande de paiement."
				);
			}
		} catch (error) {
			logger.log(`Background payment request creation error: ${error.stack}`);
			await notifyUserAI(
				{ id_paiement: "N/A" },
				channelId,
				logger,
				`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
			);
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Demande de paiement en cours de traitement... Vous serez notifié(e) bientôt !",
	});
}
async function showPaymentOptions(userId) {
	return createSlackResponse(200, {
		response_type: "ephemeral",
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: "👋 Bienvenue",
					emoji: true,
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle demande de paiement :`,
				},
			},
			{
				type: "divider",
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Option 1:* Créez une demande de paiement rapide avec la syntaxe suivante :",
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "```\n/payment titre: [Titre de la demande] date requise: yyyy-mm-dd motif: [Raison du paiement] montant: [Montant] [Devise] bon de commande: [Numéro de bon, optionnel]\n```",
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "💡 *Exemple:* `/payment titre: Achat de matériel informatique date requise: 2025-12-12 motif: Remplacement ordinateurs défaillants montant: 50000 XOF bon de commande: PO-2025-001A`",
					},
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Option 2:* Utilisez le formulaire ci-dessous",
				},
			},
		],
		text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser le formulaire ci-dessous.`,
		attachments: [
			{
				callback_id: "finance_payment_form",
				actions: [
					{
						name: "finance_payment_form",
						type: "button",
						text: "💰 Demande de paiement",
						value: "open",
						action_id: "finance_payment_form",
						style: "primary",
					},
				],
			},
		],
	});
}
module.exports = {
	handlePaymentCommand,
	handlePaymentTextParsing,
	showPaymentOptions,
};
