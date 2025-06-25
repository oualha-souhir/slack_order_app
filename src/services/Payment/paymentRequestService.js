const PaymentRequest = require("../../database/dbModels/PaymentRequest");
const PaymentSequence = require("../../database/dbModels/PaymentSequence");
const { default: axios } = require("axios");
const { getPaymentRequestBlocks } = require("./blockBuilder");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
	updateSlackPaymentMessage,
	updateSlackMessageAcceptance,
} = require("../../Handlers/slackApiUtils");
const { generatePaymentForm } = require("./paymentFormService");
const Order = require("../../database/dbModels/Order");
const {
	notifyFinancePayment,
	notifyPaymentRequest,
} = require("../Notifications/Payment");
const { extractJustificatifs } = require("../../Handlers/Utils");
const { updateSlackMessage1 } = require("../Order/orderNotificationService");
const { handleOrderStatus } = require("../Order/orderInteractionHandler");

async function createAndSavePaymentRequest(
	demandeurId,
	userName,
	channelId,
	channelName,
	formData
) {
	console.log("** createAndSavePaymentRequest");
	console.log("formData", userName);
	console.log("formData", formData);
	console.log("formData", formData);

	// Get the selected date string from the form data
	let requestDate;
	if (formData.request_date?.input_request_date?.selected_date) {
		const dateStr = formData.request_date.input_request_date.selected_date;
		requestDate = new Date(dateStr);
	} else {
		requestDate = new Date();
	}

	// Parse amount and currency from the amount field
	const amountInput = formData.amount_to_pay.input_amount_to_pay.value;
	const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);

	if (!amountMatch) {
		throw new Error("Invalid amount format");
	}

	const amount = parseFloat(amountMatch[1]);
	const currency = amountMatch[2];

	if (!["XOF", "EUR", "USD"].includes(currency)) {
		throw new Error("Invalid currency");
	}

	// Validate date is not in the past
	if (requestDate < new Date().setHours(0, 0, 0, 0)) {
		throw new Error("Request date cannot be in the past");
	}

	// Generate payment ID
	const paymentId = await generatePaymentRequestId();

	const paymentData = {
		id_paiement: paymentId,
		project: channelName,
		id_projet: channelId,
		titre: formData.request_title?.input_request_title?.value,
		demandeur: userName,
		demandeurId: demandeurId,

		date_requete: requestDate,
		motif: formData.payment_reason?.input_payment_reason?.value,
		montant: amount,
		bon_de_commande: formData.po_number?.input_po_number?.value || null,
		justificatif: [], // No justificatifs from text parsing
		devise: currency,
		status: "En attente",
	};

	const paymentRequest = new PaymentRequest(paymentData);
	const savedPaymentRequest = await paymentRequest.save();
	return savedPaymentRequest;
}
async function generatePaymentRequestId() {
	console.log("** generatePaymentRequestId");
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const yearMonth = `${year}-${month}`;

	const seq = await PaymentSequence.findOneAndUpdate(
		{ yearMonth },
		{ $inc: { currentNumber: 1 } },
		{ new: true, upsert: true, returnDocument: "after" }
	);

	return `PAY/${year}/${month}/${String(seq.currentNumber).padStart(4, "0")}`;
}
async function handlePaymentModifSubmission(payload, context) {
	console.log("** handlePaymentFormSubmission");

	try {
		const view = payload.view;

		// Parse private metadata
		const metadata = JSON.parse(view.private_metadata || "{}");
		const { paymentId, originalMessage } = metadata;

		if (!paymentId || !originalMessage) {
			throw new Error("Missing paymentId or originalMessage in metadata");
		}

		context.log(`Processing submission for payment ID: ${paymentId}`);

		// Extract form values
		const stateValues = view.state.values;
		const formData = {
			request_title: stateValues.request_title?.input_request_title?.value,
			request_date: stateValues.request_date?.input_request_date?.selected_date,
			payment_reason: stateValues.payment_reason?.input_payment_reason?.value,
			amount_to_pay: stateValues.amount_to_pay?.input_amount_to_pay?.value,
			po_number: stateValues.po_number?.input_po_number?.value,
			justificatif_url:
				stateValues.justificatif_url?.input_justificatif_url?.value,
			justificatif_files:
				stateValues.justificatif?.input_justificatif?.files || [],
			existing_justificatifs: Object.keys(stateValues)
				.filter((key) => key.startsWith("existing_justificatif_"))
				.map((key) => stateValues[key][`input_${key}`]?.value)
				.filter((url) => url && url.trim()), // Filter out empty or null values
		};

		// Validate required fields
		if (
			!formData.request_title ||
			!formData.request_date ||
			!formData.payment_reason ||
			!formData.amount_to_pay ||
			!formData.po_number
		) {
			throw new Error("Missing required fields in form submission");
		}

		// Extract amount and currency
		const amountMatch = formData.amount_to_pay.match(
			/^(\d+(\.\d+)?)\s*([A-Z]{3})$/
		);
		if (!amountMatch) {
			throw new Error(
				"Invalid amount format. Expected: 'number CURRENCY' (e.g., 1000 USD)"
			);
		}
		const amount = parseFloat(amountMatch[1]);
		const currency = amountMatch[3];

		// Fetch existing payment
		const payment = await PaymentRequest.findOne({ id_paiement: paymentId });
		if (!payment) {
			throw new Error(`Payment with ID ${paymentId} not found`);
		}

		if (payment.statut !== "En attente") {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: originalMessage.channel,
					user: payload.user.id,
					text: `⚠️ Demande de paiement traitée par l'Administrateur, vous ne pouvez pas la modifier.`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
			return { statusCode: 200, body: "" };
		}

		// Prepare justificatifs: combine existing files, new files, and new URL
		// const existingFiles = payment.justificatif.filter((j) => j.type === "file");
		// const existingUrl =
		// 	payment.justificatif.find((j) => j.type === "url") || null;
		const newFiles = formData.justificatif_files.map((file) => ({
			url: file.permalink,
			type: "file",
			createdAt: new Date(),
		}));
		const newUrl = formData.justificatif_url
			? { url: formData.justificatif_url, type: "url", createdAt: new Date() }
			: null;
		const existingUrls = formData.existing_justificatifs.map((url) => ({
			url,
			type: payment.justificatif.find((j) => j.url === url)?.type || "url", // Preserve original type if exists
			createdAt:
				payment.justificatif.find((j) => j.url === url)?.createdAt ||
				new Date(),
		}));
		const updatedJustificatifs = [
			...existingUrls, // Keep URLs from input fields
			...newFiles, // Add new files
			...(newUrl ? [newUrl] : []), // Add new URL if provided
		];

		// Update payment in database
		const updatedPayment = await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentId },
			{
				titre: formData.request_title,
				date_requete: new Date(formData.request_date),
				motif: formData.payment_reason,
				montant: amount,
				devise: currency,
				bon_de_commande: formData.po_number,
				justificatif: updatedJustificatifs,
				updatedAt: new Date(),
			},
			{ new: true }
		);

		context.log(`Updated payment: ${JSON.stringify(updatedPayment)}`);

		// Generate updated blocks for both messages using getPaymentRequestBlocks
		const demandeurBlocks = [
			...getPaymentRequestBlocks(updatedPayment, null),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Modifier", emoji: true },
						style: "primary",
						action_id: "edit_payment",
						value: paymentId,
					},
				],
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "✅ Votre demande de paiement a été mise à jour. En attente de validation par un administrateur.",
					},
				],
			},
		];
		const adminBlocks = [
			...getPaymentRequestBlocks(updatedPayment, null),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Autoriser", emoji: true },
						style: "primary",
						action_id: "payment_verif_accept",
						value: paymentId,
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Rejeter", emoji: true },
						style: "danger",
						action_id: "reject_order",
						value: paymentId,
					},
				],
			},
			{
				type: "context",
				elements: [{ type: "mrkdwn", text: "⏳ En attente de validation" }],
			},
		];

		// Update Demandeur's message
		const demandeurUpdateResponse = await axios.post(
			"https://slack.com/api/chat.update",
			{
				channel: originalMessage.channel,
				ts: originalMessage.ts,
				text: `Demande de paiement *${paymentId}* mise à jour`,
				blocks: demandeurBlocks,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);

		if (!demandeurUpdateResponse.data.ok) {
			throw new Error(
				`Failed to update demandeur message: ${demandeurUpdateResponse.data.error}`
			);
		}
		context.log(
			`Updated demandeur message: ${JSON.stringify(
				demandeurUpdateResponse.data
			)}`
		);

		// Update Admin message
		if (
			updatedPayment.admin_message?.channel &&
			updatedPayment.admin_message?.ts
		) {
			const adminUpdateResponse = await axios.post(
				"https://slack.com/api/chat.update",
				{
					channel: updatedPayment.admin_message.channel,
					ts: updatedPayment.admin_message.ts,
					text: `Demande de paiement *${paymentId}* mise à jour par <@${updatedPayment.demandeur}>`,
					blocks: adminBlocks,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);

			if (!adminUpdateResponse.data.ok) {
				throw new Error(
					`Failed to update admin message: ${adminUpdateResponse.data.error}`
				);
			}

			context.log(
				`Updated admin message: ${JSON.stringify(adminUpdateResponse.data)}`
			);
		} else {
			context.log(
				"⚠️ Admin message details not found, skipping admin message update"
			);
		}

		return { statusCode: 200, body: "" };
	} catch (error) {
		context.log(
			`❌ Error in handlePaymentFormSubmission: ${error.message}\nStack: ${error.stack}`
		);

		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de la soumission du formulaire: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);

		return {
			statusCode: 400,
			body: JSON.stringify({
				response_type: "ephemeral",
				text: `Erreur lors de la soumission: ${error.message}`,
			}),
			headers: { "Content-Type": "application/json" },
		};
	}
}
// Updated edit_payment handler to use the corrected function
async function handleEditPayment(payload, context) {
	console.log("** edit_payment");

	try {
		const paymentId = payload.actions[0].value;
		context.log(`Editing payment with ID: ${paymentId}`);

		const payment = await PaymentRequest.findOne({ id_paiement: paymentId });
		if (!payment) {
			throw new Error(`Payment with ID ${paymentId} not found`);
		}
		console.log("Payment request object:", payment);

		console.log(`payment.status ${payment.statut}`);

		if (payment.statut === "En attente") {
			// Separate files and URLs from justificatifs
			const justificatifs = payment.justificatif.map((j) => j.url); // Include all justificatifs (files and URLs)
			const urlJustificatif =
				payment.justificatif.find((j) => j.type === "url")?.url || "";
			const formData = {
				payment_title: {
					input_payment_title: {
						value: payment.titre || "",
					},
				},
				payment_date: {
					input_payment_date: {
						selected_date: payment.date_requete
							? new Date(payment.date_requete).toISOString().split("T")[0]
							: new Date().toISOString().split("T")[0],
					},
				},
				payment_description: {
					input_payment_description: {
						value: payment.motif || "",
					},
				},
				payment_amount: {
					input_payment_amount: {
						value: payment.montant ? String(payment.montant) : "",
					},
				},
				po_number: {
					input_po_number: {
						value: payment.bon_de_commande || "",
					},
				},
				justificatif_url: {
					input_justificatif_url: {
						value: urlJustificatif,
					},
				},
				existing_justificatifs: justificatifs,
				currency: payment.devise || "", // Store file URLs for display
			};
			console.log("Payment formData:", formData);

			const metadata = {
				formData: formData,
				originalViewId: payload.trigger_id,
				paymentId: paymentId,
				isEdit: true,
				originalMessage: {
					channel: payload.channel?.id || payload.channel || payload.user.id,
					ts: payload.message?.ts,
				},
			};
			console.log("$ payment metadata", metadata);

			const view = await generatePaymentForm(formData);

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						...view,
						private_metadata: JSON.stringify(metadata),
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log(
				`Edit payment form response: ${JSON.stringify(response.data)}`
			);

			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
		} else {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel?.id || payload.channel || payload.user.id,
					user: payload.user.id,
					text: `⚠️ Demande de paiement ${payment.statut}e par l'Administrateur, vous ne pouvez pas la modifier`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
		}
	} catch (error) {
		context.log(
			`❌ Error in edit_payment: ${error.message}\nStack: ${error.stack}`
		);

		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.channel || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de l'édition de la demande de paiement: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);
	}
}
async function handlePaymentVerificationConfirm(payload, context) {
	console.log("** handlePaymentVerificationConfirm");
	const { paymentId, action, message_ts } = JSON.parse(
		payload.view.private_metadata
	);
	// const { orderId, channel_id } = JSON.parse(payload.view.private_metadata);
	console.log("payload", payload);

	let order;
	let status;
	if (paymentId.startsWith("CMD/")) {
		order = await Order.findOne({ id_commande: paymentId });

		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Order not found.",
			});
		}
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: order.demandeurId,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text:
								":package:  ✅ Commande: " +
								paymentId +
								" - Approuvée" +
								` par <@${
									payload.user.username
								}> le ${new Date().toLocaleDateString()}`,
							emoji: true,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Check order status
		status = order.statut;

		// Check if the order has already been approved once
		if (order.isApprovedOnce) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: process.env.SLACK_ADMIN_ID,
					user: payload.user.id,
					text: `❌ Cet demande a déjà été ${status}e`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { response_action: "clear" };
		}
	}
	if (paymentId.startsWith("PAY/")) {
		order = await PaymentRequest.findOne({ id_paiement: paymentId });

		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Order not found.",
			});
		}
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
								"✅ Demande de paiement: " +
								paymentId +
								" - Approuvée" +
								` par <@${
									payload.user.username
								}> le ${new Date().toLocaleDateString()}`,
							emoji: true,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Check order status
		status = order.statut;
		// Check if the order has already been approved once
		if (order.isApprovedOnce) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: process.env.SLACK_ADMIN_ID,
					user: payload.user.id,
					text: `❌ Cet demande a déjà été ${status}e`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { response_action: "clear" };
		}
	}

	// In view_submission handler for payment_verif_confirm
	if (action === "accept") {
		// await postSlackMessageWithRetry(
		//   "https://slack.com/api/chat.postMessage",
		//   {
		//     channel: process.env.SLACK_ADMIN_ID,
		//     text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		//   },
		//   process.env.SLACK_BOT_TOKEN
		// );
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		// Process in background
		setImmediate(async () => {
			try {
				let paymentRequest;
				// Get paymentId from metadata NOT action.value
				const { paymentId } = JSON.parse(payload.view.private_metadata); // ← CORRECT SOURCE
				if (paymentId.startsWith("CMD/")) {
					console.log("Payment2", paymentId);
					// await notifyAdmin(order, context, false,true,status);
					await updateSlackMessageAcceptance(
						message_ts,
						paymentId,
						"validée",
						order
					);

					paymentRequest = await Order.findOneAndUpdate(
						{ id_commande: paymentId }, // ← Verify field name matches DB
						{
							statut: "Validé",
							autorisation_admin: true,
							updatedAt: new Date(),
							isApprovedOnce: true,
						},
						{ new: true }
					);
					return await handleOrderStatus(payload, action, context);
					// Add validation before using paymentRequest
					// if (!paymentRequest) {
					// 	context.log(`❌ order request not found: ${paymentId}`);
					// 	await postSlackMessageWithRetry(
					// 		"https://slack.com/api/chat.postEphemeral",
					// 		{
					// 			channel: process.env.SLACK_ADMIN_ID,
					// 			user: payload.user.id,
					// 			text: `⚠️ Demande de paiement ${paymentId} introuvable`,
					// 		},
					// 		process.env.SLACK_BOT_TOKEN
					// 	);

					// 	return { response_action: "clear" };
					// }
				} else if (paymentId.startsWith("PAY/")) {
					paymentRequest = await PaymentRequest.findOneAndUpdate(
						{ id_paiement: paymentId }, // ← Verify field name matches DB
						{
							statut: "Validé",
							autorisation_admin: true,
							updatedAt: new Date(),
						},
						{ new: true }
					);
					await updateSlackPaymentMessage(
						message_ts,
						paymentId,
						"validée",
						order
					);
					// Add validation before using paymentRequest
					if (!paymentRequest) {
						context.log(`❌ Payment request not found: ${paymentId}`);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: process.env.SLACK_ADMIN_ID,
								user: payload.user.id,
								text: `⚠️ Demande de paiement ${paymentId} introuvable`,
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { response_action: "clear" };
					}
					// Update the Slack message to remove buttons
					await updateSlackMessage1(payload, paymentId, "Validé");

					await notifyFinancePayment(paymentRequest, context, payload.user.id);
				}
			} catch (error) {
				context.log(
					`Background processing error: ${error.message}\nStack: ${error.stack}`
				);
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: payload.user.id,
						text: `❌ Erreur lors du traitement de la commande ${paymentId}. Veuillez contacter le support.`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		});
		return context.res;
	}
}
// Helper function to validate payment requests
async function validatePaymentRequest(paymentId, payload) {
	let order;

	if (paymentId.startsWith("CMD/")) {
		order = await Order.findOne({ id_commande: paymentId });
	} else if (paymentId.startsWith("PAY/")) {
		order = await PaymentRequest.findOne({ id_paiement: paymentId });
	}

	if (!order) {
		return {
			isValid: false,
			response: createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Order not found.",
			}),
		};
	}

	// Check if already processed

	if (order.isApprovedOnce) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id,
				text: `❌ Cette demande a déjà été ${order.statut}e`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		return {
			isValid: false,
			response: { response_action: "clear" },
		};
	}

	return { isValid: true, order };
}

