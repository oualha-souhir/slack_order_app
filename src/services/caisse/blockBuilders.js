const Caisse = require("../../database/dbModels/Caisse");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { syncCaisseToExcel } = require("./excelSyncService");

require("dotenv").config();
// Generate Funding Request Modal
async function generateFundingRequestForm(context, trigger_id, params) {
	console.log("** generateFundingRequestForm");
	// Validate inputs
	if (!trigger_id) {
		context.log("Error: trigger_id is missing");
		throw new Error("trigger_id is required to open a modal");
	}

	let channelId = params.get("channel_id");
	if (!channelId) {
		context.log(
			"Warning: channel_id is missing in params, falling back to default"
		);
		// Fallback to a default channel or user DM if needed
		channelId = process.env.SLACK_FINANCE_CHANNEL_ID || "unknown";
	}

	context.log(`Generating funding request form with channelId: ${channelId}`);
	const modal = {
		type: "modal",
		callback_id: "submit_funding_request",
		title: { type: "plain_text", text: "Demande de Fonds" },
		private_metadata: JSON.stringify({
			channelId: channelId, // Pass the channel ID
		}),
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "input",
				block_id: "funding_amount",
				element: {
					type: "plain_text_input",
					action_id: "input_funding_amount",
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
				},
				label: { type: "plain_text", text: "Montant" },
			},
			{
				type: "input",
				block_id: "funding_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_funding_reason",
				},
				label: { type: "plain_text", text: "Motif" },
			},
			{
				type: "input",
				block_id: "funding_date",
				element: {
					type: "datepicker",
					action_id: "input_funding_date",
				},
				label: { type: "plain_text", text: "Date Requise" },
			},
		],
	};

	await postSlackMessageWithRetry(
		"https://slack.com/api/views.open",
		{ trigger_id, view: modal },
		process.env.SLACK_BOT_TOKEN
	);
}

