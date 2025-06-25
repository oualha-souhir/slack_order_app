const Order = require("../../database/dbModels/Order");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Handlers/slackApiUtils");
const { bankOptions, extractAndValidateUrl } = require("../../Handlers/Utils");
const { handleModifyPayment } = require("./paymentModalService");
const PaymentRequest = require("../../database/dbModels/PaymentRequest");
const Caisse = require("../../database/dbModels/Caisse");
const {
	calculateTotalAmountDue,
	handlePayment,
} = require("./paymentProcessingService.js");
const { notifyPayment } = require("../Notifications/Payment.js");
const { syncCaisseToExcel } = require("../caisse/excelSyncService");

// const { WebClient } = require("@slack/web-api");
async function handlePaymentFormSubmission(payload, context) {
	console.log("** payment_form_submission");
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Process in background
	setImmediate(async () => {
		try {
			// Extract form data
			const formData = payload.view.state.values;
			const paymentMode =
				formData.payment_mode?.select_payment_mode?.selected_option?.value;
			const paymentTitle = formData.payment_title?.input_payment_title?.value;
			const amountPaid = parseFloat(
				formData.amount_paid?.input_amount_paid?.value
			);
			console.log("amountPaid", amountPaid);
			const paymentProofs =
				formData.payment_proof_unique?.input_payment_proof?.files?.map(
					(file) => file.url_private
				) || [];
			const paymentUrl =
				formData.paiement_url?.input_paiement_url?.value || null;

			// Get order ID from metadata
			const metadata = JSON.parse(payload.view.private_metadata);
			console.log("metadata11", metadata);
			const orderId = metadata.orderId;
			const userId = payload.user.id;
			const slackToken = process.env.SLACK_BOT_TOKEN;

			// Validate inputs for non-cash payments
			if (
				paymentMode !== "Espèces" &&
				(!paymentProofs || paymentProofs.length === 0) &&
				(!paymentUrl || paymentUrl.trim() === "")
			) {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_FINANCE_CHANNEL_ID,
						text: "❌ Erreur : Veuillez fournir soit un fichier de preuve de paiement, soit une URL de paiement.",
					},
					slackToken
				);
				return;
			}

			// For non-cash payments, validate URL if provided
			let validURL = true;
			if (paymentMode !== "Espèces" && paymentUrl && paymentUrl.trim() !== "") {
				validURL = await extractAndValidateUrl(
					paymentUrl,
					[],
					userId,
					slackToken
				);
				if (!validURL) {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: process.env.SLACK_FINANCE_CHANNEL_ID,
							text: "⚠️ L'URL du justificatif n'est pas valide.",
						},
						slackToken
					);
					return;
				}
			}

			// Find and validate document (order or payment request) before processing
			let document;
			let currency = "XOF"; // Default currency

			if (orderId.startsWith("CMD/")) {
				document = await Order.findOne({ id_commande: orderId });
				if (!document) {
					throw new Error(`Order ${orderId} not found`);
				}
			} else if (orderId.startsWith("PAY/")) {
				document = await PaymentRequest.findOne({ id_paiement: orderId });
				if (!document) {
					throw new Error(`Payment request ${orderId} not found`);
				}
			} else {
				throw new Error("Invalid orderId format");
			}

			// Get currency from document
			if (
				document.proformas &&
				document.proformas.length > 0 &&
				document.proformas[0].validated === true
			) {
				currency = document.proformas[0].devise;
				context.log("Currency found:", currency);
			} else {
				context.log("Proforma is not validated or does not exist");
			}

			// For cash payments, check if there's enough balance in the cash register
			if (paymentMode === "Espèces") {
				// Get current caisse state
				const caisse = await Caisse.findOne({});
				if (!caisse) {
					throw new Error("Caisse document not found");
				}

				// Check if there will be enough balance after transaction
				const currentBalance = caisse.balances[currency] || 0;

				const projectedBalance = currentBalance - amountPaid;
				context.log("Current balance:", currentBalance);
				context.log("Projected balance:", projectedBalance);

				// If balance will be negative, BLOCK the transaction
				if (projectedBalance < 0) {
					context.log(
						`❌ Error: Insufficient funds in Caisse for ${currency}. Current: ${currentBalance}, Required: ${amountPaid}`
					);
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: process.env.SLACK_FINANCE_CHANNEL_ID,
							text: `❌ PAIEMENT BLOQUÉ : Solde insuffisant dans la caisse pour ${currency}. Solde actuel: ${currentBalance}, Montant nécessaire: ${amountPaid}. Veuillez recharger la caisse avant de procéder au paiement.`,
						},
						slackToken
					);

					// Also notify the user who submitted the payment
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: payload.user.id,
							text: `❌ Paiement en espèces refusé pour ${orderId} : Solde insuffisant dans la caisse pour ${currency}. L'équipe des finances a été notifiée.`,
						},
						slackToken
					);

					// Exit completely - don't process any part of this payment
					return;
				}
			}

			// Extract mode-specific details
			let paymentDetails = {};
			switch (paymentMode) {
				case "Chèque":
					paymentDetails = {
						cheque_number: formData.cheque_number?.input_cheque_number?.value,
						cheque_bank:
							formData.cheque_bank?.input_cheque_bank?.selected_option?.value,
						cheque_date: formData.cheque_date?.input_cheque_date?.selected_date,
						cheque_order: formData.cheque_order?.input_cheque_order?.value,
					};
					break;
				case "Virement":
					paymentDetails = {
						virement_number:
							formData.virement_number?.input_virement_number?.value,
						virement_bank:
							formData.virement_bank?.input_virement_bank?.selected_option
								?.value,
						virement_date:
							formData.virement_date?.input_virement_date?.selected_date,
						virement_order:
							formData.virement_order?.input_virement_order?.value,
					};
					break;
				case "Mobile Money":
					paymentDetails = {
						mobilemoney_recipient_phone:
							formData.mobilemoney_recipient_phone
								?.input_mobilemoney_recipient_phone?.value,
						mobilemoney_sender_phone:
							formData.mobilemoney_sender_phone?.input_mobilemoney_sender_phone
								?.value,
						mobilemoney_date:
							formData.mobilemoney_date?.input_mobilemoney_date?.selected_date,
					};
					break;
				case "Julaya":
					paymentDetails = {
						julaya_recipient:
							formData.julaya_recipient?.input_julaya_recipient?.value,
						julaya_date: formData.julaya_date?.input_julaya_date?.selected_date,
						julaya_transaction_number:
							formData.julaya_transaction_number
								?.input_julaya_transaction_number?.value,
					};
					break;
				case "Espèces":
					// No additional fields required
					break;
				default:
					throw new Error("Unknown payment mode");
			}

			// Create payment data object
			const paymentData = {
				paymentMode,
				amountPaid,
				paymentTitle,
				paymentProofs,
				paymentUrl,
				details: paymentDetails,
				dateSubmitted: new Date(),
			};

			// Calculate total amount due
			const totalAmountDue = await calculateTotalAmountDue(orderId, context);
			console.log("totalAmountDue", totalAmountDue);
			// Update document with payment data
			if (orderId.startsWith("CMD/")) {
				document = await Order.findOneAndUpdate(
					{ id_commande: orderId },
					{
						$push: { payments: paymentData },
						$set: { totalAmountDue },
					},
					{ new: true }
				);
			} else if (orderId.startsWith("PAY/")) {
				document = await PaymentRequest.findOneAndUpdate(
					{ id_paiement: orderId },
					{ $push: { payments: paymentData }, $set: { totalAmountDue } },
					{ new: true }
				);
			}

			// Update payment status
			const { newAmountPaid, paymentStatus, remainingAmount } =
				await handlePayment(orderId, amountPaid, totalAmountDue, context);
			console.log("amountPaid", amountPaid);
			console.log("newAmountPaid", newAmountPaid);
			console.log("remainingAmount", remainingAmount);
			console.log("totalAmountDue", totalAmountDue);

			// Update status in database
			if (orderId.startsWith("CMD/")) {
				await Order.updateOne(
					{ id_commande: orderId },
					{
						$set: {
							paymentStatus,
							amountPaid: newAmountPaid,
							remainingAmount,
						},
					}
				);
			} else if (orderId.startsWith("PAY/")) {
				await PaymentRequest.updateOne(
					{ id_paiement: orderId },
					{
						$set: {
							paymentStatus,
							amountPaid: newAmountPaid,
							remainingAmount,
						},
					}
				);
			}

			// Update Caisse balance if payment mode is Espèces
			if (paymentMode === "Espèces") {
				// At this point, we've already checked that the balance is sufficient
				const caisseUpdate = {
					$inc: { [`balances.${currency}`]: -amountPaid }, // Subtract amountPaid from the currency balance
					$push: {
						transactions: {
							type: "payment",
							amount: -amountPaid, // Negative to indicate a deduction
							currency,
							orderId,
							details: `Payment for ${paymentTitle} (Order: ${orderId})`,
							timestamp: new Date(),
							paymentMethod: "Espèces",
							paymentDetails,
						},
					},
				};

				const updatedCaisse = await Caisse.findOneAndUpdate(
					{}, // Assuming a single Caisse document; adjust query if needed
					caisseUpdate,
					{ new: true }
				);

				if (!updatedCaisse) {
					throw new Error("Caisse document not found");
				}
				context.log(
					`New caisse balance for ${currency}: ${updatedCaisse.balances[currency]}`
				);

				// After updating the Caisse balance, sync with Excel
				if (updatedCaisse.latestRequestId) {
					await syncCaisseToExcel(updatedCaisse, updatedCaisse.latestRequestId);
					context.log(
						`Excel file updated for latest request ${updatedCaisse.latestRequestId} with new balance for ${currency}`
					);
				} else {
					context.log(
						"No latestRequestId found in Caisse, skipping Excel sync"
					);
				}

				// Notify finance team about the successful cash payment
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_FINANCE_CHANNEL_ID,
						text: `✅ Paiement en espèces traité pour ${orderId}. Nouveau solde de la caisse pour ${currency}: ${updatedCaisse.balances[currency]}.`,
					},
					slackToken
				);
			}

			// Prepare notification data
			const notifyPaymentData = {
				title: paymentData.paymentTitle,
				mode: paymentData.paymentMode,
				amountPaid: paymentData.amountPaid,
				date: paymentData.dateSubmitted,
				url: paymentData.paymentUrl,
				proofs: paymentData.paymentProofs,
				details: paymentData.details,
			};

			console.log("payload.user.id", payload.user.id);
			console.log("userId", userId);
			// Notify teams
			await Promise.all([
				notifyPayment(
					orderId,
					notifyPaymentData,
					totalAmountDue,
					remainingAmount,
					paymentStatus,
					context,
					"finance",
					payload.user.id
				),
				notifyPayment(
					orderId,
					notifyPaymentData,
					totalAmountDue,
					remainingAmount,
					paymentStatus,
					context,
					"user",
					payload.user.id
				),
				notifyPayment(
					orderId,
					notifyPaymentData,
					totalAmountDue,
					remainingAmount,
					paymentStatus,
					context,
					"admin",
					payload.user.id
				),
			]).catch((error) =>
				context.log(`❌ Erreur lors des notifications: ${error}`)
			);
		} catch (error) {
			context.log(
				`Background processing error for payment submission: ${error.message}\nStack: ${error.stack}`
			);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.user.id,
					text: `❌ Erreur lors du traitement du paiement pour la commande. Veuillez contacter le support. Détails : ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return context.res;
}

async function PaymentForm(payload, context) {
	try {
		console.log("aaaa ");
		const view = generatePaymentRequestForm({});

		if (payload.channel && payload.channel.id) {
			view.private_metadata = JSON.stringify({
				channelId: payload.channel.id,
			});
		}

		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Full postSlackMessage response:", JSON.stringify(response));
		console.log("Returning context.res:", JSON.stringify(context.res));
		context.log(`views.open response: ${JSON.stringify(response)}`);
		if (!response.ok) {
			context.log(`views.open error: ${response.error}`);
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: `❌ Erreur: ${response.error}`,
			});
		}
		if (response.warning) {
			console.log("views.open warning:", response.warning);
			// Optionally handle warnings without showing an error to the user
		}
		return createSlackResponse(200, "");
	} catch (error) {
		context.log(
			`❌ Error opening payment form: ${error.message}\nStack: ${error.stack}`
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: Impossible d'ouvrir le formulaire de paiement (${error.message})`,
		});
	}
}
async function generatePaymentForm({
	payload,
	action,
	context,
	selectedPaymentMode,
	orderId,
}) {
	console.log("** generatePaymentForm");
	context.log("Opening payment modal for order:", action.value);
	context.log("Génération du formulaire pour le mode:", selectedPaymentMode);

	// Parse private_metadata if available (for updates from modal)
	const privateMetadata = payload.view
		? JSON.parse(payload.view.private_metadata || "{}")
		: {};
	const effectiveOrderId = orderId || privateMetadata.orderId || action.value;
	const originalChannel =
		privateMetadata.originalChannel || (payload.channel && payload.channel.id);

	let blocks = [
		{
			type: "input",
			block_id: "payment_mode",
			label: { type: "plain_text", text: "Mode de paiement" },
			element: {
				type: "static_select",
				action_id: "select_payment_mode",
				options: [
					{ text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
					{ text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
					{ text: { type: "plain_text", text: "Virement" }, value: "Virement" },
					{
						text: { type: "plain_text", text: "Mobile Money" },
						value: "Mobile Money",
					},
					{ text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
				],
				...(selectedPaymentMode && {
					initial_option: {
						text: { type: "plain_text", text: selectedPaymentMode },
						value: selectedPaymentMode,
					},
				}),
			},
		},

		{
			type: "actions",
			block_id: "confirm_payment_mode",
			elements: [
				{
					type: "button",
					action_id: "confirm_payment_mode",
					text: { type: "plain_text", text: "Ajouter les détails " },
					value: "confirm_payment_mode",
				},
			],
		},
		{
			type: "context",
			elements: [
				{
					type: "plain_text",
					text: "⚠️ Vous devez ajouter les détails du paiement pour les modes de paiement : chèque, virement, mobile money et julaya.",
				},
			],
		},
		{
			type: "input",
			block_id: "payment_proof_unique",
			optional: true,
			label: {
				type: "plain_text",
				text: "📎 Justificatif de paiement ",
			},
			element: {
				type: "file_input",
				action_id: "input_payment_proof",
				filetypes: ["pdf", "png", "jpg", "jpeg"],
				max_files: 5,
			},
		},
		{
			type: "input",
			block_id: "paiement_url",
			optional: true,
			label: { type: "plain_text", text: "🔗 URL paiement" },
			element: {
				type: "plain_text_input",
				action_id: "input_paiement_url",
				placeholder: { type: "plain_text", text: "https://..." },
			},
		},
		{
			type: "input",
			block_id: "payment_title",
			label: { type: "plain_text", text: "Intitulé du paiement" },
			element: {
				type: "plain_text_input",
				action_id: "input_payment_title",
				// initial_value: "Acompte 1",
			},
		},
		{
			type: "input",
			block_id: "amount_paid",
			label: { type: "plain_text", text: "Montant payé" },
			element: {
				type: "number_input",
				action_id: "input_amount_paid",
				is_decimal_allowed: true,
				min_value: "0",
			},
		},
	];

	// Add dynamic fields based on selected payment mode
	if (selectedPaymentMode === "Chèque") {
		blocks.push(
			{ type: "divider" },

			{
				type: "input",
				block_id: "cheque_number",
				label: { type: "plain_text", text: "Numéro du chèque" },
				element: {
					action_id: "input_cheque_number",
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
				},
			},
			{
				type: "input",
				block_id: "cheque_bank",
				label: { type: "plain_text", text: "Banque" },
				element: {
					type: "static_select",
					action_id: "input_cheque_bank",

					options: bankOptions,
				},
			},
			{
				type: "input",
				block_id: "cheque_date",
				label: { type: "plain_text", text: "Date du chèque" },
				element: { type: "datepicker", action_id: "input_cheque_date" },
			},
			{
				type: "input",
				block_id: "cheque_order",
				label: { type: "plain_text", text: "Ordre" },
				element: { type: "plain_text_input", action_id: "input_cheque_order" },
			}
		);
	} else if (selectedPaymentMode === "Virement") {
		blocks.push(
			{ type: "divider" },
			{
				type: "input",
				block_id: "virement_number",
				label: { type: "plain_text", text: "Numéro de virement" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_virement_number",
				},
			},
			{
				type: "input",
				block_id: "virement_bank",
				label: { type: "plain_text", text: "Banque" },
				element: {
					type: "static_select",
					action_id: "input_virement_bank",
					options: bankOptions,
				},
			},
			{
				type: "input",
				block_id: "virement_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_virement_date" },
			},
			{
				type: "input",
				block_id: "virement_order",
				label: { type: "plain_text", text: "Ordre" },
				element: {
					type: "plain_text_input",
					action_id: "input_virement_order",
				},
			}
		);
	} else if (selectedPaymentMode === "Mobile Money") {
		blocks.push(
			{ type: "divider" },
			{
				type: "input",
				block_id: "mobilemoney_recipient_phone",
				label: { type: "plain_text", text: "Numéro de téléphone bénéficiaire" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_mobilemoney_recipient_phone",
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_sender_phone",
				label: { type: "plain_text", text: "Numéro envoyeur" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_mobilemoney_sender_phone",
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_mobilemoney_date" },
			}
		);
	} else if (selectedPaymentMode === "Julaya") {
		blocks.push(
			{ type: "divider" },
			{
				type: "input",
				block_id: "julaya_recipient",
				label: { type: "plain_text", text: "Bénéficiaire" },
				element: {
					type: "plain_text_input",
					action_id: "input_julaya_recipient",
				},
			},
			{
				type: "input",
				block_id: "julaya_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_julaya_date" },
			},
			{
				type: "input",
				block_id: "julaya_transaction_number",
				label: { type: "plain_text", text: "Numéro de transaction" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_julaya_transaction_number",
				},
			}
		);
	}

	const view = {
		type: "modal",
		callback_id: "payment_form_submission",
		title: { type: "plain_text", text: "Formulaire Paiement" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: blocks,
		private_metadata: JSON.stringify({
			orderId: effectiveOrderId,
			originalChannel: originalChannel,
		}),
	};

	// context.log("Final view structure:", JSON.stringify(view, null, 2));

	// Use views.update if called from a modal, views.open if initial call
	const apiEndpoint = payload.view
		? "https://slack.com/api/views.update"
		: "https://slack.com/api/views.open";
	const requestBody = payload.view
		? { view_id: payload.view.id, hash: payload.view.hash, view }
		: { trigger_id: payload.trigger_id, view };

	const response = await postSlackMessageWithRetry(
		apiEndpoint,
		requestBody,
		process.env.SLACK_BOT_TOKEN
	);

	if (!response.ok) {
		context.log(
			`❌ ${apiEndpoint.split("/").pop()} failed: ${JSON.stringify(
				response,
				null,
				2
			)}`
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `Erreur: ${response.error}`,
		});
	}

	return {
		statusCode: 200,
		headers: { "Content-Type": "application/json" },
		body: "",
	};
}
function generatePaymentRequestForm(existingData = {}) {
	console.log("** generatePaymentRequestForm");
	const view = {
		type: "modal",
		callback_id: "payment_request_submission",
		title: { type: "plain_text", text: "Demande de Paiement", emoji: true },
		submit: { type: "plain_text", text: "Soumettre", emoji: true },
		close: { type: "plain_text", text: "Annuler", emoji: true },
		blocks: [
			{
				type: "input",
				block_id: "request_title",
				element: {
					type: "plain_text_input",
					action_id: "input_request_title",
					// initial_value:
					//   // existingData.title ||
					//   "Entrez le titre",
				},
				label: { type: "plain_text", text: "Titre de la demande", emoji: true },
			},
			{
				type: "input",
				block_id: "request_date",
				element: {
					type: "datepicker",
					action_id: "input_request_date",
					initial_date:
						existingData.date || new Date().toISOString().split("T")[0],
				},
				label: { type: "plain_text", text: "Date de la requête", emoji: true },
			},
			{
				type: "input",
				block_id: "payment_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_reason",
					multiline: true,
					initial_value: existingData.reason || "",
				},
				label: { type: "plain_text", text: "Motif du paiement", emoji: true },
			},
			{
				type: "input",
				block_id: `amount_to_pay`,
				label: { type: "plain_text", text: "Montant" },
				element: {
					type: "plain_text_input",
					action_id: `input_amount_to_pay`,
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
					initial_value: existingData.amount || "",
				},
				hint: {
					type: "plain_text",
					text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
				},
			},

			{
				type: "input",
				block_id: "po_number",
				optional: false,
				element: {
					type: "plain_text_input",
					action_id: "input_po_number",

					// initial_value: existingData.poNumber || "",
				},
				label: {
					type: "plain_text",
					text: "Référence",
					emoji: true,
				},
			},

			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs*",
				},
			},
			{
				type: "input",
				block_id: "justificatif",
				optional: false,
				label: {
					type: "plain_text",

					text: "Fichiers justificatifs",
					emoji: true,
				},
				element: {
					type: "file_input",
					action_id: "input_justificatif",
					filetypes: ["pdf", "doc", "docx", "jpg", "jpeg", "png"],
					max_files: 10, // Allow multiple files
				},
			},
			{
				type: "input",
				block_id: "justificatif_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "URL du justificatif (optionnel)",
					emoji: true,
				},
				element: {
					type: "plain_text_input",
					action_id: "input_justificatif_url",
					placeholder: {
						type: "plain_text",
						text: "https://...",
					},
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "Vous pouvez ajouter plusieurs fichiers ou une URL externe. Au moins un justificatif est recommandé.",
					},
				],
			},

			// Include these blocks in your payment request modal
		],
	};
	return view;
}
// Function to handle the dynamic mode selection - for Action Response
// async function handlePaymentModeSelection(payload, context) {
// 	console.log("** handlePaymentModeSelection");
// 	const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 	try {
// 		const selectedMode = payload.actions[0].selected_option.value;
// 		const viewId = payload.view.id;
// 		const privateMetadata = payload.view.private_metadata;