// Helper function to process payment acceptance
async function processPaymentAcceptance(paymentId) {
	if (paymentId.startsWith("CMD/")) {
		// await processOrderAcceptance(paymentId, payload, context, message_ts);
	} else if (paymentId.startsWith("PAY/")) {
		// await processPaymentRequestAcceptance(
		// 	paymentId,
		// 	payload,
		// 	context,
		// 	message_ts
		// );
	}
}
async function handleAcceptPayment(payload, action, context) {
	const paymentId = action.value;

	try {
		const paymentRequest = await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentId },
			{
				statut: "Validé",
				autorisation_admin: true,
				updatedAt: new Date(),
			},
			{ new: true }
		);

		if (!paymentRequest) {
			throw new Error(`Payment request ${paymentId} not found`);
		}

		context.log(`Payment accepted: ${paymentId}`);

		// Note: validatedBy variable needs to be defined
		const validatedBy = payload.user?.id || payload.user?.username;
		await notifyFinancePayment(paymentRequest, context, validatedBy);

		return createSlackResponse(200, "");
	} catch (error) {
		context.log(`Error accepting payment ${paymentId}: ${error.message}`);
		throw error;
	}
}

async function handlePaymentRequestSubmission(
	payload,
	context,
	channelId,
	formData,
	userId,
	slackToken
) {
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: channelId,
			text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
		},
		process.env.SLACK_BOT_TOKEN
	);
	// Process in background
	setImmediate(async () => {
		// const project = channelId;
		const title = formData.request_title?.input_request_title?.value;
		const date = formData.request_date?.input_request_date?.selected_date;
		const reason = formData.payment_reason?.input_payment_reason?.value;

		const amountInput = formData.amount_to_pay.input_amount_to_pay.value;
		console.log("amountInput", amountInput);

		// Parse amount and currency
		const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);
		if (!amountMatch) {
			return await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId,

					text: "⚠️ Le format du montant est incorrect. Exemple attendu: 1000 XOF",
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		const amount = parseFloat(amountMatch[1]);
		const currency = amountMatch[2];
		console.log("111111");

		if (!["XOF", "EUR", "USD"].includes(currency)) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId,
					text: "⚠️ Erreur: Devise non reconnue. Les devises acceptées sont: XOF, USD, EUR. Veuillez modifier votre demande.",
				},
				process.env.SLACK_BOT_TOKEN
			);

			return { response_action: "clear" };
		}
		console.log("currency", currency);
		console.log("amount", amount);

		const poNumber = formData.po_number?.input_po_number?.value || null;

		// Extract multiple justificatifs
		const justificatifs = await extractJustificatifs(
			formData,
			context,
			userId,
			slackToken
		);
		console.log("justificatifs", justificatifs);
		// Validation
		const errors = {};
		if (!title) errors.request_title = "Titre requis";
		if (!date || new Date(date) < new Date().setHours(0, 0, 0, 0)) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId, // This sends a DM to the user
					text: "⚠️ *Erreur*: La date sélectionnée est dans le passé. Veuillez rouvrir le formulaire et sélectionner une date d'aujourd'hui ou future.",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "⚠️ *Erreur*: La date sélectionnée est dans le passé.",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "Veuillez créer une nouvelle commande et sélectionner une date d'aujourd'hui ou future.",
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
			errors.request_date = "Date invalide ou dans le passé";
		}
		if (!reason) errors.payment_reason = "Motif requis";
		if (!amount || isNaN(amount) || amount <= 0)
			errors.amount_to_pay = "Montant invalide";

		if (Object.keys(errors).length > 0) {
			return { response_action: "errors", errors };
		}

		// Generate payment ID
		const paymentId = await generatePaymentRequestId();
		console.log("ùjustificatifs", justificatifs);
		// Save to database
		const paymentRequest = new PaymentRequest({
			id_paiement: paymentId,
			project: channelId,
			titre: title,
			demandeur: userId,
			date_requete: new Date(date),
			motif: reason,
			montant: amount,
			bon_de_commande: poNumber,
			justificatif: justificatifs, // Save array of justificatifs
			devise: currency,
			status: "En attente",
		});
		await paymentRequest.save();

		// Notify admin and demandeur
		await notifyPaymentRequest(paymentRequest, context, payload.user.id);
	});

	return context.res;
}

module.exports = {
	createAndSavePaymentRequest,
	generatePaymentRequestId,
	handlePaymentModifSubmission,
	handleEditPayment,
	handlePaymentVerificationConfirm,
	handleAcceptPayment,
	handlePaymentRequestSubmission,
	validatePaymentRequest,
	processPaymentAcceptance,
};
