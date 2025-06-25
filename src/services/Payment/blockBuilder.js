const Caisse = require("../../database/dbModels/Caisse");
const { postSlackMessageWithRetry } = require("../../Handlers/slackApiUtils");

const getFinancePaymentBlocks = (paymentRequest, validatedBy) => [
	// Titre and validated by in the same section

	...getPaymentRequestBlocks(paymentRequest, validatedBy),
	{ type: "divider" },
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
				value: paymentRequest.id_paiement,
			},
		],
	},
	// Block context supplémentaire demandé
	{
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Validé par:* <@${validatedBy}>`,
			},
		],
	},
];
async function generateFundingApprovalPaymentModal(
	context,
	trigger_id,
	messageTs,
	requestId,
	channelId
) {
	console.log(
		`** generateFundingApprovalPaymentModal - messageTs: ${messageTs}, channelId: ${
			channelId || "not provided"
		}`
	);

	// Find the funding request in the database
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});

	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return;
	}

	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		console.error(`Request ${requestId} not found`);
		return;
	}
	const metadata = JSON.stringify({
		requestId: requestId,
		messageTs: messageTs,
		channelId: channelId,
		amount: request.amount, // Include amount
		currency: request.currency, // Include currency
		reason: request.reason, // Include reason
		requestedDate: request.requestedDate, // Include requested date
		submitterName: request.submitterName || request.submittedBy, // Include submitter name
	});
	console.log(`Modal metadata: ${metadata}`);

	// Bank options for dropdown (used later in handlePaymentMethodSelection)

	// Create blocks for the modal
	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Approbation de demande de fonds*\nID: ${requestId}\nMontant: ${
					request.amount
				} ${request.currency}\nMotif: ${request.reason}\nDemandeur: ${
					request.submitterName || request.submittedBy
				}`,
			},
		},
		{
			type: "divider",
		},
		{
			type: "input",
			block_id: "payment_method",
			label: { type: "plain_text", text: "Méthode de paiement" },
			element: {
				type: "radio_buttons",
				action_id: "input_payment_method",
				options: [
					{ text: { type: "plain_text", text: "Espèces" }, value: "cash" },
					{ text: { type: "plain_text", text: "Chèque" }, value: "cheque" },
				],
				initial_option: {
					text: { type: "plain_text", text: "Espèces" },
					value: "cash",
				},
			},
			dispatch_action: true, // Enable block_actions event on selection
		},
		{
			type: "input",
			block_id: "payment_notes",
			optional: true,
			label: { type: "plain_text", text: "Notes (optionnel)" },
			element: {
				type: "plain_text_input",
				action_id: "input_payment_notes",
			},
		},
	];

	const modal = {
		type: "modal",
		callback_id: "submit_finance_details",
		private_metadata: metadata,
		title: { type: "plain_text", text: "Détails financiers" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: blocks,
	};

	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id, view: modal },
			process.env.SLACK_BOT_TOKEN
		);
		console.log(`Modal opened for request ${requestId}`);
	} catch (error) {
		console.error(`Error opening modal for ${requestId}:`, error);
	}
}
// Helper function to get human-readable problem type
function getProblemTypeText(problemType) {
	console.log("** getProblemTypeText");
	const types = {
		wrong_amount: "Montant incorrect",
		wrong_payment_mode: "Mode de paiement incorrect",
		wrong_proof: "Justificatif manquant ou incorrect",
		wrong_bank_details: "Détails bancaires incorrects",
		other: "Autre problème",
	};
	return types[problemType] || problemType;
}

// Reintroduced and optimized getPaymentRequestBlocks
function getPaymentRequestBlocks(paymentRequest) {
	try {
		// Create blocks for notification
		const blocks = [
			{
				type: "header",
				text: {
					type: "plain_text",

					text: `Demande de paiement: ${paymentRequest.id_paiement}`,
					emoji: true,
				},
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Titre:*\n${paymentRequest.titre}`,
					},
					{
						type: "mrkdwn",
						text: `*Date:*\n${new Date(paymentRequest.date).toLocaleString(
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
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Demandeur:*\n<@${paymentRequest.demandeur}>`,
					},
					{
						type: "mrkdwn",
						text: `*Channel:*\n<#${paymentRequest.id_projet}>`,
					},
				],
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Référence:*\n${
							paymentRequest.bon_de_commande || "Non spécifié"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Date requise:*\n${new Date(
							paymentRequest.date_requete
						).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						})}`,
					},
				],
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Montant:*\n${paymentRequest.montant} ${paymentRequest.devise}`,
					},
					{
						type: "mrkdwn",
						text: `*Motif:*\n${paymentRequest.motif || "Non spécifié"}`,
					},
				],
			},
			// ...(paymentRequest.justificatif ? [{
			//   type: "section",
			//   text: { type: "mrkdwn", text: `*Justificatif:*\n<${paymentRequest.justificatif}|Voir le document>` },
			// }] : []),
			// { type: "divider" },
		];

		// Add justificatifs section if any exist
		if (paymentRequest.justificatif && paymentRequest.justificatif.length > 0) {
			let justificatifsText = "*Justificatifs:*\n";

			paymentRequest.justificatif.forEach((doc, index) => {
				if (doc.type === "file") {
					justificatifsText += `• <${doc.url}|Justificatif ${index + 1}>\n`;
				} else if (doc.type === "url") {
					justificatifsText += `• <${doc.url}|Lien externe ${index + 1}>\n`;
				}
			});

			blocks.push({
				type: "section",

				text: {
					type: "mrkdwn",
					text: justificatifsText,
				},
			});
		}

		// Add approval buttons for admin
		blocks.push({
			type: "actions",

			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Approuver",
						emoji: true,
					},
					style: "primary",
					action_id: "approve_payment",
					value: paymentRequest.id_paiement,
				},
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Rejeter",
						emoji: true,
					},
					style: "danger",
					action_id: "reject_order",
					value: paymentRequest.id_paiement,
				},
			],
		});

		// Send confirmation to requester
		const userBlocks = [...blocks];
		// Remove action buttons for user notification
		userBlocks.pop();

		console.log(
			`Payment request notification sent: ${paymentRequest.id_paiement}`
		);
		return userBlocks;
	} catch (error) {
		console.log(`Error in notifyPaymentRequest: ${error}`);
		throw error;
	}
}
module.exports = {
	getFinancePaymentBlocks,
	getPaymentRequestBlocks,
	generateFundingApprovalPaymentModal,
	getProblemTypeText,
};