// 		// Get the current blocks
// 		let blocks = payload.view.blocks;

// 		// Find the index where mode-specific blocks would start
// 		// Typically after the payment_mode block
// 		let insertIndex =
// 			blocks.findIndex((block) => block.block_id === "payment_mode") + 1;

// 		// Remove any existing payment-specific blocks (between mode selection and URL)
// 		const urlIndex = blocks.findIndex(
// 			(block) => block.block_id === "payment_url"
// 		);
// 		if (urlIndex > insertIndex) {
// 			blocks = [...blocks.slice(0, insertIndex), ...blocks.slice(urlIndex)];
// 		}

// 		// Insert new blocks based on mode
// 		let newBlocks = [];
// 		switch (selectedMode) {
// 			case "Chèque":
// 				newBlocks = createChequeBlocks({});
// 				break;
// 			case "Virement":
// 				newBlocks = createVirementBlocks({});
// 				break;
// 			case "Mobile Money":
// 				newBlocks = createMobileMoneyBlocks({});
// 				break;
// 			case "Julaya":
// 				newBlocks = createJulayaBlocks({});
// 				break;
// 			// No blocks for Espèces
// 		}
// 		if (selectedMode === "Espèces") {
// 			try {
// 				await deductCashForPayment(orderId, payment, context);
// 			} catch (error) {
// 				return createSlackResponse(400, `Erreur: ${error.message}`);
// 			}
// 		}
// 		// Insert the new blocks
// 		blocks.splice(insertIndex, 0, ...newBlocks);