// Function to open a modal for rejection reason
async function openRejectionReasonModalFund(payload, requestId) {
	console.log("** openRejectionReasonModalFund");
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: {
					type: "modal",
					callback_id: "reject_funding",

					private_metadata: JSON.stringify({
						requestId: requestId,
						channel_id: payload.channel.id,
						message_ts: payload.message.ts,
					}),
					title: {
						type: "plain_text",
						text: "Motif de rejet",
						emoji: true,
					},
					submit: {
						type: "plain_text",

						text: "Confirmer le rejet",
						emoji: true,
					},
					close: {
						type: "plain_text",
						text: "Annuler",
						emoji: true,
					},
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `Veuillez indiquer la raison du rejet de la demande *${requestId}*`,
							},
						},
						{
							type: "input",
							block_id: "rejection_reason_block",
							element: {
								type: "plain_text_input",
								action_id: "rejection_reason_input",
								multiline: true,
							},
							label: {
								type: "plain_text",
								text: "Motif du rejet",
								emoji: true,
							},
						},
					],
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	} catch (error) {
		console.error("Error opening rejection modal:", error);
		return createSlackResponse(500, "Error opening rejection modal");
	}
}
// Generate modal for correcting funding details
async function generateCorrectionModal(
	context,
	triggerId,
	requestId,
	channelId,
	messageTs
) {
	console.log("** generateCorrectionModal");
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

	const chequeDetails = request.paymentDetails?.cheque || {};

	// Build bank select element
	const chequeBankElement = {
		type: "static_select",
		action_id: "input_cheque_bank",
		options: [
			{
				text: { type: "plain_text", text: "AFG BANK CI" },
				value: "AFGBANK_CI",
			},
			{
				text: { type: "plain_text", text: "AFRILAND FIRST BANK CI" },
				value: "AFRILAND_FIRST_BANK_CI",
			},
			{
				text: { type: "plain_text", text: "BOA - CÔTE D’IVOIRE" },
				value: "BOA_CI",
			},
			{
				text: { type: "plain_text", text: "BANQUE ATLANTIQUE CI (BACI)" },
				value: "BACI",
			},
			{
				text: { type: "plain_text", text: "BANQUE D’ABIDJAN" },
				value: "BANQUE_D_ABIDDAJAN",
			},
			{ text: { type: "plain_text", text: "BHCI" }, value: "BHCI" },
			{ text: { type: "plain_text", text: "BDU-CI" }, value: "BDU_CI" },
			{ text: { type: "plain_text", text: "BICICI" }, value: "BICICI" }, // Shortened from "BANQUE INTERNATIONALE POUR LE COMMERCE ET L’INDUSTRIE DE LA CÔTE D’IVOIRE"
			{ text: { type: "plain_text", text: "BNI" }, value: "BNI" },
			{
				text: { type: "plain_text", text: "BANQUE POPULAIRE CI" },
				value: "BANQUE_POPULAIRE",
			},
			{
				text: { type: "plain_text", text: "BSIC - CÔTE D’IVOIRE" },
				value: "BSIC_CI",
			}, // Shortened from "BANQUE SAHÉLO-SAHARIENNE POUR L’INVESTISSEMENT ET LE COMMERCE - CÔTE D’IVOIRE"
			{
				text: { type: "plain_text", text: "BGFIBANK-CI" },
				value: "BGFIBANK_CI",
			},
			{
				text: { type: "plain_text", text: "BRIDGE BANK GROUP CI" },
				value: "BBG_CI",
			},
			{
				text: { type: "plain_text", text: "CITIBANK CI" },
				value: "CITIBANK_CI",
			},
			{
				text: { type: "plain_text", text: "CORIS BANK INTL CI" },
				value: "CBI_CI",
			},
			{ text: { type: "plain_text", text: "ECOBANK CI" }, value: "ECOBANK_CI" },
			{ text: { type: "plain_text", text: "GTBANK-CI" }, value: "GTBANK_CI" },
			{ text: { type: "plain_text", text: "MANSA BANK" }, value: "MANSA_BANK" },
			{
				text: { type: "plain_text", text: "NSIA BANQUE CI" },
				value: "NSIA_BANQUE_CI",
			},
			{ text: { type: "plain_text", text: "ORABANK CI" }, value: "ORABANK_CI" },
			{
				text: { type: "plain_text", text: "ORANGE BANK AFRICA" },
				value: "ORANGE_BANK",
			},
			{
				text: { type: "plain_text", text: "SOCIETE GENERALE CI" },
				value: "SOCIETE_GENERALE_CI",
			},
			{ text: { type: "plain_text", text: "SIB" }, value: "SIB" },
			{
				text: { type: "plain_text", text: "STANBIC BANK" },
				value: "STANBIC_BANK",
			},
			{
				text: { type: "plain_text", text: "STANDARD CHARTERED CI" },
				value: "STANDARD_CHARTERED_CI",
			},
			{ text: { type: "plain_text", text: "UBA" }, value: "UBA" },
			{
				text: { type: "plain_text", text: "VERSUS BANK" },
				value: "VERSUS_BANK",
			},
			{ text: { type: "plain_text", text: "BMS CI" }, value: "BMS_CI" },
			{ text: { type: "plain_text", text: "BRM CI" }, value: "BRM_CI" },
			{ text: { type: "plain_text", text: "Autre" }, value: "Autre" },
		],
	};

	// // Only add initial_option if there's a valid bank
	// if (chequeDetails.bank) {
	// 	bankOptions.initial_option = {
	// 		text: { type: "plain_text", text: chequeDetails.bank },
	// 		value: chequeDetails.bank,
	// 	};
	// }

	// Build date picker element
	const chequeDateElement = {
		type: "datepicker",
		action_id: "input_cheque_date",
	};
	// Map database payment method to modal options
	// Only add initial_date if there's a valid date
	if (chequeDetails.date && chequeDetails.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
		chequeDateElement.initial_date = chequeDetails.date;
	}
	// Determine payment method code
	// const validPaymentMethods = ["cash", "cheque"];
	let paymentMethod = "cash"; // Default

	// Get raw payment method from DB
	const rawDbMethod = request.paymentDetails?.method;
	console.log("$$ Raw payment method from DB:", rawDbMethod);

	// Normalize the method to a valid system code
	if (rawDbMethod) {
		const normalized = rawDbMethod.trim().toLowerCase();
		if (normalized === "cheque" || normalized === "chèque") {
			paymentMethod = "cheque";
		} else if (
			normalized === "cash" ||
			normalized === "espèces" ||
			normalized === "especes"
		) {
			paymentMethod = "cash";
		}
	}

	// Get display text for selected method
	const displayMethod = getPaymentMethodText(paymentMethod);
	console.log("$$ Selected payment method:", displayMethod);
	const modal = {
		type: "modal",
		callback_id: "correct_fund",
		private_metadata: JSON.stringify({
			entityId: requestId,
			channelId: channelId,
			messageTs: messageTs,
		}),
		title: { type: "plain_text", text: "Corriger les Détails" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Demande*: ${requestId}\n*Montant*: ${request.amount} ${request.currency}\n*Motif*: ${request.reason}`,
				},
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
						text: { type: "plain_text", text: displayMethod },
						value: paymentMethod,
					},
				},
			},
			{
				type: "input",
				block_id: "cheque_number",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_number",
					initial_value: chequeDetails.number || "",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
			{
				type: "input",
				block_id: "cheque_bank",
				optional: true,
				element: chequeBankElement,
				label: { type: "plain_text", text: "Banque" },
			},
			{
				type: "input",
				block_id: "cheque_date",
				optional: true,
				element: chequeDateElement,
				label: { type: "plain_text", text: "Date du Chèque" },
			},
			{
				type: "input",
				block_id: "cheque_order",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_order",
					initial_value: chequeDetails.order || "",
				},
				label: { type: "plain_text", text: "Ordre" },
			},
			// Add new file upload field
			{
				type: "input",
				block_id: "cheque_files",
				optional: true,
				element: {
					type: "file_input",
					action_id: "input_cheque_files",
					filetypes: ["pdf", "png", "jpg", "jpeg"],
					max_files: 3,
				},
				label: { type: "plain_text", text: "Fichiers" },
			},
			// Add URL input field for external links
			{
				type: "input",
				block_id: "cheque_urls",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_urls",
					placeholder: {
						type: "plain_text",
						text: "URLs séparées par des virgules",
					},
				},
				// label: { type: "plain_text", text: "Liens vers les documents (séparés par des virgules)" },
				label: { type: "plain_text", text: "Lien " },
			},
		],
	};

	try {
		console.log("$$ Modal payment method:", request.paymentDetails?.method);
		console.log(
			"$$ Modal payment initial option:",
			modal.blocks[1].element.initial_option
		);
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: triggerId, view: modal },
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Slack API response:", response);
	} catch (error) {
		console.error("Failed to open modal:", error);
	}
}
// Generate Report
async function generateCaisseReport(context, format = "csv") {
	console.log("** generateCaisseReport");
	const caisse = await Caisse.findOne();
	if (!caisse) throw new Error("Caisse non initialisée");

	const reportData = [
		[
			"Date",
			"Type",
			"Montant",
			"Devise",
			"Détails",
			"Solde XOF",
			"Solde USD",
			"Solde EUR",
		],
		...caisse.transactions.map((t) => [
			t.timestamp.toISOString(),
			t.type,
			t.amount,
			t.currency,
			t.details,
			caisse.balances.XOF,
			caisse.balances.USD,
			caisse.balances.EUR,
		]),
	];

	if (format === "csv") {
		const csv = reportData.map((row) => row.join(",")).join("\n");
		return Buffer.from(csv).toString("base64");
	} else {
		// Excel export
		await syncCaisseToExcel(caisse);
		return "Report synced to Excel";
	}
}

// Function to generate modal for check details
async function generateChequeDetailsModal(context, triggerId, requestId) {
	console.log("** generateChequeDetailsModal");
	const modal = {
		type: "modal",
		callback_id: "submit_cheque_details",
		private_metadata: requestId, // Store requestId for use in submission
		title: { type: "plain_text", text: "Détails du Chèque" },
		submit: { type: "plain_text", text: "Approuver" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `Veuillez saisir les détails du chèque pour la demande *${requestId}*`,
				},
			},
			{
				type: "input",
				block_id: "cheque_number",
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_number",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
			{
				type: "input",
				block_id: "bank_name",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_bank_name",
				},
				label: { type: "plain_text", text: "Banque" },
			},
		],
	};

	await postSlackMessageWithRetry(
		"https://slack.com/api/views.open",
		{ trigger_id: triggerId, view: modal },
		process.env.SLACK_BOT_TOKEN
	);
}

// Generate Approval Modal
async function generateFundingApprovalForm(context, trigger_id, requestId) {
	console.log("** generateFundingApprovalForm");
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	const modal = {
		type: "modal",
		callback_id: "approve_funding_request",
		title: { type: "plain_text", text: "Approuver Demande de Fonds" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Demande*: ${request.amount} ${request.currency}\n*Motif*: ${request.reason}`,
				},
			},
			{
				type: "input",
				block_id: "approval_action",
				element: {
					type: "static_select",
					action_id: "select_approval_action",
					options: [
						{
							text: { type: "plain_text", text: "Approuver (Espèces)" },
							value: "approve_cash",
						},
						{
							text: { type: "plain_text", text: "Approuver (Chèque)" },
							value: "approve_cheque",
						},
						{ text: { type: "plain_text", text: "Rejeter" }, value: "reject" },
					],
				},
				label: { type: "plain_text", text: "Action" },
			},
			{
				type: "input",
				block_id: "cheque_details",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_details",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
		],
	};

	await postSlackMessageWithRetry(
		"https://slack.com/api/views.open",
		{ trigger_id, view: modal },
		process.env.SLACK_BOT_TOKEN
	);
}