// 		// Update the view
// 		await slack.views.update({
// 			view_id: viewId,
// 			view: {
// 				type: "modal",
// 				callback_id: "payment_modification_modal",
// 				private_metadata: privateMetadata,
// 				title: {
// 					type: "plain_text",
// 					text: "Modifier le paiement",
// 					emoji: true,
// 				},
// 				submit: {
// 					type: "plain_text",
// 					text: "Enregistrer",
// 					emoji: true,
// 				},
// 				close: {
// 					type: "plain_text",
// 					text: "Annuler",
// 					emoji: true,
// 				},
// 				blocks: blocks,
// 			},
// 		});
// 	} catch (error) {
// 		context.log.error(`Error handling payment mode selection: ${error}`);
// 	}
// }
async function handleConfirmPaymentMode(payload, context) {
	context.log("** Processing confirm_payment_mode");

	const selectedMode =
		payload.view.state.values.payment_mode?.select_payment_mode?.selected_option
			?.value;

	if (!selectedMode) {
		context.log("No payment mode selected");
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "Veuillez sélectionner un mode de paiement avant de confirmer.",
		});
	}

	const privateMetadata = JSON.parse(payload.view.private_metadata || "{}");

	return await generatePaymentForm({
		payload,
		action: payload.actions[0],
		context,
		selectedPaymentMode: selectedMode,
		orderId: privateMetadata.entityId,
	});
}

async function handleConfirmPaymentMode2(payload, context) {
	context.log("** Processing confirm_payment_mode_2");

	const selectedMode =
		payload.view.state.values.payment_mode?.select_payment_mode?.selected_option
			?.value;

	if (!selectedMode) {
		context.log("No payment mode selected");
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "Veuillez sélectionner un mode de paiement avant de confirmer.",
		});
	}

	return await handleModifyPayment(payload, context, selectedMode);
}
// Helper functions to create payment-specific blocks
function createChequeBlocks(details) {
	console.log("** createChequeBlocks");
	return [
		{
			type: "input",
			block_id: "cheque_number",
			label: {
				type: "plain_text",
				text: "Numéro de chèque",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "cheque_number_input",
				initial_value: details.cheque_number || "",
			},
		},
		{
			type: "input",
			block_id: "cheque_bank",
			label: {
				type: "plain_text",
				text: "Banque",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "cheque_bank_input",
				initial_value: details.cheque_bank || "",
			},
		},
		{
			type: "input",
			block_id: "cheque_date",
			label: {
				type: "plain_text",
				text: "Date du chèque",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "cheque_date_input",
				initial_date:
					formatDateForDatepicker(details.cheque_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
		{
			type: "input",
			block_id: "cheque_order",
			label: {
				type: "plain_text",
				text: "Ordre",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "cheque_order_input",
				initial_value: details.cheque_order || "",
			},
		},
	];
}

function createVirementBlocks(details) {
	console.log("** createVirementBlocks");
	return [
		{
			type: "input",
			block_id: "virement_number",
			label: {
				type: "plain_text",
				text: "Numéro de virement",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "virement_number_input",
				initial_value: details.virement_number || "",
			},
		},
		{
			type: "input",
			block_id: "virement_bank",
			label: {
				type: "plain_text",
				text: "Banque",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "virement_bank_input",
				initial_value: details.virement_bank || "",
			},
		},
		{
			type: "input",
			block_id: "virement_date",
			label: {
				type: "plain_text",
				text: "Date du virement",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "virement_date_input",
				initial_date:
					formatDateForDatepicker(details.virement_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
		{
			type: "input",
			block_id: "virement_order",
			label: {
				type: "plain_text",
				text: "Ordre",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "virement_order_input",
				initial_value: details.virement_order || "",
			},
		},
	];
}

function createMobileMoneyBlocks(details) {
	console.log("** createMobileMoneyBlocks");
	return [
		{
			type: "input",
			block_id: "mobilemoney_recipient_phone",
			label: {
				type: "plain_text",
				text: "Téléphone destinataire",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "mobilemoney_recipient_phone_input",
				initial_value: details.mobilemoney_recipient_phone || "",
			},
		},
		{
			type: "input",
			block_id: "mobilemoney_sender_phone",
			label: {
				type: "plain_text",
				text: "Téléphone émetteur",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "mobilemoney_sender_phone_input",
				initial_value: details.mobilemoney_sender_phone || "",
			},
		},
		{
			type: "input",
			block_id: "mobilemoney_date",
			label: {
				type: "plain_text",
				text: "Date du transfert",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "mobilemoney_date_input",
				initial_date:
					formatDateForDatepicker(details.mobilemoney_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
	];
}

function createJulayaBlocks(details) {
	console.log("** createJulayaBlocks");
	return [
		{
			type: "input",
			block_id: "julaya_recipient",
			label: {
				type: "plain_text",
				text: "Destinataire",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "julaya_recipient_input",
				initial_value: details.julaya_recipient || "",
			},
		},
		{
			type: "input",
			block_id: "julaya_date",
			label: {
				type: "plain_text",
				text: "Date de la transaction",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "julaya_date_input",
				initial_date:
					formatDateForDatepicker(details.julaya_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
		{
			type: "input",
			block_id: "julaya_transaction_number",
			label: {
				type: "plain_text",
				text: "Numéro de transaction",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "julaya_transaction_number_input",
				initial_value: details.julaya_transaction_number || "",
			},
		},
	];
}
function formatDateForDatepicker(dateInput) {
	console.log("** formatDateForDatepicker");
	const date = new Date(dateInput);
	if (isNaN(date.getTime())) return null;

	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
		2,
		"0"
	)}-${String(date.getDate()).padStart(2, "0")}`;
}
// Helper function to get initial bank option
function getBankInitialOption(bank) {
	console.log("** getBankInitialOption");
	if (!bank) {
		return null; // No initial option if bank is undefined or null
	}

	const validBankValues = bankOptions.map((option) => option.value);
	console.log("validBanks", bankOptions);
	console.log("checking bank", bank);

	// Check if the provided bank matches one of the valid options
	if (validBankValues.includes(bank)) {
		const matchedBank = bankOptions.find((option) => option.value === bank);
		return {
			text: { type: "plain_text", text: matchedBank.text.text },
			value: matchedBank.value,
		};
	}

	// If no match, return "Autre" (we'll ensure it's in the options list later)
	return {
		text: { type: "plain_text", text: "Autre" },
		value: "Autre",
	};
}

module.exports = {
	PaymentForm,
	generatePaymentForm,
	// handlePaymentModeSelection,
	handleConfirmPaymentMode,
	handleConfirmPaymentMode2,
	generatePaymentRequestForm,
	createChequeBlocks,
	createVirementBlocks,
	createMobileMoneyBlocks,
	createJulayaBlocks,
	formatDateForDatepicker,
	getBankInitialOption,
	handlePaymentFormSubmission,
};