// Modified original function
function generateFundingDetailsBlocks(
	request,
	paymentMethod,
	paymentNotes,
	paymentDetails,
	userId
) {
	console.log("** generateFundingDetailsBlocks");
	console.log(
		'paymentMethod === "cheque" && paymentDetails.cheque',
		paymentMethod === "cheque" && paymentDetails.cheque
	);
	console.log("paymentMethod", paymentMethod);
	const rawDbMethod = request.paymentDetails?.method;
	console.log("$$ Raw payment method from DB:", rawDbMethod);
	if (rawDbMethod) {
		const normalized = rawDbMethod.trim().toLowerCase().replace(/è/g, "e"); // Normalize accented 'è' to 'e'
		if (normalized === "cheque" || normalized === "chèque") {
			paymentMethod = "cheque";
		} else if (
			normalized === "cash" ||
			normalized === "espèces" ||
			normalized === "especes"
		) {
			paymentMethod = "cash";
		}
	}
	console.log("$$ Normalized payment method:", paymentMethod);
	// Build cheque details for display if applicable
	const additionalDetails =
		paymentMethod === "cheque" && paymentDetails.cheque
			? [
					{
						type: "mrkdwn",
						text: `*Numéro de chèque:*\n${
							paymentDetails.cheque.number || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Banque:*\n${paymentDetails.cheque.bank || "N/A"}`,
					},
					{
						type: "mrkdwn",
						text: `*Date du chèque:*\n${paymentDetails.cheque.date || "N/A"}`,
					},
					{
						type: "mrkdwn",
						text: `*Ordre:*\n${paymentDetails.cheque.order || "N/A"}`,
					},
			  ]
			: [];

	const blocks = [
		{
			type: "divider",
		},
		// Call the new function to include the common request detail blocks
		...generateRequestDetailBlocks(request),
		{
			type: "divider",
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Méthode:* ${getPaymentMethodText(paymentMethod)}`,
				},
				{ type: "mrkdwn", text: `*Notes:* ${paymentNotes || "Aucune"}` },
			],
		},
	];
	console.log("additionalDetails", additionalDetails);
	console.log("additionalDetails.length > 0", additionalDetails.length > 0);

	// Add cheque details sections only if there are additional details
	if (additionalDetails.length > 0) {
		blocks.push({
			type: "section",
			fields: additionalDetails.slice(0, 2), // First 2 fields
		});

		if (additionalDetails.length > 2) {
			blocks.push({
				type: "section",
				fields: additionalDetails.slice(2), // Remaining fields
			});
		}
	}

	// Add proof sections for cheque payments
	if (
		paymentMethod === "cheque" &&
		paymentDetails.cheque &&
		(paymentDetails.cheque.file_ids?.length > 0 ||
			paymentDetails.cheque.urls?.length > 0)
	) {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",

				text: { type: "mrkdwn", text: `*Justificatif(s)*` },
			}
		);
	}

	if (
		paymentMethod === "cheque" &&
		paymentDetails.cheque?.file_ids?.length > 0
	) {
		blocks.push({
			type: "section",

			text: {
				type: "mrkdwn",
				text: `${paymentDetails.cheque.file_ids
					.map((proof, index) => `<${proof}|Preuve ${index + 1}>`)
					.join("\n")}`,
			},
		});
	}

	if (paymentMethod === "cheque" && paymentDetails.cheque?.urls?.length > 0) {
		blocks.push({
			type: "section",

			text: {
				type: "mrkdwn",
				text: `${paymentDetails.cheque.urls
					.map(
						(proof) =>
							`<${proof}|Preuve ${paymentDetails.cheque.file_ids?.length + 1}>`
					)
					.join("\n")}`,
			},
		});
	}

	// Add context block
	blocks.push({
		type: "context",

		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Détails fournis par <@${userId}>* le ${new Date().toLocaleString(
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

	return blocks;
}
// New function to generate common request detail blocks
function generateRequestDetailBlocks(request) {
	return [
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Montant:*\n${request.amount} ${request.currency}`,
				},
				{
					type: "mrkdwn",
					text: `*Motif:*\n${request.reason}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Date requise:*\n${new Date(
						request.requestedDate
					).toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
					})}`,
				},
				{
					type: "mrkdwn",
					text: `*Demandeur:*\n${request.submitterName || request.submittedBy}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Date de soumission:*\n${request.submittedAt.toLocaleString(
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
	];
}
function generateFundingRequestBlocks({
	requestId,
	amount,
	currency,
	reason,
	requestedDate,
	userId}) {
	return [
		{
			type: "divider",
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
				{ type: "mrkdwn", text: `*Montant:*\n${amount} ${currency}` },
				{ type: "mrkdwn", text: `*Motif:*\n${reason}` },
				{
					type: "mrkdwn",
					text: `*Date requise:*\n${
						new Date(requestedDate).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						}) || new Date().toISOString()
					}`,
				},
				{ type: "mrkdwn", text: `*Demandeur:*\n${userId}` },
				{
					type: "mrkdwn",
					text: `*Date de soumission:*\n${new Date().toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					})}`,
				},
			],
		},
	];
}
// Helper function to convert payment method codes to readable text
function getPaymentMethodText(method) {
	console.log("** getPaymentMethodText");
	const methodMap = {
		cash: "Espèces",
		cheque: "Chèque",
		transfer: "Virement",
	};
	return methodMap[method] || method;
}
// function getProblemTypeText(problemType) {
//

// 	return types[problemType] || problemType;
// }
module.exports = {
	generateFundingRequestForm,
	generateFundingRequestBlocks,
	generateRequestDetailBlocks,
	generateFundingDetailsBlocks,
	generateFundingApprovalForm,
	generateChequeDetailsModal,
	generateCorrectionModal,
	generateCaisseReport,
	openRejectionReasonModalFund,
};
